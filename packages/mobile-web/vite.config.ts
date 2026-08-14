import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = 3002;

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
    // Patrons hit this from their phones over the venue LAN during dev.
    host: true,
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
