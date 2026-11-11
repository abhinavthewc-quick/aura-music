import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArtistGroups } from '../../src/core/artistGroups.js';
import { trackKey } from '../../src/core/trackIdentity.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
} });
const catalog = await import('../../src/core/catalog.js');
let revision = 0;

test('catalogue metadata and artist pages share D1 authority over aliases and stale keyed HF profiles', () => {
  const latest = { key: 'a.r. rahman', name: 'A.R. Rahman', img: '', bio: '', version: 2, updated: 20 };
  const artists = {
    'a. r. rahman': { key: 'a. r. rahman', name: 'A. R. Rahman', img: 'old:portrait', version: 5, updated: 10 },
    'a.r. rahman': latest,
  };
  catalog.cacheArtistDirectory({ artists, trackArtists: {}, revision: ++revision });
  for (const fallback of [
    { 'a r rahman': { key: 'stale import', name: 'AR Rahman', img: 'stale:portrait', bio: 'old biography', updated: 9999 } },
    { 'A.R.Rahman': { name: 'A.R. Rahman', img: 'other:portrait' } },
  ]) {
    storage.set(catalog.ARTISTS_CACHE_KEY, JSON.stringify(fallback));
    const groups = buildArtistGroups([
      { id: 'one', artist: 'AR Rahman' }, { id: 'two', artist: 'A. R. Rahman' },
    ], catalog.readArtistsCache(), { authoritativeProfiles: catalog.getCachedArtistDirectory().artists });
    assert.equal(groups.length, 1);
    for (const name of ['A. R. Rahman', 'A.R.Rahman', 'AR Rahman - Topic', 'A R Rahman Official']) {
      assert.deepEqual(catalog.getArtistMeta(name), latest);
      assert.deepEqual(catalog.getArtistMeta(name), groups[0].profile);
    }
    assert.equal(groups[0].profile?.bio, '');
    assert.equal(groups[0].profile?.img, '');
  }
  storage.set(catalog.ARTISTS_CACHE_KEY, 'not valid JSON');
  assert.deepEqual(catalog.getArtistMeta('A. R. Rahman'), latest);
  catalog.cacheArtistDirectory({ artists: {}, trackArtists: {}, revision: ++revision });
  assert.equal(catalog.getArtistMeta('A. R. Rahman'), undefined);
});

test('fresh and cached catalogues keep original no-ID keys and attribution through display grouping and D1 corrections', async () => {
  const paths = [
    'Ilaiyaraaja Official - First.mp3',
    'A.R. Rahman - Song [abcdefghijk].opus',
    'Hans Zimmer & A.R. Rahman - Duet [bcdefghijkl].opus',
    'The National - Rival.mp3', 'National - Rival.mp3',
  ];
  const directory = {
    artists: { 'a.r. rahman': { key: 'a.r. rahman', name: 'A.R. Rahman', img: 'portrait' } },
    trackArtists: {}, revision: ++revision,
  };
  const playlist = JSON.stringify([{ id: 'saved', tracks: ['lk:first|ilaiyaraaja official', 'vid:abcdefghijk'] }]);
  storage.set('auraPlaylists', playlist);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    if (url === '/api/artists') return Response.json(directory);
    if (String(url).endsWith('manifest.json')) return Response.json({ artists: {}, tracks: {
      abcdefghijk: { a: 'A R Rahman', t: 'Song' },
      bcdefghijkl: { a: 'Hans Zimmer & A.R. Rahman', t: 'Duet' },
    } });
    if (String(url).includes('/tree?')) return Response.json(paths.map((path) => ({ type: 'file', path, size: 100 })));
    throw new Error('Unexpected catalogue request: ' + url);
  }) as typeof fetch;
  try {
    const tracks = await catalog.fetchHfCatalog();
    const ids = tracks.map((track) => track.id);
    const keys = tracks.map(trackKey);
    const originalArtist = tracks.map((track) => track.artist);
    assert.equal(tracks.length, 5);
    assert.equal(tracks[0].artist, 'Ilaiyaraaja Official');
    assert.equal(keys[0], 'lk:first|ilaiyaraaja official');
    assert.equal(keys[1], 'vid:abcdefghijk');
    const options = { authoritativeProfiles: catalog.getCachedArtistDirectory().artists };
    const groups = buildArtistGroups(tracks, catalog.readArtistsCache(), options);
    assert.equal(groups.find((group) => group.name === 'Ilaiyaraaja')?.songs[0], tracks[0]);
    assert.equal(groups.find((group) => group.name === 'A.R. Rahman')?.songs.length, 2);
    assert.ok(groups.some((group) => group.name === 'The National'));
    assert.ok(groups.some((group) => group.name === 'National'));
    assert.deepEqual(tracks.map((track) => track.artist), originalArtist);
    assert.deepEqual(catalog.readCatalogCache().map(trackKey), keys);

    const corrections = { ['hf:' + paths[0]]: 'My Separate Artist', 'vid:abcdefghijk': 'Another Composer' };
    catalog.cacheArtistDirectory({ ...directory, trackArtists: corrections, revision: ++revision });
    const edited = catalog.applyArtistTrackOverrides(tracks);
    assert.equal(edited[0].artist, 'My Separate Artist');
    assert.equal(edited[0].catalogArtist, 'Ilaiyaraaja Official');
    assert.deepEqual(edited.map((track) => track.id), ids);
    assert.deepEqual(edited.map(trackKey), keys);
    assert.equal(tracks[0].artist, 'Ilaiyaraaja Official', 'overrides do not mutate the previous playback snapshot');
    catalog.cacheArtistDirectory({ ...directory, trackArtists: {}, revision: ++revision });
    const restored = catalog.applyArtistTrackOverrides(edited);
    assert.deepEqual(restored.map((track) => track.artist), originalArtist);
    assert.deepEqual(restored.map(trackKey), keys);
    assert.equal(storage.get('auraPlaylists'), playlist);
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('literal metadata keys cannot read inherited object properties', () => {
  const artists = JSON.parse('{"__proto__":{"key":"literal proto artist","name":"__proto__"},"constructor":{"key":"literal constructor artist","name":"constructor"}}');
  catalog.cacheArtistDirectory({ artists, trackArtists: {}, revision: ++revision });
  assert.equal(catalog.getArtistMeta('__proto__')?.key, 'literal proto artist');
  assert.equal(catalog.getArtistMeta('constructor')?.key, 'literal constructor artist');
  assert.equal(catalog.getArtistMeta('toString'), undefined);
});
