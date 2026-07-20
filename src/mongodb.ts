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
        const collections = await db.listCollections({}, { nameOnly: true }).toArray();

        return Promise.all(
            collections.map(async (c) => ({
                name: c.name,
                schema: this.config.options.database,
                // Mongo has no view/table distinction in listCollections with
                // nameOnly; views would need `type` from the full listing.
                kind: 'table' as const,
                estimatedRowCount: await db.collection(c.name).estimatedDocumentCount(),
            }))
        );
    }

    async getSchema(collectionName?: string): Promise<ColumnInfo[]> {
        const db = this.requireDb();

        const names = collectionName
            ? [collectionName]
            : (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

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

        /** Field name -> observed BSON type names and how many docs contained it. */
        const fields = new Map<string, { types: Set<string>; present: number }>();
        for (const doc of sample) {
            for (const [key, value] of Object.entries(doc)) {
                const entry = fields.get(key) ?? { types: new Set<string>(), present: 0 };
                entry.types.add(bsonTypeOf(value));
                entry.present += 1;
                fields.set(key, entry);
            }
        }

        /** Fields covered by a single-field unique index. */
        const uniqueFields = new Set(
            indexes
                .filter((i) => i.unique && Object.keys(i.key).length === 1)
                .map((i) => Object.keys(i.key)[0])
        );

        return [...fields.entries()].map(([field, info], index) => ({
            table: name,
            name: field,
            // A union when the sample disagrees, rather than first-seen.
            dataType: [...info.types].sort().join(' | '),
            // Absent from some sampled documents means effectively nullable.
            nullable: field !== '_id' && info.present < sample.length,
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
                        { $sort: { frequency: -1 } },
                        { $limit: opts.maxDistinctForTopValues + 1 },
                    ])
                    .toArray();

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
        return [];
    }

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
