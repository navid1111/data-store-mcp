import { MongoClient, Db, Document, Filter } from "mongodb";
import {
    Database,
    MongoConnectionConfig,
    QueryParams,
    TableRelation,
} from "./database-source.js";
import type { ColumnInfo, TableInfo } from "./sources/types.js";

type MongoOperation = "find" | "findOne" | "aggregate" | "countDocuments" | "distinct";

interface MongoQueryPayload {
    operation: MongoOperation;
    collection: string;
    filter?: Filter<Document>;
    projection?: Document;
    sort?: Document;
    limit?: number;
    skip?: number;
    pipeline?: Document[];
    field?: string;
}

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

export class MongoDatabase extends Database<MongoConnectionConfig> {
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
        if (!this.db) {
            throw new Error("Database not connected");
        }

        const payload = this.parseQuery(queryString, params);
        const collection = this.db.collection(payload.collection);

        switch (payload.operation) {
            case "find":
                return collection
                    .find(payload.filter || {}, {
                        projection: payload.projection,
                        sort: payload.sort,
                        limit: payload.limit,
                        skip: payload.skip,
                    })
                    .toArray();
            case "findOne":
                return collection.findOne(payload.filter || {}, {
                    projection: payload.projection,
                    sort: payload.sort,
                });
            case "aggregate":
                return collection.aggregate(payload.pipeline || []).toArray();
            case "countDocuments":
                return collection.countDocuments(payload.filter || {});
            case "distinct":
                if (!payload.field) {
                    throw new Error("MongoDB distinct queries require a field");
                }
                return collection.distinct(payload.field, payload.filter || {});
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

    async getRelations(_databaseName?: string): Promise<TableRelation[]> {
        return [];
    }

    private parseQuery(queryString: string, params?: QueryParams): MongoQueryPayload {
        // Not `as any`: the payload is unvalidated external input, so it is
        // asserted to the expected shape once, after the guards below.
        const rawPayload: Record<string, unknown> =
            params && typeof params === "object" && !Array.isArray(params)
                ? params
                : JSON.parse(queryString);

        if (!rawPayload || typeof rawPayload !== "object") {
            throw new Error("MongoDB query must be an object or JSON object string");
        }

        if (!rawPayload.operation || !rawPayload.collection) {
            throw new Error("MongoDB query requires operation and collection");
        }

        return rawPayload as unknown as MongoQueryPayload;
    }

}
