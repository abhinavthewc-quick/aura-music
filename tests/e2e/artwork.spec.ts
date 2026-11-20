import { expect, test } from '@playwright/test';
import { DEFAULT_COVER, hfFileUrl } from '../../src/core/catalog';
import { seedAura } from './fixtures';

for (const width of [390, 1440]) {
  test(`recent artwork uses current songs before playback at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    const evidence = await seedAura(page);
    const history = [
      {id:3,title:'Gamma',artist:'Second Artist',img:hfFileUrl('Old Gamma.webp')},
      {id:1,title:'Alpha',artist:'Aura Test',img:'/aura-thumbnail.png'},
    ];
    await page.evaluate(history => {
      localStorage.setItem('recentlyPlayed',JSON.stringify(history));
      localStorage.setItem('aura_play_counts_v1',JSON.stringify({'3':5,'1':2}));
    },history);
    await page.reload();
    await expect(page.locator('#auraLoader')).toHaveCount(0);
    const cards = page.locator('#recentScroll .recent-card');
    await expect(cards).toHaveCount(2);
    await cards.first().scrollIntoViewIfNeeded();
    await expect(cards.nth(0).locator('img')).toHaveAttribute('src','/aura-vinyl-logo.png');
    await expect(cards.nth(1).locator('img')).toHaveAttribute('src','/aura-logo.png');
    await expect.poll(() => cards.first().locator('img').evaluate((img:HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('recentlyPlayed')))).toEqual(history);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aura_play_counts_v1')))).toEqual({'3':5,'1':2});
    expect(evidence.pageErrors).toEqual([]);
  });
}

test('stale cached artwork retries its moved location and follows refreshed catalogue artwork without replaying', async ({page}) => {
  const evidence = await seedAura(page);
  const old = hfFileUrl('Artist - Song [abcdefghijk].webp');
  const current = hfFileUrl('covers/Artist - Song [abcdefghijk].webp');
  const updated = hfFileUrl('covers/Artist - Song [abcdefghijk].png');
  const id = 'hf:Artist - Song [abcdefghijk].opus';
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const requests: string[] = [];
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
  await page.context().route('https://huggingface.co/**', async route => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes('/tree?')) {
      await gate;
      return route.fulfill({contentType:'application/json',body:JSON.stringify([
        {type:'file',path:'originals/Artist - Song [abcdefghijk].opus',size:100},
        {type:'file',path:'covers/Artist - Song [abcdefghijk].png',size:100},
      ])});
    }
    if (url === current || url === updated) return route.fulfill({contentType:'image/png',body:pixel});
    if (url.endsWith('manifest.json')) return route.fulfill({contentType:'application/json',body:JSON.stringify({v:1,tracks:{abcdefghijk:{t:'Song',a:'Artist'}}})});
    return route.fulfill({status:404,body:''});
  });
  await page.evaluate(({old,id}) => {
    localStorage.setItem('addedTracks','[]');
    localStorage.setItem('recentlyPlayed',JSON.stringify([{id,title:'Song',artist:'Artist',img:old}]));
    localStorage.setItem('aura_play_counts_v1',JSON.stringify({[id]:7}));
    localStorage.setItem('auraHfCatalog_v1',JSON.stringify({tracks:[{
      id,title:'Song',artist:'Artist',videoId:'abcdefghijk',img:old,isHf:true,url:'/__test__/audio/1.wav',
    }]}));
  },{old,id});
  await page.reload();
  const image = page.locator('#recentScroll .recent-card img');
  await expect(image).toHaveCount(1);
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute('src',current);
  await expect.poll(() => image.evaluate((img:HTMLImageElement) => img.naturalWidth)).toBe(1);
  release();
  await expect(image).toHaveAttribute('src',updated);
  await expect.poll(() => image.evaluate((img:HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(requests).toContain(old);
  expect(requests).toContain(current);
  expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aura_play_counts_v1')))).toEqual({[id]:7});
  expect(evidence.pageErrors).toEqual([]);
});

test('working artwork from a fresh root upload remains visible before playback', async ({page}) => {
  const evidence = await seedAura(page);
  const root = hfFileUrl('Fresh upload.webp');
  const requests: string[] = [];
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
  await page.context().route('https://huggingface.co/**/resolve/**', route => {
    requests.push(route.request().url());
    if (route.request().url() === root) return route.fulfill({contentType:'image/png',body:pixel});
    return route.fallback();
  });
  await page.evaluate(root => {
    const songs = JSON.parse(localStorage.getItem('addedTracks'));
    songs[0].img = root;
    localStorage.setItem('addedTracks',JSON.stringify(songs));
    localStorage.setItem('recentlyPlayed',JSON.stringify([{id:1,title:'Alpha',artist:'Aura Test',img:root}]));
  },root);
  await page.reload();
  await expect(page.locator('#auraLoader')).toHaveCount(0);
  const image = page.locator('#recentScroll .recent-card img');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute('src',root);
  await expect.poll(() => image.evaluate((img:HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(requests).toContain(root);
  expect(requests).not.toContain(hfFileUrl('covers/Fresh upload.webp'));
  expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  expect(evidence.pageErrors).toEqual([]);
});

test('missing artwork retries once and a reused image can recover for another song', async ({page}) => {
  const evidence = await seedAura(page);
  const missing = hfFileUrl('Missing cover.webp');
  const old = hfFileUrl('Moved cover.webp');
  const current = hfFileUrl('covers/Moved cover.webp');
  const requests: string[] = [];
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
  await page.context().route('https://huggingface.co/**/resolve/**', route => {
    requests.push(route.request().url());
    if (route.request().url() === current) return route.fulfill({contentType:'image/png',body:pixel});
    return route.fulfill({status:404,body:''});
  });
  await page.evaluate(missing => {
    const image = document.createElement('img');
    image.id = 'reused-artwork-fixture';
    image.src = missing;
    document.body.append(image);
  },missing);
  const image = page.locator('#reused-artwork-fixture');
  await expect(image).toHaveAttribute('src',DEFAULT_COVER);
  await expect.poll(() => image.evaluate((img:HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1);
  expect(requests.filter(url => url === missing)).toHaveLength(1);
  expect(requests.filter(url => url === hfFileUrl('covers/Missing cover.webp'))).toHaveLength(1);
  await image.evaluate((img:HTMLImageElement,old) => {img.src = old;},old);
  await expect(image).toHaveAttribute('src',current);
  await expect.poll(() => image.evaluate((img:HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(await image.getAttribute('data-cover-fallback')).toBeNull();
  await image.evaluate((img:HTMLImageElement) => {img.src = '/missing-next-song-artwork.png';});
  await expect(image).toHaveAttribute('src',DEFAULT_COVER);
  await expect.poll(() => image.evaluate((img:HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1);
  expect(evidence.pageErrors).toEqual([]);
});
