/** Provider-facing upload for one generated dashboard artifact. */

import {
    consumeDeploymentConfirmation,
    type DeploymentConfirmationToken,
} from './confirmation.js';

export interface DashboardDeploymentOptions {
    endpoint: string;
    providerName: string;
    bearerToken?: string;
    siteName?: string;
}

export interface DashboardDeployment {
    provider: string;
    url: string;
}

interface ProviderResponse {
    url?: unknown;
}

/**
 * Uploads one self-contained dashboard to a static-site provider API.
 *
 * The endpoint is configurable so CI can exercise the exact HTTP boundary
 * against a local stub instead of performing a real deployment.
 */
export async function deployDashboard(
    html: string,
    options: DashboardDeploymentOptions,
    confirmationToken?: DeploymentConfirmationToken,
): Promise<DashboardDeployment> {
    consumeDeploymentConfirmation(confirmationToken);
    if (!html.trim()) throw new Error('Dashboard deployment requires non-empty HTML.');
    if (!options.providerName.trim()) throw new Error('Deployment provider name is required.');
    const endpoint = deploymentEndpoint(options.endpoint);

    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(options.bearerToken
                    ? { authorization: `Bearer ${options.bearerToken}` }
                    : {}),
            },
            body: JSON.stringify({
                ...(options.siteName ? { siteName: options.siteName } : {}),
                files: [{ path: 'index.html', content: html }],
            }),
        });
    } catch (error) {
        throw new Error(
            `Dashboard deployment to ${options.providerName} failed: ${(error as Error).message}`,
            { cause: error },
        );
    }

    const body = await response.text();
    if (!response.ok) {
        const detail = body.trim() || response.statusText || 'provider returned no detail';
        throw new Error(
            `Dashboard deployment to ${options.providerName} failed ` +
            `(${response.status}): ${detail}`,
        );
    }

    let payload: ProviderResponse;
    try {
        payload = JSON.parse(body) as ProviderResponse;
    } catch (error) {
        throw new Error(
            `Dashboard deployment to ${options.providerName} returned invalid JSON.`,
            { cause: error },
        );
    }
    if (typeof payload.url !== 'string') {
        throw new Error(`Dashboard deployment to ${options.providerName} returned no URL.`);
    }
    const url = publicDeploymentUrl(payload.url, options.providerName);
    return { provider: options.providerName, url };
}

function deploymentEndpoint(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Deployment endpoint must be an absolute HTTP(S) URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Deployment endpoint must be an absolute HTTP(S) URL.');
    }
    return url.toString();
}

function publicDeploymentUrl(value: string, providerName: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Dashboard deployment to ${providerName} returned an invalid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Dashboard deployment to ${providerName} returned an invalid URL.`);
    }
    return url.toString();
}
