import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Explicit imports from 'vitest' instead of ambient globals, so the same
    // lint and type-check rules apply to tests as to src.
    globals: false,
    clearMocks: true,
  },
});
