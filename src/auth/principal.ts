/** Out-of-band request identity boundary (spec D3). */

import { AsyncLocalStorage } from 'node:async_hooks';

declare const PRINCIPAL_BRAND: unique symbol;
export type Principal = string & { readonly [PRINCIPAL_BRAND]: true };

export class PrincipalRequiredError extends Error {
    readonly code = 'E_PRINCIPAL_REQUIRED';

    constructor(message = 'An authenticated principal is required.') {
        super(message);
        this.name = 'PrincipalRequiredError';
    }
}

const principalContext = new AsyncLocalStorage<Principal>();

export function parsePrincipal(value: unknown, source: string): Principal {
    if (typeof value !== 'string') {
        throw new PrincipalRequiredError(`${source} did not supply an authenticated principal.`);
    }
    const principal = value.trim();
    if (!principal || principal.length > 256 || /[\u0000-\u001f\u007f]/.test(principal)) {
        throw new PrincipalRequiredError(`${source} supplied an invalid authenticated principal.`);
    }
    return principal as Principal;
}

export function runWithPrincipal<T>(
    principal: Principal,
    operation: () => T,
): T {
    return principalContext.run(principal, operation);
}

/** Fails closed when code requiring identity runs outside a transport boundary. */
export function currentPrincipal(): Principal {
    const principal = principalContext.getStore();
    if (!principal) throw new PrincipalRequiredError();
    return principal;
}
