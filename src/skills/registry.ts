/** Filesystem-backed workflow guide registry (spec R6.3). */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const DEFAULT_SKILLS_DIRECTORY = fileURLToPath(new URL('../../skills', import.meta.url));

export interface WorkflowSkill {
    name: string;
    description: string;
    content: string;
    path: string;
}

const metadataSchema = z.object({
    name: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1),
}).strict();

/** Discovers filenames rather than maintaining a second, stale name list. */
export async function listSkillNames(
    directory = DEFAULT_SKILLS_DIRECTORY,
): Promise<string[]> {
    const entries = await readdir(resolve(directory), { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
        .map((entry) => entry.name.slice(0, -extname(entry.name).length))
        .sort((left, right) => left.localeCompare(right));
}

export async function loadSkill(
    name: string,
    directory = DEFAULT_SKILLS_DIRECTORY,
): Promise<WorkflowSkill> {
    const available = await listSkillNames(directory);
    if (!available.includes(name)) {
        throw new Error(
            `Unknown skill "${name}". Available skills: ${available.join(', ') || '(none)'}.`,
        );
    }

    const path = resolve(directory, `${name}.md`);
    const content = await readFile(path, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(content);
    if (!match) throw new Error(`Invalid skill ${name}: expected YAML frontmatter.`);

    let rawMetadata: unknown;
    try {
        rawMetadata = parse(match[1]);
    } catch (error) {
        throw new Error(`Invalid skill ${name} frontmatter: ${(error as Error).message}`);
    }
    const metadata = metadataSchema.safeParse(rawMetadata);
    if (!metadata.success) {
        throw new Error(`Invalid skill ${name} frontmatter: ${metadata.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}.`);
    }
    if (metadata.data.name !== name) {
        throw new Error(
            `Invalid skill ${name}: frontmatter name "${metadata.data.name}" must match its filename.`,
        );
    }

    const body = match[2];
    const requiredHeadings: Array<{ pattern: RegExp; label: string }> = [
        { pattern: /^# .+$/m, label: '# <title>' },
        { pattern: /^## Goal$/m, label: '## Goal' },
        { pattern: /^## Workflow$/m, label: '## Workflow' },
        { pattern: /^## Guardrails$/m, label: '## Guardrails' },
    ];
    for (const heading of requiredHeadings) {
        if (!heading.pattern.test(body)) {
            throw new Error(`Invalid skill ${name}: missing required heading "${heading.label}".`);
        }
    }
    return {
        name,
        description: metadata.data.description,
        content,
        path,
    };
}
