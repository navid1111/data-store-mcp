/** Deterministic shortest-path resolution over declared MDL relationships. */

import type { MdlDocument, Relationship } from './types.js';

export interface JoinPathStep {
    relationship: Relationship;
    fromModel: string;
    toModel: string;
    reversed: boolean;
}

export interface JoinPath {
    models: string[];
    steps: JoinPathStep[];
}

export type JoinPathErrorCode = 'E_NO_JOIN_PATH' | 'E_AMBIGUOUS_JOIN_PATH';

export class JoinPathError extends Error {
    readonly code: JoinPathErrorCode;
    readonly routes: readonly string[];

    constructor(code: JoinPathErrorCode, message: string, routes: readonly string[] = []) {
        super(message);
        this.name = 'JoinPathError';
        this.code = code;
        this.routes = routes;
    }
}

interface Edge {
    relationship: Relationship;
    fromModel: string;
    toModel: string;
    reversed: boolean;
}

/**
 * Returns the unique shortest join route. All candidates at the winning depth
 * are collected before a choice is made, so relationship/file ordering can
 * never silently resolve ambiguity.
 */
export function resolveJoinPath(
    document: Pick<MdlDocument, 'models' | 'relationships'>,
    fromModel: string,
    toModel: string,
): JoinPath {
    const modelNames = new Set(document.models.map((model) => model.name));
    if (!modelNames.has(fromModel) || !modelNames.has(toModel)) {
        throw noPath(fromModel, toModel);
    }
    if (fromModel === toModel) return { models: [fromModel], steps: [] };

    const adjacency = buildAdjacency(document.relationships);
    let frontier: JoinPath[] = [{ models: [fromModel], steps: [] }];

    while (frontier.length > 0) {
        const matches: JoinPath[] = [];
        const next: JoinPath[] = [];

        for (const path of frontier) {
            const current = path.models[path.models.length - 1];
            for (const edge of adjacency.get(current) ?? []) {
                // A path is simple: this both prevents cycles and makes a
                // self-referencing FK harmless during traversal.
                if (path.models.includes(edge.toModel)) continue;
                const candidate: JoinPath = {
                    models: [...path.models, edge.toModel],
                    steps: [...path.steps, edge],
                };
                if (edge.toModel === toModel) matches.push(candidate);
                else next.push(candidate);
            }
        }

        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
            const routes = matches.map(routeName).sort();
            throw new JoinPathError(
                'E_AMBIGUOUS_JOIN_PATH',
                `Ambiguous join path from "${fromModel}" to "${toModel}": ${routes.join(' or ')}.`,
                routes,
            );
        }
        frontier = next;
    }

    throw noPath(fromModel, toModel);
}

function buildAdjacency(relationships: readonly Relationship[]): Map<string, Edge[]> {
    const adjacency = new Map<string, Edge[]>();
    for (const relationship of relationships) {
        addEdge(adjacency, {
            relationship,
            fromModel: relationship.fromModel,
            toModel: relationship.toModel,
            reversed: false,
        });
        addEdge(adjacency, {
            relationship,
            fromModel: relationship.toModel,
            toModel: relationship.fromModel,
            reversed: true,
        });
    }
    for (const edges of adjacency.values()) {
        edges.sort((left, right) =>
            left.relationship.name.localeCompare(right.relationship.name) ||
            left.toModel.localeCompare(right.toModel));
    }
    return adjacency;
}

function addEdge(adjacency: Map<string, Edge[]>, edge: Edge): void {
    const edges = adjacency.get(edge.fromModel) ?? [];
    edges.push(edge);
    adjacency.set(edge.fromModel, edges);
}

function routeName(path: JoinPath): string {
    return `${path.models.join(' -> ')} [${path.steps.map((step) => step.relationship.name).join(', ')}]`;
}

function noPath(fromModel: string, toModel: string): JoinPathError {
    return new JoinPathError(
        'E_NO_JOIN_PATH',
        `No join path from "${fromModel}" to "${toModel}".`,
    );
}
