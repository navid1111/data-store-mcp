/** Core semantic-model (MDL) entity types (spec R3.2/R3.6). */

export const PROVENANCE_VALUES = [
    'introspection',
    'profiling',
    'db_comment',
    'query_log',
    'llm_draft',
    'human',
] as const;

export type Provenance = typeof PROVENANCE_VALUES[number];

export interface MdlEntity {
    name: string;
    description: string;
    provenance: Provenance;
    verified: boolean;
}

export interface Column extends MdlEntity {
    dataType: string;
    sourceColumn?: string;
    nullable?: boolean;
    isPrimaryKey?: boolean;
    isUnique?: boolean;
}

export interface Model extends MdlEntity {
    source: string;
    table: string;
    kind: 'table' | 'view';
    columns: Column[];
}

export type RelationshipCardinality =
    | 'one-to-many'
    | 'many-to-one'
    | 'many-to-many';

export interface RelationshipJoinKey {
    fromColumn: string;
    toColumn: string;
}

export interface Relationship extends MdlEntity {
    fromModel: string;
    toModel: string;
    cardinality: RelationshipCardinality;
    joinKeys: RelationshipJoinKey[];
    throughModel?: string;
}

export interface Metric extends MdlEntity {
    model: string;
    expression: string;
}

/** A reusable named projection over one model. */
export interface View extends MdlEntity {
    model: string;
    columns: string[];
    metrics: string[];
}

/** A business-facing collection of dimensions and aggregate measures. */
export interface Cube extends MdlEntity {
    model: string;
    dimensions: string[];
    measures: string[];
}

export interface MdlDocument {
    models: Model[];
    relationships: Relationship[];
    metrics: Metric[];
    views: View[];
    cubes: Cube[];
}
