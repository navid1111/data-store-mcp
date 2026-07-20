/** Append-only execution audit log (spec R8.5). */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { redactSecrets } from '../mcp/errors.js';

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'timeout';

export interface AuditRecordInput {
    source: string;
    sql: string;
    appliedPolicies: readonly string[];
    rowCount: number;
    durationMs: number;
    outcome: AuditOutcome;
    errorCode?: string;
}

export interface AuditRecord extends AuditRecordInput {
    timestamp: string;
    principal: string;
}

export interface AuditLogOptions {
    path: string;
    principal: string;
    /** Exact credential values that must never be persisted. */
    secrets?: readonly string[];
}

/**
 * Serializes records through one promise chain, so concurrent executions
 * cannot interleave JSON. Each record is written with a single append call;
 * the file is never truncated or rewritten.
 */
export class AuditLog {
    readonly path: string;
    private readonly principal: string;
    private readonly secrets: readonly string[];
    private tail: Promise<void> = Promise.resolve();

    private constructor(options: AuditLogOptions) {
        this.path = resolve(options.path);
        this.principal = options.principal;
        this.secrets = Object.freeze(
            [...new Set(options.secrets ?? [])]
                .filter((secret) => secret.length > 0)
                .sort((left, right) => right.length - left.length),
        );
    }

    /** Ensures the append target is writable without adding an audit record. */
    static async open(options: AuditLogOptions): Promise<AuditLog> {
        if (!options.principal.trim()) {
            throw new Error('Audit principal must not be empty.');
        }
        if (!options.path.trim()) {
            throw new Error('Audit path must not be empty.');
        }

        const log = new AuditLog(options);
        await mkdir(dirname(log.path), { recursive: true });
        await appendFile(log.path, '', { encoding: 'utf8', flag: 'a', mode: 0o600 });
        return log;
    }

    append(input: AuditRecordInput): Promise<void> {
        const record: AuditRecord = {
            timestamp: new Date().toISOString(),
            principal: this.clean(this.principal),
            source: this.clean(input.source),
            sql: this.clean(input.sql),
            appliedPolicies: input.appliedPolicies.map((policy) => this.clean(policy)),
            rowCount: input.rowCount,
            durationMs: input.durationMs,
            outcome: input.outcome,
            ...(input.errorCode ? { errorCode: this.clean(input.errorCode) } : {}),
        };
        const line = `${JSON.stringify(record)}\n`;

        const write = this.tail.then(() =>
            appendFile(this.path, line, { encoding: 'utf8', flag: 'a', mode: 0o600 }),
        );
        // A failed append rejects its caller but does not permanently poison
        // the queue: later executions still get a chance to record themselves.
        this.tail = write.catch(() => undefined);
        return write;
    }

    private clean(value: string): string {
        let cleaned = redactSecrets(value);
        for (const secret of this.secrets) {
            cleaned = cleaned.split(secret).join('***');
        }
        return cleaned;
    }
}
