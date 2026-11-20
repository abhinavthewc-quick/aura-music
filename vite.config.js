import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/* The landing page paints one stylesheet. Shipping it as a separate file made
   the browser wait for a second round trip (and race the module script for
   bandwidth) before it could paint anything; inlining the built CSS lets the
   document carry its own styles. Vite has already rewritten the font URLs to
   hashed assets, so the inlined copy needs no further processing. Returns the
   HTML unchanged for the admin and rooms pages, which keep separate sheets. */
function inlineLandingCss() {
  return {
    name: 'aura-inline-landing-css',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle || !html.includes('id="auraLoader"')) return html;
        for (const [file, asset] of Object.entries(ctx.bundle)) {
          if (!file.endsWith('.css') || asset.type !== 'asset') continue;
          const link = new RegExp(`<link[^>]*rel="stylesheet"[^>]*href="/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
          if (!link.test(html)) continue;
          html = html.replace(link, `<style>${String(asset.source)}</style>`);
          delete ctx.bundle[file];
        }
        return html;
      },
    },
  };
}

export default defineConfig({
  plugins: [inlineLandingCss()],
  server: {
    proxy: {
      // Local dev: forward admin API calls to the deployed Pages function.
      '/api/admin': 'https://aura-music-01g.pages.dev',
      '/api/versions': {
        target: 'https://aura-music-01g.pages.dev',
        changeOrigin: true,
      },
      // Local dev: forward audio edge proxy to deployed Pages function
      '/api/audio': {
        target: 'https://aura-music-01g.pages.dev',
        changeOrigin: true,
      },
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
        rooms: fileURLToPath(new URL('./rooms.html', import.meta.url)),
      },
    },
  },
});
