/**
 * SQL identifier validation and quoting.
 *
 * Table and column names cannot be passed as bound parameters — `DESCRIBE ?`
 * is not valid SQL — so identifiers that reach a query string must be
 * validated first. Escaping quotes is not sufficient and is not used here:
 * the identifier is checked against an allowlist pattern, then quoted.
 *
 * The pattern is deliberately conservative. It rejects identifiers that are
 * legal in the engine but unusual (leading digits, spaces, unicode), because
 * these names arrive from an LLM and failing closed is the safer default.
 * Task 0.5 introduces `listTables()`, after which validation can additionally
 * check membership in the live schema and this pattern can be relaxed.
 */

/** Thrown when an identifier fails validation. Distinguishable from driver errors. */
export class InvalidIdentifierError extends Error {
  constructor(value: string, kind: string) {
    super(
      `Invalid ${kind}: ${JSON.stringify(value)}. ` +
        `Expected a name matching /^[A-Za-z_][A-Za-z0-9_]*$/.`
    );
    this.name = 'InvalidIdentifierError';
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Maximum identifier length accepted by Postgres (63) and MySQL (64). */
const MAX_LENGTH = 63;

/**
 * Validates an identifier, returning it unchanged.
 * @throws InvalidIdentifierError if it is not a plain identifier.
 */
export function assertValidIdentifier(value: unknown, kind = 'identifier'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) {
    return fail(value, kind);
  }
  if (!IDENTIFIER.test(value)) {
    return fail(value, kind);
  }
  return value;
}

function fail(value: unknown, kind: string): never {
  throw new InvalidIdentifierError(typeof value === 'string' ? value : String(value), kind);
}

/**
 * Validates and backtick-quotes an identifier for MySQL.
 *
 * Quoting is applied in addition to validation rather than instead of it, so
 * the query stays safe if the pattern is later relaxed.
 */
export function quoteMysqlIdentifier(value: unknown, kind = 'identifier'): string {
  return `\`${assertValidIdentifier(value, kind)}\``;
}

/** Validates and double-quotes an identifier for Postgres. */
export function quotePostgresIdentifier(value: unknown, kind = 'identifier'): string {
  return `"${assertValidIdentifier(value, kind)}"`;
}
