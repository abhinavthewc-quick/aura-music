import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArtistStoreError, decodePortrait, importLegacyArtistProfile, MAX_PORTRAIT_BYTES,
  readArtistDirectory, readPortrait, saveArtistProfile, saveTrackArtistEdits,
} from '../../functions/lib/artistStore.js';
import { onRequestGet as getImage, onRequestHead as headImage } from '../../functions/api/artist-image.js';
import { onRequestGet as getDirectory } from '../../functions/api/artists.js';
import { onRequestPost as adminPost } from '../../functions/api/admin.js';
import { PNG, SqliteD1, videoId } from './sqlite.js';

const conflict = (error: unknown): boolean => error instanceof ArtistStoreError && error.status === 409;

test('profiles, aliases and portraits survive independent reads; removing an image keeps its immutable bytes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const saved = await saveArtistProfile(env, { artist: 'The Artist', name: 'New Artist', img: PNG, bio: 'A biography.', genres: ['Soul', 'Soul'], social: 'https://example.com' });
  assert.equal(saved.artist.version, 1);
  assert.deepEqual(saved.directory.artists['the artist'], saved.directory.artists['new artist']);
  assert.deepEqual(saved.artist.genres, ['Soul']);
  assert.match(saved.artist.img!, /^\/api\/artist-image\?id=/);
  const id = new URL(saved.artist.img!, 'https://aura.test').searchParams.get('id')!;
  const portrait = await readPortrait(env, id);
  assert.deepEqual(new Uint8Array(portrait!.bytes as Uint8Array), decodePortrait(PNG).bytes);
  const removed = await saveArtistProfile(env, { artist: 'New Artist', version: 1, img: '', bio: '' });
  assert.equal(removed.artist.key, 'the artist');
  assert.equal(removed.artist.img, '');
  assert.equal(removed.artist.bio, '');
  assert.equal(removed.artist.version, 2);
  assert.equal(removed.directory.revision, 2);
  assert.equal(db.count('artist_images'), 1);
  assert.ok(await readPortrait(env, id));
});

test('a stale draft cannot overwrite a newer profile or add an orphan image or alias', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Artist', bio: 'Current' });
  await assert.rejects(saveArtistProfile(env, { artist: 'Artist', version: 0, name: 'Stale', img: PNG }), conflict);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_aliases'), 1);
  assert.equal((await readArtistDirectory(env)).artists.artist.bio, 'Current');
});

test('two saves that read the same version have one winner, including all dependent writes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  db.beforeBatch = async (statements) => {
    if (!statements[0].sql.startsWith('INSERT INTO artist_profiles')) return;
    if (++arrivals === 2) release();
    await gate;
  };
  const tracks = [{ id: videoId(1), artist: 'Original' }];
  const results = await Promise.allSettled(['Winner A', 'Winner B'].map((name) => saveArtistProfile(env, { artist: 'Original', version: 0, name, img: PNG, renameTracks: true }, tracks, 0)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(conflict(failed.reason));
  assert.equal(db.count('artist_profiles'), 1);
  assert.equal(db.count('artist_images'), 1);
  assert.equal(db.count('artist_aliases'), 2);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.revision, 1);
  assert.equal(directory.trackArtists[videoId(1)], directory.artists.original.name);
});

test('a conflicting name rolls back the profile, image, track renames and revision together', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Alpha', bio: 'Keep me' });
  await saveArtistProfile(env, { artist: 'Beta' });
  await assert.rejects(saveArtistProfile(env, { artist: 'Alpha', version: 1, name: 'Beta', img: PNG, renameTracks: true }, [{ id: videoId(1), artist: 'Alpha' }], 2), conflict);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.artists.alpha.name, 'Alpha');
  assert.equal(directory.artists.alpha.bio, 'Keep me');
  assert.equal(directory.artists.alpha.version, 1);
  assert.equal(directory.revision, 2);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_track_overrides'), 0);
});

test('individual corrections override earlier batch renames; a later intentional rename can replace them', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Original', name: 'Renamed', renameTracks: true }, [{ id: videoId(1), artist: 'Original' }, { id: videoId(2), artist: 'Original' }], 0);
  const edited = await saveTrackArtistEdits(env, [{ id: videoId(1), artist: 'Correct Artist' }, { id: videoId(2), artist: 'Renamed' }]);
  assert.equal(edited.trackArtists[videoId(1)], 'Correct Artist');
  assert.equal(edited.trackArtists[videoId(2)], 'Renamed');
  const renamed = await saveArtistProfile(env, { artist: 'Renamed', version: 1, name: 'Final Name', renameTracks: true }, [{ id: videoId(1), artist: 'Correct Artist' }, { id: videoId(2), artist: 'Renamed' }], edited.revision);
  assert.equal(renamed.directory.trackArtists[videoId(1)], 'Correct Artist');
  assert.equal(renamed.directory.trackArtists[videoId(2)], 'Final Name');
  assert.equal(db.count('artist_track_edits'), 1);
});

test('track edits made while a batch rename is being prepared reject the stale rename', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Artist' });
  const snapshot = await readArtistDirectory(env);
  await saveTrackArtistEdits(env, [{ id: videoId(1), artist: 'Correction' }]);
  await assert.rejects(saveArtistProfile(env, { artist: 'Artist', version: 1, name: 'New Name', img: PNG, renameTracks: true }, [{ id: videoId(1), artist: 'Artist' }], snapshot.revision), conflict);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.artists.artist.version, 1);
  assert.equal(directory.trackArtists[videoId(1)], 'Correction');
  assert.equal(directory.revision, 2);
  assert.equal(db.count('artist_images'), 0);
});

test('large rename and metadata batches remain below D1 parameter and query limits', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const tracks = Array.from({ length: 1100 }, (_, n) => ({ id: videoId(n), artist: 'Original' }));
  const saved = await saveArtistProfile(env, { artist: 'Original', name: 'New Name', renameTracks: true }, tracks, 0);
  assert.equal(saved.renamedTrackCount, 1100);
  assert.equal(Object.keys(saved.directory.trackArtists).length, 1100);
  const corrected = await saveTrackArtistEdits(env, tracks.slice(0, 500).map((track) => ({ id: track.id, artist: 'Correction' })));
  assert.equal(corrected.trackArtists[videoId(499)], 'Correction');
  assert.equal(corrected.trackArtists[videoId(500)], 'New Name');
  assert.ok(db.maxParameters <= 100);
  assert.ok(db.maxBatch <= 50);
});

test('legacy import is repeatable, accepts newer legacy saves and never overwrites admin ownership', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  assert.equal((await importLegacyArtistProfile(env, 'Legacy', { name: 'Legacy Name', bio: 'First', img: PNG, updated: 100 })).imported, true);
  assert.equal((await importLegacyArtistProfile(env, 'Legacy', { name: 'Legacy Name', bio: 'First', img: PNG, updated: 100 })).imported, false);
  assert.equal(db.count('artist_images'), 1);
  assert.equal((await importLegacyArtistProfile(env, 'Legacy', { name: 'Legacy Name', bio: 'New legacy', img: PNG, updated: 200 })).imported, true);
  assert.equal((await readArtistDirectory(env)).artists.legacy.version, 2);
  await saveArtistProfile(env, { artist: 'Legacy Name', version: 2, bio: 'Admin wins', img: '' });
  assert.equal((await importLegacyArtistProfile(env, 'Legacy', { name: 'Legacy Name', bio: 'Stale workflow', img: PNG, updated: Date.now() + 10000 })).imported, false);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.artists.legacy.bio, 'Admin wins');
  assert.equal(directory.artists.legacy.img, '');
  assert.equal(directory.artists.legacy.version, 3);
  assert.equal(directory.revision, 3);
  assert.equal(db.count('artist_images'), 2);
});

test('an admin save racing a legacy import owns the profile without leaving imported bytes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  db.beforeBatch = async (statements) => {
    if (!statements[0].sql.includes("1, 'manifest'")) return;
    db.beforeBatch = undefined;
    await saveArtistProfile(env, { artist: 'Artist', bio: 'Admin owns this' });
  };
  assert.equal((await importLegacyArtistProfile(env, 'Artist', { img: PNG, bio: 'Import', updated: 100 })).imported, false);
  assert.equal((await readArtistDirectory(env)).artists.artist.bio, 'Admin owns this');
  assert.equal(db.count('artist_images'), 0);
});

test('portrait validation bounds uploads and rejects executable, mismatched and invalid data', () => {
  assert.equal(decodePortrait(PNG).mime, 'image/png');
  assert.throws(() => decodePortrait('data:image/svg+xml;base64,' + btoa('<svg/>')), ArtistStoreError);
  assert.throws(() => decodePortrait(PNG.replace('image/png', 'image/jpeg')), ArtistStoreError);
  assert.throws(() => decodePortrait('data:image/png;base64,@@@='), ArtistStoreError);
  assert.throws(() => decodePortrait('data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_PORTRAIT_BYTES / 3) * 4 + 68)), (error) => error instanceof ArtistStoreError && error.status === 413);
});

test('public image GET, HEAD, conditional caching and directory errors have safe headers', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const saved = await saveArtistProfile(env, { artist: 'Artist', img: PNG });
  const url = 'https://aura.test' + saved.artist.img;
  const image = await getImage({ request: new Request(url), env });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('cache-control')!, /immutable/);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), decodePortrait(PNG).bytes);
  const head = await headImage({ request: new Request(url, { method: 'HEAD' }), env });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), decodePortrait(PNG).bytes.byteLength);
  const cached = await getImage({ request: new Request(url, { headers: { 'If-None-Match': 'W/' + image.headers.get('etag') } }), env });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('content-length'), null);
  assert.equal((await getImage({ request: new Request('https://aura.test/api/artist-image?id=bad'), env })).status, 404);
  const directory = await getDirectory({ env });
  assert.equal(directory.headers.get('cache-control'), 'no-store');
  assert.equal((await directory.json()).artists.artist.img, saved.artist.img);
  assert.equal((await getDirectory({ env: {} })).status, 503);
});

test('Farmer service credentials cannot read the full library or mutate artist storage', async () => {
  for (const action of ['library', 'artistSet', 'bucketManifestSet', 'bucketManifestBatch']) {
    const response = await adminPost({ request: new Request('https://aura.test/api/admin', { method: 'POST', body: JSON.stringify({ action, service_token: 'test-service-token' }) }), env: { GH_TOKEN: 'test-gh-token', BOT_SERVICE_TOKEN: 'test-service-token' } as any });
    assert.equal(response.status, 403, action);
  }
});
