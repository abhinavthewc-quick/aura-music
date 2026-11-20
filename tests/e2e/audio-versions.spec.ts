import { expect, test, type Page, type Route } from '@playwright/test';
import { currentTitle, openPlaylist, seedAura, silentAudio } from './fixtures';

async function serveAudio(route: Route, audio = silentAudio()) {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
    return route.fulfill({status:206, contentType:'audio/wav', headers:{
      'accept-ranges':'bytes', 'content-range':`bytes ${start}-${end}/${audio.length}`,
    }, body:audio.subarray(start,end + 1)});
  }
  return route.fulfill({contentType:'audio/wav', headers:{'accept-ranges':'bytes'}, body:audio});
}

async function seedVersions(page: Page, intercept?: (route: Route) => Promise<unknown>, originalAudio?: Buffer) {
  const evidence = await seedAura(page);
  const audio = silentAudio();
  const requests: string[] = [];
  await page.context().route('**/api/audio?*', async (route) => {
    requests.push(route.request().url());
    return intercept ? intercept(route) : serveAudio(route, audio);
  });
  if (originalAudio) await page.context().route('**/__test__/audio/3.wav', route => serveAudio(route, originalAudio));
  await page.evaluate(() => {
    const state = (globalThis as any).state;
    for (const id of [1,3]) {
      const song = state.songs.find((song:any) => song.id === id);
      song.isHf = true;
      song.audioVersions = {bass:{path:`versions/bass/${id}.mp3`}, 'bass-reverb':{path:`versions/bass-reverb/${id}.mp3`}};
    }
  });
  await openPlaylist(page);
  await page.locator('[data-play-playlist]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.readyState)).toBeGreaterThan(0);
  return {...evidence, requests};
}

test('switching versions preserves the collection, queue, identity, timestamp and one listening event', async ({page}) => {
  const evidence = await seedVersions(page);
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  await page.evaluate(() => {(globalThis as any).state.audio.currentTime = 20;});
  const before = await page.evaluate(() => ({
    context:JSON.stringify((globalThis as any).state.playbackContext),
    id:(globalThis as any).state.activeTrack.id,
    counts:localStorage.getItem('aura_play_counts_v1'),
  }));
  await page.locator('#miniAudioVersion [data-audio-version=\"bass\"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeGreaterThan(19.8);
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  await expect(page.locator('#fullAudioVersion [data-audio-version=\"bass\"]')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => ({context:JSON.stringify((globalThis as any).state.playbackContext),
    id:(globalThis as any).state.activeTrack.id, counts:localStorage.getItem('aura_play_counts_v1')}))).toEqual(before);
  expect(evidence.requests.some((url) => decodeURIComponent(url).includes('versions/bass/3.mp3'))).toBe(true);
  await page.locator('#nextBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await expect(page.locator('#miniAudioVersion [data-audio-version=\"bass\"]')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.readyState)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeLessThan(3);
  expect(evidence.pageErrors).toEqual([]);
});

test('paused switches stay paused and rapid switches keep the pending timestamp', async ({page}) => {
  await seedVersions(page);
  await page.locator('#playPauseBtn').click();
  await page.evaluate(() => {(globalThis as any).state.audio.currentTime = 17;});
  await page.locator('#miniAudioVersion [data-audio-version=\"bass-reverb\"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeCloseTo(17, 1);
  expect(await page.evaluate(() => (globalThis as any).state.audio.paused)).toBe(true);
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#miniAudioVersion [data-audio-version="bass"]').click();
    document.querySelector<HTMLButtonElement>('#miniAudioVersion [data-audio-version="original"]').click();
  });
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeCloseTo(17, 1);
  await expect(page.locator('#miniAudioVersion [data-audio-version=\"original\"]')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (globalThis as any).state.audio.paused)).toBe(true);
});

test('missing and failed renditions use Original without losing the remembered preference or playhead', async ({page}) => {
  await seedVersions(page, route => route.fulfill({status:404,body:''}));
  await page.evaluate(() => {(globalThis as any).state.audio.currentTime = 12;});
  await page.locator('#miniAudioVersion [data-audio-version=\"bass\"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.activeAudioVersion)).toBe('original');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeGreaterThan(11.8);
  expect(await page.evaluate(() => localStorage.getItem('auraAudioVersion_v1'))).toBe('bass');
  await expect(page.locator('.toast').filter({hasText:"Couldn't play this track"})).toHaveCount(0);
  await page.evaluate(() => {
    const state = (globalThis as any).state;
    const song = state.songs.find((song:any) => song.id === 1);
    song.audioVersions = {};
  });
  await page.locator('#nextBtn').click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await expect(page.locator('#miniAudioVersion [data-audio-version=\"original\"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#miniAudioVersion [data-audio-version="bass"]')).toBeDisabled();
  expect(await page.evaluate(() => (globalThis as any).state.preferredAudioVersion)).toBe('bass');
});

test('Pause during a pending switch cannot be undone by metadata or an old playback rejection', async ({page}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {release = resolve;});
  await seedVersions(page, async route => { await delayed; return serveAudio(route); });
  await page.locator('#miniAudioVersion [data-audio-version=\"bass\"]').click();
  await page.evaluate(() => (globalThis as any).__mediaActions.pause());
  release();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.readyState)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (globalThis as any).state.audio.paused)).toBe(true);
  expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
});

for (const width of [320, 390, 900, 1440]) {
  test(`version selector is visible, keyboard accessible and fits the player at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width,height:900});
    const evidence = await seedVersions(page);
    if (width < 900) {
      await page.locator('#currentTitle').click();
      await expect(page.locator('#fullPlayerOverlay')).toHaveAttribute('aria-hidden', 'false');
    }
    const group = page.locator(width < 900 ? '#fullAudioVersion' : '#miniAudioVersion');
    const selector = group.locator('[data-audio-version="bass-reverb"]');
    await expect(selector).toBeVisible();
    await selector.focus();
    await expect(selector).toBeFocused();
    await selector.press('Space');
    await expect(selector).toHaveAttribute('aria-checked', 'true');
    await selector.press('Home');
    await expect(group.locator('[data-audio-version="original"]')).toBeFocused();
    await selector.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const rect = await selector.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    await page.screenshot({path:info.outputPath(`versions-${width}.png`), animations:'disabled'});
    expect(evidence.pageErrors).toEqual([]);
  });
}

async function prepared(page: Page) {
  for (const version of ['original', 'bass', 'bass-reverb']) {
    await expect(page.locator(`#miniAudioVersion [data-audio-version="${version}"]`)).toHaveAttribute('data-load-state', 'ready');
  }
}

/** 8 kHz mono WAV with a sine of the given full-scale amplitude. */
function toneWav(frequency: number, amplitude: number, seconds = 60): Buffer {
  const audio = silentAudio(seconds);
  for (let i = 0; i < (audio.length - 44) / 2; i++) {
    audio.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * frequency / 8000) * amplitude * 32767), 44 + i * 2);
  }
  return audio;
}

test('a quiet rendition is loudness-matched so switching variants does not jump in level', async ({page}) => {
  // The rendition ships 10 dB quieter than its own song's original — the
  // production defect this fix targets (aubatch peak normalization).
  const original = toneWav(440, .2);
  const quiet = toneWav(440, .2 * 10 ** (-10 / 20));
  const evidence = await seedVersions(page, route => serveAudio(route, quiet), original);
  await prepared(page);
  await page.evaluate(async () => {
    const modulePath = '/src/features/ambience.ts';
    const {ensureMusicOutput} = await import(modulePath);
    const output = ensureMusicOutput();
    const analyser = output.context.createAnalyser();
    analyser.fftSize = 2048;
    output.destination.connect(analyser);
    (window as any).__loudnessProbe = {analyser};
  });
  const medianRms = async () => {
    const values: number[] = [];
    for (let i = 0; i < 8; i++) {
      values.push(await page.evaluate(() => {
        const {analyser} = (window as any).__loudnessProbe;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      }));
      await page.waitForTimeout(60);
    }
    values.sort((a, b) => a - b);
    return values[4];
  };
  const baseline = await medianRms();
  expect(baseline).toBeGreaterThan(.02);
  await page.locator('#miniAudioVersion [data-audio-version="bass"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.activeAudioVersion)).toBe('bass');
  await page.waitForTimeout(400); // crossfade (.12 s) plus shaper settle
  const matched = await medianRms();
  expect(matched).toBeGreaterThan(.02);
  // Level must not jump by more than 1.5 dB in either direction; without the
  // correction this switch measured ~10 dB quieter.
  expect(Math.abs(20 * Math.log10(matched / baseline))).toBeLessThan(1.5);
  expect(evidence.pageErrors).toEqual([]);
});

test('all versions prepare before selection and warm switches never pause, reload or refetch the track', async ({page}) => {
  const evidence = await seedVersions(page);
  await prepared(page);
  expect(evidence.requests.some(url => decodeURIComponent(url).includes('/bass/3.mp3'))).toBe(true);
  expect(evidence.requests.some(url => decodeURIComponent(url).includes('/bass-reverb/3.mp3'))).toBe(true);
  const before = await page.evaluate(() => {
    const audio = (globalThis as any).state.audio;
    (window as any).__switchEvents = [];
    for (const type of ['pause', 'waiting', 'loadstart', 'emptied', 'seeking']) {
      audio.addEventListener(type, () => (window as any).__switchEvents.push(type));
    }
    return audio.currentSrc;
  });
  const requests = evidence.requests.length;
  for (const version of ['bass', 'bass-reverb', 'original', 'bass-reverb', 'bass']) {
    await page.locator(`#miniAudioVersion [data-audio-version="${version}"]`).click();
    await expect.poll(() => page.evaluate(() => (globalThis as any).state.activeAudioVersion)).toBe(version);
  }
  expect(await page.evaluate(() => (window as any).__switchEvents)).toEqual([]);
  expect(await page.evaluate(() => (globalThis as any).state.audio.currentSrc)).toBe(before);
  expect(evidence.requests.length).toBe(requests);
  expect(evidence.pageErrors).toEqual([]);
});

test('a slow version keeps the current music advancing and the latest tap wins', async ({page}) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => {release = resolve;});
  await seedVersions(page, async route => {await delayed; return serveAudio(route);});
  await page.locator('#miniAudioVersion [data-audio-version="bass"]').click();
  const before = await page.evaluate(() => (globalThis as any).state.audio.currentTime);
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeGreaterThan(before + .25);
  expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  await page.locator('#miniAudioVersion [data-audio-version="bass-reverb"]').click();
  release();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.activeAudioVersion)).toBe('bass-reverb');
  await expect(page.locator('#fullAudioVersion [data-audio-version="bass-reverb"]')).toHaveAttribute('aria-checked', 'true');
});

test('skipping a song cancels its pending lanes and cannot mute the next ordinary track', async ({page}) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => {release = resolve;});
  const evidence = await seedVersions(page, async route => {await delayed; return serveAudio(route);});
  await page.locator('#miniAudioVersion [data-audio-version="bass"]').click();
  await page.evaluate(() => (globalThis as any).playSong((globalThis as any).state.songs.findIndex(song => song.id === 2)));
  release();
  await expect.poll(() => currentTitle(page)).toBe('Beta');
  await expect(page.locator('#fullVersionControl')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
  expect(await page.evaluate(() => ({version:(globalThis as any).state.activeAudioVersion, muted:(globalThis as any).state.audio.muted})))
    .toEqual({version:'original', muted:false});
  expect(evidence.pageErrors).toEqual([]);
});

function toneAudio(frequency: number): Buffer {
  const audio = silentAudio();
  for (let i = 0; i < (audio.length - 44) / 2; i++) audio.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * frequency / 8000) * 7000), 44 + i * 2);
  return audio;
}

test('resuming a suspended audio engine realigns every sound to the native playhead', async ({page}) => {
  await seedVersions(page);
  await prepared(page);
  await page.locator('#miniAudioVersion [data-audio-version="bass"]').click();
  const result = await page.evaluate(async () => {
    const modulePath = '/src/features/ambience.ts';
    const {ensureMusicOutput} = await import(modulePath), {context} = ensureMusicOutput();
    const offsets: Array<{offset:number; playhead:number}> = [], start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(when, offset, duration) {
      offsets.push({offset, playhead:(globalThis as any).state.audio.currentTime});
      return duration === undefined ? start.call(this, when, offset) : start.call(this, when, offset, duration);
    };
    const before = (globalThis as any).state.audio.currentTime;
    await context.suspend();
    await new Promise(resolve => setTimeout(resolve, 350));
    const resumed = (globalThis as any).state.audio.currentTime;
    await context.resume();
    await new Promise(resolve => setTimeout(resolve, 120));
    AudioBufferSourceNode.prototype.start = start;
    return {before, resumed, offsets, paused:(globalThis as any).state.audio.paused, version:(globalThis as any).state.activeAudioVersion};
  });
  expect(result.resumed).toBeGreaterThan(result.before + .2);
  expect(result.offsets).toHaveLength(3);
  for (const {offset, playhead} of result.offsets) {
    expect(offset).toBeGreaterThanOrEqual(result.resumed - .05);
    expect(Math.abs(offset - playhead)).toBeLessThan(.05);
  }
  expect(result.paused).toBe(false); expect(result.version).toBe('bass');
});

test('the audible output crossfades between prepared sounds without silence and obeys seek, volume and Pause', async ({page}) => {
  await seedVersions(page, route => serveAudio(route, toneAudio(route.request().url().includes('bass-reverb') ? 880 : 440)), toneAudio(220));
  await prepared(page);
  await page.evaluate(async () => {
    const modulePath = '/src/features/ambience.ts';
    const {ensureMusicOutput} = await import(modulePath);
    const {context, destination} = ensureMusicOutput();
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    destination.connect(analyser);
    (window as any).__soundProbe = {context, analyser};
  });
  await page.locator('#miniAudioVersion [data-audio-version="bass"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.activeAudioVersion)).toBe('bass');
  const result = await page.evaluate(async () => {
    const {context, analyser} = (window as any).__soundProbe;
    const samples = new Float32Array(analyser.fftSize);
    const rms = () => {analyser.getFloatTimeDomainData(samples);return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);};
    await new Promise(resolve => setTimeout(resolve, 180));
    const before = rms(), levels: number[] = [];
    document.querySelector<HTMLButtonElement>('#miniAudioVersion [data-audio-version="bass-reverb"]').click();
    for (let i = 0; i < 25; i++) {await new Promise(resolve => setTimeout(resolve, 10));levels.push(rms());}
    const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
    let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
    return {before, minimum:Math.min(...levels), frequency:peak * context.sampleRate / analyser.fftSize};
  });
  expect(result.before).toBeGreaterThan(.05);
  expect(result.minimum).toBeGreaterThan(.03);
  expect(result.frequency).toBeGreaterThan(850); expect(result.frequency).toBeLessThan(910);
  const muffledFrequency = await page.evaluate(async () => {
    const modulePath = '/src/features/ambience.ts';
    const {setMuffleMode} = await import(modulePath); setMuffleMode(true);
    await new Promise(resolve => setTimeout(resolve, 180));
    const {context, analyser} = (window as any).__soundProbe;
    const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
    let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
    return peak * context.sampleRate / analyser.fftSize;
  });
  expect(muffledFrequency).toBeGreaterThan(850); expect(muffledFrequency).toBeLessThan(910);
  await page.evaluate(() => {(globalThis as any).state.audio.currentTime = 25;});
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeGreaterThan(24.8);
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.activeAudioVersion)).toBe('bass-reverb');
  await page.locator('#miniVolume').focus();
  await page.locator('#miniVolume').press('Home');
  await expect.poll(() => page.evaluate(() => {
    const analyser = (window as any).__soundProbe.analyser, samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    return Math.max(...samples.map(Math.abs));
  })).toBeLessThan(.005);
  await page.evaluate(() => (globalThis as any).__mediaActions.pause());
  expect(await page.evaluate(() => (globalThis as any).state.audio.paused)).toBe(true);
});
