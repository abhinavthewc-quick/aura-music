import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ADMIN_EMAILS } from '../../src/core/config';
import type { ClientMessage, ServerMessage } from '../../src/rooms/protocol';
import { currentTitle, mockYouTube, openPlaylist, resetPosition, seedAura } from './fixtures';

/* These are isolated UI fixtures, not live accounts/catalogues/rooms.
 * seedAura's CONTEXT routes intercept providers and all /api requests. Specific
 * routes below override that default; no admin success or real Worker action
 * is performed. WebSocket fixtures never call connectToServer(). */
const entryViewports = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
] as const;
const surfaceViewports = [
  { width: 320, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const screenshotDirectory = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const capturePaths = {
  playlistDesktop: join(screenshotDirectory, 'aura-fixture-playlist-desktop.png'),
  playerDesktop: join(screenshotDirectory, 'aura-fixture-player-desktop.png'),
  playlistMobile: join(screenshotDirectory, 'aura-fixture-playlist-mobile.png'),
  playerMobile: join(screenshotDirectory, 'aura-fixture-player-mobile.png'),
};

async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    'the document must not overflow horizontally').toBeLessThanOrEqual(1);
}

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const rectangle = await locator.boundingBox();
  expect(rectangle).not.toBeNull();
  if (!rectangle) throw new Error('A visible surface has no bounding box');
  return rectangle;
}

async function insideViewport(page: Page, locator: Locator) {
  const rectangle = await box(locator), viewport = page.viewportSize()!;
  expect(rectangle.x).toBeGreaterThanOrEqual(-1);
  expect(rectangle.y).toBeGreaterThanOrEqual(-1);
  expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(viewport.height + 1);
  return rectangle;
}

async function targets44(locator: Locator) {
  const count = await locator.count();
  expect(count, 'the expected controls must actually exist').toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const button = locator.nth(index), rectangle = await box(button);
    expect(rectangle.width, `target ${index} width`).toBeGreaterThanOrEqual(44);
    expect(rectangle.height, `target ${index} height`).toBeGreaterThanOrEqual(44);
  }
}

async function namedVisibleButtons(page: Page) {
  // Role queries exclude aria-hidden/inert closed layers; CSS visibility still
  // matters for responsive controls. Private-use icon glyphs are not names.
  const buttons = page.getByRole('button');
  let checked = 0;
  for (let index = 0; index < await buttons.count(); index++) {
    const button = buttons.nth(index);
    if (!await button.isVisible()) continue;
    await expect(button).toHaveAccessibleName(/[\p{L}\p{N}]/u);
    checked++;
  }
  expect(checked, 'audit at least one rendered control').toBeGreaterThan(0);
  const missingMasks = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.fa-solid, .fa-regular, .fa-brands')].filter((icon) => {
    const style = getComputedStyle(icon);
    return icon.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
      !style.maskImage.includes('data:image/svg+xml,');
  }).map((icon) => icon.className));
  expect(missingMasks, 'visible icons must use bundled SVG masks, not solid rectangle fallbacks').toEqual([]);
}

async function receivesPointer(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  await expect.poll(() => locator.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
    return hit === element || !!hit && element.contains(hit);
  }), 'a visible control must not be covered by another surface').toBe(true);
}

async function evidence(page: Page, info: TestInfo, name: string, selectors: string[]) {
  const values = await page.evaluate((selectors) => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    surfaces: selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return { selector, missing: true };
      const style = getComputedStyle(element), rectangle = element.getBoundingClientRect();
      return {
        selector, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        background: style.backgroundColor, color: style.color, fontFamily: style.fontFamily,
        outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
        ariaModal: element.getAttribute('aria-modal'), ariaHidden: element.getAttribute('aria-hidden'),
      };
    }),
  }), selectors);
  await info.attach(name, { body: Buffer.from(JSON.stringify(values, null, 2)), contentType: 'application/json' });
}

async function openPreferences(page: Page, width: number) {
  if (width >= 900) {
    if (await page.locator('body').evaluate((body) => body.classList.contains('sb-collapsed'))) {
      await page.locator('#sidebarToggle').click();
    }
  } else {
    await page.locator('.top-header .header-icon-btn').click();
    await expect(page.locator('#sideMenu')).toBeVisible();
  }
}

async function expandPlayer(page: Page, width: number) {
  const player = page.locator('#fullPlayerOverlay'), sheet = page.locator('#upNextSheet');
  // YouTube selection already opens its official frame. Do not toggle an open
  // desktop player closed or try the intentionally hidden mobile mini player.
  if (!await player.evaluate((element) => element.classList.contains('active'))) {
    if (width >= 900) await page.locator('#miniExpandBtn').click();
    else await page.locator('#miniTrackOpenBtn').click();
  }
  await expect(player).toHaveClass(/active/);
  await expect(player).toHaveCSS('opacity', '1');
  // Mobile expansion opens artwork first; Lyrics is an explicit visible action.
  if (!await sheet.evaluate((element) => element.classList.contains('active'))) {
    await page.locator('#playerTabLyricsBtn').click();
  }
  await expect(sheet).toHaveClass(/active/);
  await expect(sheet).toBeVisible();
}

async function blockRemoteRoomSockets(page: Page, allowFixture = false) {
  await page.context().addInitScript(({ allowFixture }) => {
    const NativeSocket = window.WebSocket;
    (window as any).__unexpectedRoomSockets = [];
    // Keep only the dev server's local HMR and, when requested, Playwright's
    // explicitly routed fixture socket. A regression cannot contact a Worker.
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args, newTarget) {
        const address = new URL(String(args[0]), location.href);
        const local = address.hostname === '127.0.0.1' || address.hostname === 'localhost';
        if (!local && !(allowFixture && address.hostname === 'rooms-fixture.invalid')) {
          (window as any).__unexpectedRoomSockets.push(address.href);
          throw new Error('External room sockets are forbidden in this isolated fixture');
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
  }, { allowFixture });
}

for (const viewport of entryViewports) {
  test(`isolated ${viewport.label} Admin gate exposes only sign-in and visible failures`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(page);
    // Main-site fixture identity is not an admin session. Test the signed-out
    // entry point, never a forged successful admin credential.
    await page.evaluate(() => localStorage.removeItem('auraSession_v2'));
    const requests: string[] = [];
    let reply = { status: 401, error: 'Invalid isolated fixture credentials.' };
    await page.context().route('**/api/admin', async (route) => {
      const body = route.request().postDataJSON();
      requests.push(String(body?.action));
      await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify({ error: reply.error }) });
    });
    await page.goto('/admin.html');
    await expect(page.locator('#gateCard')).toBeVisible();
    for (const selector of ['#sessionBar', '#admTabs', '#downloadCard', '#panelLibrary', '#panelArtists', '#panelDiscord', '#panelSettings']) {
      await expect(page.locator(selector)).toBeHidden();
    }
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await targets44(page.locator('#admPasswordBtn'));
    await namedVisibleButtons(page);
    await noHorizontalOverflow(page);
    expect(requests).toEqual([]);

    await page.locator('#admPasswordBtn').click();
    await expect(page.locator('#gateStatus')).toHaveText('Enter your email and password.');
    await expect(page.locator('#gateStatus')).toBeVisible();
    expect(requests).toEqual([]);
    // Public allowlist email, deliberately fake password, mocked rejection.
    await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(ADMIN_EMAILS[0]);
    await page.getByLabel('Password', { exact: true }).fill('not-a-real-password-fixture');
    await page.locator('#admPasswordBtn').click();
    await expect(page.locator('#gateStatus')).toHaveText(reply.error);
    await expect(page.locator('#gateStatus')).toBeVisible();
    reply = { status: 503, error: 'Admin fixture service is unavailable.' };
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page.locator('#gateStatus')).toHaveText(reply.error);
    await expect(page.locator('#gateStatus')).toBeVisible();
    await expect(page.locator('#gateCard')).toBeVisible();
    await expect(page.locator('#downloadCard')).toBeHidden();
    expect(requests).toEqual(['login', 'login']);
    await noHorizontalOverflow(page);
    await evidence(page, test.info(), `admin-${viewport.label}-computed-layout`, ['#gateCard', '#admPasswordBtn', '#gateStatus']);
    expect(fixture.pageErrors).toEqual([]);
  });

  test(`isolated ${viewport.label} Rooms join validates fields and shows invalid-code/service failures`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(page);
    await blockRemoteRoomSockets(page);
    const requests: Array<{ action: string; roomId?: string }> = [];
    let invalid = true;
    await page.context().route('**/api/rooms', async (route) => {
      const body = route.request().postDataJSON();
      requests.push({ action: body.action, ...(body.roomId ? { roomId: body.roomId } : {}) });
      const response = invalid && body.action === 'exists'
        ? { status: 200, body: { exists: false, wsBase: 'wss://rooms-fixture.invalid', error: 'Room not found. Check the code and try again.' } }
        : { status: 503, body: { error: 'Rooms fixture service is unavailable.' } };
      await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
    });
    await page.goto('/rooms.html');
    await expect(page.getByRole('heading', { name: 'Find your people.', exact: true })).toBeVisible();
    await expect(page.locator('#roomView')).toBeHidden();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await targets44(page.locator('#joinBtn, #createBtn'));
    await namedVisibleButtons(page);
    await noHorizontalOverflow(page);
    await page.locator('#joinBtn').click();
    const code = page.getByRole('textbox', { name: 'Room code or invite link', exact: true });
    const name = page.getByRole('textbox', { name: 'Your name in the room', exact: true });
    await expect(code).toBeFocused();
    expect(requests).toEqual([]);
    await code.fill('K7!m2-PQ');
    await page.locator('#joinBtn').click();
    await expect(code).toBeFocused();
    await expect(code).toHaveAttribute('aria-invalid', 'true');
    await expect(code).toHaveValue('K7!m2-PQ');
    expect(requests).toEqual([]);
    await code.fill('K7m2PQ');
    await page.locator('#joinBtn').click();
    await expect(name).toBeFocused();
    expect(requests).toEqual([]);
    await name.fill('Fixture Listener');
    await page.locator('#codeInput').press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/not found|doesn’t exist|invalid.*code|check.*code/i);
    await expect(code).toHaveValue('k7m2pq');
    await expect(page.locator('#joinView')).toBeVisible();
    await expect(page.locator('#roomView')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__unexpectedRoomSockets)).toEqual([]);

    invalid = false;
    await page.locator('#joinBtn').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/unavailable|not configured|try again/i);
    await page.locator('#createBtn').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/unavailable|could not create a room|not configured/i);
    await expect(page.locator('#createBtn')).toBeEnabled();
    await expect(page.locator('#joinView')).toBeVisible();
    expect(requests).toEqual([
      { action: 'exists', roomId: 'k7m2pq' },
      { action: 'exists', roomId: 'k7m2pq' },
      { action: 'create' },
    ]);
    expect(await page.evaluate(() => (window as any).__unexpectedRoomSockets)).toEqual([]);
    await noHorizontalOverflow(page);
    await evidence(page, test.info(), `rooms-${viewport.label}-failure-layout`, ['#joinView', '#joinBtn', '#createBtn', '[role="alert"]']);
    expect(fixture.pageErrors).toEqual([]);
  });

  test(`isolated ${viewport.label} Rooms joins a fully mocked listener room and leaves without service mutations`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(page);
    await blockRemoteRoomSockets(page, true);
    const apiActions: string[] = [], socketMessages: ClientMessage[] = [];
    await page.context().route('**/api/rooms', async (route) => {
      const body = route.request().postDataJSON();
      apiActions.push(body.action);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: true, wsBase: 'wss://rooms-fixture.invalid' }) });
    });
    await page.context().routeWebSocket('wss://rooms-fixture.invalid/**', (socket) => {
      // DO NOT connectToServer: Playwright is the complete fixture referee.
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as ClientMessage;
        socketMessages.push(message);
        let response: ServerMessage | null = null;
        if (message.t === 'hello') {
          const now = Date.now();
          const you = { id: message.clientId, name: message.name, role: 'listener' as const, joinedAt: 1 };
          response = {
            t: 'welcome', you, serverTime: now,
            snapshot: {
              roomId: 'k7m2pq', queue: [], expiresAt: null,
              playback: { trackKey: null, videoId: null, positionMs: 0, playing: false, updatedAt: now, startAt: null, rev: 0 },
              participants: [you, { id: 'fixture-friend', name: 'Fixture Friend', role: 'listener', joinedAt: 2 }],
            },
          };
        } else if (message.t === 'ping') response = { t: 'pong', sentAt: message.sentAt, serverTime: Date.now() };
        if (response) socket.send(JSON.stringify(response));
      });
    });
    await page.goto('/rooms.html?r=k7m2pq');
    await expect(page.locator('#codeInput')).toHaveValue('k7m2pq');
    await page.getByRole('textbox', { name: 'Your name in the room', exact: true }).fill('Fixture Listener');
    await page.locator('#joinBtn').click();
    await expect(page.locator('#roomView')).toBeVisible();
    await expect(page.locator('#joinView')).toBeHidden();
    await expect(page.locator('#roomCode')).toHaveText('k7m2pq');
    await expect(page.locator('#rolePill')).toHaveText('Listener');
    await expect(page.locator('#peopleList')).toContainText('Fixture Listener');
    await expect(page.locator('#peopleList')).toContainText('Fixture Friend');
    await expect(page.locator('#pCount')).toHaveText('2');
    await expect(page.locator('#nowTitle')).toHaveText('Waiting for a record.');
    for (const selector of ['#prevBtn', '#playBtn', '#nextBtn']) await expect(page.locator(selector)).toBeDisabled();
    await namedVisibleButtons(page);
    await page.getByRole('button', { name: 'Invite friends', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Listener invite link', exact: true })).toHaveValue(new URL('/rooms?r=k7m2pq', page.url()).href);
    await targets44(page.locator('#copyBtn, #leaveBtn, #chatForm button'));
    await noHorizontalOverflow(page);
    await evidence(page, test.info(), `rooms-${viewport.label}-joined-layout`, ['#roomView', '.topbar', '#copyBtn', '#leaveBtn']);
    await page.locator('#leaveBtn').click();
    await expect(page.locator('#joinView')).toBeVisible();
    await expect(page.locator('#roomView')).toBeHidden();
    expect(apiActions).toEqual(['exists']);
    expect(socketMessages.some((message) => message.t === 'hello')).toBe(true);
    expect(socketMessages.some((message) => ['control', 'queue', 'role', 'chat'].includes(message.t))).toBe(false);
    expect(await page.evaluate(() => (window as any).__unexpectedRoomSockets)).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });
}

for (const viewport of surfaceViewports) {
  test(`main palette, keyboard focus, targets and companion geometry at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(page);
    await openPlaylist(page);
    await expect(page.getByRole('heading', { name: 'Night test', exact: true })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('.pl-name')).toHaveCSS('color', 'rgb(245, 245, 245)');
    await targets44(page.locator('#tabPlaylist .pl-actions button, #tabPlaylist .pl-track-order button'));
    await namedVisibleButtons(page);
    await noHorizontalOverflow(page);

    const edit = page.getByRole('button', { name: 'Edit playlist', exact: true });
    await page.keyboard.press('Tab'); // establish keyboard, not pointer, modality
    await edit.focus();
    await expect(edit).toBeFocused();
    const focusStyle = await edit.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(focusStyle.style).not.toBe('none');
    expect(focusStyle.width).toBeGreaterThanOrEqual(2);
    await edit.press('Enter');
    await expect(page.locator('#playlistModal')).toBeVisible();
    await expect(page.locator('#playlistTitleInput')).toBeFocused();
    await insideViewport(page, page.locator('#playlistModal .playlist-modal-card'));
    await page.locator('#playlistSubmitBtn').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#playlistTitleInput')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#playlistModal')).toBeHidden();
    await expect(edit).toBeFocused();

    await openPreferences(page, viewport.width);
    // Production is intentionally neutral black; no retired theme control is
    // required and opening preferences must not change the canvas.
    await expect(page.locator('#themeToggleBtn')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/light-theme/);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    const settings = viewport.width >= 900
      ? page.locator('.desktop-settings-group').getByRole('button', { name: 'Settings', exact: true })
      : page.locator('#openSettingsBtn');
    await settings.click();
    await expect(page.locator('#settingsModal')).toBeVisible();
    await insideViewport(page, page.locator('#settingsModal .settings-modal-card'));
    await targets44(page.locator('#settingsCloseBtn'));
    await namedVisibleButtons(page);
    await evidence(page, test.info(), `neutral-${viewport.width}-computed-layout`, ['body', '.pl-name', '#settingsModal .settings-modal-card', '#settingsCloseBtn']);
    await page.locator('#settingsCloseBtn').click();
    await noHorizontalOverflow(page);

    await page.locator('[data-play-playlist]').click();
    await expect.poll(() => currentTitle(page)).toBe('Gamma');
    await targets44(page.locator('#playPauseBtn, #nextBtn'));
    const dock = await insideViewport(page, page.locator('#miniPlayer'));
    if (viewport.width < 900) {
      const navigation = await insideViewport(page, page.locator('.mobile-dock'));
      expect(dock.y + dock.height).toBeLessThanOrEqual(navigation.y + 1);
      await targets44(page.locator('.mobile-dock .nav-btn, #navSearchFab'));
    }
    await expandPlayer(page, viewport.width);
    const modal = viewport.width >= 900 ? 'false' : 'true';
    await expect(page.locator('#fullPlayerOverlay')).toHaveAttribute('aria-modal', modal);
    if (viewport.width >= 900) {
      await expect(page.locator('#upNextSheet')).toHaveAttribute('role', 'region');
      await expect(page.locator('#upNextSheet')).not.toHaveAttribute('aria-modal');
    } else {
      await expect(page.locator('#upNextSheet')).toHaveAttribute('role', 'dialog');
      await expect(page.locator('#upNextSheet')).toHaveAttribute('aria-modal', modal);
    }
    const player = await insideViewport(page, page.locator('#fullPlayerOverlay'));
    const sheet = await insideViewport(page, page.locator('#upNextSheet'));
    if (viewport.width >= 900) {
      expect(Math.abs(player.x + player.width - sheet.x)).toBeLessThanOrEqual(1);
      expect(sheet.y + sheet.height).toBeLessThanOrEqual(dock.y + 1);
      await receivesPointer(page.locator('#playPauseBtn'));
    } else {
      expect(player.width).toBe(viewport.width);
      expect(sheet.width).toBe(viewport.width);
      expect(Math.abs(sheet.y + sheet.height - viewport.height)).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('#fullPlayerLyricsContainer')).toContainText(/gamma first line/i);
    await targets44(page.locator('#upNextCloseBtn, #ytmTabLyricsBtn, #ytmTabRelatedBtn, #ytmTabQueueBtn'));
    await page.locator('#ytmTabRelatedBtn').click();
    await expect(page.locator('#ytmRelatedPanel')).toBeVisible();
    await expect(page.locator('#ytmLyricsPanel')).toBeHidden();
    await namedVisibleButtons(page);
    await page.locator('#ytmTabQueueBtn').click();
    await expect(page.locator('#ytmQueuePanel')).toBeVisible();
    await expect(page.locator('#ytmRelatedPanel')).toBeHidden();
    await expect(page.locator('#queueContextLabel')).toHaveText('Up next from Night test');
    await targets44(page.locator('#upNextList .up-next-actions button'));
    await namedVisibleButtons(page);
    await noHorizontalOverflow(page);
    await evidence(page, test.info(), `player-${viewport.width}-computed-layout`, ['#fullPlayerOverlay', '#upNextSheet', '#miniPlayer', '#ytmQueuePanel', '#fullPlayBtn']);
    await page.locator('#upNextCloseBtn').click();
    // The desktop companion remains docked while artwork is open. On phones
    // the independent sheet closes and reveals the full-player controls.
    if (viewport.width < 900) await expect(page.locator('#upNextSheet')).toBeHidden();
    else await expect(page.locator('#upNextSheet')).toBeVisible();
    await expect(page.locator('#fullPlayerOverlay')).toHaveClass(/active/);
    if (viewport.width < 900) {
      await targets44(page.locator('#fullPlayBtn, #fullPrevBtn, #fullNextBtn'));
      await namedVisibleButtons(page);
      await receivesPointer(page.locator('#fullPlayBtn'));
      await targets44(page.locator('#fullSeekSlider'));
    }
    if (viewport.width >= 900) await page.locator('#miniExpandBtn').click();
    else await page.locator('#closeFullPlayerBtn').click();
    await expect(page.locator('#fullPlayerOverlay')).not.toHaveClass(/active/);
    await expect(page.locator('#fullPlayerOverlay')).toHaveAttribute('aria-hidden', 'true');
    expect(fixture.pageErrors).toEqual([]);
  });
}

for (const viewport of entryViewports) {
  test(`isolated ${viewport.label} YouTube player uses a real 16:9 layout without provider calls`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(page);
    await mockYouTube(page);
    await page.evaluate(() => {
      const app = globalThis as any;
      app.state.songs.push({ id: 'surface-video-fixture', videoId: 'abcdefghijk', title: 'Fixture video', artist: 'Aura Test', isYouTube: true, img: '/aura-logo.png' });
      app.playTrackSequence(['surface-video-fixture'], { source: 'manual', label: 'Isolated video fixture' });
    });
    await expect.poll(() => currentTitle(page)).toBe('Fixture video');
    await expandPlayer(page, viewport.width);
    await expect(page.locator('#fullPlayerArt')).toHaveClass(/youtube-mode/);
    const art = await box(page.locator('#fullPlayerArt'));
    expect(art.width / art.height).toBeCloseTo(16 / 9, 2);
    await noHorizontalOverflow(page);
    await evidence(page, test.info(), `video-${viewport.label}-computed-layout`, ['#fullPlayerArt', '#fullPlayerOverlay', '#upNextSheet']);
    expect(fixture.pageErrors).toEqual([]);
  });
}

test('capture clearly labeled isolated-fixture desktop/mobile playlists and players', async ({ page, context }, info) => {
  test.setTimeout(60_000);
  info.annotations.push({ type: 'fixture', description: 'Synthetic Night test playlist, Aura Test artists, local silent WAVs, mocked lyrics; not a live catalogue/session/service.' });
  try { await mkdir(screenshotDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    expect((await stat(screenshotDirectory)).isDirectory()).toBe(true);
  }
  async function capture(view: Page, viewport: typeof entryViewports[number], playlistPath: string, playerPath: string) {
    await view.setViewportSize(viewport);
    await view.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await seedAura(view);
    await openPlaylist(view);
    await expect(view.getByRole('heading', { name: 'Night test', exact: true })).toBeVisible();
    await noHorizontalOverflow(view);
    await view.screenshot({ path: playlistPath, animations: 'disabled', caret: 'hide' });
    await info.attach(`isolated-fixture-${viewport.label}-playlist`, { path: playlistPath, contentType: 'image/png' });
    await view.locator('[data-play-playlist]').click();
    await expect.poll(() => currentTitle(view)).toBe('Gamma');
    await view.locator('#playPauseBtn').click(); // honest paused state, stable timeline
    await expect.poll(() => view.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
    await resetPosition(view);
    await expandPlayer(view, viewport.width);
    await expect(view.locator('#fullPlayerLyricsContainer')).toContainText(/gamma first line/i);
    await insideViewport(view, view.locator('#fullPlayerOverlay'));
    await insideViewport(view, view.locator('#upNextSheet'));
    await noHorizontalOverflow(view);
    await view.screenshot({ path: playerPath, animations: 'disabled', caret: 'hide' });
    await info.attach(`isolated-fixture-${viewport.label}-player`, { path: playerPath, contentType: 'image/png' });
    await evidence(view, info, `capture-${viewport.label}-computed-layout`, ['.pl-name', '#fullPlayerOverlay', '#upNextSheet', '#miniPlayer']);
    expect(fixture.pageErrors).toEqual([]);
  }
  await capture(page, entryViewports[0], capturePaths.playlistDesktop, capturePaths.playerDesktop);
  await page.close(); // release this page's playback lease before the fresh seed
  // Fresh page + fresh seed: mobile playlist is the same clean, unplayed state.
  const mobile = await context.newPage();
  try { await capture(mobile, entryViewports[1], capturePaths.playlistMobile, capturePaths.playerMobile); }
  finally { await mobile.close(); }
  await info.attach('isolated-fixture-capture-manifest', {
    body: Buffer.from(JSON.stringify({ fixture: 'Synthetic seeded catalogue, paused player, no live services', captures: capturePaths }, null, 2)),
    contentType: 'application/json',
  });
});
