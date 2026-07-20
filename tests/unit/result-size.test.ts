import { describe, expect, it } from 'vitest';
import {
  enforceValueByteLimit,
  ResultByteAccumulator,
  resolveMaxBytes,
} from '../../src/execution/result-size.js';

describe('ResultByteAccumulator', () => {
  it('tracks the exact UTF-8 size of the JSON array', () => {
    const rows = [{ value: 'plain' }, { value: 'বাংলা' }];
    const accumulator = new ResultByteAccumulator<(typeof rows)[number]>(10_000);

    for (const row of rows) accumulator.add(row);

    expect(accumulator.result()).toEqual(rows);
    expect(accumulator.serializedBytes()).toBe(
      Buffer.byteLength(JSON.stringify(rows), 'utf8'),
    );
  });

  it('throws at the first row that crosses the cap and reports actual bytes', () => {
    const accumulator = new ResultByteAccumulator<{ value: string }>(30);
    accumulator.add({ value: 'small' });

    expect(() => accumulator.add({ value: 'this row crosses the cap' })).toThrowError(
      expect.objectContaining({
        code: 'E_RESULT_TOO_LARGE',
        detail: expect.objectContaining({ limit: 30, actual: expect.any(Number) }),
      }),
    );
    expect(accumulator.result()).toEqual([{ value: 'small' }]);
  });
});

describe('byte-limit options', () => {
  it('accepts a positive configured cap', () => {
    expect(resolveMaxBytes({ maxBytes: 1234 })).toBe(1234);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid cap %s',
    (maxBytes) => {
      expect(() => resolveMaxBytes({ maxBytes })).toThrow(/positive integer/);
    },
  );

  it('caps scalar results using their UTF-8 serialization', () => {
    expect(() => enforceValueByteLimit('বাংলা', 5)).toThrowError(
      expect.objectContaining({ code: 'E_RESULT_TOO_LARGE' }),
    );
  });
});
