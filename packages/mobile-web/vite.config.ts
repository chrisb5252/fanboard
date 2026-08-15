import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = 3002;
const API_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';
const WS_TARGET = process.env['VITE_WS_PROXY_TARGET'] ?? 'ws://localhost:3100';

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
    host: true,
    allowedHosts: [
      'fanboardmobile-web-production.up.railway.app',
      'localhost',
      '127.0.0.1'
    ],
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});