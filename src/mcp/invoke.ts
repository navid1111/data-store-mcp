/** Tool invocation boundary that strips model-supplied identity fields. */

import { runWithPrincipal, type Principal } from '../auth/principal.js';

export async function invokeToolHandler<T>(
    handler: (args: unknown) => Promise<T>,
    args: unknown,
    principal: Principal,
): Promise<T> {
    return runWithPrincipal(principal, () => handler(withoutModelPrincipal(args)));
}

function withoutModelPrincipal(args: unknown): unknown {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const sanitized = { ...(args as Record<string, unknown>) };
    delete sanitized.principal;
    return sanitized;
}
