import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import base from '../../vite.config.js';

/* Dedicated fixture server: never inherit the development production proxies.
   Native media, beacons and unexpected API calls stay on this machine too. */
const samples = Buffer.alloc(120 * 8000, 128);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(samples.length + 36, 4);
header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28);
header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
header.write('data', 36); header.writeUInt32LE(samples.length, 40);
const audio = Buffer.concat([header, samples]);
const portrait = readFileSync(new URL('../../src/assets/radio-hero.jpg', import.meta.url));

export default defineConfig({
  ...base,
  // Tests navigate explicitly; HMR could reload a rewritten room/deep-link URL
  // outside its fixture while another scoped change is being saved.
  server: { host: '127.0.0.1', port: 5186, strictPort: true, hmr: false },
  plugins: [{
    name: 'local-artist-fixtures',
    enforce: 'pre',
    transform(source, id) {
      if (!/\/src\/(?:core\/catalog|admin\/main)\.ts(?:\?|$)/.test(id)) return;
      /* Native image/media loads do not use window.fetch. Redirect only these
         fixture-served modules; shipped HF URLs remain unchanged. */
      return source.replaceAll("'https://huggingface.co/buckets/'", "'/__fixture_hf/'");
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url || '/', 'http://localhost');
        if (url.pathname === '/api/audio' || url.pathname === '/__fixture_audio.wav' ||
          (url.pathname.startsWith('/__fixture_hf/') && /\.(opus|mp3|wav)$/i.test(url.pathname))) {
          const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
          response.statusCode = range ? 206 : 200;
          response.setHeader('Content-Type', 'audio/wav');
          response.setHeader('Accept-Ranges', 'bytes');
          if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${audio.length}`);
          response.setHeader('Content-Length', end - start + 1);
          response.end(request.method === 'HEAD' ? undefined : audio.subarray(start, end + 1));
          return;
        }
        if (url.pathname === '/api/artist-image' ||
          (url.pathname.startsWith('/__fixture_hf/') && /\.(jpg|png|webp)$/i.test(url.pathname))) {
          response.setHeader('Content-Type', 'image/jpeg');
          response.end(portrait);
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          response.statusCode = 404;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ error: 'Unmocked local fixture API' }));
          return;
        }
        next();
      });
    },
  }],
});
