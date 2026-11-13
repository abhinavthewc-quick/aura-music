import { expect, test } from '@playwright/test';
import { decodePlaylistFile, encodePlaylistFile, MAX_TRACKS_PER_PLAYLIST, normalizePlaylist, parsePlaylistStore } from '../../src/core/playlist-data';
import { resolveTrackSnapshot, snapshotTrack } from '../../src/core/track-identity';

const songs = [{id:'local-1',title:'Song',artist:'Artist',isLocal:true,url:'blob:fixture',duration:60},{id:'hf:path',videoId:'abcdefghijk',title:'Remote',artist:'Artist',url:'https://example.test/audio.mp3',isHf:true}];
const legacy = [{id:'p1',title:'Collection',description:'',createdAt:1,tracks:['lk:song|artist','vid:abcdefghijk','lk:lost|unknown']}];

test('legacy migration preserves order and unresolved references', () => {
  const parsed = parsePlaylistStore(JSON.stringify(legacy),songs);
  expect(parsed.needsMigration).toBe(true);
  expect(parsed.store.playlists[0].tracks.map((ref) => ref.ref)).toEqual(['id:local-1','video:abcdefghijk','legacy:lk:lost|unknown']);
  expect(parsed.store.playlists[0].tracks[0].source).toBe('local');
});
test('metadata changes cannot orphan stable references', () => {
  const snapshot = snapshotTrack(songs[0]);
  const edited = {...songs[0],title:'Renamed',artist:'Another artist'};
  expect(resolveTrackSnapshot(snapshot,[edited])).toBe(edited);
});
test('local references cannot silently bind to another rendition', () => {
  const snapshot = snapshotTrack(songs[0]);
  expect(resolveTrackSnapshot(snapshot,[{...songs[0],id:'different'}])).toBeNull();
});
test('video references can resolve a changed catalogue path without changing identity', () => {
  const snapshot = snapshotTrack(songs[1]);
  const renamed = {...songs[1],id:'hf:new-path'};
  expect(resolveTrackSnapshot(snapshot,[renamed])).toBe(renamed);
});
test('valid exports round-trip every ordered reference, including unavailable items', () => {
  const playlist = parsePlaylistStore(JSON.stringify(legacy),songs).store.playlists[0];
  const imported = decodePlaylistFile(encodePlaylistFile(playlist,songs),songs);
  expect(imported).toEqual(playlist);
});
test('corrupt and unsupported stores throw rather than silently becoming an empty collection', () => {
  expect(() => parsePlaylistStore('{broken')).toThrow('could not be read');
  expect(() => parsePlaylistStore('{"version":99,"playlists":[]}')).toThrow('unsupported');
});
test('imports validate the entire payload instead of silently dropping malformed entries', () => {
  const playlist = parsePlaylistStore(JSON.stringify(legacy),songs).store.playlists[0];
  const invalid = {format:'aura-playlist',version:2,playlist:{...playlist,tracks:[...playlist.tracks,{ref:'id:missing-title'}]}};
  expect(() => decodePlaylistFile(JSON.stringify(invalid),songs)).toThrow('Track title');
  expect(() => decodePlaylistFile(JSON.stringify({...invalid,version:1}),songs)).toThrow('version 2');
});
test('imports reject duplicate identities and track-limit overflow', () => {
  const playlist = parsePlaylistStore(JSON.stringify(legacy),songs).store.playlists[0];
  expect(() => decodePlaylistFile(JSON.stringify({format:'aura-playlist',version:2,playlist:{...playlist,tracks:[playlist.tracks[0],playlist.tracks[0]]}}),songs)).toThrow('duplicate');
  expect(() => normalizePlaylist({...playlist,tracks:Array.from({length:MAX_TRACKS_PER_PLAYLIST+1},() => playlist.tracks[0])})).toThrow('at most');
});

test('local aliases and colliding source ids cannot bind a different recording', () => {
  const local = snapshotTrack(songs[0],'lk:song|artist');
  expect(resolveTrackSnapshot(local,[{id:'remote',title:'Song',artist:'Artist',url:'https://example.test/audio.mp3'}])).toBeNull();
  expect(resolveTrackSnapshot(local,[{id:'local-1',title:'Song',artist:'Artist',url:'https://example.test/audio.mp3'}])).toBeNull();
});
