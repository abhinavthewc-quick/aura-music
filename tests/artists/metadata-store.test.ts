import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutomaticArtistMetadata, ArtistMetadataResponse } from '../../lib/artistMetadata.js';
import { normalizeArtistKey } from '../../lib/artistProfiles.js';
import { readArtistDirectory } from '../../functions/lib/artistStore.js';
import { ARTIST_METADATA_NEGATIVE_TTL, ARTIST_METADATA_POSITIVE_TTL } from '../../functions/lib/artistMetadata.js';
import {
  ARTIST_METADATA_DAILY_BUDGET, ARTIST_METADATA_LEASE_MS, ARTIST_METADATA_LOOKUP_INTERVAL,
  readArtistMetadata, type ArtistMetadataStoreOptions,
} from '../../functions/lib/artistMetadataStore.js';
import { SqliteD1 } from './sqlite.js';

const START = Date.UTC(2026, 10, 11, 12);
const DAY = 24 * 60 * 60 * 1000;
function profile(name: string, now: number, bio = 'A factual description.'): AutomaticArtistMetadata {
  return { name, entityId: 'Q900010', bio, bioCredit: {
    title: 'Wikidata description', url: 'https://www.wikidata.org/wiki/Q900010', author: 'Wikidata contributors',
    license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  }, fetchedAt: now, expiresAt: now + ARTIST_METADATA_POSITIVE_TTL };
}
const ready = (name: string, now: number, bio?: string): ArtistMetadataResponse => ({ key: normalizeArtistKey(name), status: 'ready', metadata: profile(name, now, bio) });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const cache = (db: SqliteD1, key: string): any => db.sqlite.prepare('SELECT * FROM artist_metadata_cache WHERE artist_key = ?').get(key);
const budget = (db: SqliteD1): any => db.sqlite.prepare('SELECT * FROM artist_metadata_budget WHERE id = 1').get();
const active = (db: SqliteD1, now: number): number => Number((db.sqlite.prepare('SELECT count(*) AS n FROM artist_metadata_cache WHERE lease_token IS NOT NULL AND lease_until > ?').get(now) as any).n);

test('seven-day positive cache visits make zero outgoing calls and never mutate the manual artist directory', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  const original = await readArtistDirectory(env);
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => { calls++; return ready(name, now); } };
  const first = await readArtistMetadata(env, 'A New Musician', options);
  assert.equal(first.response.status, 'ready');
  assert.equal(first.response.metadata!.expiresAt, START + ARTIST_METADATA_POSITIVE_TTL);
  assert.equal(first.cacheUntil, START + ARTIST_METADATA_POSITIVE_TTL);
  now += ARTIST_METADATA_POSITIVE_TTL - 1;
  for (let i = 0; i < 5; i++) assert.deepEqual(await readArtistMetadata(env, 'A New Musician', options), first);
  assert.equal(calls, 1);
  now++;
  const refreshed = await readArtistMetadata(env, 'A New Musician', options);
  assert.equal(calls, 2);
  assert.equal(refreshed.response.metadata!.fetchedAt, now);
  assert.equal(cache(db, 'a new musician').lease_token, null);
  assert.deepEqual(await readArtistDirectory(env), original);
  for (const table of ['artist_profiles', 'artist_aliases', 'artist_images', 'artist_track_overrides', 'artist_track_edits']) assert.equal(db.count(table), 0);
  assert.ok(db.maxParameters <= 100 && db.maxBatch <= 50);
});

test('not-found and ambiguous results last 24 hours; rate/pending states are not negative cache entries', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => {
    calls++; return { key: normalizeArtistKey(name), status: name === 'Homonym' ? 'ambiguous' : 'not-found' };
  } };
  for (const name of ['Missing', 'Homonym']) {
    const response = await readArtistMetadata({ ARTIST_DB: db }, name, options);
    assert.equal(response.response.status, name === 'Homonym' ? 'ambiguous' : 'not-found');
    assert.equal(response.cacheUntil, now + ARTIST_METADATA_NEGATIVE_TTL);
    assert.equal(cache(db, normalizeArtistKey(name)).metadata_json, null);
    const count = calls;
    now += ARTIST_METADATA_NEGATIVE_TTL - 1;
    assert.deepEqual(await readArtistMetadata({ ARTIST_DB: db }, name, options), response);
    assert.equal(calls, count);
    now++;
    await readArtistMetadata({ ARTIST_DB: db }, name, options);
    assert.equal(calls, count + 1);
    now += ARTIST_METADATA_LOOKUP_INTERVAL;
  }
});

test('global spacing rejects extra cold names without allocating cache rows or consuming the daily budget', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => { calls++; return ready(name, now); } };
  await readArtistMetadata({ ARTIST_DB: db }, 'First', options);
  const pending = await readArtistMetadata({ ARTIST_DB: db }, 'Second', options);
  assert.equal(pending.response.status, 'retry');
  assert.equal(pending.response.retryAfter, 2);
  assert.equal(db.count('artist_metadata_cache'), 1);
  assert.equal(budget(db).jobs_started, 1);
  now += ARTIST_METADATA_LOOKUP_INTERVAL;
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Second', options)).response.status, 'ready');
  for (let i = 0; i < 20; i++) assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Other ' + i, options)).response.status, 'retry');
  assert.equal(calls, 2);
  assert.equal(db.count('artist_metadata_cache'), 2);
  assert.equal(budget(db).jobs_started, 2);
});

test('the durable daily cap resets on the next UTC day, rather than creating false missing artists', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const day = Math.floor(now / DAY) * DAY;
  db.sqlite.prepare('UPDATE artist_metadata_budget SET day_start = ?, jobs_started = ? WHERE id = 1').run(day, ARTIST_METADATA_DAILY_BUDGET);
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => { calls++; return ready(name, now); } };
  const limited = await readArtistMetadata({ ARTIST_DB: db }, 'Cold Artist', options);
  assert.equal(limited.response.status, 'retry');
  assert.equal(limited.response.retryAfter, Math.ceil((day + DAY - now) / 1000));
  assert.equal(calls, 0);
  assert.equal(db.count('artist_metadata_cache'), 0);
  now = day + DAY + 1;
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Cold Artist', options)).response.status, 'ready');
  assert.equal(calls, 1);
  assert.equal(budget(db).day_start, day + DAY);
  assert.equal(budget(db).jobs_started, 1);
});

test('one key has only one active claim, even after the global spacing interval passes', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const started = deferred(), release = deferred(); t.after(() => release.resolve());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => { calls++; started.resolve(); await release.promise; return ready(name, now); } };
  const first = readArtistMetadata({ ARTIST_DB: db }, 'Shared Artist', options);
  await started.promise;
  now += ARTIST_METADATA_LOOKUP_INTERVAL;
  const second = await readArtistMetadata({ ARTIST_DB: db }, '  SHARED ARTIST ', options);
  assert.equal(second.response.status, 'retry');
  assert.equal(calls, 1);
  assert.equal(active(db, now), 1);
  assert.equal(budget(db).jobs_started, 1);
  release.resolve();
  assert.equal((await first).response.status, 'ready');
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Shared Artist', options)).response.status, 'ready');
  assert.equal(calls, 1);
});

test('simultaneous cache-miss readers cannot both reserve a job in D1', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const release = deferred(); t.after(() => release.resolve());
  let arrivals = 0, calls = 0;
  db.beforeBatch = async (statements) => {
    if (!statements[0].sql.startsWith('UPDATE artist_metadata_budget SET\n      jobs_started')) return;
    if (++arrivals === 2) release.resolve();
    await release.promise;
  };
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => { calls++; return ready(name, START); } };
  const responses = await Promise.all([
    readArtistMetadata({ ARTIST_DB: db }, 'Concurrent Artist', options),
    readArtistMetadata({ ARTIST_DB: db }, 'Concurrent Artist', options),
  ]);
  assert.ok(responses.some((result) => result.response.status === 'ready'));
  assert.equal(calls, 1);
  assert.equal(budget(db).jobs_started, 1);
  assert.equal(db.count('artist_metadata_cache'), 1);
});

test('at most two lookup jobs are active across independent callers and different artist keys', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const starts = [deferred(), deferred()], releases = [deferred(), deferred()];
  t.after(() => releases.forEach((gate) => gate.resolve()));
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => {
    const index = calls++; starts[index].resolve(); await releases[index].promise; return ready(name, now);
  } };
  const first = readArtistMetadata({ ARTIST_DB: db }, 'Artist One', { ...options }); await starts[0].promise;
  now += ARTIST_METADATA_LOOKUP_INTERVAL;
  const second = readArtistMetadata({ ARTIST_DB: db }, 'Artist Two', { ...options }); await starts[1].promise;
  now += ARTIST_METADATA_LOOKUP_INTERVAL;
  const third = await readArtistMetadata({ ARTIST_DB: db }, 'Artist Three', { ...options });
  assert.equal(third.response.status, 'retry');
  assert.equal(calls, 2);
  assert.equal(active(db, now), 2);
  assert.equal(cache(db, 'artist three'), undefined);
  releases.forEach((gate) => gate.resolve());
  assert.equal((await first).response.status, 'ready');
  assert.equal((await second).response.status, 'ready');
  assert.equal(active(db, now), 0);
});

test('expired workers cannot overwrite, release, or extend backoff for a newer lease', async (t) => {
  for (const lateError of [false, true]) {
    const db = new SqliteD1(); t.after(() => db.close());
    const starts = [deferred(), deferred()], releases = [deferred(), deferred()];
    t.after(() => releases.forEach((gate) => gate.resolve()));
    let now = START, calls = 0, tokens = 0;
    const options: ArtistMetadataStoreOptions = { now: () => now, token: () => 'test-lease-' + ++tokens, provider: async (name) => {
      const index = calls++; starts[index].resolve(); await releases[index].promise;
      return index === 0 && lateError ? { key: normalizeArtistKey(name), status: 'retry', retryAfter: 1200 } : ready(name, now, index ? 'Winner' : 'Late loser');
    } };
    const first = readArtistMetadata({ ARTIST_DB: db }, 'Lease Artist', options); await starts[0].promise;
    const oldToken = cache(db, 'lease artist').lease_token;
    now += ARTIST_METADATA_LEASE_MS + 1;
    const second = readArtistMetadata({ ARTIST_DB: db }, 'Lease Artist', options); await starts[1].promise;
    const newToken = cache(db, 'lease artist').lease_token;
    assert.notEqual(newToken, oldToken);
    releases[0].resolve();
    assert.equal((await first).response.status, 'retry');
    assert.equal(cache(db, 'lease artist').lease_token, newToken, 'old completion cannot release the replacement');
    assert.equal(budget(db).blocked_until, 0, 'old failure cannot impose a cooldown');
    releases[1].resolve();
    assert.equal((await second).response.metadata!.bio, 'Winner');
    assert.equal(JSON.parse(cache(db, 'lease artist').metadata_json).bio, 'Winner');
    assert.equal(budget(db).jobs_started, 2);
  }
});

test('expired completion is fenced even without a replacement worker, and the slot is recoverable', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const started = deferred(), release = deferred(); t.after(() => release.resolve());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => {
    if (++calls === 1) { started.resolve(); await release.promise; }
    return ready(name, now);
  } };
  const first = readArtistMetadata({ ARTIST_DB: db }, 'Expired Artist', options); await started.promise;
  now += ARTIST_METADATA_LEASE_MS + 1;
  release.resolve();
  const late = await first;
  assert.equal(late.response.status, 'retry');
  assert.equal(late.response.metadata, undefined);
  assert.equal(cache(db, 'expired artist').metadata_json, null);
  assert.equal(active(db, now), 0);
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Expired Artist', options)).response.status, 'ready');
  assert.equal(calls, 2);
});

test('transient outages retain stale success timestamps and communicate durable per-key and global backoff', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => ++calls === 1
    ? ready(name, now) : { key: normalizeArtistKey(name), status: 'retry', retryAfter: 90 } };
  const first = (await readArtistMetadata({ ARTIST_DB: db }, 'Stale Artist', options)).response.metadata!;
  now += ARTIST_METADATA_POSITIVE_TTL + 1;
  const stale = await readArtistMetadata({ ARTIST_DB: db }, 'Stale Artist', options);
  assert.equal(stale.response.status, 'ready');
  assert.deepEqual(stale.response.metadata, first);
  assert.equal(stale.response.retryAfter, 90);
  assert.equal(stale.cacheUntil, undefined);
  assert.ok(stale.response.metadata!.expiresAt < now);
  assert.equal(cache(db, 'stale artist').status, 'ready');
  assert.equal(cache(db, 'stale artist').retry_at, now + 90_000);
  assert.equal(budget(db).blocked_until, now + 90_000);
  now += 1000;
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Stale Artist', options)).response.retryAfter, 89);
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Other Cold Artist', options)).response.status, 'retry');
  assert.equal(calls, 2);
  assert.equal(db.count('artist_metadata_cache'), 1);
});

test('repeated transient failures back off exponentially, including zero Retry-After, without a 24-hour negative', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => {
    calls++; return { key: normalizeArtistKey(name), status: 'retry', retryAfter: 0 };
  } };
  for (const delay of [30, 60, 120]) {
    const result = await readArtistMetadata({ ARTIST_DB: db }, 'Busy Artist', options);
    assert.equal(result.response.status, 'retry');
    assert.equal(result.response.retryAfter, delay);
    const row = cache(db, 'busy artist');
    assert.equal(row.status, 'retry');
    assert.equal(row.expires_at, 0);
    assert.equal(row.lease_token, null);
    now += delay * 1000;
  }
  assert.equal(calls, 3);
});

test('a later successful refresh replaces the stale snapshot and clears per-key failure state', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => ++calls === 2
    ? { key: normalizeArtistKey(name), status: 'retry', retryAfter: 60 } : ready(name, now, 'Snapshot ' + calls) };
  await readArtistMetadata({ ARTIST_DB: db }, 'Recovering Artist', options);
  now += ARTIST_METADATA_POSITIVE_TTL;
  await readArtistMetadata({ ARTIST_DB: db }, 'Recovering Artist', options);
  now += 60_000;
  const recovered = await readArtistMetadata({ ARTIST_DB: db }, 'Recovering Artist', options);
  assert.equal(recovered.response.metadata!.bio, 'Snapshot 3');
  assert.equal(recovered.response.metadata!.fetchedAt, now);
  assert.equal(recovered.response.retryAfter, undefined);
  assert.equal(cache(db, 'recovering artist').failures, 0);
  assert.equal(cache(db, 'recovering artist').retry_at, 0);
});

test('initial partial success is usable and schedules an early retry, rather than hiding missing fields for seven days', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => {
    const result = ready(name, now); if (++calls === 1) result.retryAfter = 60; return result;
  } };
  const first = await readArtistMetadata({ ARTIST_DB: db }, 'Partial Artist', options);
  assert.equal(first.response.status, 'ready');
  assert.equal(first.response.retryAfter, 60);
  assert.equal(first.response.metadata!.expiresAt, now + ARTIST_METADATA_POSITIVE_TTL);
  assert.equal(first.cacheUntil, undefined);
  now += 59_000;
  await readArtistMetadata({ ARTIST_DB: db }, 'Partial Artist', options);
  assert.equal(calls, 1);
  now += 1000;
  const complete = await readArtistMetadata({ ARTIST_DB: db }, 'Partial Artist', options);
  assert.equal(calls, 2);
  assert.equal(complete.response.retryAfter, undefined);
  assert.equal(complete.response.metadata!.fetchedAt, now);
});

test('a partial refresh cannot drop an old portrait or make retained fields falsely fresh', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const complete = profile('Partial Refresh Artist', now, 'Original bio');
  complete.img = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Portrait.jpg';
  complete.imageCredit = { title: 'Portrait.jpg', url: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg', author: 'Creator', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/' };
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => ++calls === 1
    ? { key: normalizeArtistKey(name), status: 'ready', metadata: complete }
    : { ...ready(name, now, 'New partial bio'), retryAfter: 60 } };
  await readArtistMetadata({ ARTIST_DB: db }, complete.name, options);
  now += ARTIST_METADATA_POSITIVE_TTL;
  const retained = await readArtistMetadata({ ARTIST_DB: db }, complete.name, options);
  assert.deepEqual(retained.response.metadata, complete);
  assert.equal(retained.response.retryAfter, 60);
  assert.equal(cache(db, 'partial refresh artist').fetched_at, START);
});

test('a newly verified different identity never inherits the old identity portrait on a partial refresh', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const original = profile('Changing Artist', now);
  original.img = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Portrait.jpg';
  original.imageCredit = { title: 'Portrait.jpg', url: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg', author: 'Creator', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/' };
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => {
    if (++calls === 1) return { key: normalizeArtistKey(name), status: 'ready', metadata: original };
    const newer = profile(name, now, 'New identity'); newer.entityId = 'Q900011'; newer.bioCredit!.url = 'https://www.wikidata.org/wiki/Q900011';
    return { key: normalizeArtistKey(name), status: 'ready', metadata: newer, retryAfter: 60 };
  } };
  await readArtistMetadata({ ARTIST_DB: db }, original.name, options);
  now += ARTIST_METADATA_POSITIVE_TTL;
  const result = await readArtistMetadata({ ARTIST_DB: db }, original.name, options);
  assert.equal(result.response.metadata!.entityId, 'Q900011');
  assert.equal(result.response.metadata!.img, undefined);
  assert.equal(result.response.metadata!.fetchedAt, now);
});

test('first-primary sessions are used when available and bare ArtistDatabase bindings remain compatible', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const bare = { prepare: db.prepare.bind(db), batch: db.batch.bind(db) };
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => ready(name, START) };
  assert.equal((await readArtistMetadata({ ARTIST_DB: bare }, 'Session Artist', options)).response.status, 'ready');
  const constraints: string[] = [];
  const session = { ...bare, withSession: (constraint: string) => { constraints.push(constraint); return bare; } };
  assert.equal((await readArtistMetadata({ ARTIST_DB: session }, 'Session Artist', options)).response.status, 'ready');
  assert.deepEqual(constraints, ['first-primary']);
});

test('malformed automatic cache payloads are repaired without exposing unsafe URLs', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => { calls++; return ready(name, now); } };
  await readArtistMetadata({ ARTIST_DB: db }, 'Corrupt Cache Artist', options);
  db.sqlite.prepare('UPDATE artist_metadata_cache SET metadata_json = ? WHERE artist_key = ?').run('{"img":"https://evil.example/image"}', 'corrupt cache artist');
  now += ARTIST_METADATA_LOOKUP_INTERVAL;
  const repaired = await readArtistMetadata({ ARTIST_DB: db }, 'Corrupt Cache Artist', options);
  assert.equal(repaired.response.status, 'ready');
  assert.equal(repaired.response.metadata!.img, undefined);
  assert.equal(calls, 2);
  const badLicense = profile('Corrupt Cache Artist', now);
  badLicense.bioCredit!.licenseUrl = 'https://creativecommons.org/licenses/by-nc/4.0/';
  db.sqlite.prepare('UPDATE artist_metadata_cache SET metadata_json = ? WHERE artist_key = ?').run(JSON.stringify(badLicense), 'corrupt cache artist');
  now += ARTIST_METADATA_LOOKUP_INTERVAL;
  const credited = await readArtistMetadata({ ARTIST_DB: db }, 'Corrupt Cache Artist', options);
  assert.equal(credited.response.metadata!.bioCredit!.license, 'CC0 1.0');
  assert.equal(credited.response.metadata!.bioCredit!.licenseUrl, 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(calls, 3);
});

test('D1 unavailability returns a graceful retry result and never calls the provider', async () => {
  let calls = 0;
  const result = await readArtistMetadata({}, 'Artist', { provider: async (name) => { calls++; return ready(name, START); } });
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.response, { key: 'artist', status: 'retry', retryAfter: 60 });
  assert.equal(calls, 0);
});

test('bounded lookup timeouts abort the worker and release its durable lease into backoff', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let signal: AbortSignal | undefined;
  const result = await readArtistMetadata({ ARTIST_DB: db }, 'Slow Artist', { now: () => START, lookupTimeoutMs: 10,
    provider: async (_name, options) => { signal = options.signal; return await new Promise<ArtistMetadataResponse>(() => {}); },
  });
  assert.equal(result.response.status, 'retry');
  assert.equal(signal!.aborted, true);
  assert.equal(cache(db, 'slow artist').lease_token, null);
  assert.equal(active(db, START), 0);
  assert.ok(cache(db, 'slow artist').retry_at > START);
});

test('a D1 completion outage serves the previous good snapshot, not an unfenced new result', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => ready(name, now, 'Snapshot ' + ++calls) };
  const first = (await readArtistMetadata({ ARTIST_DB: db }, 'Database Outage Artist', options)).response.metadata!;
  now += ARTIST_METADATA_POSITIVE_TTL;
  db.beforeBatch = async (statements) => { if (statements[0].sql.startsWith('UPDATE artist_metadata_cache SET status')) throw new Error('Fixture database outage'); };
  const failed = await readArtistMetadata({ ARTIST_DB: db }, 'Database Outage Artist', options);
  assert.equal(failed.response.status, 'ready');
  assert.deepEqual(failed.response.metadata, first);
  assert.equal(failed.response.retryAfter, 60);
  assert.equal(failed.cacheUntil, undefined);
});

test('an unresponsive D1 read is bounded and never starts provider work', async () => {
  let calls = 0;
  const stuck = { prepare: () => ({ bind() { return this; }, first: () => new Promise<any>(() => {}), all: () => new Promise<any>(() => {}) }),
    batch: () => new Promise<any>(() => {}),
  };
  const result = await readArtistMetadata({ ARTIST_DB: stuck }, 'Unresponsive Storage', {
    now: () => START, storageTimeoutMs: 5, provider: async (name) => { calls++; return ready(name, START); },
  });
  assert.equal(result.unavailable, true);
  assert.equal(result.response.status, 'retry');
  assert.equal(calls, 0);
});

test('a late D1 claim cannot start provider work after the request stopped waiting', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const release = deferred(); t.after(() => release.resolve());
  let now = START, calls = 0;
  const slow = { prepare: db.prepare.bind(db), batch: async <T>(statements: any[]) => {
    const result = await db.batch<T>(statements); await release.promise; return result;
  } };
  const options: ArtistMetadataStoreOptions = { now: () => now, storageTimeoutMs: 5, provider: async (name) => { calls++; return ready(name, now); } };
  const result = await readArtistMetadata({ ARTIST_DB: slow }, 'Delayed Claim', options);
  assert.equal(result.unavailable, true);
  assert.equal(calls, 0);
  release.resolve();
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(active(db, now), 1, 'the abandoned lease expires; it cannot permanently leak a slot');
  now += ARTIST_METADATA_LEASE_MS + 1;
  assert.equal((await readArtistMetadata({ ARTIST_DB: db }, 'Delayed Claim', options)).response.status, 'ready');
  assert.equal(calls, 1);
});

test('the total request deadline aborts even a non-cooperating provider and fences its uncached result', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let signal: AbortSignal | undefined;
  const result = await readArtistMetadata({ ARTIST_DB: db }, 'Overall Deadline', { now: () => START, deadlineMs: 10,
    provider: async (_name, options) => { signal = options.signal; return await new Promise<ArtistMetadataResponse>(() => {}); },
  });
  assert.equal(result.response.status, 'retry');
  assert.equal(result.response.metadata, undefined);
  assert.equal(signal!.aborted, true);
  assert.equal(cache(db, 'overall deadline').metadata_json, null);
});
