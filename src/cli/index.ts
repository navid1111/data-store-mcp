#!/usr/bin/env node

/** Command-line entry point for local administration and governed queries. */

import type { ConnectionConfig, Database } from '../database-source.js';
import { loadConfig, CONFIG_PATH_ENV, type AppConfig } from '../config/load.js';
import { PostgresDatabase } from '../postgres.js';
import { MysqlDatabase } from '../mysql.js';
import { MongoDatabase } from '../mongodb.js';
import { lintMdlFile } from '../semantic/linter.js';
import { bootstrapMdl } from '../semantic/bootstrap.js';
import { buildPlan, dialectFor } from '../governance/gate.js';
import { AuditLog } from '../audit/log.js';
import { executeWithAudit } from '../audit/execution.js';
import { SemanticRegistry } from '../semantic/registry.js';
import { ExecutionMemoryIndex } from '../memory/index.js';
import { toToolErrorPayload } from '../mcp/errors.js';
import { askQuestion, type GuidedAskContext } from '../orchestrator/ask.js';
import { CommandPromptClient } from '../orchestrator/command-client.js';
import { loadProjectContext } from '../orchestrator/context.js';
import { HybridMemoryRetriever } from '../memory/retrieval.js';
import { HashEmbeddingProvider } from '../memory/embedding.js';

type OptionValue = string | boolean;

const BOOLEAN_OPTIONS = new Set(['help', 'json', 'check', 'guided', 'direct']);

interface ParsedArguments {
    options: Map<string, OptionValue>;
    positionals: string[];
}

const ROOT_HELP = `Usage: dsm <command> [options]

Commands:
  serve                 Start the MCP stdio server
  mdl lint              Check an MDL artifact against its live source
  mdl bootstrap         Generate a draft MDL artifact from a live source
  ask <question>        Ask through guided or direct prompting
  query --sql <sql>     Execute governed, read-only SQL

Run "dsm <command> --help" for command-specific options.
`;

const HELP = {
    serve: `Usage: dsm serve [--config <path>] [--check] [--json]

Starts the MCP stdio server. --check validates configuration, semantic artifacts,
audit storage, and source connectivity, then exits.
`,
    lint: `Usage: dsm mdl lint --source <name> --file <path> [--config <path>] [--json]

Checks an MDL YAML artifact against the current schema of its configured source.
`,
    bootstrap: `Usage: dsm mdl bootstrap --source <name> --output <path> [--config <path>] [--json]

Introspects and profiles a configured source into a reviewable MDL YAML artifact.
`,
    query: `Usage: dsm query --source <name> --sql <sql> [--config <path>] [--json]

Executes SQL only after the read-only governance gate has approved and limited it.
--json writes one machine-readable JSON document to stdout.
`,
    ask: `Usage: dsm ask <question> (--guided|--direct) [options]

Options:
  --config <path>       Runtime config containing semantic and memory paths
  --project <path>      Directory containing instructions.md and queries.yml (default: cwd)
  --llm-command <path>  Executable that reads the prompt from stdin and writes a response
  --json                Write the mode and response as machine-readable JSON
`,
} as const;

export async function runCli(argv: string[]): Promise<number> {
    if (argv.length === 0 || isHelp(argv[0])) {
        writeStdout(ROOT_HELP);
        return 0;
    }

    const [command, ...rest] = argv;
    switch (command) {
        case 'serve':
            return runServe(rest);
        case 'mdl':
            return runMdl(rest);
        case 'ask':
            return runAsk(rest);
        case 'query':
            return runQuery(rest);
        default:
            throw new Error(`Unknown command "${command}". Run "dsm --help" for usage.`);
    }
}

async function runAsk(argv: string[]): Promise<number> {
    const parsed = parseArguments(argv);
    assertKnownOptions(parsed, [
        'guided', 'direct', 'config', 'project', 'llm-command', 'json', 'help',
    ]);
    if (hasOption(parsed, 'help')) {
        writeStdout(HELP.ask);
        return 0;
    }
    if (parsed.positionals.length !== 1) {
        throw new Error('ask requires exactly one question argument.');
    }
    const guidedMode = hasOption(parsed, 'guided');
    const directMode = hasOption(parsed, 'direct');
    if (guidedMode === directMode) {
        throw new Error('ask requires exactly one of --guided or --direct.');
    }

    const client = new CommandPromptClient(optionalString(parsed, 'llm-command'));
    let memory: ExecutionMemoryIndex | undefined;
    try {
        let guided: GuidedAskContext | undefined;
        if (guidedMode) {
            const config = await loadConfig(optionalString(parsed, 'config'));
            const semantic = await SemanticRegistry.load(config.semanticPath);
            const project = await loadProjectContext(optionalString(parsed, 'project') ?? process.cwd());
            memory = config.memoryPath
                ? await ExecutionMemoryIndex.open(config.memoryPath)
                : undefined;
            guided = {
                semantic,
                project,
                ...(memory ? {
                    retriever: new HybridMemoryRetriever(memory, new HashEmbeddingProvider()),
                } : {}),
                // The policy engine supplies this set once Phase 4 is active.
                // Keeping it explicit here makes prompt assembly fail-closed.
                hiddenColumns: new Set<string>(),
            };
        }
        const result = await askQuestion(parsed.positionals[0], {
            mode: guidedMode ? 'guided' : 'direct',
            client,
            ...(guided ? { guided } : {}),
        });
        if (hasOption(parsed, 'json')) {
            writeData({ mode: result.mode, response: result.response }, parsed);
        } else {
            writeStdout(`${result.response}\n`);
        }
        return 0;
    } finally {
        memory?.close();
    }
}

async function runServe(argv: string[]): Promise<number> {
    const parsed = parseArguments(argv);
    assertKnownOptions(parsed, ['config', 'check', 'json', 'help']);
    if (hasOption(parsed, 'help')) {
        writeStdout(HELP.serve);
        return 0;
    }
    rejectPositionals(parsed, 'serve');

    const configPath = optionalString(parsed, 'config');
    if (!hasOption(parsed, 'check')) {
        if (configPath) process.env[CONFIG_PATH_ENV] = configPath;
        await import('../server.js');
        return 0;
    }

    const config = await loadConfig(configPath);
    await validateRuntime(config);
    writeData({ ok: true, sources: config.sources.map((source) => source.id) }, parsed);
    return 0;
}

async function runMdl(argv: string[]): Promise<number> {
    const [subcommand, ...rest] = argv;
    if (!subcommand || isHelp(subcommand)) {
        writeStdout(`Usage: dsm mdl <lint|bootstrap> [options]\n`);
        return 0;
    }

    switch (subcommand) {
        case 'lint':
            return runMdlLint(rest);
        case 'bootstrap':
            return runMdlBootstrap(rest);
        default:
            throw new Error(`Unknown mdl command "${subcommand}". Run "dsm mdl --help" for usage.`);
    }
}

async function runMdlLint(argv: string[]): Promise<number> {
    const parsed = parseArguments(argv);
    assertKnownOptions(parsed, ['source', 'file', 'config', 'json', 'help']);
    if (hasOption(parsed, 'help')) {
        writeStdout(HELP.lint);
        return 0;
    }
    rejectPositionals(parsed, 'mdl lint');

    const file = requiredString(parsed, 'file');
    const target = await connectSelectedSource(parsed);
    try {
        const result = await lintMdlFile(target.database, file);
        const payload = { ok: result.exitCode === 0, findings: result.findings };
        if (result.exitCode === 0) writeData(payload, parsed);
        else writeStderr(payload, parsed);
        return result.exitCode;
    } finally {
        await closeDatabase(target.database);
    }
}

async function runMdlBootstrap(argv: string[]): Promise<number> {
    const parsed = parseArguments(argv);
    assertKnownOptions(parsed, ['source', 'output', 'config', 'json', 'help']);
    if (hasOption(parsed, 'help')) {
        writeStdout(HELP.bootstrap);
        return 0;
    }
    rejectPositionals(parsed, 'mdl bootstrap');

    const source = requiredString(parsed, 'source');
    const outputPath = requiredString(parsed, 'output');
    const target = await connectSelectedSource(parsed, source);
    try {
        const result = await bootstrapMdl(target.database, { source, outputPath });
        writeData({
            ok: true,
            outputPath,
            changed: result.changed,
            modelCount: result.document.models.length,
        }, parsed);
        return 0;
    } finally {
        await closeDatabase(target.database);
    }
}

async function runQuery(argv: string[]): Promise<number> {
    const parsed = parseArguments(argv);
    assertKnownOptions(parsed, ['source', 'sql', 'config', 'json', 'help']);
    if (hasOption(parsed, 'help')) {
        writeStdout(HELP.query);
        return 0;
    }
    rejectPositionals(parsed, 'query');

    const sql = requiredString(parsed, 'sql');
    const target = await connectSelectedSource(parsed);
    try {
        if (target.database.config.type === 'mongodb') {
            throw new Error('query --sql supports PostgreSQL and MySQL sources only.');
        }
        const audit = await AuditLog.open({
            ...target.config.audit,
            secrets: credentialSecrets(target.config.sources),
        });
        const result = await executeWithAudit(audit, {
            source: target.database.config.id,
            sql,
        }, async (context) => {
            const plan = buildPlan(sql, {
                dialect: dialectFor(target.database.config.type),
            });
            context.sql = plan.sql;
            context.appliedPolicies.push(...plan.appliedPolicies);
            const rows = await target.database.execute(plan, target.config.execution);
            return {
                value: {
                    source: target.database.config.id,
                    appliedLimit: plan.appliedLimit,
                    appliedPolicies: plan.appliedPolicies,
                    rows,
                },
                rowCount: Array.isArray(rows) ? rows.length : rows == null ? 0 : 1,
            };
        });
        writeData(result, parsed);
        return 0;
    } finally {
        await closeDatabase(target.database);
    }
}

async function connectSelectedSource(
    parsed: ParsedArguments,
    selected = requiredString(parsed, 'source'),
): Promise<{ config: AppConfig; database: Database }> {
    const config = await loadConfig(optionalString(parsed, 'config'));
    const source = config.sources.find((candidate) => candidate.id === selected);
    if (!source) throw new Error(`Configured source not found: ${selected}`);
    const database = createDatabase(source);
    try {
        await database.connect();
    } catch (error) {
        await closeDatabase(database).catch(() => undefined);
        throw error;
    }
    return { config, database };
}

async function validateRuntime(config: AppConfig): Promise<void> {
    const audit = await AuditLog.open({
        ...config.audit,
        secrets: credentialSecrets(config.sources),
    });
    void audit;
    await SemanticRegistry.load(config.semanticPath);
    const memory = config.memoryPath
        ? await ExecutionMemoryIndex.open(config.memoryPath)
        : undefined;
    const databases: Database[] = [];
    try {
        for (const source of config.sources) {
            const database = createDatabase(source);
            databases.push(database);
            await database.connect();
        }
    } finally {
        memory?.close();
        await Promise.all(databases.map((database) => closeDatabase(database)));
    }
}

function createDatabase(config: ConnectionConfig): Database {
    switch (config.type) {
        case 'postgres':
            return new PostgresDatabase(config);
        case 'mysql':
            return new MysqlDatabase(config);
        case 'mongodb':
            return new MongoDatabase(config);
        case 'sqlserver':
            throw new Error('SQL Server is outside the configured source scope.');
    }
}

async function closeDatabase(database: Database): Promise<void> {
    switch (database.config.type) {
        case 'postgres':
            await (database as unknown as { pool: { end(): Promise<void> } }).pool.end();
            return;
        case 'mysql':
            await (database as unknown as {
                connection: { end(): Promise<void> } | null;
            }).connection?.end();
            return;
        case 'mongodb':
            await (database as unknown as {
                client: { close(): Promise<void> } | null;
            }).client?.close();
            return;
        case 'sqlserver':
            return;
    }
}

function parseArguments(argv: string[]): ParsedArguments {
    const options = new Map<string, OptionValue>();
    const positionals: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) {
            positionals.push(argument);
            continue;
        }
        const name = argument.slice(2);
        if (!name || options.has(name)) throw new Error(`Invalid or duplicate option: ${argument}`);
        if (BOOLEAN_OPTIONS.has(name)) {
            options.set(name, true);
            continue;
        }
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            options.set(name, next);
            index += 1;
        } else {
            options.set(name, true);
        }
    }
    return { options, positionals };
}

function requiredString(parsed: ParsedArguments, name: string): string {
    const value = parsed.options.get(name);
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Missing required option --${name} <value>.`);
    }
    return value;
}

function optionalString(parsed: ParsedArguments, name: string): string | undefined {
    const value = parsed.options.get(name);
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Option --${name} requires a value.`);
    }
    return value;
}

function hasOption(parsed: ParsedArguments, name: string): boolean {
    return parsed.options.has(name);
}

function rejectPositionals(parsed: ParsedArguments, command: string): void {
    if (parsed.positionals.length > 0) {
        throw new Error(`Unexpected argument for ${command}: ${parsed.positionals[0]}`);
    }
}

function assertKnownOptions(parsed: ParsedArguments, allowed: string[]): void {
    const allowlist = new Set(allowed);
    for (const option of parsed.options.keys()) {
        if (!allowlist.has(option)) throw new Error(`Unknown option --${option}.`);
    }
}

function isHelp(argument: string | undefined): boolean {
    return argument === '--help' || argument === '-h';
}

function writeData(value: unknown, parsed: ParsedArguments): void {
    if (hasOption(parsed, 'json')) {
        writeStdout(`${JSON.stringify(value)}\n`);
        return;
    }
    writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStderr(value: unknown, parsed: ParsedArguments): void {
    const text = hasOption(parsed, 'json')
        ? JSON.stringify(value)
        : JSON.stringify(value, null, 2);
    process.stderr.write(`${text}\n`);
}

function writeStdout(value: string): void {
    process.stdout.write(value);
}

function credentialSecrets(sources: ConnectionConfig[]): string[] {
    return sources.flatMap((source) => {
        if (source.type !== 'mongodb') return [source.options.password];
        try {
            const password = new URL(source.options.uri).password;
            return password ? [password, decodeURIComponent(password)] : [];
        } catch {
            return [];
        }
    });
}

runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
}).catch((error) => {
    const payload = toToolErrorPayload(error);
    const text = process.argv.slice(2).includes('--json')
        ? JSON.stringify(payload)
        : `Error: ${payload.error.message}`;
    process.stderr.write(`${text}\n`);
    process.exitCode = 1;
});
