/** Idempotent MCP discovery-stub installation into a JSON client config. */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

export const DISCOVERY_NAME = 'data-store-mcp';

export interface SkillDiscoveryOptions {
    command?: string;
}

export interface SkillDiscoveryResult {
    configPath: string;
    changed: boolean;
    entry: {
        command: string;
        args: ['serve'];
    };
}

export async function installSkillDiscovery(
    configPath: string,
    options: SkillDiscoveryOptions = {},
): Promise<SkillDiscoveryResult> {
    if (!configPath.trim()) throw new Error('Client config path must not be empty.');
    const command = options.command?.trim() || 'dsm';
    const absolutePath = resolve(configPath);
    const root = await readConfig(absolutePath);
    const servers = objectField(root, 'mcpServers');
    const entry = { command, args: ['serve'] as ['serve'] };
    const existing = servers[DISCOVERY_NAME];

    if (existing !== undefined) {
        if (!matchesDiscovery(existing, entry)) {
            throw new Error(
                `Client config already defines a conflicting ${DISCOVERY_NAME} MCP server.`,
            );
        }
        return { configPath: absolutePath, changed: false, entry };
    }

    servers[DISCOVERY_NAME] = entry;
    await writeConfigAtomically(absolutePath, root);
    return { configPath: absolutePath, changed: true, entry };
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        throw new Error(`Could not parse client config ${path}: ${(error as Error).message}`);
    }
    if (!isObject(parsed)) throw new Error(`Client config ${path} must contain a JSON object.`);
    return parsed;
}

function objectField(root: Record<string, unknown>, key: string): Record<string, unknown> {
    const current = root[key];
    if (current === undefined) {
        const created: Record<string, unknown> = {};
        root[key] = created;
        return created;
    }
    if (!isObject(current)) throw new Error(`Client config field ${key} must be a JSON object.`);
    return current;
}

function matchesDiscovery(
    value: unknown,
    expected: { command: string; args: ['serve'] },
): boolean {
    if (!isObject(value)) return false;
    return value.command === expected.command &&
        Array.isArray(value.args) &&
        value.args.length === 1 &&
        value.args[0] === 'serve';
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function writeConfigAtomically(
    path: string,
    value: Record<string, unknown>,
): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = resolve(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
