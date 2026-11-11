import { normalizeArtistKey } from '../../lib/artistProfiles.js';
import type { ArtistMetadataResponse } from '../../lib/artistMetadata.js';
import type { ArtistEnv } from '../lib/artistStore.js';
import { validArtistMetadataName } from '../lib/artistMetadata.js';
import { readArtistMetadata, type ArtistMetadataStoreOptions } from '../lib/artistMetadataStore.js';

interface MetadataContext { request: Request; env: ArtistEnv }
const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function methodNotAllowed(): Response {
  return Response.json({ key: '', status: 'not-found' } satisfies ArtistMetadataResponse,
    { status: 405, headers: { ...SAFE_HEADERS, 'Allow': 'GET, HEAD' } });
}

export async function handleArtistMetadata(
  { request, env }: MetadataContext, options: ArtistMetadataStoreOptions = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
  const url = new URL(request.url);
  const names = url.searchParams.getAll('name');
  const name = names[0] || '';
  const key = normalizeArtistKey(name);
  if (url.search.length > 2048 || names.length !== 1 || [...url.searchParams.keys()].some((parameter) => parameter !== 'name') || !validArtistMetadataName(name)) {
    return Response.json({ key, status: 'not-found' } satisfies ArtistMetadataResponse, { status: 400, headers: SAFE_HEADERS });
  }
  /* Public metadata reads only. No admin/session logic, no manual-directory
     merge, and no provider-derived artist/track/profile mutations. */
  const result = await readArtistMetadata(env, name, {
    ...options, interactive: request.headers.get('X-Aura-Artist-Intent') === 'view',
  });
  const headers = new Headers(SAFE_HEADERS);
  if (result.response.retryAfter) headers.set('Retry-After', String(result.response.retryAfter));
  else if (result.cacheUntil) {
    const age = Math.max(0, Math.min(300, Math.floor((result.cacheUntil - (options.now || Date.now)()) / 1000)));
    if (age > 0) headers.set('Cache-Control', `public, max-age=${age}, s-maxage=${age}`);
  }
  const response = Response.json({ ...result.response, key }, { status: result.unavailable ? 503 : 200, headers });
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export const onRequestGet = (context: MetadataContext) => handleArtistMetadata(context);
export const onRequestHead = onRequestGet;
export const onRequestPost = methodNotAllowed;
export const onRequestPut = methodNotAllowed;
export const onRequestPatch = methodNotAllowed;
export const onRequestDelete = methodNotAllowed;
export const onRequestOptions = methodNotAllowed;
