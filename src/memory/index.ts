/** Persistent execution memory backed by embedded LanceDB (spec R5.1). */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import type { Row } from '../database-source.js';

const TABLE_NAME = 'successful_executions';

export interface ResultShapeColumn {
    name: string;
    type: string;
}

export interface SuccessfulExecution {
    success: true;
    question: string;
    sql: string;
    rows: readonly Row[];
    durationMs: number;
    unverifiedModels?: readonly string[];
}

export interface FailedExecution {
    success: false;
    question: string;
    sql: string;
    durationMs: number;
    error?: string;
}

export type ExecutionMemoryEvent = SuccessfulExecution | FailedExecution;

export interface ExecutionMemoryRecord {
    id: string;
    question: string;
    sql: string;
    resultShape: ResultShapeColumn[];
    durationMs: number;
    recordedAt: string;
    unverifiedModels: string[];
}

interface StoredExecution extends Record<string, unknown> {
    id: string;
    question: string;
    sql: string;
    result_shape: string;
    duration_ms: number;
    recorded_at: string;
    unverified_models: string;
}

export class ExecutionMemoryIndex {
    readonly path: string;
    private readonly connection: lancedb.Connection;
    private writeTail: Promise<void> = Promise.resolve();

    private constructor(path: string, connection: lancedb.Connection) {
        this.path = path;
        this.connection = connection;
    }

    static async open(path: string): Promise<ExecutionMemoryIndex> {
        if (!path.trim()) throw new Error('Memory index path must not be empty.');
        const absolutePath = resolve(path);
        return new ExecutionMemoryIndex(absolutePath, await lancedb.connect(absolutePath));
    }

    /** Returns false for failed executions; they never enter the persistence queue. */
    recordExecution(event: ExecutionMemoryEvent): Promise<boolean> {
        if (!event.success) return Promise.resolve(false);
        const operation = this.writeTail.then(async () => {
            const stored = toStoredExecution(event);
            const table = await this.tableForWrite(stored);
            await table.mergeInsert('id')
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute([stored]);
        });
        this.writeTail = operation.catch(() => undefined);
        return operation.then(() => true);
    }

    async records(): Promise<ExecutionMemoryRecord[]> {
        await this.writeTail;
        if (!await this.hasTable()) return [];
        const table = await this.connection.openTable(TABLE_NAME);
        const rows = await table.query().toArray() as StoredExecution[];
        return rows.map(fromStoredExecution)
            .sort((left, right) => left.question.localeCompare(right.question));
    }

    async count(): Promise<number> {
        await this.writeTail;
        if (!await this.hasTable()) return 0;
        return (await this.connection.openTable(TABLE_NAME)).countRows();
    }

    close(): void {
        this.connection.close();
    }

    private async tableForWrite(record: StoredExecution): Promise<lancedb.Table> {
        if (await this.hasTable()) return this.connection.openTable(TABLE_NAME);
        return this.connection.createTable(TABLE_NAME, [record]);
    }

    private async hasTable(): Promise<boolean> {
        return (await this.connection.tableNames()).includes(TABLE_NAME);
    }
}

function toStoredExecution(event: SuccessfulExecution): StoredExecution {
    const question = event.question.trim();
    const sql = event.sql.trim();
    if (!question) throw new Error('Successful execution question must not be empty.');
    if (!sql) throw new Error('Successful execution SQL must not be empty.');
    if (!Number.isFinite(event.durationMs) || event.durationMs < 0) {
        throw new RangeError(`durationMs must be a non-negative finite number, got ${event.durationMs}.`);
    }
    return {
        id: questionId(question),
        question,
        sql,
        result_shape: JSON.stringify(inferResultShape(event.rows)),
        duration_ms: event.durationMs,
        recorded_at: new Date().toISOString(),
        unverified_models: JSON.stringify([...new Set(event.unverifiedModels ?? [])].sort()),
    };
}

function fromStoredExecution(row: StoredExecution): ExecutionMemoryRecord {
    return {
        id: String(row.id),
        question: String(row.question),
        sql: String(row.sql),
        resultShape: JSON.parse(String(row.result_shape)) as ResultShapeColumn[],
        durationMs: Number(row.duration_ms),
        recordedAt: String(row.recorded_at),
        unverifiedModels: JSON.parse(String(row.unverified_models)) as string[],
    };
}

function questionId(question: string): string {
    const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex');
}

function inferResultShape(rows: readonly Row[]): ResultShapeColumn[] {
    const names = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
    return names.map((name) => {
        const types = [...new Set(rows
            .filter((row) => Object.hasOwn(row, name))
            .map((row) => valueType(row[name])))].sort();
        return { name, type: types.join('|') || 'unknown' };
    });
}

function valueType(value: unknown): string {
    if (value === null) return 'null';
    if (value instanceof Date) return 'date';
    if (Buffer.isBuffer(value)) return 'binary';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'bigint') return 'bigint';
    return typeof value === 'object' ? 'object' : typeof value;
}
