/* Deep links: /?play=<track id> and /?play=yt:<videoId>.
 *
 * The PreMiD activity points its "Listen in Aura Music" button and the
 * clickable song title here, so pressing them opens the site already playing
 * that exact track instead of just the home screen.
 *
 * Ids are what state.songs uses: "hf:<bucket path>", "youtube-<videoId>",
 * a numeric id for hand-added tracks, or an 11-character YouTube id (matched
 * against a song's videoId).
 */

import { fetchYouTubeMeta } from '../core/dom';
import { state } from '../core/state';
import { playSong, playYouTubeInsideAura } from './player';

let applied = false;

function clearPlayParam(): void {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('play');
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  } catch {
    /* URL API unavailable — leave the address alone. */
  }
}

function playYouTubeDeepLink(videoId: string): void {
  applied = true;
  clearPlayParam();
  const poster = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  fetchYouTubeMeta(videoId).then(({ title }) => {
    playYouTubeInsideAura(videoId, title, poster).catch(() => {
      /* The iframe player reports its own errors. */
    });
  });
}

/**
 * Applies a pending ?play= link. Safe to call repeatedly: it does nothing once
 * a track has been started, and it waits (returns) while the catalog is still
 * loading so app.ts can retry after the remote tracks arrive.
 */
export function applyPlayDeepLink(): void {
  if (applied) return;

  let raw = '';
  try {
    raw = new URLSearchParams(location.search).get('play')?.trim() || '';
  } catch {
    return;
  }
  if (!raw) return;

  const youtube = /^yt:([\w-]{11})$/.exec(raw);
  if (youtube) {
    playYouTubeDeepLink(youtube[1]);
    return;
  }

  const index = state.songs.findIndex(
    (song) => String(song.id) === raw || (song.videoId && String(song.videoId) === raw),
  );
  if (index === -1) return; // catalog may still be fetching — retried later

  applied = true;
  clearPlayParam();
  playSong(index);
}
