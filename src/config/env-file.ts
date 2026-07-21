/**
 * Reads a `.env` file into the process environment.
 *
 * The config resolves `${NAME}` references from the environment, which works
 * naturally when a launcher can supply them — the VS Code extension reads the
 * workspace `.env` and passes the values to the child process. Other MCP
 * clients (Claude Code, Codex) have no such notion: their config files take a
 * literal `env` map, so without this the only options are exporting variables
 * in the parent shell or writing secrets into a file that gets committed.
 *
 * Existing environment variables always win. An explicit export or a value set
 * by the MCP client is more specific than a file on disk, and silently
 * overriding it would make the effective credentials hard to reason about.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses `.env` contents. Supports quotes, `export` prefixes and `#` comments. */
export function parseEnvFile(contents: string): Record<string, string> {
    const values: Record<string, string> = {};

    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) continue;

        const match = LINE.exec(line);
        if (!match) continue;

        values[match[1]] = unquote(match[2]);
    }

    return values;
}

function unquote(raw: string): string {
    const value = raw.trim();

    const quoted =
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1);

    if (quoted) {
        const inner = value.slice(1, -1);
        return value.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
    }

    // Trailing comments are stripped only on unquoted values: a `#` inside
    // quotes is data, and passwords legitimately contain one.
    return value.replace(/\s+#.*$/, '').trim();
}

/**
 * Loads `path` into `env`, leaving already-set variables untouched.
 *
 * @returns the names applied, for logging
 * @throws if the file cannot be read — an explicitly requested env file that
 *         is missing is a configuration error, not something to shrug off.
 */
export function loadEnvFile(
    path: string,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const absolutePath = resolve(path);

    let contents: string;
    try {
        contents = readFileSync(absolutePath, 'utf8');
    } catch (error) {
        throw new Error(
            `Could not read env file ${absolutePath}: ${(error as Error).message}`,
        );
    }

    const applied: string[] = [];
    for (const [name, value] of Object.entries(parseEnvFile(contents))) {
        if (env[name] === undefined) {
            env[name] = value;
            applied.push(name);
        }
    }

    return applied;
}
