/** Human confirmation authority for public dashboard deployment. */

import { createInterface } from 'node:readline/promises';

declare const deploymentConfirmationBrand: unique symbol;

export interface DeploymentConfirmationToken {
    readonly [deploymentConfirmationBrand]: true;
}

export const DEPLOYMENT_CONFIRMATION_PHRASE = 'publish publicly';
export const DEPLOYMENT_CONFIRMATION_PROMPT =
    'This deployment will publish dashboard data publicly on the internet. ' +
    `Type "${DEPLOYMENT_CONFIRMATION_PHRASE}" to continue: `;

const issuedTokens = new WeakSet<object>();

/** Host-facing authority: call only after displaying the public-data warning. */
export function confirmPublicDeployment(answer: string): DeploymentConfirmationToken {
    if (answer.trim() !== DEPLOYMENT_CONFIRMATION_PHRASE) {
        throw new Error('Dashboard deployment cancelled: explicit public deployment confirmation was not given.');
    }
    const token = Object.freeze({}) as DeploymentConfirmationToken;
    issuedTokens.add(token);
    return token;
}

/** The CLI authority is deliberately interactive and cannot be satisfied by a flag. */
export async function requestPublicDeploymentConfirmation(): Promise<DeploymentConfirmationToken> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error(
            'Dashboard deployment publishes data publicly on the internet and requires ' +
            'confirmation from an interactive human terminal.',
        );
    }
    // Prompts go to stderr so --json keeps stdout machine-readable.
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return confirmPublicDeployment(await prompt.question(DEPLOYMENT_CONFIRMATION_PROMPT));
    } finally {
        prompt.close();
    }
}

/** Consumes a token exactly once so every retry requires a fresh confirmation. */
export function consumeDeploymentConfirmation(
    token: DeploymentConfirmationToken | undefined,
): void {
    if (!token || typeof token !== 'object' || !issuedTokens.delete(token)) {
        throw new Error(
            'Dashboard deployment denied: a fresh human confirmation token is required.',
        );
    }
}
