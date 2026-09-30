/* Dynamic catalog: lists tracks (audio + cover art) from the public
   Hugging Face storage bucket at runtime instead of hardcoding them.
   Result is cached in localStorage so the library paints instantly and
   still works offline; a background refresh keeps it in sync. */

export const HF_BUCKET_ID = 'Angelrider/sonora';
const HF_TREE_URL = `https://huggingface.co/api/buckets/${HF_BUCKET_ID}/tree?recursive=true`;
const CACHE_KEY = 'auraHfCatalog_v1';

const AUDIO_RE = /\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$/i;
const COVER_RE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO_ID_SUFFIX_RE = /\s\[[A-Za-z0-9_-]{11}\]$/;

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

export function parseTrackName(path: string): { title: string; artist: string } {
  const base = path.replace(/\.[^.]+$/, '').replace(VIDEO_ID_SUFFIX_RE, '');
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1], title: m[2] } : { artist: 'Unknown Artist', title: base };
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

export async function fetchHfCatalog(): Promise<any[]> {
  const res = await fetch(HF_TREE_URL);
  if (!res.ok) throw new Error('bucket listing failed (HTTP ' + res.status + ')');
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('unexpected bucket listing format');

  const covers = new Map<string, string>(); // basename (lowercase, no ext) -> path
  const audios: { path: string; size: number }[] = [];

  for (const it of items) {
    if (!it || it.type !== 'file' || typeof it.path !== 'string') continue;
    const p: string = it.path;
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
    return {
      id: 'hf:' + a.path,
      title,
      artist,
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
