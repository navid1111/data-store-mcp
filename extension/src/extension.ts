/**
 * Registers the bundled data-store-mcp server with VS Code so Copilot (and any
 * other MCP client in the editor) can use it.
 *
 * The design constraint that shapes everything here: **credentials must not be
 * stored by the extension and must not reach the language model.** So the
 * config file holds `${VAR}` references, the values come from the workspace
 * .env at spawn time, and they are handed to the child process and nowhere
 * else. Nothing is written to extension state or settings sync.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { parseEnv, referencedVariables, type EnvFile } from './env.js';
import { DEFAULT_ENV_TEMPLATE, GITIGNORE_ENTRIES, defaultConfig } from './defaults.js';

const PROVIDER_ID = 'dataStoreMcp.provider';
const SERVER_LABEL = 'Data Store MCP';

let output: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel(SERVER_LABEL, { log: true });
    context.subscriptions.push(output);

    // Fired when the config or .env changes so VS Code re-resolves the server
    // definition and restarts it with fresh values.
    const didChange = new vscode.EventEmitter<void>();
    context.subscriptions.push(didChange);

    context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
            onDidChangeMcpServerDefinitions: didChange.event,
            provideMcpServerDefinitions: () => provideDefinitions(context),
            resolveMcpServerDefinition: (server) => resolveDefinition(server),
        }),
    );

    watchWorkspace(context, didChange);
    registerCommands(context, didChange);
}

export function deactivate(): void {
    // The child process is owned by VS Code's MCP host; nothing to tear down.
}

// ---------------------------------------------------------------- definitions

async function provideDefinitions(
    context: vscode.ExtensionContext,
): Promise<vscode.McpServerDefinition[]> {
    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    if (!settings.get<boolean>('enabled', true)) {
        return [];
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return [];
    }

    const configUri = resolveInWorkspace(folder, settings.get<string>('configPath')!);
    if (!(await exists(configUri))) {
        // No config yet: stay silent rather than nagging. The walkthrough and
        // the "Check Setup" command tell the user what to do.
        output.info(`No config at ${configUri.fsPath}; server not registered.`);
        return [];
    }

    const env = await readEnvFile(folder, settings.get<string>('envFile')!);

    // Constructor is positional: (label, command, args, env, version).
    // `cwd` is a settable property rather than a constructor argument.
    const definition = new vscode.McpStdioServerDefinition(
        SERVER_LABEL,
        settings.get<string>('nodePath', 'node'),
        [context.asAbsolutePath(path.join('dist', 'server', 'server.cjs'))],
        {
            ...env.values,
            DATA_STORE_MCP_CONFIG: configUri.fsPath,
        },
        context.extension.packageJSON.version as string,
    );

    // Relative paths in the config (semantic/, audit/) resolve from here.
    definition.cwd = folder.uri;

    return [definition];
}

/**
 * Runs immediately before the server starts. Used to fail with an actionable
 * message rather than letting the child exit with a stack trace the user never
 * sees.
 */
async function resolveDefinition(
    server: vscode.McpServerDefinition,
): Promise<vscode.McpServerDefinition | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }

    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    const configUri = resolveInWorkspace(folder, settings.get<string>('configPath')!);
    const missing = await missingVariables(folder, configUri, settings.get<string>('envFile')!);

    if (missing.length > 0) {
        const envFile = settings.get<string>('envFile');
        const message =
            `Data Store MCP: ${envFile} is missing ${missing.length === 1 ? 'a value' : 'values'} ` +
            `used by your config: ${missing.join(', ')}`;

        output.error(message);
        const choice = await vscode.window.showErrorMessage(message, 'Open .env', 'Open Config');
        if (choice === 'Open .env') {
            await openOrCreateEnv(folder);
        } else if (choice === 'Open Config') {
            await vscode.window.showTextDocument(configUri);
        }

        // Returning undefined stops the server from starting. A half-configured
        // server would fail on the first query instead, inside a tool call,
        // where the error is much harder to act on.
        return undefined;
    }

    return server;
}

// ------------------------------------------------------------------- watching

function watchWorkspace(
    context: vscode.ExtensionContext,
    didChange: vscode.EventEmitter<void>,
): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return;
    }

    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    const patterns = [
        settings.get<string>('configPath', 'data-store-mcp.config.json'),
        settings.get<string>('envFile', '.env'),
    ];

    for (const pattern of patterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, pattern),
        );
        for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
            context.subscriptions.push(event(() => didChange.fire()));
        }
        context.subscriptions.push(watcher);
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('dataStoreMcp')) {
                didChange.fire();
            }
        }),
    );
}

// ------------------------------------------------------------------- commands

function registerCommands(
    context: vscode.ExtensionContext,
    didChange: vscode.EventEmitter<void>,
): void {
    const register = (id: string, handler: () => Promise<void>) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));

    register('dataStoreMcp.initConfig', () => initConfig(didChange));
    register('dataStoreMcp.openConfig', openConfig);
    register('dataStoreMcp.checkSetup', checkSetup);
    register('dataStoreMcp.restart', async () => {
        didChange.fire();
        vscode.window.showInformationMessage('Data Store MCP: server reloaded.');
    });
}

async function initConfig(didChange: vscode.EventEmitter<void>): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Data Store MCP: open a folder first.');
        return;
    }

    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    const configUri = resolveInWorkspace(folder, settings.get<string>('configPath')!);

    if (await exists(configUri)) {
        const overwrite = await vscode.window.showWarningMessage(
            `${path.basename(configUri.fsPath)} already exists. Overwrite it?`,
            { modal: true },
            'Overwrite',
        );
        if (overwrite !== 'Overwrite') {
            await vscode.window.showTextDocument(configUri);
            return;
        }
    }

    await vscode.workspace.fs.writeFile(configUri, Buffer.from(defaultConfig(), 'utf8'));
    await openOrCreateEnv(folder);
    await ensureGitignore(folder);

    didChange.fire();
    await vscode.window.showTextDocument(configUri);
    vscode.window.showInformationMessage(
        'Data Store MCP: config created. Set your connection details, then put the password in .env.',
    );
}

async function openConfig(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    const configUri = resolveInWorkspace(folder, settings.get<string>('configPath')!);

    if (!(await exists(configUri))) {
        await vscode.commands.executeCommand('dataStoreMcp.initConfig');
        return;
    }
    await vscode.window.showTextDocument(configUri);
}

/** Reports every setup problem at once rather than one per restart. */
async function checkSetup(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Data Store MCP: open a folder first.');
        return;
    }

    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    const configPath = settings.get<string>('configPath')!;
    const envPath = settings.get<string>('envFile')!;
    const configUri = resolveInWorkspace(folder, configPath);
    const problems: string[] = [];

    if (!(await exists(configUri))) {
        problems.push(`No config at ${configPath}. Run "Data Store MCP: Create Config File".`);
    } else {
        try {
            const text = await readText(configUri);
            JSON.parse(text);
        } catch (error) {
            problems.push(`Config is not valid JSON: ${(error as Error).message}`);
        }

        const missing = await missingVariables(folder, configUri, envPath);
        if (missing.length > 0) {
            problems.push(`${envPath} is missing: ${missing.join(', ')}`);
        }
    }

    const env = await readEnvFile(folder, envPath);
    if (!env.exists) {
        problems.push(`No ${envPath} file. Credentials belong there, not in the config.`);
    }

    if (problems.length === 0) {
        vscode.window.showInformationMessage(
            'Data Store MCP: setup looks good. Open Copilot Chat in Agent mode to use it.',
        );
        return;
    }

    output.show(true);
    for (const problem of problems) {
        output.warn(problem);
    }
    vscode.window.showWarningMessage(
        `Data Store MCP: ${problems.length} setup issue(s). See the output panel.`,
    );
}

// -------------------------------------------------------------------- helpers

async function readEnvFile(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
): Promise<EnvFile> {
    const uri = resolveInWorkspace(folder, relativePath);
    if (!(await exists(uri))) {
        return { values: {}, exists: false };
    }
    return { values: parseEnv(await readText(uri)), exists: true };
}

async function missingVariables(
    folder: vscode.WorkspaceFolder,
    configUri: vscode.Uri,
    envPath: string,
): Promise<string[]> {
    if (!(await exists(configUri))) {
        return [];
    }

    const referenced = referencedVariables(await readText(configUri));
    const env = await readEnvFile(folder, envPath);

    // A variable already in the real environment is fine — this supports CI and
    // shells that export credentials directly.
    return referenced.filter((name) => !env.values[name] && !process.env[name]);
}

async function openOrCreateEnv(folder: vscode.WorkspaceFolder): Promise<void> {
    const settings = vscode.workspace.getConfiguration('dataStoreMcp');
    const uri = resolveInWorkspace(folder, settings.get<string>('envFile')!);

    if (!(await exists(uri))) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(DEFAULT_ENV_TEMPLATE, 'utf8'));
    }
    await vscode.window.showTextDocument(uri);
}

/** Adds .env and the runtime directory to .gitignore, without duplicating. */
async function ensureGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
    const uri = vscode.Uri.joinPath(folder.uri, '.gitignore');
    const current = (await exists(uri)) ? await readText(uri) : '';
    const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const additions = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));

    if (additions.length === 0) {
        return;
    }

    const suffix = `${current.endsWith('\n') || current === '' ? '' : '\n'}\n# Data Store MCP\n${additions.join('\n')}\n`;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(current + suffix, 'utf8'));
    output.info(`Added ${additions.join(', ')} to .gitignore`);
}

function resolveInWorkspace(folder: vscode.WorkspaceFolder, relativePath: string): vscode.Uri {
    return path.isAbsolute(relativePath)
        ? vscode.Uri.file(relativePath)
        : vscode.Uri.joinPath(folder.uri, relativePath);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function readText(uri: vscode.Uri): Promise<string> {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}
