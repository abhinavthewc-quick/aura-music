import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { composeArtistMetadata, type AutomaticArtistMetadata } from '../../lib/artistMetadata.js';
import {
  ArtistStoreError, decodePortrait, importLegacyArtistProfile, MAX_PORTRAIT_BYTES,
  readArtistDirectory, readPortrait, saveArtistProfile, saveTrackArtistEdits,
} from '../../functions/lib/artistStore.js';
import { onRequestGet as getImage, onRequestHead as headImage } from '../../functions/api/artist-image.js';
import { onRequestGet as getDirectory } from '../../functions/api/artists.js';
import { onRequestPost as adminPost } from '../../functions/api/admin.js';
import { PNG, SqliteD1, videoId } from './sqlite.js';

const conflict = (error: unknown): boolean => error instanceof ArtistStoreError && error.status === 409;
const automatic: AutomaticArtistMetadata = {
  name: 'Provider name', entityId: 'provider:1', img: 'https://images.example/automatic.jpg',
  bio: 'Automatic biography.', fetchedAt: 100, expiresAt: 200,
};

test('override migration preserves raw cutover data, locks all curated fields and publishes flags once', (t) => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migration = (file: string) => readFileSync(new URL('../../migrations/artists/' + file, import.meta.url), 'utf8');
  sqlite.exec(migration('0001_artist_storage.sql'));
  sqlite.exec(migration('0002_track_artist_edits.sql'));
  const insert = sqlite.prepare(`INSERT INTO artist_profiles
    (artist_key, name, img, bio, genres, social, updated, version, source, mutation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  /* The observed production shape: 16 manifest + 2 admin rows, all version 1,
     all with curated portraits and unspecified empty biographies. */
  for (let n = 0; n < 18; n++) {
    insert.run('artist ' + n, 'Artist ' + n,
      n < 16 ? '/api/artist-image?id=curated-' + n + '.png' : 'https://images.example/curated-' + n + '.jpg',
      '', '[ "Soul" ]', 'https://artist.example/' + n, 100 + n, 1, n < 16 ? 'manifest' : 'admin', 'old-mutation-' + n);
    sqlite.prepare('INSERT INTO artist_aliases (alias_key, artist_key) VALUES (?, ?)').run('original ' + n, 'artist ' + n);
  }
  for (const source of ['admin', 'manifest']) {
    insert.run('biography ' + source, 'Biography ' + source, '', '  Curated biography.  ', '[]', '', 300, 1, source, 'bio-' + source);
  }
  insert.run('blank fields', 'Blank Fields', '  ', '  ', '[]', '', 400, 1, 'manifest', 'blank-mutation');
  sqlite.prepare('INSERT INTO artist_images (image_id, mime, bytes, etag, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('curated-0.png', 'image/png', decodePortrait(PNG).bytes, 'old-etag', 99);
  sqlite.exec(`INSERT INTO artist_track_overrides VALUES ('${videoId(0)}', 'artist 0', 'Artist 0', 100);
    INSERT INTO artist_track_edits VALUES ('${videoId(1)}', 'Correction', 101);
    UPDATE artist_catalog_state SET revision = 18 WHERE id = 1`);
  const rawProfiles = sqlite.prepare('SELECT * FROM artist_profiles ORDER BY artist_key').all().map((row) => ({ ...row }));
  const unchangedTables = ['artist_aliases', 'artist_images', 'artist_track_overrides', 'artist_track_edits'];
  const before = unchangedTables.map((table) => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all());

  sqlite.exec(migration('0003_artist_metadata_overrides.sql'));
  const rows = sqlite.prepare('SELECT * FROM artist_profiles ORDER BY artist_key').all();
  assert.deepEqual(rows.map(({ img_override, bio_override, ...raw }) => raw), rawProfiles);
  for (const row of rows) {
    assert.equal(row.img_override, String(row.img).trim() ? 1 : 0);
    assert.equal(row.bio_override, String(row.bio).trim() ? 1 : 0);
  }
  assert.deepEqual(sqlite.prepare(`SELECT source, count(*) AS profiles, sum(img_override) AS images,
    sum(bio_override) AS biographies FROM artist_profiles WHERE artist_key LIKE 'artist %'
    GROUP BY source ORDER BY source`).all().map((row) => ({ ...row })), [
    { source: 'admin', profiles: 2, images: 2, biographies: 0 },
    { source: 'manifest', profiles: 16, images: 16, biographies: 0 },
  ]);
  assert.deepEqual(unchangedTables.map((table) => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()), before);
  assert.equal(sqlite.prepare('SELECT revision FROM artist_catalog_state WHERE id = 1').get()!.revision, 19);
  for (const column of ['img_override', 'bio_override']) {
    assert.throws(() => sqlite.exec(`UPDATE artist_profiles SET ${column} = 2 WHERE artist_key = 'artist 0'`), /CHECK constraint/);
    assert.throws(() => sqlite.exec(`UPDATE artist_profiles SET ${column} = NULL WHERE artist_key = 'artist 0'`), /NOT NULL constraint/);
  }
});

test('untouched fields allow automatic fill while explicit values and clears lock fields independently', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const created = await saveArtistProfile(env, { artist: 'Artist' });
  assert.equal(created.artist.source, 'admin');
  assert.equal(created.artist.imgOverride, false);
  assert.equal(created.artist.bioOverride, false);
  assert.equal(composeArtistMetadata(created.artist, automatic)!.bio, automatic.bio);
  assert.deepEqual(await readArtistDirectory(env), created.directory, 'composition never writes automatic data or revisions');

  const imageOnly = await saveArtistProfile(env, { artist: 'Artist', version: 1, img: PNG });
  assert.equal(imageOnly.artist.imgOverride, true);
  assert.equal(imageOnly.artist.bioOverride, false);
  assert.equal(composeArtistMetadata(imageOnly.artist, automatic)!.img, imageOnly.artist.img);
  assert.equal(composeArtistMetadata(imageOnly.artist, automatic)!.bio, automatic.bio);
  const cleared = await saveArtistProfile(env, { artist: 'Artist', version: 2, bio: '' });
  assert.equal(cleared.artist.bio, '');
  assert.equal(cleared.artist.bioOverride, true);
  assert.equal(composeArtistMetadata(cleared.artist, automatic)!.bio, '');
  const untouched = await saveArtistProfile(env, { artist: 'Artist', version: 3, genres: ['Soul'] });
  assert.equal(untouched.artist.img, imageOnly.artist.img);
  assert.equal(untouched.artist.imgOverride, true);
  assert.equal(untouched.artist.bioOverride, true);
  assert.equal(composeArtistMetadata(untouched.artist, automatic)!.bio, '');

  const lockedBlank = await saveArtistProfile(env, { artist: 'Blank Artist', imgOverride: true, bioOverride: true });
  assert.equal(lockedBlank.artist.img, '');
  assert.equal(lockedBlank.artist.bio, '');
  assert.equal(lockedBlank.artist.imgOverride, true);
  assert.equal(lockedBlank.artist.bioOverride, true);
});

test('Use Automatic unlocks without discarding fallback values; unrelated saves preserve intent', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const saved = await saveArtistProfile(env, { artist: 'Artist', img: PNG, bio: 'Manual biography.' });
  const unlockedImage = await saveArtistProfile(env, { artist: 'Artist', version: 1, imgOverride: false });
  assert.equal(unlockedImage.artist.img, saved.artist.img);
  assert.equal(unlockedImage.artist.imgOverride, false);
  assert.equal(unlockedImage.artist.bioOverride, true);
  assert.equal(composeArtistMetadata(unlockedImage.artist, automatic)!.img, automatic.img);
  assert.equal(composeArtistMetadata(unlockedImage.artist, null)!.img, saved.artist.img);
  const renamed = await saveArtistProfile(env, { artist: 'Artist', version: 2, name: 'Renamed Artist' });
  assert.equal(renamed.artist.imgOverride, false);
  assert.equal(renamed.artist.bioOverride, true);
  const unlockedBoth = await saveArtistProfile(env, {
    artist: 'Renamed Artist', version: 3, img: '', imgOverride: false, bio: 'Stored fallback.', bioOverride: false,
  });
  assert.equal(unlockedBoth.artist.img, '');
  assert.equal(unlockedBoth.artist.bio, 'Stored fallback.');
  assert.equal(unlockedBoth.artist.imgOverride, false);
  assert.equal(unlockedBoth.artist.bioOverride, false);
  assert.equal(composeArtistMetadata(unlockedBoth.artist, automatic)!.img, automatic.img);
  assert.equal(composeArtistMetadata(unlockedBoth.artist, automatic)!.bio, automatic.bio);
  const relocked = await saveArtistProfile(env, { artist: 'Renamed Artist', version: 4, imgOverride: true });
  assert.equal(relocked.artist.img, '');
  assert.equal(relocked.artist.imgOverride, true);
  assert.equal(relocked.artist.bioOverride, false);
  assert.equal(composeArtistMetadata(relocked.artist, automatic)!.img, '');
});

test('non-boolean override flags are rejected before any profile or dependent write', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const saved = await saveArtistProfile(env, { artist: 'Artist', bio: 'Keep this' });
  for (const flag of ['imgOverride', 'bioOverride']) {
    for (const value of [null, 0, 1, '', 'false', 'true', [], {}]) {
      await assert.rejects(saveArtistProfile(env, {
        artist: 'Artist', version: 1, name: 'Invalid Alias', img: PNG, bio: '', [flag]: value, renameTracks: true,
      }, [{ id: videoId(1), artist: 'Artist' }], saved.directory.revision),
      (error) => error instanceof ArtistStoreError && error.status === 400 && error.message === flag + ' must be a boolean.');
    }
  }
  await assert.rejects(saveArtistProfile(env, { artist: 'New Artist', img: PNG, imgOverride: 'false' }), ArtistStoreError);
  assert.deepEqual(await readArtistDirectory(env), saved.directory);
  assert.equal(db.count('artist_profiles'), 1);
  assert.equal(db.count('artist_aliases'), 1);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_track_overrides'), 0);
});

test('profiles, aliases and portraits survive independent reads; removing an image keeps its immutable bytes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const initialRevision = (await readArtistDirectory(env)).revision;
  const saved = await saveArtistProfile(env, { artist: 'The Artist', name: 'New Artist', img: PNG, bio: 'A biography.', genres: ['Soul', 'Soul'], social: 'https://example.com' });
  assert.equal(saved.artist.version, 1);
  assert.equal(saved.artist.source, 'admin');
  assert.equal(saved.artist.imgOverride, true);
  assert.equal(saved.artist.bioOverride, true);
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
  assert.equal(removed.artist.imgOverride, true);
  assert.equal(removed.artist.bioOverride, true);
  assert.equal(removed.artist.version, 2);
  assert.equal(removed.directory.revision, initialRevision + 2);
  assert.equal(db.count('artist_images'), 1);
  assert.ok(await readPortrait(env, id));
});

test('a stale draft cannot overwrite a newer profile or add an orphan image or alias', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Artist', bio: 'Current' });
  const before = await readArtistDirectory(env);
  await assert.rejects(saveArtistProfile(env, { artist: 'Artist', version: 0, name: 'Stale', img: PNG, imgOverride: true, bioOverride: false }), conflict);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_aliases'), 1);
  assert.deepEqual(await readArtistDirectory(env), before);
});

test('two saves that read the same version have one winner, including all dependent writes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const initialRevision = (await readArtistDirectory(env)).revision;
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  db.beforeBatch = async (statements) => {
    if (!statements[0].sql.startsWith('INSERT INTO artist_profiles')) return;
    if (++arrivals === 2) release();
    await gate;
  };
  const tracks = [{ id: videoId(1), artist: 'Original' }];
  const drafts = [
    { name: 'Winner A', imgOverride: false, bio: '', bioOverride: true },
    { name: 'Winner B', imgOverride: true, bio: 'Winner B biography', bioOverride: false },
  ];
  const results = await Promise.allSettled(drafts.map((draft) => saveArtistProfile(env, { artist: 'Original', version: 0, ...draft, img: PNG, renameTracks: true }, tracks, initialRevision)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(conflict(failed.reason));
  assert.equal(db.count('artist_profiles'), 1);
  assert.equal(db.count('artist_images'), 1);
  assert.equal(db.count('artist_aliases'), 2);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.revision, initialRevision + 1);
  assert.equal(directory.trackArtists[videoId(1)], directory.artists.original.name);
  const winner = drafts.find((draft) => draft.name === directory.artists.original.name)!;
  assert.equal(directory.artists.original.imgOverride, winner.imgOverride);
  assert.equal(directory.artists.original.bioOverride, winner.bioOverride);
  assert.equal(directory.artists.original.bio, winner.bio);
  const row = await db.prepare('SELECT img_override, bio_override FROM artist_profiles').first<any>();
  assert.equal(row.img_override, Number(winner.imgOverride));
  assert.equal(row.bio_override, Number(winner.bioOverride));
});

test('a conflicting name rolls back the profile, image, track renames and revision together', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Alpha', bio: 'Keep me' });
  await saveArtistProfile(env, { artist: 'Beta' });
  const before = await readArtistDirectory(env);
  await assert.rejects(saveArtistProfile(env, { artist: 'Alpha', version: 1, name: 'Beta', img: PNG, imgOverride: true, bioOverride: false, renameTracks: true }, [{ id: videoId(1), artist: 'Alpha' }], before.revision), conflict);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.artists.alpha.name, 'Alpha');
  assert.equal(directory.artists.alpha.bio, 'Keep me');
  assert.equal(directory.artists.alpha.version, 1);
  assert.deepEqual(directory, before);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_track_overrides'), 0);
});

test('concurrent updates cannot leak the losing clear or unlock intentions', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const saved = await saveArtistProfile(env, { artist: 'Artist', img: PNG, bio: 'Manual biography.' });
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  db.beforeBatch = async (statements) => {
    if (!statements[0].sql.startsWith('INSERT INTO artist_profiles')) return;
    if (++arrivals === 2) release();
    await gate;
  };
  const drafts = [
    { img: '', bio: '', imgOverride: true, bioOverride: true },
    { img: saved.artist.img, bio: 'Fallback biography.', imgOverride: false, bioOverride: false },
  ];
  const results = await Promise.allSettled(drafts.map((draft) => saveArtistProfile(env, { artist: 'Artist', version: 1, ...draft })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(conflict(failed.reason));
  const winner = drafts[results.findIndex((result) => result.status === 'fulfilled')];
  const directory = await readArtistDirectory(env);
  for (const field of ['img', 'bio', 'imgOverride', 'bioOverride'] as const) assert.equal(directory.artists.artist[field], winner[field]);
  assert.equal(directory.artists.artist.version, 2);
  assert.equal(directory.revision, saved.directory.revision + 1);
  assert.equal(db.count('artist_images'), 1);
});

test('individual corrections override earlier batch renames; a later intentional rename can replace them', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const initialRevision = (await readArtistDirectory(env)).revision;
  await saveArtistProfile(env, { artist: 'Original', name: 'Renamed', renameTracks: true }, [{ id: videoId(1), artist: 'Original' }, { id: videoId(2), artist: 'Original' }], initialRevision);
  const edited = await saveTrackArtistEdits(env, [{ id: videoId(1), artist: 'Correct Artist' }, { id: videoId(2), artist: 'Renamed' }]);
  assert.equal(edited.trackArtists[videoId(1)], 'Correct Artist');
  assert.equal(edited.trackArtists[videoId(2)], 'Renamed');
  const renamed = await saveArtistProfile(env, { artist: 'Renamed', version: 1, name: 'Final Name', renameTracks: true }, [{ id: videoId(1), artist: 'Correct Artist' }, { id: videoId(2), artist: 'Renamed' }], edited.revision);
  assert.equal(renamed.directory.trackArtists[videoId(1)], 'Correct Artist');
  assert.equal(renamed.directory.trackArtists[videoId(2)], 'Final Name');
  assert.equal(db.count('artist_track_edits'), 1);
});

test('artist profile batch renames leave collaborative credits and another performer untouched', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Anirudh Ravichander', img: PNG, bio: 'Saved profile.' });
  await saveArtistProfile(env, { artist: 'Dhanush', bio: 'A separate performer.' });
  const credits = [
    { id: videoId(0), artist: 'Anirudh Ravichander' },
    { id: videoId(1), artist: 'Anirudh Ravichander & Dhanush' },
    { id: videoId(2), artist: 'Dhanush' },
    { id: videoId(3), artist: 'Anirudh Ravichandran & Dhanush' },
  ];
  const before = await readArtistDirectory(env), raw = JSON.stringify(credits);
  const saved = await saveArtistProfile(env, { artist: 'Anirudh Ravichander', version: 1,
    name: 'Reviewed Anirudh', renameTracks: true }, credits, before.revision);
  assert.equal(saved.renamedTrackCount, 1);
  assert.deepEqual({ ...saved.directory.trackArtists }, { [videoId(0)]: 'Reviewed Anirudh' });
  assert.deepEqual(saved.directory.artists.dhanush, before.artists.dhanush);
  assert.equal(saved.artist.img, before.artists['anirudh ravichander'].img);
  assert.equal(db.count('artist_images'), 1);
  assert.equal(JSON.stringify(credits), raw);
  const collaboratorOnly = await saveArtistProfile(env, { artist: 'Guest Artist', name: 'Renamed Guest', renameTracks: true },
    [{ id: videoId(4), artist: 'Anirudh Ravichander & Guest Artist' }], saved.directory.revision);
  assert.equal(collaboratorOnly.renamedTrackCount, 0);
  assert.deepEqual(collaboratorOnly.directory.trackArtists, saved.directory.trackArtists);
});

test('track edits made while a batch rename is being prepared reject the stale rename', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Artist' });
  const snapshot = await readArtistDirectory(env);
  await saveTrackArtistEdits(env, [{ id: videoId(1), artist: 'Correction' }]);
  await assert.rejects(saveArtistProfile(env, { artist: 'Artist', version: 1, name: 'New Name', img: PNG, imgOverride: true, bioOverride: true, renameTracks: true }, [{ id: videoId(1), artist: 'Artist' }], snapshot.revision), conflict);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.artists.artist.version, 1);
  assert.equal(directory.trackArtists[videoId(1)], 'Correction');
  assert.equal(directory.revision, snapshot.revision + 1);
  assert.equal(directory.artists.artist.imgOverride, false);
  assert.equal(directory.artists.artist.bioOverride, false);
  assert.equal(db.count('artist_images'), 0);
});

test('large rename and metadata batches remain below D1 parameter and query limits', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const initialRevision = (await readArtistDirectory(env)).revision;
  const tracks = Array.from({ length: 1100 }, (_, n) => ({ id: videoId(n), artist: 'Original' }));
  const saved = await saveArtistProfile(env, { artist: 'Original', name: 'New Name', renameTracks: true }, tracks, initialRevision);
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
  const initialRevision = (await readArtistDirectory(env)).revision;
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
  assert.equal(directory.artists.legacy.source, 'admin');
  assert.equal(directory.artists.legacy.imgOverride, true);
  assert.equal(directory.artists.legacy.bioOverride, true);
  assert.equal(directory.artists.legacy.version, 3);
  assert.equal(directory.revision, initialRevision + 3);
  assert.equal(db.count('artist_images'), 2);
});

test('an admin save racing a legacy import owns the profile without leaving imported bytes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const initialRevision = (await readArtistDirectory(env)).revision;
  db.beforeBatch = async (statements) => {
    if (!statements[0].sql.includes("1, 'manifest'")) return;
    db.beforeBatch = undefined;
    await saveArtistProfile(env, { artist: 'Artist', bio: 'Admin owns this', imgOverride: false, bioOverride: false });
  };
  assert.equal((await importLegacyArtistProfile(env, 'Artist', { name: 'Imported Alias', img: PNG, bio: 'Import', updated: 100 })).imported, false);
  const directory = await readArtistDirectory(env);
  assert.equal(directory.artists.artist.bio, 'Admin owns this');
  assert.equal(directory.artists.artist.source, 'admin');
  assert.equal(directory.artists.artist.imgOverride, false);
  assert.equal(directory.artists.artist.bioOverride, false);
  assert.equal(directory.revision, initialRevision + 1);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_aliases'), 1);
});

test('new legacy imports preserve choices and reimports cannot reset existing field intention', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await importLegacyArtistProfile(env, 'Legacy', { img: PNG, bio: '', updated: 100 });
  const first = (await readArtistDirectory(env)).artists.legacy;
  assert.equal(first.source, 'manifest');
  assert.equal(first.imgOverride, true);
  assert.equal(first.bioOverride, false);
  assert.equal(composeArtistMetadata(first, automatic)!.img, first.img);
  assert.equal(composeArtistMetadata(first, automatic)!.bio, automatic.bio);
  await importLegacyArtistProfile(env, 'Legacy', {
    img: PNG, bio: 'New legacy fallback.', updated: 200, imgOverride: false, bioOverride: true,
  });
  const reimported = (await readArtistDirectory(env)).artists.legacy;
  assert.equal(reimported.source, 'manifest');
  assert.equal(reimported.imgOverride, true);
  assert.equal(reimported.bioOverride, false);
  assert.equal(reimported.bio, 'New legacy fallback.');
  await saveArtistProfile(env, { artist: 'Legacy', version: 2, imgOverride: false, bio: '' });
  const before = await readArtistDirectory(env);
  assert.equal((await importLegacyArtistProfile(env, 'Legacy', {
    img: PNG, bio: 'Cannot replace admin.', updated: Date.now() + 10000, imgOverride: true, bioOverride: false,
  })).imported, false);
  assert.deepEqual(await readArtistDirectory(env), before);
  assert.equal(before.artists.legacy.source, 'admin');
  assert.equal(before.artists.legacy.imgOverride, false);
  assert.equal(before.artists.legacy.bioOverride, true);
  assert.equal(db.count('artist_images'), 2);

  await importLegacyArtistProfile(env, 'Explicit Import', { img: PNG, imgOverride: false, bio: '', bioOverride: true, updated: 100 });
  const explicit = (await readArtistDirectory(env)).artists['explicit import'];
  assert.equal(explicit.imgOverride, false);
  assert.equal(explicit.bioOverride, true);
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
  const body = await directory.json();
  assert.equal(body.artists.artist.img, saved.artist.img);
  assert.equal(body.artists.artist.source, 'admin');
  assert.equal(body.artists.artist.imgOverride, true);
  assert.equal(body.artists.artist.bioOverride, false);
  assert.equal((await getDirectory({ env: {} })).status, 503);
});

test('artistSet forwards boolean flags, omissions and clears unchanged and validates them locally', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Artist writes must not use the network.'); });
  const env = { ARTIST_DB: db, GH_TOKEN: 'test-gh-token', GOOGLE_CLIENT_ID: 'test-client-id', ADMIN_PASSWORD: 'test-password' };
  const post = (body: Record<string, unknown>) => adminPost({ request: new Request('https://aura.test/api/admin', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  const login = await post({ action: 'login', email: 'abhinavthewc@gmail.com', password: 'test-password' });
  assert.equal(login.status, 200);
  const credential = (await login.json()).token;
  const set = (body: Record<string, unknown>) => post({ action: 'artistSet', credential, artist: 'Artist', ...body });
  const saved = await set({ img: PNG, bio: '', bioOverride: false });
  assert.equal(saved.status, 200);
  const first = await saved.json();
  assert.equal(first.artist.source, 'admin');
  assert.equal(first.artist.imgOverride, true);
  assert.equal(first.artist.bioOverride, false);
  const unlocked = await set({ version: 1, imgOverride: false });
  assert.equal(unlocked.status, 200);
  const second = await unlocked.json();
  assert.equal(second.artist.img, first.artist.img);
  assert.equal(second.artist.imgOverride, false);
  assert.equal(second.artist.bioOverride, false);
  const untouched = await set({ version: 2, genres: ['Soul'] });
  assert.equal(untouched.status, 200);
  const third = await untouched.json();
  assert.equal(third.artist.imgOverride, false);
  assert.equal(third.artist.bioOverride, false);
  const cleared = await set({ version: 3, img: '', bio: '' });
  assert.equal(cleared.status, 200);
  const fourth = await cleared.json();
  assert.equal(fourth.artist.imgOverride, true);
  assert.equal(fourth.artist.bioOverride, true);
  assert.equal(fourth.artist.img, '');
  assert.equal(fourth.artist.bio, '');
  const before = await readArtistDirectory(env);
  const invalid = await set({ version: 4, img: PNG, imgOverride: 'false' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'imgOverride must be a boolean.');
  assert.deepEqual(await readArtistDirectory(env), before);
  assert.equal(db.count('artist_images'), 1);
  assert.equal(network.mock.calls.length, 0);
});

test('Farmer service credentials cannot read the full library or mutate artist storage', async () => {
  for (const action of ['library', 'artistSet', 'bucketManifestSet', 'bucketManifestBatch']) {
    const response = await adminPost({ request: new Request('https://aura.test/api/admin', { method: 'POST', body: JSON.stringify({ action, service_token: 'test-service-token' }) }), env: { GH_TOKEN: 'test-gh-token', BOT_SERVICE_TOKEN: 'test-service-token' } as any });
    assert.equal(response.status, 403, action);
  }
});
