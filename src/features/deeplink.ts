/* Deep links: /?play=<track id>, /?play=yt:<videoId>, and /#playlist=<snapshot>.
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
import { getPlaybackIntent } from '../core/playbackIntent';
import { playSong, playYouTubeInsideAura } from './player';
import { decodePlaylistShare, PLAYLIST_SHARE_PREFIX, PlaylistShareError } from '../core/playlist-sharing';
import { openSharedPlaylistPreview } from './playlists';

let applied = false;
let lastPlaylistHash = '';
let pendingTrackIntent: number | null = null;
let linkRevision = 0;

function clearPlayParam(): void {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('play');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch {
    /* URL API unavailable — leave the address alone. */
  }
}

function playYouTubeDeepLink(videoId: string): void {
  applied = true;
  clearPlayParam();
  const intent = getPlaybackIntent();
  const revision = ++linkRevision;
  const poster = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  fetchYouTubeMeta(videoId).then(({ title }) => {
    if (intent !== getPlaybackIntent() || revision !== linkRevision) return;
    playYouTubeInsideAura(videoId, title, poster).catch(() => {
      /* The iframe player reports its own errors. */
    });
  });
}

function applyPlaylistDeepLink(): boolean {
  const hash = location.hash;
  if (!hash.startsWith(PLAYLIST_SHARE_PREFIX) && hash !== '#playlist') return false;
  /* A playlist preview takes priority over a combined ?play= parameter. A
     received snapshot must not start playback or a YouTube metadata request. */
  applied = true;
  clearPlayParam();
  if (hash === lastPlaylistHash) return true;
  lastPlaylistHash = hash;
  linkRevision++;
  try {
    openSharedPlaylistPreview(decodePlaylistShare(hash.slice(PLAYLIST_SHARE_PREFIX.length)));
  } catch (error) {
    openSharedPlaylistPreview(null, error instanceof PlaylistShareError ? error.message : 'Could not open this playlist link. Ask the sender for a new link.');
  }
  return true;
}

/**
 * Applies a received playlist preview or a pending ?play= link. Safe to call repeatedly: it does nothing once
 * a track has been started, and it waits (returns) while the catalog is still
 * loading so app.ts can retry after the remote tracks arrive.
 */
export function applyPlayDeepLink(): void {
  if (applyPlaylistDeepLink()) return;
  if (applied) return;

  let raw = '';
  try {
    raw = new URLSearchParams(location.search).get('play')?.trim() || '';
  } catch {
    return;
  }
  if (!raw) return;
  if (pendingTrackIntent === null) pendingTrackIntent = getPlaybackIntent();
  else if (pendingTrackIntent !== getPlaybackIntent()) {
    // A manual selection supersedes a link that was waiting for the catalogue.
    applied = true;
    clearPlayParam();
    return;
  }

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

/* Also handle a second received link in an already-open music session. The
   fragment survives the existing signed-out gate until bootstrap calls above. */
window.addEventListener('hashchange', () => {
  lastPlaylistHash = '';
  applyPlayDeepLink();
});
