import { trackKey, trackMatchesKey } from './trackIdentity';
import { resolveTrackSnapshot, type TrackSnapshot } from './track-identity';

/* A link carries a small, versioned snapshot in its fragment. Fragments are
   not sent to the web server. Only display text and library keys cross devices;
   media URLs, local-file names/IDs, artwork and account data never do. */
export const PLAYLIST_SHARE_PREFIX = '#playlist=';
export const MAX_SHARED_TRACKS = 100;
export const MAX_SHARE_BYTES = 16_384;
export const MAX_SHARE_ENCODED_LENGTH = Math.ceil(MAX_SHARE_BYTES * 4 / 3);

export type SharedTrack = { key: string; title: string; artist: string };
export type SharedPlaylist = {
  v: 1;
  title: string;
  description: string;
  tracks: SharedTrack[];
  omitted: { local: number; unavailable: number };
};
export type SharedTrackMatch = {
  track: SharedTrack;
  song: any | null;
  index: number;
  available: boolean;
};

const INVALID_LINK = 'This playlist link is incomplete or invalid. Ask the sender for a new link.';
const TOO_LARGE = 'This playlist is too large for a link. Share a smaller playlist (up to 100 tracks).';

export class PlaylistShareError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validText(value: unknown, max: number, required = false): value is string {
  if (typeof value !== 'string' || value.length > max * 2 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
  const characters = Array.from(value);
  return characters.length <= max && (!required || Boolean(value.trim())) &&
    characters.every((character) => { const code = character.codePointAt(0)!; return code < 0xd800 || code > 0xdfff; });
}

function clipText(value: unknown, max: number): string {
  return Array.from(String(value ?? '').trim()).slice(0, max).join('');
}

export function isSharedTrackKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\t]/.test(value) || !validText(value, 512, true)) return false;
  if (/^vid:[A-Za-z0-9_-]{11}$/.test(value)) return true;
  if (!value.startsWith('lk:') || value !== value.toLowerCase()) return false;
  const separator = value.indexOf('|', 3);
  return separator > 3 && Boolean(value.slice(3, separator).trim());
}

/** Strict allowlist, also used when restoring a locally saved import. No
    coercion of objects, unknown versions, URL fields or oversized arrays. */
export function validateSharedPlaylist(raw: unknown): SharedPlaylist {
  if (!isRecord(raw)) throw new PlaylistShareError(INVALID_LINK);
  if (raw.v !== 1) throw new PlaylistShareError('This playlist link uses an unsupported version. Ask the sender for a new link.');
  if (!hasFields(raw, ['v', 'title', 'description', 'tracks', 'omitted']) ||
    !validText(raw.title, 60, true) || !validText(raw.description, 140) ||
    !Array.isArray(raw.tracks) || !isRecord(raw.omitted) || !hasFields(raw.omitted, ['local', 'unavailable'])) {
    throw new PlaylistShareError(INVALID_LINK);
  }
  if (raw.tracks.length > MAX_SHARED_TRACKS) throw new PlaylistShareError(TOO_LARGE);
  const { local, unavailable } = raw.omitted;
  if (![local, unavailable].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= MAX_SHARED_TRACKS) ||
    raw.tracks.length + (local as number) + (unavailable as number) > MAX_SHARED_TRACKS) {
    throw new PlaylistShareError(INVALID_LINK);
  }
  const seen = new Set<string>();
  const tracks: SharedTrack[] = [];
  for (const track of raw.tracks) {
    if (!isRecord(track) || !hasFields(track, ['key', 'title', 'artist']) || !isSharedTrackKey(track.key) ||
      !validText(track.title, 160, true) || !validText(track.artist, 160)) throw new PlaylistShareError(INVALID_LINK);
    if (seen.has(track.key)) continue;
    seen.add(track.key);
    tracks.push({ key: track.key, title: track.title, artist: track.artist });
  }
  return {
    v: 1, title: raw.title.trim(), description: raw.description.trim(), tracks,
    omitted: { local: local as number, unavailable: unavailable as number },
  };
}

export function isPlaylistTrackAvailable(song: any): boolean {
  return Boolean(song && !song.missing && (song.url || song.videoId) && (!song.isLocal || song.url));
}

/** Snapshot construction never changes the source playlist or library. Resolve
    legacy display-name aliases to trackKey, retaining the catalog identity. */
export function createPlaylistShare(
  playlist: { title: string; description: string; tracks: readonly (string | TrackSnapshot)[]; shared?: SharedPlaylist },
  songs: readonly any[],
): SharedPlaylist {
  const keys = [...new Map(playlist.tracks.map(track => [typeof track === 'string' ? track : track.ref, track])).values()];
  if (keys.length > MAX_SHARED_TRACKS) throw new PlaylistShareError(TOO_LARGE);
  const snapshot: SharedPlaylist = {
    v: 1, title: clipText(playlist.title, 60), description: clipText(playlist.description, 140),
    tracks: [], omitted: { local: 0, unavailable: 0 },
  };
  const seen = new Set<string>();
  for (const entry of keys) {
    const ref = typeof entry === 'string' ? null : entry;
    const originalKey = typeof entry === 'string' ? entry : entry.legacyKey ||
      (entry.ref.startsWith('video:') ? `vid:${entry.ref.slice(6)}` : entry.ref.replace(/^legacy:/, ''));
    const song = ref ? resolveTrackSnapshot(ref, songs as any[]) : songs.find((candidate) => trackMatchesKey(candidate, originalKey));
    const key = song ? trackKey(song) : originalKey;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref?.source === 'local' || song && (song.isLocal || /^(?:blob|data|file):/i.test(String(song.url || '')))) {
      snapshot.omitted.local++;
    } else if (song && isSharedTrackKey(key)) {
      snapshot.tracks.push({ key, title: clipText(song.title || 'Untitled track', 160), artist: clipText(song.artist, 160) });
    } else {
      /* An imported, currently missing track still has safe display metadata.
         An unknown legacy key might belong to a local file: omit it honestly. */
      const known = playlist.shared?.tracks.find((track) => track.key === key);
      if (known) snapshot.tracks.push({ key: known.key, title: known.title, artist: known.artist });
      else snapshot.omitted.unavailable++;
    }
  }
  return validateSharedPlaylist(snapshot);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodePlaylistShare(playlist: SharedPlaylist): string {
  const bytes = new TextEncoder().encode(JSON.stringify(validateSharedPlaylist(playlist)));
  if (bytes.length > MAX_SHARE_BYTES) throw new PlaylistShareError(TOO_LARGE);
  return base64url(bytes);
}

export function decodePlaylistShare(encoded: string): SharedPlaylist {
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_SHARE_ENCODED_LENGTH ||
    encoded.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new PlaylistShareError(INVALID_LINK);
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    if (binary.length > MAX_SHARE_BYTES) throw new PlaylistShareError(INVALID_LINK);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64url(bytes) !== encoded) throw new PlaylistShareError(INVALID_LINK);
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateSharedPlaylist(JSON.parse(json));
  } catch (error) {
    if (error instanceof PlaylistShareError) throw error;
    throw new PlaylistShareError(INVALID_LINK);
  }
}

export function playlistShareUrl(playlist: SharedPlaylist, pageUrl: string): string {
  const page = new URL(pageUrl);
  if (!['https:', 'http:'].includes(page.protocol)) throw new PlaylistShareError('Open Aura in a browser to share this playlist.');
  /* The music app lives at /. Do not copy query parameters, account routes,
     credentials, ?play=, or another feature's fragment into the shared link. */
  return `${page.origin}/${PLAYLIST_SHARE_PREFIX}${encodePlaylistShare(playlist)}`;
}

/** Match only the recipient's existing library. No discovery, downloads,
    storage writes, or playback. Missing keys keep their place in the copy. */
export function matchSharedPlaylist(playlist: SharedPlaylist, songs: readonly any[]): SharedTrackMatch[] {
  const seen = new Set<string>();
  const matches: SharedTrackMatch[] = [];
  for (const track of playlist.tracks) {
    const index = songs.findIndex((song) => trackMatchesKey(song, track.key));
    const song = index < 0 ? null : songs[index];
    const identity = song ? trackKey(song) : track.key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = isSharedTrackKey(identity) ? identity : track.key;
    matches.push({ track: { key, title: track.title, artist: track.artist }, song, index, available: isPlaylistTrackAvailable(song) });
  }
  return matches;
}
