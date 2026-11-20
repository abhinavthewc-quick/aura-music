import { expect, test } from '@playwright/test';
import { compileCatalog, hfFileUrl, tracksFromCatalogResponse } from '../../src/core/catalog';

/* The edge Function and the browser share `compileCatalog`, so a payload that
   round-trips through `tracksFromCatalogResponse` has to reach the player with
   exactly the URLs and rendition metadata the bucket listing produced. */

const MAIN = 'Artist - Song [prXvpLr8WIs].opus';
const BASS = 'versions/prXvpLr8WIs/bass.mp3';
const REVERB = 'versions/prXvpLr8WIs/bass-reverb.mp3';

const items = [
  { type: 'file', path: MAIN, size: 4200000, contentType: 'audio/ogg' },
  { type: 'file', path: BASS, size: 4300000, contentType: 'audio/ogg' },
  { type: 'file', path: REVERB, size: 4400000, contentType: 'audio/ogg' },
  { type: 'file', path: 'covers/Artist - Song [prXvpLr8WIs].webp', size: 43394, contentType: 'image/webp' },
  { type: 'file', path: 'manifest.json', size: 1200, contentType: 'application/json' },
];

const versions = {
  v: 1,
  source: 'database',
  tracks: {
    'video:prXvpLr8WIs': {
      bass: { path: BASS, revision: 'aaa', duration: 214.5 },
      'bass-reverb': { path: REVERB, revision: 'bbb', duration: 214.5 },
    },
  },
};

/** What functions/api/catalog.ts returns: no `url`/`hfUrl`, so the payload is
 *  not carrying two full URLs per track. */
function compactPayload() {
  const tracks = compileCatalog(items, { tracks: { prXvpLr8WIs: { t: 'Song Title', a: 'Artist', y: '2024' } } }, versions);
  return {
    v: 1,
    tracks: tracks.map(({ id, title, artist, album, year, duration, videoId, hfPath, img, size, audioVersions }) =>
      ({ id, title, artist, album, year, duration, videoId, hfPath, img, size, audioVersions })),
    builtAt: 1700000000000,
  };
}

test('a compact edge payload rebuilds the same playable tracks', () => {
  const payload = compactPayload();
  for (const track of payload.tracks) {
    expect(track).not.toHaveProperty('url');
    expect(track).not.toHaveProperty('hfUrl');
  }

  const rebuilt = tracksFromCatalogResponse(payload);
  expect(rebuilt).toHaveLength(1);
  const [track] = rebuilt;
  expect(track.id).toBe('hf:' + MAIN);
  expect(track.title).toBe('Song Title');
  expect(track.artist).toBe('Artist');
  expect(track.url).toBe(compileCatalog(items, {}, versions)[0].url);
  expect(track.hfUrl).toBe(hfFileUrl(MAIN));
  expect(track.img).toBe(hfFileUrl('covers/Artist - Song [prXvpLr8WIs].webp'));
  expect(track.isHf).toBe(true);
  expect(track.favorite).toBe(false);
  expect(Object.keys(track.audioVersions).sort()).toEqual(['bass', 'bass-reverb']);
});

test('renditions missing from the listing never reach the player', () => {
  const partial = [
    { type: 'file', path: MAIN, size: 4200000 },
    { type: 'file', path: BASS, size: 4300000 },
  ];
  const payload = {
    v: 1,
    tracks: compileCatalog(partial, {}, versions).map((t: any) => ({ ...t })),
  };
  const [track] = tracksFromCatalogResponse(payload);
  expect(Object.keys(track.audioVersions)).toEqual(['bass']);
});

test('a malformed or unavailable payload falls back instead of half-loading', () => {
  expect(tracksFromCatalogResponse(null)).toBeNull();
  expect(tracksFromCatalogResponse({ v: 2, tracks: [] })).toBeNull();
  expect(tracksFromCatalogResponse({ v: 1, tracks: [] })).toBeNull();
  expect(tracksFromCatalogResponse({ v: 1, tracks: [{ id: 'x' }] })).toBeNull();
  expect(tracksFromCatalogResponse({ v: 1, tracks: [{ id: 'hf:a', title: 'A', img: '', hfPath: '' }] })).toBeNull();
});

test('compileCatalog drops pruned artists and dedupes a manual upload against its rendition', () => {
  const tracks = compileCatalog([
    ...items,
    { type: 'file', path: 'Michael Jackson - Thriller [34Na4j8AVgA].opus', size: 1 },
    { type: 'file', path: 'Artist - Song.mp3', size: 100 },
  ], {}, versions);
  expect(tracks.map((t) => t.id)).toEqual(['hf:' + MAIN]);
});