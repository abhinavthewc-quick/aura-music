import { defaultSongs } from './config';

// Mutable shared store. Every cross-module-reassigned top-level `let` from the
// original single-file app lives here so feature modules can read/write it.
export const AURA_LIKED_KEY='auraLikedSongs_v2';

export const state = {
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

state.songs = [...defaultSongs, ...state.addedSongs];
export const savedLikeMap = Object.fromEntries(state.auraLikedHistory.map((x: any) => [String(x.id), true]));
state.songs.forEach((s: any) => { s.favorite = !!savedLikeMap[String(s.id)]; });

export const $ = (id: string) => document.getElementById(id);

export function persistLikedHistory(){
  state.auraLikedHistory = state.songs.filter((s: any) => s.favorite).map((s: any) => ({
    id:s.id,title:s.title,artist:s.artist,img:s.img||'',videoId:s.videoId||'',url:s.url||'',isYouTube:!!s.isYouTube
  }));
  localStorage.setItem(AURA_LIKED_KEY,JSON.stringify(state.auraLikedHistory));
}
