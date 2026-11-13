import { expect, test, type Page } from '@playwright/test';
import { currentTitle, mockYouTube, openPlaylist, seedAura } from './fixtures';

const disabledLiveActions = ['nexttrack', 'previoustrack', 'seekto', 'seekforward', 'seekbackward'];
const audioUrl = (page: Page, name = 'radio') => new URL(`/__test__/audio/${name}.wav`, page.url()).href;
const context = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).state.playbackContext)));
const radioPlaying = (page: Page) => page.evaluate(() => (globalThis as any).state.radioIsPlaying);

async function startPersonal(page: Page): Promise<void> {
  await openPlaylist(page);
  await page.locator('[data-play-playlist]').click();
  await expect.poll(() => currentTitle(page)).toBe('Gamma');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
}

async function startCustomRadio(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as any).goTab('tabRadio'));
  // seedAura serves valid 60-second PCM for every /__test__/audio/ path. No
  // public radio directory, stream, YouTube SDK or provider is contacted.
  await page.locator('#customRadioUrl').fill(audioUrl(page));
  await page.locator('#customRadioPlayBtn').click();
  await expect.poll(() => radioPlaying(page)).toBe(true);
  await expect(page.locator('#radioMiniName')).toHaveText('Custom radio station');
}

async function invokeMedia(page: Page, name: string, details: Record<string, number> = {}): Promise<void> {
  await page.evaluate(({name, details}) => (window as any).__mediaActions[name]?.(details), {name, details});
}

async function expectLiveHandlers(page: Page): Promise<void> {
  expect(await page.evaluate((names) => names.map((name) => (window as any).__mediaActions[name] === null), disabledLiveActions)).toEqual(disabledLiveActions.map(() => true));
  expect(await page.evaluate(() => ['play', 'pause', 'stop'].map((name) => typeof (window as any).__mediaActions[name]))).toEqual(['function', 'function', 'function']);
}

test('radio owns live Media Session without changing the saved collection; Stop restores personal transport', async ({page}) => {
  const evidence = await seedAura(page);
  await startPersonal(page);
  await page.evaluate(() => { (globalThis as any).state.audio.currentTime = 12; });
  const personal = await context(page);
  await startCustomRadio(page);
  // Playback can advance before the source hand-off; after radio pauses it,
  // personal media actions must leave this exact frozen playhead unchanged.
  const frozenMainTime = await page.evaluate(() => (globalThis as any).state.audio.currentTime);
  await expectLiveHandlers(page);
  expect(await context(page)).toEqual(personal);
  expect(await page.evaluate(() => ({paused:(globalThis as any).state.audio.paused, playing:(globalThis as any).state.isPlaying}))).toEqual({paused:true, playing:false});
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Custom radio station');

  for (const action of disabledLiveActions) await invokeMedia(page, action, {seekTime:45, seekOffset:30});
  await page.evaluate(() => {
    document.getElementById('nextBtn')?.click();
    document.getElementById('miniPrevBtn')?.click();
  });
  expect(await context(page)).toEqual(personal);
  expect(await page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBe(frozenMainTime);
  await invokeMedia(page, 'pause');
  await expect.poll(() => radioPlaying(page)).toBe(false);
  await invokeMedia(page, 'play');
  await expect.poll(() => radioPlaying(page)).toBe(true);
  expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);

  await invokeMedia(page, 'stop');
  await expect.poll(() => radioPlaying(page)).toBe(false);
  await expect(page.locator('#radioMiniPlayer')).not.toHaveClass(/active/);
  expect(await context(page)).toEqual(personal);
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Gamma');
  expect(await page.evaluate(() => ['nexttrack', 'previoustrack', 'seekto'].map((name) => typeof (window as any).__mediaActions[name]))).toEqual(['function', 'function', 'function']);
  await invokeMedia(page, 'seekto', {seekTime:15});
  expect(await page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeCloseTo(15, 1);
  await invokeMedia(page, 'play');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  await invokeMedia(page, 'nexttrack');
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  expect(evidence.pageErrors).toEqual([]);
});

test('starting radio stops an active YouTube player and ignores its late callbacks', async ({page}) => {
  const evidence = await seedAura(page);
  await mockYouTube(page);
  await page.evaluate(async () => {
    const player = await import('/src/features/player.ts' as string);
    await player.playYouTubeInsideAura('abcdefghijk', 'Fixture video', '', false, true);
    const instance = (window as any).__youtubePlayers[0];
    (window as any).__radioYTStopped = 0;
    (window as any).__radioYTDestroyed = 0;
    const stop = instance.stopVideo.bind(instance), destroy = instance.destroy.bind(instance);
    instance.stopVideo = () => { (window as any).__radioYTStopped += 1; stop(); };
    instance.destroy = () => { (window as any).__radioYTDestroyed += 1; destroy(); };
  });
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  const personal = await context(page);
  await page.locator('#closeFullPlayerBtn').click();
  await startCustomRadio(page);
  expect(await page.evaluate(() => (window as any).__radioYTStopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__radioYTDestroyed)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const instance = (window as any).__youtubePlayers[0];
    instance.options.events.onReady({target:instance});
    instance.transition(1);
  });
  expect(await page.evaluate(async () => {
    const player = await import('/src/features/player.ts' as string);
    return {videoId:player.auraYTVideoId, player:player.auraYTPlayer, playing:(globalThis as any).state.isPlaying};
  })).toEqual({videoId:'', player:null, playing:false});
  expect(await context(page)).toEqual(personal);
  expect(await radioPlaying(page)).toBe(true);
  await invokeMedia(page, 'stop');
  await invokeMedia(page, 'play');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  expect(await page.evaluate(() => (window as any).__youtubePlayers.length)).toBe(2);
  expect(await context(page)).toEqual(personal);
  expect(evidence.pageErrors).toEqual([]);
});

test('starting radio cancels a pending YouTube SDK selection before it can construct a player', async ({page}) => {
  const evidence = await seedAura(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://www.youtube.com/iframe_api', async (route) => {
    await gate;
    await route.fulfill({contentType:'application/javascript', body:'/* SDK fixture controlled by the test */'});
  });
  try {
    const requestSeen = page.waitForRequest('https://www.youtube.com/iframe_api', {timeout:5000});
    await page.evaluate(async () => {
      const player = await import('/src/features/player.ts' as string);
      void player.playYouTubeInsideAura('abcdefghijk', 'Pending fixture video', '', false, true);
    });
    await requestSeen;
    const personal = await context(page);
    await page.locator('#closeFullPlayerBtn').click();
    await startCustomRadio(page);
    await mockYouTube(page);
    release();
    await page.evaluate(() => window.onYouTubeIframeAPIReady?.());
    await expect.poll(() => page.evaluate(() => (window as any).__youtubePlayers.length)).toBe(0);
    expect(await page.evaluate(async () => (await import('/src/features/player.ts' as string)).auraYTVideoId)).toBe('');
    expect(await context(page)).toEqual(personal);
    expect(await radioPlaying(page)).toBe(true);
    expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
    expect(evidence.pageErrors).toEqual([]);
  } finally { release(); }
});

test('invalid custom and directory URLs cannot disturb personal playback; unsafe websites are not actions', async ({page}) => {
  const evidence = await seedAura(page);
  const stream = audioUrl(page, 'directory');
  await page.route('https://de1.api.radio-browser.info/json/stations/search?**', (route) => route.fulfill({
    contentType:'application/json', headers:{'access-control-allow-origin':'*'}, body:JSON.stringify([
      {name:'Bad protocol', url:'javascript:alert(1)'},
      {name:'No host', url_resolved:'https://'},
      {name:'Directory fixture', url_resolved:stream, homepage:'javascript:alert(1)', favicon:'data:text/html,not-an-image', tags:['untrusted type']},
    ]),
  }));
  await startPersonal(page);
  const personal = await context(page);
  await page.evaluate(() => (globalThis as any).goTab('tabRadio'));
  for (const url of ['https://', 'javascript:alert(1)', 'data:audio/wav,invalid', 'https://user:password@example.invalid/radio']) {
    await page.locator('#customRadioUrl').fill(url);
    await page.locator('#customRadioPlayBtn').click();
    await expect(page.locator('.toast').last()).toContainText('valid HTTP(S)');
    expect(await page.evaluate(() => ({playing:(globalThis as any).state.isPlaying, paused:(globalThis as any).state.audio.paused}))).toEqual({playing:true, paused:false});
    expect(await context(page)).toEqual(personal);
  }
  await expect(page.locator('#radioStationList').getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', {name:'Play Bad protocol', exact:true})).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Play No host', exact:true})).toHaveCount(0);
  await page.getByRole('button', {name:'Play Directory fixture', exact:true}).click();
  await expect.poll(() => radioPlaying(page)).toBe(true);
  await page.locator('#radioMiniName').click();
  await page.locator('#radioHeaderMenuBtn').click();
  await expect(page.locator('#trackSheetRows').getByRole('button', {name:'Open station website', exact:true})).toHaveCount(0);
  await expect(page.locator('#trackSheetRows').getByRole('button', {name:'Stop radio', exact:true})).toBeVisible();
  expect(await context(page)).toEqual(personal);
  expect(evidence.pageErrors).toEqual([]);
});

test('stale station play fulfillment and rejection cannot overwrite the newest station', async ({page}) => {
  const evidence = await seedAura(page);
  const urls = [audioUrl(page, 'old-a'), audioUrl(page, 'old-b'), audioUrl(page, 'current')];
  await page.evaluate(async (urls) => {
    const radio = await import('/src/features/radio.ts' as string);
    const play = radio.radioAudio.play.bind(radio.radioAudio);
    let calls = 0;
    radio.radioAudio.play = () => {
      calls += 1;
      if (calls === 1) return new Promise<void>((resolve) => { (window as any).__fulfillOldRadio = resolve; });
      if (calls === 2) return new Promise<void>((_resolve, reject) => { (window as any).__rejectOldRadio = reject; });
      return play();
    };
    radio.playRadioStation({name:'Old station A', url:urls[0]});
    radio.playRadioStation({name:'Old station B', url:urls[1]});
    radio.playRadioStation({name:'Current station', url:urls[2]});
  }, urls);
  await expect.poll(() => radioPlaying(page)).toBe(true);
  await page.evaluate(() => {
    (window as any).__fulfillOldRadio();
    (window as any).__rejectOldRadio(new DOMException('Obsolete fixture request', 'NotSupportedError'));
  });
  await expect(page.locator('#radioMiniName')).toHaveText('Current station');
  expect(await radioPlaying(page)).toBe(true);
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Current station');
  await expect(page.locator('.toast').filter({hasText:'This station could not be played'})).toHaveCount(0);
  expect(evidence.pageErrors).toEqual([]);
});

test('explicit Pause clears foreground recovery and cannot be undone by returning to the page', async ({page}) => {
  const evidence = await seedAura(page);
  await startCustomRadio(page);
  await page.evaluate(async () => {
    const radio = await import('/src/features/radio.ts' as string);
    const play = radio.radioAudio.play.bind(radio.radioAudio);
    (window as any).__radioForegroundPlayCalls = 0;
    radio.radioAudio.play = () => { (window as any).__radioForegroundPlayCalls += 1; return play(); };
    (await import('/src/features/player.ts' as string)).auraCaptureBackgroundState();
  });
  expect(await page.evaluate(async () => (await import('/src/features/player.ts' as string)).radioWasPlayingBeforeHidden)).toBe(true);
  await invokeMedia(page, 'pause');
  await expect.poll(() => radioPlaying(page)).toBe(false);
  await page.evaluate(async () => (await import('/src/features/player.ts' as string)).auraResumeAfterForeground());
  expect(await page.evaluate(() => (window as any).__radioForegroundPlayCalls)).toBe(0);
  expect(await page.evaluate(async () => (await import('/src/features/radio.ts' as string)).radioAudio.paused)).toBe(true);
  expect(await radioPlaying(page)).toBe(false);
  expect(await page.evaluate(async () => (await import('/src/features/player.ts' as string)).radioWasPlayingBeforeHidden)).toBe(false);
  expect(evidence.pageErrors).toEqual([]);
});

test('a restored station stays paused and owns nonseekable handlers without circular-init errors', async ({page}) => {
  const evidence = await seedAura(page);
  await startCustomRadio(page);
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as any).state && !!(globalThis as any).stopRadio);
  await expect(page.locator('#radioMiniName')).toHaveText('Custom radio station');
  await expectLiveHandlers(page);
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Custom radio station');
  expect(await radioPlaying(page)).toBe(false);
  expect(await page.evaluate(async () => (await import('/src/features/radio.ts' as string)).radioAudio.paused)).toBe(true);
  expect(evidence.pageErrors).toEqual([]);
});
