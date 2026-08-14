import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
  },
  preview: {
    port: PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
