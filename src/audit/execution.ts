/** Exactly-once audit wrapper for one query tool invocation. */

import { performance } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { isGovernanceError } from '../governance/errors.js';
import type { AuditLog, AuditOutcome } from './log.js';

export interface AuditExecutionContext {
    source: string;
    sql: string;
    appliedPolicies: string[];
}

export interface AuditExecutionResult<T> {
    value: T;
    rowCount: number;
}

/**
 * Runs one query attempt and appends exactly one record before resolving or
 * rethrowing. The operation may replace submitted SQL with compiled SQL and
 * add the policies that were actually applied.
 */
export async function executeWithAudit<T>(
    audit: AuditLog,
    initial: Pick<AuditExecutionContext, 'source' | 'sql'>,
    operation: (context: AuditExecutionContext) => Promise<AuditExecutionResult<T>>,
): Promise<T> {
    const started = performance.now();
    const context: AuditExecutionContext = {
        ...initial,
        appliedPolicies: [],
    };

    try {
        const result = await operation(context);
        await audit.append({
            ...context,
            rowCount: result.rowCount,
            durationMs: elapsedMs(started),
            outcome: 'success',
        });
        return result.value;
    } catch (error) {
        addDeniedPolicy(context, error);
        await audit.append({
            ...context,
            rowCount: 0,
            durationMs: elapsedMs(started),
            outcome: outcomeFor(error),
            errorCode: errorCodeFor(error),
        });
        throw error;
    }
}

function elapsedMs(started: number): number {
    return Math.max(0, Number((performance.now() - started).toFixed(3)));
}

function outcomeFor(error: unknown): AuditOutcome {
    if (!isGovernanceError(error)) return 'failure';

    switch (error.code) {
        case 'E_TIMEOUT':
            return 'timeout';
        case 'E_WRITE_FORBIDDEN':
        case 'E_POLICY_DENIED':
            return 'denied';
        default:
            return 'failure';
    }
}

function errorCodeFor(error: unknown): string {
    if (isGovernanceError(error)) return error.code;
    if (error instanceof ZodError) return 'INVALID_ARGUMENTS';

    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && code.length > 0 ? code : 'EXECUTION_FAILED';
}

function addDeniedPolicy(context: AuditExecutionContext, error: unknown): void {
    if (!isGovernanceError(error) || context.appliedPolicies.length > 0) return;

    if (error.detail.code === 'E_WRITE_FORBIDDEN') {
        context.appliedPolicies.push('read-only');
    } else if (error.detail.code === 'E_POLICY_DENIED') {
        context.appliedPolicies.push(error.detail.policy);
    }
}
