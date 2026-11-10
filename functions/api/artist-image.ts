import { PORTRAIT_ID_RE } from '../../lib/artistProfiles.js';
import { readPortrait, type ArtistEnv } from '../lib/artistStore.js';

export const onRequestGet = async ({ request, env, waitUntil }: {
  request: Request; env: ArtistEnv; waitUntil?: (promise: Promise<unknown>) => void;
}) => {
  const id = new URL(request.url).searchParams.get('id') || '';
  const missing = () => new Response('Portrait not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!PORTRAIT_ID_RE.test(id)) return missing();
  const cacheKey = new Request(new URL('/api/artist-image?id=' + id, request.url), { method: 'GET' });
  let response: Response | undefined;
  try { response = await (caches as any).default.match(cacheKey); } catch { /* cache is optional */ }
  if (!response) {
    let image: Awaited<ReturnType<typeof readPortrait>>;
    try { image = await readPortrait(env, id); }
    catch { return new Response('Portrait temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
    if (!image) return missing();
    const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes as ArrayBuffer);
    response = new Response(bytes as BodyInit, { headers: {
      'Content-Type': image.mime,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': '"' + image.etag + '"',
      'X-Content-Type-Options': 'nosniff',
    } });
    if (waitUntil) {
      try { waitUntil((caches as any).default.put(cacheKey, response.clone()).catch(() => {})); } catch { /* cache is optional */ }
    }
  }
  const requestedEtag = request.headers.get('If-None-Match');
  if (requestedEtag && requestedEtag.split(',').some((tag) => tag.trim().replace(/^W\//, '') === response.headers.get('ETag') || tag.trim() === '*')) {
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
};

export const onRequestHead = onRequestGet;
