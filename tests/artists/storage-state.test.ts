import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { trackKey } from '../../src/core/trackIdentity.js';

type Store = typeof import('../../src/core/state.js');
const storage = new Map<string, string>();
const mutations: { operation: string; key: string }[] = [];
let blockedReads = new Set<string>();
let requests = 0;
let imports = 0;
let audioSource: string | null = null;
const audioCalls: string[] = [];
const audio = {
  // An empty src attribute resolves to the document URL in a browser. Looking
  // only at the reflected property would mistake an explicit reset for audio.
  get src() { return audioSource === null ? '' : audioSource || 'https://aura.example/'; },
  set src(value: string) { audioCalls.push('src'); audioSource = value; },
  currentSrc: '', currentTime: 0, playbackRate: 1, paused: true,
  getAttribute(name: string) { return name === 'src' ? audioSource : null; },
  removeAttribute(name: string) { if (name === 'src') { audioCalls.push('remove:src'); audioSource = null; } },
  pause() { audioCalls.push('pause'); audio.paused = true; },
  load() { audioCalls.push('load'); audio.currentSrc = audioSource ? audio.src : ''; audio.currentTime = 0; },
  play() { audioCalls.push('play'); audio.paused = false; return Promise.resolve(); },
};
const globals = ['localStorage', 'window', 'document', 'fetch'] as const;
const originals = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) {
    if (blockedReads.has('*') || blockedReads.has(key)) throw new DOMException('Fixture storage unavailable', 'SecurityError');
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) { mutations.push({ operation: 'set', key }); storage.set(key, String(value)); },
  removeItem(key: string) { mutations.push({ operation: 'remove', key }); storage.delete(key); },
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id: string) => id === 'audioPlayer' ? audio : null } });
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: () => { requests++; throw new Error('State initialization must stay offline'); } });
after(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const cloud = { id: 'hf:Archive Artist - Cloud song [abcdefghijk].opus', hfPath: 'Archive Artist - Cloud song [abcdefghijk].opus', title: 'Cloud song', artist: 'Archive Artist', videoId: 'abcdefghijk', url: '/fixture.wav', img: 'cover:cloud' };
const local = { id: 'local:recording', title: 'On this device', artist: 'Local Ensemble', catalogArtist: 'Original Ensemble', isLocal: true, img: 'data:image/png;base64,fixture', album: 'Home tapes', genre: ['Ambient', 'Field recording'], year: 2024, duration: 123, custom: { source: 'original recording' } };
const numeric = { id: 0, title: 'Track zero', artist: 'Local Artist', isLocal: true, img: 'cover:zero' };
const legacy = { title: 'Older entry', artist: 'Legacy Artist', url: 'fixture:legacy', img: 'cover:legacy' };
const likes = [{ id: 81, title: cloud.title, artist: cloud.artist }, { id: local.id }, { title: legacy.title, artist: legacy.artist }];
const recent = [{ id: numeric.id, title: numeric.title, artist: numeric.artist }, { id: local.id, title: local.title, artist: local.artist }, { id: 'not-in-library', title: 'Remember this', artist: 'Earlier Artist' }];
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function records(): Record<string, string> {
  return {
    auraHfCatalog_v1: pretty({ tracks: [cloud], at: Date.now() }),
    addedTracks: pretty([local, numeric, legacy]),
    auraLikedSongs_v2: pretty(likes),
    recentlyPlayed: pretty(recent),
    aura_play_counts_v1: pretty({ [local.id]: 12, '0': 3, [trackKey(cloud)]: 8 }),
    auraPlaylists: pretty([{ id: 'keep-playlist', tracks: [trackKey(local), trackKey(numeric), trackKey(cloud)] }]),
  };
}

async function start(values: Record<string, string>, blocked: string[] = []) {
  storage.clear();
  for (const [key, value] of Object.entries(values)) storage.set(key, value);
  mutations.length = 0;
  requests = 0;
  blockedReads = new Set(blocked);
  audioSource = null;
  Object.assign(audio, { currentSrc: '', currentTime: 0, playbackRate: 1, paused: true });
  audioCalls.length = 0;
  const before = new Map(storage);
  const url = new URL('../../src/core/state.ts', import.meta.url);
  url.searchParams.set('storage-case', String(++imports));
  // Freshly evaluate the real store, including its import-time favourite and
  // popularity derivation. The catalogue reader and track identities are real.
  const store = await import(url.href) as Store;
  return {
    store, before,
    readOnly() {
      assert.deepEqual(mutations, [], 'loading and rebuilding must not write or delete raw storage');
      assert.deepEqual(storage, before, 'raw stored records stay byte-for-byte intact');
      assert.equal(requests, 0, 'state import does not fetch a catalogue');
    },
  };
}

function loadSelection(store: Store, song: any, playing = true) {
  const index = store.state.songs.indexOf(song);
  assert.notEqual(index, -1, 'the selected track is in the real derived library');
  store.state.currentIndex = index;
  store.state.isPlaying = playing;
  audio.src = song.url;
  Object.assign(audio, { currentSrc: audio.src, currentTime: 42, playbackRate: 1.25, paused: !playing });
  audioCalls.length = 0;
}

const catalogue = () => ['A', 'B', 'C'].map(title => ({
  id: 'hf:' + title + '.opus', title, artist: 'Catalogue artist', catalogArtist: 'Original artist',
  url: 'https://media.example/' + title + '.opus', img: 'cover:' + title, duration: 180,
}));

describe('stored music state startup', { concurrency: false }, () => {
  test('each corrupt or wrong-shaped collection falls back independently and still rebuilds', async () => {
    const fields = { addedTracks: 'addedSongs', auraLikedSongs_v2: 'auraLikedHistory', recentlyPlayed: 'recentlyPlayed' } as const;
    for (const [key, field] of Object.entries(fields)) {
      for (const raw of ['{broken', '', 'null', '{}', '42', 'true', '"not an array"']) {
        const context = await start({ ...records(), [key]: raw });
        const { state, rebuildSongs, setHfTracks } = context.store;
        assert.deepEqual(state[field], [], key + ': ' + raw);
        for (const [otherKey, otherField] of Object.entries(fields)) {
          if (otherKey !== key) assert.equal(state[otherField].length, 3, otherKey + ' survives corruption in ' + key);
        }
        setHfTracks([{ ...cloud }]);
        rebuildSongs();
        assert.ok(state.songs.some(song => song.id === cloud.id), 'cloud tracks remain usable');
        if (key !== 'addedTracks') assert.ok(state.songs.some(song => song.id === local.id), 'valid local tracks survive');
        if (key !== 'auraLikedSongs_v2') assert.equal(state.songs.find(song => song.id === cloud.id).favorite, true, 'legacy metadata likes survive');
        context.readOnly();
      }
    }
  });

  test('malformed members are ignored individually without discarding valid local records, likes or history', async () => {
    const invalid = [null, false, 17, 'broken', [], {}, { id: {} }, { id: ['bad'] },
      { id: 'bad-title', title: { toString: null } }, { id: 'bad-artist', artist: 23 },
      { id: 'bad-video', videoId: [] }, { id: 'bad-url', url: {} }, { id: 'bad-cover', img: {} }];
    const context = await start({
      ...records(),
      addedTracks: pretty([invalid[0], local, ...invalid.slice(1), numeric, legacy]),
      auraLikedSongs_v2: pretty([likes[0], ...invalid, likes[1], likes[2]]),
      recentlyPlayed: pretty([recent[0], ...invalid, recent[1], recent[2]]),
    });
    const { state, savedLikeMap, likedKeySet, rebuildSongs } = context.store;
    assert.deepEqual(state.addedSongs.map(song => song.id), [local.id, 0, undefined]);
    assert.deepEqual(state.auraLikedHistory, likes);
    assert.deepEqual(state.recentlyPlayed, recent);
    assert.equal(savedLikeMap[local.id], true, 'ID-only likes still work');
    assert.equal(savedLikeMap.undefined, undefined, 'metadata-only likes do not create a phantom ID');
    assert.equal(likedKeySet.has('|'), false, 'ID-only likes do not like every unnamed track');
    assert.equal(state.songs.find(song => song.id === local.id).favorite, true);
    assert.equal(state.songs.find(song => song.title === legacy.title).favorite, true, 'metadata-only legacy likes still work');
    assert.equal(state.songs.length, 4);
    rebuildSongs();
    context.readOnly();
  });

  test('original IDs, metadata, playback selection and local blob references survive rebuilds and cloud refreshes', async t => {
    const context = await start(records());
    const { state, setHfTracks, rebuildSongs, playCountMap } = context.store;
    const keptLocal = state.addedSongs.find(song => song.id === local.id);
    const keptNumeric = state.addedSongs.find(song => song.id === 0);
    const keys = state.addedSongs.map(trackKey);
    assert.deepEqual(keptLocal, { ...local, favorite: true });
    assert.deepEqual(keptNumeric, { ...numeric, favorite: false });
    assert.deepEqual(state.recentlyPlayed, recent, 'history keeps its original order and out-of-library records');
    assert.equal(trackKey(keptLocal), 'lk:on this device|original ensemble');

    // The existing IndexedDB hydration path addresses files by the untouched ID
    // and writes the URL onto addedSongs. Exercise those shared-object invariants
    // through actual rebuilds, without loading the unrelated player/UI modules.
    const blobs = new Map<string | number, Blob>([[local.id, new Blob(['local audio'])], [0, new Blob(['numeric-key audio'])]]);
    const urls = [URL.createObjectURL(blobs.get(keptLocal.id)!), URL.createObjectURL(blobs.get(keptNumeric.id)!)];
    t.after(() => urls.forEach(url => URL.revokeObjectURL(url)));
    keptLocal.url = urls[0]; keptNumeric.url = urls[1];
    loadSelection(context.store, keptNumeric);
    const beforeAudio = { ...audio };
    playCountMap[trackKey(cloud)] = 50;
    setHfTracks([{ ...cloud, artist: 'Updated display', catalogArtist: cloud.artist }]);
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], keptNumeric);
    assert.equal(state.songs.find(song => song.id === local.id), keptLocal);
    assert.equal(state.songs.find(song => song.id === local.id).url, urls[0]);
    assert.equal(state.songs[state.currentIndex].url, urls[1]);
    assert.deepEqual(state.addedSongs.map(trackKey), keys);
    assert.equal(state.audio, audio);
    assert.equal(state.isPlaying, true);
    assert.deepEqual(audio, beforeAudio);
    assert.deepEqual(audioCalls, [], 'metadata refresh never touches the audio transport');
    context.readOnly();
  });

  test('unusable count maps derive popularity in memory without repairing stored data on load', async () => {
    for (const raw of ['{broken', 'null', '[27, 99]', '42', 'true', '"not a map"']) {
      const context = await start({ ...records(), aura_play_counts_v1: raw });
      const { state, playCountMap, getPlayCount, rebuildSongs, recordPlayCount } = context.store;
      assert.equal(Array.isArray(playCountMap), false, raw);
      assert.equal(getPlayCount(state.songs.find(song => song.id === 0)), 10, 'numeric ID zero remains a valid history entry');
      assert.equal(getPlayCount(state.songs.find(song => song.id === local.id)), 9);
      rebuildSongs();
      assert.equal(state.songs[0].id, 0, 'history-derived ranking remains usable');
      context.readOnly();
      recordPlayCount(0, trackKey(numeric));
      assert.equal(getPlayCount(numeric), 11, 'a later real play increments the derived count');
      assert.deepEqual(mutations, [{ operation: 'set', key: 'aura_play_counts_v1' }]);
      for (const [key, value] of context.before) if (key !== 'aura_play_counts_v1') assert.equal(storage.get(key), value);
    }
  });

  test('bad count values cannot poison sorting and literal stable IDs do not inherit object members', async () => {
    const literalTracks = ['__proto__', 'constructor', 'toString'].map(id => ({ id, title: id, artist: 'Literal IDs', url: 'fixture:' + id }));
    const context = await start({
      ...records(), addedTracks: pretty([local, numeric, ...literalTracks]),
      auraLikedSongs_v2: pretty([{ id: '__proto__' }]),
      aura_play_counts_v1: '{"local:recording":12,"0":4,"__proto__":5,"constructor":7,"negative":-1,"string":"17","object":{},"infinite":1e999}',
    });
    const { state, playCountMap, getPlayCount, rebuildSongs } = context.store;
    assert.deepEqual(Object.keys(playCountMap).sort(), ['0', '__proto__', 'constructor', 'local:recording'].sort());
    assert.equal(getPlayCount({ id: '__proto__' }), 5);
    assert.equal(getPlayCount({ id: 'constructor' }), 7);
    assert.equal(getPlayCount({ id: 'toString' }), 0);
    assert.equal(state.songs.find(song => song.id === '__proto__').favorite, true);
    assert.equal(state.songs.find(song => song.id === 'toString').favorite, false);
    rebuildSongs();
    assert.deepEqual(state.songs.slice(0, 4).map(song => song.id), [local.id, 'constructor', '__proto__', 0]);
    assert.ok(state.songs.every(song => Number.isFinite(getPlayCount(song))));
    context.readOnly();
  });

  test('unavailable reads remain isolated and a completely blocked store can initialize', async () => {
    const partial = await start(records(), ['addedTracks']);
    assert.deepEqual(partial.store.state.addedSongs, []);
    assert.deepEqual(partial.store.state.auraLikedHistory, likes);
    assert.deepEqual(partial.store.state.recentlyPlayed, recent);
    partial.store.rebuildSongs();
    partial.readOnly();

    const blocked = await start(records(), ['*']);
    assert.deepEqual(blocked.store.state.songs, []);
    assert.deepEqual(blocked.store.state.auraLikedHistory, []);
    assert.deepEqual(blocked.store.state.recentlyPlayed, []);
    blocked.store.setHfTracks([{ ...cloud }]);
    assert.equal(blocked.store.state.songs[0].id, cloud.id);
    blocked.readOnly();
  });

  test('an empty device initializes without creating replacement records', async () => {
    const context = await start({});
    assert.deepEqual(context.store.state.songs, []);
    assert.equal(Object.keys(context.store.playCountMap).length, 0);
    context.store.rebuildSongs();
    context.readOnly();
  });
});

describe('current track reconciliation', { concurrency: false }, () => {
  test('removing the playing middle catalogue entry keeps its identity through repeated and empty refreshes', async () => {
    const context = await start({});
    const { state, setHfTracks, rebuildSongs } = context.store;
    const [a, b, c] = catalogue();
    setHfTracks([a, b, c]);
    loadSelection(context.store, b);
    assert.equal(state.currentIndex, 1, 'reproduce B playing in [A, B, C]');
    // Playback can already be using the direct-source fallback rather than url.
    audio.src = 'https://fallback.example/B.opus';
    audio.currentSrc = audio.src;
    audioCalls.length = 0;
    const beforeAudio = { ...audio };

    setHfTracks([a, c]);
    assert.equal(state.songs[state.currentIndex], b, 'MediaSession and lyrics still resolve B, not the new index-1 track C');
    assert.equal(state.songs[state.currentIndex].title, 'B');
    assert.deepEqual(state.hfSongs, [a, c], 'the removed record is not put back into the catalogue');
    assert.deepEqual(state.addedSongs, [], 'continuity does not convert cloud tracks into local records');
    rebuildSongs();
    setHfTracks([c, a]);
    assert.equal(state.songs[state.currentIndex], b);
    assert.equal(state.songs.filter(song => song === b).length, 1);
    setHfTracks([]);
    rebuildSongs();
    assert.deepEqual(state.songs, [b], 'even a completely empty refresh keeps the audible track identifiable');
    assert.equal(state.currentIndex, 0);
    assert.equal(state.isPlaying, true);
    assert.deepEqual(audio, beforeAudio);
    assert.deepEqual(audioCalls, []);
    context.readOnly();
  });

  test('a paused but loaded removed track remains selected without resuming or reloading', async () => {
    const context = await start({});
    const { state, setHfTracks, rebuildSongs } = context.store;
    const [a, b, c] = catalogue();
    setHfTracks([a, b, c]);
    loadSelection(context.store, b, false);
    const beforeAudio = { ...audio };
    setHfTracks([a, c]);
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], b);
    assert.equal(state.isPlaying, false);
    assert.deepEqual(audio, beforeAudio);
    assert.deepEqual(audioCalls, []);
    context.readOnly();
  });

  test('later selections and popularity rebuilds discard the old retained track without changing the new selection', async () => {
    const context = await start({});
    const { state, setHfTracks, rebuildSongs, playCountMap } = context.store;
    const [a, b, c] = catalogue();
    setHfTracks([a, b, c]);
    loadSelection(context.store, b);
    setHfTracks([a, c]);

    loadSelection(context.store, c);
    const beforeAudio = { ...audio };
    playCountMap[c.id] = 20;
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], c);
    assert.equal(state.currentIndex, 0, 'the new selection follows its identity through sorting');
    assert.equal(state.songs.some(song => song.id === b.id), false);
    setHfTracks([a]);
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], c, 'only the newly loaded track can now be retained');
    assert.equal(state.songs.some(song => song.id === b.id), false);
    setHfTracks([b, a]);
    assert.equal(state.songs[state.currentIndex], c, 'B reappearing must not steal playback back');
    assert.deepEqual(audio, beforeAudio);
    assert.deepEqual(audioCalls, []);

    loadSelection(context.store, a);
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], a);
    assert.deepEqual(new Set(state.songs), new Set([a, b]));
    context.readOnly();
  });

  test('catalogue reappearance adopts fresh metadata by stable ID or key and never duplicates the retained track', async () => {
    for (const changeId of [false, true]) {
      const context = await start({});
      const { state, setHfTracks, rebuildSongs } = context.store;
      const [a, b, c] = catalogue();
      setHfTracks([a, b, c]);
      loadSelection(context.store, b);
      const beforeAudio = { ...audio };
      setHfTracks([a, c]);
      const returned = { ...b, id: changeId ? 'hf:B-new-path.opus' : b.id, artist: 'Refreshed display artist', img: 'cover:new', url: 'https://media.example/new-B.opus' };
      setHfTracks([c, returned, a]);
      rebuildSongs();
      assert.equal(state.songs[state.currentIndex], returned);
      assert.equal(state.songs[state.currentIndex].artist, 'Refreshed display artist');
      assert.equal(trackKey(returned), trackKey(b));
      assert.equal(state.songs.filter(song => trackKey(song) === trackKey(b)).length, 1);
      assert.equal(state.songs.includes(b), false, 'fresh catalogue metadata supersedes the ephemeral object');
      setHfTracks([a, c]);
      assert.equal(state.songs[state.currentIndex], returned, 'a later disappearance retains the latest metadata');
      assert.deepEqual(audio, beforeAudio);
      assert.deepEqual(audioCalls, []);
      context.readOnly();
    }
  });

  test('legacy tracks without IDs reconcile by their stable keys rather than another missing ID', async () => {
    const context = await start({});
    const { state, setHfTracks, rebuildSongs } = context.store;
    const [a, b, c] = catalogue().map(({ id, ...song }) => song);
    setHfTracks([a, b, c]);
    loadSelection(context.store, b);
    const beforeAudio = { ...audio };
    setHfTracks([a, c]);
    assert.equal(state.songs[state.currentIndex], b);
    const returned = { ...b, artist: 'New display artist' };
    setHfTracks([c, returned, a]);
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], returned);
    assert.deepEqual(audio, beforeAudio);
    assert.deepEqual(audioCalls, []);
    context.readOnly();
  });

  test('an unloaded removed selection is cleared, including empty src attributes with stale currentSrc', async () => {
    for (const source of [null, '']) {
      const context = await start({});
      const { state, setHfTracks, rebuildSongs } = context.store;
      const [a, b, c] = catalogue();
      setHfTracks([a, b, c]);
      state.currentIndex = 1;
      if (source === '') {
        audio.src = '';
        audio.currentSrc = b.url;
        assert.equal(audio.src, 'https://aura.example/');
      }
      audioCalls.length = 0;
      const beforeAudio = { ...audio };
      setHfTracks([a, c]);
      rebuildSongs();
      assert.deepEqual(state.songs, [a, c]);
      assert.equal(state.currentIndex, -1, 'no track is silently substituted for the removed selection');
      assert.equal(state.songs[state.currentIndex], undefined);
      assert.equal(state.isPlaying, false);
      setHfTracks([c, a]);
      assert.equal(state.currentIndex, -1, 'subsequent refreshes respect the cleared selection');
      setHfTracks([]);
      assert.equal(state.currentIndex, -1);
      setHfTracks([a, c]);
      assert.equal(state.currentIndex, 0, 'an empty library can still get its normal initial selection');
      assert.deepEqual(audio, beforeAudio);
      assert.deepEqual(audioCalls, []);
      context.readOnly();
    }
  });

  test('explicitly deleting an active local track clears retention through the existing reset and rebuild APIs', async () => {
    for (const resetBeforeRebuild of [true, false]) {
      const context = await start(records());
      const { state, rebuildSongs, setHfTracks } = context.store;
      const selected = state.addedSongs.find(song => song.id === 0);
      selected.url = 'blob:local-zero';
      loadSelection(context.store, selected);
      state.addedSongs = state.addedSongs.filter(song => song !== selected);
      if (!resetBeforeRebuild) {
        rebuildSongs();
        assert.equal(state.songs[state.currentIndex], selected, 'removal alone never mislabels audio still loaded by the caller');
      }
      // The deletion owner decides to stop only after its await, then clears the
      // current selection before rebuilding (again if it already rebuilt).
      state.audio.pause();
      state.audio.removeAttribute('src');
      state.audio.load();
      state.isPlaying = false;
      state.currentIndex = -1;
      const resetAudio = { ...audio };
      audioCalls.length = 0;
      rebuildSongs();
      setHfTracks([{ ...cloud }]);
      rebuildSongs();
      assert.equal(state.songs.some(song => song.id === 0), false, 'an explicitly deleted local file cannot become an orphan');
      assert.equal(state.currentIndex, -1);
      assert.equal(state.isPlaying, false);
      assert.deepEqual(audio, resetAudio);
      assert.deepEqual(audioCalls, []);
      context.readOnly();
    }
  });

  test('finishing another local track deletion after a new selection leaves that selection and audio intact', async () => {
    const context = await start(records());
    const { state, rebuildSongs, setHfTracks } = context.store;
    const deleted = state.addedSongs.find(song => song.id === local.id);
    const selected = state.addedSongs.find(song => song.id === 0);
    deleted.url = 'blob:deleted'; selected.url = 'blob:chosen';
    loadSelection(context.store, deleted);
    // Selection changed while the library owner was awaiting IndexedDB.
    loadSelection(context.store, selected);
    const beforeAudio = { ...audio };
    state.addedSongs = state.addedSongs.filter(song => song !== deleted);
    rebuildSongs();
    setHfTracks([]);
    rebuildSongs();
    assert.equal(state.songs[state.currentIndex], selected);
    assert.equal(state.songs.includes(deleted), false);
    assert.equal(state.isPlaying, true);
    assert.deepEqual(audio, beforeAudio);
    assert.deepEqual(audioCalls, []);
    context.readOnly();
  });
});
