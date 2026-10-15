/* Adapts an HTMLAudioElement to the SyncTarget interface.
 *
 * Deliberately knows nothing about the rest of AURA. In production the element
 * handed in is the app's existing `state.audio`; in development it is a plain
 * element in the test harness. Keeping the coupling at this one seam is what
 * lets the sync engine be exercised without the whole app.
 */

import type { SyncTarget } from './syncEngine';

/** Everything needed to actually play a track. */
export interface ResolvedTrack {
  key: string;
  videoId: string | null;
  url: string;
  title: string;
  artist: string;
  img?: string;
  durationMs?: number;
}

export interface AudioTargetOptions {
  element: HTMLAudioElement;
  /** Turn a broadcast track key into something playable, or null if unknown. */
  resolve: (trackKey: string) => ResolvedTrack | null;
  /** Fired when the loaded track changes, so the UI can follow along. */
  onTrackChanged?: (track: ResolvedTrack) => void;
  /** Fired on any media error. */
  onError?: (message: string) => void;
}

export function createAudioTarget(options: AudioTargetOptions): SyncTarget {
  const { element, resolve, onTrackChanged, onError } = options;
  let currentKey: string | null = null;

  element.addEventListener('error', () => {
    onError?.('that track could not be played');
  });

  return {
    getTrackKey: () => currentKey,

    getPositionMs: () => (Number.isFinite(element.currentTime) ? element.currentTime * 1000 : 0),

    isPlaying: () => !element.paused && !element.ended,

    isBuffering: () => element.readyState < 3,

    async load(trackKey: string): Promise<void> {
      if (currentKey === trackKey && element.readyState >= 1) return;

      const track = resolve(trackKey);
      if (!track) throw new Error(`unknown track ${trackKey}`);

      currentKey = track.key;
      element.src = track.url;
      element.load();

      // Wait for enough metadata to seek. A track that never fires this is
      // treated as a failure so the room does not wait on it forever.
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = window.setTimeout(() => {
          cleanup();
          rejectReady(new Error('track took too long to load'));
        }, 15000);

        const onReady = () => { cleanup(); resolveReady(); };
        const onError = () => { cleanup(); rejectReady(new Error('track failed to load')); };
        function cleanup() {
          window.clearTimeout(timer);
          element.removeEventListener('loadedmetadata', onReady);
          element.removeEventListener('error', onError);
        }
        element.addEventListener('loadedmetadata', onReady);
        element.addEventListener('error', onError);
      });

      onTrackChanged?.(track);
    },

    seek(ms: number): void {
      const seconds = Math.max(0, ms / 1000);
      if (Number.isFinite(element.duration)) {
        element.currentTime = Math.min(seconds, Math.max(0, element.duration - 0.05));
      } else {
        element.currentTime = seconds;
      }
    },

    async play(): Promise<void> {
      // Autoplay policies reject this until the user has interacted. The UI
      // surfaces that as a "tap to listen" prompt rather than an error.
      await element.play();
    },

    pause(): void {
      element.pause();
    },
  };
}