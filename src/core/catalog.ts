/* Dynamic catalog: lists tracks (audio + cover art) from the public
   Hugging Face storage bucket at runtime instead of hardcoding them.
   Result is cached in localStorage so the library paints instantly and
   still works offline; a background refresh keeps it in sync.
   Optional extras (album / year / duration) come from the bucket's
   manifest.json, written by the upload workflow and keyed by video ID. */

export const HF_BUCKET_ID = 'Angelrider/sonora';
const HF_TREE_URL = `https://huggingface.co/api/buckets/${HF_BUCKET_ID}/tree?recursive=true`;
const CACHE_KEY = 'auraHfCatalog_v1';

const AUDIO_RE = /\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$/i;
const COVER_RE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO_ID_SUFFIX_RE = /\s\[[A-Za-z0-9_-]{11}\]$/;
const VIDEO_ID_RE = /\[([A-Za-z0-9_-]{11})\]$/;

export const DEFAULT_COVER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="18" fill="#241a12"/><circle cx="100" cy="100" r="62" fill="#111" stroke="#b98249" stroke-width="3"/><circle cx="100" cy="100" r="16" fill="#b98249"/><path d="M138 52v50.5a20 20 0 1 0 10 17V62z" fill="#e6bd92"/></svg>'
  );

export function hfFileUrl(path: string): string {
  return (
    'https://huggingface.co/buckets/' +
    HF_BUCKET_ID +
    '/resolve/' +
    path.split('/').map(encodeURIComponent).join('/')
  );
}

/* YouTube's auto-generated channels publish as "<Artist> - Topic" — strip the
   suffix so one artist groups as one artist everywhere in the UI. */
export function cleanArtist(name: string): string {
  return name.replace(/\s*-\s*Topic$/i, '').trim() || 'Unknown Artist';
}

/* Drop upload-noise from titles — "(Official Video)", "[Lyrics]", "【MV】",
   fullwidth quotes — while keeping meaningful parts like years, "(From …)"
   credits and "(Remix)". Order matters: specific phrases first. */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/＂/g, '"').replace(/（/g, '(').replace(/）/g, ')');
  const patterns: RegExp[] = [
    /[[(【]\s*official\s+(?:music\s+)?video\s*[\])】]/gi,
    /[[(【]\s*(?:official\s+)?music\s+video\s*[\])】]/gi,
    /[[(【]\s*official\s+audio\s*[\])】]/gi,
    /[[(【]\s*official\s+lyric(?:s)?\s*(?:video)?\s*[\])】]/gi,
    /[[(【]\s*(?:full\s+)?lyric(?:s)?\s*(?:video)?\s*[\])】]/gi,
    /[[(【]\s*official\s+(?:audio\s+)?visuali[sz]er\s*[\])】]/gi,
    /[[(【]\s*visuali[sz]er\s*[\])】]/gi,
    /[[(【]\s*(?:official\s+)?m\s*\/\s*v\s*[\])】]/gi,
    /[[(【]\s*mv\s*[\])】]/gi,
    /[[(【]\s*(?:hd|hq|4k|1080p|720p)\s*[\])】]/gi,
    /【[^】]*official[^】]*】/gi,
    /\s*[-–—]\s*lyric(?:s)?$/i,
    /\s+\blyrics?$/i,
  ];
  for (const re of patterns) t = t.replace(re, ' ');
  return t.replace(/\s{2,}/g, ' ').replace(/\s+[-–—]$/g, '').trim() || raw.trim();
}

export function cleanMeta(artist: string, title: string): { artist: string; title: string } {
  const a = cleanArtist(artist || '');
  return { artist: a || 'Unknown Artist', title: cleanTitle(title || '') };
}

/* The trailing " [dQw4w9WgXcQ]" in bucket filenames IS the YouTube video ID —
   the single dedupe key across search results, pasted links, the queue and
   the already-uploaded library. */
export function extractVideoId(path: string): string {
  const m = VIDEO_ID_RE.exec(path.replace(/\.[^.]+$/, ''));
  return m ? m[1] : '';
}

export function parseTrackName(path: string): { title: string; artist: string } {
  /* "<Artist> - Topic - <Title>" is the auto-generated-channel filename form:
     collapse the middle segment so the first " - " split lands on the artist. */
  const base = path
    .replace(/\.[^.]+$/, '')
    .replace(VIDEO_ID_SUFFIX_RE, '')
    .replace(/\s*-\s*Topic\s*-\s*/i, ' - ');
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  const artist = m ? m[1] : 'Unknown Artist';
  const title = m ? m[2] : base;
  return cleanMeta(artist, title);
}

export function readCatalogCache(): any[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.tracks) ? parsed.tracks : [];
  } catch {
    return [];
  }
}

interface ManifestEntry { t?: string; a?: string; al?: string; y?: string; d?: number; }
type Manifest = { v?: number; tracks?: Record<string, ManifestEntry> };

export async function fetchHfCatalog(): Promise<any[]> {
  const [treeRes, manifestRes] = await Promise.allSettled([fetch(HF_TREE_URL), fetch(hfFileUrl('manifest.json'))]);

  if (treeRes.status !== 'fulfilled') throw treeRes.reason;
  const res = treeRes.value;
  if (!res.ok) throw new Error('bucket listing failed (HTTP ' + res.status + ')');
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('unexpected bucket listing format');

  let manifest: Manifest = {};
  if (manifestRes.status === 'fulfilled' && manifestRes.value.ok) {
    try {
      const data = await manifestRes.value.json();
      if (data && typeof data === 'object') manifest = data as Manifest;
    } catch { /* keep empty — filename parse still works */ }
  }
  const meta: Record<string, ManifestEntry> =
    manifest.tracks && typeof manifest.tracks === 'object' ? manifest.tracks : {};

  const covers = new Map<string, string>(); // basename (lowercase, no ext) -> path
  const audios: { path: string; size: number }[] = [];

  for (const it of items) {
    if (!it || it.type !== 'file' || typeof it.path !== 'string') continue;
    const p: string = it.path;
    if (p === 'manifest.json') continue;
    const ct: string = it.contentType || '';
    if (AUDIO_RE.test(p)) {
      audios.push({ path: p, size: Number(it.size) || 0 });
    } else if (COVER_RE.test(p) || ct.startsWith('image/')) {
      covers.set(p.replace(/\.[^.]+$/, '').toLowerCase(), p);
    }
  }

  const tracks = audios.map((a) => {
    const { title, artist } = parseTrackName(a.path);
    const cover = covers.get(a.path.replace(/\.[^.]+$/, '').toLowerCase());
    const videoId = extractVideoId(a.path);
    const m = videoId ? meta[videoId] : undefined;
    return {
      id: 'hf:' + a.path,
      title: (m?.t || title) || title,
      artist: (m?.a && m.a.trim() ? m.a : artist) || artist,
      album: m?.al || '',
      year: m?.y || '',
      duration: typeof m?.d === 'number' ? m.d : 0,
      videoId,
      url: hfFileUrl(a.path),
      img: cover ? hfFileUrl(cover) : DEFAULT_COVER,
      favorite: false,
      isHf: true,
      size: a.size,
    };
  });

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ tracks, at: Date.now() }));
  } catch {
    /* quota — cache is best-effort */
  }
  return tracks;
}
