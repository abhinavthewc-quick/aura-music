import { readCatalogCache } from './catalog';
import { trackKey } from './trackIdentity';
export { trackKey, trackMatchesKey } from './trackIdentity';
import type { PlaybackContext, RepeatMode } from './playback-context';
import { stableTrackRef } from './track-identity';

// Mutable shared store. Every cross-module-reassigned top-level `let` from the
// original single-file app lives here so feature modules can read/write it.
export const AURA_LIKED_KEY='auraLikedSongs_v2';
export const AURA_PLAY_COUNTS_KEY='aura_play_counts_v1';

function readStoredJSON(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function hasStoredId(id: unknown): boolean {
  return typeof id === 'string' ? !!id.trim() : typeof id === 'number' && Number.isFinite(id);
}

const trackTextFields = ['title', 'artist', 'catalogArtist', 'videoId', 'img', 'url', 'hfPath', 'hfUrl'];
function readStoredTracks(key: string): any[] {
  const records = readStoredJSON(key);
  if (!Array.isArray(records)) return [];
  // Ignore only unusable records. Keep optional metadata, original IDs and
  // object references: IndexedDB hydration later fills in local tracks' URLs.
  return records.filter(s => s && typeof s === 'object' && !Array.isArray(s) &&
    (s.id == null || typeof s.id === 'string' || typeof s.id === 'number' && Number.isFinite(s.id)) &&
    trackTextFields.every(key => s[key] == null || typeof s[key] === 'string') &&
    (hasStoredId(s.id) || !!(s.title?.trim() || s.artist?.trim() || s.videoId?.trim())));
}

export const playCountMap: Record<string, number> = (() => {
  const counts: Record<string, number> = Object.create(null);
  const parsed = readStoredJSON(AURA_PLAY_COUNTS_KEY);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counts[key] = value;
    }
  }
  return counts;
})();

export const state = {
  hfSongs: readCatalogCache() as any[],
  addedSongs: readStoredTracks('addedTracks'),
  songs: [] as any[],
  auraLikedHistory: readStoredTracks(AURA_LIKED_KEY),
  recentlyPlayed: readStoredTracks('recentlyPlayed'),
  activeTrack: null as any,
  libraryVersion: 0,
  currentIndex: 0,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'all' as RepeatMode,
  playbackContext: null as PlaybackContext | null,
  audio: document.getElementById('audioPlayer') as HTMLAudioElement,
  auraYTQueueIndex: -1,
  radioIsPlaying: false,
  /* Catalogue fetch state, used to paint skeletons / retry UI instead of a
     misleading "no tracks" empty state during the first network round-trip. */
  catalogLoading: false,
  catalogError: false,
};

// Seed popularity in memory only. Reading corrupt or missing storage must not
// overwrite the original data; recordPlayCount persists on an actual play.
if (Object.keys(playCountMap).length === 0) {
  state.recentlyPlayed.forEach((s: any, idx: number) => {
    if (hasStoredId(s.id)) playCountMap[String(s.id)] = Math.max(1, 10 - idx);
  });
}

export function getPlayCount(s: any): number {
  if (!s) return 0;
  const idKey = String(s.id);
  const tk = trackKey(s);
  return s.isLocal ? (playCountMap[idKey] || 0) : Math.max(playCountMap[idKey] || 0, playCountMap[tk] || 0);
}

export function recordPlayCount(songId: string | number, tKey?: string) {
  const idKey = String(songId);
  playCountMap[idKey] = (playCountMap[idKey] || 0) + 1;
  if (tKey) {
    playCountMap[tKey] = (playCountMap[tKey] || 0) + 1;
  }
  try {
    localStorage.setItem(AURA_PLAY_COUNTS_KEY, JSON.stringify(playCountMap));
  } catch {}
}

export const savedLikeMap: Record<string, boolean> = state.auraLikedHistory.reduce((map, s) => {
  if (hasStoredId(s.id)) map[String(s.id)] = true;
  return map;
}, Object.create(null));
/* Older likes used numeric ids from the hardcoded catalog; match those by
   title+artist too so history survives the move to Hugging Face. */
export let likedKeySet = new Set<string>(
  state.auraLikedHistory.filter((s: any) => !s.isLocal && (s.title || s.artist)).map((x: any) => likeKey(x.title, x.catalogArtist ?? x.artist))
);
export function likeKey(title?: string, artist?: string): string {
  return (title || '') + '|' + (artist || '');
}
function applyFavorites(list: any[]) {
  list.forEach((s: any) => {
    s.favorite = !!savedLikeMap[String(s.id)] || (!s.isLocal && (
      likedKeySet.has(likeKey(s.title, s.catalogArtist ?? s.artist)) || likedKeySet.has(likeKey(s.title, s.artist))
    ));
  });
}

export function rebuildSongs() {
  const current = state.activeTrack || state.songs[state.currentIndex];
  const hadSongs = state.songs.length > 0;
  const seen = new Set<string>();
  const hf: any[] = [];
  for (const s of state.hfSongs) {
    const k = trackKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    hf.push(s);
  }
  const added: any[] = [];
  for (const s of state.addedSongs) {
    const k = s.isLocal ? stableTrackRef(s) : trackKey(s);
    if (seen.has(k)) {
      if (s.favorite) {
        const kept = hf.find((x) => trackKey(x) === k);
        if (kept) kept.favorite = true;
      }
      continue;
    }
    seen.add(k);
    added.push(s);
  }
  // Most played songs at the top, rest downwards
  state.songs = [...hf, ...added].sort((a: any, b: any) => {
    const countA = getPlayCount(a);
    const countB = getPlayCount(b);
    if (countB !== countA) return countB - countA;
    return 0;
  });
  let idx = -1;
  if (current) {
    if (hasStoredId(current.id)) {
      idx = state.songs.findIndex((s: any) => hasStoredId(s.id) && String(s.id) === String(current.id));
    }
    if (idx === -1 && !current.isLocal) idx = state.songs.findIndex((s: any) => !s.isLocal && trackKey(s) === trackKey(current));
    const source = typeof state.audio?.getAttribute === 'function' ? state.audio.getAttribute('src') : state.audio?.src;
    if (idx === -1 && (state.isPlaying || source?.trim())) {
      // A catalogue refresh can remove the loaded (including paused) track.
      // Keep its identity in the derived list while its audio continues, never
      // in hfSongs/addedSongs or storage. A later selection/rebuild drops it.
      // Explicit deletion clears playback and currentIndex before rebuilding.
      idx = state.songs.push(current) - 1;
    }
  }
  // Only an initially empty library gets a default selection. A removed,
  // unloaded track or an explicit reset must not silently select its neighbour.
  state.currentIndex = idx !== -1 ? idx : !hadSongs && state.songs.length ? 0 : -1;
  if (state.activeTrack) state.activeTrack = state.songs[state.currentIndex] || null;
  state.libraryVersion += 1;
  queueMicrotask(() => window.dispatchEvent(new Event('aura:library-changed')));
}
export function setHfTracks(tracks: any[]) {
  state.hfSongs = tracks;
  applyFavorites(state.hfSongs);
  rebuildSongs();
}
applyFavorites(state.hfSongs);
applyFavorites(state.addedSongs);
rebuildSongs();

export const $ = (id: string) => document.getElementById(id);

export function persistLikedHistory(): boolean {
  const history = state.songs.filter((song) => song.favorite).map((song) => ({
    id:song.id,title:song.title,artist:song.artist,catalogArtist:song.catalogArtist,img:song.img||'',videoId:song.videoId||'',
    ...(!song.isLocal ? {url:song.url||''} : {}),isLocal:!!song.isLocal,isYouTube:!!song.isYouTube,
  }));
  try { localStorage.setItem(AURA_LIKED_KEY,JSON.stringify(history)); } catch { return false; }
  state.auraLikedHistory = history;
  likedKeySet = new Set(history.filter((song) => !song.isLocal).map((song) => likeKey(song.title,song.catalogArtist ?? song.artist)));
  return true;
}
