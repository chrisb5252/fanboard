import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = 3003;
const API_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';
const WS_TARGET = process.env['VITE_WS_PROXY_TARGET'] ?? 'ws://localhost:3100';

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
    // The Fire TV stick loads this from another machine on the venue LAN.
    host: true,
    // Same-origin /api, so the display key header is not a cross-origin
    // preflight on every poll.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // The realtime listener runs on its own port in the same backend
      // process; the proxy is what makes it same-origin to the display.
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // The realtime listener runs on its own port in the same backend
      // process; the proxy is what makes it same-origin to the display.
      '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Fire TV Silk trails desktop Chrome; keep the output conservative.
    target: 'es2019',
  },
});
