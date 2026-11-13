import { legacyTrackMatches, resolveTrackSnapshot, safeArtwork, snapshotTrack, type TrackSnapshot } from './track-identity';
import { validateSharedPlaylist, type SharedPlaylist } from './playlist-sharing';

export const PLAYLISTS_KEY = 'auraPlaylists';
export const PLAYLIST_FORMAT = 'aura-playlist';
export const PLAYLIST_SCHEMA = 2;
export const MAX_PLAYLISTS = 200;
export const MAX_TRACKS_PER_PLAYLIST = 2000;
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export type PlaylistTrackRef = TrackSnapshot;
export type PlaylistPrivacy = 'Public' | 'Private' | 'Unlisted';
export interface Playlist {
  schemaVersion: 2;
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  privacy: PlaylistPrivacy;
  year: number | string;
  shared?: SharedPlaylist;
  tracks: PlaylistTrackRef[];
}
export interface PlaylistStore { version: 2; revision: number; playlists: Playlist[] }
export interface ParsedPlaylistStore { store: PlaylistStore; needsMigration: boolean }

export class PlaylistDataError extends Error {
  constructor(message: string) { super(message); this.name = 'PlaylistDataError'; }
}
const fail = (message: string): never => { throw new PlaylistDataError(message); };
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    return fail(`${label} must be text.`);
  }
  const result = value.trim();
  if ((required && !result) || Array.from(result).length > maximum) return fail(`${label} must contain ${required ? '1–' : 'at most '}${maximum} characters.`);
  return result;
}

function legacySnapshot(key: string, songs: any[]): PlaylistTrackRef {
  const matches = legacyTrackMatches(key,songs);
  if (matches.length === 1) return snapshotTrack(matches[0], key);
  const parts = key.startsWith('lk:') ? key.slice(3).split('|') : [];
  return {
    ref: key.startsWith('vid:') ? `video:${key.slice(4)}` : key.startsWith('id:') ? key : `legacy:${key}`,
    legacyKey: key,
    title: parts[0] || 'Unavailable track', artist: parts[1] || 'Not in this library', img: '', duration: 0,
  };
}

function normalizeReference(raw: unknown, songs: any[], legacy: boolean): PlaylistTrackRef {
  if (legacy && typeof raw === 'string') return legacySnapshot(text(raw,'Track reference',1000,true), songs);
  if (!isRecord(raw)) return fail('Every track must have a stable reference and metadata.');
  const ref = text(raw.ref,'Track reference',1000,true);
  if (!/^(?:id:.+|video:[A-Za-z0-9_-]{11}|legacy:.+)$/s.test(ref)) return fail('A track reference is invalid.');
  const result: PlaylistTrackRef = {
    ref,
    title: text(raw.title,'Track title',200,true),
    artist: text(raw.artist,'Track artist',200),
    img: safeArtwork(raw.img),
    duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration
      : typeof raw.duration === 'string' && /^\d{1,3}:\d{2}(?::\d{2})?$/.test(raw.duration) ? raw.duration : 0,
  };
  if (raw.legacyKey !== undefined) result.legacyKey = text(raw.legacyKey,'Legacy track reference',1000);
  if (raw.source !== undefined) {
    if (!['local','catalog','youtube','added'].includes(raw.source)) return fail('A track source is invalid.');
    result.source = raw.source;
  }
  const resolved = resolveTrackSnapshot(result,songs);
  // Resolving a legacy alias also makes the metadata robust against future edits.
  return resolved ? snapshotTrack(resolved,result.legacyKey) : result;
}

export function normalizePlaylist(raw: unknown, songs: any[] = [], legacy = false, strictDuplicates = false): Playlist {
  if (!isRecord(raw)) return fail('The playlist is missing.');
  if (!legacy && raw.schemaVersion !== PLAYLIST_SCHEMA) return fail('This playlist version is not supported.');
  if (!Array.isArray(raw.tracks) || raw.tracks.length > MAX_TRACKS_PER_PLAYLIST) return fail(`A playlist can contain at most ${MAX_TRACKS_PER_PLAYLIST} tracks.`);
  const seen = new Set<string>();
  const tracks: PlaylistTrackRef[] = [];
  for (const rawRef of raw.tracks) {
    const ref = normalizeReference(rawRef,songs,legacy);
    if (seen.has(ref.ref)) {
      if (strictDuplicates) return fail('The playlist file contains duplicate tracks.');
      continue;
    }
    seen.add(ref.ref);
    tracks.push(ref);
  }
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) && raw.createdAt >= 0 ? raw.createdAt : Date.now();
  let shared: SharedPlaylist | undefined;
  if (raw.shared) {
    try { shared = validateSharedPlaylist(raw.shared); } catch { /* Invalid auxiliary preview metadata cannot erase the saved collection. */ }
  }
  for (const ref of tracks) {
    const details = shared?.tracks.find(track => track.key === ref.legacyKey || `video:${track.key.slice(4)}` === ref.ref && track.key.startsWith('vid:'));
    if (details && !resolveTrackSnapshot(ref, songs)) { ref.title = details.title; ref.artist = details.artist; }
  }
  return {
    schemaVersion: 2,
    id: text(raw.id,'Playlist id',200,true),
    title: text(raw.title,'Playlist title',60,true),
    description: text(raw.description,'Description',140),
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0 ? raw.updatedAt : createdAt,
    privacy: ['Public', 'Private', 'Unlisted'].includes(raw.privacy) ? raw.privacy : 'Private',
    year: typeof raw.year === 'string' && raw.year.length <= 32 || typeof raw.year === 'number' && Number.isFinite(raw.year)
      ? raw.year : new Date(createdAt).getFullYear(),
    ...(shared ? { shared } : {}),
    tracks,
  };
}

export function parsePlaylistStore(raw: string | null, songs: any[] = []): ParsedPlaylistStore {
  const empty: PlaylistStore = {version:2,revision:0,playlists:[]};
  if (!raw) return {store:empty,needsMigration:false};
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return fail('Saved playlists could not be read. Export a recovery copy before changing browser storage.'); }
  const legacy = Array.isArray(parsed);
  if (!legacy && (!isRecord(parsed) || parsed.version !== 2)) return fail('Saved playlists use an unsupported format. No data has been changed.');
  const source = legacy ? parsed : parsed.playlists;
  if (!Array.isArray(source) || source.length > MAX_PLAYLISTS) return fail('The saved playlist collection is invalid or too large.');
  const ids = new Set<string>();
  const playlists = source.map((item: unknown) => {
    const playlist = normalizePlaylist(item,songs,legacy);
    if (ids.has(playlist.id)) return fail('Saved playlists contain duplicate identifiers.');
    ids.add(playlist.id);
    return playlist;
  });
  const store: PlaylistStore = {
    version:2,
    revision: !legacy && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
    playlists,
  };
  return {store,needsMigration:legacy || JSON.stringify(parsed) !== JSON.stringify(store)};
}

export function decodePlaylistFile(content: string, songs: any[] = []): Playlist {
  if (new TextEncoder().encode(content).byteLength > MAX_IMPORT_BYTES) return fail('That playlist file is too large.');
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return fail('The file is not valid JSON.'); }
  if (!isRecord(parsed) || parsed.format !== PLAYLIST_FORMAT || parsed.version !== PLAYLIST_SCHEMA) return fail('Choose an Aura playlist export in version 2 format.');
  return normalizePlaylist(parsed.playlist,songs,false,true);
}

export function encodePlaylistFile(playlist: Playlist, songs: any[] = []): string {
  const normalized = normalizePlaylist(playlist,songs);
  return JSON.stringify({format:PLAYLIST_FORMAT,version:PLAYLIST_SCHEMA,exportedAt:new Date().toISOString(),playlist:normalized},null,2);
}
