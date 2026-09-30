import { readCatalogCache } from './catalog';

// Mutable shared store. Every cross-module-reassigned top-level `let` from the
// original single-file app lives here so feature modules can read/write it.
export const AURA_LIKED_KEY='auraLikedSongs_v2';

export const state = {
  hfSongs: readCatalogCache() as any[],
  addedSongs: JSON.parse(localStorage.getItem('addedTracks')) || [],
  songs: [] as any[],
  auraLikedHistory: JSON.parse(localStorage.getItem(AURA_LIKED_KEY) || '[]'),
  recentlyPlayed: JSON.parse(localStorage.getItem('recentlyPlayed')) || [],
  currentIndex: 0,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'all' as string,
  audio: document.getElementById('audioPlayer') as HTMLAudioElement,
  auraYTQueueIndex: -1,
  radioIsPlaying: false,
};

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
    s.favorite = !!savedLikeMap[String(s.id)] || likedKeySet.has(likeKey(s.title, s.artist));
  });
}
export function rebuildSongs() {
  state.songs = [...state.hfSongs, ...state.addedSongs];
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
applyFavorites(state.songs = [...state.hfSongs, ...state.addedSongs]);

export const $ = (id: string) => document.getElementById(id);

export function persistLikedHistory(){
  state.auraLikedHistory = state.songs.filter((s: any) => s.favorite).map((s: any) => ({
    id:s.id,title:s.title,artist:s.artist,img:s.img||'',videoId:s.videoId||'',url:s.url||'',isYouTube:!!s.isYouTube
  }));
  localStorage.setItem(AURA_LIKED_KEY,JSON.stringify(state.auraLikedHistory));
  likedKeySet = new Set<string>(state.auraLikedHistory.map((x: any) => likeKey(x.title, x.artist)));
}
