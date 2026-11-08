import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

function searchDevPlugin() {
  return {
    name: 'search-dev-plugin',
    configureServer(server) {
      server.middlewares.use('/api/search', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ results: [] }));
          return;
        }
        try {
          const ytRes = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              Origin: 'https://music.youtube.com',
              Cookie: 'SOCS=CAI',
            },
            body: JSON.stringify({
              context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250915.01.00', hl: 'en', gl: 'US' } },
              query: q,
              params: 'EgWKAQIIAWoKEAoQAxAEEAkQBQ==',
            }),
          });
          const data = await ytRes.json();
          const sections = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
          const out = [];
          for (const sec of sections) {
            for (const item of sec?.musicShelfRenderer?.contents || []) {
              const r = item?.musicResponsiveListItemRenderer;
              const videoId = r?.playlistItemData?.videoId;
              if (!videoId) continue;
              const cols = (r?.flexColumns || []).map((f) =>
                Array.isArray(f?.musicResponsiveListItemFlexColumnRenderer?.text?.runs)
                  ? f.musicResponsiveListItemFlexColumnRenderer.text.runs.map((x) => x.text).join('')
                  : f?.musicResponsiveListItemFlexColumnRenderer?.text?.simpleText || ''
              );
              const title = cols[0] || 'Unknown Title';
              const sub = cols[1] || '';
              const artist = sub ? sub.split('•')[0].trim() : 'YouTube Music';
              const thumb = r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
              out.push({ source: 'youtube', id: videoId, videoId, title, artist, img: thumb, full: true, sub });
              if (out.length >= 20) break;
            }
            if (out.length >= 20) break;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, results: out }));
        } catch (err) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: err.message, results: [] }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [searchDevPlugin()],
  server: {
    proxy: {
      // Local dev: forward admin API calls to the deployed Pages function.
      '/api/admin': 'https://aura-music-01g.pages.dev',
      // Local dev: forward audio edge proxy to deployed Pages function
      '/api/audio': {
        target: 'https://aura-music-01g.pages.dev',
        changeOrigin: true,
      },
      // Local dev: forward telepathy / telemetry API
      '/api/v1': {
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
