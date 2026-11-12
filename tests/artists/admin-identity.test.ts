import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAdminArtistGroups } from '../../src/admin/artistGroups.js';
import { buildArtistGroups } from '../../src/core/artistGroups.js';
import { artistSourceCredit } from '../../src/core/artistIdentity.js';
import { trackKey } from '../../src/core/trackIdentity.js';

const track = (artist: string, source: string, videoId: string, title = 'Recording') => {
  const hfPath = `${source} - ${title} [${videoId}].opus`;
  return { id: 'hf:' + hfPath, artist, hfPath, videoId, title, album: 'Album', img: 'recording:artwork' };
};

test('admin and listener artist memberships agree for aliases and every collaborator, not whole raw credits', () => {
  const profile = Object.freeze({ key: 'anirudh ravichander', name: 'Anirudh Ravichander', img: 'saved:portrait', version: 1 });
  const profiles = Object.freeze({ 'anirudh ravichander': profile });
  const tracks = [
    track('Anirudh Ravichander', 'Anirudh Ravichander', 'abcdefghijk'),
    track('Anirudh Ravichandran', 'Anirudh Ravichandran', 'bcdefghijkl'),
    track('Dhanush', 'Dhanush', 'cdefghijklm'),
    track('Anirudh Ravichander & Dhanush', 'Anirudh Ravichander', 'defghijklmn'),
    track('Anirudh Ravichandran & Dhanush', 'Anirudh Ravichander', 'efghijklmno'),
    track('Anirudh Ravichander, Anirudh Ravichandran & Dhanush', 'Anirudh Ravichander', 'fghijklmnop'),
    track('Siri Xander & Arra Aria Khayal', 'Siri Xander', 'ghijklmnopq'),
  ].map(Object.freeze);
  const before = JSON.stringify({ tracks, profiles }), keys = tracks.map(trackKey);
  const admin = buildAdminArtistGroups([...tracks, tracks[3]], profiles);
  const listeners = buildArtistGroups([...tracks, tracks[3]], profiles, { authoritativeProfiles: profiles });
  assert.deepEqual(admin.map((group) => ({ key: group.key, name: group.name, ids: group.tracks.map((song) => song.id) })),
    listeners.map((group) => ({ key: group.key, name: group.name, ids: group.songs.map((song) => song.id) })));
  assert.equal(admin.length, 4);
  const anirudh = admin.find((group) => group.name === 'Anirudh Ravichander')!;
  const dhanush = admin.find((group) => group.name === 'Dhanush')!;
  assert.equal(anirudh.tracks.length, 5);
  assert.equal(dhanush.tracks.length, 4);
  assert.equal(anirudh.normKey, profile.key);
  assert.equal(anirudh.profile?.img, profile.img);
  assert.equal(dhanush.profile, undefined);
  assert.equal(anirudh.renameTrackCount, 1, 'only a whole-credit name owned by this profile is batch-renamable');
  assert.equal(dhanush.renameTrackCount, 1);
  assert.equal(admin.find((group) => group.name === 'Arra Aria Khayal')?.renameTrackCount, 0);
  assert.ok(admin.every((group) => group.albums.length === 1 && group.albums[0] === 'Album'));
  assert.deepEqual(tracks.map(trackKey), keys);
  assert.equal(JSON.stringify({ tracks, profiles }), before);
});

test('admin counts owned whole credits, retaining joint projects, explicit corrections and zero-track aliases', () => {
  const solo = { key: 'solo', name: 'Solo Artist', version: 2 };
  const joint = { key: 'joint', name: 'Solo Artist & Guest Artist', version: 1, img: 'joint:portrait' };
  const absent = { key: 'absent', name: 'Absent Artist', version: 1, img: '' };
  const profiles = { 'old solo': solo, 'solo artist': solo, 'solo artist & guest artist': joint,
    'old absent': absent, 'absent artist': absent };
  const tracks = [
    track('Old Solo', 'Solo Artist', 'abcdefghijk'),
    track('Solo Artist & Guest Artist', 'Solo Artist', 'bcdefghijkl'),
    track('Edited One & Edited Two', 'Edited One', 'cdefghijklm'),
  ];
  const groups = buildAdminArtistGroups(tracks, profiles, ['Edited One & Edited Two']);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.find((group) => group.normKey === 'solo')?.tracks, [tracks[0]]);
  assert.equal(groups.find((group) => group.normKey === 'solo')?.renameTrackCount, 1);
  assert.equal(groups.find((group) => group.normKey === 'joint')?.profile?.img, 'joint:portrait');
  assert.equal(groups.find((group) => group.normKey === 'joint')?.renameTrackCount, 1);
  assert.equal(groups.find((group) => group.name === 'Edited One & Edited Two')?.tracks[0], tracks[2]);
  assert.equal(groups.filter((group) => group.normKey === 'absent').length, 1);
  assert.equal(groups.find((group) => group.normKey === 'absent')?.tracks.length, 0);
});

test('admin exposes both ambiguous owners by their real keys and keeps audited equivalent zero-track owners once', () => {
  const first = { key: 'alex north', name: 'Alex North', version: 1 };
  const second = { key: 'two', name: 'Alex North', version: 1 };
  const profiles = { 'first owner': first, 'second owner': second,
    'a. r. rahman': { key: 'a. r. rahman', name: 'A. R. Rahman', source: 'manifest' as const },
    'a.r. rahman': { key: 'a.r. rahman', name: 'A.R. Rahman', source: 'admin' as const } };
  const groups = buildAdminArtistGroups([track('Alex North', 'Record Label', 'abcdefghijk')], profiles);
  const unresolved = groups.find((group) => group.key.startsWith('unresolved:'))!;
  assert.equal(unresolved.metadataName, '');
  assert.equal(unresolved.profile, undefined);
  assert.deepEqual(groups.filter((group) => group.profile?.name === 'Alex North').map((group) => group.normKey).sort(), ['alex north', 'two']);
  assert.equal(groups.filter((group) => group.normKey === 'alex north').length, 2, 'display identity separates a saved key from its unresolved same-name recording');
  assert.equal(new Set(groups.map((group) => group.key)).size, groups.length);
  assert.equal(groups.filter((group) => group.key === 'artist:ar-rahman').length, 1);
  assert.equal(groups.find((group) => group.key === 'artist:ar-rahman')?.normKey, 'a.r. rahman');
  const invalid = buildAdminArtistGroups([
    track('', 'Record Label', 'bcdefghijkl'), track('Unknown Artist', 'Record Label', 'cdefghijklm'),
  ], {});
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].name, 'Unknown Artist');
  assert.equal(invalid[0].tracks.length, 2);
  assert.equal(invalid[0].metadataName, '');
});

test('filename credit extraction is bounded and does not change track objects or persistence keys', () => {
  const cases = [
    ['Hamsika Iyer - Recording [abcdefghijk].opus', 'Hamsika Iyer'],
    ['folder/Siri Xander - Topic - Recording [bcdefghijkl].m4a', 'Siri Xander'],
    ['A. R. Ameen - Recording.mp3', 'A. R. Ameen'],
    ['Earth, Wind & Fire - Recording.flac', 'Earth, Wind & Fire'],
    ['Unidentified.opus', ''], ['Artist - Cover.jpg', ''], ['Artist - Recording.html', ''],
    ['x'.repeat(4001) + ' - Recording.opus', ''],
  ];
  for (const [hfPath, expected] of cases) {
    assert.equal(artistSourceCredit({ hfPath }), expected);
    assert.equal(artistSourceCredit({ id: 'hf:' + hfPath }), expected);
  }
  assert.equal(artistSourceCredit(undefined!), '');
  assert.equal(artistSourceCredit({ id: 'local:Artist - Recording.opus' }), '');
});
