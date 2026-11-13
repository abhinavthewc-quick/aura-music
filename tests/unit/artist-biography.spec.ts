import { expect, test } from '@playwright/test';
import { biographyFromWikipedia } from '../../src/core/artist-biography';

const page = (title: string, extract = `${title} is a singer and composer.`) => ({ title, extract, pageprops: {} });
const response = (...pages: any[]) => ({ query: { pages: Object.fromEntries(pages.map((value, index) => [index, value])) } });

test('artist biographies choose a matching musician and keep the full plain-text introduction', () => {
  const extract = 'Sai Abhyankkar is an Indian musician, composer and singer.\n\nAnother paragraph.';
  expect(biographyFromWikipedia(response(page('Sai Abhyankkar', extract)), 'Sai Abhyankkar'))
    .toEqual({ text: extract, title: 'Sai Abhyankkar' });
});

test('missing, ambiguous, unrelated and same-named non-music pages are not biographies', () => {
  for (const candidate of [
    { ...page('Aura Test'), missing: '' },
    { ...page('Aura Test'), pageprops: { disambiguation: '' } },
    page('Different Artist'),
    page('Aura Test', 'Aura Test is a politician and lawyer.'),
    { title: 'Aura Test', extract: null },
  ]) expect(biographyFromWikipedia(response(candidate), 'Aura Test')).toBeNull();
  expect(biographyFromWikipedia(null, 'Aura Test')).toBeNull();
});

test('music-specific titles and Wikipedia redirects can resolve an artist', () => {
  expect(biographyFromWikipedia(response(page('Aura Test (composer)')), 'Aura Test')?.title).toBe('Aura Test (composer)');
  const data = response(page('Artist Stage Name'));
  (data.query as any).redirects = [{ from: 'Artist Full Name', to: 'Artist Stage Name' }];
  expect(biographyFromWikipedia(data, 'Artist Full Name')?.title).toBe('Artist Stage Name');
});
