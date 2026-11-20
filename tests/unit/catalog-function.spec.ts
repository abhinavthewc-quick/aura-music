import { expect, test } from '@playwright/test';
import { onRequestGet } from '../../functions/api/catalog';

/* /api/catalog is the one request that stands in for listing the bucket: if it
   regresses, Home is empty on every cold visit. These tests pin the contract
   the client depends on — compact tracks with no redundant URLs, edge caching
   keyed by origin, and a non-200 body whenever the catalogue cannot be built,
   so `fetchCatalog()` falls back to the bucket listing instead of trusting it. */

class FakeCache {
  store = new Map<string, Response>();
  fetchCount = 0;
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
  async match(request: Request): Promise<Response | undefined> {
    const hit = this.store.get(request.url);
    this.fetchCount += hit ? 0 : 1;
    return hit ? hit.clone() : undefined;
  }
}

const AUDIO = 'Artist - Song [prXvpLr8WIs].opus';
const BASS = 'versions/prXvpLr8WIs/bass.mp3';

const page1 = [
  { type: 'file', path: AUDIO, size: 4200000, contentType: 'audio/ogg' },
  { type: 'file', path: BASS, size: 4300000, contentType: 'audio/ogg' },
  { type: 'file', path: 'covers/Artist - Song [prXvpLr8WIs].webp', size: 43394, contentType: 'image/webp' },
];
const page2 = [{ type: 'file', path: 'Other - Track [abcdefghijk].opus', size: 1000, contentType: 'audio/ogg' }];

function stubFetch(calls: string[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url || input);
    calls.push(url);
    if (url.includes('/tree?')) {
      const second = url.includes('cursor=page2');
      const body = second ? page2 : page1;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (!second) headers.link = '<https://huggingface.co/api/buckets/Angelrider/sonora/tree?recursive=true&limit=1000&cursor=page2>; rel="next"';
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    if (url.includes('manifest.json')) {
      return new Response(JSON.stringify({ tracks: { prXvpLr8WIs: { t: 'Song Title', a: 'Artist' } } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const db = {
  prepare: () => ({
    all: async () => ({ results: [{ track_ref: 'video:prXvpLr8WIs', mode: 'bass', path: BASS, duration: 214, revision: 'r1' }] }),
  }),
};

function context(url = 'https://aura-music-01g.pages.dev/api/catalog') {
  return { request: new Request(url), env: { VERSION_DB: db } as any } as any;
}

test('compiles the bucket listing into a compact, cacheable payload', async () => {
  const calls: string[] = [];
  const restore = stubFetch(calls);
  (globalThis as any).caches = { default: new FakeCache() };
  try {
    const response = await onRequestGet(context());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=300');
    const body = await response.json();
    expect(body.v).toBe(1);
    expect(body.tracks).toHaveLength(2);
    for (const track of body.tracks) {
      expect(track.url).toBeUndefined();
      expect(track.hfUrl).toBeUndefined();
      expect(track.hfPath).toBeTruthy();
    }
    const first = body.tracks.find((t: any) => t.videoId === 'prXvpLr8WIs');
    expect(first.title).toBe('Song Title');
    expect(Object.keys(first.audioVersions)).toEqual(['bass']);
  } finally {
    restore();
  }
});

test('follows the Link: rel="next" pagination and stores the result in the edge cache', async () => {
  const calls: string[] = [];
  const restore = stubFetch(calls);
  const cache = new FakeCache();
  (globalThis as any).caches = { default: cache };
  try {
    const first = await onRequestGet(context());
    expect(calls.some((url) => url.includes('cursor=page2'))).toBe(true);
    await first.text();
    expect(cache.store.size).toBe(1);

    const before = calls.length;
    const second = await onRequestGet(context());
    expect(second.status).toBe(200);
    expect(calls.length).toBe(before); // served from cache, no bucket listing
    expect(second.headers.get('x-catalog-tracks')).toBe('2');
    await second.text();
  } finally {
    restore();
  }
});

test('a broken bucket listing answers 503 so the client falls back', async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  (globalThis as any).caches = { default: new FakeCache() };
  try {
    const response = await onRequestGet(context());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((globalThis as any).caches.default.store.size).toBe(0);
  } finally {
    globalThis.fetch = restore;
  }
});