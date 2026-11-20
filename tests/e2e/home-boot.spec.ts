import { expect, test } from '@playwright/test';

/* The hand-off from the logo reveal to a populated Home.
   A cold visitor used to land on "No library tracks are available yet…" and
   "Loading artists…" while the bucket was listed in the browser. The document
   now ships skeleton rails and /api/catalog answers with one cached payload. */

const payload = {
  v: 1,
  builtAt: 1700000000000,
  tracks: [
    { id: 'hf:A - One [prXvpLr8WIs].opus', title: 'One', artist: 'A', album: '', year: '2024', duration: 200, videoId: 'prXvpLr8WIs', hfPath: 'A - One [prXvpLr8WIs].opus', img: 'https://huggingface.co/buckets/Angelrider/sonora/resolve/covers/one.webp', size: 1000, audioVersions: { bass: { path: 'versions/prXvpLr8WIs/bass.mp3', duration: 200 } } },
    { id: 'hf:A - Two [abcdefghijk].opus', title: 'Two', artist: 'A', album: '', year: '2024', duration: 210, videoId: 'abcdefghijk', hfPath: 'A - Two [abcdefghijk].opus', img: 'https://huggingface.co/buckets/Angelrider/sonora/resolve/covers/two.webp', size: 1000, audioVersions: {} },
  ],
};

async function routeColdBoot(page: import('@playwright/test').Page, catalog: () => Promise<any>) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/catalog') {
      const body = await catalog();
      if (body === 'offline') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.hostname === 'huggingface.co') {
      /* Empty bucket listing: the direct fallback path. */
      return route.fulfill({ contentType: 'application/json', body: url.pathname.includes('manifest.json') ? '{}' : '[]' });
    }
    if (/betterlyrics|binilyrics|musixmatch|lrclib|subtitles-for-youtube/.test(url.hostname)) return route.fulfill({ status: 404, body: '{}' });
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.fulfill({ status: 404, body: '' });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('auraSession_v2', JSON.stringify({ email: 'audit@example.com', name: 'Audit Listener', picture: '', exp: Math.floor(Date.now() / 1000) + 86400, token: 'local:audit' }));
    localStorage.setItem('auraHfCatalog_v1', JSON.stringify({ tracks: [], at: Date.now() }));
  });
}

test('a cold home paints skeleton rails instead of an empty-library message', async ({ page }) => {
  let release: (value: any) => void = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  await routeColdBoot(page, () => gate as Promise<any>);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.getElementById('auraLoader')?.remove());

  /* Shipped in the HTML: visible before the module graph has even evaluated. */
  await expect(page.locator('#ytmQuickGrid .ytm-track-card[aria-hidden="true"]')).toHaveCount(12);
  await expect(page.locator('#homeFeaturedArtistsShelf .ytm-artist-card[aria-hidden="true"]')).toHaveCount(8);
  await expect(page.locator('#auraPicksScroll .aura-pick[aria-hidden="true"]')).toHaveCount(8);
  await expect(page.locator('#ytmQuickGrid .home-empty')).toHaveCount(0);

  /* Still nothing from the app: no "no tracks" text anywhere on Home. */
  await expect(page.locator('#homeMainView')).not.toContainText('No library tracks are available yet');
  await expect(page.locator('#homeMainView')).not.toContainText('Loading artists');

  release(payload);
  await expect(page.locator('#ytmQuickGrid .ytm-track-card:not([aria-hidden])')).toHaveCount(2);
  await expect(page.locator('#ytmQuickGrid .skeleton-block')).toHaveCount(0);
  await expect(page.locator('#ytmQuickGrid')).toContainText('One');
  await expect(page.evaluate(() => (globalThis as any).state.songs.length)).resolves.toBe(2);
  await expect(page.evaluate(() => Object.keys((globalThis as any).state.songs[0].audioVersions))).resolves.toEqual(['bass']);
});

test('a failing catalogue Function falls back to the bucket listing without a fatal error', async ({ page }) => {
  await routeColdBoot(page, async () => 'offline');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.getElementById('auraLoader')?.remove());

  /* Fallback runs, finds nothing, and the empty state replaces the skeleton
     rather than shimmering forever. */
  await expect(page.locator('#ytmQuickGrid .home-empty')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#ytmQuickGrid .skeleton-block')).toHaveCount(0);
  expect(errors).toEqual([]);
});