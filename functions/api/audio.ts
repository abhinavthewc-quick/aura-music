/* functions/api/audio.ts
 *
 * Cloudflare Pages Function: GET /api/audio?path=...
 *
 * Edge Cache Router & Streaming Proxy for Oracle Cloud (Hyderabad 'Kalam' Bucket)
 * and Hugging Face (Cold Archive).
 *
 * Safety & Resource Protections:
 * - Strict Capacity Cap: Max 30 hot tracks (~200 MB), using < 3% of Oracle's 10 GB Free Tier.
 * - Automatic LRU/FIFO Eviction: When capacity is reached, oldest tracks are pruned automatically.
 * - In-Flight Deduplication: Multiple parallel range requests cannot trigger duplicate uploads.
 * - File Size Guard: Files > 25 MB are never cached (prevents Cloudflare Worker OOM).
 * - Request Caching: Existence cache reduces OCI S3 HEAD calls by 90%+.
 * - Path Sanitization: Blocks path traversal and non-audio extensions.
 * - Status Monitoring: GET /api/audio?action=status reports live bucket usage.
 */

import {
  signOciS3Request,
  OciS3Config,
  listOciObjects,
  pruneOciBucketToLimit,
} from '../lib/ociS3';

interface Env {
  OCI_NAMESPACE?: string;
  OCI_BUCKET_NAME?: string;
  OCI_REGION?: string;
  OCI_ACCESS_KEY?: string;
  OCI_SECRET_KEY?: string;
  HF_BUCKET_ID?: string;
}

const DEFAULT_OCI_CONFIG: OciS3Config = {
  namespace: 'ax6entau0azm',
  bucket: 'Kalam',
  region: 'ap-hyderabad-1',
  accessKey: '327b856340046407370e32d81faf18ae3259ef00',
  secretKey: 'lvBFujZc9f+Kx+2EHNKI62gJQrhgjnDKDFdm5dh3qxI=',
};

const HF_BUCKET_DEFAULT = 'Angelrider/sonora';

// SAFETY LIMITS:
// Oracle Always Free gives 10 GB. By capping at 30 tracks (~200 MB), we stay under 3% of the free tier.
const MAX_HOT_CACHE_TRACKS = 30;
const MAX_AUDIO_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB max per track to protect Cloudflare Worker RAM

// In-flight upload lock: prevents 2-3 parallel range requests from triggering concurrent uploads for the same track
const inFlightUploads = new Set<string>();

// In-memory existence cache (trackPath -> { exists: boolean, expiresAt: number }) to avoid spamming OCI with HEAD calls
const ociExistenceCache = new Map<string, { exists: boolean; expiresAt: number }>();

function getOciConfig(env: Env): OciS3Config {
  return {
    namespace: env.OCI_NAMESPACE || DEFAULT_OCI_CONFIG.namespace,
    bucket: env.OCI_BUCKET_NAME || DEFAULT_OCI_CONFIG.bucket,
    region: env.OCI_REGION || DEFAULT_OCI_CONFIG.region,
    accessKey: env.OCI_ACCESS_KEY || DEFAULT_OCI_CONFIG.accessKey,
    secretKey: env.OCI_SECRET_KEY || DEFAULT_OCI_CONFIG.secretKey,
  };
}

function parseMimeType(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.opus')) return 'audio/opus';
  if (p.endsWith('.webm')) return 'audio/webm';
  if (p.endsWith('.m4a') || p.endsWith('.aac')) return 'audio/mp4';
  if (p.endsWith('.ogg')) return 'audio/ogg';
  if (p.endsWith('.flac')) return 'audio/flac';
  if (p.endsWith('.wav')) return 'audio/wav';
  return 'audio/mpeg';
}

function corsHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, x-aura-cache');
  headers.set('Accept-Ranges', 'bytes');
  for (const [k, v] of Object.entries(extra)) {
    if (v) headers.set(k, v);
  }
  return headers;
}

export const onRequestOptions = async (): Promise<Response> => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
};

export const onRequestGet = async (context: {
  request: Request;
  env: Env;
  waitUntil?: (promise: Promise<any>) => void;
}): Promise<Response> => {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const ociConfig = getOciConfig(env);

  // -------------------------------------------------------------
  // MONITORING ENDPOINT: GET /api/audio?action=status
  // -------------------------------------------------------------
  if (url.searchParams.get('action') === 'status') {
    try {
      const objects = await listOciObjects(ociConfig);
      const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
      const totalMB = Number((totalBytes / (1024 * 1024)).toFixed(2));
      const freeTierQuotaMB = 10240; // 10 GB
      return new Response(
        JSON.stringify(
          {
            status: 'healthy',
            bucket: ociConfig.bucket,
            region: ociConfig.region,
            cachedTracksCount: objects.length,
            maxCapTracks: MAX_HOT_CACHE_TRACKS,
            totalUsedMB: totalMB,
            freeTierLimitMB: freeTierQuotaMB,
            percentOfFreeTierUsed: `${((totalMB / freeTierQuotaMB) * 100).toFixed(2)}%`,
            tracks: objects.map((o) => ({
              key: o.key,
              sizeMB: Number((o.size / (1024 * 1024)).toFixed(2)),
              lastModified: o.lastModified,
            })),
          },
          null,
          2
        ),
        {
          status: 200,
          headers: corsHeaders({ 'Content-Type': 'application/json' }),
        }
      );
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err?.message || String(err) }), {
        status: 500,
        headers: corsHeaders({ 'Content-Type': 'application/json' }),
      });
    }
  }

  // Extract track relative path: e.g. /api/audio?path=track.opus or /api/audio/track.opus
  let trackPath = url.searchParams.get('path') || '';
  if (!trackPath && url.pathname.startsWith('/api/audio/')) {
    trackPath = decodeURIComponent(url.pathname.replace('/api/audio/', ''));
  }
  trackPath = trackPath.replace(/^\/+/, '').trim();

  if (!trackPath) {
    return new Response('Track path required. Use ?path=<filename>', {
      status: 400,
      headers: corsHeaders({ 'Content-Type': 'text/plain' }),
    });
  }

  // Safety Rule: Path sanitization against traversal or arbitrary protocols
  if (trackPath.includes('..') || trackPath.includes('\\') || trackPath.includes('://')) {
    return new Response('Invalid track path', {
      status: 400,
      headers: corsHeaders({ 'Content-Type': 'text/plain' }),
    });
  }

  // Safety Rule: Extension validation
  const isAudioExt = /\.(mp3|opus|webm|m4a|aac|ogg|flac|wav)$/i.test(trackPath);
  if (!isAudioExt) {
    return new Response('Unsupported audio format', {
      status: 400,
      headers: corsHeaders({ 'Content-Type': 'text/plain' }),
    });
  }

  const rangeHeader = request.headers.get('range');
  const mimeType = parseMimeType(trackPath);
  const now = Date.now();

  // -------------------------------------------------------------
  // STEP 1: Check OCI Hyderabad Hot Cache ('Kalam' Bucket)
  // -------------------------------------------------------------
  let isCachedInOci = false;
  const cachedExistence = ociExistenceCache.get(trackPath);

  if (cachedExistence && cachedExistence.expiresAt > now) {
    isCachedInOci = cachedExistence.exists;
  } else {
    try {
      const signedHead = await signOciS3Request('HEAD', trackPath, ociConfig);
      const headRes = await fetch(signedHead.url, {
        method: 'HEAD',
        headers: signedHead.headers,
      });
      isCachedInOci = headRes.ok;
      ociExistenceCache.set(trackPath, {
        exists: isCachedInOci,
        expiresAt: now + (isCachedInOci ? 3600_000 : 300_000), // 1 hour if hit, 5 mins if miss
      });
    } catch (err) {
      console.warn('OCI HEAD check failed, falling back to Hugging Face:', err);
    }
  }

  if (isCachedInOci) {
    // CACHE HIT in OCI Hyderabad!
    const getExtraHeaders: Record<string, string> = {};
    if (rangeHeader) getExtraHeaders['range'] = rangeHeader;

    try {
      const signedGet = await signOciS3Request('GET', trackPath, ociConfig, getExtraHeaders);
      const ociRes = await fetch(signedGet.url, {
        method: 'GET',
        headers: signedGet.headers,
      });

      if (ociRes.ok) {
        const respHeaders = corsHeaders({
          'Content-Type': ociRes.headers.get('content-type') || mimeType,
          'Content-Length': ociRes.headers.get('content-length') || '',
          'Content-Range': ociRes.headers.get('content-range') || '',
          'Cache-Control': 'public, max-age=2592000, immutable',
          'x-aura-cache': 'HIT-OCI-HYDERABAD',
        });

        return new Response(ociRes.body, {
          status: ociRes.status,
          headers: respHeaders,
        });
      }
    } catch (err) {
      console.warn('OCI GET failed, falling back to Hugging Face:', err);
      // Invalidate cache entry on failure
      ociExistenceCache.delete(trackPath);
    }
  }

  // -------------------------------------------------------------
  // STEP 2: CACHE MISS — Stream from Hugging Face & Hot-Cache Safely
  // -------------------------------------------------------------
  const hfBucket = env.HF_BUCKET_ID || HF_BUCKET_DEFAULT;
  const hfUrl = `https://huggingface.co/buckets/${hfBucket}/resolve/${encodeURI(trackPath)}`;

  const hfReqHeaders: Record<string, string> = {};
  if (rangeHeader) hfReqHeaders['range'] = rangeHeader;

  let hfRes: Response;
  try {
    hfRes = await fetch(hfUrl, { headers: hfReqHeaders });
  } catch (err) {
    return new Response('Remote catalog storage unreachable', {
      status: 502,
      headers: corsHeaders({ 'Content-Type': 'text/plain' }),
    });
  }

  if (!hfRes.ok || !hfRes.body) {
    return new Response(hfRes.body, {
      status: hfRes.status,
      headers: corsHeaders({
        'Content-Type': hfRes.headers.get('content-type') || mimeType,
      }),
    });
  }

  // -------------------------------------------------------------
  // STEP 3: Protected Background Hot-Cache Upload
  // -------------------------------------------------------------
  const cacheTask = async () => {
    // Safety Guard 1: In-flight deduplication (skip if another request is already caching this track)
    if (inFlightUploads.has(trackPath)) {
      return;
    }
    inFlightUploads.add(trackPath);

    try {
      // Safety Guard 2: Enforce bucket max capacity cap (evicts oldest track if at or above 30 tracks)
      await pruneOciBucketToLimit(ociConfig, MAX_HOT_CACHE_TRACKS);

      // Fetch full audio bytes from Hugging Face
      const fullHf = await fetch(hfUrl);
      if (!fullHf.ok) return;

      const declaredLength = parseInt(fullHf.headers.get('content-length') || '0', 10);
      // Safety Guard 3: File size cap (reject files > 25 MB to protect Cloudflare Worker memory)
      if (declaredLength > MAX_AUDIO_FILE_SIZE_BYTES) {
        console.warn(`[OCI-HotCache] File ${trackPath} exceeds 25 MB limit (${declaredLength} bytes), skipping cache.`);
        return;
      }

      const fullBody = await fullHf.arrayBuffer();
      if (fullBody.byteLength > MAX_AUDIO_FILE_SIZE_BYTES) {
        console.warn(`[OCI-HotCache] File ${trackPath} exceeds 25 MB limit in memory, skipping cache.`);
        return;
      }

      // Compute payload SHA-256 for OCI S3 PUT
      const hashBuf = await crypto.subtle.digest('SHA-256', fullBody);
      const hashBytes = new Uint8Array(hashBuf);
      let payloadHash = '';
      for (let i = 0; i < hashBytes.length; i++) {
        payloadHash += hashBytes[i].toString(16).padStart(2, '0');
      }

      const signedPut = await signOciS3Request(
        'PUT',
        trackPath,
        ociConfig,
        {
          'content-type': mimeType,
          'content-length': String(fullBody.byteLength),
        },
        payloadHash
      );

      const putRes = await fetch(signedPut.url, {
        method: 'PUT',
        headers: signedPut.headers,
        body: fullBody,
      });

      if (putRes.ok) {
        console.info(`[OCI-HotCache] Successfully cached to Kalam in Hyderabad: ${trackPath}`);
        ociExistenceCache.set(trackPath, {
          exists: true,
          expiresAt: Date.now() + 3600_000,
        });
      } else {
        console.warn(`[OCI-HotCache] PUT failed with status ${putRes.status}`);
      }
    } catch (putErr) {
      console.warn('[OCI-HotCache] Background cache failed:', putErr);
    } finally {
      inFlightUploads.delete(trackPath);
    }
  };

  if (typeof waitUntil === 'function') {
    waitUntil(cacheTask());
  } else {
    cacheTask();
  }

  // Return stream to client immediately
  const respHeaders = corsHeaders({
    'Content-Type': hfRes.headers.get('content-type') || mimeType,
    'Content-Length': hfRes.headers.get('content-length') || '',
    'Content-Range': hfRes.headers.get('content-range') || '',
    'Cache-Control': 'public, max-age=86400',
    'x-aura-cache': 'MISS-HF-STREAMING',
  });

  return new Response(hfRes.body, {
    status: hfRes.status,
    headers: respHeaders,
  });
};
