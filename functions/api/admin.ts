/* Cloudflare Pages Function — /api/admin
   The GitHub token lives HERE (as a Pages environment variable), never in
   the browser. Every request must authenticate first: either a Google ID
   token (RS256 against Google's JWKS, exp/iss/aud) or a password-login
   session token (HMAC keyed on GH_TOKEN, verified against ADMIN_PASSWORD).
   The email must match the allow-list before any GitHub API call is made. */

const REPO = 'abhinavthewc-quick/aura-music';
const WORKFLOW_FILE = 'upload-music.yml';
const ALLOWED_EMAILS = new Set([
  'vivekpereiraalbert@gmail.com',
  'abhinavthewc@gmail.com',
]);
const YT_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/;
const ALLOWED_SECRETS = new Set(['YOUTUBE_COOKIES']);
const MAX_URLS = 10;
const MAX_SECRET_BYTES = 128 * 1024;
const FALLBACK_TTL_SEC = 7 * 24 * 3600; // password sessions last 7 days

interface Env {
  GH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  ADMIN_PASSWORD?: string; // optional — enables the email+password login
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/* ---------- YouTube InnerTube search (see YOUTUBE_SEARCH_IMPL_GUIDE.md) ----------
   One POST to YouTube's private JSON RPC — no API key, no quota, no cookies.
   Results are cached twice: a module-level Map (same isolate, ~0 ms) and the
   worker Cache API (cross-isolate), because YouTube's search payload is ~200-430 KB
   and there is no official quota. */
const SEARCH_TTL_MS = 60 * 60 * 1000; // 1 hour
const SEARCH_CACHE_MAX = 200;
const SEARCH_MAX_Q = 200;
const MUSIC_PARAMS = 'EgWKAQIIAWoKEAoQAxAEEAkQBQ=='; // YT Music "Songs" tab only
const VIDEO_PARAMS = 'EgIQAQ=='; // WEB "video only"
const searchMem = new Map<string, { results: YtResult[]; at: number }>();

interface YtResult {
  videoId: string;
  title: string;
  sub: string; // "artist • album • 6:10" (music) or channel (video)
  extra: string; // "1.9B plays" (music) or "views · published" (video)
  duration: string | null;
  thumbnail: string | null;
  isLive: boolean;
}

const YT_POST_HEADERS = (origin: string) => ({
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: origin,
  Cookie: 'SOCS=CAI', // kills the EU consent interstitial
});

async function ytPost(url: string, origin: string, body: unknown): Promise<any> {
  let lastErr: unknown = new Error('YouTube request failed');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: YT_POST_HEADERS(origin),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('YouTube HTTP ' + res.status);
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('non-JSON response from YouTube (' + ct + ')');
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const runsText = (r: any): string =>
  Array.isArray(r?.runs) ? r.runs.map((x: any) => x.text).join('') : (r?.simpleText ?? '');

async function ytSearchMusic(q: string, hl: string, gl: string): Promise<YtResult[]> {
  const data = await ytPost('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', 'https://music.youtube.com', {
    context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250915.01.00', hl, gl } },
    query: q,
    params: MUSIC_PARAMS,
  });
  const sections =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer
      ?.contents || [];
  const out: YtResult[] = [];
  for (const sec of sections) {
    for (const item of sec?.musicShelfRenderer?.contents || []) {
      const r = item?.musicResponsiveListItemRenderer;
      const videoId = r?.playlistItemData?.videoId;
      if (!videoId) continue; // albums/playlists/sections carry no videoId
      const cols = (r?.flexColumns || []).map((f: any) =>
        runsText(f?.musicResponsiveListItemFlexColumnRenderer?.text),
      );
      out.push({
        videoId,
        title: cols[0] || '',
        sub: cols[1] || '',
        extra: cols[2] || '',
        duration: null,
        thumbnail: r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ?? null,
        isLive: false,
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

async function ytSearchVideos(q: string, hl: string, gl: string): Promise<YtResult[]> {
  const data = await ytPost('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', 'https://www.youtube.com', {
    context: { client: { clientName: 'WEB', clientVersion: '2.20250915.01.00', hl, gl } },
    query: q,
    params: VIDEO_PARAMS,
  });
  const items =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents || [];
  const out: YtResult[] = [];
  for (const it of items) {
    const v = it?.videoRenderer;
    if (!v?.videoId) continue;
    out.push({
      videoId: v.videoId,
      title: runsText(v.title),
      sub: runsText(v.ownerText) || runsText(v.shortBylineText),
      extra: [v?.viewCountText?.simpleText, v?.publishedTimeText?.simpleText].filter(Boolean).join(' · '),
      duration: v?.lengthText?.simpleText ?? null,
      thumbnail: v?.thumbnail?.thumbnails?.at(-1)?.url ?? null,
      isLive: !!v.isLive,
    });
    if (out.length >= 20) return out;
  }
  return out;
}

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

/* ---------- password fallback: HMAC-signed sessions (keyed on GH_TOKEN) ---------- */
function bytesToB64url(bytes: ArrayBuffer): string {
  const b = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('aura-fallback:' + env.GH_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signFallbackToken(env: Env, email: string) {
  const exp = Math.floor(Date.now() / 1000) + FALLBACK_TTL_SEC;
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email + ':' + exp));
  return { token: 'v1.' + exp + '.' + bytesToB64url(sig), exp };
}

async function verifyFallbackToken(env: Env, token: string): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
  const key = await hmacKey(env);
  for (const allowed of ALLOWED_EMAILS) {
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(allowed + ':' + parts[1]));
    if (bytesToB64url(sig) === parts[2]) return allowed;
  }
  return null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

export const onRequestPost = async ({ request, env, ctx }: {
  request: Request;
  env: Env;
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
}) => {
  if (!env?.GH_TOKEN) {
    return json({ error: 'server not configured — set GH_TOKEN (and GOOGLE_CLIENT_ID / ADMIN_PASSWORD) in the Pages environment' }, 500);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  /* ----- password login: verify against ADMIN_PASSWORD, issue signed token ----- */
  if (body?.action === 'login') {
    const loginEmail = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    if (!env.ADMIN_PASSWORD) {
      return json({ error: 'Password login is not configured — set ADMIN_PASSWORD in the Pages environment.' }, 500);
    }
    if (!ALLOWED_EMAILS.has(loginEmail)) {
      return json({ error: 'This email is not allowed.' }, 401);
    }
    if (!password) return json({ error: 'Enter your password.' }, 400);
    try {
      const [given, stored] = await Promise.all([sha256Hex(password), sha256Hex(env.ADMIN_PASSWORD)]);
      if (given !== stored) return json({ error: 'Wrong email or password.' }, 401);
    } catch {
      return json({ error: 'auth error' }, 500);
    }
    const { token, exp } = await signFallbackToken(env, loginEmail);
    return json({ token, exp, email: loginEmail });
  }

  /* ----- session exchange: spend a short-lived Google ID token ONCE for a
     7-day signed session token, so sign-in survives the ~1h ID-token expiry ----- */
  if (body?.action === 'exchange') {
    const raw = String(body.credential || '');
    if (raw.startsWith('v1.')) {
      const already = await verifyFallbackToken(env, raw);
      if (!already) return json({ error: 'session expired — sign in again' }, 401);
      return json({ token: raw, exp: Number(raw.split('.')[1]), email: already });
    }
    try {
      if (!env.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured on the server');
      const { email } = await verifyGoogle(raw, env.GOOGLE_CLIENT_ID);
      if (!ALLOWED_EMAILS.has(email)) return json({ error: email + ' is not allowed' }, 403);
      const { token, exp } = await signFallbackToken(env, email);
      return json({ token, exp, email });
    } catch (e) {
      return json({ error: (e as Error).message }, 401);
    }
  }

  /* ----- authenticate every other action: Google ID token or signed fallback token ----- */
  let email: string;
  const credential = String(body?.credential || '');
  try {
    if (credential.startsWith('v1.')) {
      const matched = await verifyFallbackToken(env, credential);
      if (!matched) throw new Error('session expired — sign in again');
      email = matched;
    } else {
      if (!env.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured on the server');
      ({ email } = await verifyGoogle(credential, env.GOOGLE_CLIENT_ID));
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 401);
  }
  if (!ALLOWED_EMAILS.has(email)) {
    return json({ error: email + ' is not allowed' }, 403);
  }

  try {
    switch (body?.action) {
      case 'search': {
        const q = String(body.q || '').trim().slice(0, SEARCH_MAX_Q);
        if (!q) return json({ error: 'empty query' }, 400);
        const mode = body.mode === 'video' ? 'video' : 'music';
        const hl = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(body.hl || '')) ? String(body.hl) : 'en';
        const gl = /^[A-Z]{2}$/.test(String(body.gl || '')) ? String(body.gl) : 'US';
        const memKey = mode + '|' + hl + '|' + gl + '|' + q.toLowerCase();

        const memHit = searchMem.get(memKey);
        if (memHit && Date.now() - memHit.at < SEARCH_TTL_MS) {
          return json({ results: memHit.results, cached: 'mem' });
        }

        const cacheKey = new Request(
          'https://aura-search.internal/ytsearch?' +
            new URLSearchParams({ mode, hl, gl, q: q.toLowerCase() }),
        );
        try {
          const hit = await (caches as any).default.match(cacheKey);
          if (hit) {
            const data = await hit.json();
            if (Array.isArray(data?.results)) {
              searchMem.set(memKey, { results: data.results, at: Date.now() });
              return json({ results: data.results, cached: 'edge' });
            }
          }
        } catch { /* cache unavailable — fetch fresh */ }

        const results = mode === 'music' ? await ytSearchMusic(q, hl, gl) : await ytSearchVideos(q, hl, gl);

        searchMem.set(memKey, { results, at: Date.now() });
        if (searchMem.size > SEARCH_CACHE_MAX) {
          const oldest = searchMem.keys().next().value;
          if (oldest !== undefined) searchMem.delete(oldest);
        }
        try {
          const cacheRes = new Response(JSON.stringify({ results }), {
            headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' },
          });
          ctx?.waitUntil((caches as any).default.put(cacheKey, cacheRes));
        } catch { /* caching is best-effort */ }
        return json({ results });
      }

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
