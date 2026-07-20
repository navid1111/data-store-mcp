/** Live-database drift checks for one MDL file (spec R3.5). */

import { readFile } from 'node:fs/promises';
import { LineCounter, parseDocument } from 'yaml';
import type { ColumnInfo, Database, TableRelation } from '../database-source.js';
import { parseMdlYaml } from './schema.js';
import type { Model, Relationship } from './types.js';

export type DriftFindingCode =
    | 'missing_model_table'
    | 'missing_column'
    | 'column_type_changed'
    | 'missing_foreign_key';

export interface DriftFinding {
    code: DriftFindingCode;
    severity: 'error';
    file: string;
    line: number;
    column: number;
    entityPath: string;
    message: string;
}

export interface MdlLintResult {
    findings: DriftFinding[];
    exitCode: 0 | 1;
}

interface Location {
    line: number;
    column: number;
}

/** Parses and checks one MDL artifact against the connected source. */
export async function lintMdlFile(database: Database, file: string): Promise<MdlLintResult> {
    const source = await readFile(file, 'utf8');
    const document = parseMdlYaml(source);
    const locations = locationResolver(source);
    const liveTables = new Set(
        (await database.listTables()).map((table) => table.name),
    );
    const liveColumns = groupColumns(await database.getSchema());
    const liveRelations = await database.getRelations();
    const models = new Map(document.models.map((model) => [model.name, model]));
    const findings: DriftFinding[] = [];

    document.models.forEach((model, modelIndex) => {
        if (!liveTables.has(model.table)) {
            findings.push(finding(
                'missing_model_table',
                file,
                locations(['models', modelIndex, 'table']),
                `model.${model.name}`,
                `Model "${model.name}" references missing table "${model.table}".`,
            ));
            return;
        }

        const tableColumns = liveColumns.get(model.table) ?? new Map<string, ColumnInfo>();
        model.columns.forEach((column, columnIndex) => {
            const sourceColumn = column.sourceColumn ?? column.name;
            const live = tableColumns.get(sourceColumn);
            const entityPath = `model.${model.name}.column.${column.name}`;
            if (!live) {
                findings.push(finding(
                    'missing_column',
                    file,
                    locations(['models', modelIndex, 'columns', columnIndex, column.sourceColumn ? 'sourceColumn' : 'name']),
                    entityPath,
                    `Column "${model.table}.${sourceColumn}" no longer exists.`,
                ));
                return;
            }
            if (!equivalentTypes(column.dataType, live.dataType)) {
                findings.push(finding(
                    'column_type_changed',
                    file,
                    locations(['models', modelIndex, 'columns', columnIndex, 'dataType']),
                    entityPath,
                    `Column "${model.table}.${sourceColumn}" type changed from "${column.dataType}" to "${live.dataType}".`,
                ));
            }
        });
    });

    document.relationships.forEach((relationship, relationshipIndex) => {
        if (relationshipHasForeignKey(relationship, models, liveTables, liveRelations)) return;
        const from = models.get(relationship.fromModel);
        const to = models.get(relationship.toModel);
        // A missing model table already has the more fundamental finding.
        if (!from || !to || !liveTables.has(from.table) || !liveTables.has(to.table)) return;
        findings.push(finding(
            'missing_foreign_key',
            file,
            locations(['relationships', relationshipIndex, 'name']),
            `relationship.${relationship.name}`,
            `Relationship "${relationship.name}" has no matching live foreign key.`,
        ));
    });

    return { findings, exitCode: findings.length === 0 ? 0 : 1 };
}

function relationshipHasForeignKey(
    relationship: Relationship,
    models: Map<string, Model>,
    liveTables: Set<string>,
    liveRelations: TableRelation[],
): boolean {
    const from = models.get(relationship.fromModel);
    const to = models.get(relationship.toModel);
    if (!from || !to || !liveTables.has(from.table) || !liveTables.has(to.table)) return false;
    const orientations = [
        {
            child: from,
            parent: to,
            keys: relationship.joinKeys.map((key) => ({
                childColumn: physicalColumn(from, key.fromColumn),
                parentColumn: physicalColumn(to, key.toColumn),
            })),
        },
        {
            child: to,
            parent: from,
            keys: relationship.joinKeys.map((key) => ({
                childColumn: physicalColumn(to, key.toColumn),
                parentColumn: physicalColumn(from, key.fromColumn),
            })),
        },
    ];
    return orientations.some(({ child, parent, keys }) => {
        const constraints = new Set(liveRelations
            .filter((live) => live.childTable === child.table && live.parentTable === parent.table)
            .map((live) => live.constraintName));
        return [...constraints].some((constraint) => keys.every((key) => liveRelations.some((live) =>
            live.constraintName === constraint &&
            live.childTable === child.table &&
            live.childColumn === key.childColumn &&
            live.parentTable === parent.table &&
            live.parentColumn === key.parentColumn)));
    });
}

function physicalColumn(model: Model, semanticName: string): string {
    const column = model.columns.find((candidate) => candidate.name === semanticName);
    return column?.sourceColumn ?? semanticName;
}

function groupColumns(columns: ColumnInfo[]): Map<string, Map<string, ColumnInfo>> {
    const grouped = new Map<string, Map<string, ColumnInfo>>();
    for (const column of columns) {
        const table = grouped.get(column.table) ?? new Map<string, ColumnInfo>();
        table.set(column.name, column);
        grouped.set(column.table, table);
    }
    return grouped;
}

function equivalentTypes(declared: string, live: string): boolean {
    return canonicalType(declared) === canonicalType(live);
}

function canonicalType(value: string): string {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalized
        .replace(/^int4$/, 'integer')
        .replace(/^int8$/, 'bigint')
        .replace(/^int2$/, 'smallint')
        .replace(/^int(?=\b|\()/, 'integer')
        .replace(/^character varying(?=\b|\()/, 'varchar')
        .replace(/^double precision$/, 'double');
}

function locationResolver(source: string): (path: Array<string | number>) => Location {
    const lineCounter = new LineCounter();
    const document = parseDocument(source, { lineCounter, strict: true, uniqueKeys: true });
    return (path) => {
        const node = document.getIn(path, true) as { range?: readonly number[] } | null | undefined;
        const offset = node?.range?.[0] ?? 0;
        const position = lineCounter.linePos(offset);
        return { line: position.line, column: position.col };
    };
}

function finding(
    code: DriftFindingCode,
    file: string,
    location: Location,
    entityPath: string,
    detail: string,
): DriftFinding {
    return {
        code,
        severity: 'error',
        file,
        ...location,
        entityPath,
        message: `${file}:${location.line}:${location.column}: ${detail}`,
    };
}
