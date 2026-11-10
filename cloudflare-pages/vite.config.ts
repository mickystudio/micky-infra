import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for Micky Canvas (Cloudflare Pages SPA)
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    host: true,
  },
});
