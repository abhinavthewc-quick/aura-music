import { expect, test } from '@playwright/test';
import {
  AUDIO_EDGE_CACHE_TTL_SECONDS,
  edgeCacheKey,
  readEdgeCache,
  writeEdgeCache,
} from '../../functions/api/audio';

/**
 * The audio edge cache is the one change in this pass that can corrupt
 * playback rather than merely slow it down, so these tests pin the exact
 * Cloudflare constraints it depends on:
 *
 *   - cache.put throws on a 206 Partial Content response
 *     https://developers.cloudflare.com/workers/runtime-apis/cache/
 *   - cache.match slices a cached full response into a 206 when the lookup
 *     carries a Range header, which is what makes seeking work
 *   - a stale rendition must never be served, so the revision is part of the key
 *
 * A fake Cache stands in for caches.default. It records what was stored and
 * enforces the same 206 rejection the real implementation does, so a future
 * edit that starts caching partial bodies fails here instead of in production.
 */

class FakeCache {
  store = new Map<string, Response>();
  puts: { key: string; cacheControl: string }[] = [];

  async put(request: Request, response: Response): Promise<void> {
    // Mirrors the documented behaviour: 206 is rejected outright.
    if (response.status === 206) throw new Error('Cannot cache a 206 Partial Content response');
    this.puts.push({ key: request.url, cacheControl: response.headers.get('cache-control') || '' });
    this.store.set(request.url, response);
  }

  async match(request: Request): Promise<Response | undefined> {
    const stored = this.store.get(request.url);
    if (!stored) return undefined;
    const range = request.headers.get('range');
    if (!range) return stored.clone();
    // Emulate Cloudflare slicing a cached full body into a 206.
    const [, startRaw, endRaw] = /^bytes=(\d*)-(\d*)$/.exec(range) || [];
    const body = await stored.clone().arrayBuffer();
    const start = startRaw ? Number(startRaw) : 0;
    const end = endRaw ? Number(endRaw) : body.byteLength - 1;
    const slice = body.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${body.byteLength}`,
        'content-length': String(slice.byteLength),
      },
    });
  }
}

function installCache(): FakeCache {
  const cache = new FakeCache();
  (globalThis as any).caches = { default: cache };
  return cache;
}

function uninstallCache(): void {
  delete (globalThis as any).caches;
}

const ORIGIN = new URL('https://aura-music-01g.pages.dev/api/audio?path=originals%2FSong.opus');

test('the cache key changes with the revision so a new rendition cannot serve stale bytes', () => {
  const a = edgeCacheKey(ORIGIN, 'Angelrider/sonora', 'originals/Song.opus', 'rev-aaa');
  const b = edgeCacheKey(ORIGIN, 'Angelrider/sonora', 'originals/Song.opus', 'rev-bbb');
  const same = edgeCacheKey(ORIGIN, 'Angelrider/sonora', 'originals/Song.opus', 'rev-aaa');

  expect(a.url).not.toBe(b.url);
  expect(a.url).toBe(same.url);
  // The revision must be visible in the key, not carried in a header that
  // cache.match cannot be told to ignore.
  expect(a.url).toContain('rev-aaa');
  expect(a.method).toBe('GET');
});

test('the cache key is built on the real origin, not a synthetic host', () => {
  const key = edgeCacheKey(ORIGIN, 'Angelrider/sonora', 'originals/Song.opus', 'rev-aaa');
  const parsed = new URL(key.url);
  expect(parsed.origin).toBe(ORIGIN.origin);
  // Path is namespaced so it can never collide with a real app route.
  expect(parsed.pathname.startsWith('/__aura_edge_audio/')).toBe(true);
});

test('a full 200 is stored with an explicit edge TTL and without per-request markers', () => {
  const cache = installCache();
  try {
    const key = edgeCacheKey(ORIGIN, 'b', 'originals/Song.opus', 'rev-1');
    const response = new Response('audio-bytes', {
      status: 200,
      headers: { 'content-type': 'audio/ogg', 'x-aura-cache': 'MISS-HF-STREAMING' },
    });
    writeEdgeCache({ request: new Request(ORIGIN), env: {} } as any, key, response);

    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].cacheControl).toBe(`public, max-age=${AUDIO_EDGE_CACHE_TTL_SECONDS}`);

    const stored = cache.store.get(key.url)!;
    // A stale HIT marker must not be baked into the cached copy.
    expect(stored.headers.get('x-aura-cache')).toBeNull();
    expect(stored.headers.get('content-type')).toBe('audio/ogg');
  } finally {
    uninstallCache();
  }
});

test('a 206 is never written to the cache', async () => {
  const cache = installCache();
  try {
    const key = edgeCacheKey(ORIGIN, 'b', 'originals/Song.opus', 'rev-1');
    const partial = new Response('partial', { status: 206, headers: { 'content-range': 'bytes 0-6/100' } });
    writeEdgeCache({ request: new Request(ORIGIN), env: {} } as any, key, partial);
    // The write is fire-and-forget; give the rejection a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.puts).toHaveLength(0);
    expect(cache.store.size).toBe(0);
  } finally {
    uninstallCache();
  }
});

test('a range lookup is served from a cached full body as a 206', async () => {
  const cache = installCache();
  try {
    const key = edgeCacheKey(ORIGIN, 'b', 'originals/Song.opus', 'rev-1');
    const full = new Response('0123456789', { status: 200, headers: { 'content-type': 'audio/ogg' } });
    writeEdgeCache({ request: new Request(ORIGIN), env: {} } as any, key, full);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ranged = await readEdgeCache(key, 'bytes=2-5');
    expect(ranged).not.toBeNull();
    expect(ranged!.status).toBe(206);
    expect(await ranged!.text()).toBe('2345');
  } finally {
    uninstallCache();
  }
});

test('a miss returns null rather than throwing, and a missing cache is tolerated', async () => {
  const cache = installCache();
  try {
    const key = edgeCacheKey(ORIGIN, 'b', 'originals/Song.opus', 'rev-none');
    expect(await readEdgeCache(key, null)).toBeNull();
  } finally {
    uninstallCache();
  }
  // No caches.default at all (e.g. a non-Workers runtime) must not throw.
  expect(await readEdgeCache(edgeCacheKey(ORIGIN, 'b', 'p', 'r'), null)).toBeNull();
});

test('a cache write failure never propagates to the caller', async () => {
  (globalThis as any).caches = {
    default: {
      put: () => Promise.reject(new Error('quota exceeded')),
      match: () => Promise.resolve(undefined),
    },
  };
  try {
    const key = edgeCacheKey(ORIGIN, 'b', 'originals/Song.opus', 'rev-1');
    const response = new Response('audio', { status: 200 });
    // Must not throw synchronously.
    expect(() => writeEdgeCache({ request: new Request(ORIGIN), env: {} } as any, key, response)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    uninstallCache();
  }
});

test('writeEdgeCache hands the write to waitUntil when the runtime provides it', async () => {
  installCache();
  const waited: Promise<unknown>[] = [];
  try {
    const key = edgeCacheKey(ORIGIN, 'b', 'originals/Song.opus', 'rev-1');
    const response = new Response('audio', { status: 200 });
    writeEdgeCache(
      { request: new Request(ORIGIN), env: {}, waitUntil: (p: Promise<unknown>) => { waited.push(p); } } as any,
      key,
      response,
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  } finally {
    uninstallCache();
  }
});
