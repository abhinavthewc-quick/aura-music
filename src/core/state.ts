import { readCatalogCache } from './catalog';
import type { PlaybackContext, RepeatMode } from './playback-context';
import { legacyTrackKey, stableTrackRef } from './track-identity';
import { readAudioVersionPreference, type AudioVersion } from './audio-versions';

function storedArray(key: string): any[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
  } catch { return []; }
}

// Mutable shared store. Every cross-module-reassigned top-level `let` from the
// original single-file app lives here so feature modules can read/write it.
export const AURA_LIKED_KEY='auraLikedSongs_v2';
export const AURA_PLAY_COUNTS_KEY='aura_play_counts_v1';

export const playCountMap: Record<string, number> = (() => {
  try {
    const raw = localStorage.getItem(AURA_PLAY_COUNTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
})();

export const state = {
  hfSongs: readCatalogCache() as any[],
  addedSongs: storedArray('addedTracks').filter((song) => song.id !== null && song.id !== undefined),
  songs: [] as any[],
  auraLikedHistory: storedArray(AURA_LIKED_KEY),
  recentlyPlayed: storedArray('recentlyPlayed'),
  activeTrack: null as any,
  libraryVersion: 0,
  currentIndex: 0,
  isPlaying: false,
  preferredAudioVersion: readAudioVersionPreference(),
  activeAudioVersion: 'original' as AudioVersion,
  isShuffle: false,
  repeatMode: 'off' as RepeatMode,
  playbackContext: null as PlaybackContext | null,
  audio: document.getElementById('audioPlayer') as HTMLAudioElement,
  radioIsPlaying: false,
  /* Catalogue fetch state, used to paint skeletons / retry UI instead of a
     misleading "no tracks" empty state during the first network round-trip. */
  catalogLoading: false,
  catalogError: false,
};

// Seed play counts from recentlyPlayed if playCountMap is initially empty
try {
  if (Object.keys(playCountMap).length === 0 && Array.isArray(state.recentlyPlayed)) {
    state.recentlyPlayed.forEach((s: any, idx: number) => {
      if (s?.id) {
        playCountMap[String(s.id)] = Math.max(1, 10 - idx);
      }
    });
    localStorage.setItem(AURA_PLAY_COUNTS_KEY, JSON.stringify(playCountMap));
  }
} catch {}

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

export const savedLikeMap = Object.fromEntries(state.auraLikedHistory.map((x: any) => [String(x.id), true]));
/* Older likes used numeric ids from the hardcoded catalog; match those by
   title+artist too so history survives the move to Hugging Face. */
export let likedKeySet = new Set<string>(
  state.auraLikedHistory.map((x: any) => likeKey(x.title, x.artist))
);
export function likeKey(title?: string, artist?: string): string {
  return (title || '') + '|' + (artist || '');
}
function applyFavorites(list: any[]) {
  list.forEach((s: any) => {
    s.favorite = !!savedLikeMap[String(s.id)] || (!s.isLocal && likedKeySet.has(likeKey(s.title, s.artist)));
  });
}

/* One song = one entry, no matter how it arrived (bucket catalog, manual add,
   YouTube link, local file). Video ID is the strongest identity; otherwise
   title+artist decides. Cross-source duplicates collapse onto the HF entry
   and carry their favorite flag over. */
export const trackKey = legacyTrackKey;

export function rebuildSongs() {
  const current = state.songs[state.currentIndex];
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
  if (current) {
    let idx = state.songs.findIndex((s: any) => String(s.id) === String(current.id));
    if (idx === -1) idx = state.songs.findIndex((s: any) => trackKey(s) === trackKey(current));
    const kept = state.songs.findIndex((song) => stableTrackRef(song) === stableTrackRef(current));
    state.currentIndex = kept;
  }
  state.libraryVersion += 1;
  queueMicrotask(() => window.dispatchEvent(new CustomEvent('aura:library-changed')));
}
export function setHfTracks(tracks: any[]) {
  const current = state.songs[state.currentIndex];
  state.hfSongs = tracks;
  applyFavorites(state.hfSongs);
  rebuildSongs();
  if (current) {
    const idx = state.songs.findIndex((s: any) => String(s.id) === String(current.id));
    if (idx !== -1) state.currentIndex = idx;
  }
}
applyFavorites(state.hfSongs);
applyFavorites(state.addedSongs);
rebuildSongs();

export const $ = (id: string) => document.getElementById(id);

export function persistLikedHistory(): boolean {
  const history = state.songs.filter((song) => song.favorite).map((song) => ({
    id:song.id,title:song.title,artist:song.artist,img:song.img||'',videoId:song.videoId||'',isLocal:!!song.isLocal,isYouTube:!!song.isYouTube,
  }));
  try { localStorage.setItem(AURA_LIKED_KEY,JSON.stringify(history)); } catch { return false; }
  state.auraLikedHistory = history;
  likedKeySet = new Set(history.filter((song) => !song.isLocal).map((song) => likeKey(song.title,song.artist)));
  return true;
}
