import {
  normalizeArtistKey, portraitUrl, PORTRAIT_ID_RE,
  type ArtistProfile, type ArtistDirectory,
} from '../../lib/artistProfiles.js';

/* Minimal binding types keep the Pages functions independent of a Worker SDK. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface ArtistDatabase {
  prepare(sql: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<Array<{ results: T[] }>>;
  withSession?(constraint: string): ArtistDatabase;
}
export interface ArtistEnv { ARTIST_DB?: ArtistDatabase }

export class ArtistStoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ArtistStoreError';
    this.status = status;
  }
}

interface ArtistRow {
  artist_key: string;
  name: string;
  img: string;
  bio: string;
  genres: string;
  social: string;
  updated: number;
  version: number;
  source: 'admin' | 'manifest';
  mutation_id: string;
}

function database(env: ArtistEnv): ArtistDatabase {
  if (!env.ARTIST_DB) throw new ArtistStoreError('Artist storage is not configured. Bind ARTIST_DB in Cloudflare Pages.', 503);
  /* Read the primary even if read replication is enabled later. A confirmed
     save must be visible to a different browser immediately. */
  return env.ARTIST_DB.withSession?.('first-primary') || env.ARTIST_DB;
}

function publicProfile(row: ArtistRow): ArtistProfile {
  return {
    key: row.artist_key, name: row.name, img: row.img, bio: row.bio,
    genres: JSON.parse(row.genres), social: row.social,
    updated: row.updated, version: row.version,
  };
}

export async function readArtistDirectory(env: ArtistEnv): Promise<ArtistDirectory> {
  const db = database(env);
  const [profiles, overrides, state] = await db.batch([
    db.prepare('SELECT a.alias_key, p.* FROM artist_aliases a JOIN artist_profiles p ON p.artist_key = a.artist_key'),
    db.prepare(`SELECT track_id, artist_name FROM artist_track_overrides
      WHERE track_id NOT IN (SELECT track_id FROM artist_track_edits)
      UNION ALL SELECT track_id, artist_name FROM artist_track_edits`),
    db.prepare('SELECT revision FROM artist_catalog_state WHERE id = 1'),
  ]);
  const artists: Record<string, ArtistProfile> = Object.create(null);
  for (const row of profiles.results as unknown as Array<ArtistRow & { alias_key: string }>) {
    artists[row.alias_key] = publicProfile(row);
  }
  const trackArtists: Record<string, string> = Object.create(null);
  for (const row of overrides.results as Array<{ track_id: string; artist_name: string }>) {
    trackArtists[row.track_id] = row.artist_name;
  }
  return { artists, trackArtists, revision: Number(state.results[0]?.revision) || 0 };
}

function field(value: unknown, fallback: string, max: number, label: string): string {
  const text = value === undefined ? fallback : String(value ?? '').trim();
  if (text.length > max) throw new ArtistStoreError(`${label} is too long (max ${max} characters).`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new ArtistStoreError(`${label} contains invalid characters.`);
  return text;
}

function httpsUrl(value: string, label: string): string {
  if (!value) return '';
  let url: URL;
  try { url = new URL(value); } catch { throw new ArtistStoreError(`${label} must be a valid HTTPS URL.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new ArtistStoreError(`${label} must be a valid HTTPS URL without credentials.`);
  }
  return url.href;
}

export const MAX_PORTRAIT_BYTES = 1.5 * 1024 * 1024;
export interface PortraitUpload { bytes: Uint8Array; mime: string; ext: 'jpg' | 'png' | 'webp' }

/* MIME declarations alone are not enough: never publish HTML/SVG as an image
   on the site's origin. The encoded and decoded sizes are both bounded. */
export function decodePortrait(data: string): PortraitUpload {
  if (data.length > Math.ceil(MAX_PORTRAIT_BYTES / 3) * 4 + 64) {
    throw new ArtistStoreError('Portrait is too large (max 1.5 MB).', 413);
  }
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data);
  if (!match || match[2].length % 4 !== 0) throw new ArtistStoreError('Upload a JPEG, PNG or WebP portrait.');
  let binary: string;
  try { binary = atob(match[2]); } catch { throw new ArtistStoreError('Portrait data is invalid.'); }
  if (binary.length > MAX_PORTRAIT_BYTES) throw new ArtistStoreError('Portrait is too large (max 1.5 MB).', 413);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const type = match[1].toLowerCase();
  const png = bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  const jpeg = bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 20 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP';
  if (type === 'png' && png) return { bytes, mime: 'image/png', ext: 'png' };
  if ((type === 'jpg' || type === 'jpeg') && jpeg) return { bytes, mime: 'image/jpeg', ext: 'jpg' };
  if (type === 'webp' && webp) return { bytes, mime: 'image/webp', ext: 'webp' };
  throw new ArtistStoreError('Portrait bytes do not match the image type.');
}

async function prepareImage(value: unknown, fallback: string): Promise<{
  img: string; upload?: PortraitUpload; imageId?: string; etag?: string;
}> {
  const img = value === undefined ? fallback : String(value ?? '').trim();
  if (!img) return { img: '' };
  if (img.startsWith('data:')) {
    const upload = decodePortrait(img);
    const imageId = crypto.randomUUID() + '.' + upload.ext;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', upload.bytes as BufferSource));
    const etag = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    return { img: portraitUrl(imageId), upload, imageId, etag };
  }
  if (img.length > 2048) throw new ArtistStoreError('Picture URL is too long.');
  if (img.startsWith('/api/artist-image?')) {
    const url = new URL(img, 'https://aura.invalid');
    const id = url.searchParams.get('id') || '';
    if (url.pathname !== '/api/artist-image' || !PORTRAIT_ID_RE.test(id)) throw new ArtistStoreError('Picture URL is invalid.');
    return { img: portraitUrl(id) };
  }
  /* External URLs are references only. Never fetch arbitrary admin-provided
     hosts server-side, which would turn the portrait editor into an SSRF proxy. */
  return { img: httpsUrl(img, 'Picture URL') };
}

export interface RenameCandidate { id: string; artist: string }
export interface ArtistSave {
  artist?: unknown;
  artistKey?: unknown;
  version?: unknown;
  name?: unknown;
  img?: unknown;
  bio?: unknown;
  genres?: unknown;
  social?: unknown;
  renameTracks?: unknown;
}

export async function saveArtistProfile(
  env: ArtistEnv, input: ArtistSave, tracks: RenameCandidate[] = [], expectedDirectoryRevision?: number,
): Promise<{ artist: ArtistProfile; renamedTrackCount: number; directory: ArtistDirectory }> {
  const db = database(env);
  const original = field(input.artist, '', 120, 'Artist name');
  const lookupKey = normalizeArtistKey(field(input.artistKey, original, 120, 'Artist key'));
  if (!lookupKey || !original) throw new ArtistStoreError('Artist name is required.');
  const existing = await db.prepare(`SELECT p.* FROM artist_profiles p
    LEFT JOIN artist_aliases a ON a.artist_key = p.artist_key
    WHERE p.artist_key = ? OR a.alias_key = ? LIMIT 1`).bind(lookupKey, lookupKey).first<ArtistRow>();
  const key = existing?.artist_key || lookupKey;
  const expected = input.version === undefined ? 0 : Number(input.version);
  if (!Number.isInteger(expected) || expected < 0) throw new ArtistStoreError('Artist version is invalid.');
  if ((existing?.version || 0) !== expected) {
    throw new ArtistStoreError('This artist was changed in another tab. Reload the artist list, then reapply your changes.', 409);
  }
  const name = field(input.name, existing?.name || original, 120, 'Artist name');
  if (!name) throw new ArtistStoreError('Artist name is required.');
  const bio = field(input.bio, existing?.bio || '', 2000, 'Biography');
  const social = httpsUrl(field(input.social, existing?.social || '', 2048, 'Social link'), 'Social link');
  const rawGenres = input.genres === undefined ? JSON.parse(existing?.genres || '[]') : input.genres;
  if (!Array.isArray(rawGenres) || rawGenres.length > 20) throw new ArtistStoreError('Use at most 20 genres.');
  const genres = [...new Set(rawGenres.map((g) => field(g, '', 64, 'Genre')).filter(Boolean))];
  const image = await prepareImage(input.img, existing?.img || '');
  const mutation = crypto.randomUUID();
  const now = Date.now();
  const version = expected + 1;
  const aliasRows = existing ? await db.prepare('SELECT alias_key FROM artist_aliases WHERE artist_key = ?').bind(key).all<{ alias_key: string }>() : { results: [] };
  const aliases = new Set([key, normalizeArtistKey(original), normalizeArtistKey(existing?.name || original), normalizeArtistKey(name)]);
  const matchNames = new Set([...aliases, ...aliasRows.results.map((row) => row.alias_key)]);
  const renameIds = input.renameTracks === true
    ? [...new Set(tracks.filter((t) => matchNames.has(normalizeArtistKey(t.artist)) && t.artist !== name).map((t) => t.id))]
    : [];

  /* D1 batches are transactions. Every dependent write is gated by this
     request's unique mutation ID, not just a version number: a losing race
     cannot add aliases, an image, or track overrides to the winner's save. */
  const statements = [db.prepare(`INSERT INTO artist_profiles
    (artist_key, name, img, bio, genres, social, updated, version, source, mutation_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?
    WHERE (? IS NULL OR (SELECT revision FROM artist_catalog_state WHERE id = 1) = ?)
    ON CONFLICT(artist_key) DO UPDATE SET
      name = excluded.name, img = excluded.img, bio = excluded.bio,
      genres = excluded.genres, social = excluded.social, updated = excluded.updated,
      version = excluded.version, source = 'admin', mutation_id = excluded.mutation_id
    WHERE artist_profiles.version = ? RETURNING *`)
    .bind(key, name, image.img, bio, JSON.stringify(genres), social, now, version, mutation,
      expectedDirectoryRevision ?? null, expectedDirectoryRevision ?? null, expected)];
  for (const alias of aliases) {
    /* A name already owned by a different artist violates the primary key,
       rolling back the entire batch instead of hijacking that artist. */
    statements.push(db.prepare(`INSERT INTO artist_aliases (alias_key, artist_key)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)
      AND NOT EXISTS (SELECT 1 FROM artist_aliases WHERE alias_key = ? AND artist_key = ?)`)
      .bind(alias, key, key, mutation, alias, key));
  }
  if (image.upload) {
    statements.push(db.prepare(`INSERT INTO artist_images (image_id, mime, bytes, etag, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)`)
      .bind(image.imageId, image.upload.mime, image.upload.bytes.buffer, image.etag, now, key, mutation));
  }
  /* Stay below D1's 100 bound-parameter limit and the free-tier per-request
     query limit, even when an artist has hundreds of tracks. */
  for (let offset = 0; offset < renameIds.length; offset += 90) {
    const ids = renameIds.slice(offset, offset + 90);
    statements.push(db.prepare(`INSERT INTO artist_track_overrides (track_id, artist_key, artist_name, updated)
      SELECT column1, ?, ?, ? FROM (VALUES ${ids.map(() => '(?)').join(', ')})
      WHERE EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)
      ON CONFLICT(track_id) DO UPDATE SET artist_key = excluded.artist_key,
        artist_name = excluded.artist_name, updated = excluded.updated`)
      .bind(key, name, now, ...ids, key, mutation));
    statements.push(db.prepare(`DELETE FROM artist_track_edits WHERE track_id IN (${ids.map(() => '?').join(', ')})
      AND EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)`)
      .bind(...ids, key, mutation));
  }
  statements.push(db.prepare(`UPDATE artist_catalog_state SET revision = revision + 1
    WHERE id = 1 AND EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)`)
    .bind(key, mutation));
  let result: Array<{ results: Record<string, unknown>[] }>;
  try { result = await db.batch(statements); }
  catch (e) {
    if (/UNIQUE constraint failed: artist_aliases/.test(String((e as Error).message))) {
      throw new ArtistStoreError('That name is already used by another artist. Choose a different name.', 409);
    }
    throw new ArtistStoreError('Artist changes could not be saved. Try again.', 503);
  }
  if (!result[0].results.length) {
    throw new ArtistStoreError('The artist or its tracks changed during this save. Reload the artist list, then reapply your changes.', 409);
  }
  return {
    artist: publicProfile(result[0].results[0] as unknown as ArtistRow),
    renamedTrackCount: renameIds.length,
    directory: await readArtistDirectory(env),
  };
}

export async function saveTrackArtistEdits(
  env: ArtistEnv, edits: Array<{ id: string; artist: string }>,
): Promise<ArtistDirectory> {
  const db = database(env);
  if (edits.length > 500) throw new ArtistStoreError('Update at most 500 tracks at once.');
  const names = new Map<string, string>();
  for (const edit of edits) {
    if (!/^vid:[A-Za-z0-9_-]{11}$/.test(edit.id)) throw new ArtistStoreError('Track ID is invalid.');
    const artist = field(edit.artist, '', 200, 'Track artist');
    if (!artist) throw new ArtistStoreError('Track artist is required.');
    names.set(edit.id, artist);
  }
  if (!names.size) return readArtistDirectory(env);
  const rows = [...names];
  const now = Date.now();
  const statements: D1Statement[] = [];
  for (let offset = 0; offset < rows.length; offset += 32) {
    const chunk = rows.slice(offset, offset + 32);
    statements.push(db.prepare(`INSERT INTO artist_track_edits (track_id, artist_name, updated)
      VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
      ON CONFLICT(track_id) DO UPDATE SET artist_name = excluded.artist_name, updated = excluded.updated`)
      .bind(...chunk.flatMap(([id, artist]) => [id, artist, now])));
  }
  statements.push(db.prepare('UPDATE artist_catalog_state SET revision = revision + 1 WHERE id = 1'));
  await db.batch(statements);
  return readArtistDirectory(env);
}

/* Cutover-only import. Re-running a fresh manifest is safe: newer imports win,
   but any profile saved through the admin has permanent ownership. The image,
   aliases and revision have the same transaction gate as an ordinary save. */
export async function importLegacyArtistProfile(
  env: ArtistEnv, alias: string, profile: ArtistProfile,
): Promise<{ imported: boolean; key: string }> {
  const db = database(env);
  const original = field(alias, '', 120, 'Artist key');
  const lookupKey = normalizeArtistKey(original);
  if (!lookupKey) throw new ArtistStoreError('Artist key is required.');
  const name = field(profile.name, original, 120, 'Artist name');
  if (!name) throw new ArtistStoreError('Artist name is required.');
  const existing = await db.prepare(`SELECT p.* FROM artist_profiles p
    LEFT JOIN artist_aliases a ON a.artist_key = p.artist_key
    WHERE p.artist_key = ? OR a.alias_key = ? OR a.alias_key = ?
    ORDER BY p.artist_key = ? DESC LIMIT 1`)
    .bind(lookupKey, lookupKey, normalizeArtistKey(name), lookupKey).first<ArtistRow>();
  const key = existing?.artist_key || lookupKey;
  const updated = Number(profile.updated || 0);
  if (!Number.isSafeInteger(updated) || updated < 0) throw new ArtistStoreError('Legacy artist timestamp is invalid.');
  if (existing && (existing.source === 'admin' || existing.updated >= updated)) return { imported: false, key };
  const bio = field(profile.bio, '', 2000, 'Biography');
  const social = httpsUrl(field(profile.social, '', 2048, 'Social link'), 'Social link');
  const rawGenres = profile.genres || [];
  if (!Array.isArray(rawGenres) || rawGenres.length > 20) throw new ArtistStoreError('Use at most 20 genres.');
  const genres = [...new Set(rawGenres.map((g) => field(g, '', 64, 'Genre')).filter(Boolean))];
  const image = await prepareImage(profile.img, '');
  const mutation = crypto.randomUUID();
  const statements = [db.prepare(`INSERT INTO artist_profiles
    (artist_key, name, img, bio, genres, social, updated, version, source, mutation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'manifest', ?)
    ON CONFLICT(artist_key) DO UPDATE SET name = excluded.name, img = excluded.img,
      bio = excluded.bio, genres = excluded.genres, social = excluded.social,
      updated = excluded.updated, version = artist_profiles.version + 1, mutation_id = excluded.mutation_id
    WHERE artist_profiles.source = 'manifest' AND artist_profiles.updated < excluded.updated
    RETURNING artist_key`)
    .bind(key, name, image.img, bio, JSON.stringify(genres), social, updated, mutation)];
  for (const artistAlias of new Set([key, lookupKey, normalizeArtistKey(name)])) {
    statements.push(db.prepare(`INSERT INTO artist_aliases (alias_key, artist_key)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)
      AND NOT EXISTS (SELECT 1 FROM artist_aliases WHERE alias_key = ? AND artist_key = ?)`)
      .bind(artistAlias, key, key, mutation, artistAlias, key));
  }
  if (image.upload) {
    statements.push(db.prepare(`INSERT INTO artist_images (image_id, mime, bytes, etag, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)`)
      .bind(image.imageId, image.upload.mime, image.upload.bytes.buffer, image.etag, updated, key, mutation));
  }
  statements.push(db.prepare(`UPDATE artist_catalog_state SET revision = revision + 1
    WHERE id = 1 AND EXISTS (SELECT 1 FROM artist_profiles WHERE artist_key = ? AND mutation_id = ?)`)
    .bind(key, mutation));
  const results = await db.batch(statements);
  return { imported: results[0].results.length > 0, key };
}

export async function readPortrait(env: ArtistEnv, id: string): Promise<{
  mime: string; bytes: number[] | ArrayBuffer | Uint8Array; etag: string;
} | null> {
  return database(env).prepare('SELECT mime, bytes, etag FROM artist_images WHERE image_id = ?')
    .bind(id).first();
}
