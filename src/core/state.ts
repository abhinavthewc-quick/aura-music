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

/* One song = one entry, no matter how it arrived (bucket catalog, manual add,
   YouTube link, local file). Video ID is the strongest identity; otherwise
   title+artist decides. Cross-source duplicates collapse onto the HF entry
   and carry their favorite flag over. */
export function trackKey(s: any): string {
  if (s?.videoId) return 'vid:' + s.videoId;
  return 'lk:' + String(s?.title || '').toLowerCase().trim() + '|' + String(s?.artist || '').toLowerCase().trim();
}

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
    const k = trackKey(s);
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
  state.songs = [...hf, ...added];
  if (current) {
    let idx = state.songs.findIndex((s: any) => String(s.id) === String(current.id));
    if (idx === -1) idx = state.songs.findIndex((s: any) => trackKey(s) === trackKey(current));
    if (idx !== -1) state.currentIndex = idx;
  }
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

export function persistLikedHistory(){
  state.auraLikedHistory = state.songs.filter((s: any) => s.favorite).map((s: any) => ({
    id:s.id,title:s.title,artist:s.artist,img:s.img||'',videoId:s.videoId||'',url:s.url||'',isYouTube:!!s.isYouTube
  }));
  localStorage.setItem(AURA_LIKED_KEY,JSON.stringify(state.auraLikedHistory));
  likedKeySet = new Set<string>(state.auraLikedHistory.map((x: any) => likeKey(x.title, x.artist)));
}
