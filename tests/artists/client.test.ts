import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArtistGroups, resolveArtistSelection, selectArtist } from '../../src/core/artistGroups.js';
import { trackKey, trackMatchesKey } from '../../src/core/trackIdentity.js';

const storage = new Map<string, string>();
const writes: string[] = [];
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { writes.push(key); storage.set(key, String(value)); },
  removeItem: (key: string) => storage.delete(key),
} });
const browser = new EventTarget();
Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
const audio = { src: 'fixture:playing', currentTime: 42, playbackRate: 1, paused: false };
Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => audio } });
const catalog = await import('../../src/core/catalog.js');
const { state, setHfTracks, savedLikeMap } = await import('../../src/core/state.js');

const song = (artist: string, id = 'song') => ({ id, title: id, artist, img: 'cover:' + id });
const directory = (revision: number, name = 'New Artist', img = '/api/artist-image?id=portrait.png') => ({
  artists: {
    'old artist': { key: 'old artist', name, img, bio: 'Cloud biography', genres: ['Soul'], version: revision },
    'new artist': { key: 'old artist', name, img, bio: 'Cloud biography', genres: ['Soul'], version: revision },
  },
  trackArtists: { 'vid:abcdefghijk': name, 'hf:Old Artist - Hand upload.mp3': name },
  revision,
});

test('artist selections survive first cloud load, profile-only renames and later track renames', () => {
  const songs = [song('Old Artist', 'one'), song('Old Artist', 'two')];
  const selected = selectArtist(buildArtistGroups(songs, {})[0]);
  const profiles = directory(1).artists;
  const first = resolveArtistSelection(buildArtistGroups(songs, profiles), selected)!;
  assert.equal(first.key, 'profile:old artist');
  assert.equal(first.name, 'New Artist');
  assert.equal(first.songs.length, 2);
  const next = resolveArtistSelection(buildArtistGroups(songs.map((s) => ({ ...s, artist: 'New Artist' })), profiles), selectArtist(first))!;
  assert.equal(next.key, first.key);
  assert.equal(next.songs.length, 2);
  assert.equal(resolveArtistSelection([next], 'Old Artist'), next);
  assert.equal(resolveArtistSelection([next], 'not in library'), undefined);
});

test('managed spelling variants group together regardless of track order without merging distinct profiles', () => {
  const songs = [song('Anirudh Ravichandran', 'one'), song('Anirudh Ravichander - Topic', 'two')];
  const profiles = { 'anirudh ravichander': { key: 'anirudh ravichander', name: 'Anirudh Ravichander', img: 'portrait' } };
  for (const ordered of [songs, [...songs].reverse()]) {
    const groups = buildArtistGroups(ordered, profiles);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].songs.length, 2);
    assert.equal(groups[0].cover, 'portrait');
    assert.equal(groups[0].name, profiles['anirudh ravichander'].name);
  }
  const separate = { ...profiles, 'anirudh ravichandran': { key: 'different artist', name: 'Anirudh Ravichandran' } };
  assert.equal(buildArtistGroups(songs, separate).length, 2);
  const ambiguous = buildArtistGroups([song('Anirudh Ravichandr', 'three'), ...songs], separate);
  assert.equal(ambiguous.length, 3);
  const formatted = buildArtistGroups([song('A. R. Rahman'), song('A.R. Rahman - Topic', 'two')], {
    'a. r. rahman': { key: 'first profile', name: 'A. R. Rahman' },
    'a.r. rahman': { key: 'second profile', name: 'A.R. Rahman' },
  });
  assert.equal(formatted.length, 2);
  assert.deepEqual(new Set(formatted.map((group) => group.key)), new Set(['profile:first profile', 'profile:second profile']));
});

test('initials, articles, aliases and portrait replacement share the same artist identity', () => {
  const initials = buildArtistGroups([song('A. R. Rahman'), song('a.r. rahman - Topic', 'two')], {});
  assert.equal(initials.length, 1);
  assert.doesNotMatch(initials[0].name, /Topic/i);
  assert.equal(buildArtistGroups([song('The National'), song('National', 'two')], {}).length, 1);
  const songs = [song('Old Artist')];
  const before = buildArtistGroups(songs, directory(1, 'New Artist', 'portrait:one').artists)[0];
  const after = resolveArtistSelection(buildArtistGroups(songs, directory(2, 'New Artist', 'portrait:two').artists), selectArtist(before))!;
  assert.equal(after.key, before.key);
  assert.equal(after.cover, 'portrait:two');
});

test('artist revisions reject late snapshots, deduplicate concurrent refreshes and keep cloud ownership across HF refreshes', async () => {
  let updates = 0;
  const onUpdate = () => updates++;
  browser.addEventListener('aura:artists-updated', onUpdate);
  const originalFetch = globalThis.fetch;
  try {
    assert.equal(catalog.cacheArtistDirectory(directory(10)), true);
    assert.equal(catalog.cacheArtistDirectory(directory(9, 'Stale Artist')), false);
    assert.equal(catalog.getArtistMeta('Old Artist')?.name, 'New Artist');
    let complete!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (() => { calls++; return new Promise<Response>((resolve) => { complete = resolve; }); }) as typeof fetch;
    const first = catalog.fetchArtistDirectory();
    const second = catalog.fetchArtistDirectory();
    assert.equal(first, second);
    assert.equal(calls, 1);
    catalog.cacheArtistDirectory(directory(12, 'Latest Artist'));
    complete(Response.json(directory(11, 'Late Response')));
    assert.equal((await first).revision, 12);
    assert.equal(catalog.getArtistMeta('Old Artist')?.name, 'Latest Artist');
    localStorage.setItem(catalog.ARTISTS_CACHE_KEY, JSON.stringify({ 'old artist': { name: 'Manifest Artist', img: 'legacy' } }));
    assert.equal(catalog.getArtistMeta('Old Artist')?.name, 'Latest Artist');
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal((await catalog.fetchArtistDirectory()).revision, 12);
    assert.equal(updates, 2);
  } finally {
    globalThis.fetch = originalFetch;
    browser.removeEventListener('aura:artists-updated', onUpdate);
  }
});

test('cross-tab stale snapshots cannot replace newer cloud profiles', () => {
  storage.set(catalog.CLOUD_ARTISTS_CACHE_KEY, JSON.stringify(directory(11, 'Stale Tab')));
  const stale = new Event('storage');
  Object.assign(stale, { key: catalog.CLOUD_ARTISTS_CACHE_KEY });
  browser.dispatchEvent(stale);
  assert.equal(catalog.getArtistMeta('Old Artist')?.name, 'Latest Artist');
  assert.equal(catalog.getCachedArtistDirectory().revision, 12);
  storage.set(catalog.CLOUD_ARTISTS_CACHE_KEY, JSON.stringify(directory(13, 'Other Tab')));
  browser.dispatchEvent(stale);
  assert.equal(catalog.getArtistMeta('Old Artist')?.name, 'Other Tab');
});

test('no-ID playlists retain catalog keys and metadata refresh leaves playback, local tracks and storage untouched', () => {
  const path = 'Old Artist - Hand upload.mp3';
  const handUpload = { id: 'hf:' + path, hfPath: path, title: 'Hand upload', artist: 'Old Artist', url: '/fixture.wav' };
  const withId = { ...song('Old Artist'), id: 'hf:video', hfPath: 'Old Artist - Video [abcdefghijk].opus', videoId: 'abcdefghijk' };
  const local = { ...song('Local Artist', 'local'), isLocal: true, url: 'blob:local' };
  const playlist = JSON.stringify([{ id: 'playlist', title: 'Do not rewrite', tracks: [trackKey(handUpload), trackKey(withId), trackKey(local)] }]);
  storage.set('auraPlaylists', playlist);
  storage.set('addedTracks', JSON.stringify([local]));
  state.addedSongs = [local];
  savedLikeMap[handUpload.id] = true;
  setHfTracks([handUpload, withId]);
  state.currentIndex = state.songs.findIndex((s) => s.id === handUpload.id);
  state.isPlaying = true;
  const writesBefore = writes.length;
  const beforeAudio = { ...audio };
  const updated = catalog.applyArtistTrackOverrides(state.hfSongs);
  setHfTracks(updated);
  const current = state.songs[state.currentIndex];
  assert.equal(current.id, handUpload.id);
  assert.equal(current.artist, 'Other Tab');
  assert.equal(current.catalogArtist, 'Old Artist');
  assert.equal(current.favorite, true);
  assert.equal(trackKey(current), 'lk:hand upload|old artist');
  assert.equal(trackMatchesKey(current, 'lk:hand upload|old artist'), true);
  assert.equal(trackMatchesKey(current, 'lk:hand upload|other tab'), true);
  assert.equal(trackKey(state.songs.find((s) => s.videoId)), 'vid:abcdefghijk');
  assert.equal(state.songs.find((s) => s.id === local.id), local);
  assert.deepEqual(audio, beforeAudio);
  assert.equal(state.isPlaying, true);
  assert.equal(storage.get('auraPlaylists'), playlist);
  assert.equal(writes.length, writesBefore);
  catalog.cacheArtistDirectory({ ...directory(14, 'Renamed Again'), trackArtists: {} });
  setHfTracks(catalog.applyArtistTrackOverrides(state.hfSongs));
  assert.equal(state.songs[state.currentIndex].artist, 'Old Artist');
  assert.equal(trackKey(state.songs[state.currentIndex]), 'lk:hand upload|old artist');
  assert.equal(storage.get('auraPlaylists'), playlist);
});
