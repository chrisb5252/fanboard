import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = 3003;

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
    // The Fire TV stick loads this from another machine on the venue LAN.
    host: true,
  },
  preview: {
    port: PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Fire TV Silk trails desktop Chrome; keep the output conservative.
    target: 'es2019',
  },
});
