import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = 3001;
const API_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
    // Same-origin /api: the backend sets no CORS headers, so a cross-origin
    // call from this console would be refused before it reached a route.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    port: PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
