/* Cloudflare Pages Function — /api/admin
   The GitHub token lives HERE (as a Pages environment variable), never in
   the browser. Every request must carry a Google ID token; it is fully
   re-verified (RS256 against Google's JWKS, exp/iss/aud) and the email must
   match the allow-list before any GitHub API call is made. */

const REPO = 'abhinavthewc-quick/aura-music';
const WORKFLOW_FILE = 'upload-music.yml';
const ALLOWED_EMAIL = 'vivekpereiraalbert@gmail.com';
const YT_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/;
const ALLOWED_SECRETS = new Set(['YOUTUBE_COOKIES']);
const MAX_URLS = 10;
const MAX_SECRET_BYTES = 128 * 1024;

interface Env {
  GH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/* ---------- Google ID-token verification (mirror of src/core/google-auth.ts) ---------- */
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let certsCache: { keys: any[]; fetchedAt: number } | null = null;
const CERTS_TTL_MS = 10 * 60 * 1000;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyGoogle(token: string, clientId: string) {
  if (!token || typeof token !== 'string') throw new Error('missing credential');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed credential');
  const [h, p, s] = parts;

  let header: any, payload: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    throw new Error('malformed credential');
  }
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  if (!certsCache || Date.now() - certsCache.fetchedAt > CERTS_TTL_MS) {
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error('could not fetch Google signing keys');
    const data = await res.json();
    if (!Array.isArray(data?.keys) || !data.keys.length) throw new Error('Google signing keys missing');
    certsCache = { keys: data.keys, fetchedAt: Date.now() };
  }
  const jwk = certsCache.keys.find(
    (k) => k.kid === header.kid && (k.use === 'sig' || !k.use) && (k.alg === 'RS256' || !k.alg),
  );
  if (!jwk) throw new Error('no matching Google signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = new TextEncoder().encode(h + '.' + p);
  const sig = b64urlToBytes(s);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    sig.buffer as ArrayBuffer,
    data.buffer as ArrayBuffer,
  );
  if (!ok) throw new Error('signature verification failed');

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - 60) throw new Error('session expired — sign in again');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'https://accounts.google.com/') {
    throw new Error('unexpected token issuer');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new Error('token was not issued for this app');
  if (!payload.email) throw new Error('token has no email');
  if (payload.email_verified === false || payload.email_verified === 'false') throw new Error('Google email is not verified');
  return { email: String(payload.email).toLowerCase() };
}

/* ---------- GitHub API ---------- */
async function gh<T = any>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'User-Agent': 'aura-admin',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j: any = await res.json();
      if (j?.message) msg += ' — ' + j.message;
    } catch { /* keep status text */ }
    const err = new Error(msg);
    (err as any).upstream = true;
    throw err;
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env?.GH_TOKEN || !env?.GOOGLE_CLIENT_ID) {
    return json({ error: 'server not configured — set GH_TOKEN and GOOGLE_CLIENT_ID in the Pages environment' }, 500);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  let email: string;
  try {
    ({ email } = await verifyGoogle(String(body?.credential || ''), env.GOOGLE_CLIENT_ID));
  } catch (e) {
    return json({ error: (e as Error).message }, 401);
  }
  if (email !== ALLOWED_EMAIL.toLowerCase()) {
    return json({ error: email + ' is not allowed' }, 403);
  }

  try {
    switch (body?.action) {
      case 'dispatch': {
        const urls: unknown = body.urls;
        if (!Array.isArray(urls) || !urls.length) return json({ error: 'no URLs given' }, 400);
        if (urls.length > MAX_URLS) return json({ error: 'max ' + MAX_URLS + ' URLs per run' }, 400);
        for (const u of urls) {
          if (typeof u !== 'string' || !YT_RE.test(u)) return json({ error: 'invalid YouTube URL in list' }, 400);
        }
        await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
          method: 'POST',
          body: JSON.stringify({ ref: 'main', inputs: { urls: urls.join('\n') } }),
        });
        return json({ ok: true });
      }

      case 'setSecret': {
        const name = String(body.name || '');
        if (!ALLOWED_SECRETS.has(name)) return json({ error: 'secret not allowed from this panel' }, 400);
        const value = typeof body.value === 'string' ? body.value : '';
        if (!value.trim()) return json({ error: 'empty value — nothing to save' }, 400);
        if (value.length > MAX_SECRET_BYTES) return json({ error: 'value too large' }, 400);

        const pub = await gh<{ key: string; key_id: string }>(env, `/repos/${REPO}/actions/secrets/public-key`);
        const sodium = (await import('libsodium-wrappers')).default;
        await sodium.ready;
        const sealed = sodium.crypto_box_seal(
          sodium.from_string(value),
          sodium.from_base64(pub.key, sodium.base64_variants.ORIGINAL),
        );
        await gh(env, `/repos/${REPO}/actions/secrets/${name}`, {
          method: 'PUT',
          body: JSON.stringify({
            encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
            key_id: pub.key_id,
          }),
        });
        return json({ ok: true });
      }

      case 'deleteSecret': {
        const name = String(body.name || '');
        if (!ALLOWED_SECRETS.has(name)) return json({ error: 'secret not allowed from this panel' }, 400);
        await gh(env, `/repos/${REPO}/actions/secrets/${name}`, { method: 'DELETE' });
        return json({ ok: true });
      }

      case 'status': {
        const data = await gh<{ secrets: { name: string }[] }>(env, `/repos/${REPO}/actions/secrets?per_page=100`);
        return json({ secrets: (data.secrets || []).map((s) => s.name), repo: REPO });
      }

      case 'runs': {
        const data = await gh<{ workflow_runs: any[] }>(
          env,
          `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=8`,
        );
        const runs = (data.workflow_runs || []).map((r) => ({
          id: r.id,
          status: r.status,
          conclusion: r.conclusion,
          created_at: r.created_at,
          html_url: r.html_url,
          display_title: r.display_title,
        }));
        return json({ runs });
      }

      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || 'server error' }, 502);
  }
};
