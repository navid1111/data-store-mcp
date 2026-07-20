/** Startup configuration loading (spec R8.1/R8.2). */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ConnectionConfig } from '../database-source.js';
import type { ExecuteOptions } from '../governance/plan.js';
import { policyDocumentSchema, type PolicyDocument } from '../governance/policy.js';

export const CONFIG_PATH_ENV = 'DATA_STORE_MCP_CONFIG';

const sqlOptions = z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    user: z.string().min(1),
    password: z.string(),
    database: z.string().min(1),
}).strict();

const sourceSchema = z.discriminatedUnion('type', [
    z.object({
        name: z.string().min(1),
        type: z.literal('postgres'),
        description: z.string().min(1).optional(),
        options: sqlOptions,
    }).strict(),
    z.object({
        name: z.string().min(1),
        type: z.literal('mysql'),
        description: z.string().min(1).optional(),
        options: sqlOptions,
    }).strict(),
    z.object({
        name: z.string().min(1),
        type: z.literal('mongodb'),
        description: z.string().min(1).optional(),
        options: z.object({
            uri: z.string().min(1),
            database: z.string().min(1),
        }).strict(),
    }).strict(),
]);

const configSchema = z.object({
    principal: z.string().trim().min(1),
    semantic: z.object({
        path: z.string().min(1),
    }).strict(),
    audit: z.object({
        path: z.string().min(1),
    }).strict(),
    memory: z.object({
        path: z.string().min(1),
    }).strict().optional(),
    sources: z.array(sourceSchema).min(1),
    limits: z.object({
        maxResultBytes: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
    }).strict().optional(),
    policies: policyDocumentSchema.optional(),
}).strict();

export interface AppConfig {
    semanticPath: string;
    audit: {
        path: string;
        principal: string;
    };
    sources: ConnectionConfig[];
    execution: ExecuteOptions;
    memoryPath?: string;
    policies?: PolicyDocument;
}

/**
 * Loads the JSON file named by DATA_STORE_MCP_CONFIG.
 *
 * String values may reference environment variables as `${NAME}`. Expansion
 * happens before validation and missing variables fail startup without ever
 * printing another config value.
 */
export async function loadConfig(
    configPath = process.env[CONFIG_PATH_ENV],
    env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
    if (!configPath) {
        throw new Error(
            `${CONFIG_PATH_ENV} must point to a JSON configuration file containing sources.`,
        );
    }

    const absolutePath = resolve(configPath);
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(absolutePath, 'utf8'));
    } catch (error) {
        throw new Error(
            `Could not load configuration from ${absolutePath}: ${(error as Error).message}`,
        );
    }

    return parseConfig(raw, env);
}

/** Pure parser exported for deterministic unit tests and alternate transports. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = configSchema.parse(interpolateEnvironment(raw, env));
    const names = new Set<string>();

    const sources: ConnectionConfig[] = parsed.sources.map((source) => {
        if (names.has(source.name)) {
            throw new Error(`Duplicate source name: ${source.name}`);
        }
        names.add(source.name);

        switch (source.type) {
            case 'postgres':
                return {
                    id: source.name,
                    type: 'postgres',
                    ...(source.description ? { description: source.description } : {}),
                    options: source.options,
                };
            case 'mysql':
                return {
                    id: source.name,
                    type: 'mysql',
                    ...(source.description ? { description: source.description } : {}),
                    options: source.options,
                };
            case 'mongodb':
                return {
                    id: source.name,
                    type: 'mongodb',
                    ...(source.description ? { description: source.description } : {}),
                    options: source.options,
                };
        }
    });

    return {
        semanticPath: parsed.semantic.path,
        audit: {
            path: parsed.audit.path,
            principal: parsed.principal,
        },
        sources,
        execution: {
            ...(parsed.limits?.maxResultBytes !== undefined
                ? { maxBytes: parsed.limits.maxResultBytes }
                : {}),
            ...(parsed.limits?.timeoutMs !== undefined
                ? { timeoutMs: parsed.limits.timeoutMs }
                : {}),
        },
        ...(parsed.memory ? { memoryPath: parsed.memory.path } : {}),
        ...(parsed.policies ? { policies: parsed.policies } : {}),
    };
}

function interpolateEnvironment(value: unknown, env: NodeJS.ProcessEnv): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
            const replacement = env[name];
            if (replacement === undefined) {
                throw new Error(`Configuration references missing environment variable: ${name}`);
            }
            return replacement;
        });
    }

    if (Array.isArray(value)) {
        return value.map((item) => interpolateEnvironment(item, env));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
                key,
                interpolateEnvironment(nested, env),
            ]),
        );
    }

    return value;
}
