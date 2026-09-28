import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The store modules touch globalThis for their caches and the Postgres
    // pool reads DATABASE_URL, so tests are isolated per file by default. Any
    // test that needs the real database has to opt out explicitly, which keeps
    // the default suite runnable in CI without a Postgres service.
    isolate: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
