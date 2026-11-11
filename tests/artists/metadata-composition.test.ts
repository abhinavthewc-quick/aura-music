import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtistProfile } from '../../lib/artistProfiles.js';
import {
  composeArtistMetadata, type ArtistMetadataCredit, type AutomaticArtistMetadata, type DisplayArtistProfile,
} from '../../lib/artistMetadata.js';

const imageCredit: ArtistMetadataCredit = Object.freeze({
  title: 'Artist portrait', url: 'https://commons.example/portrait', author: 'Photographer',
  license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
});
const bioCredit: ArtistMetadataCredit = Object.freeze({ title: 'Artist article', url: 'https://encyclopedia.example/artist' });
const automatic: AutomaticArtistMetadata = Object.freeze({
  name: 'Provider spelling must not own identity', entityId: 'provider:123',
  img: 'https://images.example/automatic.jpg', bio: 'Automatic biography.', imageCredit, bioCredit,
  fetchedAt: 100, expiresAt: 200,
});
const stored: ArtistProfile = Object.freeze({
  key: 'original owner', name: 'Admin display name', img: '/api/artist-image?id=stored.png', bio: 'Stored biography.',
  genres: ['Soul'], social: 'https://artist.example/', updated: 42, version: 1, source: 'admin',
  imgOverride: true, bioOverride: true,
});

test('explicit overrides retain manual values and clears without automatic credits', () => {
  for (const values of [{ img: stored.img, bio: stored.bio }, { img: '', bio: '' }]) {
    const profile = { ...stored, ...values };
    assert.deepEqual(composeArtistMetadata(profile, automatic), profile);
  }
});

test('each override is independent; unlocked fields use automatic values and only their credits', () => {
  const manualImage = composeArtistMetadata({ ...stored, bio: '', bioOverride: false }, automatic)!;
  assert.equal(manualImage.img, stored.img);
  assert.equal(manualImage.bio, automatic.bio);
  assert.equal(manualImage.imageCredit, undefined);
  assert.equal(manualImage.bioCredit, bioCredit);

  const manualBio = composeArtistMetadata({ ...stored, imgOverride: false, bio: '' }, automatic)!;
  assert.equal(manualBio.img, automatic.img);
  assert.equal(manualBio.bio, '');
  assert.equal(manualBio.imageCredit, imageCredit);
  assert.equal(manualBio.bioCredit, undefined);
});

test('explicit false permits automatic data even for nonempty admin and manifest fields', () => {
  for (const source of ['admin', 'manifest'] as const) {
    const display = composeArtistMetadata({ ...stored, source, imgOverride: false, bioOverride: false }, automatic)!;
    assert.equal(display.img, automatic.img);
    assert.equal(display.bio, automatic.bio);
    assert.equal(display.imageCredit, imageCredit);
    assert.equal(display.bioCredit, bioCredit);
    assert.equal(display.source, source);
  }
});

test('empty or whitespace automatic fields fall back to stored values without misleading credits', () => {
  const profile = { ...stored, imgOverride: false, bioOverride: false };
  for (const empty of [undefined, '', ' \n\t ']) {
    const noImage = composeArtistMetadata(profile, { ...automatic, img: empty })!;
    assert.equal(noImage.img, stored.img);
    assert.equal(noImage.imageCredit, undefined);
    assert.equal(noImage.bioCredit, bioCredit);
    const noBio = composeArtistMetadata(profile, { ...automatic, bio: empty })!;
    assert.equal(noBio.bio, stored.bio);
    assert.equal(noBio.bioCredit, undefined);
    assert.equal(noBio.imageCredit, imageCredit);
  }
});

test('old managed snapshots without flags retain whole-profile ownership, including missing and blank fields', () => {
  for (const source of [undefined, 'admin', 'manifest'] as const) {
    for (const fields of [{}, { img: '', bio: '' }, { img: stored.img, bio: stored.bio }]) {
      const profile: ArtistProfile = { key: 'owner', name: 'Stored name', version: 1, source, ...fields };
      assert.deepEqual(composeArtistMetadata(profile, automatic), profile);
    }
  }
});

test('fresh flags unlock only their own field while missing managed flags remain conservative', () => {
  const imageOnly = composeArtistMetadata({ key: 'owner', version: 2, imgOverride: false, bio: '' }, automatic)!;
  assert.equal(imageOnly.img, automatic.img);
  assert.equal(imageOnly.bio, '');
  assert.equal(imageOnly.bioCredit, undefined);
  const bioOnly = composeArtistMetadata({ key: 'owner', version: 2, img: '', bioOverride: false }, automatic)!;
  assert.equal(bioOnly.img, '');
  assert.equal(bioOnly.bio, automatic.bio);
  assert.equal(bioOnly.imageCredit, undefined);
});

test('plain legacy HF profiles are fallbacks; explicit overrides still work without managed versions', () => {
  const legacy: ArtistProfile = { name: 'Legacy name', img: 'https://images.example/legacy.jpg', bio: 'Legacy biography.' };
  const display = composeArtistMetadata(legacy, automatic)!;
  assert.equal(display.name, legacy.name);
  assert.equal(display.img, automatic.img);
  assert.equal(display.bio, automatic.bio);
  assert.equal(display.key, undefined);
  const cleared = { ...legacy, img: '', bio: '', imgOverride: true, bioOverride: true };
  assert.deepEqual(composeArtistMetadata(cleared, automatic), cleared);
});

test('artists without profiles receive display fields, never provider ownership or identity', () => {
  for (const profile of [null, undefined]) {
    assert.deepEqual(composeArtistMetadata(profile, automatic), {
      img: automatic.img, bio: automatic.bio, imageCredit, bioCredit,
    });
    assert.deepEqual(composeArtistMetadata(profile, { ...automatic, img: undefined, imageCredit: undefined }), {
      bio: automatic.bio, bioCredit,
    });
  }
  const savedProfile = { ...stored, imgOverride: false, bioOverride: false };
  const display = composeArtistMetadata(savedProfile, automatic)!;
  for (const key of ['key', 'name', 'genres', 'social', 'updated', 'version', 'source', 'imgOverride', 'bioOverride'] as const) {
    assert.deepEqual(display[key], savedProfile[key]);
  }
  for (const key of ['entityId', 'fetchedAt', 'expiresAt']) assert.equal(Object.hasOwn(display, key), false);
});

test('no stored profile and no usable automatic fields produce no display profile', () => {
  assert.equal(composeArtistMetadata(null, null), null);
  assert.equal(composeArtistMetadata(undefined, undefined), null);
  assert.equal(composeArtistMetadata(null, { ...automatic, img: '', bio: ' \t ' }), null);
  assert.deepEqual(composeArtistMetadata({}, null), {});
});

test('missing automatic data preserves fallback values and strips credits from previously composed inputs', () => {
  const previous: DisplayArtistProfile = { ...stored, imageCredit, bioCredit };
  for (const missing of [null, undefined]) assert.deepEqual(composeArtistMetadata(previous, missing), stored);
  assert.deepEqual(composeArtistMetadata(previous, automatic), stored, 'manual overrides cannot keep old automatic credits');
  const uncredited = composeArtistMetadata({ ...stored, imgOverride: false, bioOverride: false }, {
    ...automatic, imageCredit: undefined, bioCredit: undefined,
  })!;
  assert.equal(uncredited.img, automatic.img);
  assert.equal(uncredited.bio, automatic.bio);
  assert.equal(Object.hasOwn(uncredited, 'imageCredit'), false);
  assert.equal(Object.hasOwn(uncredited, 'bioCredit'), false);
});

test('composition is pure and leaves directory fields and the metadata cache unchanged', () => {
  const profile = Object.freeze({ ...stored, imgOverride: false, bioOverride: false });
  const before = JSON.stringify({ profile, automatic });
  const first = composeArtistMetadata(profile, automatic)!;
  assert.notEqual(first, profile);
  assert.deepEqual(composeArtistMetadata(profile, automatic), first);
  assert.equal(JSON.stringify({ profile, automatic }), before);
});
