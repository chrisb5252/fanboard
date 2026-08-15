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
    // Patrons hit this from their phones over the venue LAN during dev.
    host: true,
    /**
     * Proxy /api to the backend so the browser sees one origin.
     *
     * This is not convenience. The session cookie is HttpOnly and SameSite=Lax,
     * and the backend sets no CORS headers — a cross-origin XHR would be
     * refused, and even if it were allowed the cookie would not ride along.
     * Same-origin sidesteps both. Production must serve the app and the API
     * from one origin (or a shared parent site) for the same reason.
     */
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      // The realtime listener runs on its own port in the same backend
      // process; the proxy is what makes it same-origin to the browser.
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

export default {
  server: {
    allowedHosts: [
      'fanboardmobile-web-production.up.railway.app',
      'localhost',
      '127.0.0.1'
    ]
  },
  // ... rest of config
}
