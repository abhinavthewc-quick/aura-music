import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000
  }
});
