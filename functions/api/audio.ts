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

export interface AudioEnv {
  OCI_NAMESPACE?: string;
  OCI_BUCKET_NAME?: string;
  OCI_REGION?: string;
  OCI_ACCESS_KEY?: string;
  OCI_SECRET_KEY?: string;
  AUDIO_ADMIN_TOKEN?: string;
  HF_BUCKET_ID?: string;
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
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, x-aura-cache',
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

function streamResponse(response: Response, type: string, cache: string, head: boolean): Response {
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
      'Cache-Control': 'public, max-age=3600',
      'x-aura-cache': cache,
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

function scheduleCacheUpload(context: AudioContext, config: OciS3Config, key: string, path: string, archiveUrl: string): void {
  if (typeof context.waitUntil !== 'function' || inFlightUploads.has(key)) return;
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
      const capacity = await pruneOciBucketToLimit(config, MAX_HOT_CACHE_TRACKS);
      if (!capacity.hasCapacity) return;
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      const payloadHash = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const signed = await signOciS3Request('PUT', path, config, {
        'content-type': mimeType(path), 'content-length': String(bytes.byteLength),
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

async function statusResponse(context: AudioContext, config: OciS3Config | null, head: boolean): Promise<Response> {
  const expected = context.env.AUDIO_ADMIN_TOKEN?.trim() || '';
  const given = /^Bearer\s+(.+)$/i.exec(context.request.headers.get('authorization') || '')?.[1]?.trim() || '';
  if (!expected || !given || given.length > 4096 || !(await timingSafeTokenMatch(given, expected))) {
    return errorResponse('Not found', 404, head, { Vary: 'Authorization' });
  }
  if (!config) return errorResponse('Hot cache is not configured', 503, head, { Vary: 'Authorization' });
  try {
    const objects = await listOciObjects(config);
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
  const path = validateTrackPath(url);
  if (!path) return errorResponse('A valid relative track path is required', 400, head);
  if (!AUDIO_EXTENSION.test(path)) return errorResponse('Unsupported audio format', 400, head);
  const range = validateRange(request.headers.get('range'));
  if (range === false) return errorResponse('Only one valid byte range is supported', 400, head);
  const bucket = env.HF_BUCKET_ID?.trim() || HF_BUCKET_DEFAULT;
  if (!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(bucket)) {
    return errorResponse('Archive storage is not configured correctly', 503, head);
  }
  const archiveUrl = `https://huggingface.co/buckets/${bucket}/resolve/${encodeS3ObjectKey(path)}`;
  const type = mimeType(path);
  const key = config ? `${config.namespace}/${config.region}/${config.bucket}/${bucket}/${path}` : '';

  if (config) {
    let exists = existenceCache.get(key)?.exists || false;
    const cached = existenceCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
      try {
        const signed = await signOciS3Request('HEAD', path, config);
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
        const signed = await signOciS3Request(head ? 'HEAD' : 'GET', path, config, range ? { range } : {});
        const response = await fetch(signed.url, { method: head ? 'HEAD' : 'GET', headers: signed.headers, signal: AbortSignal.timeout(5000) });
        if (response.status === 200 || response.status === 206) return streamResponse(response, type, 'HIT-OCI', head);
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
  if (config && !head) scheduleCacheUpload(context, config, key, path, archiveUrl);
  return streamResponse(response, type, 'MISS-HF-STREAMING', head);
}

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: corsHeaders() });
export const onRequestGet = (context: AudioContext): Promise<Response> => handleAudio(context, false);
export const onRequestHead = (context: AudioContext): Promise<Response> => handleAudio(context, true);
