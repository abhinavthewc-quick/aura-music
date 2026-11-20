/* GET/HEAD /api/audio?path=<relative audio key>
 *
 * Public archive streaming, with an optional server-configured OCI hot cache.
 * Missing or invalid OCI configuration disables every OCI call and cache write.
 * Status is admin-only, never cached, and returns aggregates rather than keys.
 * Resource guards are per Cloudflare isolate, not a distributed cache quota.
 */
import {
  encodeS3ObjectKey,
  isValidOciS3Config,
  listOciObjects,
  pruneOciBucketToLimit,
  signOciS3Request,
  type OciS3Config,
} from '../lib/ociS3';
import { archiveAudioIdentity, audioCachePath, audioCachePrefix, registryAudioIdentity,
  type AudioCacheIdentity } from '../lib/audio-cache';
import type { VersionDatabase } from '../lib/version-registry';

export interface AudioEnv {
  OCI_NAMESPACE?: string;
  OCI_BUCKET_NAME?: string;
  OCI_REGION?: string;
  OCI_ACCESS_KEY?: string;
  OCI_SECRET_KEY?: string;
  AUDIO_ADMIN_TOKEN?: string;
  HF_BUCKET_ID?: string;
  VERSION_DB?: VersionDatabase;
}

interface AudioContext {
  request: Request;
  env: AudioEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const HF_BUCKET_DEFAULT = 'Angelrider/sonora';
const MAX_HOT_CACHE_TRACKS = 30;
const MAX_AUDIO_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_EXISTENCE_ENTRIES = 256;
const MAX_PENDING_CACHE_UPLOADS = 4;
const AUDIO_EXTENSION = /\.(mp3|opus|webm|m4a|aac|ogg|flac|wav)$/i;
const inFlightUploads = new Set<string>();
const existenceCache = new Map<string, { exists: boolean; expiresAt: number }>();
// Serialize eviction + write within this isolate. Different isolates still need
// infrastructure quotas if the owner needs a hard global capacity guarantee.
let uploadTail: Promise<void> = Promise.resolve();

function getOciConfig(env: AudioEnv): OciS3Config | null {
  const config: OciS3Config = {
    namespace: env.OCI_NAMESPACE?.trim() || '',
    bucket: env.OCI_BUCKET_NAME?.trim() || '',
    region: env.OCI_REGION?.trim() || '',
    accessKey: env.OCI_ACCESS_KEY?.trim() || '',
    secretKey: env.OCI_SECRET_KEY?.trim() || '',
  };
  return isValidOciS3Config(config) ? config : null;
}

async function timingSafeTokenMatch(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < av.length; i++) difference |= av[i] ^ bv[i];
  return difference === 0;
}

function mimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    mp3: 'audio/mpeg', opus: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
  };
  return types[extension || ''] || 'application/octet-stream';
}

function corsHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Authorization',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, x-aura-cache, x-aura-revision',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const [key, value] of Object.entries(extra)) if (value) headers.set(key, value);
  return headers;
}

function errorResponse(message: string, status: number, head = false, extra: Record<string, string> = {}): Response {
  return new Response(head ? null : message, {
    status,
    headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra }),
  });
}

/** Edge-cache a track for a day. The key carries the revision, so a re-published
 * rendition is a different entry and can never serve stale bytes. */
export const AUDIO_EDGE_CACHE_TTL_SECONDS = 86_400;

/**
 * Cache key for a track revision.
 *
 * Built from the REAL request origin, not a synthetic hostname: the Cache API
 * keys on the URL, and nothing in the docs promises a made-up host resolves to
 * a usable entry. The revision goes in the query string rather than a header
 * because `cache.match` cannot be told to ignore headers, and a stale entry is
 * the one failure mode that would actually be audible — a new rendition must
 * land on a different key.
 */
export function edgeCacheKey(requestUrl: URL, bucket: string, path: string, revision: string): Request {
  const key = new URL(requestUrl.origin);
  key.pathname = `/__aura_edge_audio/${encodeURIComponent(bucket)}/${encodeURIComponent(path)}`;
  key.search = `?rev=${encodeURIComponent(revision)}`;
  return new Request(key.toString(), { method: 'GET' });
}

/**
 * Read a track from Cloudflare's per-datacenter edge cache.
 *
 * A Range header on the lookup is deliberate: Cloudflare's cache slices a
 * cached full response into a 206 itself, which is what makes seeking work
 * without us storing partial content (cache.put rejects 206 outright).
 */
export async function readEdgeCache(key: Request, range: string | null): Promise<Response | null> {
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return null;
    const lookup = new Request(key.url, { method: 'GET', headers: range ? { Range: range } : {} });
    return (await cache.match(lookup)) || null;
  } catch {
    return null;
  }
}

/**
 * Store a full track response in the edge cache.
 *
 * Only ever called with a complete 200. A 206 would throw inside cache.put, so
 * a range request that misses simply streams from origin and does not populate
 * the cache — the next full request will.
 */
export function writeEdgeCache(context: AudioContext, key: Request, response: Response): void {
  try {
    // Defence in depth. Call sites already gate on status 200, but rebuilding
    // the response below forces status 200, so a partial body passed in here
    // would be silently stored as if it were the whole file — the exact
    // corruption the revision key exists to prevent. Refuse anything else.
    if (response.status !== 200) return;
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return;
    // Rebuild the response so the stored copy carries an explicit edge TTL and
    // no per-request markers (x-aura-cache would otherwise be served stale).
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${AUDIO_EDGE_CACHE_TTL_SECONDS}`);
    headers.delete('x-aura-cache');
    const cacheable = new Response(response.clone().body, { status: 200, headers });
    const task = cache.put(key, cacheable).catch(() => { /* cache is best-effort */ });
    if (typeof context.waitUntil === 'function') context.waitUntil(task);
  } catch {
    // Never let a cache write break playback.
  }
}

function updateExistence(key: string, exists: boolean): void {
  existenceCache.delete(key);
  if (existenceCache.size >= MAX_EXISTENCE_ENTRIES) {
    const oldest = existenceCache.keys().next().value;
    if (oldest !== undefined) existenceCache.delete(oldest);
  }
  existenceCache.set(key, { exists, expiresAt: Date.now() + (exists ? 3_600_000 : 300_000) });
}

function validateTrackPath(url: URL): string | null {
  let path = url.searchParams.get('path') || '';
  if (!path && url.pathname.startsWith('/api/audio/')) {
    try { path = decodeURIComponent(url.pathname.slice('/api/audio/'.length)); } catch { return null; }
  }
  path = path.replace(/^\/+/, '').trim();
  if (!path || path.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(path) || path.includes('://')) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  try { encodeS3ObjectKey(path); } catch { return null; }
  return path;
}

function validateRange(raw: string | null): string | null | false {
  if (raw === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw.trim());
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))
    || (start !== null && end !== null && end < start) || (start === null && end === 0)) return false;
  return `bytes=${match[1]}-${match[2]}`;
}

function streamResponse(response: Response, type: string, cache: string, head: boolean, revision = '', requestedRevision = ''): Response {
  const compressed = response.headers.get('content-encoding');
  const length = compressed && compressed !== 'identity' ? '' : response.headers.get('content-length') || '';
  return new Response(head ? null : response.body, {
    status: response.status,
    headers: corsHeaders({
      // An archive can contain mislabelled data. Never reflect text/html or SVG
      // as executable same-origin content just because an upstream says so.
      'Content-Type': type,
      'Content-Length': length,
      'Content-Range': response.headers.get('content-range') || '',
      'Accept-Ranges': 'bytes',
      // Catalogue metadata can replace a file at its path. Do not mark it immutable.
      'Cache-Control': revision && requestedRevision === revision ? 'public, max-age=3600' : 'public, max-age=0, must-revalidate',
      'x-aura-cache': cache,
      'x-aura-revision': revision,
    }),
  });
}

/** Do not buffer an unknown-length response with arrayBuffer(): stop reading at
 * the cap before it can exhaust Worker memory. Exported for deterministic tests.
 */
export async function readBoundedAudio(response: Response): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  const length = declared === null ? null : Number(declared);
  if (!response.body || (length !== null && (!Number.isSafeInteger(length) || length < 0 || length > MAX_AUDIO_FILE_SIZE_BYTES))) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_AUDIO_FILE_SIZE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes || (length !== null && length !== bytes)) return null;
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function scheduleCacheUpload(context: AudioContext, config: OciS3Config, key: string, objectPath: string,
  archiveUrl: string, identity: AudioCacheIdentity, bucket: string): void {
  if (typeof context.waitUntil !== 'function' || inFlightUploads.has(key) || inFlightUploads.size >= MAX_PENDING_CACHE_UPLOADS) return;
  inFlightUploads.add(key);
  const task = uploadTail.then(async () => {
    try {
      const response = await fetch(archiveUrl, {
        headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200 || response.headers.has('content-range')) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const bytes = await readBoundedAudio(response);
      if (!bytes) return;
      // A render may finish while the archive download is in flight. Never
      // publish downloaded bytes under a superseded source identity.
      const current = await resolveAudioIdentity(context,bucket,identity.path);
      if (!current || current.path !== identity.path || current.revision !== identity.revision) return;
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      const payloadHash = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (identity.sha256 && identity.sha256 !== payloadHash) return;
      const capacity = await pruneOciBucketToLimit(config, MAX_HOT_CACHE_TRACKS,await audioCachePrefix(bucket));
      if (!capacity.hasCapacity) return;
      const signed = await signOciS3Request('PUT', objectPath, config, {
        'content-type': mimeType(identity.path), 'content-length': String(bytes.byteLength),
      }, payloadHash);
      const written = await fetch(signed.url, {
        method: 'PUT', headers: signed.headers, body: bytes as BodyInit, signal: AbortSignal.timeout(10_000),
      });
      if (written.ok) updateExistence(key, true);
      else console.warn('[audio] Hot-cache write failed.');
      await written.body?.cancel().catch(() => {});
    } catch {
      // Never log upstream exception objects, signed URLs, headers, or keys.
      console.warn('[audio] Hot-cache maintenance unavailable. Archive streaming is unaffected.');
    } finally {
      inFlightUploads.delete(key);
    }
  });
  uploadTail = task.catch(() => {});
  context.waitUntil(task);
}

async function resolveAudioIdentity(context: AudioContext, bucket: string, path: string): Promise<AudioCacheIdentity | null> {
  try {
    if (context.env.VERSION_DB) {
      const identity = await registryAudioIdentity(context.env.VERSION_DB,path);
      if (identity) return identity;
    }
    return await archiveAudioIdentity(`https://huggingface.co/buckets/${bucket}/resolve/${encodeS3ObjectKey(path)}`,path);
  } catch {
    // A cache identity outage cannot break the source stream.
    console.warn('[audio] Cache identity unavailable; using archive.');
    return null;
  }
}

async function statusResponse(context: AudioContext, config: OciS3Config | null, head: boolean): Promise<Response> {
  const expected = context.env.AUDIO_ADMIN_TOKEN?.trim() || '';
  const given = /^Bearer\s+(.+)$/i.exec(context.request.headers.get('authorization') || '')?.[1]?.trim() || '';
  if (!expected || !given || given.length > 4096 || !(await timingSafeTokenMatch(given, expected))) {
    return errorResponse('Not found', 404, head, { Vary: 'Authorization' });
  }
  if (!config) return errorResponse('Hot cache is not configured', 503, head, { Vary: 'Authorization' });
  try {
    const prefix = await audioCachePrefix(context.env.HF_BUCKET_ID?.trim() || HF_BUCKET_DEFAULT);
    const objects = (await listOciObjects(config)).filter(object => object.key.startsWith(prefix));
    const body = JSON.stringify({
      status: 'healthy',
      cachedTracksCount: objects.filter((object) => AUDIO_EXTENSION.test(object.key)).length,
      maxCapTracks: MAX_HOT_CACHE_TRACKS,
      totalUsedBytes: objects.reduce((sum, object) => sum + object.size, 0),
    });
    return new Response(head ? null : body, {
      headers: corsHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', Vary: 'Authorization' }),
    });
  } catch {
    return errorResponse('Hot-cache status unavailable', 502, head, { Vary: 'Authorization' });
  }
}

async function handleAudio(context: AudioContext, head: boolean): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const config = getOciConfig(env);
  if (url.searchParams.get('action') === 'status') return statusResponse(context, config, head);
  let path = validateTrackPath(url);
  if (!path) return errorResponse('A valid relative track path is required', 400, head);
  if (!AUDIO_EXTENSION.test(path)) return errorResponse('Unsupported audio format', 400, head);
  const range = validateRange(request.headers.get('range'));
  if (range === false) return errorResponse('Only one valid byte range is supported', 400, head);
  const bucket = env.HF_BUCKET_ID?.trim() || HF_BUCKET_DEFAULT;
  if (!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(bucket)) {
    return errorResponse('Archive storage is not configured correctly', 503, head);
  }
  let archiveUrl = `https://huggingface.co/buckets/${bucket}/resolve/${encodeS3ObjectKey(path)}`;
  const type = mimeType(path);
  const identity = config ? await resolveAudioIdentity(context,bucket,path) : null;
  if (identity) {
    path = identity.path;
    archiveUrl = `https://huggingface.co/buckets/${bucket}/resolve/${encodeS3ObjectKey(path)}`;
  }
  const objectPath = identity ? await audioCachePath(bucket,identity) : '';
  const key = identity ? `${config.namespace}/${config.region}/${config.bucket}/${objectPath}` : '';
  const revision = identity?.revision || '';
  const requestedRevision = url.searchParams.get('v') || '';

  // Edge cache: only for GETs whose bytes are pinned to a known revision.
  // Without a revision the file at a path can be replaced, so caching it would
  // risk serving a stale rendition — exactly the bug the revision exists to
  // prevent. HEAD is skipped too: it would populate the cache with an empty body.
  const edgeKey = identity && revision && !head ? edgeCacheKey(url, bucket, path, revision) : null;
  if (edgeKey) {
    const hit = await readEdgeCache(edgeKey, range);
    if (hit) {
      // The cached entry is a full 200; Cloudflare already sliced it if the
      // request carried a Range. Re-stamp the per-request markers.
      const headers = new Headers(hit.headers);
      headers.set('x-aura-cache', 'HIT-EDGE');
      headers.set('x-aura-revision', revision);
      headers.set('Cache-Control', revision && requestedRevision === revision
        ? `public, max-age=${AUDIO_EDGE_CACHE_TTL_SECONDS}`
        : 'public, max-age=0, must-revalidate');
      return new Response(hit.body, { status: hit.status, headers: corsHeaders(Object.fromEntries(headers)) });
    }
  }

  if (config && identity) {
    let exists = existenceCache.get(key)?.exists || false;
    const cached = existenceCache.get(key);
    if (head || !cached || cached.expiresAt <= Date.now()) {
      try {
        const signed = await signOciS3Request('HEAD', objectPath, config);
        const response = await fetch(signed.url, { method: 'HEAD', headers: signed.headers, signal: AbortSignal.timeout(2500) });
        exists = response.ok;
        // An outage is not proof of a missing object; cache only confirmed states.
        if (response.ok || response.status === 404) updateExistence(key, exists);
      } catch {
        exists = false;
        console.warn('[audio] Hot-cache lookup unavailable; using archive.');
      }
    }
    if (exists) {
      try {
        const signed = await signOciS3Request(head ? 'HEAD' : 'GET', objectPath, config, range ? { range } : {});
        const response = await fetch(signed.url, { method: head ? 'HEAD' : 'GET', headers: signed.headers, signal: AbortSignal.timeout(5000) });
        if (response.status === 200 || response.status === 206) {
          const fromOci = streamResponse(response, type, 'HIT-OCI', head,revision,requestedRevision);
          // OCI is a 30-track hot set; the edge cache is per-datacenter and much
          // larger. Promoting a full OCI read into it saves the OCI round trip
          // for every later listener in the same colo.
          if (edgeKey && fromOci.status === 200) writeEdgeCache(context, edgeKey, fromOci);
          return fromOci;
        }
        if (response.status === 416) {
          await response.body?.cancel().catch(() => {});
          return errorResponse('Byte range is not satisfiable', 416, head, { 'Content-Range': response.headers.get('content-range') || '' });
        }
        await response.body?.cancel().catch(() => {});
        existenceCache.delete(key);
      } catch {
        existenceCache.delete(key);
        console.warn('[audio] Hot-cache read unavailable; using archive.');
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(archiveUrl, {
      method: head ? 'HEAD' : 'GET', headers: { 'Accept-Encoding': 'identity', ...(range ? { range } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    // Old playlists/cached clients keep their original source keys after the
    // bucket move. Resolve only these known legacy layouts on a confirmed 404.
    if (response.status === 404) {
      const legacy = /^versions\/(bass|bass-reverb)\/([A-Za-z0-9_-]{11}|track-[a-f0-9]{20})\.mp3$/.exec(path);
      const migrated = legacy ? `versions/${legacy[2]}/${legacy[1]}.mp3` : !path.includes('/') ? `originals/${path}` : '';
      if (migrated) {
        await response.body?.cancel().catch(() => {});
        archiveUrl = `https://huggingface.co/buckets/${bucket}/resolve/${encodeS3ObjectKey(migrated)}`;
        response = await fetch(archiveUrl, {
          method: head ? 'HEAD' : 'GET', headers: {'Accept-Encoding': 'identity', ...(range ? {range} : {})},
          signal: AbortSignal.timeout(10_000),
        });
      }
    }
  } catch {
    return errorResponse('Remote catalog storage unreachable', 502, head);
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return errorResponse('Track not found', 404, head);
    if (response.status === 416) return errorResponse('Byte range is not satisfiable', 416, head, { 'Content-Range': response.headers.get('content-range') || '' });
    return errorResponse('Remote catalog storage failed', 502, head);
  }
  if (!head && !response.body) return errorResponse('Remote catalog storage returned no audio', 502);
  if (config && identity && !head) scheduleCacheUpload(context, config, key, objectPath, archiveUrl,identity,bucket);
  const streamed = streamResponse(response, type, 'MISS-HF-STREAMING', head,revision,requestedRevision);
  // Populate the edge cache only from a complete 200. A 206 is a partial body:
  // cache.put rejects it, and storing it would poison the entry for every
  // later request that expects the whole file.
  if (edgeKey && streamed.status === 200) writeEdgeCache(context, edgeKey, streamed);
  return streamed;
}

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: corsHeaders() });
export const onRequestGet = (context: AudioContext): Promise<Response> => handleAudio(context, false);
export const onRequestHead = (context: AudioContext): Promise<Response> => handleAudio(context, true);
