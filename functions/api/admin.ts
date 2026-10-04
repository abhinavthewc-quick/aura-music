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
const MAX_URLS = 25;       // per run
const CHAIN_MAX_URLS = 300; // per dispatch — the runs chain themselves for the rest
const MAX_SECRET_BYTES = 128 * 1024;
const FALLBACK_TTL_SEC = 7 * 24 * 3600; // password sessions last 7 days
const HF_BUCKET = 'Angelrider/sonora'; // public tree — no HF token needed for reads
const TREE_TTL_MS = 60 * 1000;
const VIDEO_ID_SUFFIX_RE = /\s\[([A-Za-z0-9_-]{11})\]$/;
const MANAGE_WORKFLOW_FILE = 'manage-music.yml';
const STAGING_DIR = '.staging';
const AUDIO_EXT_RE = /\.(opus|mp3|ogg|m4a|webm)$/i;
const IMAGE_EXT_RE = /\.(webp|jpe?g|png)$/i;
const MAX_COVER_B64 = Math.ceil(1.5 * 1024 * 1024) * 4 / 3 + 64; // ~1.5 MB image

interface Env {
  GH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  ADMIN_PASSWORD?: string; // optional — enables the email+password login
  HF_TOKEN?: string; // bucket mutations (rename/delete) — set in Pages env
  HF_BUCKET_ID?: string;
}

interface BucketFile {
  path: string;
  size: number;
  mtime: string;
  xetHash?: string; // required to copyFile (rename) server-side
}

function ytIdOf(u: string): string {
  const m = YT_RE.exec(u);
  return m ? m[1] : '';
}

/* Bucket tree: the single source of truth for "what is already uploaded".
   Cached in-module (same isolate) and in the worker Cache API for 60s. */
let treeMem: { files: BucketFile[]; at: number } | null = null;

async function bucketTree(force = false): Promise<BucketFile[]> {
  if (!force && treeMem && Date.now() - treeMem.at < TREE_TTL_MS) return treeMem.files;
  const cacheKey = new Request('https://aura-bucket.internal/tree?' + HF_BUCKET);
  if (!force) {
    try {
      const hit = await (caches as any).default.match(cacheKey);
      if (hit) {
        const data = await hit.json();
        if (Array.isArray(data?.files)) {
          treeMem = { files: data.files, at: Date.now() };
          return data.files;
        }
      }
    } catch { /* cache unavailable — fetch fresh */ }
  }
  const res = await fetch(`https://huggingface.co/api/buckets/${HF_BUCKET}/tree?recursive=true`);
  if (!res.ok) throw new Error('bucket listing failed (HTTP ' + res.status + ')');
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('unexpected bucket listing format');
  const files: BucketFile[] = [];
  for (const it of items) {
    if (it && it.type === 'file' && typeof it.path === 'string') {
      files.push({
        path: it.path,
        size: Number(it.size) || 0,
        mtime: String(it.mtime || ''),
        xetHash: typeof it.xetHash === 'string' ? it.xetHash : undefined,
      });
    }
  }
  treeMem = { files, at: Date.now() };
  try {
    const cacheRes = new Response(JSON.stringify({ files }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
    });
    await (caches as any).default.put(cacheKey, cacheRes);
  } catch { /* caching is best-effort */ }
  return files;
}

function uploadedVideoIds(files: BucketFile[]): Set<string> {
  const ids = new Set<string>();
  for (const f of files) {
    const m = VIDEO_ID_SUFFIX_RE.exec(f.path.replace(/\.[^.]+$/, ''));
    if (m) ids.add(m[1]);
  }
  return ids;
}

/* Drop both tree caches — called after every bucket mutation so the very
   next library/dispatch request sees the new state. */
async function invalidateTree(): Promise<void> {
  treeMem = null;
  try {
    await (caches as any).default.delete(new Request('https://aura-bucket.internal/tree?' + HF_BUCKET));
  } catch { /* cache unavailable */ }
}

function hfBucketId(env: Env): string {
  return env.HF_BUCKET_ID || HF_BUCKET;
}

/* HF buckets mutate through a single NDJSON batch endpoint: copyFile (=
   server-side rename, needs xetHash + mtime in ms) and deleteFile. Uploading
   NEW bytes is not expressible here — that path goes through the
   manage-music.yml workflow with the GitHub-held HF_TOKEN. */
async function hfBatch(env: Env, ops: Record<string, unknown>[]): Promise<any> {
  if (!env.HF_TOKEN) {
    throw new Error('HF_TOKEN is not set in the Pages environment — add HF_TOKEN + HF_BUCKET_ID to the deployment');
  }
  if (!ops.length) return { success: true, processed: 0, succeeded: 0, failed: [] };
  const body = ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const res = await fetch(`https://huggingface.co/api/buckets/${hfBucketId(env)}/batch`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.HF_TOKEN, 'Content-Type': 'application/x-ndjson' },
    body,
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || data?.message || 'bucket update failed (HTTP ' + res.status + ')');
  if (data && Array.isArray(data.failed) && data.failed.length) {
    throw new Error('bucket update failed: ' + JSON.stringify(data.failed).slice(0, 300));
  }
  return data;
}

/* manifest.json — clean track metadata (title/artist/album/year/duration)
   keyed by video ID. Fetched anonymously (the resolve URL is public) with a
   hard timeout so a slow CDN never stalls an admin action; never fatal. */
type ManifestTracks = Record<string, Record<string, unknown>>;
let manifestMem: { tracks: ManifestTracks; at: number } | null = null;
const MANIFEST_TTL_MS = 30_000;
async function hfManifest(env: Env): Promise<ManifestTracks> {
  if (manifestMem && Date.now() - manifestMem.at < MANIFEST_TTL_MS) return manifestMem.tracks;
  try {
    const res = await fetch(`https://huggingface.co/buckets/${hfBucketId(env)}/resolve/manifest.json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data: any = await res.json();
    const tracks = data && data.tracks;
    const out = tracks && typeof tracks === 'object' ? (tracks as ManifestTracks) : {};
    manifestMem = { tracks: out, at: Date.now() };
    return out;
  } catch {
    return manifestMem ? manifestMem.tracks : {};
  }
}
function invalidateManifest(): void { manifestMem = null; }

/* UTF-8-safe base64 for GitHub Contents API staging (btoa wants binary). */
function toB64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function assertSafePath(p: string): void {
  if (!p || p.length > 512 || p.startsWith('/') || p.includes('..') || p.includes('\0')) {
    throw new Error('invalid file path');
  }
}

/* Remove a staged .staging file after a failed dispatch (best-effort). */
async function cleanupStaged(env: Env, path: string): Promise<void> {
  try {
    const meta = await gh<{ sha: string }>(env, `/repos/${REPO}/contents/${path}`);
    await gh(env, `/repos/${REPO}/contents/${path}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `chore: drop stale staging file ${path}`, sha: meta.sha, branch: 'main' }),
    });
  } catch { /* already gone / never landed */ }
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

/* ---------- InnerTube playlist/album expansion ----------
   Pasted /playlist?list=… links are expanded server-side into individual
   tracks, so the workflow still downloads real per-track files. YT Music's
   browse endpoint serves both playlists (browseId "VL"+id) and albums
   (browseId "MPRE…") in one code path. */
const EXPAND_MAX_TRACKS = 300;
const EXPAND_MAX_PAGES = 6;
const LIST_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function collectPlaylistItems(node: any, out: YtResult[], cap = EXPAND_MAX_TRACKS): void {
  if (!node || typeof node !== 'object' || out.length >= cap) return;
  if (Array.isArray(node)) {
    for (const x of node) collectPlaylistItems(x, out, cap);
    return;
  }
  const r = node.musicResponsiveListItemRenderer;
  if (r) {
    const videoId =
      r?.playlistItemData?.videoId ||
      r?.overlay?.musicCardPlayerOverlayRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
    if (videoId && !out.some((x) => x.videoId === videoId)) {
      const cols = (r.flexColumns || []).map((f: any) =>
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
    }
  }
  for (const k of Object.keys(node)) {
    if (k !== 'musicResponsiveListItemRenderer') collectPlaylistItems(node[k], out, cap);
  }
}

function findContinuation(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const found = findContinuation(x);
      if (found) return found;
    }
    return null;
  }
  const next = node.nextContinuationData?.continuation;
  if (typeof next === 'string') return next;
  const reload = node.reloadContinuationData?.continuation;
  if (typeof reload === 'string') return reload;
  for (const k of Object.keys(node)) {
    const found = findContinuation(node[k]);
    if (found) return found;
  }
  return null;
}

function findHeaderTitle(node: any): string {
  if (!node || typeof node !== 'object') return '';
  const hdr =
    node.musicDetailHeaderRenderer ||
    node.musicDetailedMetadataHeaderRenderer ||
    node.musicTwoRowItemRenderer;
  const t = hdr && (hdr.title || hdr.displayName);
  if (t && (t.runs || t.simpleText)) {
    const text = runsText(t).trim();
    if (text) return text;
  }
  for (const k of Object.keys(node)) {
    const found = findHeaderTitle(node[k]);
    if (found) return found;
  }
  return '';
}

async function ytBrowse(origin: string, hl: string, gl: string, payload: Record<string, unknown>): Promise<any> {
  return ytPost(origin + '/youtubei/v1/browse?prettyPrint=false', origin, {
    context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250915.01.00', hl, gl } },
    ...payload,
  });
}

/* An auto-uploads list has no usable title ("Playlist" / "Top songs"). Name it
   after whatever its tracks share: the film or album in their titles, else the
   dominant artist credit — e.g. the ten Bethlehem Kudumba Unit songs show as
   "Bethlehem Kudumba Unit". */
const FILM_TAG_RE = /\(\s*From\s+["\u201c\u300c\uff02]([^"\u201d\u300d\uff03]+)["\u201d\u300d\uff03]/i;
async function uploadsListName(listId: string, hl: string, gl: string): Promise<string> {
  try {
    const data = await ytBrowse('https://music.youtube.com', hl, gl, { browseId: 'VL' + listId });
    const tracks: YtResult[] = [];
    collectPlaylistItems(data, tracks, 60);
    if (!tracks.length) return '';
    const films = new Map<string, number>();
    const albums = new Map<string, number>();
    const artists = new Map<string, number>();
    for (const t of tracks) {
      const f = FILM_TAG_RE.exec(t.title || '');
      if (f) films.set(f[1].trim(), (films.get(f[1].trim()) || 0) + 1);
      const album = (t.sub || '').split('\u2022')[1]?.trim();
      if (album) albums.set(album, (albums.get(album) || 0) + 1);
      const who = (t.sub || '').split('\u2022')[0].split(',')[0].trim();
      if (who) artists.set(who, (artists.get(who) || 0) + 1);
    }
    const best = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    /* shared film/album wins over the artist (a soundtrack list is one film) */
    return best(films) || best(albums) || best(artists);
  } catch {
    return '';
  }
}

async function ytExpandList(listId: string, hl: string, gl: string, maxPages = EXPAND_MAX_PAGES): Promise<Record<string, any>> {
  const isAlbum = /^MPRE/i.test(listId);
  const browseId = isAlbum ? listId : 'VL' + listId;
  const tracks: YtResult[] = [];
  let title = '';
  let cont = '';
  try {
    const data = await ytBrowse('https://music.youtube.com', hl, gl, { browseId });
    collectPlaylistItems(data, tracks, EXPAND_MAX_TRACKS);
    const mf = data?.microformat?.microformatDataRenderer;
    title =
      (typeof mf?.title === 'string' && mf.title.trim()) ||
      findHeaderTitle(data?.header || {});
    cont = findContinuation(data) || '';
  } catch (e) {
    return { type: isAlbum ? 'album' : 'playlist', title: '', tracks: [], error: (e as Error).message };
  }
  /* YouTube intermittently serves a partial first page (10 → 5) with no
     continuation token, which silently under-reports the playlist. One retry
     costs a single browse and merges whatever the second pass returns. */
  if (tracks.length < 10 && !cont) {
    try {
      const again = await ytBrowse('https://music.youtube.com', hl, gl, { browseId });
      const before = tracks.length;
      collectPlaylistItems(again, tracks, EXPAND_MAX_TRACKS);
      if (tracks.length > before) cont = findContinuation(again) || '';
    } catch { /* keep what we have */ }
  }
  /* follow the playlist's own pages — one extra page used to cap every
     playlist at ~70 tracks */
  for (let page = 0; cont && page < maxPages && tracks.length < EXPAND_MAX_TRACKS; page++) {
    try {
      const more = await ytBrowse('https://music.youtube.com', hl, gl, { continuation: cont });
      const before = tracks.length;
      collectPlaylistItems(more, tracks, EXPAND_MAX_TRACKS);
      if (tracks.length === before) break;
      cont = findContinuation(more) || '';
    } catch {
      break;
    }
  }
  return {
    type: isAlbum ? 'album' : 'playlist',
    title: title || (isAlbum ? 'Album' : 'Playlist'),
    tracks: tracks.slice(0, EXPAND_MAX_TRACKS),
    truncated: !!cont,
  };
}

/* ---------- full artist catalogue ----------
   "+ all by artist" used to page through YT Music *search* results, which caps
   at ~20 rows and whose continuation tokens return nothing new — so a 250-track
   artist looked like a 20-track one.

   Three sources per channel, because no single one is complete:
     1. uploads      "VL" + OLAK…  (the channel's auto-uploads playlist)
     2. albums       MPRE… tiles on the channel home (canonical album tracks)
     3. playlists    VLPL… tiles titled "<Artist> - <Album>" (per-album lists)
   Tracks are credit-filtered to the artist, then collapsed by title so the
   album cut wins over the remix/live/radio-edit uploads of the same song. */
const ARTIST_MAX_TRACKS = 500;   // returned to the client
const ARTIST_CRAWL_CAP = 900;    // hard stop while paging
const ARTIST_MAX_PAGES = 4;      // upload continuation rounds per channel
const ARTIST_MAX_CHANNELS = 2;   // channels swept (uploads + catalogue)
const ARTIST_MAX_ALBUMS = 14;    // album tiles expanded per channel
const ARTIST_MAX_LISTS = 8;      // "<Artist> - …" playlist tiles expanded
const ARTIST_MAX_GENERIC_LISTS = 8; // assorted compilations (Motown-era cuts live here)
const ARTIST_MAX_FEATURED = 6;    // "Featured on" auto-playlists around the artist
const ARTIST_FETCH_CONCURRENCY = 5;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const ARTIST_TTL_MS = 60 * 60 * 1000;
const ARTIST_CACHE_V = '12'; // bump when the harvested payload shape changes
const artistMem = new Map<string, { at: number; data: any }>();

const normName = (s: string): string =>
  (s || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\.\s*/g, '.') // "A. R." === "AR"
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();

/* Collapse the "(Live)", "- Radio Edit", "(Remastered 2011)" style variants so
   one song queued once — the same title in different flavours is one song. */
const stripVariant = (s: string): string => {
  let out = (s || '').toLowerCase();
  /* repeat: "(From Delta Force Game) (feat. Sofia Reyes)" needs two passes */
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/\s*[-\u2013\u2014]\s*(radio edit|edit|mix|remix|live|remastered|version|mono|stereo)\b.*$/g, '')
      .replace(/\s*[(\[][^)\]]*\b(live|remix|edit|version|remastered|immortal|mono|stereo|acoustic|instrumental|radio)\b[^)\]]*[)\]]\s*$/g, '')
      .replace(/\s*[(\[][^)\]]{0,40}[)\]]\s*$/g, '');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/[\s\-\u2013\u2014_.,'"]+/g, ' ')
    .trim();
};

/* "(Remastered Radio Edit)", "(Immortal Version)", "(Lyric Video)" … — the same
   song in another flavour. The plain title is the one to keep. */
const VARIANT_RE =
  /\b(remix|remixed|edit|mix|live|immortal|version|radio|acoustic|instrumental|rework|bootleg|megamix|extended|mono|stereo|cover|demo|unplugged|visualizer)\b|\blyric\s*video\b|\bofficial\s+(music\s+)?video\b|\baudio\s+only\b|\b(4k|hd|hq)\b/i;
/* Channel uploads are often titled "<Artist> - <Song>"; the album tiles use the
   bare title, so both must reduce to one key or the song ships twice. */
function stripArtistPrefix(title: string, q: string): string {
  const t = (title || '').trim();
  const m = /^[^–—:]{2,44}?\s*[-–—:]\s*(\S.*)$/.exec(t);
  if (!m) return t;
  const head = normName(m[0].slice(0, m[0].length - m[1].length - 1));
  const want = normName(q);
  if (!head || !want || !m[1].trim()) return t;
  if (!(head.includes(want) || want.includes(head))) return t;
  const rest = m[1].trim();
  /* a cut that leaves unbalanced brackets means the split landed mid-title */
  const opens = (rest.match(/[(\[]/g) || []).length;
  const closes = (rest.match(/[)\]]/g) || []).length;
  if (opens !== closes || rest.length < 3) return t;
  return rest;
}

/* Not a song at all: medleys, mashups, intros, plus the promo clutter every
   artist channel carries — trailers, BTS, ASMR, interviews, event streams. */
const JUNK_TITLE_RE =
  /\s\/\s|\bmedley\b|\bmashup\b|\bmegamix\b|\bmixtape\b|\binterlude\b|\bintro\b|\bsegment\b|\binterview\b|\bspeech\b|\bbts\b|behind[\s-]the[\s-]scenes|\btrailer\b|\bteaser\b|\basmr\b|\bpodcast\b|\bvlog\b|\bdocumentary\b|\bmaking\s+of\b|\breaction\b|\bsneak\s+peek\b|\bfirst\s+look\b|\bpress\s+conference\b|\bshort\s+film\b|\baudio\s+description\b|\bpreview\b|\bsnippet\b|\bexcerpt\b|\bsample\b|\(poem\)|\bpoem\b|\bspoken\s+word\b|\bpoetry\b|\b audiobook\b|\bvisuali[sz]ation\b|\bgameplay\b|\blive\s+set\b|\bfull\s+(set|show|experience|concert)\b|\bawards?\b|\bgrammy\b|\btakeover\b|\blive\s+at\b|\blivestream\b|\bmulticam\b|\bgame\s+play\b|\b(bgmi|pubg\w*|fortnite|minecraft)\b/i;
/* two songs welded into one upload: "X & Y", "X / Y", '"X" and "Y"' */

/* Channel browseIds mentioned anywhere in a YT Music search response, most
   relevant first (top results appear first in the payload). */
function channelIdsFromSearch(data: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  (function walk(node: any) {
    if (!node || typeof node !== 'object' || seen.size > 40) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (typeof v === 'string' && CHANNEL_ID_RE.test(v)) {
        if (!seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  })(data);
  return out;
}

/* Everything the channel home browse tells us: uploads playlist, album tiles,
   playlist tiles. */
function channelCatalogue(data: any) {
  let uploads: string | null = null;
  const albums: { id: string; title: string }[] = [];
  const lists: { id: string; title: string }[] = [];
  const featured: { id: string; title: string }[] = [];
  (function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (typeof v === 'string' && /^OLAK[A-Za-z0-9_-]+$/.test(v)) {
        uploads = uploads || v;
      } else if (k === 'musicTwoRowItemRenderer' && v?.navigationEndpoint?.browseEndpoint?.browseId) {
        const id = v.navigationEndpoint.browseEndpoint.browseId;
        const title = runsText(v.title);
        if (/^MPRE/.test(id)) albums.push({ id, title });
        else if (/^VLPL/.test(id)) lists.push({ id, title });
        else if (/RDCLAK/.test(id)) featured.push({ id, title }); // "Featured on" auto-playlists
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  })(data);
  return { uploads, albums, lists, featured };
}

function channelTitle(data: any): string {
  const mf = data?.microformat?.microformatDataRenderer;
  if (typeof mf?.title === 'string' && mf.title.trim()) return mf.title.trim();
  return findHeaderTitle(data?.header || {});
}

function collectSongItems(node: any, out: YtResult[], cap: number): void {
  if (!node || typeof node !== 'object' || out.length >= cap) return;
  if (Array.isArray(node)) {
    for (const x of node) collectSongItems(x, out, cap);
    return;
  }
  const r = node.musicResponsiveListItemRenderer;
  if (r) {
    const videoId = r?.playlistItemData?.videoId;
    if (videoId && !out.some((x) => x.videoId === videoId)) {
      const cols = (r.flexColumns || []).map((f: any) =>
        runsText(f?.musicResponsiveListItemFlexColumnRenderer?.text),
      );
      const dur =
        r?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ??
        r?.lengthText?.runs?.[0]?.text ??
        null;
      out.push({
        videoId,
        title: (cols[0] || '').trim(),
        sub: (cols[1] || '').trim(),
        extra: '',
        duration: typeof dur === 'string' ? dur.trim() : null,
        thumbnail: r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url ?? null,
        isLive: false,
      });
    }
    return;
  }
  for (const k of Object.keys(node)) collectSongItems(node[k], out, cap);
}

/* Does this upload actually belong to the artist we asked for? Channel
   catalogues include compilations and collabs, so match on the primary artist
   credit, with a looser title/credit pass as a fallback. */
function byArtist(track: YtResult, want: string): boolean {
  const primary = normName(track.sub.split('•')[0].split(',')[0]);
  if (primary === want) return true;
  const all = normName(track.sub);
  if (all.includes(want)) return true;
  return normName(track.title).includes(want);
}

async function ytBrowseItems(
  listId: string,
  hl: string,
  gl: string,
  pages: number,
  cap: number,
): Promise<YtResult[]> {
  const out: YtResult[] = [];
  const first = await ytBrowse('https://music.youtube.com', hl, gl, { browseId: listId });
  collectSongItems(first, out, cap);
  let cont = findContinuation(first);
  for (let p = 0; cont && p < pages && out.length < cap; p++) {
    const more = await ytBrowse('https://music.youtube.com', hl, gl, { continuation: cont });
    const before = out.length;
    collectSongItems(more, out, cap);
    cont = out.length > before ? findContinuation(more) : null; // no new rows → stop
  }
  return out;
}

async function ytArtistSongs(q: string, hl: string, gl: string) {
  const want = normName(q);
  const searchData = await ytPost(
    'https://music.youtube.com/youtubei/v1/search?prettyPrint=false',
    'https://music.youtube.com',
    { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250915.01.00', hl, gl } }, query: q },
  );
  const channels = channelIdsFromSearch(searchData);
  if (!channels.length) return { artist: q, channels: [], tracks: [], dupes: 0, truncated: false };

  interface Sweep {
    title: string;
    exact: boolean;
    tracks: YtResult[];
  }
  const sweeps: Sweep[] = [];

  for (const ch of channels) {
    if (sweeps.length >= ARTIST_MAX_CHANNELS) break;
    let head: any;
    try {
      head = await ytBrowse('https://music.youtube.com', hl, gl, { browseId: ch });
    } catch {
      continue;
    }
    const cat = channelCatalogue(head);
    if (!cat.uploads && !cat.albums.length) continue;
    const title = channelTitle(head);
    const exact = normName(title) === want;
    /* Albums/playlists cost ~1 subrequest each, so only the best channel gets
       the full catalogue sweep; any further channel is uploads-only. */
    const deep = sweeps.length === 0;
    const tracks: YtResult[] = [];

    /* 1. every upload on the channel */
    if (cat.uploads) {
      try {
        tracks.push(...(await ytBrowseItems('VL' + cat.uploads, hl, gl, ARTIST_MAX_PAGES, ARTIST_CRAWL_CAP)));
      } catch { /* keep what we have */ }
    }

    const jobs: { id: string; album: string; strict: boolean }[] = [];
    if (deep) {
      /* 2. album tiles — album credit plus the deep cuts that were never
         uploaded as videos */
      for (const a of cat.albums.slice(0, ARTIST_MAX_ALBUMS)) jobs.push({ id: a.id, album: a.title, strict: false });
      /* 3. playlists the artist published as "<Artist> - <Album>" */
      for (const l of cat.lists) {
        if (jobs.length >= ARTIST_MAX_ALBUMS + ARTIST_MAX_LISTS) break;
        if (!normName(l.title).startsWith(want + ' ')) continue;
        jobs.push({
          id: l.id,
          album: l.title.replace(new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–—]\\s*', 'i'), ''),
          strict: true,
        });
      }
      /* 4. assorted compilations the channel appears on — the only place some
         early-career tracks exist at all (credit filter keeps other artists out) */
      /* lists that name the artist ("The Best of Michael Jackson") hold early
         catalogue; decade-mix compilations are the weakest source, so they go last */
      const generic = cat.lists
        .filter((l) => !normName(l.title).startsWith(want + ' '))
        .sort((a, b) => Number(normName(b.title).includes(want)) - Number(normName(a.title).includes(want)))
        .slice(0, ARTIST_MAX_GENERIC_LISTS);
      for (const l of generic) jobs.push({ id: l.id, album: '', strict: true });
      /* 5. "Featured on" — YT's own playlists that include the artist; these
         reach singles that never made it onto the channel page */
      for (const f of cat.featured
        .sort((a, b) => Number(normName(b.title).includes(want)) - Number(normName(a.title).includes(want)))
        .slice(0, ARTIST_MAX_FEATURED)) {
        jobs.push({ id: f.id, album: '', strict: true });
      }
    }

    for (let i = 0; i < jobs.length; i += ARTIST_FETCH_CONCURRENCY) {
      const slice = jobs.slice(i, i + ARTIST_FETCH_CONCURRENCY);
      const got = await Promise.all(
        slice.map(async (job) => {
          try {
            return (await ytBrowseItems(job.id, hl, gl, 1, ARTIST_CRAWL_CAP)).map((t) => {
              /* Album rows sometimes omit the credits column; the channel we
                 harvested from is the artist, so fill it in rather than
                 letting "Unknown Artist" reach manifest.json. Keep the album
                 name in the sub line — the admin splits on "•" for metadata. */
              const credits = t.sub.split('•')[0].trim();
              let sub = credits || q;
              if (job.album && !sub.includes('•')) sub += ' • ' + job.album;
              return { ...t, sub, _album: job.album, _strict: job.strict };
            });
          } catch {
            return [] as YtResult[];
          }
        }),
      );
      for (const list of got) tracks.push(...list);
      if (tracks.length >= ARTIST_CRAWL_CAP) break;
    }

    sweeps.push({ title, exact, tracks });
    if (exact && tracks.filter((t) => byArtist(t, want)).length >= 200) break; // clearly enough
  }

  /* Credit filter, then collapse same-song variants (album cut beats the
     remix/live upload of the identical title). */
  const best = new Map<string, YtResult>();
  const seenIds = new Set<string>();
  let dupes = 0;
  let junk = 0;
  for (const sweep of sweeps.sort((a, b) => Number(b.exact) - Number(a.exact) || a.title.length - b.title.length)) {
    for (const t of sweep.tracks) {
      if (seenIds.has(t.videoId)) continue;
      seenIds.add(t.videoId);
      const album = (t as any)._album as string | undefined;
      const strict = (t as any)._strict === true;
      /* canonical album on the artist's own channel → its whole tracklist is
         theirs (guest features keep their own credits); compilations and
         uploads must credit the artist explicitly */
      const ok = byArtist(t, want) || (sweep.exact && !!album && !strict);
      if (!ok) continue;
      /* medleys / mashups / intros and channel promo clutter are not tracks
         anybody queued */
      const title = stripArtistPrefix(t.title, q);
      if (JUNK_TITLE_RE.test(title) || (/\s&\s|\s\/\s|["'][^"']+["']\s*(and|&|\/|,)\s*["'][^"']+["']/i.test(title) && title.length > 22)) {
        junk++;
        continue;
      }
      /* Key on the song, not the credit string: the same track shows up as
         "Michael Jackson & The Jacksons" on one release and "The Jacksons" on
         another, and that is still one song. */
      const track = title === t.title ? t : { ...t, title };
      const key = stripVariant(title);
      const prev = best.get(key);
      if (!prev) {
        best.set(key, track);
        continue;
      }
      dupes++;
      /* One song, one row: the plain studio title beats every remix/live/edit
         cut, a canonical album cut beats a compilation, and only when nothing
         better exists does a variant survive. */
      const score = (x: YtResult) => {
        let s = 0;
        if (!VARIANT_RE.test(x.title)) s += 4;
        if (normName(x.sub.split('•')[0]).includes(want)) s += 1; // credit the search
        if ((x as any)._album) s += 2;
        if (!/live/i.test(x.title)) s += 1;
        if (x.duration) s += 0.5;
        return s;
      };
      if (score(track) > score(prev)) best.set(key, track);
    }
  }

  const tracks = [...best.values()].slice(0, ARTIST_MAX_TRACKS);
  return {
    artist: q,
    channels: sweeps.map((s) => s.title).filter(Boolean),
    tracks,
    dupes,
    junk,
    truncated: best.size > ARTIST_MAX_TRACKS,
  };
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
          await (caches as any).default.put(cacheKey, cacheRes);
        } catch { /* caching is best-effort */ }
        return json({ results });
      }

      case 'library': {
        const files = await bucketTree();
        const manifest = await hfManifest(env);
        return json({
          files,
          videoIds: [...uploadedVideoIds(files)],
          bucketId: hfBucketId(env),
          manifest,
        });
      }

      /* ----- bucket management (F6): rename & delete are direct batch
         mutations; cover art uploads new bytes → manage-music.yml ----- */

      case 'bucketDelete': {
        const path = String(body.path || '');
        assertSafePath(path);
        if (!AUDIO_EXT_RE.test(path)) return json({ error: 'only audio files can be deleted' }, 400);
        const files = await bucketTree(true);
        const stem = path.replace(/\.[^.]+$/, '');
        const group = files.filter((f) => f.path.replace(/\.[^.]+$/, '') === stem);
        if (!group.some((f) => f.path === path)) return json({ error: 'not found in the bucket' }, 404);
        await hfBatch(env, group.map((f) => ({ type: 'deleteFile', path: f.path })));
        await invalidateTree();
        return json({ ok: true, deleted: group.map((f) => f.path) });
      }

      case 'bucketRename': {
        const from = String(body.from || '');
        const to = String(body.to || '');
        assertSafePath(from);
        assertSafePath(to);
        if (!AUDIO_EXT_RE.test(from)) return json({ error: 'source must be an audio file' }, 400);
        if (!AUDIO_EXT_RE.test(to)) return json({ error: 'new name must keep an audio extension (.opus/.mp3/…)' }, 400);
        if (from === to) return json({ ok: true, renamed: [] });
        const files = await bucketTree(true);
        const srcGroup = files.filter((f) => f.path.replace(/\.[^.]+$/, '') === from.replace(/\.[^.]+$/, ''));
        if (!srcGroup.some((f) => f.path === from)) return json({ error: 'not found in the bucket' }, 404);
        const toStem = to.replace(/\.[^.]+$/, '');
        const planned = srcGroup.map((f) => toStem + f.path.slice(from.replace(/\.[^.]+$/, '').length));
        if (files.some((f) => planned.includes(f.path))) {
          return json({ error: 'a file with the new name already exists' }, 409);
        }
        const ops: Record<string, unknown>[] = [];
        for (let i = 0; i < srcGroup.length; i++) {
          const f = srcGroup[i];
          if (!f.xetHash || !Date.parse(f.mtime)) {
            throw new Error('bucket listing is missing copy metadata for ' + f.path);
          }
          ops.push({
            type: 'copyFile',
            path: planned[i],
            xetHash: f.xetHash,
            mtime: Date.parse(f.mtime),
            sourceRepoType: 'bucket',
            sourceRepoId: hfBucketId(env),
          });
        }
        for (const f of srcGroup) ops.push({ type: 'deleteFile', path: f.path });
        await hfBatch(env, ops);
        await invalidateTree();
        return json({ ok: true, renamed: planned });
      }

      case 'bucketCover': {
        const path = String(body.path || '');
        assertSafePath(path);
        if (!AUDIO_EXT_RE.test(path)) return json({ error: 'cover applies to audio files' }, 400);
        const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
        if (!m) return json({ error: 'expected a data:image/…;base64 payload' }, 400);
        if (m[2].length > MAX_COVER_B64) return json({ error: 'cover image too large (max 1.5 MB)' }, 400);
        const stem = path.replace(/\.[^.]+$/, '');
        const files = await bucketTree();
        if (!files.some((f) => f.path === path)) return json({ error: 'not found in the bucket' }, 404);
        /* keep the existing cover extension so the site keeps resolving it */
        const existing = files.find((f) => f.path.replace(/\.[^.]+$/, '') === stem && IMAGE_EXT_RE.test(f.path));
        const target = existing ? existing.path : stem + '.webp';
        const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
        const stagedName = `cover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const stagedPath = `${STAGING_DIR}/${stagedName}`;
        try {
          await gh(env, `/repos/${REPO}/contents/${stagedPath}`, {
            method: 'PUT',
            body: JSON.stringify({
              message: `chore: stage cover for ${path}`,
              content: m[2],
              branch: 'main',
            }),
          });
        } catch (e) {
          throw new Error('could not stage the cover image in the repo — ' + (e as Error).message);
        }
        try {
          await gh(env, `/repos/${REPO}/actions/workflows/${MANAGE_WORKFLOW_FILE}/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
              ref: 'main',
              inputs: { op: 'cover', staged_path: stagedPath, target_path: target },
            }),
          });
        } catch (e) {
          await cleanupStaged(env, stagedPath); // best-effort — don't leave junk in the repo
          throw e;
        }
        return json({ ok: true, dispatched: true, target, staged: stagedPath });
      }

      /* ----- edit manifest.json metadata (title/artist/album for the site).
         The batch endpoint can't write new bytes, so the mutated manifest is
         staged in the repo and pushed by manage-music.yml — same pattern as
         cover art, ~1 min to appear. ----- */
      case 'bucketManifestSet': {
        const vid = String(body.id || '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return json({ error: 'bad video ID' }, 400);
        const fields: Record<string, unknown> = {};
        for (const [src, dst] of [['title', 't'], ['artist', 'a'], ['album', 'al']] as const) {
          const v = String((body as any)[src] ?? '').trim().slice(0, 200);
          if (v) fields[dst] = v;
        }
        if (!Object.keys(fields).length) return json({ error: 'nothing to update' }, 400);
        const tracks = await hfManifest(env);
        const existing = tracks[vid];
        if (!existing) {
          return json({ error: 'not in manifest yet — its metadata arrives with the next download run for this track' }, 404);
        }
        const manifest = { v: 1, tracks: { ...tracks, [vid]: { ...existing, ...fields } } };
        const stagedPath = `${STAGING_DIR}/manifest-${Date.now().toString(36)}.json`;
        try {
          await gh(env, `/repos/${REPO}/contents/${stagedPath}`, {
            method: 'PUT',
            body: JSON.stringify({
              message: `chore: stage manifest metadata for ${vid}`,
              content: toB64Utf8(JSON.stringify(manifest, null, 1)),
              branch: 'main',
            }),
          });
        } catch (e) {
          throw new Error('could not stage the manifest in the repo — ' + (e as Error).message);
        }
        try {
          await gh(env, `/repos/${REPO}/actions/workflows/${MANAGE_WORKFLOW_FILE}/dispatches`, {
            method: 'POST',
            body: JSON.stringify({
              ref: 'main',
              inputs: { op: 'manifest', staged_path: stagedPath, target_path: 'manifest.json' },
            }),
          });
        } catch (e) {
          await cleanupStaged(env, stagedPath);
          throw e;
        }
        return json({ ok: true, dispatched: true, target: 'manifest.json' });
      }

      case 'expand': {
        const raw = String(body.url || body.listId || '').trim();
        const listMatch = /[?&]list=([A-Za-z0-9_-]{6,64})/.exec(raw);
        const listId = listMatch ? listMatch[1] : LIST_ID_RE.test(raw) ? raw : '';
        if (!listId) return json({ error: 'no playlist/album ID in that link' }, 400);
        if (/^RD/.test(listId)) {
          return json({ error: 'auto-generated mixes can’t be expanded — queue the tracks individually' }, 400);
        }
        const hl = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(body.hl || '')) ? String(body.hl) : 'en';
        const gl = /^[A-Z]{2}$/.test(String(body.gl || '')) ? String(body.gl) : 'US';
        let expanded_listName = '';
        /* Queue exactly what the link contains. An "OLAK…" uploads list can be a
           soundtrack, a single's worth of tracks or a whole catalogue — guessing
           "the artist" from it and sweeping their channel dumped 200 unrelated
           songs on someone who wanted a film's10 tracks. Only the naming is
           improved, so the queue shows something meaningful. */
        if (/^OLAK/.test(listId)) expanded_listName = await uploadsListName(listId, hl, gl);
        const expanded = await ytExpandList(listId, hl, gl);
        if (!expanded.tracks.length) {
          return json({ error: expanded.error || 'no tracks found in that playlist/album' }, 404);
        }
        /* uploads lists carry useless titles ("Playlist", "Top songs") —
           prefer the name derived from the tracks themselves */
        if (expanded_listName) {
          expanded.title = expanded_listName;
          expanded.type = 'playlist';
        }
        return json(expanded);
      }

      case 'artist': {
        const raw = String(body.q || body.artist || '').trim().slice(0, 120);
        if (!raw) return json({ error: 'empty artist name' }, 400);
        const hl = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(body.hl || '')) ? String(body.hl) : 'en';
        const gl = /^[A-Z]{2}$/.test(String(body.gl || '')) ? String(body.gl) : 'US';
        const memKey = hl + '|' + gl + '|' + normName(raw);

        const memHit = artistMem.get(memKey);
        if (memHit && Date.now() - memHit.at < ARTIST_TTL_MS) return json({ ...memHit.data, cached: 'mem' });

        const cacheKey = new Request(
          'https://aura-search.internal/ytartist?' + new URLSearchParams({ v: ARTIST_CACHE_V, hl, gl, q: normName(raw) }),
        );
        try {
          const hit = await (caches as any).default.match(cacheKey);
          if (hit) {
            const data = await hit.json();
            if (Array.isArray(data?.tracks)) {
              artistMem.set(memKey, { at: Date.now(), data });
              return json({ ...data, cached: 'edge' });
            }
          }
        } catch { /* cache unavailable — fetch fresh */ }

        let data: any;
        try {
          data = await ytArtistSongs(raw, hl, gl);
        } catch (e) {
          return json({ error: 'artist lookup failed — ' + (e as Error).message }, 502);
        }
        artistMem.set(memKey, { at: Date.now(), data });
        if (artistMem.size > 40) {
          const oldest = artistMem.keys().next().value;
          if (oldest !== undefined) artistMem.delete(oldest);
        }
        if (data.tracks.length) {
          try {
            const cacheRes = new Response(JSON.stringify(data), {
              headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
            });
            /* awaited, not waitUntil: Pages Functions doesn't always run
               waitUntil work, and a lost put means no cross-isolate cache */
            await (caches as any).default.put(cacheKey, cacheRes);
          } catch { /* caching is best-effort */ }
        }
        return json(data);
      }

      case 'dispatch': {
        const urls: unknown = body.urls;
        if (!Array.isArray(urls) || !urls.length) return json({ error: 'no URLs given' }, 400);
        if (urls.length > CHAIN_MAX_URLS) return json({ error: 'max ' + CHAIN_MAX_URLS + ' tracks per download' }, 400);
        for (const u of urls) {
          if (typeof u !== 'string' || !YT_RE.test(u)) return json({ error: 'invalid YouTube URL in list' }, 400);
        }

        /* Dedupe hard: same video twice in one batch, or already in the
           bucket, never reaches a runner. A failed listing must not block
           downloads — the filter is best-effort. */
        let uploaded = new Set<string>();
        try {
          uploaded = uploadedVideoIds(await bucketTree());
        } catch { /* tree unavailable — dispatch anyway */ }
        const seen = new Set<string>();
        const keep: string[] = [];
        let skippedDup = 0;
        let skippedUploaded = 0;
        for (const u of urls as string[]) {
          const id = ytIdOf(u);
          if (!id || seen.has(id)) {
            skippedDup++;
            continue;
          }
          seen.add(id);
          if (uploaded.has(id)) {
            skippedUploaded++;
            continue;
          }
          keep.push(u);
        }
        const skipped = skippedDup + skippedUploaded;
        if (!keep.length) {
          return json({ ok: true, dispatched: 0, skipped, skippedUploaded });
        }
        /* Clean metadata (title/artist/album from search results) rides along
           for manifest.json. This run gets the first batch; the rest travels
           as more_urls/more_meta and is split by the next run in the chain. */
        const cleanMeta = (list: string[]) => {
          const ids = new Set(list.map((u) => ytIdOf(u)));
          return (Array.isArray(body.meta) ? body.meta : [])
            .filter((m: any) => m && typeof m.id === 'string' && ids.has(m.id))
            .map((m: any) => ({
              id: String(m.id),
              title: String(m.title || '').slice(0, 200),
              artist: String(m.artist || '').slice(0, 200),
              album: String(m.album || '').slice(0, 200),
            }));
        };
        const firstBatch = keep.slice(0, MAX_URLS);
        const rest = keep.slice(MAX_URLS);
        const metaInput = JSON.stringify(cleanMeta(firstBatch));
        const moreUrls = rest.join('\n');
        const moreMeta = JSON.stringify(cleanMeta(rest));
        /* The workflow shares one concurrency group and GitHub keeps only a
           single *pending* run in a group — dispatching a second batch while
           one waits silently cancels it. Refuse instead, so the client can
           queue batches one at a time. */
        try {
          const recent = await gh<{ workflow_runs: any[] }>(
            env,
            `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`,
          );
          const active = (recent.workflow_runs || []).find(
            (r) => r.status === 'in_progress' || r.status === 'queued',
          );
          if (active) {
            return json(
              {
                error: `run #${active.id} is still ${active.status.replace('_', ' ')} — GitHub cancels queued runs, so wait for it to finish`,
                runId: active.id,
              },
              409,
            );
          }
        } catch { /* status check is best-effort — dispatch anyway */ }

        await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
          method: 'POST',
          body: JSON.stringify({
            ref: 'main',
            inputs: {
              urls: firstBatch.join('\n'),
              meta: metaInput,
              more_urls: moreUrls,
              more_meta: moreMeta,
            },
          }),
        });

        /* best-effort: hand the caller the new run id so it can wait on it */
        let runId = 0;
        try {
          const fresh = await gh<{ workflow_runs: any[] }>(
            env,
            `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`,
          );
          runId = Number(fresh.workflow_runs?.[0]?.id) || 0;
        } catch { /* polling fallback handles it */ }
        return json({
          ok: true,
          dispatched: firstBatch.length,
          chained: rest.length,
          runs: Math.ceil(keep.length / MAX_URLS),
          skipped,
          skippedUploaded,
          runId,
        });
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
        return json({
          secrets: (data.secrets || []).map((s) => s.name),
          repo: REPO,
          hf: Boolean(env.HF_TOKEN && env.HF_BUCKET_ID),
        });
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

      case 'runJobs': {
        const id = Number(body.run_id);
        if (!Number.isFinite(id) || id <= 0) return json({ error: 'bad run id' }, 400);
        const data = await gh<{ jobs: any[] }>(env, `/repos/${REPO}/actions/runs/${id}/jobs?per_page=20`);
        const jobs = (data.jobs || []).map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          started_at: j.started_at,
          completed_at: j.completed_at,
          steps: (j.steps || []).map((s: any) => ({
            number: s.number,
            name: s.name,
            status: s.status,
            conclusion: s.conclusion,
          })),
        }));
        return json({ jobs });
      }

      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || 'server error' }, 502);
  }
};
