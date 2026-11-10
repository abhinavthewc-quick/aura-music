import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeArtistKey, type ArtistProfile } from '../../lib/artistProfiles.js';
import { artistKey, artistNamesMatch, createArtistIdentityResolver } from '../../src/core/artistIdentity.js';
import { buildArtistGroups, resolveArtistSelection, selectArtist } from '../../src/core/artistGroups.js';
import { trackKey } from '../../src/core/trackIdentity.js';

const song = (artist: string, id: string, extra = {}) => ({ id, title: id, artist, img: 'cover:' + id, ...extra });
const songs = (...names: string[]) => names.map((name, i) => song(name, String(i)));
const named = (groups: ReturnType<typeof buildArtistGroups>, name: string) => groups.find((group) => group.name === name)!;
const snapshot = (groups: ReturnType<typeof buildArtistGroups>) => groups.map((group) => ({
  key: group.key, name: group.name, aliases: group.aliases, profileKeys: group.profileKeys,
  cover: group.cover, songs: group.songs.map((track) => track.id).sort(),
})).sort((a, b) => a.key < b.key ? -1 : 1);

/* Public production observations, 2026-11-10: two natural Rahman profile keys,
   initial/spelling variants and multiple comma/ampersand collaboration credits.
   Keep this small deterministic fixture offline; do not mutate production. */
const olderRahman = Object.freeze({ key: 'a. r. rahman', name: 'A. R. Rahman', img: 'older:portrait', updated: 10, version: 9 });
const newerRahman = Object.freeze({ key: 'a.r. rahman', name: 'A.R. Rahman', img: 'newer:portrait', updated: 20, version: 1 });
const profiles: Record<string, ArtistProfile> = Object.freeze({
  'a. r. rahman': olderRahman,
  'a.r. rahman': newerRahman,
  'anirudh ravichander': Object.freeze({ key: 'anirudh ravichander', name: 'Anirudh Ravichander', img: 'anirudh:portrait' }),
  'hans zimmer': Object.freeze({ key: 'hans zimmer', name: 'Hans Zimmer' }),
  'alan walker': Object.freeze({ key: 'alan walker', name: 'Alan Walker' }),
});

test('production duplicates have one page per artist, with every collaboration credited accurately', () => {
  const tracks = songs(
    'A. R. Rahman', 'A.R. Rahman - Topic', 'Hans Zimmer & A.R. Rahman',
    'A.R. Rahman, G.V. Prakash Kumar, Anirudh Ravichander & Ilango Krishnan',
    'Anirudh Ravichandran', 'Anirudh Ravichander & Vivek',
    'Alan Walker & Torine', 'Alan Walker & Sorana', 'Alan Walker',
  );
  tracks.forEach(Object.freeze);
  const before = JSON.stringify({ tracks, profiles });
  const keys = tracks.map(trackKey);
  const groups = buildArtistGroups(tracks, profiles);
  const rahman = named(groups, 'A.R. Rahman');
  assert.equal(rahman.songs.length, 4);
  assert.equal(rahman.profile, newerRahman);
  assert.equal(rahman.cover, 'newer:portrait');
  assert.deepEqual(rahman.profileKeys, ['a. r. rahman', 'a.r. rahman']);
  assert.equal(groups.filter((group) => /rahman/i.test(group.name)).length, 1);
  assert.equal(named(groups, 'Anirudh Ravichander').songs.length, 3);
  assert.equal(named(groups, 'Alan Walker').songs.length, 3);
  assert.deepEqual(named(groups, 'Torine').songs.map((track) => track.id), ['6']);
  assert.deepEqual(named(groups, 'Sorana').songs.map((track) => track.id), ['7']);
  assert.equal(named(groups, 'Hans Zimmer').songs[0], tracks[2]);
  assert.ok(groups.every((group) => !/[,&]/.test(group.name)));
  assert.deepEqual(new Set(groups.flatMap((group) => group.songs)), new Set(tracks));
  assert.deepEqual(tracks.map(trackKey), keys);
  assert.equal(JSON.stringify({ tracks, profiles }), before);
});

test('Unicode presentation and initials normalize without changing storage keys', () => {
  for (const variants of [
    ['A. R. Rahman', 'A.R.Rahman', 'A R Rahman', 'AR Rahman', 'Ａ．Ｒ． Ｒａｈｍａｎ', 'A\u200b.R. Rahman'],
    ['K.J. Yesudas', 'K. J. Yesudas', 'K J Yesudas', 'KJ Yesudas', 'Ｋ．Ｊ．\u00a0Ｙｅｓｕｄａｓ'],
    ['K.S. Chithra', 'K S Chithra', 'KS Chithra'],
    ['Sam C.S.', 'Sam C. S.', 'Sam CS'],
    ['Mary J. Blige', 'Mary J.Blige', 'Mary J Blige'],
    ['Guns N’ Roses', "Guns N' Roses"],
    ['Sigur Ro\u0301s', 'Sigur Rós'],
    ['Björk', 'Bjo\u0308rk - Topic', 'Bjork'],
    ['محمد عبده', 'محمد\u00a0عبده'],
  ]) {
    assert.equal(buildArtistGroups(songs(...variants), {}).length, 1, variants.join(' / '));
  }
  assert.notEqual(normalizeArtistKey('A. R. Rahman'), normalizeArtistKey('A.R. Rahman'));
  assert.equal(artistKey('A. R. Rahman'), artistKey('A.R. Rahman'));
  assert.notEqual(artistKey('می\u200cروم'), artistKey('میروم'), 'meaningful ZWNJ is preserved');
});

test('reviewed transliterations and channel aliases work; arbitrary spelling proximity does not', () => {
  for (const variants of [
    ['Ilaiyaraaja', 'Ilayaraja', 'Ilaiyaraja', 'Ilaiyaraaja Official'],
    ['Sai Abhyankkar', 'Sai Abhyankar'],
    ['Ouseppachan', 'Ousepachan'],
    ['Vidhu Prathap', 'VidhuPrathap Official'],
    ['S. P. Balasubrahmanyam', 'SP Balasubrahmanyam (SpBaluofficial)'],
    ['ImagineDragons', 'Imagine Dragons'],
    ['Official Arctic Monkeys', 'Arctic Monkeys'],
    ['She & Him', 'SheandHimOfficial'],
  ]) assert.equal(buildArtistGroups(songs(...variants), {}).length, 1, variants.join(' / '));

  for (const pair of [
    ['The National', 'National'], ['John Williams', 'John Williamson'],
    ['David Bowie', 'David Boyle'], ['Alan Walker', 'Alan Walter'],
    ['Shaan Rahman', 'Shah Rahman'], ['Anirudh', 'Anirudh Ravichander'],
    ['M G', 'MG'], ['H.E.R.', 'HER'], ['AC/DC', 'ACDC'], ['P!nk', 'Pink'],
    ['René North', 'Rene North'], ['MØ', 'MO'], ['!!!', '!'],
    ['Quartet ＜UK＞', 'Quartet'], ['Nova (UK)', 'Nova'],
  ]) {
    assert.equal(artistNamesMatch(pair[0], pair[1]), false, pair.join(' / '));
    assert.equal(buildArtistGroups(songs(...pair), {}).length, 2, pair.join(' / '));
  }
});

test('official/topic noise is bounded and cannot eat meaningful words or explicit profiles', () => {
  const tracks = songs('Solar Echo', 'Solar Echo Official', 'Solar EchoVEVO', 'Solar Echo — Topic',
    'Solar Echo - Official Artist Channel', 'Solar Echo - Topic (Official)');
  const groups = buildArtistGroups(tracks, {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Solar Echo');
  assert.equal(groups[0].songs.length, 6);
  assert.equal(buildArtistGroups(songs('Official Secrets Act', 'Secrets Act', 'The Official', 'The'), {}).length, 4);
  assert.equal(buildArtistGroups(songs('Moon Official'), {})[0].name, 'Moon Official');
  const cloud = { 'solar echo official': { key: 'a separate band', name: 'Solar Echo Official' } };
  assert.equal(buildArtistGroups(tracks, cloud).length, 2, 'exact ownership beats channel heuristics');
});

test('intentional owners, renamed profiles and D1 track corrections outrank all inferred aliases', () => {
  const distinct = {
    'a. r. rahman': { key: 'first profile', name: 'A. R. Rahman' },
    'a.r. rahman': { key: 'second profile', name: 'A.R. Rahman' },
  };
  const groups = buildArtistGroups(songs('A. R. Rahman', 'A.R. Rahman', 'AR Rahman'), distinct);
  assert.equal(groups.length, 3);
  assert.equal(resolveArtistSelection(groups, 'A. R. Rahman')?.key, 'profile:first profile');
  assert.equal(resolveArtistSelection(groups, 'A.R. Rahman')?.key, 'profile:second profile');
  assert.equal(createArtistIdentityResolver({ profiles: distinct }).resolve('AR Rahman')?.confidence, 'ambiguous');

  const renamed = { ...profiles, 'a.r. rahman': { ...newerRahman, name: 'Another Composer', version: 2 } };
  assert.equal(buildArtistGroups(songs('A. R. Rahman', 'A.R. Rahman'), renamed).length, 2);
  assert.equal(named(buildArtistGroups(songs('A.R. Rahman'), renamed), 'Another Composer').profile?.key, 'a.r. rahman');

  const edited = buildArtistGroups(songs('Anirudh Ravichander', 'Anirudh Ravichandran', 'Alice & Bob', 'Alice', 'Bob'), profiles, {
    authoritativeNames: ['Anirudh Ravichandran', 'Alice & Bob'],
  });
  assert.equal(edited.length, 5);
  assert.equal(named(edited, 'Anirudh Ravichandran').profile, undefined);
  assert.deepEqual(named(edited, 'Alice & Bob').songs.map((track) => track.id), ['2']);
});

test('legacy metadata cannot compete with or refill a cloud profile, including cleared portraits', () => {
  const cleared = { ...newerRahman, updated: 30, version: 2, img: '', bio: '' };
  const cloudAndLegacy = {
    ...profiles, 'a.r. rahman': cleared,
    'a r rahman': { name: 'AR Rahman', img: 'stale:portrait', bio: 'stale biography', updated: 9999 },
  };
  const groups = buildArtistGroups(songs('AR Rahman', 'A. R. Rahman'), cloudAndLegacy);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].profile, cleared);
  assert.equal(groups[0].profile?.bio, '');
  assert.notEqual(groups[0].cover, 'stale:portrait');
  for (const name of ['A. R. Rahman', 'A.R. Rahman', 'AR Rahman']) {
    assert.equal(createArtistIdentityResolver({ profiles: cloudAndLegacy }).resolve(name)?.profile, cleared);
  }
});

test('explicit directory aliases outrank ambiguous display labels and copies use the latest owner version', () => {
  const older = { key: 'one', name: 'Old label', version: 1, updated: 30, img: 'old' };
  const latest = { key: 'one', name: 'Alex North', version: 2, updated: 20, img: 'new' };
  const directory = {
    'old alias': older, 'alex north': latest,
    'another owner': { key: 'two', name: 'Alex North' },
  };
  for (const data of [directory, Object.fromEntries(Object.entries(directory).reverse())]) {
    const resolver = createArtistIdentityResolver({ profiles: data });
    assert.equal(resolver.resolve('Alex North')?.key, 'profile:one');
    assert.equal(resolver.resolve('old alias')?.profile, latest);
    assert.equal(resolver.resolve('another owner')?.key, 'profile:two');
  }
});

test('HF profile keys never gain D1 ownership when the authoritative snapshot is provided', () => {
  const fallback = { 'a r rahman': { key: 'old import key', name: 'AR Rahman', img: 'fallback', updated: 9999 } };
  const groups = buildArtistGroups(songs('AR Rahman', 'A.R. Rahman'), { ...fallback, ...profiles }, { authoritativeProfiles: profiles });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].profile, newerRahman);
  assert.deepEqual(groups[0].profileKeys, ['a. r. rahman', 'a.r. rahman']);
});

test('compound bands and weak separators need evidence; feature credits and known collaborators split safely', () => {
  const names = ['Earth', 'Wind', 'Fire', 'Earth, Wind & Fire', 'Earth, Wind & Fire feat. New Guest',
    'Simon & Garfunkel', 'Tyler, The Creator', 'Tyler, The Creator & Alan Walker',
    'AC/DC', 'Of Mice & Men', 'Strangers & Friends', 'VEDAN with word', 'Duo and Company',
    'Alan Walker', 'Alan Walker (feat. Guest Singer)', 'Alan Walker ft. Other Singer',
    'Arbitrary A', 'Arbitrary B', 'Arbitrary A x Arbitrary B'];
  const groups = buildArtistGroups(songs(...names), profiles);
  assert.equal(named(groups, 'Earth, Wind & Fire').songs.length, 2);
  assert.equal(named(groups, 'New Guest').songs.length, 1);
  assert.equal(named(groups, 'Tyler, The Creator').songs.length, 2);
  assert.equal(named(groups, 'Alan Walker').songs.length, 4);
  assert.equal(named(groups, 'Arbitrary A').songs.length, 2);
  assert.equal(named(groups, 'Arbitrary B').songs.length, 2);
  for (const name of ['AC/DC', 'Of Mice & Men', 'Strangers & Friends', 'VEDAN with word', 'Duo and Company']) assert.ok(named(groups, name), name);
  const joint = { 'arbitrary a & arbitrary b': { key: 'joint project', name: 'Arbitrary A & Arbitrary B' } };
  assert.equal(buildArtistGroups(songs('Arbitrary A', 'Arbitrary B', 'Arbitrary A & Arbitrary B'), joint).length, 3);
});

test('repeated aliases count a shared track once, without losing different recordings or mutating tracks', () => {
  const first = song('A.R. Rahman & A. R. Rahman', 'first', { videoId: 'abcdefghijk', title: 'Same title' });
  const second = song('A.R. Rahman', 'second', { videoId: 'bcdefghijkl', title: 'Same title' });
  Object.freeze(first); Object.freeze(second);
  const groups = buildArtistGroups([first, first, second], profiles);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].songs, [first, second]);
  assert.equal(trackKey(first), 'vid:abcdefghijk');
  assert.equal(trackKey(second), 'vid:bcdefghijkl');
});

test('identity, display metadata, membership and cover are independent of catalogue and profile iteration order', () => {
  const tracks = songs('A.R. Rahman', 'A. R. Rahman', 'A R Rahman', 'Anirudh Ravichandran',
    'Alan Walker & Torine', 'Alan Walker & Sorana', 'Foxtrot', 'FOX TROT', 'foxtrot', 'Fooxtrot',
    'Solar Echo', 'Solar Echo Official', 'The National', 'National');
  const expected = snapshot(buildArtistGroups(tracks, profiles));
  const reversedProfiles = Object.fromEntries(Object.entries(profiles).reverse());
  for (const order of [tracks.slice().reverse(), [...tracks.slice(4), ...tracks.slice(0, 4)]]) {
    assert.deepEqual(snapshot(buildArtistGroups(order, reversedProfiles)), expected);
  }
});

test('selections survive audited profile convergence, but never jump to another removed owner', () => {
  const tracks = songs('A. R. Rahman', 'A.R. Rahman');
  const groups = buildArtistGroups(tracks, profiles);
  assert.equal(resolveArtistSelection(groups, 'profile:a.r. rahman'), groups[0]);
  assert.equal(resolveArtistSelection(groups, 'profile:a. r. rahman'), groups[0]);
  const selection = selectArtist(groups[0]);
  Object.freeze(selection.profileKeys); Object.freeze(selection.aliases); Object.freeze(selection);
  assert.equal(resolveArtistSelection(groups, selection), groups[0]);

  const separate = buildArtistGroups(tracks, {
    'a. r. rahman': { key: 'one', name: 'A. R. Rahman' },
    'a.r. rahman': { key: 'two', name: 'A.R. Rahman' },
  });
  const removed = selectArtist(separate.find((group) => group.key === 'profile:one')!);
  assert.equal(resolveArtistSelection(separate.filter((group) => group.key !== removed.key), removed), undefined);
  assert.equal(resolveArtistSelection(buildArtistGroups(songs('National'), {}), 'The National'), undefined);
});

test('a reserved alias cannot navigate to another artist just because its real owner has no loaded tracks', () => {
  const directory = {
    'anirudh ravichander': { key: 'one', name: 'Anirudh Ravichander' },
    'anirudh ravichandran': { key: 'two', name: 'Anirudh Ravichandran' },
  };
  const groups = buildArtistGroups(songs('Anirudh Ravichander'), directory);
  assert.equal(resolveArtistSelection(groups, 'Anirudh Ravichander'), groups[0]);
  assert.equal(resolveArtistSelection(groups, 'Anirudh Ravichandran'), undefined);
  assert.equal(resolveArtistSelection(groups, 'Anirudh Ravichandran - Topic'), undefined);
});

test('similar large catalogues do not form fuzzy chains; invalid credits cannot create junk groups', () => {
  const tracks = Array.from({ length: 1000 }, (_, i) => song('Session Performer ' + i, String(i)));
  const groups = buildArtistGroups([...tracks, ...songs('', ' ', 'Unknown Artist', 'Unknown Artist - Topic'), null], {});
  assert.equal(groups.length, 1000);
  assert.ok(groups.every((group) => group.songs.length === 1));
  const resolver = createArtistIdentityResolver({ names: ['Alice', 'Bob'] });
  assert.deepEqual(resolver.splitCredits('Alice & & Bob'), ['Alice & & Bob']);
  assert.deepEqual(resolver.splitCredits('Alice (Band & Choir)'), ['Alice (Band & Choir)']);
  assert.deepEqual(resolver.splitCredits('Alice (feat. Bob'), ['Alice (feat. Bob']);
});
