/* functions/api/audio.ts
 *
 * Cloudflare Pages Function: GET /api/audio?path=...
 *
 * Edge Cache Router & Streaming Proxy for Oracle Cloud (Hyderabad 'Kalam' Bucket)
 * and Hugging Face (Cold Archive).
 *
 * Features:
 * - OCI S3 SigV4 signed requests (zero browser CORS restrictions)
 * - HTTP 206 Partial Content & byte-range streaming for instant seeking
 * - Cache-through: Automatic background upload to OCI Kalam on first play
 * - Edge response caching (30-day immutable)
 */

import { signOciS3Request, OciS3Config } from '../lib/ociS3';

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

  const rangeHeader = request.headers.get('range');
  const ociConfig = getOciConfig(env);
  const mimeType = parseMimeType(trackPath);

  // -------------------------------------------------------------
  // STEP 1: Check OCI Hyderabad Hot Cache ('Kalam' Bucket)
  // -------------------------------------------------------------
  try {
    const signedHead = await signOciS3Request('HEAD', trackPath, ociConfig);
    const headRes = await fetch(signedHead.url, {
      method: 'HEAD',
      headers: signedHead.headers,
    });

    if (headRes.ok) {
      // CACHE HIT in OCI Hyderabad!
      const getExtraHeaders: Record<string, string> = {};
      if (rangeHeader) getExtraHeaders['range'] = rangeHeader;

      const signedGet = await signOciS3Request('GET', trackPath, ociConfig, getExtraHeaders);
      const ociRes = await fetch(signedGet.url, {
        method: 'GET',
        headers: signedGet.headers,
      });

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
    console.warn('OCI HEAD check failed, falling back to Hugging Face:', err);
  }

  // -------------------------------------------------------------
  // STEP 2: CACHE MISS — Stream from Hugging Face & Cache to OCI
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
  // STEP 3: Asynchronous Background Cache-Through to OCI 'Kalam'
  // -------------------------------------------------------------
  const cacheTask = async () => {
    try {
      // Fetch full audio bytes from Hugging Face if client only requested a range
      let fullBody: ArrayBuffer;
      if (rangeHeader) {
        const fullHf = await fetch(hfUrl);
        if (!fullHf.ok) return;
        fullBody = await fullHf.arrayBuffer();
      } else {
        // Full file requested: clone buffer
        const fullHf = await fetch(hfUrl);
        if (!fullHf.ok) return;
        fullBody = await fullHf.arrayBuffer();
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
      } else {
        console.warn(`[OCI-HotCache] PUT failed with status ${putRes.status}`);
      }
    } catch (putErr) {
      console.warn('[OCI-HotCache] Background cache failed:', putErr);
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
