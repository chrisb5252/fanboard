import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.tsx', 'src/__tests__/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    globals: false,
    clearMocks: true,
  },
});
