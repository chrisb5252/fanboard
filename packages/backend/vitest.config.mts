import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Explicit imports from 'vitest' instead of ambient globals, so the same
    // lint and type-check rules apply to tests as to src.
    globals: false,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      // Application code only. Without this the report is dominated by test
      // files and config, which inflates the number and hides where the gaps
      // actually are.
      //
      // .ts rather than src/**: that glob also swept in layout.tsx, page.tsx
      // and a markdown file living under src/, none of which the v8 provider
      // can parse. It logged three "Failed to parse" errors per run and
      // excluded them anyway, so the only thing the wider glob produced was
      // noise. The two .tsx files are Next's JSX shells and hold no logic.
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      // The integration blocks skip themselves without TEST_DATABASE_URL, so a
      // coverage run on a machine with no database reports a much lower number.
      // Measure with the database up.
      thresholds: {
        statements: 80,
        branches: 78,
        functions: 80,
        lines: 80,
      },
    },
  },
});
