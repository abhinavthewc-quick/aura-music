import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtistProfile } from '../../lib/artistProfiles.js';
import { normalizeArtistKey } from '../../lib/artistProfiles.js';
import { composeArtistMetadata, type AutomaticArtistMetadata } from '../../lib/artistMetadata.js';
import { buildArtistGroups, selectArtist, resolveArtistSelection } from '../../src/core/artistGroups.js';
import { trackKey } from '../../src/core/trackIdentity.js';
import {
  ARTIST_METADATA_CACHE_KEY, artistMetadataCreditHTML, createArtistMetadataClient,
  createArtistMetadataDraft, editArtistMetadataDraft, safeArtistMetadataUrl,
  useAutomaticArtistMetadataDraft, validateArtistMetadataResponse, validateAutomaticArtistMetadata,
} from '../../src/core/artistMetadata.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };

class Clock {
  at = NOW;
  serial = 0;
  jobs = new Map<number, { at: number; callback: () => void }>();
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.serial;
    this.jobs.set(id, { at: this.at + Math.max(0, delay), callback });
    return id;
  };
  cancel = (handle: unknown) => { this.jobs.delete(handle as number); };
  async advance(ms = 0) {
    const end = this.at + ms;
    await flush();
    for (let turns = 0; ; turns++) {
      if (turns > 10000) throw new Error('Scheduler is spinning instead of waiting.');
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = Math.max(this.at, next[1].at);
      this.jobs.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.at = end;
    await flush();
  }
}

const automatic = (name = 'Artist', at = NOW, fields: Partial<AutomaticArtistMetadata> = {}): AutomaticArtistMetadata => ({
  name, entityId: 'Q42', img: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg', bio: 'Verified biography.',
  imageCredit: { title: 'Artist portrait', url: 'https://commons.wikimedia.org/wiki/File:Artist.jpg', author: 'Photographer', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  bioCredit: { title: 'Artist article', url: 'https://en.wikipedia.org/wiki/Artist', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  fetchedAt: at, expiresAt: at + 7 * DAY, ...fields,
});
const ready = (name = 'Artist', at = NOW, fields: Partial<AutomaticArtistMetadata> = {}) => ({
  key: normalizeArtistKey(name), status: 'ready', metadata: automatic(name, at, fields),
});
const cached = (name: string, metadata = automatic(name, NOW - 1000), overrides = {}) => ({
  key: normalizeArtistKey(name), name, status: 'ready', metadata,
  checkedAt: NOW - 1000, nextRequestAt: metadata.expiresAt, usedAt: NOW - 1000, failures: 0, ...overrides,
});
const savedCache = (entries: unknown[]) => JSON.stringify({ v: 1, entries });

type FixtureRequest = { name: string; url: string; init: RequestInit; resolve: (response: Response) => void };
function harness(options: { raw?: string; reply?: (name: string, count: number, clock: Clock) => Response; ignoreAbort?: boolean; idle?: boolean } = {}) {
  const clock = new Clock(), stored = new Map<string, string>(), writes: string[] = [], requests: FixtureRequest[] = [];
  if (options.raw !== undefined) stored.set(ARTIST_METADATA_CACHE_KEY, options.raw);
  const context = { session: { email: 'listener@example.test', token: 'fixture' } as { email: string; token: string } | null,
    visible: true, online: true, gate: true, sessionChecks: 0 };
  const events: { keys: string[]; displayChanged: boolean }[] = [];
  const storage = { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); stored.set(key, value); } };
  const client = createArtistMetadataClient({
    storage, now: () => clock.at, schedule: clock.schedule, cancel: clock.cancel,
    ...(options.idle ? { idle: callback => clock.schedule(callback, 1), cancelIdle: clock.cancel } : {}),
    session: () => { context.sessionChecks++; return context.session; },
    visible: () => context.visible, online: () => context.online,
    emit: (keys, displayChanged) => events.push({ keys, displayChanged }),
    fetch: ((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const name = new URL(url, 'https://aura.example').searchParams.get('name')!;
      const request = { name, url, init, resolve };
      requests.push(request);
      if (!options.ignoreAbort) init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      if (options.reply) resolve(options.reply(name, requests.length, clock));
    })) as typeof fetch,
  });
  return { client, clock, context, events, storage, stored, writes, requests,
    start: () => client.start(() => context.gate) };
}

test('metadata and attribution validation accepts partial fields but rejects active URLs and malformed payloads', () => {
  for (const fields of [{ img: undefined, imageCredit: undefined }, { bio: undefined, bioCredit: undefined }]) {
    assert.ok(validateAutomaticArtistMetadata(automatic('Artist', NOW, fields), NOW));
  }
  assert.equal(safeArtistMetadataUrl('/api/artist-image?id=portrait.png', true), '/api/artist-image?id=portrait.png');
  assert.ok(safeArtistMetadataUrl("https://example.test/Artist's_portrait.jpg", true));
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'http://example.test/picture', '//example.test/picture',
    'https://user:password@example.test/picture', 'https://example.test/with space', '/unexpected/image', '/api/artist-image?id=one#two']) {
    assert.equal(safeArtistMetadataUrl(url, true), undefined, url);
  }
  for (const fields of [{ name: '' }, { entityId: '<script>' }, { fetchedAt: NOW + 300001 }, { expiresAt: NOW - 1 },
    { bio: 'x'.repeat(2001) }, { bio: 'bad\u0000text' }, { img: 'javascript:alert(1)' },
    { imageCredit: { title: 'Credit', url: 'https://example.test', licenseUrl: 'javascript:alert(1)' } },
    { bioCredit: { title: 'x'.repeat(257), url: 'https://example.test' } }]) {
    assert.equal(validateAutomaticArtistMetadata(automatic('Artist', NOW, fields), NOW), undefined);
  }
  const response = ready();
  assert.ok(validateArtistMetadataResponse(response, 'artist', NOW));
  for (const override of [{ key: 'other artist' }, { status: ['ready'] }, { status: 'not-found' }, { metadata: null },
    { retryAfter: -1 }, { retryAfter: Infinity }, { retryAfter: 30 * 24 * 3600 + 1 }]) {
    assert.equal(validateArtistMetadataResponse({ ...response, ...override }, 'artist', NOW), undefined);
  }
});

test('cache restoration is lazy, validated, and does not write artist directories or playlists', async () => {
  const old = automatic('Artist', NOW - 8 * DAY);
  const valid = cached('Artist', old, { nextRequestAt: NOW - 1 });
  const negative = cached('Missing', undefined, { status: 'not-found', metadata: undefined, nextRequestAt: NOW + DAY });
  const h = harness({ raw: savedCache([valid, negative,
    cached('Ambiguous', old, { status: 'ambiguous', nextRequestAt: NOW + DAY }),
    { ...valid, key: 'wrong key' }, { ...valid, name: 'Corrupt', key: 'corrupt', failures: '0' },
    { ...valid, name: 'Future', key: 'future', checkedAt: NOW + 300001 },
    { ...valid, name: 'Unsafe', key: 'unsafe', metadata: { ...old, img: 'javascript:alert(1)' } },
  ]) });
  assert.deepEqual(h.client.getMetadata('ARTIST'), old, 'expired verified data remains available before a refresh');
  assert.equal(h.client.getResponse('Missing')?.status, 'not-found');
  assert.equal(h.client.getMetadata('Ambiguous'), undefined, 'old/corrupt negative rows cannot display a portrait');
  for (const name of ['Corrupt', 'Future', 'Unsafe']) assert.equal(h.client.getResponse(name), undefined);
  h.context.session = null;
  h.client.setCatalog(['Artist', 'Missing']);
  h.client.prioritize('Artist', 'open');
  h.start();
  await h.clock.advance(60000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
  h.context.session = { email: 'listener@example.test', token: 'fixture' };
  h.client.wake();
  await h.clock.advance();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(Response.json(ready('Artist', h.clock.at)));
  await h.clock.advance();
  assert.deepEqual([...new Set(h.writes)], [ARTIST_METADATA_CACHE_KEY]);
  h.client.stop();
});

test('malformed, oversized UTF-8, and unavailable storage never prevent a neutral client', () => {
  const oversized = savedCache(Array.from({ length: 200 }, (_, index) => cached('Large ' + index, automatic('Large ' + index, NOW, { bio: '藝'.repeat(2000) }))));
  assert.ok(oversized.length < 1024 * 1024 && new TextEncoder().encode(oversized).byteLength > 1024 * 1024);
  for (const raw of ['{broken', '{"v":2,"entries":[]}', oversized]) {
    const h = harness({ raw });
    assert.equal(h.client.getMetadata('Large 0'), undefined);
    assert.equal(h.client.getRevision(), 0);
    assert.equal(h.requests.length, 0);
  }
  const client = createArtistMetadataClient({ storage: { getItem() { throw new Error('Private storage'); }, setItem() { throw new Error('Quota'); } } });
  assert.equal(client.getMetadata('Artist'), undefined);
  assert.equal(client.getRevision(), 0);
});

test('lookups are single-flight, same-origin GETs and limited to two active requests', async () => {
  const h = harness();
  h.client.prioritize(['  Ａrtist One  ', 'Artist Two', 'Artist Three'], 'open');
  h.client.prioritize('artist one');
  await h.clock.advance();
  assert.equal(h.requests.length, 0, 'prioritization alone cannot start the runtime');
  h.start();
  await h.clock.advance();
  assert.deepEqual(h.requests.map(request => request.name), ['Artist One', 'Artist Two']);
  h.client.prioritize('Artist One', 'open');
  await h.clock.advance();
  assert.equal(h.requests.length, 2);
  const init = h.requests[0].init;
  assert.equal(init.method, 'GET');
  assert.equal(init.mode, 'same-origin');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body, undefined);
  assert.deepEqual(init.headers, { 'X-Aura-Artist-Intent': 'view' }, 'an explicit open sends only its public view intent, never a credential');
  assert.match(h.requests[0].url, /^\/api\/artist-metadata\?name=/);
  h.requests[0].resolve(Response.json(ready('Artist One')));
  await h.clock.advance();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].name, 'Artist Three');
  h.client.stop();
});

test('current and visible artists precede idle work in an ordinary 176-credit library', async () => {
  const h = harness({ idle: true });
  h.client.setCatalog(Array.from({ length: 176 }, (_, index) => 'Catalogue Artist ' + index));
  h.client.prioritize('Visible Artist');
  h.client.prioritize('Current Artist', 'open');
  h.start();
  await h.clock.advance();
  assert.deepEqual(h.requests.map(request => request.name), ['Current Artist', 'Visible Artist']);
  assert.deepEqual(h.requests[0].init.headers, { 'X-Aura-Artist-Intent': 'view' });
  assert.equal(h.requests[1].init.headers, undefined, 'being visible is not an interactive provider request');
  h.requests.forEach(request => request.resolve(Response.json({ key: normalizeArtistKey(request.name), status: 'not-found' })));
  await h.clock.advance(1);
  assert.equal(h.requests.length, 4, 'only a small idle batch is started, not the full catalogue');
  assert.ok(h.requests.slice(2).every(request => request.init.headers === undefined));
  h.requests.slice(2).forEach(request => request.resolve(Response.json({ key: normalizeArtistKey(request.name), status: 'not-found' })));
  await h.clock.advance(1499);
  assert.equal(h.requests.length, 4);
  await h.clock.advance(2);
  assert.equal(h.requests.length, 6);
  h.client.stop();
});

test('promoting an already queued visible artist preserves explicit view intent for only that artist', async () => {
  const h = harness();
  h.client.prioritize(['Promoted Artist', 'Visible Artist']);
  h.client.prioritize('Promoted Artist', 'open');
  h.start(); await h.clock.advance();
  assert.deepEqual(h.requests.map(request => request.name), ['Promoted Artist', 'Visible Artist']);
  assert.deepEqual(h.requests[0].init.headers, { 'X-Aura-Artist-Intent': 'view' });
  assert.equal(h.requests[1].init.headers, undefined);
  h.client.stop();
});

test('opening an in-flight visible artist remains single-flight and promotes a later retry to view intent', async () => {
  const h = harness();
  h.client.prioritize('Artist'); h.start(); await h.clock.advance();
  assert.equal(h.requests[0].init.headers, undefined);
  h.client.prioritize('Artist', 'open'); await h.clock.advance();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(Response.json({ key: 'artist', status: 'retry' }));
  await h.clock.advance(30000);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].init.headers, { 'X-Aura-Artist-Intent': 'view' });
  h.client.stop();
});

test('pending foreground work is bounded and a current artist can displace a visible tail', async () => {
  const h = harness({ reply: name => Response.json({ key: normalizeArtistKey(name), status: 'not-found' }) });
  h.client.prioritize(Array.from({ length: 100 }, (_, index) => 'Visible ' + index));
  h.client.prioritize('Open Artist', 'open');
  h.start();
  await h.clock.advance();
  assert.equal(h.requests.length, 32);
  assert.equal(h.requests[0].name, 'Open Artist');
  assert.ok(!h.requests.some(request => request.name === 'Visible 31'));
  h.client.stop();
});

test('the live session and admin-style gate are checked again before each request', async () => {
  const h = harness();
  h.client.prioritize(['First', 'Second'], 'open');
  h.context.gate = false;
  h.start();
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 0);
  h.context.gate = true;
  h.start();
  const original = h.context.session;
  let checks = 0;
  const issued: string[] = [];
  // Expire the session synchronously when the first fetch is issued. The
  // second request in the same pump must not trust its initial session hint.
  const client = createArtistMetadataClient({ storage: h.storage, schedule: h.clock.schedule, cancel: h.clock.cancel, now: () => h.clock.at,
    session: () => { checks++; return h.context.session; },
    fetch: (async (url: string) => {
      const name = new URL(url, 'https://aura.example').searchParams.get('name')!;
      issued.push(name);
      if (issued.length === 1) h.context.session = null;
      return Response.json({ key: normalizeArtistKey(name), status: 'not-found' });
    }) as typeof fetch });
  h.client.stop();
  client.prioritize(['First', 'Second'], 'open');
  client.start();
  await h.clock.advance();
  assert.deepEqual(issued, ['First']);
  assert.ok(checks >= 4);
  assert.equal(client.getResponse('First'), undefined, 'a response cannot populate the cache after sign-out');
  assert.equal(client.getResponse('Second'), undefined);
  h.context.session = original;
  client.wake();
  await h.clock.advance();
  assert.ok(issued.includes('Second'));
  assert.equal(client.getResponse('Second')?.status, 'not-found');
  client.stop();
});

test('visibility and connectivity pause the queue without discarding pending artists', async () => {
  const h = harness();
  h.client.prioritize(['One', 'Two', 'Three'], 'open');
  h.context.visible = false;
  h.start();
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 0);
  h.context.visible = true;
  h.context.online = false;
  h.client.wake();
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 0);
  h.context.online = true;
  h.client.wake();
  await h.clock.advance();
  assert.equal(h.requests.length, 2);
  h.context.visible = false;
  h.requests.forEach(request => request.resolve(Response.json(ready(request.name, h.clock.at))));
  await h.clock.advance(5000);
  assert.equal(h.requests.length, 2);
  h.context.visible = true;
  h.client.wake();
  await h.clock.advance();
  assert.equal(h.requests.length, 3);
  h.client.stop();
});

test('Retry-After headers and bodies are honored, then negative tombstones survive repeated paints', async () => {
  const h = harness({ reply: (name, count) => count === 1
    ? Response.json({ key: normalizeArtistKey(name), status: 'retry', retryAfter: 120 }, { headers: { 'Retry-After': '180' } })
    : Response.json({ key: normalizeArtistKey(name), status: 'not-found' }) });
  h.client.prioritize('Artist', 'open');
  h.start();
  await h.clock.advance();
  assert.equal(h.client.getResponse('Artist')?.retryAfter, 180);
  for (let paint = 0; paint < 20; paint++) h.client.prioritize('Artist');
  await h.clock.advance(179999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  for (let paint = 0; paint < 20; paint++) { h.client.prioritize('Artist'); h.client.setCatalog(['Artist']); }
  await h.clock.advance(DAY - 1);
  assert.equal(h.requests.length, 2);
  await h.clock.advance(1);
  h.client.prioritize('Artist', 'open');
  await h.clock.advance();
  assert.equal(h.requests.length, 3);
  assert.ok(h.events.every(event => !event.displayChanged), 'negative/retry statuses update admin previews without public repaints');
  h.client.stop();
});

test('unavailable lookups have a three-attempt cycle and a bounded cooldown', async () => {
  const h = harness({ reply: name => Response.json({ key: normalizeArtistKey(name), status: 'retry' }) });
  h.client.prioritize('Artist', 'open');
  h.start();
  await h.clock.advance(90000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.client.getResponse('Artist')?.retryAfter, 3600);
  for (let paint = 0; paint < 20; paint++) h.client.prioritize('Artist');
  await h.clock.advance(3599999);
  assert.equal(h.requests.length, 3);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 4, 'later explicit interest permits a new bounded cycle');
  h.client.stop();
});

test('request timeouts free the single-flight slot and back off rather than spinning', async () => {
  const h = harness();
  h.client.prioritize('Artist', 'open');
  h.start();
  await h.clock.advance(24999);
  assert.equal(h.requests[0].init.signal?.aborted, false);
  await h.clock.advance(1);
  assert.equal(h.requests[0].init.signal?.aborted, true);
  assert.equal(h.client.getResponse('Artist')?.status, 'retry');
  await h.clock.advance(29999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  h.client.stop();
});

test('a slow valid response is accepted beyond the API deadline and cancels the browser timeout', async () => {
  const h = harness();
  h.client.prioritize('Artist', 'open'); h.start();
  await h.clock.advance(22000);
  assert.equal(h.requests[0].init.signal?.aborted, false);
  h.requests[0].resolve(Response.json(ready('Artist', h.clock.at)));
  await h.clock.advance();
  assert.equal(h.client.getResponse('Artist')?.status, 'ready');
  await h.clock.advance(3000);
  assert.equal(h.requests[0].init.signal?.aborted, false, 'the finished request does not retain a timeout');
  assert.equal(h.requests.length, 1);
  h.client.stop();
});

test('stale ready responses with Retry-After retain verified fields while taking the retry path', async () => {
  const stale = automatic('Artist', NOW - 8 * DAY);
  const h = harness({ raw: savedCache([cached('Artist', stale, { nextRequestAt: NOW - 1 })]),
    reply: (name, count, clock) => count === 1 ? Response.json({ key: normalizeArtistKey(name), status: 'ready', metadata: stale, retryAfter: 60 })
      : Response.json(ready(name, clock.at)) });
  const revision = h.client.getRevision();
  h.client.prioritize('Artist', 'open');
  h.start();
  await h.clock.advance();
  assert.deepEqual(h.client.getMetadata('Artist'), stale);
  assert.equal(h.client.getResponse('Artist')?.status, 'retry');
  assert.equal(h.client.getRevision(), revision);
  await h.clock.advance(60000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.client.getResponse('Artist')?.status, 'ready');
  assert.equal(h.client.getMetadata('Artist')?.fetchedAt, h.clock.at);
  assert.equal(h.client.getRevision(), revision, 'timestamp-only refreshes do not repaint identical display fields');
  h.client.stop();
});

test('definitive not-found or ambiguous matches remove automatic fields, not manual fallbacks', async () => {
  for (const status of ['not-found', 'ambiguous']) {
    const stale = automatic('Artist', NOW - 8 * DAY);
    const h = harness({ raw: savedCache([cached('Artist', stale, { nextRequestAt: NOW - 1 })]),
      reply: name => Response.json({ key: normalizeArtistKey(name), status }) });
    h.client.prioritize('Artist', 'open'); h.start();
    await h.clock.advance();
    assert.equal(h.client.getMetadata('Artist'), undefined);
    const profile = { img: '/api/artist-image?id=manual.jpg', bio: 'Manual text', imgOverride: true, bioOverride: true };
    assert.deepEqual(composeArtistMetadata(profile, h.client.getMetadata('Artist')), profile);
    assert.ok(h.events.some(event => event.displayChanged));
    h.client.stop();
  }
});

test('320-entry LRU eviction changes the revision and includes evicted successful artists in its event', async () => {
  const entries = Array.from({ length: 320 }, (_, index) => cached('Cached ' + index, automatic('Cached ' + index, NOW - 1000), { usedAt: NOW - 1000 - index }));
  const h = harness({ raw: savedCache(entries), reply: name => Response.json(ready(name)) });
  h.client.getMetadata('Cached 319'); // keep the least-recent artist that is now visible
  const revision = h.client.getRevision();
  h.client.prioritize('New Artist', 'open'); h.start();
  await h.clock.advance();
  const stored = JSON.parse(h.stored.get(ARTIST_METADATA_CACHE_KEY)!);
  assert.equal(stored.entries.length, 320);
  assert.ok(h.client.getMetadata('Cached 319'));
  assert.equal(h.client.getMetadata('Cached 318'), undefined);
  assert.equal(h.client.getRevision(), revision + 1);
  assert.ok(h.events.some(event => event.displayChanged && event.keys.includes('cached 318') && event.keys.includes('new artist')));
  h.client.stop();
});

test('cross-tab merging is bounded in memory and does not write storage-event feedback', () => {
  const first = Array.from({ length: 320 }, (_, index) => cached('First ' + index));
  const next = Array.from({ length: 320 }, (_, index) => cached('Next ' + index, automatic('Next ' + index), { checkedAt: NOW, usedAt: NOW }));
  const h = harness({ raw: savedCache(first) });
  h.client.getRevision();
  h.stored.set(ARTIST_METADATA_CACHE_KEY, savedCache(next));
  h.client.reloadCache();
  assert.equal([...first, ...next].filter(entry => h.client.getMetadata(entry.name)).length, 320);
  assert.equal(h.writes.length, 0);
  assert.ok(h.events[0].keys.includes('first 0') && h.events[0].keys.includes('next 0'));
});

test('the byte cap accounts for multibyte biographies during cross-tab merging and persistence', async () => {
  const first = Array.from({ length: 100 }, (_, index) => cached('First ' + index, automatic('First ' + index, NOW - 1000, { bio: '藝'.repeat(2000) })));
  const next = Array.from({ length: 100 }, (_, index) => cached('Next ' + index, automatic('Next ' + index, NOW, { bio: '藝'.repeat(2000) }), { checkedAt: NOW, usedAt: NOW }));
  const h = harness({ raw: savedCache(first), reply: name => Response.json(ready(name)) });
  assert.ok(h.client.getMetadata('First 0'));
  h.stored.set(ARTIST_METADATA_CACHE_KEY, savedCache(next)); h.client.reloadCache();
  const count = [...first, ...next].filter(entry => h.client.getMetadata(entry.name)).length;
  assert.ok(count > 100 && count < 200, 'a count-only cap would retain all 200 oversized combined entries');
  h.client.prioritize('Newest', 'open'); h.start(); await h.clock.advance();
  assert.ok(new TextEncoder().encode(h.stored.get(ARTIST_METADATA_CACHE_KEY)!).byteLength <= 1024 * 1024);
  h.client.stop();
});

test('late network responses and older cross-tab metadata cannot replace newer verified fields', async () => {
  const old = automatic('Artist', NOW - 1000);
  const h = harness({ raw: savedCache([cached('Artist', old, { nextRequestAt: NOW - 1 })]) });
  h.client.prioritize('Artist', 'open'); h.start(); await h.clock.advance();
  await h.clock.advance(100);
  const latest = automatic('Different provider label', h.clock.at, { img: '/api/artist-image?id=latest.jpg', bio: 'Latest verified text' });
  const updated = cached('Artist', latest, { checkedAt: h.clock.at, usedAt: h.clock.at });
  h.stored.set(ARTIST_METADATA_CACHE_KEY, savedCache([updated])); h.client.reloadCache();
  const revision = h.client.getRevision();
  h.requests[0].resolve(Response.json(ready('Artist', NOW, { bio: 'Losing response' })));
  await h.clock.advance();
  assert.deepEqual(h.client.getMetadata('Artist'), latest);
  assert.equal(h.client.getRevision(), revision);
  h.stored.set(ARTIST_METADATA_CACHE_KEY, savedCache([{ ...updated, checkedAt: h.clock.at + 1, metadata: old }]));
  h.client.reloadCache();
  assert.deepEqual(h.client.getMetadata('Artist'), latest);
  h.stored.set(ARTIST_METADATA_CACHE_KEY, savedCache([{ ...updated, checkedAt: h.clock.at + 2, status: 'retry', metadata: undefined }]));
  h.client.reloadCache();
  assert.deepEqual(h.client.getMetadata('Artist'), latest);
  assert.equal(h.client.getRevision(), revision);
  h.client.stop();
});

test('stop aborts active work, preserves interest for restart, and fences responses from the prior session', async () => {
  const h = harness({ ignoreAbort: true });
  h.client.prioritize(['One', 'Two'], 'open'); h.start(); await h.clock.advance();
  h.client.stop();
  assert.ok(h.requests.every(request => request.init.signal?.aborted));
  h.context.session = { email: 'other@example.test', token: 'other-fixture' };
  h.start(); await h.clock.advance();
  assert.equal(h.requests.length, 4);
  h.requests.slice(0, 2).forEach(request => request.resolve(Response.json(ready(request.name, NOW, { bio: 'Old session response' }))));
  await h.clock.advance();
  assert.equal(h.client.getMetadata('One'), undefined);
  h.requests.slice(2).forEach(request => request.resolve(Response.json(ready(request.name, NOW, { bio: 'New session response' }))));
  await h.clock.advance();
  assert.equal(h.client.getMetadata('One')?.bio, 'New session response');
  h.client.stop();
});

test('admin drafts use the shared conservative legacy rules and keep per-field clears independent', () => {
  const profiles: (ArtistProfile | undefined)[] = [undefined, {}, { key: 'legacy', source: 'admin' },
    { version: 0 }, { version: 1.5 }, { version: 1, source: 'manifest' },
    { key: 'managed', version: 1, img: '', bio: '' },
    { version: 2, img: 'Manual portrait', bio: 'Manual biography', imgOverride: false, bioOverride: true }];
  for (const profile of profiles) {
    const before = JSON.stringify(profile), draft = createArtistMetadataDraft(profile);
    const captured = composeArtistMetadata({ ...profile, ...draft }, automatic())!;
    const shared = composeArtistMetadata({ ...profile, img: draft.img, bio: draft.bio }, automatic())!;
    for (const field of ['img', 'bio', 'imageCredit', 'bioCredit'] as const) assert.deepEqual(captured[field], shared[field]);
    assert.equal(JSON.stringify(profile), before);
  }
  const profile = { key: 'owner', version: 2, img: '/api/artist-image?id=manual.jpg', bio: 'Manual biography', imgOverride: true, bioOverride: true };
  const draft = createArtistMetadataDraft(profile);
  editArtistMetadataDraft(draft, 'bio', '');
  assert.equal(composeArtistMetadata({ ...profile, ...draft }, automatic())?.bio, '');
  assert.equal(draft.img, profile.img);
  useAutomaticArtistMetadataDraft(draft, 'bio');
  const display = composeArtistMetadata({ ...profile, ...draft }, automatic())!;
  assert.equal(display.bio, automatic().bio);
  assert.equal(display.img, profile.img);
  assert.equal(display.imageCredit, undefined);
  assert.equal(draft.bio, '', 'automatic text is never copied into the editable draft');
  assert.equal(profile.version, 2);
  useAutomaticArtistMetadataDraft(draft, 'img');
  assert.equal(draft.img, profile.img, 'unlocking retains the saved value as a fallback');
});

test('automatic composition happens after ownership and preserves all track identities and artwork', () => {
  const profile = Object.freeze({ key: 'owner', name: 'Canonical Artist', version: 2, img: '', bio: '', imgOverride: false, bioOverride: false });
  const profiles = Object.freeze({ 'old artist': profile, 'canonical artist': profile });
  const songs = [Object.freeze({ id: 'one', title: 'Track', artist: 'Old Artist', img: 'album:one' }),
    Object.freeze({ id: 'two', title: 'Local', artist: 'Local Artist', img: 'album:two', isLocal: true })];
  const keys = songs.map(trackKey), before = JSON.stringify({ songs, profiles }), queried: string[] = [];
  const groups = buildArtistGroups(songs, profiles, { authoritativeProfiles: profiles,
    automaticMetadata: name => { queried.push(name); return name === 'Canonical Artist' ? automatic('Never use this provider name') : undefined; } });
  const artist = groups.find(group => group.name === 'Canonical Artist')!;
  assert.ok(queried.includes('Canonical Artist') && !queried.includes('Old Artist'));
  assert.equal(artist.key, 'profile:owner');
  assert.equal(artist.profile?.key, 'owner');
  assert.equal(artist.profile?.name, 'Canonical Artist');
  assert.equal(artist.profile?.version, 2);
  assert.equal(artist.cover, automatic().img);
  assert.equal(groups.find(group => group.name === 'Local Artist')?.cover, '', 'album covers are not artist portraits');
  assert.equal(artist.songs[0], songs[0]);
  assert.deepEqual(songs.map(trackKey), keys);
  assert.equal(JSON.stringify({ songs, profiles }), before);
  const selected = selectArtist(artist);
  assert.equal(resolveArtistSelection(groups, selected), artist);
});

test('conflicting artist ownership remains neutral without any provider lookup', () => {
  const profiles = { 'a. r. rahman': { key: 'first', name: 'A. R. Rahman' },
    'a.r. rahman': { key: 'second', name: 'A.R. Rahman' } };
  const queried: string[] = [];
  const groups = buildArtistGroups([{ id: 'one', artist: 'AR Rahman', img: 'album:one' }], profiles,
    { automaticMetadata: name => { queried.push(name); return automatic(name); } });
  assert.ok(groups[0].key.startsWith('unresolved:'));
  assert.equal(groups[0].cover, '');
  assert.equal(queried.length, 0);
});

test('credits escape provider text, reject unsafe links, and disclose image-only cropping', () => {
  const image = artistMetadataCreditHTML({ title: '<script>unsafe</script>', url: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
    author: '"<img onerror=alert(1)>', license: 'CC BY-SA', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' }, 'image');
  assert.match(image, /&lt;script&gt;/);
  assert.doesNotMatch(image, /<script>|<img/);
  assert.match(image, /rel="noopener noreferrer"/);
  assert.match(image, /Cropped to fit/);
  assert.match(image, /data-artist-credit="image"/);
  const bio = artistMetadataCreditHTML(automatic().bioCredit, 'bio');
  assert.match(bio, /Biography excerpt/);
  assert.doesNotMatch(bio, /Cropped/);
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test', 'http://example.test']) {
    assert.equal(artistMetadataCreditHTML({ title: 'Unsafe', url }, 'bio'), '');
  }
});
