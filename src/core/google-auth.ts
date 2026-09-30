/* Verifies a Google Sign-In (GIS) ID token in the browser using Web Crypto:
   RS256 signature against Google's published JWKS, plus exp/iss/aud checks.
   The same logic is mirrored server-side in functions/api/admin.ts. */

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string;
  exp: number;
}

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let certsCache: { keys: any[]; fetchedAt: number } | null = null;
const CERTS_TTL_MS = 10 * 60 * 1000;

async function getCerts(): Promise<any[]> {
  if (certsCache && Date.now() - certsCache.fetchedAt < CERTS_TTL_MS) return certsCache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error('could not fetch Google signing keys');
  const data = await res.json();
  if (!Array.isArray(data?.keys) || !data.keys.length) throw new Error('Google signing keys missing');
  certsCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyGoogleCredential(token: string, clientId: string): Promise<GoogleProfile> {
  if (!clientId) throw new Error('Google sign-in is not configured (missing client ID)');
  if (!token || typeof token !== 'string') throw new Error('missing credential');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed credential');
  const [h, p, s] = parts;

  let header: any;
  let payload: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    throw new Error('malformed credential');
  }
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  const keys = await getCerts();
  const jwk = keys.find((k) => k.kid === header.kid && (k.use === 'sig' || !k.use) && (k.alg === 'RS256' || !k.alg));
  if (!jwk) throw new Error('no matching Google signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const data = new TextEncoder().encode(h + '.' + p);
  const sig = b64urlToBytes(s);
  const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
  if (!ok) throw new Error('signature verification failed');

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - 60) throw new Error('session expired — sign in again');
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) throw new Error('token not valid yet');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'https://accounts.google.com/') {
    throw new Error('unexpected token issuer');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new Error('token was not issued for this app');
  if (!payload.email) throw new Error('token has no email');
  if (payload.email_verified === false || payload.email_verified === 'false') throw new Error('Google email is not verified');

  return {
    sub: String(payload.sub || ''),
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || payload.email || ''),
    picture: String(payload.picture || ''),
    exp: Number(payload.exp),
  };
}
