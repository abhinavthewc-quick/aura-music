/* Binds the room sync engine to AURA's real player.
 *
 * The harness plays a synthetic tone. This plays the actual library, and it
 * deliberately goes through the existing `loadSong()` so the normal player UI
 * (title, artist, artwork, seek bar) stays truthful while a room is running.
 * `loadSong()` is used rather than `playSong()` because the latter has side
 * effects — writing to listening history, re-rendering the library — that a
 * room should not trigger on every correction.
 */

import { loadSong } from '../features/player';
import { state, trackKey } from '../core/state';
import { ensureCatalog } from './catalogReady';
import { roomModeActive, setRoomActive } from './roomFlag';
import type { SyncTarget } from './syncEngine';
import type { ResolvedTrack } from './audioTarget';


/** Resolve a broadcast track key to something playable, or null if unavailable. */
export function resolveTrack(key: string): ResolvedTrack | null {
  const song = state.songs.find((s: any) => trackKey(s) === key);
  if (!song) return null;

  // Rooms only ever play tracks that exist in the shared catalogue. Locally
  // added files and YouTube results are invisible to other listeners, so
  // offering them would just produce silence on everyone else's device.
  if (!song.url || song.isLocal || song.isYouTube) return null;

  return {
    key,
    videoId: song.videoId || null,
    url: song.url,
    title: song.title || 'Unknown',
    artist: song.artist || 'Unknown artist',
    img: song.img || '',
    durationMs: song.duration ? song.duration * 1000 : undefined,
  };
}

export function createAppTarget(onError?: (m: string) => void): SyncTarget {
  const audio = state.audio;
  let currentKey: string | null = null;

  return {
    getTrackKey: () => currentKey,

    getPositionMs: () => (Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0),

    isPlaying: () => !audio.paused && !audio.ended,

    isBuffering: () => audio.readyState < 3,

    async load(key: string): Promise<void> {
      if (currentKey === key && audio.readyState >= 1) return;

      // A room can ask for a track before the catalogue has finished loading,
      // so give the fetch a moment before deciding it is unavailable.
      if (!resolveTrack(key)) await ensureCatalog();

      const song = state.songs.find((s: any) => trackKey(s) === key);
      const track = resolveTrack(key);
      if (!song || !track) throw new Error('that track is not in the shared library');

      currentKey = key;
      // Reuse the real loader so the player UI reflects the room.
      const index = state.songs.indexOf(song);
      if (index >= 0) {
        state.currentIndex = index;
        loadSong(index);
      } else {
        audio.src = track.url;
        audio.load();
      }

      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = window.setTimeout(() => {
          cleanup();
          rejectReady(new Error('track took too long to load'));
        }, 20000);
        const onReady = () => { cleanup(); resolveReady(); };
        const onErr = () => { cleanup(); rejectReady(new Error('track failed to load')); };
        function cleanup() {
          window.clearTimeout(timer);
          audio.removeEventListener('loadedmetadata', onReady);
          audio.removeEventListener('error', onErr);
        }
        audio.addEventListener('loadedmetadata', onReady);
        audio.addEventListener('error', onErr);
      });
    },

    seek(ms: number): void {
      const seconds = Math.max(0, ms / 1000);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Math.min(seconds, Math.max(0, audio.duration - 0.05));
      } else {
        audio.currentTime = seconds;
      }
    },

    async play(): Promise<void> {
      await audio.play();
    },

    pause(): void {
      audio.pause();
    },
  };
}
/* Re-exported so the room UI has one obvious import site. */
export { roomModeActive, setRoomActive };
