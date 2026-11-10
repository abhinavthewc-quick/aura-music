import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO, AUDIO_TWO, VIDEO_A, VIDEO_B, VIDEO_C, LYRICS, createPlaybackHarness, deferred, flush } from './harness.js';

type Harness = ReturnType<typeof createPlaybackHarness>;
const indexOf = (h: Harness, id: string) => h.state.songs.findIndex((song) => song.id === id);
const currentId = (h: Harness) => h.state.songs[h.state.currentIndex]?.id;
const activeLine = (h: Harness) => h.$('fullPlayerLyricsContainer').querySelector('.bl-lyric-line.active')?.getAttribute('data-idx');
async function startVideo(h: Harness, video = VIDEO_A) {
  await h.player.playYouTubeInsideAura(video.videoId, video.title, video.img);
  const yt = h.instances[h.instances.length - 1];
  yt.ready(); yt.transition(h.PlayerState.PLAYING);
  return yt;
}
async function startSequence(h: Harness, ids = [VIDEO_A.id, VIDEO_B.id, VIDEO_C.id]) {
  h.queue.playTrackSequence(ids);
  await flush();
  const yt = h.instances[h.instances.length - 1];
  yt.ready(); yt.transition(h.PlayerState.PLAYING);
  return yt;
}

test('bootstrap and metadata loads are intent-neutral; genuine requests are monotonic even in the same millisecond', async () => {
  const h = createPlaybackHarness();
  assert.equal(h.intent.getPlaybackIntent(), 0);
  h.player.loadSong(0);
  assert.equal(h.intent.getPlaybackIntent(), 0);
  assert.equal(h.audio.plays, 0);
  h.player.playSong(0);
  const first = h.intent.getPlaybackIntent();
  assert.equal(first, 1);
  h.state.songs[0].title = 'Edited metadata';
  h.player.loadSong(0);
  assert.equal(h.intent.getPlaybackIntent(), first);
  h.player.playSong(indexOf(h, AUDIO_TWO.id));
  assert.equal(h.intent.getPlaybackIntent(), first + 1);
  h.player.togglePlay();
  h.player.togglePlay();
  assert.equal(h.intent.getPlaybackIntent(), first + 3);
  h.player.playSong(indexOf(h, VIDEO_A.id));
  await flush();
  assert.equal(h.intent.getPlaybackIntent(), first + 4, 'YouTube through playSong counts once');
  h.player.stopAuraYouTube();
  assert.equal(h.intent.getPlaybackIntent(), first + 5);
  h.player.stopAuraYouTube();
  h.player.playSong(-1);
  assert.equal(h.intent.getPlaybackIntent(), first + 5, 'no-op cleanup and invalid indices do not manufacture intent');
});

test('paused audio lyrics render, seek and rewind to zero without starting playback', () => {
  const h = createPlaybackHarness();
  h.window.auraYTPlayer = { getCurrentTime: () => 88, seekTo() { throw new Error('obsolete window player'); } };
  h.player.loadSong(0);
  h.audio.currentTime = 25;
  h.lyrics.renderLyrics(LYRICS);
  assert.equal(activeLine(h), '2');
  h.window.seekToLyric(12);
  assert.equal(h.audio.currentTime, 12);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.plays, 0);
  assert.equal(activeLine(h), '1');
  h.$('upNextSheet').classList.add('active');
  h.audio.currentTime = 0;
  h.clock.frame();
  assert.equal(activeLine(h), '-1', 'the loop processes a paused clock at exactly zero');
  h.audio.currentTime = 11.8;
  h.lyrics.setSyncOffset(0.3);
  assert.equal(activeLine(h), '1');
  h.lyrics.resetSyncOffset();
  assert.equal(activeLine(h), '0');
  assert.equal(h.audio.plays, 0);
});

test('paused lyric synchronization follows its own sheet through transport changes, closing and tab switches', () => {
  const h = createPlaybackHarness();
  h.document.emit('DOMContentLoaded');
  h.player.loadSong(0);
  h.audio.currentTime = 25;
  h.player.openPlayerSheet('lyrics');
  assert.equal(activeLine(h), '2');
  h.player.updatePlayState();
  h.notifyAttributeMutation(h.$('fullPlayerOverlay'), 'class');
  h.audio.currentTime = 0;
  h.clock.frame();
  assert.equal(activeLine(h), '-1', 'a queued transport mutation on the minimized player cannot stop visible lyrics');
  h.player.closePlayerSheet();
  h.notifyAttributeMutation(h.$('upNextSheet'), 'class');
  assert.equal(h.clock.frames.size, 0, 'closing the sheet stops its animation frames');
  h.audio.currentTime = 12;
  h.clock.frame();
  assert.equal(activeLine(h), '-1');
  h.player.openPlayerSheet('lyrics');
  h.notifyAttributeMutation(h.$('upNextSheet'), 'class');
  h.audio.currentTime = 25;
  h.clock.frame();
  assert.equal(activeLine(h), '2', 'reopening the paused sheet resumes synchronization');
  h.player.switchRightPanelTab('related');
  h.notifyAttributeMutation(h.$('ytmLyricsPanel'), 'style');
  assert.equal(h.clock.frames.size, 0, 'the Related tab stops hidden lyric animation frames');
  h.player.switchRightPanelTab('lyrics');
  h.notifyAttributeMutation(h.$('ytmLyricsPanel'), 'style');
  h.audio.currentTime = 12;
  h.clock.frame();
  assert.equal(activeLine(h), '1');
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.plays, 0);
});

test('a retained YouTube track can be prepared at bootstrap without creating a player or claiming audio', async () => {
  const h = createPlaybackHarness();
  h.state.currentIndex = indexOf(h, VIDEO_A.id);
  h.player.loadSong(h.state.currentIndex);
  assert.equal(h.$('fullTitle').textContent, VIDEO_A.title);
  assert.equal(h.intent.getPlaybackIntent(), 0);
  assert.equal(h.instances.length, 0);
  assert.equal(h.audio.plays, 0);
  assert.equal(h.player.seekActivePlayback(12), false);
  h.player.togglePlay(); await flush();
  assert.equal(h.instances[0].options.videoId, VIDEO_A.videoId);
  assert.equal(h.intent.getPlaybackIntent(), 1);
});

test('YouTube lyrics use the live module player, never stale library audio or a window fallback', async () => {
  const h = createPlaybackHarness();
  h.player.playSong(0);
  h.audio.currentTime = 77;
  const audioPlays = h.audio.plays;
  let globalReads = 0;
  h.window.auraYTPlayer = { getCurrentTime() { globalReads++; return 99; }, seekTo() { globalReads++; } };
  const yt = await startVideo(h);
  yt.time = 17;
  h.lyrics.renderLyrics(LYRICS);
  assert.equal(activeLine(h), '1');
  assert.equal(h.player.getActivePlaybackTime(), 17);
  h.window.seekToLyric(24);
  assert.deepEqual(yt.seeks, [24]);
  assert.equal(h.audio.currentTime, 77);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.plays, audioPlays);
  const ytPlays = yt.plays;
  yt.transition(h.PlayerState.PAUSED);
  h.lyrics.renderLyrics(LYRICS);
  assert.equal(activeLine(h), '2');
  h.window.seekToLyric(12);
  assert.equal(yt.plays, ytPlays, 'lyric seek does not resume paused YouTube either');
  assert.equal(h.state.isPlaying, false);
  h.$('upNextSheet').classList.add('active');
  yt.time = 0;
  h.clock.frame();
  assert.equal(activeLine(h), '-1');
  yt.time = 4.8;
  h.lyrics.setSyncOffset(0.4);
  assert.equal(activeLine(h), '0');
  h.lyrics.resetSyncOffset();
  assert.equal(activeLine(h), '-1');
  assert.equal(globalReads, 0);
  assert.equal(h.audio.plays, audioPlays);
});

test('loading, stopped, failed and unseekable YouTube sources cannot seek or resume library audio', async () => {
  const h = createPlaybackHarness({ delayedAPI: true });
  h.player.loadSong(0);
  h.audio.currentTime = 66;
  const pending = h.player.playYouTubeInsideAura(VIDEO_A.videoId, VIDEO_A.title, '');
  h.window.seekToLyric(12);
  assert.equal(h.player.seekActivePlayback(12), false);
  assert.equal(h.player.getActivePlaybackTime(), 0);
  assert.equal(h.audio.currentTime, 66);
  h.player.closeYouTubePlayer();
  h.installYouTube(); h.window.onYouTubeIframeAPIReady();
  await pending;
  assert.equal(h.instances.length, 0, 'stop cancels pending API construction');
  assert.equal(h.player.seekActivePlayback(12), false);
  const yt = await startVideo(h);
  yt.seekThrows = true;
  assert.equal(h.player.seekActivePlayback(12), false);
  yt.error();
  h.window.seekToLyric(24);
  assert.equal(h.audio.currentTime, 66);
  assert.equal(h.audio.plays, 0);
  assert.equal(h.state.isPlaying, false);
  assert.equal(h.player.seekActivePlayback(Number.NaN), false);
});

test('retained YouTube A → B → C autoplays through the real manual queue with an empty Search queue', async () => {
  const h = createPlaybackHarness();
  const first = await startSequence(h);
  assert.equal(h.search.auraYTQueue.length, 0);
  assert.deepEqual([...h.queue.manualQueue], [VIDEO_B.id, VIDEO_C.id]);
  first.transition(h.PlayerState.ENDED);
  first.transition(h.PlayerState.ENDED);
  assert.equal([...h.clock.timers.values()].filter((timer) => timer.delay === 250).length, 1, 'duplicate ENDED schedules once');
  h.clock.advance(249);
  assert.equal(currentId(h), VIDEO_A.id);
  h.clock.advance(1); await flush();
  assert.equal(currentId(h), VIDEO_B.id);
  assert.deepEqual([...h.queue.manualQueue], [VIDEO_C.id]);
  assert.equal(first.destroyed, true);
  const second = h.instances[1];
  second.ready(); second.transition(h.PlayerState.PLAYING); second.transition(h.PlayerState.ENDED);
  h.clock.advance(250); await flush();
  assert.equal(currentId(h), VIDEO_C.id);
  assert.deepEqual([...h.queue.manualQueue], []);
});

test('shared queue autoplay crosses YouTube → local audio → YouTube', async () => {
  const h = createPlaybackHarness();
  const yt = await startSequence(h, [VIDEO_A.id, AUDIO_TWO.id, VIDEO_B.id]);
  yt.transition(h.PlayerState.ENDED);
  h.clock.advance(250); await flush();
  assert.equal(currentId(h), AUDIO_TWO.id);
  assert.equal(h.audio.getAttribute('src'), AUDIO_TWO.url);
  assert.equal(h.audio.paused, false);
  h.audio.end(); await flush();
  assert.equal(currentId(h), VIDEO_B.id);
  assert.equal(h.audio.paused, true);
  assert.deepEqual([...h.queue.manualQueue], []);
});

test('superseded iframe ready/state/error/end callbacks cannot affect a newer selection', async (t) => {
  for (const destination of ['youtube', 'audio', 'stop']) {
    await t.test(destination, async () => {
      const h = createPlaybackHarness();
      const old = await startSequence(h);
      old.transition(h.PlayerState.ENDED);
      const delayedEnd = h.clock.timer(250)!;
      old.stopEmitsEnded = true;
      if (destination === 'youtube') h.player.playSong(indexOf(h, VIDEO_C.id));
      else if (destination === 'audio') h.player.playSong(indexOf(h, AUDIO_TWO.id));
      else h.player.closeYouTubePlayer();
      await flush();
      const selected = currentId(h), intent = h.intent.getPlaybackIntent();
      const playing = h.state.isPlaying, ready = h.player.auraYTPlayerReady, oldPlays = old.plays;
      delayedEnd(); // Also models a callback already dequeued before clearTimeout.
      old.ready(); old.transition(h.PlayerState.PLAYING); old.transition(h.PlayerState.PAUSED);
      old.transition(h.PlayerState.ENDED); old.blocked(); old.error();
      h.clock.advance(500); await flush();
      assert.equal(currentId(h), selected);
      assert.equal(h.intent.getPlaybackIntent(), intent);
      assert.equal(h.state.isPlaying, playing);
      assert.equal(h.player.auraYTPlayerReady, ready);
      assert.equal(old.plays, oldPlays);
      assert.deepEqual([...h.queue.manualQueue], [VIDEO_B.id, VIDEO_C.id]);
      assert.equal(h.toasts.length, 0);
    });
  }
});

test('external intent cancellation, radio and room ownership fence an already delayed end', async (t) => {
  for (const cancel of ['intent', 'radio', 'room']) {
    await t.test(cancel, async () => {
      const h = createPlaybackHarness();
      const yt = await startSequence(h);
      yt.transition(h.PlayerState.ENDED);
      if (cancel === 'intent') h.intent.beginPlaybackIntent();
      if (cancel === 'radio') h.radio.currentRadioStation = { name: 'Live' };
      if (cancel === 'room') h.room.setRoomActive(true);
      h.clock.advance(250); await flush();
      assert.equal(currentId(h), VIDEO_A.id);
      assert.deepEqual([...h.queue.manualQueue], [VIDEO_B.id, VIDEO_C.id]);
      assert.equal(h.player.seekActivePlayback(12), false);
    });
  }
});

test('a delayed API constructs only the newest selected video on its own host', async () => {
  const h = createPlaybackHarness({ delayedAPI: true });
  const first = h.player.playYouTubeInsideAura(VIDEO_A.videoId, VIDEO_A.title, '');
  const oldHost = h.$('auraYTFrameHost');
  const second = h.player.playYouTubeInsideAura(VIDEO_B.videoId, VIDEO_B.title, '');
  const newHost = h.$('auraYTFrameHost');
  assert.notEqual(oldHost, newHost);
  assert.equal(h.document.head.children.length, 1, 'one shared API script');
  h.installYouTube(); h.window.onYouTubeIframeAPIReady();
  await Promise.all([first, second]);
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].host, newHost);
  assert.equal(h.instances[0].options.videoId, VIDEO_B.videoId);
  assert.equal(h.player.auraYTPlayer, h.instances[0]);
});

test('Pause before API readiness cancels autoplay; same-source resume keeps live event ownership', async () => {
  const h = createPlaybackHarness({ delayedAPI: true });
  const pending = h.player.playYouTubeInsideAura(VIDEO_A.videoId, VIDEO_A.title, '');
  const before = h.intent.getPlaybackIntent();
  assert.equal(h.$('fullPlayBtn').getAttribute('aria-label'), 'Pause', 'the pending command has a working Pause control');
  h.mediaActions.get('pause')!();
  assert.equal(h.intent.getPlaybackIntent(), before + 1);
  assert.equal(h.$('fullPlayBtn').getAttribute('aria-label'), 'Play');
  h.installYouTube(); h.window.onYouTubeIframeAPIReady(); await pending;
  const yt = h.instances[0];
  assert.equal(yt.options.playerVars.autoplay, 0);
  yt.ready();
  assert.equal(yt.plays, 0);
  h.player.togglePlay();
  yt.transition(h.PlayerState.PLAYING);
  assert.equal(h.state.isPlaying, true);
  h.queue.promoteVisibleOrder([VIDEO_B.id]);
  yt.transition(h.PlayerState.ENDED);
  h.clock.advance(250); await flush();
  assert.equal(currentId(h), VIDEO_B.id, 'updating the intent on a control must not strand this player’s end handler');
});

test('replay, lyric/slider seeking, autoplay preference and repeat-one cancel delayed advancement', async () => {
  const h = createPlaybackHarness();
  const yt = await startSequence(h);
  const end = () => { yt.transition(h.PlayerState.PLAYING); yt.transition(h.PlayerState.ENDED); return h.clock.timer(250)!; };
  const replay = end();
  h.player.togglePlay(); replay();
  assert.equal(currentId(h), VIDEO_A.id);
  const lyricSeek = end();
  h.window.seekToLyric(12); lyricSeek();
  assert.equal(currentId(h), VIDEO_A.id);
  const sliderSeek = end();
  h.$('fullSeekSlider').value = 25; h.$('fullSeekSlider').emit('input'); sliderSeek();
  assert.equal(yt.time, 30);
  assert.equal(currentId(h), VIDEO_A.id);
  end(); h.settings.autoplayNext = false;
  h.clock.advance(250);
  assert.equal(currentId(h), VIDEO_A.id);
  h.settings.autoplayNext = true;
  h.state.repeatMode = 'one';
  const plays = yt.plays;
  yt.transition(h.PlayerState.PLAYING); yt.transition(h.PlayerState.ENDED);
  h.clock.advance(500);
  assert.equal(yt.time, 0);
  assert.equal(yt.plays, plays + 1);
  assert.deepEqual([...h.queue.manualQueue], [VIDEO_B.id, VIDEO_C.id]);
});

test('artwork tools retain node identity, bound Info/Share handlers and attached listeners across source changes', async () => {
  const h = createPlaybackHarness();
  const controls = ['artInfoBtn', 'artLikeBtn', 'artShareBtn'].map(h.$);
  const tools = h.$('fullPlayerArt').querySelector('.ytm-art-overlay-tools');
  let likes = 0;
  controls[1].addEventListener('click', () => likes++);
  h.player.loadSong(0);
  for (const change of [
    () => h.player.resetFullPlayerArtToImage('cover:one'),
    () => startVideo(h),
    () => startVideo(h, VIDEO_B),
    () => h.player.closeYouTubePlayer(),
    () => h.player.playSong(0),
  ]) {
    await change();
    assert.equal(h.$('fullPlayerArt').querySelector('.ytm-art-overlay-tools'), tools);
    assert.deepEqual(controls.map((node) => h.$(node.id) === node), [true, true, true]);
    controls.forEach((node) => node.click());
    assert.equal(h.trackSheets[h.trackSheets.length - 1].title, h.state.songs[h.state.currentIndex].title);
    const song = h.state.songs[h.state.currentIndex];
    assert.equal(h.shares[h.shares.length - 1].url, song.isYouTube ? 'https://youtu.be/' + song.videoId : song.url);
  }
  assert.equal(likes, 5);
});

test('control-origin, control-ending, canceled, orphaned and dragged artwork gestures never toggle playback', () => {
  const h = createPlaybackHarness();
  h.player.playSong(0);
  const art = h.$('fullPlayerArt'), control = h.$('artInfoBtn').children[0];
  const pointer = (target: any, type: string, overrides = {}) => target.emit(type, { pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 20, ...overrides });
  const before = h.intent.getPlaybackIntent();
  pointer(control, 'pointerdown'); pointer(art, 'pointerup', { clientX: 21 });
  pointer(art, 'pointerdown'); pointer(control, 'pointerup');
  pointer(art, 'pointerdown'); pointer(art, 'pointercancel'); pointer(art, 'pointerup');
  pointer(art, 'pointerup');
  pointer(art, 'pointerdown'); pointer(art, 'pointermove', { clientX: 60 }); pointer(art, 'pointerup');
  pointer(art, 'pointerdown', { button: 2 }); pointer(art, 'pointerup');
  pointer(art, 'pointerdown', { isPrimary: false }); pointer(art, 'pointerup');
  assert.equal(h.intent.getPlaybackIntent(), before);
  assert.equal(h.state.isPlaying, true);
  pointer(art, 'pointerdown'); pointer(art, 'pointerup');
  assert.equal(h.intent.getPlaybackIntent(), before + 1);
  assert.equal(h.state.isPlaying, false, 'a normal artwork tap still works');
});

test('late HTML-audio promises and events cannot override a newer audio or YouTube request', async () => {
  const h = createPlaybackHarness();
  const old = deferred();
  h.audio.playResults.push(old.promise);
  h.player.playSong(0);
  h.player.playSong(indexOf(h, AUDIO_TWO.id));
  old.reject(new Error('old same-millisecond play failed')); await flush();
  h.audio.emit('pause', { bubbles: false });
  assert.equal(h.state.isPlaying, true);
  h.player.togglePlay();
  h.audio.emit('play', { bubbles: false });
  assert.equal(h.state.isPlaying, false, 'a queued old play event cannot resume a paused transport');
  const pending = deferred();
  h.audio.playResults.push(pending.promise);
  h.player.playSong(0);
  h.audio.currentTime = 77;
  h.audio.emit('timeupdate', { bubbles: false });
  await startVideo(h);
  h.$('fullCurrentTime').textContent = 'YouTube position';
  pending.reject(new Error('late audio rejection'));
  h.audio.emit('pause', { bubbles: false }); h.audio.end();
  h.clock.frame(); await flush();
  assert.equal(currentId(h), VIDEO_A.id);
  assert.equal(h.state.isPlaying, true);
  assert.equal(h.$('fullCurrentTime').textContent, 'YouTube position');
});

test('passive audio fallback never autoplays; retired fallback and foreground callbacks cannot revive it', async () => {
  const h = createPlaybackHarness();
  h.state.songs[0].hfUrl = '/fallback.wav';
  h.player.loadSong(0);
  h.audio.emit('error', { bubbles: false });
  assert.equal(h.audio.getAttribute('src'), 'https://fixture.invalid/fallback.wav');
  assert.equal(h.audio.plays, 0);
  h.player.playSong(0);
  h.player.auraCaptureBackgroundState(); h.audio.pause();
  h.player.auraResumeAfterForeground();
  assert.equal(h.audio.plays, 2, 'the same current audio source may resume after an OS pause');
  const oldError = h.audio.onerror;
  h.player.auraCaptureBackgroundState();
  await startVideo(h);
  const plays = h.audio.plays;
  oldError(); h.player.auraResumeAfterForeground();
  assert.equal(h.audio.getAttribute('src'), AUDIO.url);
  assert.equal(h.audio.plays, plays);
  assert.equal(h.audio.paused, true);
});

test('late lyric provider results cannot replace the current track’s lyrics, including a stale null completion', async (t) => {
  for (const source of ['audio', 'youtube']) {
    await t.test(source, async () => {
      const h = createPlaybackHarness();
      h.$('upNextSheet').classList.add('active');
      const song = source === 'audio' ? AUDIO : VIDEO_A;
      h.lyrics.lyricsCache.delete(h.lyrics.getTrackKey(song.title, song.artist));
      h.player.playSong(indexOf(h, song.id)); await flush();
      assert.equal(h.fetches.length, 1);
      h.player.playSong(indexOf(h, AUDIO_TWO.id)); await flush();
      const text = h.$('fullPlayerLyricsContainer').textContent;
      const status = h.$('blStatusText').textContent;
      h.fetches[0].resolve({ ok: true, json: async () => ({ ttml: '<p begin="00:05.0"><span begin="00:05.0" end="00:06.0">Stale</span><span begin="00:06.0" end="00:07.0">lyrics</span></p>' }) });
      await flush();
      assert.equal(h.$('fullPlayerLyricsContainer').textContent, text);
      assert.equal(h.$('blStatusText').textContent, status);
      assert.equal(status, 'Synced • Fixture');
    });
  }
});
