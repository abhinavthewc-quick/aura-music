import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPlaylistShare, decodePlaylistShare, encodePlaylistShare, matchSharedPlaylist,
  MAX_SHARE_BYTES, MAX_SHARE_ENCODED_LENGTH, MAX_SHARED_TRACKS, PLAYLIST_SHARE_PREFIX,
  PlaylistShareError, playlistShareUrl,
  type SharedPlaylist,
} from '../../src/core/playlist-sharing.js';

/* Hand-built wire fixtures deliberately do not use the production encoder. */
const wire = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const snapshot = (): SharedPlaylist => ({
  v: 1, title: 'மாலை 🎧 · Café', description: 'हवा\nMusic & friends <3',
  tracks: [
    { key: 'lk:காற்று 🎵|original artist', title: 'காற்று 🎵', artist: 'Renamed Artist' },
    { key: 'vid:AbCdEfGhI_1', title: 'After the rain', artist: 'Another artist' },
  ],
  omitted: { local: 0, unavailable: 0 },
});

test('Unicode snapshot crosses a real URL, resolves reordered recipient tracks, and keeps stable catalog keys', () => {
  const songs = [
    { id: 'hf:private-path', title: 'காற்று 🎵', artist: 'Renamed Artist', catalogArtist: 'Original Artist', url: 'https://audio.example.test/private?token=secret', img: 'blob:private-cover' },
    { id: 'hf:another-private-path', title: 'After the rain', artist: 'Another artist', videoId: 'AbCdEfGhI_1', url: '/api/audio?secret=private' },
  ];
  const source = {
    id: 'private-local-playlist-id', owner: { email: 'private@example.test' },
    title: snapshot().title, description: snapshot().description,
    tracks: ['lk:காற்று 🎵|original artist', 'lk:காற்று 🎵|renamed artist', 'vid:AbCdEfGhI_1', 'vid:AbCdEfGhI_1'],
  };
  const before = JSON.stringify({ source, songs });
  const outgoing = createPlaylistShare(source, songs);
  const url = new URL(playlistShareUrl(outgoing, 'https://name:password@aura.example.test/account/private?token=secret&play=yt:AbCdEfGhI_1#room=private'));
  assert.equal(url.origin, 'https://aura.example.test');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.equal(url.username + url.password, '');
  const decodedIndependently = JSON.parse(Buffer.from(url.hash.slice(PLAYLIST_SHARE_PREFIX.length), 'base64url').toString('utf8'));
  assert.deepEqual(decodedIndependently, snapshot());
  assert.doesNotMatch(JSON.stringify(decodedIndependently), /private|blob:|token|owner|email|https:|\/api\/|hf:/);
  const incoming = decodePlaylistShare(url.hash.slice(PLAYLIST_SHARE_PREFIX.length));
  const recipient = [{ ...songs[1], id: 'different-recipient-id' }, { ...songs[0], artist: 'Latest Artist' }];
  const matches = matchSharedPlaylist(incoming, recipient);
  assert.deepEqual(matches.map(({ track, index, available }) => [track.key, index, available]), [
    ['lk:காற்று 🎵|original artist', 1, true], ['vid:AbCdEfGhI_1', 0, true],
  ]);
  assert.equal(matches[0].song.artist, 'Latest Artist');
  assert.equal(JSON.stringify({ source, songs }), before, 'sharing and matching are read-only');
});

test('local media and unresolved legacy entries are counted, never serialized with their private data', () => {
  const source = { title: 'Device mix', description: '', tracks: ['lk:family recording|me', 'vid:abcdefghijk', 'lk:gone|me', 'blob:secret'] };
  const songs = [
    { title: 'Family recording', artist: 'Me', isLocal: true, id: '/Users/private/file.wav', url: 'blob:https://aura.test/secret', img: 'data:private' },
    { title: 'Mislabelled local file', artist: 'Me', videoId: 'abcdefghijk', url: 'blob:secret' },
  ];
  const outgoing = createPlaylistShare(source, songs);
  assert.deepEqual(outgoing.tracks, []);
  assert.deepEqual(outgoing.omitted, { local: 2, unavailable: 2 });
  assert.doesNotMatch(JSON.stringify(outgoing), /family|Family|recording|blob|data:|Users|secret|gone/);
  assert.deepEqual(decodePlaylistShare(encodePlaylistShare(outgoing)), outgoing);
});

test('missing recipient tracks keep ordered keys and metadata, then match after a later library update', () => {
  const incoming = decodePlaylistShare(wire(snapshot()));
  const first = matchSharedPlaylist(incoming, []);
  assert.deepEqual(first.map(({ track, index, available }) => [track.key, index, available]), incoming.tracks.map((track) => [track.key, -1, false]));
  const savedCopy = { title: incoming.title, description: incoming.description, tracks: first.map(({ track }) => track.key), shared: incoming };
  assert.deepEqual(createPlaylistShare(savedCopy, []), incoming, 're-sharing an imported missing track retains its safe metadata');
  const later = [{ title: 'காற்று 🎵', catalogArtist: 'Original Artist', artist: 'Latest Artist', url: '/saved-audio.opus' }];
  assert.equal(matchSharedPlaylist(incoming, later)[0].available, true);
  assert.deepEqual(savedCopy.tracks, incoming.tracks.map((track) => track.key));
});

test('reader deduplicates exact keys; recipient import also deduplicates artist aliases in first-occurrence order', () => {
  const incoming = snapshot();
  incoming.tracks.push({ ...incoming.tracks[0], title: 'Duplicate metadata' });
  incoming.tracks.push({ ...incoming.tracks[0], key: 'lk:காற்று 🎵|renamed artist' });
  const decoded = decodePlaylistShare(wire(incoming));
  assert.equal(decoded.tracks.length, 3);
  assert.equal(decoded.tracks[0].title, 'காற்று 🎵');
  const matched = matchSharedPlaylist(decoded, [{ title: 'காற்று 🎵', artist: 'Renamed Artist', catalogArtist: 'Original Artist', url: '/audio.opus' }]);
  assert.deepEqual(matched.map(({ track }) => track.key), snapshot().tracks.map((track) => track.key));
});

test('a recipient missing its local blob does not get a falsely playable match', () => {
  const incoming = snapshot();
  const local = { title: 'காற்று 🎵', artist: 'Original Artist', isLocal: true, missing: true };
  assert.equal(matchSharedPlaylist(incoming, [local])[0].available, false);
  assert.equal(matchSharedPlaylist(incoming, [{ ...local, missing: false, url: 'blob:recipient-owned' }])[0].available, true);
});

test('recipient catalog metadata cannot expand a bounded incoming key into an invalid saved snapshot', () => {
  const incoming = { ...snapshot(), tracks: [{ key: 'lk:song|display artist', title: 'Song', artist: 'Display Artist' }] };
  const matched = matchSharedPlaylist(incoming, [{ title: 'Song', artist: 'Display Artist', catalogArtist: 'x'.repeat(600), url: '/audio.opus' }]);
  assert.equal(matched[0].available, true);
  assert.equal(matched[0].track.key, incoming.tracks[0].key);
  assert.doesNotThrow(() => encodePlaylistShare({ ...incoming, tracks: matched.map(({ track }) => track) }));
});

test('empty snapshots and 100 short tracks round-trip; neither Unicode truncation nor large URLs fail silently', () => {
  const empty = { ...snapshot(), tracks: [] };
  assert.deepEqual(decodePlaylistShare(encodePlaylistShare(empty)), empty);
  const full = { ...empty, tracks: Array.from({ length: MAX_SHARED_TRACKS }, (_, index) => ({ key: `lk:song ${index}|artist`, title: `Song ${index}`, artist: 'Artist' })) };
  assert.equal(decodePlaylistShare(encodePlaylistShare(full)).tracks.length, 100);
  const longUnicode = createPlaylistShare({ title: '🎧'.repeat(70), description: 'தமிழ் 🎵'.repeat(30), tracks: [] }, []);
  assert.equal(Array.from(decodePlaylistShare(encodePlaylistShare(longUnicode)).title).length, 60);
  assert.doesNotMatch(JSON.stringify(longUnicode), /�/);
  const tooMany = { ...empty, tracks: [...full.tracks, { key: 'lk:overflow|artist', title: 'Overflow', artist: '' }] };
  assert.throws(() => encodePlaylistShare(tooMany), PlaylistShareError);
  const tooManyBytes = { ...full, tracks: full.tracks.map((track) => ({ ...track, title: '音'.repeat(160), artist: '楽'.repeat(160) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(tooManyBytes)) > MAX_SHARE_BYTES);
  assert.throws(() => encodePlaylistShare(tooManyBytes), /smaller playlist/);
  assert.throws(() => decodePlaylistShare(wire(tooManyBytes)), PlaylistShareError);
});

const invalidPayloads: Array<[string, unknown]> = [
  ['null', null], ['array', []], ['string', 'playlist'],
  ['unsupported version', { ...snapshot(), v: 2 }],
  ['coerced version', { ...snapshot(), v: '1' }],
  ['missing field', { v: 1, title: 'Mix', tracks: [], omitted: { local: 0, unavailable: 0 } }],
  ['empty title', { ...snapshot(), title: '   ' }],
  ['object title', { ...snapshot(), title: { toString: 'no coercion' } }],
  ['overlong title', { ...snapshot(), title: '🎧'.repeat(61) }],
  ['overlong description', { ...snapshot(), description: 'a'.repeat(141) }],
  ['lone surrogate', { ...snapshot(), title: '\ud800' }],
  ['control character', { ...snapshot(), description: 'bad\u0000data' }],
  ['account data', { ...snapshot(), owner: { email: 'private@example.test' } }],
  ['root media URL', { ...snapshot(), url: 'https://example.test/collect' }],
  ['tracks object', { ...snapshot(), tracks: {} }],
  ['null track', { ...snapshot(), tracks: [null] }],
  ['track media URL', { ...snapshot(), tracks: [{ ...snapshot().tracks[0], url: 'blob:secret' }] }],
  ['overlong track text', { ...snapshot(), tracks: [{ ...snapshot().tracks[0], title: 'a'.repeat(161) }] }],
  ['track artist object', { ...snapshot(), tracks: [{ ...snapshot().tracks[0], artist: {} }] }],
  ['negative omitted count', { ...snapshot(), omitted: { local: -1, unavailable: 0 } }],
  ['fractional omitted count', { ...snapshot(), omitted: { local: 0.5, unavailable: 0 } }],
  ['coerced omitted count', { ...snapshot(), omitted: { local: '1', unavailable: 0 } }],
  ['huge omitted count', { ...snapshot(), omitted: { local: Number.MAX_SAFE_INTEGER, unavailable: 0 } }],
  ['unknown omitted field', { ...snapshot(), omitted: { local: 0, unavailable: 0, token: 'secret' } }],
  ['oversized combined track count', { ...snapshot(), omitted: { local: 100, unavailable: 0 } }],
  ...['blob:secret', 'file:///Users/private', 'https://example.test/track', 'hf:private/path', 'vid:short', 'vid:123456789012', 'lk:|artist', 'lk:song|artist\n', 'lk:' + 'a'.repeat(513) + '|artist'].map((key): [string, unknown] => ['invalid key ' + key.slice(0, 30), { ...snapshot(), tracks: [{ ...snapshot().tracks[0], key }] }]),
];

for (const [name, raw] of invalidPayloads) {
  test(`rejects untrusted ${name}`, () => assert.throws(() => decodePlaylistShare(wire(raw)), PlaylistShareError));
}

test('rejects malformed encoding, invalid UTF-8, truncated JSON, prototype fields and oversized input before use', () => {
  const malformed = ['', '%not-base64', 'a', 'abcd=', 'ab+c', 'ab/c', wire(snapshot()) + '&play=yt:abcdefghijk', 'A'.repeat(MAX_SHARE_ENCODED_LENGTH + 1), Buffer.from([0xff, 0xfe]).toString('base64url'), Buffer.from('{"v":1').toString('base64url')];
  for (const encoded of malformed) assert.throws(() => decodePlaylistShare(encoded), PlaylistShareError);
  const prototype = JSON.stringify(snapshot()).replace('"v":1', '"v":1,"__proto__":{"polluted":true}');
  assert.throws(() => decodePlaylistShare(Buffer.from(prototype).toString('base64url')), PlaylistShareError);
  assert.equal(({} as any).polluted, undefined);
  assert.throws(() => playlistShareUrl(snapshot(), 'file:///private/Aura/index.html'), PlaylistShareError);
});
