import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIST_METADATA_POSITIVE_TTL, fetchArtistMetadata, providerRetryAfter, validArtistMetadataName, WIKIMEDIA_USER_AGENT,
} from '../../functions/lib/artistMetadata.js';
import { normalizeArtistKey } from '../../lib/artistProfiles.js';

const NOW = Date.UTC(2026, 10, 11, 12);
const value = (data: unknown, rank = 'normal') => ({ rank, mainsnak: { snaktype: 'value', datavalue: { value: data } } });
const item = (id: string) => value({ id });
const entity = (id: string, name: string, extra: any = {}) => ({
  id, type: 'item', labels: { en: { value: name } }, aliases: {},
  descriptions: { en: { value: 'A musician.' } }, claims: { P31: [item('Q5')], P106: [item('Q639669')] }, sitelinks: {}, ...extra,
});
const file = 'Artist portrait.jpg';
const commons = (overrides: any = {}, metadata: any = {}, filename = file) => ({ query: { pages: [{
  title: 'File:' + filename, imageinfo: [{
    mime: 'image/jpeg', width: 1200, height: 1600,
    thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Artist_portrait.jpg/960px-Artist_portrait.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(filename.replace(/ /g, '_')),
    extmetadata: {
      Artist: { value: '<a href="https://creator.example/">Original&nbsp;Creator</a>' },
      LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
      ...metadata,
    }, ...overrides,
  }],
}] } });

function fixture(config: { entities?: Record<string, any>; search?: any; image?: any; summary?: any; respond?: (url: URL) => Response | undefined }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.ok(['www.wikidata.org', 'commons.wikimedia.org', 'en.wikipedia.org'].includes(url.hostname), 'only Wikimedia APIs may be fetched');
    const response = config.respond?.(url);
    if (response) return response;
    if (url.hostname === 'www.wikidata.org' && url.searchParams.get('action') === 'wbsearchentities') {
      const result = config.search ?? { search: Object.keys(config.entities || {}).map((id) => ({ id })) };
      return Response.json({ ...result, search: result.search?.map((candidate: any) => {
        const artist = config.entities?.[candidate.id];
        const query = url.searchParams.get('search');
        const alias = Object.values(artist?.aliases || {}).flat().find((entry: any) => entry.value === query);
        return { label: artist?.labels?.en?.value || artist?.labels?.mul?.value,
          ...(alias ? { match: { type: 'alias', text: query } } : {}), ...candidate };
      }) });
    }
    if (url.hostname === 'www.wikidata.org' && url.searchParams.get('action') === 'wbgetentities') return Response.json({ entities: config.entities });
    if (url.hostname === 'commons.wikimedia.org') return Response.json(config.image);
    if (url.hostname === 'en.wikipedia.org') return Response.json(config.summary);
    throw new Error('Unexpected fixture request');
  }) as typeof fetch;
  return { calls, options: { fetch: fetcher, now: () => NOW } };
}

test('Alan Walker uses its verified binding, accepts mul labels, and retains validated per-field credits', async () => {
  const artist = entity('Q21808729', 'unused', {
    labels: { mul: { value: 'Alan Walker' } }, aliases: { en: [{ value: 'An older stage-name alias' }] }, descriptions: { en: { value: 'Norwegian electronic dance music producer.' } },
    claims: { P31: [item('Q5')], P106: [item('Q639669')], P18: [value('Alan Walker (cropped).jpg')] },
    sitelinks: { enwiki: { title: 'Alan Walker' } },
  });
  const data = fixture({ entities: { [artist.id]: artist },
    image: commons({}, { Artist: { value: '<a href="https://creator.example/">Maximilian&nbsp;Wild</a><script>not a credit</script>' }, Restrictions: { value: 'personality' } }, 'Alan Walker (cropped).jpg'),
    summary: { type: 'standard', wikibase_item: artist.id, title: 'Alan Walker', extract: 'Alan Walker is a Norwegian music producer.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Alan_Walker' } } },
  });
  const result = await fetchArtistMetadata('  ALAN WALKER  ', data.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.key, normalizeArtistKey('  ALAN WALKER  '));
  assert.equal(result.metadata!.name, 'Alan Walker');
  assert.equal(result.metadata!.entityId, 'Q21808729');
  assert.equal(result.metadata!.imageCredit!.author, 'Maximilian Wild');
  assert.equal(result.metadata!.imageCredit!.license, 'CC BY-SA 4.0');
  assert.match(result.metadata!.imageCredit!.title, /personality rights/);
  assert.equal(result.metadata!.bioCredit!.author, 'Wikipedia contributors');
  assert.equal(result.metadata!.bioCredit!.license, 'CC BY-SA 4.0');
  assert.equal(result.metadata!.fetchedAt, NOW);
  assert.equal(result.metadata!.expiresAt, NOW + ARTIST_METADATA_POSITIVE_TTL);
  assert.equal(data.calls.length, 3);
  assert.equal(data.calls[0].url.searchParams.get('action'), 'wbgetentities', 'seeded names do not use a fuzzy search');
  for (const call of data.calls) {
    assert.equal(new Headers(call.init.headers).get('User-Agent'), WIKIMEDIA_USER_AGENT);
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.credentials, 'omit');
  }
});

test('seed IDs are revalidated for both music evidence and the verified name', async () => {
  for (const changed of [
    entity('Q21808729', 'Different Person'),
    entity('Q21808729', 'Alan Walker', { claims: { P31: [item('Q783794')], P434: [value('b0e4bc50-3062-4d31-afad-def6a6b7a8e9')] } }),
  ]) {
    const data = fixture({ entities: { [changed.id]: changed } });
    assert.equal((await fetchArtistMetadata('Alan Walker', data.options)).status, 'ambiguous');
    assert.equal(data.calls.length, 1);
  }
});

test('provider redirects are rejected without following or trusting their payloads', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const data = fixture({ respond: () => Response.json({ search: [] }, {
      status, headers: { Location: 'https://untrusted.example/artist', 'Retry-After': '90' },
    }) });
    assert.deepEqual(await fetchArtistMetadata('Redirected Artist', data.options), {
      key: 'redirected artist', status: 'retry', retryAfter: 90,
    });
    assert.equal(data.calls.length, 1);
    assert.equal(data.calls[0].init.redirect, 'manual', 'use the redirect policy supported by the Pages runtime');
  }
});

test('idle lookups retain maxlag while explicit user-waiting lookups use Wikimedia interactive reads', async () => {
  for (const interactive of [false, true]) {
    const artist = entity('Q900100', 'Interactive Artist', {
      claims: { P31: [item('Q5')], P106: [item('Q639669')], P18: [value(file)] },
    });
    const data = fixture({ entities: { [artist.id]: artist }, image: commons() });
    const result = await fetchArtistMetadata('Interactive Artist', { ...data.options, interactive });
    assert.equal(result.status, 'ready');
    assert.equal(data.calls.length, 3);
    for (const { url } of data.calls) assert.equal(url.searchParams.get('maxlag'), interactive ? null : '5');
  }
});

test('Torine village and ship are rejected even with an exact name and a music identifier', async () => {
  const village = entity('Q3532302', 'Torine', { claims: { P31: [item('Q532')], P434: [value('18f44e2c-8905-4f7d-b99e-04842e0485b0')] }, sitelinks: { enwiki: { title: 'Torine' } } });
  const ship = entity('Q131304840', 'Torine', { claims: { P31: [item('Q11446')] } });
  const data = fixture({ entities: { [village.id]: village, [ship.id]: ship } });
  assert.deepEqual(await fetchArtistMetadata('Torine', data.options), { key: 'torine', status: 'not-found' });
  assert.equal(data.calls.length, 2, 'no village Wikipedia summary is requested');
});

test('Sorana can be bio-only and Wikipedia is fetched from the verified sitelink', async () => {
  const artist = entity('Q110969361', 'Sorana', { descriptions: { en: { value: 'Romanian singer and songwriter' } }, sitelinks: { enwiki: { title: 'Sorana (singer)' } } });
  const data = fixture({ entities: { [artist.id]: artist }, summary: {
    type: 'standard', wikibase_item: artist.id, title: 'Sorana (singer)', extract: 'Sorana is a Romanian singer and songwriter.',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Sorana_(singer)' } },
    thumbnail: { source: 'https://unsafe.example/not-a-licensed-portrait.jpg' },
  } });
  const result = await fetchArtistMetadata('Sorana', data.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.metadata!.img, undefined, 'Wikipedia thumbnails are never used as portraits');
  assert.equal(result.metadata!.imageCredit, undefined);
  assert.equal(result.metadata!.bio, 'Sorana is a Romanian singer and songwriter.');
  assert.match(data.calls[1].url.pathname, /Sorana_%28singer%29$/);
});

test('Wikipedia mismatches, disambiguation pages and unsafe source URLs fall back to CC0 Wikidata text', async () => {
  const artist = entity('Q110969361', 'Sorana', { descriptions: { en: { value: 'Romanian singer and songwriter' } }, sitelinks: { enwiki: { title: 'Sorana (singer)' } } });
  for (const summary of [
    { type: 'standard', wikibase_item: 'Q3532302', extract: 'Wrong identity.' },
    { type: 'disambiguation', wikibase_item: artist.id, extract: 'Wrong page type.' },
    { type: 'standard', wikibase_item: artist.id, extract: 'Unsafe source.', content_urls: { desktop: { page: 'https://en.wikipedia.org.evil.example/wiki/Sorana' } } },
  ]) {
    const data = fixture({ entities: { [artist.id]: artist }, summary });
    const result = await fetchArtistMetadata('Sorana', data.options);
    assert.equal(result.metadata!.bio, 'Romanian singer and songwriter');
    assert.equal(result.metadata!.bioCredit!.license, 'CC0 1.0');
    assert.equal(result.metadata!.bioCredit!.url, 'https://www.wikidata.org/wiki/Q110969361');
  }
});

test('a missing Wikipedia introduction is not a transient error or a missing artist profile', async () => {
  const artist = entity('Q110969361', 'Sorana', { sitelinks: { enwiki: { title: 'Sorana (singer)' } } });
  const data = fixture({ entities: { [artist.id]: artist }, respond: (url) => url.hostname === 'en.wikipedia.org'
    ? Response.json({ type: 'not_found' }, { status: 404 }) : undefined });
  const result = await fetchArtistMetadata('Sorana', data.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.retryAfter, undefined);
  assert.equal(result.metadata!.bioCredit!.license, 'CC0 1.0');
});

test('long Wikipedia introductions are accurate, bounded excerpts without abbreviation-based sentence splitting', async () => {
  const artist = entity('Q108560', 'A. R. Rahman', { sitelinks: { enwiki: { title: 'A. R. Rahman' } } });
  const data = fixture({ entities: { [artist.id]: artist }, summary: {
    type: 'standard', wikibase_item: artist.id, title: 'A. R. Rahman', extract: 'A. R. Rahman is a composer. ' + 'A documented introductory fact. '.repeat(50),
  } });
  const result = await fetchArtistMetadata('A.R. Rahman', data.options);
  assert.equal(result.key, 'a.r. rahman');
  assert.ok(result.metadata!.bio!.startsWith('A. R. Rahman is a composer.'));
  assert.ok(result.metadata!.bio!.length >= 700 && result.metadata!.bio!.length <= 950);
  assert.match(result.metadata!.bioCredit!.title, /\(excerpt\)$/);
  assert.equal(result.metadata!.bioCredit!.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
});

test('generic catalog musicians resolve from exact labels, not pinned identities or search scores', async () => {
  for (const [index, name] of ['Ed Sheeran', 'Lana Del Rey', 'Deepak Dev', 'Anuv Jain', 'Dhibu Ninan Thomas', 'Sid Sriram'].entries()) {
    // Synthetic IDs keep this fixture about matching rather than adding seeds.
    const artist = entity('Q' + (900001 + index), name);
    const fuzzy = entity('Q990001', name + ' Tribute Band');
    const data = fixture({ entities: { [fuzzy.id]: fuzzy, [artist.id]: artist }, search: { search: [{ id: fuzzy.id, score: 100 }, { id: artist.id, score: 40 }] } });
    const result = await fetchArtistMetadata(name, data.options);
    assert.equal(result.status, 'ready', name);
    assert.equal(result.metadata!.entityId, artist.id, name);
    assert.equal(result.key, normalizeArtistKey(name));
    assert.equal(data.calls[0].url.searchParams.get('action'), 'wbsearchentities');
    assert.equal(data.calls[1].url.searchParams.get('ids'), artist.id, 'partial-name search hints do not require entity downloads');
  }
});

test('generic aliases and actual music groups are accepted, while provider names stay informational', async () => {
  const singer = entity('Q900010', 'Sidharth Sriram', { aliases: { en: [{ value: 'Sid Sriram' }] }, claims: { P31: [item('Q5')], P434: [value('b0e4bc50-3062-4d31-afad-def6a6b7a8e9')] } });
  const group = entity('Q900011', 'A Music Group', { claims: { P31: [item('Q215380')] } });
  for (const [name, artist] of [['Sid Sriram', singer], ['A Music Group', group]] as const) {
    const data = fixture({ entities: { [artist.id]: artist } });
    const result = await fetchArtistMetadata(name, data.options);
    assert.equal(result.status, 'ready');
    assert.equal(result.key, normalizeArtistKey(name));
    assert.equal(result.metadata!.name, artist.labels.en.value);
  }
});

test('two exact musicians are ambiguous, regardless of ordering, ranking or popularity', async () => {
  const a = entity('Q900020', 'Phoenix');
  const b = entity('Q900021', 'Phoenix', { claims: { P31: [item('Q215380')] } });
  for (const entries of [[a, b], [b, a]]) {
    const data = fixture({ entities: Object.fromEntries(entries.map((entry) => [entry.id, entry])) });
    assert.deepEqual(await fetchArtistMetadata('Phoenix', data.options), { key: 'phoenix', status: 'ambiguous' });
    assert.equal(data.calls.length, 2);
  }
});

test('a truncated candidate set cannot establish a unique exact musician', async () => {
  const artist = entity('Q900025', 'Common Name');
  const data = fixture({ entities: { [artist.id]: artist }, search: { search: [{ id: artist.id }], 'search-continue': 5 } });
  assert.equal((await fetchArtistMetadata('Common Name', data.options)).status, 'ambiguous');
  const partials = fixture({ search: { search: [{ id: 'Q900026', label: 'Common Name discography' }], 'search-continue': 50 } });
  assert.equal((await fetchArtistMetadata('Common Name', partials.options)).status, 'ambiguous', 'an incomplete page cannot prove absence either');
  assert.equal(partials.calls.length, 1);
});

test('unrelated album and discography results do not make a unique artist artificially ambiguous', async () => {
  const musician = entity('Q900026', 'Ed Sheeran');
  const album = entity('Q900027', 'Ed Sheeran', { claims: { P31: [item('Q482994')] } });
  const partials = Array.from({ length: 18 }, (_, index) => ({ id: 'Q' + (910000 + index), label: `Ed Sheeran discography ${index}` }));
  const data = fixture({ entities: { [musician.id]: musician, [album.id]: album }, search: {
    search: [{ id: musician.id, label: 'Ed Sheeran' }, { id: album.id, label: 'Ed Sheeran' }, ...partials],
  } });
  const result = await fetchArtistMetadata('Ed Sheeran', data.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.metadata!.entityId, musician.id);
  assert.equal(data.calls[0].url.searchParams.get('limit'), '50');
  assert.equal(data.calls[1].url.searchParams.get('ids'), musician.id + '|' + album.id);
});

test('search hints cannot replace the entity identity check and exact candidate downloads remain bounded', async () => {
  const wrong = entity('Q900028', 'A Different Musician');
  const misleading = fixture({ entities: { [wrong.id]: wrong }, search: { search: [{ id: wrong.id, label: 'Requested Artist' }] } });
  assert.equal((await fetchArtistMetadata('Requested Artist', misleading.options)).status, 'not-found');
  const many = fixture({ search: { search: Array.from({ length: 6 }, (_, index) => ({ id: 'Q' + (920000 + index), label: 'Common Name' })) } });
  assert.equal((await fetchArtistMetadata('Common Name', many.options)).status, 'ambiguous');
  assert.equal(many.calls.length, 1, 'no unbounded full-entity batch');
});

test('unknown names, arbitrary accent stripping, nonmusicians and collaboration splitting never choose another artist', async () => {
  for (const [name, artists] of [
    ['Aura Unknown Artist 7f2b9d', []],
    ['Rene North', [entity('Q900030', 'René North')]],
    ['Alice & Bob', [entity('Q900031', 'Alice'), entity('Q900032', 'Bob')]],
    ['A Human', [entity('Q900033', 'A Human', { claims: { P31: [item('Q5')] } })]],
    ['A Company', [entity('Q900034', 'A Company', { claims: { P31: [item('Q783794')], P434: [value('b0e4bc50-3062-4d31-afad-def6a6b7a8e9')] } })]],
    ['Disambiguation', [entity('Q900035', 'Disambiguation', { claims: { P31: [item('Q5'), item('Q4167410')], P106: [item('Q639669')] } })]],
  ] as const) {
    const data = fixture({ entities: Object.fromEntries(artists.map((artist) => [artist.id, artist])) });
    assert.deepEqual(await fetchArtistMetadata(name, data.options), { key: normalizeArtistKey(name), status: 'not-found' });
  }
});

test('unsafe Commons media URLs, file pages, licenses and insufficient author credits omit only the portrait', async () => {
  const artist = entity('Q76364', 'Hans Zimmer', { claims: { P31: [item('Q5')], P106: [item('Q36834')], P18: [value(file)] } });
  for (const image of [
    commons({ thumburl: 'https://upload.wikimedia.org.evil.example/portrait.jpg' }),
    commons({ thumburl: 'http://upload.wikimedia.org/wikipedia/commons/portrait.jpg' }),
    commons({ thumburl: 'https://user:pass@upload.wikimedia.org/wikipedia/commons/portrait.jpg' }),
    commons({ thumburl: 'https://upload.wikimedia.org/not-commons/portrait.jpg' }),
    commons({ descriptionurl: 'https://commons.wikimedia.org/wiki/File:Someone_else.jpg' }),
    commons({ descriptionurl: 'https://commons.wikimedia.org/wiki/File:Artist_portrait.jpg?action=delete' }),
    commons({}, { LicenseShortName: { value: 'CC BY-NC 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/4.0/' } }),
    commons({}, { LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' } }),
    commons({}, { LicenseUrl: { value: 'https://license.example/by-sa/4.0/' } }),
    commons({}, { Artist: { value: '' } }),
    commons({}, { Artist: { value: 'Creator '.repeat(100) } }),
    commons({}, { Artist: { value: '' }, LicenseShortName: { value: 'CC0 1.0' }, LicenseUrl: { value: 'https://creativecommons.org/publicdomain/zero/1.0/' }, AttributionRequired: { value: 'true' } }),
    commons({}, { Restrictions: { value: 'trademark' } }),
  ]) {
    const data = fixture({ entities: { [artist.id]: artist }, image });
    const result = await fetchArtistMetadata('Hans Zimmer', data.options);
    assert.equal(result.status, 'ready');
    assert.equal(result.metadata!.img, undefined);
    assert.equal(result.metadata!.imageCredit, undefined);
    assert.equal(result.metadata!.bioCredit!.license, 'CC0 1.0');
  }
});

test('P18 uses only nondeprecated value claims and never constructs image URLs', async () => {
  const returned = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist_portrait.jpg';
  const artist = entity('Q76364', 'Hans Zimmer', { descriptions: {}, claims: { P31: [item('Q5')], P106: [item('Q36834')], P18: [
    value('Wrong old portrait.jpg', 'deprecated'), { mainsnak: { snaktype: 'novalue' } }, value(file),
  ] } });
  const data = fixture({ entities: { [artist.id]: artist }, image: commons({ thumburl: returned }) });
  const result = await fetchArtistMetadata('Hans Zimmer', data.options);
  assert.equal(result.status, 'ready', 'image-only is valid');
  assert.equal(result.metadata!.bio, undefined);
  assert.equal(result.metadata!.img, returned);
  assert.equal(data.calls[1].url.searchParams.get('titles'), 'File:' + file);
  assert.equal(data.calls[1].url.searchParams.get('iiurlwidth'), '512');
});

test('unsafe/non-raster P18 and deprecated-only images do not become portraits', async () => {
  for (const p18 of [[value('Artist.svg')], [value(file, 'deprecated')], [value('Bad\nimage.jpg')]]) {
    const artist = entity('Q76364', 'Hans Zimmer', { claims: { P31: [item('Q5')], P106: [item('Q36834')], P18: p18 } });
    const data = fixture({ entities: { [artist.id]: artist } });
    assert.equal((await fetchArtistMetadata('Hans Zimmer', data.options)).metadata!.img, undefined);
    assert.equal(data.calls.length, 1);
  }
});

test('rate limits, 503s and HTTP-200 error objects are transient and honor Retry-After, including zero', async () => {
  for (const response of [
    Response.json({ error: { code: 'maxlag', lag: 3 } }, { headers: { 'Retry-After': '0' } }),
    Response.json({ status: 503, type: 'https://example.invalid/server_error' }, { headers: { 'Retry-After': '10' } }),
    Response.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '120' } }),
    Response.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': new Date(NOW + 300_000).toUTCString() } }),
  ]) {
    const data = fixture({ respond: () => response });
    const result = await fetchArtistMetadata('Alan Walker', data.options);
    assert.equal(result.status, 'retry');
    assert.equal(result.metadata, undefined);
    assert.ok(result.retryAfter! >= 10);
    if (response.status === 429) assert.equal(result.retryAfter, 120);
    if (response.status === 503) assert.equal(result.retryAfter, 300);
  }
  assert.equal(providerRetryAfter('0', NOW), 10);
  assert.equal(providerRetryAfter('not a date', NOW), 60);
});

test('optional portrait rate errors return usable CC0 text and backoff, without more outgoing work', async () => {
  const artist = entity('Q76364', 'Hans Zimmer', { claims: { P31: [item('Q5')], P106: [item('Q36834')], P18: [value(file)] }, sitelinks: { enwiki: { title: 'Hans Zimmer' } } });
  const data = fixture({ entities: { [artist.id]: artist }, respond: (url) => url.hostname === 'commons.wikimedia.org'
    ? Response.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': '90' } }) : undefined });
  const result = await fetchArtistMetadata('Hans Zimmer', data.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.retryAfter, 90);
  assert.equal(result.metadata!.bioCredit!.license, 'CC0 1.0');
  assert.equal(data.calls.length, 2);
});

test('request and body timeouts stay bounded even if an injected fetch ignores its abort signal', async () => {
  let signal: AbortSignal | undefined;
  const never = (async (_url: any, init: RequestInit) => { signal = init.signal!; return await new Promise<Response>(() => {}); }) as typeof fetch;
  const result = await fetchArtistMetadata('Alan Walker', { fetch: never, now: () => NOW, timeoutMs: 30, requestTimeoutMs: 5 });
  assert.equal(result.status, 'retry');
  assert.equal(signal!.aborted, true);
  const stream = new ReadableStream<Uint8Array>({ start() { /* intentionally never finishes */ } });
  const stalled = await fetchArtistMetadata('Alan Walker', {
    fetch: (async () => new Response(stream)) as typeof fetch, now: () => NOW, timeoutMs: 30, requestTimeoutMs: 5,
  });
  assert.equal(stalled.status, 'retry');
});

test('oversized and malformed upstream JSON are retry states, not persistent negatives', async () => {
  for (const response of [
    new Response('{}', { headers: { 'Content-Length': '2000000' } }),
    new Response('{broken'),
    Response.json({ entities: [] }),
    Response.json({ entities: { Q21808729: entity('Q21808729', 'Alan Walker') }, padding: 'x'.repeat(1_500_000) }),
  ]) {
    const data = fixture({ respond: () => response });
    assert.equal((await fetchArtistMetadata('Alan Walker', data.options)).status, 'retry');
  }
});

test('invalid names are bounded and rejected before any provider fetch', async () => {
  for (const name of ['', ' ', 'x'.repeat(121), 'Artist\u0000', 'Artist\nOther', 'https://example.com/image', '//example.com', 'Artist\ud800']) {
    assert.equal(validArtistMetadataName(name), false);
    let requests = 0;
    const result = await fetchArtistMetadata(name, { fetch: (async () => { requests++; throw new Error('Must not fetch'); }) as typeof fetch });
    assert.equal(result.status, 'not-found');
    assert.equal(requests, 0);
  }
  assert.equal(validArtistMetadataName('AC/DC'), true);
  assert.equal(validArtistMetadataName('René North'), true);
});
