/* Run on a fresh /tests/artists/browser.html local fixture page. The app,
   controls, lyrics and queue are real; only the YouTube iframe API is synthetic. */
const $ = (id) => document.getElementById(id);
const frame = () => new Promise(requestAnimationFrame);
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await frame();
  }
  throw new Error('Timed out: ' + label);
}
const sampleLyrics = {
  isSynced: true, syncType: 'Line', provider: 'Playback fixture', lines: [
    { time: 5, text: 'First fixture line' },
    { time: 12, text: 'Second fixture line' },
    { time: 24, text: 'Third fixture line' },
  ],
};

export async function runPlaybackRegressions() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'main') throw new Error('Use the dedicated local main-app fixture.');
  await until(() => window.state?.songs.length && !window.state.catalogLoading && !$('musicApp').hidden, 'music bootstrap');
  const [{ state }, player, lyrics, queue, { auraSettings }, intent, radio] = await Promise.all([
    import('/src/core/state.ts'), import('/src/features/player.ts'), import('/src/features/lyrics.ts'),
    import('/src/features/queue.ts'), import('/src/features/settings.ts'), import('/src/core/playbackIntent.ts'),
    import('/src/features/radio.ts'),
  ]);
  await until(() => state.songs.some((song) => song.isLocal && song.url?.startsWith('blob:')), 'local media hydration');
  const passed = [];
  const check = (value, label) => { if (!value) throw new Error(label); passed.push(label); };
  const activeLine = () => $('fullPlayerLyricsContainer').querySelector('.bl-lyric-line.active')?.dataset.idx;
  const originalYT = Object.getOwnPropertyDescriptor(window, 'YT');
  const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');
  const originalSettings = { autoplayNext: auraSettings.autoplayNext, repeatMode: state.repeatMode, isShuffle: state.isShuffle };
  const originalSongs = [...state.songs];
  const originalQueue = [...queue.manualQueue];
  const errorsBefore = fixture.errors.length;
  const nativePlays = [];
  const onPlay = () => nativePlays.push(state.audio.currentTime);
  state.audio.addEventListener('play', onPlay);
  const shares = [];
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { shares.push(data); } });
  const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const instances = [];
  class FixturePlayer {
    state = PlayerState.UNSTARTED;
    time = 0;
    plays = 0;
    destroyed = false;
    seeks = [];
    constructor(host, options) {
      if (!(host instanceof HTMLElement)) throw new Error('Expected the selection’s own host element');
      this.options = options;
      this.frame = document.createElement('iframe');
      this.frame.id = host.id;
      this.frame.title = 'Local playback test';
      this.frame.srcdoc = '<!doctype html><html><body style="background:black;color:white">Local iframe fixture</body></html>';
      host.replaceWith(this.frame);
      instances.push(this);
    }
    ready() { this.options.events.onReady({ target: this }); }
    transition(state) { this.state = state; this.options.events.onStateChange({ target: this, data: state }); }
    error() { this.options.events.onError({ target: this, data: 100 }); }
    getPlayerState() { return this.state; }
    getCurrentTime() { return this.time; }
    getDuration() { return 120; }
    getIframe() { return this.frame; }
    setVolume() {}
    playVideo() { this.plays++; this.transition(PlayerState.PLAYING); }
    pauseVideo() { this.transition(PlayerState.PAUSED); }
    seekTo(time) { this.time = time; this.seeks.push(time); }
    stopVideo() { this.transition(PlayerState.ENDED); }
    destroy() { this.destroyed = true; this.frame.remove(); }
  }
  Object.defineProperty(window, 'YT', { configurable: true, writable: true, value: { Player: FixturePlayer, PlayerState } });
  const videos = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((videoId, index) => ({
    id: 'youtube-' + videoId, videoId, isYouTube: true, title: 'Retained fixture ' + (index + 1),
    artist: 'YouTube Music', img: '/src/assets/brand-logo.webp', url: '',
  }));
  const audioIndex = state.songs.findIndex((song) => song.isLocal && song.url?.startsWith('blob:'));
  const audioId = state.songs[audioIndex].id;
  state.songs.push(...videos);
  for (const song of [state.songs[audioIndex], ...videos]) lyrics.lyricsCache.set(lyrics.getTrackKey(song.title, song.artist), structuredClone(sampleLyrics));
  const controls = ['artInfoBtn', 'artLikeBtn', 'artShareBtn'].map($);
  const tools = $('fullPlayerArt').querySelector('.ytm-art-overlay-tools');
  const assertTools = (mode) => {
    check($('fullPlayerArt').querySelector('.ytm-art-overlay-tools') === tools && controls.every((node) => $(node.id) === node), mode + ' retains the original artwork controls and their nodes');
    const before = intent.getPlaybackIntent();
    const song = state.songs[state.currentIndex];
    controls[0].click();
    check(queue.trackSheetSongId === song.id && $('trackSheetOverlay').classList.contains('active'), mode + ' Info opens the current track menu');
    queue.closeTrackMenu();
    const sharesBefore = shares.length;
    controls[2].click();
    check(song.isLocal ? shares.length === sharesBefore && $('toastContainer').textContent.includes('Local files stay on this device. Download the audio to share the file.')
      : shares.length === sharesBefore + 1 && shares.at(-1)?.url === (song.isYouTube ? 'https://youtu.be/' + song.videoId : song.hfUrl || song.url),
      mode + ' Share preserves attribution without exposing device-local audio');
    const favorite = song.favorite;
    controls[1].click();
    check(song.favorite === !favorite && intent.getPlaybackIntent() === before, mode + ' original inline Like listener works without toggling playback');
    controls[1].click();
  };
  async function startVideo(video = videos[0]) {
    await player.playYouTubeInsideAura(video.videoId, video.title, video.img);
    const yt = instances[instances.length - 1]; yt.ready(); return yt;
  }
  try {
    auraSettings.autoplayNext = true; state.repeatMode = 'off'; state.isShuffle = false;
    const bootIntent = intent.getPlaybackIntent();
    player.loadSong(audioIndex);
    check(intent.getPlaybackIntent() === bootIntent && state.audio.paused, 'passive source preparation preserves pending-link intent and does not autoplay');
    state.audio.muted = true;
    player.playSong(audioIndex);
    await state.audio.play();
    await until(() => state.audio.readyState >= 1 && state.audio.duration > 30, 'native local audio');
    state.audio.currentTime = 25;
    player.togglePlay();
    player.openPlayerSheet('lyrics');
    lyrics.renderLyrics(sampleLyrics);
    check(activeLine() === '2' && state.audio.paused, 'paused native audio renders its current lyric rather than the intro');
    check($('fullPlayerLyricsContainer').querySelector('.bl-instrumental')?.dataset.idx === '-1', 'the rendered intro has its own lyric index');
    const playsBeforeSeek = nativePlays.length;
    $('fullPlayerLyricsContainer').querySelector('[data-idx="1"]').click();
    await frame();
    check(Math.abs(state.audio.currentTime - 12) < 0.01 && state.audio.paused && nativePlays.length === playsBeforeSeek, 'a real lyric DOM click seeks paused native media without starting it');
    state.audio.currentTime = 0;
    await until(() => activeLine() === '-1', 'native lyric rewind to zero').catch((error) => {
      throw new Error(error.message + '; ' + JSON.stringify({
        time: player.getActivePlaybackTime(), paused: state.audio.paused,
        intro: $('fullPlayerLyricsContainer').querySelector('.bl-instrumental')?.className,
        active: activeLine(), sheet: $('upNextSheet').className,
        panelDisplay: getComputedStyle($('ytmLyricsPanel')).display,
        containerVisible: $('fullPlayerLyricsContainer').offsetParent !== null,
        overlay: $('fullPlayerOverlay').className,
      }));
    });
    check($('fullPlayerLyricsContainer').querySelectorAll('.bl-lyric-line.active').length === 1 &&
      $('fullPlayerLyricsContainer').querySelector('.bl-instrumental.active:not(.passed)') &&
      $('fullPlayerLyricsContainer').querySelector('[data-idx="0"]').classList.contains('first-upcoming') &&
      state.audio.currentTime === 0 && state.audio.paused && nativePlays.length === playsBeforeSeek,
    'the visible lyric synchronization loop processes paused time zero and restores only the intro');
    player.closePlayerSheet();
    assertTools('Image mode');

    const related = {
      ...state.songs[audioIndex], id: 'fixture:related-"<&', title: 'Encore "A" <live> & again',
      artist: state.songs[audioIndex].artist + ' "duo" <live> & guests',
    };
    const unavailableRelated = { ...related, id: 'fixture:related-unavailable', title: 'Unavailable companion', missing: true };
    state.songs.push(related, unavailableRelated);
    try {
      player.openPlayerSheet('related');
      const relatedList = $('ytmRelatedList');
      const rows = [...relatedList.querySelectorAll('.ytm-rel-row')];
      const row = rows.find((node) => node.dataset.relatedId === related.id);
      const unavailableRow = rows.find((node) => node.dataset.relatedId === unavailableRelated.id);
      check(row instanceof HTMLButtonElement && row.type === 'button' && row.tabIndex === 0 && !row.disabled &&
        rows.every((node) => node instanceof HTMLButtonElement && !node.querySelector('button, a, input, select, textarea, [role="button"], [tabindex]')),
      'related tracks each expose one native play button with no nested interactive controls');
      check(row.getAttribute('aria-label') === `Play ${related.title} by ${related.artist}` &&
        row.querySelector('.ytm-rel-row-title').textContent === related.title && row.querySelector('.ytm-rel-row-sub').textContent === related.artist,
      'related-track names and metadata preserve quotes, angle brackets and ampersands as text');
      check(!row.querySelector('div, live') && row.querySelector('.ytm-rel-row-meta').tagName === 'SPAN' &&
        row.querySelector('.ytm-rel-row-play').matches('span[aria-hidden="true"]'),
      'related buttons use valid span content and a decorative play icon');
      const titleBox = row.querySelector('.ytm-rel-row-title').getBoundingClientRect();
      const artistBox = row.querySelector('.ytm-rel-row-sub').getBoundingClientRect();
      check(row.getBoundingClientRect().height >= 64 && row.querySelector('img').getBoundingClientRect().width === 44 &&
        getComputedStyle(row).gap === '12px' && artistBox.top >= titleBox.bottom && row.scrollWidth <= row.clientWidth,
      'native related buttons retain cover size, row spacing and stacked truncated metadata without overflow');
      const beforeUnavailable = intent.getPlaybackIntent();
      unavailableRow.click();
      check(unavailableRow.disabled && intent.getPlaybackIntent() === beforeUnavailable,
        'an unavailable related track is disabled and cannot request playback');

      // Keep the rendered row while the library order changes: activation must
      // resolve its stable ID rather than reuse the old numeric index.
      state.songs.splice(state.songs.indexOf(related), 1);
      state.songs.unshift(related);
      state.currentIndex = state.songs.findIndex((song) => song.id === audioId);
      row.click();
      check(state.songs[state.currentIndex]?.id === related.id && intent.getPlaybackIntent() === beforeUnavailable + 1,
        'activating a related row after library reordering plays that exact track once');
      await state.audio.play();
      player.playSong(state.songs.findIndex((song) => song.id === audioId));
      await state.audio.play();
      player.togglePlay();
      await frame();
      state.songs.splice(state.songs.indexOf(related), 1);
      state.currentIndex = state.songs.findIndex((song) => song.id === audioId);
      const beforeRemoval = intent.getPlaybackIntent();
      row.click();
      check(row.isConnected && row.disabled && intent.getPlaybackIntent() === beforeRemoval &&
        state.songs[state.currentIndex]?.id === audioId && state.audio.paused,
      'a removed related track disables its stale row without falling back to track zero or another index');
    } finally {
      state.songs = state.songs.filter((song) => song.id !== related.id && song.id !== unavailableRelated.id);
      state.currentIndex = state.songs.findIndex((song) => song.id === audioId);
      player.closePlayerSheet();
    }

    state.audio.currentTime = 77;
    const nativePosition = state.audio.currentTime;
    const nativeCount = nativePlays.length;
    const yt = await startVideo();
    yt.time = 17;
    player.openPlayerSheet('lyrics');
    lyrics.renderLyrics(sampleLyrics);
    check(activeLine() === '1' && player.getActivePlaybackTime() === 17, 'YouTube lyrics ignore the previously loaded native playhead');
    $('fullPlayerLyricsContainer').querySelector('[data-idx="2"]').click();
    check(yt.seeks[yt.seeks.length - 1] === 24 && state.audio.currentTime === nativePosition && state.audio.paused, 'a real YouTube lyric DOM click calls the iframe seek API only');
    yt.pauseVideo();
    const ytPlays = yt.plays;
    $('fullPlayerLyricsContainer').querySelector('[data-idx="1"]').click();
    check(yt.time === 12 && yt.plays === ytPlays && !state.isPlaying, 'paused YouTube lyric seeking preserves pause state');
    yt.time = 0;
    await until(() => activeLine() === '-1', 'YouTube lyric rewind to zero');
    yt.time = 4.8;
    lyrics.setSyncOffset(0.4);
    check(activeLine() === '0', 'offset adjustment reads the YouTube clock');
    lyrics.resetSyncOffset();
    check(activeLine() === '-1' && nativePlays.length === nativeCount, 'offset reset and zero-time synchronization never start stale native audio');
    player.closePlayerSheet();
    assertTools('YouTube mode');

    const art = $('fullPlayerArt');
    const pointer = (node, type, extra = {}) => node.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 7, isPrimary: true, button: 0, clientX: 20, clientY: 20, ...extra,
    }));
    const gestureIntent = intent.getPlaybackIntent();
    pointer(controls[0].querySelector('i'), 'pointerdown'); pointer(art, 'pointerup', { clientX: 21 });
    pointer(art, 'pointerdown'); pointer(controls[2].querySelector('i'), 'pointerup');
    pointer(art, 'pointerdown'); pointer(art, 'pointercancel'); pointer(art, 'pointerup');
    pointer(art, 'pointerdown'); pointer(art, 'pointermove', { clientX: 60 }); pointer(art, 'pointerup');
    pointer(art, 'pointerup');
    check(intent.getPlaybackIntent() === gestureIntent && !state.isPlaying, 'control-origin/control-ending, canceled, dragged and orphaned pointer gestures cannot toggle artwork playback');
    pointer(art, 'pointerdown'); pointer(art, 'pointerup');
    check(intent.getPlaybackIntent() > gestureIntent && state.isPlaying, 'an ordinary artwork pointer tap still controls the selected source');

    queue.playTrackSequence(videos.map((video) => video.id));
    await until(() => player.auraYTPlayer?.options.videoId === videos[0].videoId, 'first retained video');
    let active = player.auraYTPlayer; active.ready();
    active.transition(PlayerState.ENDED); active.transition(PlayerState.ENDED);
    await until(() => state.songs[state.currentIndex]?.id === videos[1].id && player.auraYTPlayer, 'retained video B autoplay');
    check(queue.manualQueue.join(',') === videos[2].id, 'duplicate YouTube ENDED advances the shared playlist queue exactly once');
    active = player.auraYTPlayer; active.ready(); active.transition(PlayerState.ENDED);
    await until(() => state.songs[state.currentIndex]?.id === videos[2].id && player.auraYTPlayer, 'retained video C autoplay');
    check(queue.manualQueue.length === 0, 'retained A → B → C autoplays with the library-only Search queue');

    queue.playTrackSequence(videos.map((video) => video.id));
    await until(() => player.auraYTPlayer?.options.videoId === videos[0].videoId, 'stale-end fixture');
    const retired = player.auraYTPlayer; retired.ready(); retired.transition(PlayerState.ENDED);
    player.playSong(state.songs.findIndex((song) => song.id === audioId));
    await state.audio.play();
    const selectedIntent = intent.getPlaybackIntent();
    retired.ready(); retired.transition(PlayerState.PAUSED); retired.transition(PlayerState.PLAYING); retired.transition(PlayerState.ENDED); retired.error();
    const deadline = performance.now() + 350;
    await until(() => performance.now() >= deadline, 'retired end callback window');
    check(state.songs[state.currentIndex]?.id === audioId && intent.getPlaybackIntent() === selectedIntent && !state.audio.paused && state.isPlaying, 'late iframe ready/state/error/end callbacks cannot override a newer native selection');
    check(queue.manualQueue.join(',') === videos.slice(1).map((video) => video.id).join(','), 'a stale end cannot consume the remaining queue');
    assertTools('Restored image mode');

    await player.playYouTubeInsideAura(videos[0].videoId, videos[0].title, videos[0].img);
    const loading = player.auraYTPlayer;
    player.togglePlay(); loading.ready();
    check(loading.plays === 0 && !state.isPlaying && state.audio.paused, 'Pause while the iframe is loading cancels pending autoplay');
    player.togglePlay();
    check(loading.plays === 1 && state.isPlaying, 'resuming the same iframe keeps its real event handlers active');
    player.closeYouTubePlayer();
    loading.ready(); loading.transition(PlayerState.PLAYING);
    check(!player.auraYTPlayer && !state.isPlaying && $('fullImg') && controls.every((node) => $(node.id) === node), 'explicit YouTube close restores image controls and rejects late iframe events');

    const radioRetired = await startVideo();
    radio.radioAudio.muted = true;
    radio.playRadioStation({ name: 'Local playback fixture', url: location.origin + '/__fixture_audio.wav' });
    await until(() => !radio.radioAudio.paused && state.radioIsPlaying, 'local radio fixture');
    radioRetired.ready(); radioRetired.transition(PlayerState.ENDED);
    check(radio.currentRadioStation?.name === 'Local playback fixture' && player.getActivePlaybackTime() === 0 && !player.seekActivePlayback(12), 'radio source ownership rejects stale music lyrics and iframe callbacks');
    check(!document.querySelector('script[src*="youtube.com/iframe_api"]'), 'the browser regression needs no external YouTube API or video requests');
    check(fixture.errors.length === errorsBefore, 'playback regressions finish without uncaught browser errors');
    return { passed: passed.length, checks: passed };
  } finally {
    player.closeYouTubePlayer();
    radio.stopRadio();
    state.audio.pause();
    state.audio.removeEventListener('play', onPlay);
    state.songs = originalSongs;
    state.currentIndex = state.songs.findIndex((song) => song.id === audioId);
    state.isPlaying = false;
    queue.promoteVisibleOrder(originalQueue);
    auraSettings.autoplayNext = originalSettings.autoplayNext;
    state.repeatMode = originalSettings.repeatMode; state.isShuffle = originalSettings.isShuffle;
    if (originalYT) Object.defineProperty(window, 'YT', originalYT); else delete window.YT;
    if (originalShare) Object.defineProperty(navigator, 'share', originalShare); else delete navigator.share;
    player.closePlayerSheet(); player.updatePlayState();
  }
}
