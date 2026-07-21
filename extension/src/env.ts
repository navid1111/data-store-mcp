/**
 * Minimal .env reader.
 *
 * Deliberately not the `dotenv` package: this must never call
 * `dotenv.config()`, which mutates `process.env` in the *extension host* — a
 * process shared with every other extension. Values are parsed into a plain
 * object and handed only to the spawned server.
 */

export interface EnvFile {
    /** Parsed key/value pairs. Empty if the file does not exist. */
    values: Record<string, string>;
    /** False when the file is absent, so callers can guide the user. */
    exists: boolean;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses .env contents. Supports quotes, `export` prefixes, and `#` comments. */
export function parseEnv(contents: string): Record<string, string> {
    const values: Record<string, string> = {};

    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const match = LINE.exec(line);
        if (!match) {
            continue;
        }

        const [, key, rawValue] = match;
        values[key] = unquote(rawValue);
    }

    return values;
}

function unquote(raw: string): string {
    const value = raw.trim();

    if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
        const inner = value.slice(1, -1);
        // Only double quotes get escape processing, matching dotenv.
        return value.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
    }

    // Strip a trailing inline comment on unquoted values only — a `#` inside
    // quotes is data, and passwords legitimately contain one.
    const withoutComment = value.replace(/\s+#.*$/, '');
    return withoutComment.trim();
}

/**
 * Names referenced as `${NAME}` in a config document.
 *
 * Used to tell the user exactly which variables their .env is missing, rather
 * than letting the server fail with one name at a time.
 */
export function referencedVariables(configText: string): string[] {
    const names = new Set<string>();
    const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(configText)) !== null) {
        names.add(match[1]);
    }

    return [...names].sort();
}
