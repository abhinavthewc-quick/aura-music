/* Waits for the shared catalogue to be present.
 *
 * The library is fetched in the background after page load, so a listener who
 * joins a room in the first seconds can legitimately be asked for a track that
 * has not arrived yet. Without this, the room would report "not in your
 * library" for a track that is about to appear.
 */

import { fetchHfCatalog } from '../core/catalog';
import { setHfTracks, state } from '../core/state';

let pending: Promise<void> | null = null;
let deadline = 0;

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
      });
  }

  const timeout = new Promise<void>((resolve) => {
    window.setTimeout(resolve, timeoutMs);
  });

  return Promise.race([pending, timeout]);
}

/** Reset between room sessions so a later join re-checks. */
export function resetCatalogWait(): void {
  if (state.songs.length === 0) {
    pending = null;
    deadline = 0;
  }
}