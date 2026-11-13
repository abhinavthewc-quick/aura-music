/* Optional Playwright runner for the existing isolated Vite fixture. No server
   or dependency installation is automatic; output stays outside the checkout. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.AURA_BROWSER_ORIGIN || 'http://127.0.0.1:5186';
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Browser fixtures must run on 127.0.0.1, never production.');
const output = resolve(process.env.AURA_BROWSER_OUTPUT || '../aura-artist-browser-results');
await mkdir(output, { recursive: true });
const only = new Set((process.env.AURA_BROWSER_SUITES || '').split(',').filter(Boolean));
const widths = (process.env.AURA_BROWSER_WIDTHS || '390,1440').split(',').map(Number);
const suites = [
  ['main-and-identity', '', 'artists/browser-regressions.js', 'runBrowserRegressions', 'artists/browser-identity-regressions.js', 'runArtistIdentityRegressions'],
  ['artist-page', '?artist-page', 'artists/browser-page-regressions.js', 'runArtistPageRegressions'],
  ['artist-page-playback', '?artist-page', 'artists/browser-page-regressions.js', 'runArtistPagePlaybackRegressions'],
  ['automatic-metadata', '', 'artists/browser-metadata-regressions.js', 'runAutomaticMetadataRegressions'],
  ['metadata-held', '?metadata=held-ready', 'artists/browser-metadata-regressions.js', 'runMetadataLookupRegressions'],
  ['admin-artists', '?page=admin', 'artists/browser-regressions.js', 'runBrowserRegressions'],
  ['admin-metadata', '?page=admin', 'artists/browser-metadata-regressions.js', 'runAdminMetadataRegressions'],
  ['admin-metadata-held', '?page=admin&admin-gate=held', 'artists/browser-metadata-regressions.js', 'runAdminMetadataGateRegressions'],
  ['admin-metadata-denied', '?page=admin&admin-gate=denied', 'artists/browser-metadata-regressions.js', 'runAdminMetadataGateRegressions'],
  ['listener-credits', '?credits&cloud', 'artists/browser-credit-regressions.js', 'runArtistCreditRegressions'],
  ['admin-credits', '?page=admin&credits', 'artists/browser-credit-regressions.js', 'runAdminArtistCreditRegressions'],
  ['playback', '', 'playback/browser-playback-regressions.js', 'runPlaybackRegressions'],
  ['queue-playback', '', 'artists/browser-identity-regressions.js', 'runQueuePlaybackRegressions'],
  ['library-races', '', 'artists/browser-library-races.js', 'runLibraryRaceRegressions'],
  ['playlist-sharing', '', 'playlists/browser-playlist-regressions.js', 'runPlaylistSharingRegressions'],
  ['rooms', '?page=rooms', 'artists/browser-room-regressions.js', 'runRoomRegressions'],
  ['signed-out-metadata', '?signed-out', 'artists/browser-metadata-regressions.js', 'runSignedOutMetadataRegressions'],
  ['signed-out-admin-metadata', '?page=admin&signed-out', 'artists/browser-metadata-regressions.js', 'runSignedOutMetadataRegressions'],
];
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
const results = [];
async function contextFor(width) {
  const context = await browser.newContext({ viewport: { width, height: width < 900 ? 900 : 960 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return context;
}
async function runSuite(suite, width) {
  const [name, query, module, entry, secondModule, secondEntry] = suite;
  const context = await contextFor(width), page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin + '/tests/artists/browser.html' + query);
    await page.waitForFunction(() => window.__auraFixture && (document.getElementById('musicApp') || document.getElementById('gateCard') || document.getElementById('joinView')));
    if (!query.includes('page=') && !query.includes('signed-out')) {
      // A warm cache starts with catalogLoading=false. Wait for the actual
      // fixture listing/reconciliation, not just the initial cached paint.
      await page.waitForFunction(() => !document.getElementById('musicApp').hidden && !window.state?.catalogLoading &&
        window.state?.hfSongs.length && window.state.hfSongs.every(song => song.hfUrl) &&
        window.state.songs.some(song => song.isLocal && song.url?.startsWith('blob:')));
    }
    const parts = await page.evaluate(async ({ module, entry, secondModule, secondEntry }) => {
      const first = await (await import('/tests/' + module))[entry]();
      const second = secondModule ? await (await import('/tests/' + secondModule))[secondEntry]() : undefined;
      return second ? [first, second] : [first];
    }, { module, entry, secondModule, secondEntry });
    assert.deepEqual(errors, [], 'uncaught browser errors');
    const passed = parts.reduce((total, part) => total + part.passed, 0);
    results.push({ name, width, passed, parts });
    console.log(`PASS ${name} ${width}px: ${passed} checks`);
  } catch (error) {
    results.push({ name, width, failed: String(error), errors });
    console.error(`FAIL ${name} ${width}px: ${error.message}`);
    await page.screenshot({ path: resolve(output, `${name}-${width}-failed.png`), fullPage: true }).catch(() => {});
  } finally { await context.close(); }
}
async function runNativeArtistChecks(width) {
  const name = 'native-artist-layout', context = await contextFor(width), page = await context.newPage();
  const checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (value, label) => { assert.ok(value, label); checks.push(label); };
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(origin + '/tests/artists/browser.html?artist-page');
    await page.waitForFunction(() => window.state?.hfSongs.length && window.state.hfSongs.every(song => song.hfUrl) &&
      !window.state.catalogLoading && !document.getElementById('musicApp').hidden);
    await page.evaluate(async () => {
      await (await import('/src/app.ts')).ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const fixture = window.__auraFixture;
      await fixture.publishMetadata('Kendrick Lamar', fixture.readyMetadata('Kendrick Lamar', {
        bio: 'A performer and songwriter whose recordings are kept in this isolated music catalogue. '.repeat(18).trim(),
      }));
      window.state.audio.muted = true;
    });
    await page.locator('#homeArtistsChip').click();
    await page.locator('#homeArtistsFullGrid [data-artist-open]').filter({ hasText: 'Kendrick Lamar' }).press('Enter');
    await page.locator('#artistName').waitFor({ state: 'visible' });
    check(await page.locator('#artistName').textContent() === 'Kendrick Lamar' && await page.locator('#artistName').evaluate(el => el === document.activeElement), 'native Enter opens the selected artist and focuses its title');
    await page.waitForFunction(() => !document.querySelector('#artistHeroCard [data-artist-bio-toggle]').hidden);
    const design = await page.locator('#homeArtistDetailView').evaluate(root => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      columns: getComputedStyle(root.querySelector('.artist-detail-layout')).gridTemplateColumns.split(' ').length,
      radius: getComputedStyle(root.querySelector('.artist-hero-card')).borderTopLeftRadius,
      background: getComputedStyle(root.querySelector('[data-artist-play-all]')).backgroundColor,
      filter: getComputedStyle(root.querySelector('.artist-hero-image')).filter,
      transform: getComputedStyle(root.querySelector('.artist-hero-image')).transform,
    }));
    check(design.overflow <= 1 && design.columns === (width >= 1100 ? 2 : 1), 'responsive artist layout stays within the viewport and uses the intended columns');
    check(design.radius === '20px' && design.background === 'rgb(255, 255, 255)' && design.filter === 'none' && design.transform === 'none', 'supplied hero and white transport styling respect system reduced motion');
    for (const selector of ['[data-artist-back]', '[data-artist-play-all]', '[data-artist-shuffle]', '[data-artist-bio-toggle]']) {
      const button = page.locator('#homeArtistDetailView ' + selector), box = await button.boundingBox();
      check(box?.height >= 44 && box?.width >= 44, selector + ' has a 44px native touch target');
    }
    await page.screenshot({ path: resolve(output, `artist-home-${width}.png`), fullPage: true, animations: 'disabled' });
    const toggle = page.locator('#homeArtistDetailView [data-artist-bio-toggle]');
    await toggle.press('Enter');
    check(await toggle.getAttribute('aria-expanded') === 'true', 'native Enter expands the biography');
    await toggle.press('Space');
    check(await toggle.getAttribute('aria-expanded') === 'false', 'native Space collapses the biography');
    await page.locator('#artistPlayAllBtn').press('Enter');
    await page.waitForFunction(() => window.state.isPlaying && !window.state.audio.paused);
    const row = page.locator('#artistSongsList .artist-song-row').first();
    await row.press('Space');
    await page.waitForFunction(() => !window.state.isPlaying && window.state.audio.paused);
    await row.press('Enter');
    await page.waitForFunction(() => window.state.isPlaying && !window.state.audio.paused);
    check((await row.getAttribute('aria-label')).startsWith('Pause '), 'native row Space and Enter pause and resume the selected artist');
    await page.locator('#homeArtistDetailView [data-artist-back]').press('Enter');
    check(await page.locator('#homeArtistsChip').evaluate(el => document.activeElement === el), 'Home back restores its own keyboard opener');

    await page.evaluate(() => { window.goTab('tabLibrary'); window.setLibView('artists'); });
    await page.locator('#librarySongList .artist-tile').filter({ hasText: 'Kendrick Lamar' }).press('Enter');
    await page.locator('#libraryArtistName').waitFor({ state: 'visible' });
    check(await page.locator('#libraryArtistName').evaluate(el => document.activeElement === el), 'native Library tile Enter focuses the shared artist title');
    check(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), 'Library shared artist design has no horizontal overflow');
    const libraryToggle = page.locator('#libraryArtistHeroCard [data-artist-bio-toggle]');
    await libraryToggle.press('Enter');
    const like = page.locator('#libraryArtistSongsList [data-like-song-id]').first();
    await like.press('Space');
    check(await like.getAttribute('aria-pressed') === 'true' && await like.evaluate(el => document.activeElement === el) &&
      await libraryToggle.getAttribute('aria-expanded') === 'true', 'native artist favorite preserves keyboard focus and biography expansion');
    const menu = page.locator('#libraryArtistSongsList [data-song-menu]').first();
    await menu.press('Enter');
    await page.waitForFunction(() => document.getElementById('trackSheetOverlay').classList.contains('active') &&
      document.getElementById('trackSheetOverlay').contains(document.activeElement));
    check(await page.locator('#trackSheetTitle').textContent() === 'Kendrick Lamar recording 1', 'native artist menu targets its original song');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trackSheetOverlay').classList.contains('active'));
    await page.waitForFunction(() => document.activeElement === document.querySelector('#libraryArtistSongsList [data-song-menu]'));
    check(await menu.evaluate(el => document.activeElement === el), 'Escape restores the artist menu opener');
    await libraryToggle.press('Enter');
    await page.screenshot({ path: resolve(output, `artist-library-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.locator('#librarySongList [data-artist-back]').press('Enter');
    check(await page.locator('#libViewSeg [data-view="artists"]').evaluate(el => document.activeElement === el), 'Library back restores its own tab control');
    check(await page.evaluate(() => localStorage.getItem('auraPlaylists') === window.__auraFixture.playlist), 'native artist actions leave saved playlists unchanged');
    if (width === 390) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        const song = window.state.songs.find(song => song.artist === 'Kendrick Lamar');
        for (let index = 0; index < 20; index++) window.state.songs.push({ ...song, id: 'fixture:scroll-' + index, title: 'Scroll recording ' + index });
        window.goTab('tabHome'); window.openArtistDetail('Kendrick Lamar', false); scrollTo(0, 340);
      });
      await page.waitForFunction(() => parseFloat(document.querySelector('#artistHeroCard .artist-hero-image').style.getPropertyValue('--artist-image-blur')) > 0);
      check(await page.locator('#artistName').evaluate(el => getComputedStyle(el).filter === 'none'), 'scroll blur affects the portrait, not the reading text');
      await page.evaluate(() => document.body.classList.add('aura-reduce-motion'));
      check(await page.locator('#artistHeroCard .artist-hero-image').evaluate(el => getComputedStyle(el).filter === 'none'), 'the in-app reduced-motion preference also disables portrait motion');
    }
    assert.deepEqual(errors, [], 'native artist page has no uncaught errors');
    results.push({ name, width, passed: checks.length, checks });
    console.log(`PASS ${name} ${width}px: ${checks.length} checks`);
  } catch (error) {
    results.push({ name, width, failed: String(error), checks, errors });
    console.error(`FAIL ${name} ${width}px: ${error.message}`);
    await page.screenshot({ path: resolve(output, `${name}-${width}-failed.png`), fullPage: true }).catch(() => {});
  } finally { await context.close(); }
}
try {
  for (const width of widths) for (const suite of suites) {
    if (!only.size || only.has(suite[0])) await runSuite(suite, width);
  }
  if (!only.size || only.has('native-artist-layout')) {
    for (const width of [320, 390, 430, 768, 1024, 1440]) await runNativeArtistChecks(width);
  }
} finally {
  await browser.close();
  const failed = results.filter(result => result.failed).length;
  await writeFile(resolve(output, 'browser-results.json'), JSON.stringify({ origin, suites: results.length, failed,
    passed: results.reduce((total, result) => total + (result.passed || 0), 0), results }, null, 2));
  console.log(`Browser results: ${results.length} suites, ${failed} failed; ${output}`);
  if (failed) process.exitCode = 1;
}
