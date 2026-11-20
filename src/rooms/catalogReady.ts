/* Waits for the shared catalogue to be present, and keeps it fresh.
 *
 * The library is fetched in the background after page load, so a listener who
 * joins a room in the first seconds can legitimately be asked for a track that
 * has not arrived yet. Without this, the room would report "not in your
 * library" for a track that is about to appear.
 *
 * `refreshCatalog()` re-fetches the bucket (bounded by a minimum interval so
 * the focus/visibility poll can't hammer Hugging Face) and notifies
 * subscribers — that is how an open room picks up newly uploaded tracks
 * without reloading.
 */

import { fetchHfCatalog } from '../core/catalog';
import { setHfTracks, state } from '../core/state';

let pending: Promise<void> | null = null;
let deadline = 0;
let lastBucketFetch = 0;
/** Never hit the bucket more often than this while the tab is visible. */
const MIN_FETCH_MS = 15_000;
const listeners = new Set<(tracks: any[]) => void>();

/** True once the catalogue has been fetched (successfully or not). */
export function catalogSettled(): boolean {
  return pending !== null && deadline > 0;
}

/**
 * Resolves when the catalogue is populated, or after a short deadline if it
 * cannot be. Never rejects — a failed catalogue fetch should degrade to "no
 * shared tracks", not break joining a room.
 */
export function ensureCatalog(timeoutMs = 8000): Promise<void> {
  if (state.songs.length > 0) return Promise.resolve();

  if (!pending) {
    pending = fetchHfCatalog()
      .then((tracks) => {
        if (tracks.length) setHfTracks(tracks);
      })
      .catch(() => {
        /* offline, or the bucket listing failed — leave the library as-is */
      })
      .finally(() => {
        deadline = Date.now();
        pending = null;
      });
  }

  const timeout = new Promise<void>((resolve) => {
    window.setTimeout(resolve, timeoutMs);
  });

  return Promise.race([pending, timeout]);
}

/** Re-fetch the bucket and, if it changed, repopulate the shared library.
 * Bounded by MIN_FETCH_MS so polls and focus events can't hammer the bucket.
 * Never rejects. */
export async function refreshCatalog(): Promise<void> {
  if (pending) await pending;

  const now = Date.now();
  if (now - lastBucketFetch < MIN_FETCH_MS && state.songs.length > 0) return;
  lastBucketFetch = now;

  try {
    const tracks = await fetchHfCatalog();
    if (tracks.length) setHfTracks(tracks);
    for (const l of listeners) l(tracks);
  } catch {
    /* offline, or the bucket listing failed — leave the library as-is */
  }
}

/** Subscribe to successful catalogue refreshes. Returns an unsubscriber. */
export function onCatalogRefreshed(listener: (tracks: any[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset between room sessions so a later join re-checks. */
export function resetCatalogWait(): void {
  if (state.songs.length === 0) {
    pending = null;
    deadline = 0;
  }
}
