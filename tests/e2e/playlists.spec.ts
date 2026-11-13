import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { currentTitle, endNativeAudio, mockYouTube, openPlayerSheet, openPlaylist, resetPosition, seedAura, silentAudio, store } from './fixtures';

test('playlist transport remains scoped; Previous and selecting a different playlist use the right order', async ({page}) => {
  const evidence = await seedAura(page,{repeat:'off'});
  await page.getByRole('button',{name:'Playlists',exact:true}).first().click();
  await page.getByRole('button',{name:'Open Night test'}).click();
  await page.locator('[data-play-playlist]').click();
  await expect.poll(() => currentTitle(page)).toBe('Gamma');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  await resetPosition(page); await page.locator('#miniPrevBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Gamma');
  await openPlaylist(page,'p2'); await page.getByRole('button',{name:'Play Beta by Aura Test'}).click();
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Delta');
  expect(evidence.pageErrors).toEqual([]);
});

test('repeat off/all/one and shuffle stay scoped and are mirrored between controls', async ({page}) => {
  await seedAura(page); await openPlaylist(page); await page.locator('[data-play-playlist]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.repeatMode)).toBe('all');
  await expect(page.locator('#miniRepeatBtn')).toHaveAttribute('aria-label','Repeat all');
  await page.locator('#nextBtn').click(); await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Gamma');
  await page.locator('#miniRepeatBtn').click(); await expect(page.locator('#repeatBtn')).toHaveAttribute('aria-label','Repeat one');
  await endNativeAudio(page);
  await expect.poll(() => currentTitle(page)).toBe('Gamma');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await page.locator('#miniShuffleBtn').click();
  const order = await page.evaluate(() => (globalThis as any).state.playbackContext.playOrder);
  expect(new Set(order)).toEqual(new Set(['id:3','id:1']));
  await page.locator('#miniRepeatBtn').click(); await expect(page.locator('#repeatBtn')).toHaveAttribute('aria-label','Repeat off');
});

test('manual queue interrupts a playlist, then resumes it; history includes queued tracks', async ({page}) => {
  await seedAura(page); await openPlaylist(page); await page.locator('[data-play-playlist]').click();
  await page.evaluate(() => (globalThis as any).openTrackMenu(null,'4'));
  await page.getByRole('button',{name:'Play next',exact:true}).click();
  await openPlayerSheet(page,'queue');
  await expect(page.locator('#queueContextLabel')).toHaveText('Up next from Night test');
  await expect(page.locator('.up-next-row').first()).toHaveAttribute('data-up-next-id','id:4');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Delta');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await resetPosition(page); await page.locator('#miniPrevBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Delta');
  await resetPosition(page); await page.locator('#miniPrevBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Gamma');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Delta');
});

test('row selection changes the collection without discarding unheard manual queue entries', async ({page}) => {
  await seedAura(page); await openPlaylist(page); await page.locator('[data-play-playlist]').click();
  await page.evaluate(() => (globalThis as any).openTrackMenu(null,'1')); await page.getByRole('button',{name:'Play next',exact:true}).click();
  await openPlaylist(page,'p2'); await page.getByRole('button',{name:'Play Beta by Aura Test'}).click();
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Delta');
});

test('metadata edits preserve stable references, playhead, and selected track identity', async ({page}) => {
  await seedAura(page); await openPlaylist(page); await page.getByRole('button',{name:'Play Alpha by Aura Test'}).click();
  await page.evaluate(() => {(globalThis as any).state.audio.currentTime=12;(globalThis as any).openTrackMenu(null,'1');});
  await page.getByRole('button',{name:'Edit Track',exact:true}).click();
  await page.locator('#editTitleInput').fill('Alpha renamed'); await page.locator('#editArtistInput').fill('Edited artist');
  await page.getByRole('button',{name:'Save Changes',exact:true}).click();
  await expect.poll(() => currentTitle(page)).toBe('Alpha renamed');
  await expect(page.getByRole('button',{name:'Play Alpha renamed by Edited artist'})).toBeVisible();
  expect((await store(page)).playlists.find((item:any) => item.id==='p1').tracks.map((ref:any) => ref.ref)).toEqual(['id:3','id:1']);
  expect(await page.evaluate(() => (globalThis as any).state.audio.currentTime)).toBeGreaterThanOrEqual(12);
});

test('stale catalogue indices cannot change row targets; numeric favorites retain the production index API', async ({page}) => {
  await seedAura(page); await openPlaylist(page);
  await page.evaluate(() => (globalThis as any).state.songs.reverse());
  await page.getByRole('button',{name:'Add Beta',exact:true}).click();
  await page.getByRole('button',{name:'Play Gamma by Second Artist'}).click(); await expect.poll(() => currentTitle(page)).toBe('Gamma');
  const index = await page.evaluate(() => (globalThis as any).state.songs.findIndex((song:any) => song.id===1));
  await page.evaluate(index => (globalThis as any).toggleFavorite(null,index),index);
  expect(await page.evaluate(() => (globalThis as any).state.songs.find((song:any) => song.id===1).favorite)).toBe(true);
  expect(await page.evaluate(() => !!(globalThis as any).state.songs.find((song:any) => song.id===2).favorite)).toBe(false);
  expect((await store(page)).playlists.find((item:any) => item.id==='p1').tracks.map((ref:any) => ref.ref)).toContain('id:2');
});

test('missing tracks stay visible, can be relinked, and a missing local file can be restored', async ({page}) => {
  await seedAura(page,{missingLocal:true}); await openPlaylist(page,'p3');
  await expect(page.locator('.pl-track.is-missing')).toHaveCount(1);
  await page.getByRole('button',{name:'Relink lost song'}).click();
  await page.locator('#playlistPicker').getByRole('button',{name:/Gamma/}).click();
  await expect(page.getByRole('button',{name:'Play Gamma by Second Artist'})).toBeVisible();
  await openPlaylist(page,'p4');
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Restore the file for Missing file'}).click();
  await (await chooser).setFiles({name:'restored.wav',mimeType:'audio/wav',buffer:silentAudio()});
  await expect(page.getByRole('button',{name:'Play Missing file by My device'})).toBeVisible();
  expect((await store(page)).playlists.find((item:any) => item.id==='p4').tracks[0].ref).toBe('id:local-missing');
});

test('reordering is keyboard accessible and nested Edit only edits once', async ({page}) => {
  await seedAura(page); await page.evaluate(() => (globalThis as any).goTab('tabPlaylists'));
  await page.getByRole('button',{name:'Edit Night test'}).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#playlistModal')).toHaveClass(/active/); await expect(page.locator('#tabPlaylists')).toHaveClass(/active/);
  await page.keyboard.press('Escape'); await openPlaylist(page);
  await page.getByRole('button',{name:'Move Alpha up'}).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-track-ref]').first()).toHaveAttribute('data-track-ref','id:1');
  await page.getByRole('button',{name:'Play Alpha by Aura Test'}).focus(); await page.keyboard.press('Space');
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
});

test('export/import round-trips order and unavailable references; invalid imports are atomic', async ({page}) => {
  await seedAura(page); await openPlaylist(page);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button',{name:'Export Night test'}).click();
  const download = await downloadPromise, payload = await readFile(await download.path());
  expect(JSON.parse(payload.toString()).playlist.tracks.map((ref:any) => ref.ref)).toEqual(['id:3','id:1']);
  await page.evaluate(() => (globalThis as any).goTab('tabPlaylists'));
  page.on('dialog',(dialog) => dialog.accept());
  let chooser = page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Import a playlist file'}).click();
  await (await chooser).setFiles({name:download.suggestedFilename(),mimeType:'application/json',buffer:payload});
  await expect.poll(async () => (await store(page)).playlists.length).toBe(4);
  await expect(page.locator('.pl-name')).toHaveText('Night test');
  await page.evaluate(() => (globalThis as any).goTab('tabPlaylists'));
  const before = await store(page), invalid = JSON.parse(payload.toString()); invalid.playlist.tracks.push({ref:'id:9'});
  chooser = page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Import a playlist file'}).click();
  await (await chooser).setFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});
  await expect(page.locator('.toast').last()).toContainText('Track title');
  expect(await store(page)).toEqual(before);
});

test('cross-tab detail/picker updates and concurrent appends do not overwrite each other', async ({page,context}) => {
  await seedAura(page); await openPlaylist(page);
  const other = await context.newPage(); await other.goto('/'); await other.waitForFunction(() => !!(globalThis as any).addTrackToPlaylist);
  await Promise.all([
    page.evaluate(() => (globalThis as any).addTrackToPlaylist('p1','2')),
    other.evaluate(() => (globalThis as any).addTrackToPlaylist('p1','4')),
  ]);
  await expect(page.locator('#tabPlaylist [data-track-ref]')).toHaveCount(4);
  await other.evaluate(() => (globalThis as any).openPlaylistModal('p1')); await other.locator('#playlistTitleInput').fill('Renamed elsewhere'); await other.locator('#playlistSubmitBtn').click();
  await expect(page.locator('.pl-name')).toHaveText('Renamed elsewhere');
  await page.evaluate(() => (globalThis as any).openPlaylistPicker('1'));
  other.once('dialog',(dialog) => dialog.accept());
  await other.evaluate(() => (globalThis as any).deletePlaylist('p2'));
  await expect(page.locator('#playlistPicker')).not.toContainText('Second queue');
  await expect(page.locator('#playlistPicker')).toContainText('Renamed elsewhere');
});

test('IndexedDB fallback serializes writes when Web Locks are unavailable', async ({page,context}) => {
  await seedAura(page,{fallbackLock:true});
  const other = await context.newPage(); await other.goto('/'); await other.waitForFunction(() => !!(globalThis as any).addTrackToPlaylist);
  await Promise.all([page.evaluate(() => (globalThis as any).addTrackToPlaylist('p1','2')),other.evaluate(() => (globalThis as any).addTrackToPlaylist('p1','4'))]);
  expect((await store(page)).playlists.find((item:any) => item.id==='p1').tracks).toHaveLength(4);
});

test('failed storage writes never report success or drop tracks; corrupt/newer data stays unchanged', async ({page}) => {
  await seedAura(page); await openPlaylist(page);
  const before = await store(page);
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    (window as any).__restoreStorage = () => Storage.prototype.setItem=write;
    Storage.prototype.setItem=function(key,value){if(key==='auraPlaylists')throw new DOMException('quota','QuotaExceededError');return write.call(this,key,value);};
  });
  await page.getByRole('button',{name:'Remove Gamma from playlist'}).click();
  await expect(page.locator('.toast').last()).toContainText('could not save'); expect(await store(page)).toEqual(before);
  await page.evaluate(() => {(window as any).__restoreStorage();localStorage.setItem('auraPlaylists','{"version":99,"playlists":[]}');window.dispatchEvent(new StorageEvent('storage',{key:'auraPlaylists'}));});
  await page.evaluate(() => (globalThis as any).goTab('tabPlaylists'));
  await expect(page.getByRole('alert')).toContainText('unsupported');
  expect(await page.evaluate(() => localStorage.getItem('auraPlaylists'))).toBe('{"version":99,"playlists":[]}');
});

test('Search category clears stale queries and playlist navigation clears Search body state', async ({page}) => {
  await seedAura(page); await page.evaluate(() => (globalThis as any).goTab('tabSearch'));
  await page.locator('#searchTabInput').fill('Alpha');
  await page.evaluate(() => (globalThis as any).goToSearchCategory('local'));
  await expect(page.locator('#searchTabInput')).toHaveValue(''); await expect(page.locator('#searchResultsLabel')).toHaveText('Local files');
  await expect(page.locator('#searchResultsList .song-item')).toHaveCount(1);
  await openPlaylist(page); await expect(page.locator('body')).not.toHaveClass(/tab-search-active/);
});

test('YouTube playlist ends advance context, keep metadata, and reject stale iframe events', async ({page}) => {
  await seedAura(page); await mockYouTube(page);
  await page.evaluate(() => {
    const state = (globalThis as any).state;
    state.songs.push({id:'yt-test',videoId:'abcdefghijk',isYouTube:true,title:'Video title',artist:'Video artist',img:'/aura-logo.png'});
    (globalThis as any).playTrackSequence(['yt-test','1'],{source:'playlist',collectionId:'video-test',label:'Video fixture'});
  });
  await expect.poll(() => currentTitle(page)).toBe('Video title');
  expect(await page.evaluate(() => navigator.mediaSession.metadata.artist)).toBe('Video artist');
  await page.waitForFunction(() => (window as any).__youtubePlayers[0]?.getPlayerState()===1);
  await page.evaluate(() => (window as any).__youtubePlayers[0].transition(0));
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await page.evaluate(() => (window as any).__youtubePlayers[0].transition(0));
  await expect.poll(() => currentTitle(page)).toBe('Alpha');
});

test('Media Session uses the same context, and lyrics are fetched lazily with a real parser', async ({page}) => {
  const evidence = await seedAura(page); await openPlaylist(page); await page.locator('[data-play-playlist]').click();
  expect(evidence.lyricsRequests).toHaveLength(0);
  await page.evaluate(() => (window as any).__mediaActions.nexttrack()); await expect.poll(() => currentTitle(page)).toBe('Alpha');
  await openPlayerSheet(page,'queue'); expect(evidence.lyricsRequests).toHaveLength(0);
  await page.locator('#ytmTabLyricsBtn').click(); await expect(page.locator('#fullPlayerLyricsContainer')).toContainText(/alpha first line/i);
  const parsed = await page.evaluate(async () => {
    const path = '/src/features/lyrics.ts'; const lyrics = await import(path);
    return lyrics.parseLRC('[00:01.50]First\n[00:03.00]Second','Fixture','Line').lines;
  });
  expect(parsed.map((line:any) => [line.time,line.text])).toEqual([[1.5,'First'],[3,'Second']]);
});

test('desktop and mobile surfaces keep visible labels and no horizontal overflow', async ({page}) => {
  const evidence = await seedAura(page);
  for (const width of [1440,768,390,320]) {
    await page.setViewportSize({width,height:900});
    for (const tab of ['tabHome','tabSearch','tabLibrary','tabPlaylists']) {
      await page.evaluate((tab) => (globalThis as any).goTab(tab),tab);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),`${tab} at ${width}`).toBeLessThanOrEqual(1);
    }
    await openPlaylist(page);
    await expect(page.getByRole('button',{name:'Edit playlist',exact:true})).toBeVisible(); await expect(page.getByRole('button',{name:'Export Night test'})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),`playlist at ${width}`).toBeLessThanOrEqual(1);
  }
  expect(evidence.pageErrors).toEqual([]);
});

test('deletion cannot destroy local audio when metadata persistence is denied', async ({page}) => {
  await seedAura(page);
  const before = await page.evaluate(() => localStorage.getItem('addedTracks'));
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==='addedTracks')throw new DOMException('quota','QuotaExceededError');return write.call(this,key,value);};
    (globalThis as any).openTrackMenu(null,'4');
  });
  page.once('dialog',(dialog) => dialog.accept());
  await page.getByRole('button',{name:'Remove from Library',exact:true}).click();
  await expect(page.locator('.toast').last()).toContainText('could not be saved');
  expect(await page.evaluate(() => localStorage.getItem('addedTracks'))).toBe(before);
  const retained = await page.evaluate(async () => {
    const path = '/src/features/library.ts'; const library = await import(path);
    return (await library.getLocalBlob(4))?.size;
  });
  expect(retained).toBe(silentAudio().length);
});
test('pending YouTube honors Media Session Pause and never resumes the previous HTML source', async ({page}) => {
  await seedAura(page);
  const previousSource = await page.evaluate(() => (globalThis as any).state.audio.getAttribute('src'));
  await page.context().route('https://www.youtube.com/iframe_api',(route) => route.fulfill({contentType:'application/javascript',body:'/* SDK callback is deliberately deferred */'}));
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    (window as any).__audioPlayCount = 0;
    HTMLMediaElement.prototype.play=function(){(window as any).__audioPlayCount++;return original.call(this);};
    (globalThis as any).state.songs.push({id:'deferred-video',videoId:'abcdefghijk',title:'Deferred video',artist:'Video artist',isYouTube:true,img:'/aura-logo.png'});
    (globalThis as any).playTrackSequence(['deferred-video'],{source:'manual',label:'Deferred fixture'});
  });
  await page.waitForFunction(() => typeof (window as any).onYouTubeIframeAPIReady==='function');
  await page.evaluate(() => {(window as any).__mediaActions.play();(window as any).__mediaActions.pause();});
  expect(await page.evaluate(() => (window as any).__audioPlayCount)).toBe(0);
  // Production retains the paused native source, but a pending iframe owns
  // transport and time. Native audio must never be the fallback for Play/seek.
  expect(await page.evaluate(() => (globalThis as any).state.audio.getAttribute('src'))).toBe(previousSource);
  expect(await page.evaluate(() => (globalThis as any).state.audio.paused)).toBe(true);
  expect(await page.evaluate(async () => {
    const player = await import('/src/features/player.ts' as string);
    return { time: player.getActivePlaybackTime(), sought: player.seekActivePlayback(20) };
  })).toEqual({ time: 0, sought: false });
  await mockYouTube(page); await page.evaluate(() => (window as any).onYouTubeIframeAPIReady());
  await expect.poll(() => page.evaluate(() => (window as any).__youtubePlayers.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__youtubePlayers[0].getPlayerState())).toBe(2);
  expect(await page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(false);
  await page.evaluate(() => (window as any).__mediaActions.play());
  await expect.poll(() => page.evaluate(() => (globalThis as any).state.isPlaying)).toBe(true);
});
test('selecting a future queued item keeps its original collection anchor and honest Up Next order', async ({page}) => {
  await seedAura(page); await openPlaylist(page); await page.locator('[data-play-playlist]').click();
  for (const id of ['4','2']) {
    await page.evaluate((id) => (globalThis as any).openTrackMenu(null,id),id);
    await page.getByRole('button',{name:'Add to queue',exact:true}).click();
  }
  await page.locator('#nextBtn').click(); await resetPosition(page); await page.locator('#miniPrevBtn').click();
  await openPlayerSheet(page,'queue');
  await expect(page.locator('.up-next-row').first()).toHaveAttribute('data-up-next-id','id:4');
  await page.locator('#upNextList').getByRole('button',{name:'Play Delta by Second Artist'}).click();
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Beta');
  await page.locator('#nextBtn').click(); await expect.poll(() => currentTitle(page)).toBe('Alpha');
});
