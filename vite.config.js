import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  server: {
    proxy: {
      // Local dev: forward admin API calls to the deployed Pages function.
      '/api/admin': 'https://aura-music-01g.pages.dev',
      // Local dev: rooms run against a local Durable Object
      // (`cd rooms-worker && npm run dev`). Set ROOMS_DEV_URL to change the
      // port. In production this path is served by functions/api/rooms.ts.
      '/api/rooms': {
        target: process.env.ROOMS_DEV_URL || 'http://localhost:8799',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
});
