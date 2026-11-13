import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArtistGroups, resolveArtistSelection, selectArtist } from '../../src/core/artistGroups.js';
import { artistNamesMatch } from '../../src/core/artistIdentity.js';
import { trackKey } from '../../src/core/trackIdentity.js';

const pairs = [
  ['Kendrick Lamar', 'KendrickLamarVEVO', 3],
  ['Lewis Capaldi', 'LewisCapaldiVEVO', 2],
  ['Post Malone', 'PostMaloneVEVO', 3],
  ['The Kid LAROI.', 'TheKidLAROIVEVO', 2],
  ['The Neighbourhood', 'TheNeighbourhoodVEVO', 2],
  ['Travis Scott', 'TravisScottVEVO', 2],
] as const;
for(const [name, alias, total] of pairs) {
  test(`${name} and its reviewed VEVO channel share every recording without rewriting identity`, () => {
    const tracks = Array.from({ length: total }, (_, i) => Object.freeze({
      id: i === 0 ? 17 : `hf:${alias} - Recording ${i}.opus`, artist: i === 0 ? name : alias,
      title: `Recording ${i}`, url: `/audio/${i}.opus`, img: `cover:${i}`, favorite: i === 1,
    }));
    const before = JSON.stringify(tracks), keys = tracks.map(trackKey);
    const groups = buildArtistGroups(tracks, {}, { authoritativeProfiles: {} });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, name);
    assert.equal(groups[0].songs.length, total);
    assert.deepEqual(groups[0].songs, tracks);
    assert.ok(artistNamesMatch(name, alias));
    assert.equal(resolveArtistSelection(groups, alias), groups[0]);
    assert.equal(resolveArtistSelection(groups, name), groups[0]);
    assert.equal(resolveArtistSelection(buildArtistGroups(tracks.slice().reverse(), {}), selectArtist(groups[0]))?.key, groups[0].key);
    assert.equal(buildArtistGroups([tracks[1]], {})[0].name, name, 'VEVO-only snapshots still use the normal artist name');
    assert.equal(groups[0].cover, '', 'track artwork is not promoted to an artist portrait');
    assert.deepEqual(tracks.map(trackKey), keys);
    assert.equal(JSON.stringify(tracks), before);
  });
}
test('six reviewed channel pairs do not broaden fuzzy normalization or cross explicit ownership', () => {
  for(const [name, alias] of pairs) {
    const tracks = [{ id: 'normal', title: 'Normal', artist: name }, { id: 'channel', title: 'Channel', artist: alias }];
    const profiles = {
      [name.toLowerCase()]: { key: 'explicit-normal', name, bio: 'Curated normal artist.' },
      [alias.toLowerCase()]: { key: 'explicit-channel', name: 'Distinct channel owner', bio: 'Intentional owner.' },
    };
    const owned = buildArtistGroups(tracks, profiles, { authoritativeProfiles: profiles });
    assert.equal(owned.length, 2, name);
    assert.equal(resolveArtistSelection(owned, alias)?.profile?.key, 'explicit-channel');
    const edited = buildArtistGroups(tracks, {}, { authoritativeProfiles: {}, authoritativeNames: [alias] });
    assert.equal(edited.length, 2, 'explicit track corrections retain their own identity');
    assert.equal(resolveArtistSelection(edited, alias)?.key, 'edited:' + alias.toLowerCase());
    assert.equal(artistNamesMatch(name, name + ' Tribute'), false);
  }
  for(const [first, second] of [['National', 'The National'], ['Kid LAROI', 'The Kid LAROI.'],
    ['Random Band', 'RandomBandVEVO'], ['Travis', 'Travis Scott'], ['Post Malon', 'Post Malone']]) {
    assert.equal(artistNamesMatch(first, second), false);
  }
});
