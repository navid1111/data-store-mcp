/** Introspection + profiling to a safe, reviewable first-draft MDL. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
    ColumnInfo,
    ColumnProfile,
    Database,
    ProfileOptions,
    TableInfo,
    TableRelation,
} from '../database-source.js';
import { parseMdlYaml, stringifyMdlYaml } from './schema.js';
import type { Column, MdlDocument, Model, Relationship, SemanticScalar } from './types.js';
import { draftMdl, type DraftOptions } from './draft.js';

export interface BootstrapOptions {
    source: string;
    outputPath: string;
    profile?: ProfileOptions;
    draft?: DraftOptions;
}

export interface BootstrapResult {
    document: MdlDocument;
    yaml: string;
    changed: boolean;
}

export async function bootstrapMdl(
    database: Database,
    options: BootstrapOptions,
): Promise<BootstrapResult> {
    const introspectedTables = [...await database.listTables()];
    validateTables(introspectedTables);
    const tables = introspectedTables
        .filter((table) => table.kind === 'table')
        .sort((left, right) => left.name.localeCompare(right.name));

    const models: Model[] = [];
    for (const table of tables) {
        const columns = [...await database.getSchema(table.name)]
            .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
        validateColumns(table, columns);
        const profiles = await database.profile(
            table.name,
            columns.map((column) => column.name),
            options.profile,
        );
        models.push(toModel(options.source, table, columns, profiles));
    }

    const relationships = toRelationships(await database.getRelations(), models);
    const structuralDocument: MdlDocument = {
        models,
        relationships,
        metrics: [],
        views: [],
        cubes: [],
    };
    const document = options.draft
        ? await draftMdl(structuralDocument, options.draft)
        : structuralDocument;
    const yaml = stringifyMdlYaml(document);
    // Parse our own output before it can touch disk. Bootstrap must never emit
    // an artifact the runtime registry would later reject.
    const parsed = parseMdlYaml(yaml);
    const previous = await readFile(options.outputPath, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    const changed = previous !== yaml;
    if (changed) {
        await mkdir(dirname(options.outputPath), { recursive: true });
        await writeFile(options.outputPath, yaml, 'utf8');
    }
    return { document: parsed, yaml, changed };
}

function toRelationships(relations: TableRelation[], models: Model[]): Relationship[] {
    const modelsByTable = new Map(models.map((model) => [model.table, model]));
    const grouped = new Map<string, TableRelation[]>();
    for (const relation of relations) {
        validateRelation(relation);
        const key = [
            relation.childTable,
            relation.constraintName,
            relation.parentTable,
        ].join('\u0000');
        const group = grouped.get(key) ?? [];
        group.push(relation);
        grouped.set(key, group);
    }

    return [...grouped.values()]
        .sort((left, right) => relationshipKey(left[0]).localeCompare(relationshipKey(right[0])))
        .flatMap((group) => {
            const first = group[0];
            const from = modelsByTable.get(first.childTable);
            const to = modelsByTable.get(first.parentTable);
            // Views are intentionally not emitted as bootstrap models. Ignore
            // relationships whose endpoints therefore have no structural model.
            if (!from || !to) return [];

            const joinKeys = group
                .sort((left, right) =>
                    left.childColumn.localeCompare(right.childColumn) ||
                    left.parentColumn.localeCompare(right.parentColumn))
                .map((relation) => ({
                    fromColumn: relation.childColumn,
                    toColumn: relation.parentColumn,
                }));
            assertRelationshipColumns(from, to, joinKeys);
            const parentIsUnique = joinKeys.every((key) => {
                const column = to.columns.find((candidate) => candidate.name === key.toColumn);
                return Boolean(column?.isPrimaryKey || column?.isUnique);
            });

            return [{
                name: relationshipName(first),
                description: `Relationship from ${from.name} to ${to.name} discovered by introspection.`,
                provenance: 'introspection' as const,
                verified: false,
                fromModel: from.name,
                toModel: to.name,
                cardinality: parentIsUnique ? 'many-to-one' as const : 'many-to-many' as const,
                joinKeys,
            }];
        });
}

function validateRelation(relation: TableRelation): void {
    if (
        !relation.childTable ||
        !relation.childColumn ||
        !relation.constraintName ||
        !relation.parentTable ||
        !relation.parentColumn
    ) {
        throw new Error(`Unexpected relationship introspection shape: ${JSON.stringify(relation)}.`);
    }
}

function assertRelationshipColumns(
    from: Model,
    to: Model,
    keys: Array<{ fromColumn: string; toColumn: string }>,
): void {
    for (const key of keys) {
        if (!from.columns.some((column) => column.name === key.fromColumn)) {
            throw new Error(`Relationship references missing column "${from.name}.${key.fromColumn}".`);
        }
        if (!to.columns.some((column) => column.name === key.toColumn)) {
            throw new Error(`Relationship references missing column "${to.name}.${key.toColumn}".`);
        }
    }
}

function relationshipName(relation: TableRelation): string {
    return `${relation.childTable}_${relation.constraintName}`
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function relationshipKey(relation: TableRelation): string {
    return [
        relation.childTable,
        relation.constraintName,
        relation.parentTable,
        relation.childColumn,
        relation.parentColumn,
    ].join('\u0000');
}

function validateTables(tables: TableInfo[]): void {
    const names = new Set<string>();
    for (const table of tables) {
        if (!table.name || (table.kind !== 'table' && table.kind !== 'view')) {
            throw new Error(`Unexpected table introspection shape: ${JSON.stringify(table)}.`);
        }
        if (names.has(table.name)) {
            throw new Error(`Introspection returned duplicate table "${table.name}".`);
        }
        names.add(table.name);
    }
}

function validateColumns(table: TableInfo, columns: ColumnInfo[]): void {
    if (columns.length === 0) {
        throw new Error(`Introspection returned no columns for ${table.kind} "${table.name}".`);
    }
    const names = new Set<string>();
    for (const column of columns) {
        if (!column.name || !column.dataType || column.table !== table.name) {
            throw new Error(
                `Unexpected column introspection shape for "${table.name}": ${JSON.stringify(column)}.`,
            );
        }
        if (names.has(column.name)) {
            throw new Error(`Introspection returned duplicate column "${table.name}.${column.name}".`);
        }
        names.add(column.name);
    }
}

function toModel(
    source: string,
    table: TableInfo,
    columns: ColumnInfo[],
    profiles: ColumnProfile[],
): Model {
    const byColumn = new Map(profiles.map((profile) => [profile.column, profile]));
    if (byColumn.size !== columns.length) {
        throw new Error(
            `Profiling returned ${byColumn.size} of ${columns.length} columns for "${table.name}".`,
        );
    }
    return {
        name: table.name,
        description: nonEmptyDescription(table.comment, `${capitalize(table.kind)} ${table.name}.`),
        provenance: 'introspection',
        verified: false,
        source,
        table: table.name,
        kind: table.kind,
        columns: columns.map((column) => toColumn(table, column, requiredProfile(byColumn, column))),
    };
}

function toColumn(table: TableInfo, column: ColumnInfo, profile: ColumnProfile): Column {
    return {
        name: column.name,
        description: nonEmptyDescription(column.comment, `Column ${column.name} on ${table.name}.`),
        provenance: 'introspection',
        verified: false,
        dataType: column.dataType,
        sourceColumn: column.name,
        nullable: column.nullable,
        isPrimaryKey: column.isPrimaryKey,
        isUnique: column.isUnique,
        profile: {
            distinctCount: profile.distinctCount,
            nullRate: profile.nullRate,
            ...(profile.min !== undefined ? { min: scalar(profile.min) } : {}),
            ...(profile.max !== undefined ? { max: scalar(profile.max) } : {}),
            ...(profile.topValues
                ? {
                    topValues: profile.topValues.map((value) => ({
                        value: scalar(value.value),
                        count: value.count,
                    })),
                }
                : {}),
        },
    };
}

function requiredProfile(
    profiles: Map<string, ColumnProfile>,
    column: ColumnInfo,
): ColumnProfile {
    const profile = profiles.get(column.name);
    if (!profile) throw new Error(`Profiling omitted column "${column.table}.${column.name}".`);
    return profile;
}

function scalar(value: unknown): SemanticScalar {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`Profile produced non-finite number ${value}.`);
        return value;
    }
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value) || (value && typeof value === 'object')) {
        return JSON.stringify(normalizeJson(value));
    }
    throw new Error(`Profile produced unsupported value: ${Object.prototype.toString.call(value)}.`);
}

function normalizeJson(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, normalizeJson(nested)]),
        );
    }
    return value;
}

function nonEmptyDescription(value: string | undefined, fallback: string): string {
    return value?.trim() || fallback;
}

function capitalize(value: string): string {
    return `${value[0].toUpperCase()}${value.slice(1)}`;
}
