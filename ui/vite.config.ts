import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.TACK_API ?? 'http://127.0.0.1:4400';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
  preview: {
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false, chunkSizeWarningLimit: 700 },
});
