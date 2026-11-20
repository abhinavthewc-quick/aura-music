export interface TrackSnapshot {
  ref: string;
  legacyKey?: string;
  source?: 'local' | 'catalog' | 'youtube' | 'added';
  title: string;
  artist: string;
  img: string;
  duration: number | string;
}

/** Immutable source identity. Title/artist are display metadata, never a primary key. */
export function stableTrackRef(song: any): string {
  if (/^[A-Za-z0-9_-]{11}$/.test(String(song?.videoId || ''))) return `video:${String(song.videoId)}`;
  return song?.id !== undefined && song?.id !== null ? `id:${String(song.id)}` : '';
}

export function legacyTrackKey(song: any): string {
  if (song?.videoId) return `vid:${song.videoId}`;
  return `lk:${String(song?.title || '').toLowerCase().trim()}|${String(song?.artist || '').toLowerCase().trim()}`;
}

export function safeArtwork(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(raw)) return raw;
  if (/^(?:https?:\/\/|\/[^/]|\.\.?\/)/i.test(raw)) return raw;
  return '';
}

export function snapshotTrack(song: any, legacyKey?: string): TrackSnapshot {
  return {
    ref: stableTrackRef(song), legacyKey,
    source: song?.isLocal ? 'local' : song?.isHf ? 'catalog' : song?.isYouTube ? 'youtube' : 'added',
    title: String(song?.title || 'Untitled').slice(0, 200),
    artist: String(song?.artist || 'Unknown artist').slice(0, 200),
    img: safeArtwork(song?.img),
    duration: typeof song?.duration === 'number' && Number.isFinite(song.duration)
      ? Math.max(0, song.duration) : typeof song?.duration === 'string' ? song.duration.slice(0, 16) : 0,
  };
}

interface TrackLookup { length:number; ids:Map<string,any>; refs:Map<string,any>; legacy:Map<string,any[]>; names:Map<string,any[]> }
const lookups = new WeakMap<any[],TrackLookup>();
function lookup(songs: any[]): TrackLookup {
  const cached = lookups.get(songs);
  if (cached?.length === songs.length) return cached;
  const result: TrackLookup = {length:songs.length,ids:new Map(),refs:new Map(),legacy:new Map(),names:new Map()};
  for (const song of songs) {
    result.ids.set(String(song.id),song); result.refs.set(stableTrackRef(song),song);
    const key = legacyTrackKey(song), name = `${String(song.title || '').toLowerCase().trim()}|${String(song.artist || '').toLowerCase().trim()}`;
    const legacy = result.legacy.get(key), names = result.names.get(name);
    if (legacy) legacy.push(song); else result.legacy.set(key,[song]);
    if (names) names.push(song); else result.names.set(name,[song]);
  }
  lookups.set(songs,result); return result;
}
export function legacyTrackMatches(key: string,songs: any[]): any[] {
  const data = lookup(songs);
  const direct = data.refs.get(key);
  return direct ? [direct] : data.legacy.get(key) || [];
}

export function resolveTrackId(id: string | number, songs: any[]): any | null {
  const data = lookup(songs), raw = String(id);
  return data.ids.get(raw) || data.refs.get(raw) || null;
}

export function resolveTrackSnapshot(ref: TrackSnapshot, songs: any[]): any | null {
  const data = lookup(songs);
  const candidate = data.refs.get(ref.ref) || (ref.ref.startsWith('id:') ? data.ids.get(ref.ref.slice(3)) : null);
  const direct = candidate && (ref.source !== 'local' || candidate.isLocal) ? candidate : null;
  if (direct) return direct;
  // A legacy title alias is not permission to bind a local/video identity to a
  // different recording. This guard must also apply before alias migration.
  if (ref.source === 'local' || /^(id:|video:)/.test(ref.ref)) return null;
  if (ref.legacyKey) {
    const legacyMatches = data.legacy.get(ref.legacyKey) || [];
    if (legacyMatches.length === 1) return legacyMatches[0];
  }
  const title = ref.title.toLowerCase().trim();
  const artist = ref.artist.toLowerCase().trim();
  const candidates = (data.names.get(`${title}|${artist}`) || []).filter((song) => !song.isLocal);
  return title && candidates.length === 1 ? candidates[0] : null;
}

export function trackAvailable(song: any): boolean {
  return !!song && !song.missing && (song.isYouTube ? /^[A-Za-z0-9_-]{11}$/.test(String(song.videoId || '')) : !!song.url);
}
