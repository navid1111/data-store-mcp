/** Deterministic, validated in-memory index of semantic YAML files. */

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parseMdlYaml } from './schema.js';
import type {
    Cube,
    MdlDocument,
    Metric,
    Model,
    Relationship,
    View,
} from './types.js';

type NamedEntity = Model | Relationship | Metric | View | Cube;

interface LoadedDocument {
    path: string;
    document: MdlDocument;
}

export class SemanticRegistry {
    readonly document: Readonly<MdlDocument>;
    private readonly modelsByName: ReadonlyMap<string, Model>;
    private readonly metricsByName: ReadonlyMap<string, Metric>;

    private constructor(document: MdlDocument) {
        this.document = Object.freeze(document);
        this.modelsByName = new Map(document.models.map((model) => [model.name, model]));
        this.metricsByName = new Map(document.metrics.map((metric) => [metric.name, metric]));
    }

    static async load(directory: string): Promise<SemanticRegistry> {
        return SemanticRegistry.loadFiles(await yamlFiles(resolve(directory)));
    }

    /** Public for callers that already discovered files and deterministic tests. */
    static async loadFiles(paths: readonly string[]): Promise<SemanticRegistry> {
        const orderedPaths = [...paths]
            .map((path) => resolve(path))
            .sort((left, right) => left.localeCompare(right));
        const loaded = await Promise.all(orderedPaths.map(loadDocument));
        return new SemanticRegistry(mergeAndValidate(loaded));
    }

    /** Map lookup is intentionally case-sensitive and O(1). */
    getModel(name: string): Model | undefined {
        return this.modelsByName.get(name);
    }

    /** Map lookup is intentionally case-sensitive and O(1). */
    getMetric(name: string): Metric | undefined {
        return this.metricsByName.get(name);
    }
}

async function yamlFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return yamlFiles(path);
        return entry.isFile() && ['.yml', '.yaml'].includes(extname(entry.name).toLowerCase())
            ? [path]
            : [];
    }));
    return nested.flat();
}

async function loadDocument(path: string): Promise<LoadedDocument> {
    try {
        return { path, document: parseMdlYaml(await readFile(path, 'utf8')) };
    } catch (error) {
        throw new Error(`Invalid MDL file ${path}: ${(error as Error).message}`, { cause: error });
    }
}

function mergeAndValidate(loaded: LoadedDocument[]): MdlDocument {
    const merged: MdlDocument = {
        models: [],
        relationships: [],
        metrics: [],
        views: [],
        cubes: [],
    };
    const origins = new Map<string, string>();

    for (const item of loaded) {
        appendUnique('model', item.document.models, item.path, merged.models, origins);
        appendUnique('relationship', item.document.relationships, item.path, merged.relationships, origins);
        appendUnique('metric', item.document.metrics, item.path, merged.metrics, origins);
        appendUnique('view', item.document.views, item.path, merged.views, origins);
        appendUnique('cube', item.document.cubes, item.path, merged.cubes, origins);
    }

    const modelNames = new Set(merged.models.map((model) => model.name));
    for (const relationship of merged.relationships) {
        assertModelExists(relationship.fromModel, `relationship ${relationship.name}`, modelNames);
        assertModelExists(relationship.toModel, `relationship ${relationship.name}`, modelNames);
        if (relationship.throughModel) {
            assertModelExists(relationship.throughModel, `relationship ${relationship.name}`, modelNames);
        }
    }

    const collections: NamedEntity[][] = [
        merged.models,
        merged.relationships,
        merged.metrics,
        merged.views,
        merged.cubes,
    ];
    for (const entities of collections) {
        entities.sort((left, right) => left.name.localeCompare(right.name));
        Object.freeze(entities);
    }
    return merged;
}

function appendUnique<T extends NamedEntity>(
    kind: string,
    entities: T[],
    path: string,
    target: T[],
    origins: Map<string, string>,
): void {
    for (const entity of entities) {
        const key = `${kind}:${entity.name}`;
        const previous = origins.get(key);
        if (previous) {
            throw new Error(`Duplicate ${kind} name "${entity.name}" in ${previous} and ${path}.`);
        }
        origins.set(key, path);
        target.push(entity);
    }
}

function assertModelExists(name: string, owner: string, models: Set<string>): void {
    if (!models.has(name)) {
        throw new Error(`${owner} references undefined model "${name}".`);
    }
}
