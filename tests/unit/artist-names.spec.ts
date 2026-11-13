import { expect, test } from '@playwright/test';
import { artistKey, artistMatchKey, artistMergeKey, preferredArtistName } from '../../src/core/artist-names';
import { createArtistIdentityResolver } from '../../src/core/artistIdentity';

const pairs = [
  ['Kendrick Lamar', 'KendrickLamarVEVO'],
  ['Lewis Capaldi', 'LewisCapaldiVEVO'],
  ['Post Malone', 'PostMaloneVEVO'],
  ['The Kid LAROI.', 'TheKidLAROIVEVO'],
  ['The Neighbourhood', 'TheNeighbourhoodVEVO'],
  ['Travis Scott', 'TravisScottVEVO'],
];

for (const [name, channel] of pairs) {
  test(`${name} matches its VEVO handle in either order and keeps the normal artist label`, () => {
    expect(artistMatchKey(channel)).toBe(artistMatchKey(name));
    expect(artistMergeKey([artistKey(name)], channel)).toBe(artistKey(name));
    expect(artistMergeKey([artistKey(channel)], name)).toBe(artistKey(channel));
    expect(artistMatchKey(` ${channel.toLowerCase()} - Topic `)).toBe(artistMatchKey(name));
    expect(preferredArtistName([[channel, 3], [name, 1]])).toBe(name);
    expect(preferredArtistName([[name, 1], [channel, 3]])).toBe(name);
    const profile = { name, bio: 'Saved artist biography.' };
    expect(createArtistIdentityResolver({ profiles: { [name.toLowerCase()]: profile } }).resolve(channel)?.profile).toBe(profile);
    expect(createArtistIdentityResolver({ profiles: { [channel.toLowerCase()]: profile } }).resolve(name)?.profile).toBe(profile);
  });
}

test('Topic channels, initial punctuation, articles and existing typo matches still group', () => {
  expect(artistKey('A. R. Rahman - Topic')).toBe('a.r.rahman');
  expect(artistMergeKey(['a.r.rahman'], 'A.R. Rahman')).toBe('a.r.rahman');
  expect(artistMergeKey(['neighbourhood'], 'The Neighbourhood')).toBe('neighbourhood');
  expect(artistMergeKey(['anirudh ravichander'], 'Anirudh Ravichandran')).toBe('anirudh ravichander');
  expect(preferredArtistName([['A. R. Rahman - Topic', 3], ['A.R. Rahman', 1]])).toBe('A.R. Rahman');
});

test('a VEVO-only group can use its handle without the channel suffix', () => {
  expect(preferredArtistName([['KendrickLamarVEVO', 2]])).toBe('Kendrick Lamar');
  expect(preferredArtistName([['TheKidLAROIVEVO', 1]])).toBe('The Kid LAROI');
  expect(preferredArtistName([['Lewis Capaldi - VEVO', 1]])).toBe('Lewis Capaldi');
});

test('exact channel aliases win over a merely similar earlier name', () => {
  expect(artistMergeKey(['post mallone', 'post malone'], 'PostMaloneVEVO')).toBe('post malone');
});

test('distinct artists, collaborations and non-suffix VEVO text stay distinct', () => {
  for (const other of ['TravisBarkerVEVO', 'TravisScottVEVO & Guest', 'Travis Scott & Kendrick Lamar']) {
    expect(artistMatchKey(other)).not.toBe(artistMatchKey('Travis Scott'));
    expect(artistMergeKey(['travis scott'], other)).toBe(artistKey(other));
  }
  expect(artistMatchKey('Simon & Garfunkel')).not.toBe(artistMatchKey('Simon Garfunkel'));
  expect(artistKey('VEVO')).toBe('vevo');
  expect(artistKey('VEVO Music')).toBe('vevo music');
  expect(artistKey('Vevolution')).toBe('vevolution');
  expect(createArtistIdentityResolver({ profiles: { 'travis scott': { name: 'Travis Scott' } } }).resolve('Travis Barker')?.profile).toBeUndefined();
});

test('a directly saved canonical profile takes priority over a channel alias', () => {
  const canonical = { key: 'post malone', name: 'Post Malone', bio: 'Canonical biography.' };
  const channel = { name: 'PostMaloneVEVO', bio: 'Old channel profile.' };
  const owned = { 'post malone': canonical };
  expect(createArtistIdentityResolver({ profiles: { postmalonevevo: channel, ...owned }, authoritativeProfiles: owned }).resolve('Post Malone')?.profile).toBe(canonical);
});
