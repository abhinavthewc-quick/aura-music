import { expect, test, type Page } from '@playwright/test';
import { currentTitle, seedAura } from './fixtures';

const biography = 'Aura Test is a singer and composer from the isolated test catalogue. '.repeat(12);

async function profile(page: Page, name = 'Aura Test', bio = biography): Promise<void> {
  await page.evaluate(({ name, bio }) => {
    localStorage.setItem('auraHfArtists_v1', JSON.stringify({
      ...JSON.parse(localStorage.getItem('auraHfArtists_v1') || '{}'),
      [name.toLowerCase()]: { name, img: '/aura-vinyl-logo.png', bio, imgOverride: true, bioOverride: true },
    }));
  }, { name, bio });
}

function automaticProfile(name = 'Aura Test', bio = biography) {
  const now = Date.now();
  return { key: name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(), status: 'ready', metadata: {
    name, entityId: 'fixture:artist', bio, fetchedAt: now, expiresAt: now + 86400000,
    bioCredit: { title: 'Wikipedia introduction', url: `https://en.wikipedia.org/wiki/${name.replaceAll(' ', '_')}`,
      author: 'Wikipedia contributors', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  } };
}

async function metadataRoute(page: Page, respond: (name: string) => Promise<any> | any) {
  // Page routes win over seedAura's offline context route and are installed
  // before bootstrap starts the authenticated, bounded metadata queue.
  await page.route('**/api/artist-metadata?**', async route => {
    const name = new URL(route.request().url()).searchParams.get('name') || '';
    const body = name === 'Aura Test' ? await respond(name) : {key:name.toLowerCase(),status:'not-found'};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
}

async function openHomeArtist(page: Page, name = 'Aura Test'): Promise<void> {
  await page.evaluate((name) => (globalThis as any).openArtistDetail(name), name);
  await expect(page.locator('#artistName')).toHaveText(name);
  await expect(page.locator('#homeArtistDetailView')).toBeVisible();
}

async function openLibraryArtist(page: Page, name = 'Aura Test'): Promise<void> {
  await page.evaluate(() => {
    const app = globalThis as any;
    app.goTab('tabLibrary');
    app.setLibView('artists');
  });
  await page.locator('#librarySongList').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#libraryArtistName')).toHaveText(name);
}

test('Home artist uses saved metadata, expandable biography, and the Artists back action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await seedAura(page);
  await profile(page);
  await page.locator('#homeArtistsChip').click();
  await page.locator('#homeArtistsFullGrid [data-artist-open]').filter({hasText:'Aura Test'}).press('Enter');
  await expect(page.locator('#artistName')).toHaveText('Aura Test');
  await expect(page.locator('#artistHeroCard .artist-hero-image')).toHaveAttribute('src', '/aura-vinyl-logo.png');
  await expect(page.locator('#artistHeroCard .artist-hero-count')).toHaveText('2 songs in your music');
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText(biography.trim());
  const toggle = page.locator('#artistHeroCard [data-artist-bio-toggle]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.press('Enter');
  await expect(toggle).toHaveText('Less');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveCSS('display', 'block');
  await toggle.click();
  await expect(toggle).toHaveText('More');
  await page.getByRole('button', { name: 'Back to Artists', exact: true }).click();
  await expect(page.locator('#homeArtistDetailView')).toBeHidden();
  await expect(page.locator('#homeArtistsView')).toBeVisible();
  await expect(page.locator('#homeArtistsChip')).toBeFocused();
  expect(fixture.pageErrors).toEqual([]);
});

test('artist Play all is ordered, rows pause/resume, and Shuffle stays inside the artist', async ({ page }) => {
  const fixture = await seedAura(page,{repeat:'off'});
  await profile(page);
  await openHomeArtist(page);
  await page.evaluate(() => { (globalThis as any).state.isShuffle = true; });
  await page.locator('#artistPlayAllBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  expect(await page.evaluate(() => {
    const state = (globalThis as any).state;
    return { source: state.playbackContext.source, order: state.playbackContext.order, shuffle: state.isShuffle };
  })).toEqual({ source: 'artist', order: ['id:1', 'id:2'], shuffle: false });
  const alpha = page.locator('#artistSongsList [data-artist-track-id="1"]');
  await expect(alpha).toHaveClass(/is-playing/);
  await expect(alpha).toHaveAccessibleName('Pause Alpha by Aura Test');
  await alpha.click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  await expect(alpha).not.toHaveClass(/is-playing/);
  await alpha.press('Enter');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  await page.locator('#nextBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Beta');
  await expect(page.locator('#artistSongsList [data-artist-track-id="2"]')).toHaveClass(/is-playing/);
  await page.locator('#nextBtn').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  expect(await currentTitle(page)).toBe('Beta');
  await page.locator('#artistShuffleBtn').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isShuffle)).toBe(true);
  expect(await page.evaluate(() => (globalThis as any).state.playbackContext.order)).toEqual(['id:1', 'id:2']);
  const selected = await page.evaluate(() => String((globalThis as any).state.activeTrack.id));
  await page.locator(`#artistSongsList [data-artist-track-id="${selected}"]`).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  expect(await page.evaluate(() => (globalThis as any).state.isShuffle)).toBe(true);
  const other = selected === '1' ? '2' : '1';
  await page.locator(`#artistSongsList [data-artist-track-id="${other}"]`).click();
  await expect.poll(() => currentTitle(page)).toBe(other === '1' ? 'Alpha' : 'Beta');
  expect(await page.evaluate(() => (globalThis as any).state.isShuffle)).toBe(false);
  expect(fixture.pageErrors).toEqual([]);
});

test('Library shares the portrait design and keeps favorites, track options, and its own back action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await seedAura(page);
  await profile(page);
  await openLibraryArtist(page);
  await expect(page.locator('#libraryArtistHeroCard .artist-hero-image')).toHaveAttribute('src', '/aura-vinyl-logo.png');
  await expect(page.locator('#libraryArtistHeroCard .artist-bio-text')).toHaveText(biography.trim());
  await expect(page.locator('#tabLibrary > .lib-menu-group').first()).toBeHidden();
  const toggle = page.locator('#libraryArtistHeroCard [data-artist-bio-toggle]');
  await toggle.click();
  await page.locator('#libraryArtistSongsList').getByRole('button', { name: 'Like Alpha', exact: true }).press('Enter');
  const unlike = page.locator('#libraryArtistSongsList').getByRole('button', { name: 'Unlike Alpha', exact: true });
  await expect(unlike).toHaveAttribute('aria-pressed', 'true');
  await expect(unlike).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await page.getByRole('button', { name: 'More options for Alpha', exact: true }).click();
  await expect(page.locator('#trackSheet')).toBeVisible();
  await expect(page.locator('#trackSheetTitle')).toHaveText('Alpha');
  await page.keyboard.press('Escape');
  await page.locator('#libraryArtistPlayAllBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await page.locator('#tabLibrary').getByRole('button', { name: 'Back to Artists', exact: true }).click();
  await expect(page.locator('#libraryArtistHeroCard')).toHaveCount(0);
  await expect(page.locator('#librarySongList .artist-tiles')).toBeVisible();
  await expect(page.locator('#libViewSeg [data-view="artists"]')).toBeFocused();
  expect(fixture.pageErrors).toEqual([]);
});

test('automatic biographies are attributed, cached, and never replace saved overrides', async ({ page }) => {
  const requests: string[] = [];
  await metadataRoute(page,name => { requests.push(name); return automaticProfile(name); });
  const fixture = await seedAura(page);
  await openHomeArtist(page);
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText(biography.trim());
  await page.locator('#artistHeroCard [data-artist-bio-toggle]').click();
  const credit = page.locator('#artistHeroCard [data-artist-credit="bio"]');
  await expect(credit).toBeVisible();
  await expect(credit).toContainText('Wikipedia contributors');
  await expect(credit.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/');
  await expect(credit.getByRole('link', { name: /Wikipedia introduction/ })).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Aura_Test');
  await openHomeArtist(page);
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText(biography.trim());
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('auraAutomaticArtistMetadata_v1') || '{}').entries.find((entry:any) => entry.key==='aura test').metadata.name)).toBe('Aura Test');
  await profile(page, 'Aura Test', 'Saved artist biography.');
  await openHomeArtist(page);
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText('Saved artist biography.');
  const toggle = page.locator('#artistHeroCard [data-artist-bio-toggle]');
  await expect(toggle).toHaveText('Less');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toBeHidden();
  await expect(page.locator('#artistHeroCard [data-artist-credit="bio"]')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(fixture.pageErrors).toEqual([]);
});

test('biography failures do not block songs and recover after the production retry backoff', async ({ page }) => {
  let requests = 0;
  // Advance the captured clock AND its already-scheduled retry timer together.
  // Changing Date.now alone leaves the real 30-second timer waiting unchanged.
  await page.clock.install();
  await metadataRoute(page,name => ++requests === 1 ? {key:'aura test',status:'retry'} : automaticProfile(name));
  const fixture = await seedAura(page);
  await openHomeArtist(page);
  await expect.poll(() => page.evaluate(async () => (await import('/src/core/artistMetadata.ts' as string)).getArtistMetadataResponse('Aura Test')?.status)).toBe('retry');
  await expect(page.locator('#artistHeroCard .artist-bio')).toHaveCount(0);
  await page.locator('#artistPlayAllBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await openHomeArtist(page);
  expect(requests).toBe(1);
  await page.clock.fastForward(31000);
  await page.evaluate(async () => {
    (await import('/src/core/artistMetadata.ts' as string)).prioritizeArtistMetadata('Aura Test','open');
  });
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText(biography.trim());
  expect(requests).toBe(2);
  expect(fixture.pageErrors).toEqual([]);
});

test('late biographies cannot leak into another artist, and unavailable tracks stay disabled', async ({ page }) => {
  let resolveResponse: () => void;
  let announceRequest: () => void;
  const requested = new Promise<void>((resolve) => { announceRequest = resolve; });
  const response = new Promise<void>((resolve) => { resolveResponse = resolve; });
  await metadataRoute(page, async name => {
    announceRequest();
    await response;
    return automaticProfile(name);
  });
  const fixture = await seedAura(page, { missingLocal: true });
  await openHomeArtist(page);
  await requested;
  await profile(page, 'Second Artist', 'Second Artist has its own saved biography.');
  await openHomeArtist(page, 'Second Artist');
  resolveResponse();
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText('Second Artist has its own saved biography.');
  await profile(page, 'My device', 'Local audio artist.');
  await openHomeArtist(page, 'My device');
  await expect(page.locator('#artistPlayAllBtn')).toBeDisabled();
  await expect(page.locator('#artistShuffleBtn')).toBeDisabled();
  await expect(page.locator('#artistSongsList [data-artist-track-id="local-missing"]')).toBeDisabled();
  await page.evaluate(() => (globalThis as any).openArtistDetail('No matching artist'));
  await expect(page.locator('.toast').last()).toContainText('no longer in your library');
  await expect(page.locator('#artistName')).toHaveText('My device');
  await expect(page.locator('#artistPlayAllBtn')).toBeDisabled();
  expect(fixture.pageErrors).toEqual([]);
});

test('a biography loaded while Home is hidden is expandable when the artist page becomes visible', async ({ page }) => {
  let resolveResponse: () => void;
  let announceRequest: () => void;
  const requested = new Promise<void>((resolve) => { announceRequest = resolve; });
  const response = new Promise<void>((resolve) => { resolveResponse = resolve; });
  await metadataRoute(page, async name => {
    announceRequest();
    await response;
    return automaticProfile(name);
  });
  const fixture = await seedAura(page);
  await openHomeArtist(page);
  await requested;
  await page.evaluate(() => (globalThis as any).goTab('tabLibrary'));
  resolveResponse();
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText(biography.trim());
  await page.evaluate(() => (globalThis as any).goTab('tabHome'));
  const toggle = page.locator('#artistHeroCard [data-artist-bio-toggle]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(fixture.pageErrors).toEqual([]);
});

test('artist names and biographies containing markup remain plain text', async ({ page }) => {
  const fixture = await seedAura(page);
  const name = `Artist's <b>name</b>`;
  await profile(page, name, '<img src=x onerror="window.__artistInjected=true"> A musician biography.');
  await page.evaluate((name) => {
    const app = globalThis as any;
    app.state.songs[0].artist = name;
    app.state.songs[1].artist = name;
    app.openHomeArtistsTab();
  }, name);
  await page.locator('#homeArtistsFullGrid [data-artist-open]').filter({ hasText: name }).press('Enter');
  await expect(page.locator('#artistName')).toHaveText(name);
  await expect(page.locator('#artistName b')).toHaveCount(0);
  await expect(page.locator('.artist-bio-text img')).toHaveCount(0);
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toContainText('<img src=x');
  expect(await page.evaluate(() => (window as any).__artistInjected)).toBeUndefined();
  expect(fixture.pageErrors).toEqual([]);
});

test('Home and Library merge artist-name variants and use metadata from either spelling', async ({ page }) => {
  const fixture = await seedAura(page);
  await profile(page, 'A.R. Rahman', 'Saved composer biography.');
  await page.evaluate(() => {
    const app = globalThis as any;
    app.state.songs[0].artist = 'A. R. Rahman - Topic';
    app.state.songs[1].artist = 'A.R. Rahman';
    app.openHomeArtistsTab();
  });
  const artist = page.locator('#homeArtistsFullGrid [data-artist-open]').filter({ hasText: 'A. R. Rahman' });
  await expect(artist).toHaveCount(1);
  await expect(artist).toContainText('2 songs');
  await artist.click();
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText('Saved composer biography.');
  await page.locator('#artistPlayAllBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  const key = await page.evaluate(() => (globalThis as any).state.playbackContext.collectionId);
  await openLibraryArtist(page, 'A. R. Rahman');
  await expect(page.locator('#libraryArtistHeroCard .artist-hero-count')).toHaveText('2 songs in your music');
  await expect(page.locator('#libraryArtistHeroCard .artist-bio-text')).toHaveText('Saved composer biography.');
  await expect(page.locator('#libraryArtistSongsList [data-artist-track-id="1"]')).toHaveAccessibleName('Pause Alpha by A. R. Rahman - Topic');
  await page.locator('#libraryArtistSongsList [data-artist-track-id="1"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  expect(await page.evaluate(() => (globalThis as any).state.playbackContext.collectionId)).toBe(key);
  expect(fixture.pageErrors).toEqual([]);
});

const vevoArtists = [
  { name: 'Kendrick Lamar', channel: 'KendrickLamarVEVO', channelSongs: 2 },
  { name: 'Lewis Capaldi', channel: 'LewisCapaldiVEVO', channelSongs: 1 },
  { name: 'Post Malone', channel: 'PostMaloneVEVO', channelSongs: 2 },
  { name: 'The Kid LAROI.', channel: 'TheKidLAROIVEVO', channelSongs: 1 },
  { name: 'The Neighbourhood', channel: 'TheNeighbourhoodVEVO', channelSongs: 1 },
  { name: 'Travis Scott', channel: 'TravisScottVEVO', channelSongs: 1 },
];

for (const [index, artist] of vevoArtists.entries()) {
  test(`${artist.name} and its VEVO channel share one artist and every song`, async ({ page }) => {
    const fixture = await seedAura(page);
    await page.evaluate(({ artist, channelFirst }) => {
      const app = globalThis as any;
      app.state.songs[0].artist = channelFirst ? artist.channel : artist.name;
      app.state.songs[1].artist = channelFirst ? artist.name : artist.channel;
      if (artist.channelSongs === 2) app.state.songs.push({
        ...app.state.songs[1], id: 'vevo-extra', title: 'Additional channel track', artist: artist.channel,
      });
      app.openHomeArtistsTab();
    }, { artist, channelFirst: index % 2 === 0 });
    const count = artist.channelSongs + 1;
    const card = page.locator('#homeArtistsFullGrid [data-artist-open]').filter({ hasText: artist.name });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.ytm-artist-name')).toHaveText(artist.name);
    await expect(card).toContainText(`${count} songs`);
    await expect(page.locator('#homeArtistsFullGrid .ytm-artist-name').filter({ hasText: /VEVO/i })).toHaveCount(0);
    await page.evaluate(async () => {
      const home = await import('/src/features/home.ts' as string);
      home.renderFeaturedArtistsShelf();
      home.renderArtistSpotlight();
    });
    await expect(page.locator('#homeFeaturedArtistsShelf [data-artist-open]').filter({ hasText: artist.name })).toContainText(`${count} songs`);
    const spotlight = page.locator('#artistSpotlightContainer .artist-spotlight-block').filter({ hasText: artist.name });
    await expect(spotlight).toHaveCount(1);
    await expect(spotlight.locator('.spotlight-card')).toHaveCount(count);
    await expect(page.locator('#artistSpotlightContainer .spotlight-header').filter({ hasText: /VEVO/i })).toHaveCount(0);
    await card.click();
    await expect(page.locator('#artistName')).toHaveText(artist.name);
    await expect(page.locator('#artistSongsList [data-artist-track-id]')).toHaveCount(count);
    await page.locator('#artistPlayAllBtn').click();
    await expect.poll(() => currentTitle(page)).toBe('Alpha');
    const order = ['id:1', 'id:2', ...(artist.channelSongs === 2 ? ['id:vevo-extra'] : [])];
    expect(await page.evaluate(() => (globalThis as any).state.playbackContext.order)).toEqual(order);
    const key = await page.evaluate(() => (globalThis as any).state.playbackContext.collectionId);
    await openLibraryArtist(page, artist.name);
    await expect(page.locator('#libraryArtistHeroCard .artist-hero-count')).toHaveText(`${count} songs in your music`);
    await expect(page.locator('#libraryArtistSongsList [data-artist-track-id]')).toHaveCount(count);
    await page.locator('#libraryArtistPlayAllBtn').click();
    expect(await page.evaluate(() => (globalThis as any).state.playbackContext.collectionId)).toBe(key);
    expect(await page.evaluate(() => (globalThis as any).state.playbackContext.order)).toEqual(order);
    await page.evaluate((channel) => (globalThis as any).openArtistDetail(channel), artist.channel);
    await expect(page.locator('#artistName')).toHaveText(artist.name);
    await expect(page.locator('#artistSongsList [data-artist-track-id]')).toHaveCount(count);
    await page.evaluate((channel) => (globalThis as any).playArtistSongs(channel), artist.channel);
    expect(await page.evaluate(() => (globalThis as any).state.playbackContext.order)).toEqual(order);
    await page.evaluate(() => {
      const app = globalThis as any;
      app.goTab('tabLibrary');
      app.setLibView('tracks');
      app.toggleStatsPanel();
    });
    await expect(page.locator('#statsPanel .stats-cell').filter({ hasText: 'Artists' }).locator('.stat-num')).toHaveText('2');
    expect(fixture.pageErrors).toEqual([]);
  });
}

test('VEVO-only artists use saved profile names and keep metadata stored under an old channel handle', async ({ page }) => {
  const fixture = await seedAura(page);
  await page.evaluate(() => {
    const app = globalThis as any;
    app.state.songs[0].artist = app.state.songs[1].artist = 'PostMaloneVEVO';
    localStorage.setItem('auraHfArtists_v1', JSON.stringify({
      'post malone': { name: 'Post Malone', img: '/aura-vinyl-logo.png', bio: 'Saved canonical artist profile.' },
    }));
    app.openHomeArtistsTab();
  });
  await page.locator('#homeArtistsFullGrid [data-artist-open]').filter({ hasText: 'Post Malone' }).click();
  await expect(page.locator('#artistName')).toHaveText('Post Malone');
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText('Saved canonical artist profile.');
  await expect(page.locator('#artistHeroCard .artist-hero-image')).toHaveAttribute('src', '/aura-vinyl-logo.png');
  await openLibraryArtist(page, 'Post Malone');
  await expect(page.locator('#libraryArtistHeroCard .artist-bio-text')).toHaveText('Saved canonical artist profile.');
  await page.evaluate(() => {
    const app = globalThis as any;
    app.state.songs[0].artist = 'Post Malone';
    localStorage.setItem('auraHfArtists_v1', JSON.stringify({
      postmalonevevo: { name: 'PostMaloneVEVO', img: '/aura-thumbnail.png', bio: 'Saved old channel profile.' },
    }));
    app.openArtistDetail('PostMaloneVEVO');
  });
  await expect(page.locator('#artistName')).toHaveText('Post Malone');
  await expect(page.locator('#artistHeroCard .artist-bio-text')).toHaveText('Saved old channel profile.');
  await expect(page.locator('#artistHeroCard .artist-hero-image')).toHaveAttribute('src', '/aura-thumbnail.png');
  await openLibraryArtist(page, 'Post Malone');
  await expect(page.locator('#libraryArtistHeroCard .artist-bio-text')).toHaveText('Saved old channel profile.');
  expect(fixture.pageErrors).toEqual([]);
});

for (const width of [320, 390, 430, 768, 1024, 1440]) {
  test(`artist layout has no overflow and accessible controls at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(page);
    await profile(page);
    await openHomeArtist(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    for (const button of await page.locator('#homeArtistDetailView #artistPlayAllBtn, #homeArtistDetailView #artistShuffleBtn, #homeArtistDetailView [data-artist-bio-toggle], #homeArtistDetailView [data-artist-back]').all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
      await expect(button).toHaveAccessibleName(/[A-Za-z]/);
    }
    await expect(page.locator('#artistPlayAllBtn')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('#artistHeroCard')).toHaveCSS('border-top-left-radius', '20px');
    await expect(page.locator('#artistHeroCard .artist-hero-image')).toHaveCSS('filter', 'none');
    const columns = await page.locator('.artist-detail-layout').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width >= 1100 ? 2 : 1);
    await page.keyboard.press('Tab');
    await page.locator('#artistPlayAllBtn').focus();
    await expect(page.locator('#artistPlayAllBtn')).toBeFocused();
    expect(await page.locator('#artistPlayAllBtn').evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await page.screenshot({ path: info.outputPath(`artist-${width}.png`), animations: 'disabled' });
    await expect(page.locator('#artistName')).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await openLibraryArtist(page);
    await expect(page.locator('#tabLibrary > .lib-menu-group').first()).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(fixture.pageErrors).toEqual([]);
  });
}

test('scrolling blurs only the artist portrait and reduced motion turns the effect off', async ({ page }) => {
  const fixture = await seedAura(page);
  await page.setViewportSize({ width: 390, height: 600 });
  await profile(page);
  await page.evaluate(() => {
    const songs = (globalThis as any).state.songs;
    for (let index = 0; index < 20; index++) songs.push({ ...songs[0], id: `artist-extra-${index}`, title: `Extra ${index}` });
  });
  await openHomeArtist(page);
  await page.evaluate(() => scrollTo(0, 340));
  await expect.poll(() => page.locator('#artistHeroCard .artist-hero-image').evaluate((element) => parseFloat((element as HTMLElement).style.getPropertyValue('--artist-image-blur')))).toBeGreaterThan(0);
  await page.evaluate(() => document.body.classList.add('aura-reduce-motion'));
  await expect(page.locator('#artistHeroCard .artist-hero-image')).toHaveCSS('filter', 'none');
  await expect(page.locator('#artistHeroCard .artist-hero-image')).toHaveCSS('transform', 'none');
  expect(fixture.pageErrors).toEqual([]);
});
