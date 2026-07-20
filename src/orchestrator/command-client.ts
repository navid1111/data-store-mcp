/** Provider-neutral LLM bridge: prompt on stdin, completion on stdout. */

import { spawn } from 'node:child_process';
import type { AskPromptClient } from './ask.js';

export const LLM_COMMAND_ENV = 'DSM_LLM_COMMAND';

export class CommandPromptClient implements AskPromptClient {
    constructor(private readonly command = process.env[LLM_COMMAND_ENV]) {}

    complete(prompt: string): Promise<string> {
        if (!this.command?.trim()) {
            throw new Error(
                `No LLM command configured. Set ${LLM_COMMAND_ENV} or pass --llm-command <path>.`,
            );
        }

        return new Promise((resolve, reject) => {
            const child = spawn(this.command!, [], {
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => { stdout += chunk; });
            child.stderr.on('data', (chunk: string) => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', (code, signal) => {
                if (code === 0) {
                    resolve(stdout);
                    return;
                }
                const status = signal ? `signal ${signal}` : `exit code ${String(code)}`;
                reject(new Error(
                    `LLM command failed with ${status}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`,
                ));
            });
            child.stdin.on('error', reject);
            child.stdin.end(prompt);
        });
    }
}
