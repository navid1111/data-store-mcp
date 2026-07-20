import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests hit real databases; the default 5s is too tight for
    // connection setup and the larger Pagila/Sakila aggregate queries.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each suite owns its own driver connections; run them in one process so
    // parallel workers don't contend over the fixture databases.
    pool: 'forks',
    maxWorkers: 1,
    reporters: ['verbose'],
  },
});
