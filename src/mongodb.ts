import { MongoClient, Db, Document, Filter } from "mongodb";
import { Database, ConnectionConfig, TableRelation } from "./database-source.js";

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

export class MongoDatabase extends Database {
    private client: MongoClient | null = null;
    private db: Db | null = null;

    constructor(config: ConnectionConfig) {
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

    async query(queryString: string, params?: any): Promise<any> {
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

    async getSchema(collectionName?: string): Promise<any> {
        if (!this.db) {
            throw new Error("Database not connected");
        }

        if (collectionName) {
            return [await this.inspectCollection(collectionName)];
        }

        const collections = await this.db.listCollections({}, { nameOnly: true }).toArray();
        return Promise.all(
            collections.map((collection) => this.inspectCollection(collection.name))
        );
    }

    async getRelations(_databaseName?: string): Promise<TableRelation[]> {
        return [];
    }

    private parseQuery(queryString: string, params?: any): MongoQueryPayload {
        const rawPayload = params && typeof params === "object" && !Array.isArray(params)
            ? params
            : JSON.parse(queryString);

        if (!rawPayload || typeof rawPayload !== "object") {
            throw new Error("MongoDB query must be an object or JSON object string");
        }

        if (!rawPayload.operation || !rawPayload.collection) {
            throw new Error("MongoDB query requires operation and collection");
        }

        return rawPayload as MongoQueryPayload;
    }

    private async inspectCollection(collectionName: string): Promise<any> {
        if (!this.db) {
            throw new Error("Database not connected");
        }

        const collection = this.db.collection(collectionName);
        const [indexes, sample, estimatedDocumentCount] = await Promise.all([
            collection.indexes(),
            collection.findOne({}, { projection: { _id: 0 } }),
            collection.estimatedDocumentCount(),
        ]);

        return {
            name: collectionName,
            estimatedDocumentCount,
            sampleFields: sample ? Object.keys(sample) : [],
            indexes: indexes.map((index) => ({
                name: index.name,
                key: index.key,
                unique: Boolean(index.unique),
            })),
        };
    }
}
