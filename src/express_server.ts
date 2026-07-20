/** Express transport for host-authenticated, request-scoped principals. */

import express, { type Request, type Response } from 'express';
import { tools } from './mcp/tools/index.js';
import { toToolErrorPayload } from './mcp/errors.js';
import {
    parsePrincipal,
    PrincipalRequiredError,
    type Principal,
} from './auth/principal.js';
import { invokeToolHandler } from './mcp/invoke.js';

export interface HttpAppOptions {
    /** Host authentication callback. Request body values must never be trusted here. */
    resolvePrincipal(request: Request): unknown | Promise<unknown>;
}

export function createHttpApp(options: HttpAppOptions): express.Express {
    if (typeof options?.resolvePrincipal !== 'function') {
        throw new PrincipalRequiredError('HTTP transport requires a host principal resolver.');
    }

    const app = express();
    app.use(express.json());
    app.get('/health', (_request, response) => response.json({ status: 'ok' }));

    app.post('/query', async (request, response) =>
        invokeHttpTool('query', request.body, request, response, options));
    app.post('/tools/:name', async (request, response) => {
        const body = isObject(request.body) && Object.hasOwn(request.body, 'arguments')
            ? request.body.arguments
            : request.body;
        return invokeHttpTool(request.params.name, body, request, response, options);
    });

    return app;
}

async function invokeHttpTool(
    name: string,
    args: unknown,
    request: Request,
    response: Response,
    options: HttpAppOptions,
): Promise<void> {
    try {
        const principal = parsePrincipal(
            await options.resolvePrincipal(request),
            'HTTP host application',
        );
        const tool = tools[name];
        if (!tool) {
            response.status(404).json({
                error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` },
            });
            return;
        }
        const result = await invokeWithPrincipal(tool.handler, args, principal);
        response.json(result);
    } catch (error) {
        const principalFailure = error instanceof PrincipalRequiredError;
        response.status(principalFailure ? 401 : 400).json(
            principalFailure
                ? { error: { code: error.code, message: error.message } }
                : toToolErrorPayload(error),
        );
    }
}

function invokeWithPrincipal<T>(
    handler: (args: unknown) => Promise<T>,
    args: unknown,
    principal: Principal,
): Promise<T> {
    return invokeToolHandler(handler, args ?? {}, principal);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
