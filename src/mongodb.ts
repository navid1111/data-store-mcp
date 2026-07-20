import { MongoClient, Db, type Document } from "mongodb";
import {
    Database,
    MongoConnectionConfig,
    QueryParams,
    TableRelation,
} from "./database-source.js";
import type { ColumnInfo, ColumnProfile, ProfileOptions, TableInfo } from "./sources/types.js";
import { DEFAULT_PROFILE_OPTIONS } from "./sources/types.js";
import type { ExecuteOptions } from "./governance/plan.js";
import {
    buildMongoPlan,
    type MongoQueryPlan,
} from "./governance/mongo.js";
import {
    enforceValueByteLimit,
    ResultByteAccumulator,
    resolveMaxBytes,
} from "./execution/result-size.js";

/** How many documents to sample when inferring a collection's fields. */
const SAMPLE_SIZE = 100;

/** BSON-ish type name for an inferred column's `dataType`. */
function bsonTypeOf(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (typeof value === 'object') {
        // ObjectId and friends expose _bsontype.
        const bsontype = (value as { _bsontype?: string })._bsontype;
        return bsontype ? bsontype.toLowerCase() : 'object';
    }
    return typeof value;
}

interface FieldObservation {
    readonly types: Set<string>;
    present: number;
}

interface CollectionMetadata {
    readonly name: string;
    readonly type?: string;
    readonly options?: {
        readonly viewOn?: string;
        readonly pipeline?: readonly Document[];
    };
}

export class MongoDatabase extends Database<MongoConnectionConfig, MongoQueryPlan> {
    private client: MongoClient | null = null;
    private db: Db | null = null;

    constructor(config: MongoConnectionConfig) {
        super(config);
    }

    async connect(): Promise<void> {
        const uri = this.config.options.uri;
        const database = this.config.options.database;

        if (!uri || !database) {
            throw new Error("MongoDB requires both uri and database options");
        }

        this.client = new MongoClient(uri);
        await this.client.connect();
        this.db = this.client.db(database);
        await this.db.command({ ping: 1 });
    }

    async query(queryString: string, params?: QueryParams): Promise<unknown> {
        // Kept for the internal Database contract, but deliberately gated too:
        // no alternate caller can use this legacy surface to bypass R1.6.
        const plan = buildMongoPlan(params ?? queryString);
        return this.execute(plan);
    }

    async execute(plan: MongoQueryPlan, options?: ExecuteOptions): Promise<unknown> {
        const payload = plan.payload;
        const db = this.requireDb();
        const collection = db.collection(payload.collection);
        const maxBytes = resolveMaxBytes(options);

        switch (payload.operation) {
            case "find":
                return collectCursor(
                    collection.find(payload.filter || {}, {
                        projection: payload.projection,
                        sort: payload.sort,
                        limit: payload.limit,
                        skip: payload.skip,
                    }),
                    maxBytes,
                );
            case "findOne": {
                const result = await collection.findOne(payload.filter || {}, {
                    projection: payload.projection,
                    sort: payload.sort,
                });
                return enforceValueByteLimit(result, maxBytes);
            }
            case "aggregate":
                return collectCursor(
                    collection.aggregate([...(payload.pipeline || [])]),
                    maxBytes,
                );
            case "countDocuments": {
                const result = await collection.countDocuments(payload.filter || {});
                return enforceValueByteLimit(result, maxBytes);
            }
            case "distinct":
                if (!payload.field) {
                    throw new Error("MongoDB distinct queries require a field");
                }
                return enforceValueByteLimit(
                    await collection.distinct(payload.field, payload.filter || {}),
                    maxBytes,
                );
            default:
                throw new Error(`Unsupported MongoDB operation: ${String(payload.operation)}`);
        }
    }

    async listTables(): Promise<TableInfo[]> {
        const db = this.requireDb();
        const collections = await db.listCollections({}, { nameOnly: false }).toArray();

        return Promise.all(
            collections
                .filter((collection) => !collection.name.startsWith('system.'))
                .map(async (collection) => ({
                    name: collection.name,
                    schema: this.config.options.database,
                    kind: collection.type === 'view' ? 'view' as const : 'table' as const,
                    ...(collection.type !== 'view' ? {
                        estimatedRowCount: await db
                            .collection(collection.name)
                            .estimatedDocumentCount(),
                    } : {}),
                }))
        );
    }

    async getSchema(collectionName?: string): Promise<ColumnInfo[]> {
        const db = this.requireDb();

        const names = collectionName
            ? [collectionName]
            : (await db.listCollections({}, { nameOnly: true }).toArray())
                .map((collection) => collection.name)
                .filter((name) => !name.startsWith('system.'));

        const perCollection = await Promise.all(
            names.map((name) => this.describeCollection(name))
        );
        return perCollection.flat();
    }

    /**
     * Derives columns for one collection by sampling documents.
     *
     * A document store has no declared schema, so fields are inferred from a
     * sample. Sampling many documents rather than one is what makes an
     * optional field visible: `findOne` would miss any field absent from the
     * first document, and would report a single type for a heterogeneous one.
     */
    private async describeCollection(name: string): Promise<ColumnInfo[]> {
        const db = this.requireDb();
        const collection = db.collection(name);

        const [sample, indexes] = await Promise.all([
            collection
                .aggregate([{ $sample: { size: SAMPLE_SIZE } }])
                .toArray()
                .catch(() => [] as Document[]),
            collection.indexes().catch(() => []),
        ]);

        /** Dotted field path -> observed BSON types and document presence count. */
        const fields = new Map<string, FieldObservation>();
        for (const doc of sample) {
            const observed = new Map<string, Set<string>>();
            for (const [field, value] of Object.entries(doc)) {
                observeField(field, value, observed, false);
            }
            for (const [field, types] of observed) {
                const entry = fields.get(field) ?? { types: new Set<string>(), present: 0 };
                for (const type of types) entry.types.add(type);
                entry.present += 1;
                fields.set(field, entry);
            }
        }

        /** Fields covered by a single-field unique index. */
        const uniqueFields = new Set(
            indexes
                .filter((i) => i.unique && Object.keys(i.key).length === 1)
                .map((i) => Object.keys(i.key)[0])
        );

        return [...fields.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([field, info], index) => ({
                table: name,
                name: field,
                // A union when the sample disagrees, rather than first-seen.
                dataType: [...info.types].sort().join(' | '),
                // Missing or explicitly null in a sampled document is nullable.
                nullable: field !== '_id' &&
                    (info.present < sample.length || info.types.has('null')),
                isPrimaryKey: field === '_id',
                isUnique: field === '_id' || uniqueFields.has(field),
                position: index + 1,
            }));
    }

    private requireDb(): Db {
        if (!this.db) {
            throw new Error("Database not connected");
        }
        return this.db;
    }

    async profile(
        table: string,
        columns?: string[],
        options?: ProfileOptions,
    ): Promise<ColumnProfile[]> {
        const db = this.requireDb();
        const opts = { ...DEFAULT_PROFILE_OPTIONS, ...options };
        const collection = db.collection(table);

        const fields = columns ?? (await this.describeCollection(table)).map((c) => c.name);
        const total = await collection.estimatedDocumentCount();

        return Promise.all(
            fields.map(async (field): Promise<ColumnProfile> => {
                // $group in-engine rather than pulling values into Node, for
                // the same reason the SQL path uses count(distinct ...).
                const grouped = await collection
                    .aggregate([
                        { $match: { [field]: { $ne: null } } },
                        { $group: { _id: `$${field}`, frequency: { $sum: 1 } } },
                        // Stable tie-breaking keeps generated MDL idempotent.
                        { $sort: { frequency: -1, _id: 1 } },
                        { $limit: opts.maxDistinctForTopValues + 1 },
                    ])
                    .toArray();
                grouped.sort((left, right) =>
                    Number(right.frequency) - Number(left.frequency) ||
                    stableProfileKey(left._id).localeCompare(stableProfileKey(right._id)));

                const nonNull = grouped.reduce((sum, g) => sum + Number(g.frequency), 0);
                const distinctCount = grouped.length;

                const profile: ColumnProfile = {
                    table,
                    column: field,
                    distinctCount,
                    nullRate: total === 0 ? 0 : Math.max(0, (total - nonNull) / total),
                };

                // Omitted rather than truncated above the cutoff — the extra
                // element fetched above is what detects "more than the cutoff".
                if (distinctCount > 0 && distinctCount <= opts.maxDistinctForTopValues) {
                    profile.topValues = grouped
                        .slice(0, opts.topValueLimit)
                        .map((g) => ({ value: g._id, count: Number(g.frequency) }));
                }

                return profile;
            })
        );
    }

    async getRelations(_databaseName?: string): Promise<TableRelation[]> {
        const collections = await this.requireDb()
            .listCollections({}, { nameOnly: false })
            .toArray() as CollectionMetadata[];
        const relations = collections.flatMap((collection) => {
            const source = collection.options?.viewOn;
            const pipeline = collection.options?.pipeline;
            if (collection.type !== 'view' || !source || !Array.isArray(pipeline)) return [];
            return lookupRelations(collection.name, source, pipeline);
        });
        return relations.sort((left, right) =>
            left.constraintName.localeCompare(right.constraintName));
    }

}

function stableProfileKey(value: unknown): string {
    return JSON.stringify(normalizeProfileValue(value));
}

function normalizeProfileValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(normalizeProfileValue);
    if (value && typeof value === 'object') {
        const bsonType = (value as { _bsontype?: unknown })._bsontype;
        if (bsonType) return `${String(bsonType)}:${String(value)}`;
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, normalizeProfileValue(nested)]),
        );
    }
    return value;
}

/** Records nested document fields as dotted paths; array nesting stays explicit. */
function observeField(
    path: string,
    value: unknown,
    observed: Map<string, Set<string>>,
    repeated: boolean,
): void {
    const type = bsonTypeOf(value);
    const recordedType = repeated && type !== 'null' ? `array<${type}>` : type;
    const types = observed.get(path) ?? new Set<string>();
    types.add(recordedType);
    observed.set(path, types);

    if (Array.isArray(value)) {
        for (const item of value) {
            if (!isEmbeddedDocument(item)) continue;
            for (const [field, nested] of Object.entries(item)) {
                observeField(`${path}.${field}`, nested, observed, true);
            }
        }
    } else if (isEmbeddedDocument(value)) {
        for (const [field, nested] of Object.entries(value)) {
            observeField(`${path}.${field}`, nested, observed, repeated);
        }
    }
}

function isEmbeddedDocument(value: unknown): value is Record<string, unknown> {
    return Boolean(
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        !(value as { _bsontype?: unknown })._bsontype,
    );
}

function lookupRelations(
    viewName: string,
    source: string,
    pipeline: readonly Document[],
): TableRelation[] {
    const relations: TableRelation[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const document = value as Record<string, unknown>;
        const lookup = document.$lookup;
        if (lookup && typeof lookup === 'object' && !Array.isArray(lookup)) {
            const spec = lookup as Record<string, unknown>;
            if (
                typeof spec.from === 'string' &&
                typeof spec.localField === 'string' &&
                typeof spec.foreignField === 'string'
            ) {
                const alias = typeof spec.as === 'string' ? spec.as : spec.from;
                relations.push({
                    childTable: source,
                    childColumn: spec.localField,
                    constraintName: `lookup:${viewName}:${alias}`,
                    parentTable: spec.from,
                    parentColumn: spec.foreignField,
                });
            }
        }
        for (const nested of Object.values(document)) visit(nested);
    };
    visit(pipeline);
    return relations;
}

async function collectCursor<T>(
    cursor: AsyncIterable<T> & { close(): Promise<void> },
    maxBytes: number,
): Promise<T[]> {
    const rows = new ResultByteAccumulator<T>(maxBytes);
    try {
        for await (const row of cursor) rows.add(row);
        return rows.result();
    } finally {
        // On overflow this kills the server cursor before unread documents are
        // decoded or retained. close() is harmless after normal exhaustion.
        await cursor.close();
    }
}
