import { compileCatalog } from '../../src/core/catalog';
import { publicVersions, type RegistryEnv } from '../lib/version-registry';

interface Context {
  request: Request;
  env: RegistryEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The compiled catalogue at the edge.
 *
 * Boot used to list the bucket straight from the browser: two paginated
 * `tree` requests (~520 KB of JSON), a manifest fetch and the versions index,
 * all parsed and merged on the main thread while the splash was fading. On a
 * phone that was seconds of blank Home plus a long task, for data that is
 * identical for every visitor.
 *
 * This Function compiles the same tracks server-side with the same
 * `compileCatalog` the client uses, returns a compact payload (URLs are
 * derived from `hfPath`, so they are not repeated), and caches it in the
 * edge cache. The browser then makes one small request that is usually a
 * cache hit, and Home fills in around the end of the logo reveal.
 */

const BUCKET = 'Angelrider/sonora';
const TREE_URL = `https://huggingface.co/api/buckets/${BUCKET}/tree?recursive=true&limit=1000`;
const MANIFEST_URL = `https://huggingface.co/buckets/${BUCKET}/resolve/manifest.json`;

/* Renditions are published minutes apart at the very fastest; five minutes of
   edge cache keeps a new upload visible quickly without re-listing the bucket
   for every visitor in between. */
const CATALOG_TTL_SECONDS = 300;
/* Let the edge cache the bucket listing itself, so a cold Function build
   does not re-download ~520 KB from Hugging Face for every isolate. */
const HF_CACHE = { cacheEverything: true, cacheTtl: 120 } as any;

/** Only the fields the player and the UI actually read. `url` and `hfUrl` are
 *  cheap to derive from `hfPath`, and repeating them per track tripled the
 *  response size. */
function compactTrack(track: any) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    year: track.year,
    duration: track.duration,
    videoId: track.videoId,
    hfPath: track.hfPath,
    img: track.img,
    size: track.size,
    audioVersions: track.audioVersions,
  };
}

async function listItems(): Promise<any[]> {
  let url: string | null = TREE_URL;
  const items: any[] = [];
  const seen = new Set<string>();
  for (let page = 0; url && page < 20; page++) {
    const response = await fetch(url, HF_CACHE);
    if (!response.ok) {
      if (!items.length) throw new Error(`bucket listing failed (HTTP ${response.status})`);
      break;
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) {
      if (!items.length) throw new Error('unexpected bucket listing format');
      break;
    }
    for (const item of batch) {
      const path = item?.path;
      if (typeof path === 'string' && !seen.has(path)) {
        seen.add(path);
        items.push(item);
      }
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') || '');
    url = next ? next[1] : null;
  }
  return items;
}

const jsonError = (message: string, status: number) => Response.json(
  { v: 1, error: message },
  { status, headers: { 'Cache-Control': 'no-store' } },
);

export const onRequestGet = async ({ request, env, waitUntil }: Context): Promise<Response> => {
  const cacheKey = new URL(request.url).origin + `/api/catalog?bucket=${encodeURIComponent(BUCKET)}`;
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  if (cache) {
    const hit = await cache.match(cacheKey);
    /* Stored responses keep the header they were built with, so relabel a hit
       instead of letting every visitor see "miss" in devtools. */
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-Catalog-Cache', 'hit');
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  try {
    const [items, manifest, versions] = await Promise.all([
      listItems(),
      fetch(MANIFEST_URL, HF_CACHE)
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => ({})),
      env.VERSION_DB ? publicVersions(env.VERSION_DB).catch(() => null) : Promise.resolve(null),
    ]);

    const tracks = compileCatalog(items, (manifest as any) || {}, versions);
    if (!tracks.length) throw new Error('catalogue compiled empty');

    const artists = (manifest as any)?.artists;
    const body = JSON.stringify({
      v: 1,
      tracks: tracks.map(compactTrack),
      artists: artists && typeof artists === 'object' ? artists : undefined,
      builtAt: Date.now(),
    });
    const response = new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${CATALOG_TTL_SECONDS}, stale-while-revalidate=600`,
        'X-Content-Type-Options': 'nosniff',
        'X-Catalog-Cache': 'miss',
        'X-Catalog-Tracks': String(tracks.length),
      },
    });

    if (cache) {
      const cached = response.clone();
      const store = () => cache.put(cacheKey, cached).catch(() => {});
      if (waitUntil) waitUntil(store()); else await store();
    }
    return response;
  } catch {
    return jsonError('catalogue unavailable', 503);
  }
};
