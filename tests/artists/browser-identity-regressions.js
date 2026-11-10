/* Run after the shared regressions in the dedicated main-page local fixture:
   (await import('/tests/artists/browser-identity-regressions.js')).runArtistIdentityRegressions()
   No remote writes. Common/Home playback callbacks are observed. Queue checks
   restore the manual order and never activate its directly imported play action;
   artwork sharing is captured locally. Native key activation is audited centrally. */
export async function runArtistIdentityRegressions() {
  const fixture = window.__auraFixture;
  if (!fixture || fixture.page !== 'main' || location.hostname !== '127.0.0.1') throw new Error('Use the local main-page artist fixture.');
  const results = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const { state } = await import('/src/core/state.ts');
  const library = await import('/src/features/library.ts');
  const home = await import('/src/features/home.ts');
  const { goTab } = await import('/src/ui/nav.ts');
  const initialPlayback = { src: state.audio.getAttribute('src'), index: state.currentIndex, playing: state.isPlaying, rate: state.audio.playbackRate };
  const originalPlay = window.playSong, originalLike = window.toggleFavorite;
  const plays = [], likes = [];
  window.playSong = (...args) => plays.push(args);
  window.toggleFavorite = (...args) => likes.push(args);
  try {
    goTab('tabLibrary');
    library.setLibView('tracks');
    const row = document.querySelector('#librarySongList .song-item');
    check(!!row && !row.hasAttribute('role') && !row.hasAttribute('tabindex'), 'track row is a non-interactive container');
    const play = row.querySelector('.song-item-play');
    const like = row.querySelector('.song-item-like');
    const menu = row.querySelector('.song-item-menu-btn');
    check(play instanceof HTMLButtonElement && !!play.getAttribute('aria-label')?.startsWith('Play '), 'track play is a named native keyboard button');
    check(!play.querySelector('button, a, input, [tabindex]') && !play.contains(like) && !play.contains(menu), 'play, like and menu are sibling actions, never nested controls');
    play.focus();
    check(document.activeElement === play, 'track play participates in native focus navigation');
    play.click();
    check(plays.length === 1 && Number.isInteger(plays[0][0]) && !!state.songs[plays[0][0]], 'native play invokes one valid playback action');
    like.click();
    check(likes.length === 1 && plays.length === 1, 'liking a row cannot bubble into playback');
    menu.click();
    check(document.getElementById('trackSheetOverlay').classList.contains('active') && plays.length === 1, 'the existing row menu opens without starting a track');
    document.getElementById('trackSheetOverlay').click();

    const groups = library.getArtistGroups();
    home.renderArtistsFullGrid();
    const keys = [...document.querySelectorAll('#homeArtistsFullGrid [data-artist-open]')].map((card) => card.dataset.artistOpen);
    check(new Set(keys).size === keys.length && keys.length === groups.length, 'Home grid renders exactly one card per shared artist identity');
    check(JSON.stringify(home.getAllArtists().map((artist) => artist.key)) === JSON.stringify(groups.map((group) => group.key)), 'Home and Library use identical identities and ordering');
    library.renderStatsPanel();
    const artistStat = [...document.querySelectorAll('#statsPanel .stats-cell')].find((cell) => cell.querySelector('.stat-label')?.textContent === 'Artists');
    check(artistStat?.querySelector('.stat-num')?.textContent === String(groups.length), 'artist stats count the resolved directory rather than raw credits');

    goTab('tabHome');
    home.openArtistDetail(groups[0].key, false);
    const artistRow = document.querySelector('#artistSongsList .artist-song-row');
    check(artistRow instanceof HTMLButtonElement && !!artistRow.getAttribute('aria-label') && !artistRow.querySelector('button, a, [tabindex]'), 'Home artist tracks are single named native buttons');
    artistRow.click();
    check(plays.length === 2, 'Home artist row invokes playback exactly once');
    await checkUpNextControls(check, state);
    await checkArtworkActions(check, state);
    const audio = state.audio;
    check(audio.getAttribute('src') === initialPlayback.src && state.currentIndex === initialPlayback.index && state.isPlaying === initialPlayback.playing && audio.playbackRate === initialPlayback.rate, 'artist, queue and artwork controls leave playback state intact');
  } finally {
    window.playSong = originalPlay;
    window.toggleFavorite = originalLike;
    home.closeArtistDetail();
    goTab('tabHome');
  }
  return { passed: results.length, checks: results };
}

async function checkUpNextControls(check, state) {
  const queue = await import('/src/features/queue.ts');
  const originalQueue = [...queue.manualQueue];
  const originalFocus = document.activeElement;
  const scroll = { left: window.scrollX, top: window.scrollY };
  let host;
  let list = document.getElementById('upNextList');
  // The current Lyrics/Related page omits this legacy mount. Exercise the real
  // renderer in a temporary, visible fixture without changing the shipped page.
  if (!list) {
    host = document.createElement('section');
    host.setAttribute('aria-label', 'Up Next control fixture');
    list = document.createElement('div');
    list.id = 'upNextList';
    list.className = 'up-next-list';
    host.append(list);
    document.getElementById('tabHome').append(host);
  }
  const rows = () => [...list.querySelectorAll('.up-next-row')];
  const ids = () => rows().map((row) => row.dataset.upNextId);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const handleFor = (id) => rows().find((row) => row.dataset.upNextId === id)?.querySelector('.up-next-action.reorder');
  const arrow = (handle, key) => {
    handle.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    handle.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    queue.manualQueue.splice(0);
    queue.renderUpNext();
    const initialIds = ids();
    if (initialIds.length < 2) throw new Error('The queue regression needs at least two upcoming fixture tracks.');
    check(rows().every((row) => !row.hasAttribute('role') && !row.hasAttribute('tabindex')), 'Up Next rows retain their data selectors as non-interactive containers');
    check(rows().every((row) => {
      const play = row.querySelector('.up-next-play');
      const actions = row.querySelector('.up-next-actions');
      return play instanceof HTMLButtonElement && play.type === 'button' &&
        play.getAttribute('aria-label') === `Play ${play.querySelector('.up-next-song-title').textContent} by ${play.querySelector('.up-next-song-artist').textContent}` &&
        !play.querySelector('button, a, input, [tabindex]') && actions?.parentElement === play.parentElement &&
        actions.querySelectorAll('button.up-next-action').length === 2;
    }), 'each Up Next track has a named native play button and independent favorite/reorder actions');
    const help = document.getElementById('upNextReorderHelp');
    const status = document.getElementById('upNextReorderStatus');
    check(!help.hidden && help.getClientRects().length && /Arrow Up.*Arrow Down/.test(help.textContent) &&
      rows().every((row) => row.querySelector('.reorder').getAttribute('aria-describedby') === help.id &&
        row.querySelector('.reorder').getAttribute('aria-keyshortcuts') === 'ArrowUp ArrowDown'), 'reorder instructions are visible and described on every handle');

    const favorite = rows()[0].querySelector('.favorite');
    favorite.focus();
    queue.renderUpNext();
    check(document.activeElement === rows()[0].querySelector('.favorite'), 'row refresh retains focus on the same track favorite control');
    rows()[0].querySelector('.up-next-play').focus();
    queue.renderUpNext();
    check(document.activeElement === rows()[0].querySelector('.up-next-play'), 'row refresh retains focus on the same native play control');
    handleFor(initialIds[0]).click();
    check(queue.manualQueue.length === 0 && /Arrow Up.*Arrow Down/.test(status.textContent), 'activating a reorder handle gives keyboard instructions without queuing or playing');
    check(arrow(handleFor(initialIds[0]), 'ArrowUp') && same(ids(), initialIds) && queue.manualQueue.length === 0 &&
      document.activeElement === handleFor(initialIds[0]) && /already first/.test(status.textContent), 'ArrowUp at the first row keeps focus and order without promoting the rolling queue');
    check(arrow(handleFor(initialIds.at(-1)), 'ArrowDown') && same(ids(), initialIds) && queue.manualQueue.length === 0 &&
      document.activeElement === handleFor(initialIds.at(-1)) && /already last/.test(status.textContent), 'ArrowDown at the last row gives boundary feedback without wrapping or queuing');

    // A nonvisible manual tail (including the current track, if present) must
    // survive the same promotion operation used by pointer drag reordering.
    const seed = state.songs.map((song) => song.id).reverse();
    queue.manualQueue.push(...seed);
    queue.renderUpNext();
    const before = ids(), movedId = before[1];
    const remaining = seed.map(String).filter((id) => !before.includes(id));
    const moved = [before[1], before[0], ...before.slice(2)];
    check(arrow(handleFor(movedId), 'ArrowUp') && same(ids(), moved) &&
      same(queue.manualQueue.map(String), [...moved, ...remaining]), 'keyboard reorder moves one step and retains nonvisible manual queue membership');
    check(document.activeElement === handleFor(movedId) && /position 1 of/.test(document.activeElement.getAttribute('aria-label')) &&
      status.textContent.includes(`position 1 of ${before.length}`), 'the moved handle retains focus, its new position and live status feedback');
    check(arrow(handleFor(movedId), 'ArrowDown') && same(ids(), before) &&
      same(queue.manualQueue.map(String), [...before, ...remaining]) && document.activeElement === handleFor(movedId), 'consecutive ArrowDown follows the focused track through rerendering');
    check(document.getElementById('upNextReorderStatus') === status && status.getAttribute('role') === 'status' &&
      status.getAttribute('aria-live') === 'polite' && document.querySelectorAll('#upNextReorderHelp').length === 1 &&
      status.textContent.includes(`position 2 of ${before.length}`), 'one persistent live region reports the latest position across row refreshes');
  } finally {
    queue.manualQueue.splice(0, queue.manualQueue.length, ...originalQueue);
    if (host) host.remove(); else queue.renderUpNext();
    if (originalFocus instanceof HTMLElement && originalFocus.isConnected) originalFocus.focus({ preventScroll: true });
    window.scrollTo(scroll);
  }
}

async function checkArtworkActions(check, state) {
  const queue = await import('/src/features/queue.ts');
  const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share');
  const originalMenuId = queue.trackSheetSongId;
  const menu = document.getElementById('trackSheetOverlay');
  const menuWasOpen = menu.classList.contains('active');
  const shares = [];
  Object.defineProperty(navigator, 'share', { configurable: true, value: (data) => { shares.push(data); return Promise.resolve(); } });
  try {
    const song = state.songs[state.currentIndex];
    document.getElementById('artInfoBtn').click();
    if (song) {
      check(menu.classList.contains('active') && queue.trackSheetSongId === song.id, 'artwork Info opens the current track options through the existing menu');
      queue.closeTrackMenu();
    } else {
      check(menu.classList.contains('active') === menuWasOpen && queue.trackSheetSongId === originalMenuId, 'artwork Info keeps the missing-track guard');
    }
    document.getElementById('artShareBtn').click();
    const url = song?.isYouTube && song.videoId ? `https://youtu.be/${song.videoId}` : song?.url || undefined;
    check(song ? shares.length === 1 && shares[0].title === song.title && shares[0].text === `${song.title} — ${song.artist}` && shares[0].url === url : shares.length === 0,
      'artwork Share uses the existing current-track attribution and URL, or ignores a missing track');
    check(!menu.classList.contains('active') || menuWasOpen, 'artwork Share does not leave a track menu open');
  } finally {
    if (shareDescriptor) Object.defineProperty(navigator, 'share', shareDescriptor); else delete navigator.share;
    if (menuWasOpen) queue.openTrackMenu(null, originalMenuId); else queue.closeTrackMenu();
  }
}

/* Separate actual-playback regression for a dedicated main-page local fixture:
   (await import('/tests/artists/browser-identity-regressions.js')).runQueuePlaybackRegressions()
   Uses the fixture's real native audio and hydrated local blob. */
export async function runQueuePlaybackRegressions() {
  if (window.__auraFixture?.page !== 'main' || location.hostname !== '127.0.0.1') throw new Error('Use the local main-page artist fixture.');
  const { state, playCountMap, AURA_PLAY_COUNTS_KEY } = await import('/src/core/state.ts');
  const queue = await import('/src/features/queue.ts');
  const player = await import('/src/features/player.ts');
  const library = await import('/src/features/library.ts');
  if (player.auraYTVideoId || state.radioIsPlaying) throw new Error('Use a dedicated native-audio fixture.');
  const until = async (predicate, label) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('Timed out: ' + label);
      await new Promise(requestAnimationFrame);
    }
  };
  await until(() => !state.catalogLoading && state.songs.some((song) => song.isLocal && song.url?.startsWith('blob:')), 'local fixture hydration');
  const [a, d, b, c] = state.songs.filter((song) => !song.isLocal && !song.isYouTube && !song.missing && song.url);
  const local = state.songs.find((song) => song.isLocal && !song.missing && song.url?.startsWith('blob:'));
  if (!c || !local) throw new Error('Queue playback needs four catalogue tracks and one hydrated local track.');
  const audio = state.audio;
  const original = {
    songs: state.songs, index: state.currentIndex, queue: [...queue.manualQueue], shuffle: state.isShuffle,
    src: audio.getAttribute('src'), time: audio.currentTime, rate: audio.playbackRate, muted: audio.muted,
    preload: audio.preload, playing: !audio.paused, isPlaying: state.isPlaying, ytIndex: state.auraYTQueueIndex,
    recent: state.recentlyPlayed, counts: { ...playCountMap },
    mini: document.getElementById('miniPlayer').classList.contains('active'),
    full: document.getElementById('fullPlayerOverlay').classList.contains('active'),
    stored: new Map(['recentlyPlayed', AURA_PLAY_COUNTS_KEY].map((key) => [key, localStorage.getItem(key)])),
  };
  const results = [], played = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); results.push(label); };
  const waitForTrack = async (song) => {
    if (state.songs[state.currentIndex]?.id !== song.id) throw new Error(`Expected queued "${song.title}", selected "${state.songs[state.currentIndex]?.title}".`);
    await until(() => state.songs[state.currentIndex]?.id === song.id && state.isPlaying && !audio.paused &&
      audio.readyState >= 2 && audio.currentSrc === new URL(song.url, location.href).href, 'native playback of ' + song.title);
    played.push(song.id);
  };
  const missing = { ...local, id: 'fixture:queue-missing-local', missing: true, url: '' };
  const unhydrated = { ...local, id: 'fixture:queue-no-local-url', missing: false, url: '' };
  const removed = ['fixture:queue-deleted-one', 'fixture:queue-deleted-two'];
  try {
    audio.muted = true;
    state.isShuffle = false;
    // D is the ordinary library successor to A; the manual sequence must win.
    state.songs = [a, d, b, c, local, missing, unhydrated];
    queue.playTrackSequence([a.id, b.id, c.id, local.id]);
    await waitForTrack(a);
    state.songs = state.songs.filter((song) => song !== b);
    await queue.playNext();
    await waitForTrack(c);
    check(queue.manualQueue.length === 1 && queue.manualQueue[0] === local.id,
      'deleting queued B advances A directly to C, retaining the remaining manual sequence');
    check(state.songs[state.currentIndex] !== d, 'an unrelated library successor cannot take a deleted queue entry’s turn');
    await queue.playNext();
    await waitForTrack(local);
    check(queue.manualQueue.length === 0, 'a valid hydrated local track plays next and consumes exactly its queue entry');

    queue.playTrackSequence([a.id, c.id, local.id]);
    await waitForTrack(a);
    queue.manualQueue.unshift(...removed, missing.id, unhydrated.id);
    await queue.playNext();
    await waitForTrack(c);
    check(queue.manualQueue.length === 1 && queue.manualQueue[0] === local.id,
      'one advance drains consecutive deleted IDs, missing local files and local entries without a URL before playing C');
    await queue.playNext();
    await waitForTrack(local);
    check(queue.manualQueue.length === 0, 'valid queued entries retain their order after multiple unavailable entries');

    queue.playTrackSequence([a.id]);
    await waitForTrack(a);
    queue.manualQueue.push(...removed, missing.id, unhydrated.id);
    await queue.playNext();
    await waitForTrack(d);
    check(queue.manualQueue.length === 0, 'ordinary library fallback runs only after the unusable manual queue is fully drained');
  } finally {
    audio.pause();
    state.songs = original.songs;
    state.currentIndex = original.index;
    state.isShuffle = original.shuffle;
    state.auraYTQueueIndex = original.ytIndex;
    queue.manualQueue.splice(0, queue.manualQueue.length, ...original.queue);
    state.recentlyPlayed = original.recent;
    for (const key of Object.keys(playCountMap)) delete playCountMap[key];
    Object.assign(playCountMap, original.counts);
    for (const [key, value] of original.stored) {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    }
    const song = state.songs[state.currentIndex];
    if (song) {
      player.resetFullPlayerArtToImage(song.img || '');
      player.loadSong(state.currentIndex);
    }
    if (original.src === null) {
      audio.removeAttribute('src');
      audio.onerror = null;
      audio.load();
    } else {
      if (audio.getAttribute('src') !== original.src) { audio.setAttribute('src', original.src); audio.load(); }
      if (original.time > 0) {
        audio.preload = 'metadata';
        await until(() => audio.readyState >= 1, 'restore the original fixture playback position');
        audio.currentTime = original.time;
      }
    }
    audio.preload = original.preload;
    audio.playbackRate = original.rate;
    audio.muted = original.muted;
    if (original.playing && original.src) await audio.play();
    state.isPlaying = original.isPlaying;
    player.updatePlayState();
    document.getElementById('miniPlayer').classList.toggle('active', original.mini);
    document.getElementById('fullPlayerOverlay').classList.toggle('active', original.full);
    queue.renderUpNext();
    library.renderRecent();
  }
  return { passed: results.length, checks: results, played };
}
