import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleArtistMetadata, onRequestPost } from '../../functions/api/artist-metadata.js';
import { readArtistDirectory, saveArtistProfile, saveTrackArtistEdits } from '../../functions/lib/artistStore.js';
import { ARTIST_METADATA_POSITIVE_TTL } from '../../functions/lib/artistMetadata.js';
import type { ArtistMetadataStoreOptions } from '../../functions/lib/artistMetadataStore.js';
import { normalizeArtistKey } from '../../lib/artistProfiles.js';
import type { ArtistMetadataResponse } from '../../lib/artistMetadata.js';
import { SqliteD1, videoId } from './sqlite.js';

const START = Date.UTC(2026, 10, 11, 12);
const request = (name: string, init?: RequestInit) => new Request('https://aura.test/api/artist-metadata?name=' + encodeURIComponent(name), init);
const ready = (name: string, now: number): ArtistMetadataResponse => ({ key: normalizeArtistKey(name), status: 'ready', metadata: {
  name: 'Provider display label', entityId: 'Q900010', bio: 'A factual biography.', bioCredit: {
    title: 'Wikidata description', url: 'https://www.wikidata.org/wiki/Q900010', author: 'Wikidata contributors',
    license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  }, fetchedAt: now, expiresAt: now + ARTIST_METADATA_POSITIVE_TTL,
} });

test('the same-origin GET is public, uses the requested normalized key, and has no manual/admin/track mutations', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env = { ARTIST_DB: db };
  await saveArtistProfile(env, { artist: 'Canonical Artist', img: '', bio: '' });
  await saveTrackArtistEdits(env, [{ id: videoId(1), artist: 'Canonical Artist' }]);
  const original = await readArtistDirectory(env);
  let calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => { calls++; return ready(name, START); } };
  const response = await handleArtistMetadata({ request: request('  CANONICAL ARTIST  '), env }, options);
  assert.equal(response.status, 200, 'no admin token, user credentials, or session is required');
  const body = await response.json();
  assert.equal(body.key, normalizeArtistKey('  CANONICAL ARTIST  '));
  assert.equal(body.status, 'ready');
  assert.equal(body.metadata.name, 'Provider display label');
  assert.match(response.headers.get('Cache-Control')!, /^public, max-age=300, s-maxage=300$/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null, 'no cross-origin wildcard API access is advertised');
  assert.deepEqual(await readArtistDirectory(env), original, 'names, clears, flags, versions, aliases and directory revision are untouched');
  assert.equal(db.count('artist_profiles'), 1);
  assert.equal(db.count('artist_aliases'), 1);
  assert.equal(db.count('artist_images'), 0);
  assert.equal(db.count('artist_track_edits'), 1);
  assert.equal(calls, 1);
  const cached = await handleArtistMetadata({ request: request('Canonical Artist', { headers: { Cookie: 'unrelated=value', Authorization: 'Bearer unrelated' } }), env }, options);
  assert.equal(cached.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(await readArtistDirectory(env), original);
});

test('invalid query bounds, duplicate parameters, controls and arbitrary URLs fail before D1/provider work', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let calls = 0, reads = 0;
  const dbWithoutReads = { prepare() { reads++; throw new Error('Invalid query must not read D1'); }, batch: db.batch.bind(db) };
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => { calls++; return ready(name, START); } };
  const urls = [
    'https://aura.test/api/artist-metadata',
    'https://aura.test/api/artist-metadata?name=',
    'https://aura.test/api/artist-metadata?name=A&name=B',
    'https://aura.test/api/artist-metadata?name=A&url=https://example.com',
    'https://aura.test/api/artist-metadata?name=A&action=artistSet',
    ...[' ', 'x'.repeat(121), 'x'.repeat(2049), 'A\u0000B', 'A\nB', 'A\u007fB', 'A\u202eB', 'https://example.com/photo', '//example.com/photo', 'javascript:alert(1)']
      .map((name) => request(name).url),
  ];
  for (const url of urls) {
    const response = await handleArtistMetadata({ request: new Request(url), env: { ARTIST_DB: dbWithoutReads } }, options);
    assert.equal(response.status, 400, url);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).status, 'not-found');
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.equal(db.count('artist_metadata_cache'), 0);
});

test('POST/admin-style bodies and other write methods are rejected without storage mutation', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const original = await readArtistDirectory({ ARTIST_DB: db });
  let calls = 0;
  const options: ArtistMetadataStoreOptions = { provider: async (name) => { calls++; return ready(name, START); } };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await handleArtistMetadata({ request: request('Canonical Artist', { method,
      body: JSON.stringify({ action: 'artistSet', artist: 'Canonical Artist', name: 'Injected rename', bio: 'Injected bio', renameTracks: true }),
    }), env: { ARTIST_DB: db } }, options);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(onRequestPost().status, 405);
  assert.equal(calls, 0);
  assert.equal(db.count('artist_metadata_cache'), 0);
  assert.deepEqual(await readArtistDirectory({ ARTIST_DB: db }), original);
});

test('D1 missing or failed bindings produce bounded 503 JSON, without revealing internal errors', async () => {
  const broken = { prepare() { throw new Error('private infrastructure detail'); }, batch() { throw new Error('private infrastructure detail'); } } as any;
  for (const env of [{}, { ARTIST_DB: broken }]) {
    const response = await handleArtistMetadata({ request: request('Canonical Artist'), env });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.deepEqual(await response.json(), { key: 'canonical artist', status: 'retry', retryAfter: 60 });
  }
});

test('an unresponsive D1 binding returns 503 JSON instead of hanging the page', async () => {
  const stuck = { prepare: () => ({ bind() { return this; }, first: () => new Promise<any>(() => {}), all: () => new Promise<any>(() => {}) }), batch: () => new Promise<any>(() => {}) };
  const response = await handleArtistMetadata({ request: request('Unresponsive Storage'), env: { ARTIST_DB: stuck } }, { storageTimeoutMs: 5 });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { key: 'unresponsive storage', status: 'retry', retryAfter: 60 });
});

test('global budget/pending reads return retry with seconds and no-store, never not-found', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => { calls++; return ready(name, START); } };
  await handleArtistMetadata({ request: request('First Artist'), env: { ARTIST_DB: db } }, options);
  const pending = await handleArtistMetadata({ request: request('Second Artist'), env: { ARTIST_DB: db } }, options);
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get('Cache-Control'), 'no-store');
  assert.equal(pending.headers.get('Retry-After'), '2');
  assert.deepEqual(await pending.json(), { key: 'second artist', status: 'retry', retryAfter: 2 });
  assert.equal(calls, 1);
  assert.equal(db.count('artist_metadata_cache'), 1);
});

test('opened-artist intent reaches the provider but cannot bypass shared rate limits', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START;
  const modes: boolean[] = [];
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name, settings) => {
    modes.push(settings.interactive === true);
    return ready(name, now);
  } };
  const env = { ARTIST_DB: db };
  await handleArtistMetadata({ request: request('Background Artist'), env }, options);
  const headers = { 'X-Aura-Artist-Intent': 'view' };
  const limited = await handleArtistMetadata({ request: request('Opened Artist', { headers }), env }, options);
  assert.equal((await limited.json()).status, 'retry');
  assert.deepEqual(modes, [false]);
  now += 2000;
  const opened = await handleArtistMetadata({ request: request('Opened Artist', { headers }), env }, options);
  assert.equal((await opened.json()).status, 'ready');
  assert.deepEqual(modes, [false, true]);
  await handleArtistMetadata({ request: request('Opened Artist'), env }, options);
  assert.deepEqual(modes, [false, true], 'both modes reuse the same validated cache');
  now += 2000;
  await handleArtistMetadata({ request: request('Other Artist', { headers: { 'X-Aura-Artist-Intent': 'prefetch' } }), env }, options);
  assert.deepEqual(modes, [false, true, false]);
});

test('negative responses have bounded public caching and make no outgoing calls until refresh is due', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => {
    calls++; return { key: normalizeArtistKey(name), status: 'ambiguous' };
  } };
  const first = await handleArtistMetadata({ request: request('Homonym'), env: { ARTIST_DB: db } }, options);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('Cache-Control')!, /public, max-age=300/);
  assert.deepEqual(await first.json(), { key: 'homonym', status: 'ambiguous' });
  await handleArtistMetadata({ request: request('Homonym'), env: { ARTIST_DB: db } }, options);
  assert.equal(calls, 1);
});

test('stale successes have truthful fetchedAt/expiresAt, retryAfter, and no-store HTTP headers', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  let now = START, calls = 0;
  const options: ArtistMetadataStoreOptions = { now: () => now, provider: async (name) => ++calls === 1
    ? ready(name, now) : { key: normalizeArtistKey(name), status: 'retry', retryAfter: 120 } };
  const first = await handleArtistMetadata({ request: request('Stale Artist'), env: { ARTIST_DB: db } }, options);
  const initial = (await first.json()).metadata;
  now += ARTIST_METADATA_POSITIVE_TTL + 1;
  const response = await handleArtistMetadata({ request: request('Stale Artist'), env: { ARTIST_DB: db } }, options);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Retry-After'), '120');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.retryAfter, 120);
  assert.deepEqual(body.metadata, initial);
  assert.ok(body.metadata.expiresAt < now);
});

test('an actual provider fixture crosses the public endpoint without forwarding cookies or authorization', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const calls: { url: URL; headers: Headers }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit) => {
    const url = new URL(String(input)), headers = new Headers(init.headers);
    calls.push({ url, headers });
    assert.equal(url.hostname, 'www.wikidata.org');
    assert.equal(url.searchParams.get('action'), 'wbgetentities');
    assert.equal(url.searchParams.get('ids'), 'Q110969361');
    return Response.json({ entities: { Q110969361: { id: 'Q110969361', type: 'item', labels: { en: { value: 'Sorana' } },
      descriptions: { en: { value: 'Romanian singer and songwriter' } }, aliases: {}, sitelinks: {}, claims: {
        P31: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { id: 'Q5' } } } }],
        P106: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { id: 'Q177220' } } } }],
      },
    } } });
  }) as typeof fetch;
  const response = await handleArtistMetadata({ request: request('SORANA', { headers: {
    Cookie: 'session=not-a-provider-credential', Authorization: 'Bearer not-a-provider-credential',
  } }), env: { ARTIST_DB: db } }, { fetch: fetcher, now: () => START });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.key, 'sorana');
  assert.equal(body.metadata.bioCredit.license, 'CC0 1.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('Cookie'), null);
  assert.equal(calls[0].headers.get('Authorization'), null);
  assert.match(calls[0].headers.get('User-Agent')!, /AuraMusicArtistMetadata\/1\.0/);
});

test('HEAD uses the public contract/cache headers but omits the response body', async (t) => {
  const db = new SqliteD1(); t.after(() => db.close());
  const options: ArtistMetadataStoreOptions = { now: () => START, provider: async (name) => ready(name, START) };
  const response = await handleArtistMetadata({ request: request('Head Artist', { method: 'HEAD' }), env: { ARTIST_DB: db } }, options);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.match(response.headers.get('Cache-Control')!, /public/);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});
