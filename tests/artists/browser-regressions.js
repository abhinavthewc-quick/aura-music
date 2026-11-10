/* Run in the dedicated local fixture only:
   (await import('/tests/artists/browser-regressions.js')).runBrowserRegressions()
   These checks exercise the shipped modules, DOM and a real local audio blob. */
const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}
async function settleTransition(element) {
  await flush();
  await Promise.all(element.getAnimations().map((animation) => animation.finished));
  await flush();
}

export async function runBrowserRegressions() {
  const fixture = window.__auraFixture;
  if (!fixture || location.hostname !== '127.0.0.1') throw new Error('Use the dedicated local Aura fixture.');
  const results = [];
  const check = (value, label) => {
    if (!value) throw new Error(label);
    results.push(label);
  };
  const text = (selector) => document.querySelector(selector)?.textContent.trim();
  const catalog = await import('/src/core/catalog.ts');
  if (fixture.page === 'admin') {
    await until(() => document.querySelector('[data-artist-edit="New Artist"]'), 'initial admin artists');
    document.querySelector('[data-panel="panelArtists"]').click();
    await flush();
    document.querySelector('[data-artist-edit="New Artist"]').click();
    const nameInput = document.getElementById('aemName');
    const bioInput = document.getElementById('aemBio');
    nameInput.value = 'Unsaved draft';
    bioInput.value = 'Keep my edits';
    const portrait = document.getElementById('aemAvatarImg').getAttribute('src');
    await fixture.publish(fixture.cloud(2, 'Other tab Artist', '/api/artist-image?id=two.jpg'));
    check(Boolean(document.querySelector('[data-artist-edit="Other tab Artist"]')), 'admin list receives cloud changes while open');
    check(nameInput.value === 'Unsaved draft' && bioInput.value === 'Keep my edits', 'refresh leaves draft fields intact');
    check(document.getElementById('aemAvatarImg').getAttribute('src') === portrait, 'refresh leaves draft portrait intact');
    document.getElementById('aemSaveBtn').click();
    await until(() => text('#aemStatus')?.includes('another tab'), 'stale editor rejection');
    check(fixture.requests.filter((request) => request.action === 'artistSet').at(-1).version === 1, 'stale save sends captured version, not latest version');
    check(!document.getElementById('modalHost').hidden && !document.getElementById('aemSaveBtn').disabled, 'conflict keeps the editor and draft usable');
    check(fixture.directory.artists['old artist'].name === 'Other tab Artist', 'stale draft cannot overwrite the winning profile');

    const currentFetch = window.fetch;
    window.fetch = async (input, init) => {
      const response = await currentFetch(input, init);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action !== 'library') return response;
      return Response.json({ ...(await response.json()), ...fixture.cloud(1, 'Late library response') });
    };
    try {
      document.getElementById('artistsRefreshBtn').click();
      await flush();
      check(Boolean(document.querySelector('[data-artist-edit="Other tab Artist"]')), 'late library responses cannot downgrade admin profiles');
    } finally { window.fetch = currentFetch; }

    document.getElementById('aemCancelBtn').click();
    document.querySelector('[data-artist-edit="Other tab Artist"]').click();
    document.getElementById('aemClearPicBtn').click();
    document.getElementById('aemSaveBtn').click();
    await until(() => document.getElementById('modalHost').hidden, 'portrait removal save');
    check(fixture.directory.artists['old artist'].version === 3 && fixture.directory.artists['old artist'].img === '', 'reopened editor removes only the profile portrait reference');

    document.querySelector('[data-artist-edit="Other tab Artist"]').click();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2XcAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], 'fixture.png', { type: 'image/png' }));
    document.getElementById('aemFileInput').files = transfer.files;
    document.getElementById('aemFileInput').dispatchEvent(new Event('change'));
    await until(() => document.getElementById('aemAvatarImg')?.getAttribute('src').startsWith('data:image/png'), 'upload preview');
    document.getElementById('aemSaveBtn').click();
    await until(() => document.getElementById('modalHost').hidden, 'portrait upload save');
    const savedPortrait = fixture.directory.artists['old artist'].img;
    check(savedPortrait.startsWith('/api/artist-image?id=upload-'), 'upload response replaces preview data with immutable image URL');
    document.querySelector('[data-artist-edit="Other tab Artist"]').click();
    check(document.getElementById('aemAvatarImg').getAttribute('src') === savedPortrait, 'saved portrait survives editor reopening');
    document.getElementById('aemBio').value = 'Updated biography';
    document.getElementById('aemSaveBtn').click();
    await until(() => document.getElementById('modalHost').hidden, 'biography save');
    check(fixture.requests.filter((request) => request.action === 'artistSet').at(-1).img === savedPortrait, 'metadata-only saves reuse the existing portrait');
    check(fixture.directory.artists['old artist'].version === 5, 'reopened saves use the newly captured profile version');
    document.querySelector('[data-artist-edit="Other tab Artist"]').click();
    const oversized = new DataTransfer();
    oversized.items.add(new File([new Uint8Array(1572865)], 'large.png', { type: 'image/png' }));
    document.getElementById('aemFileInput').files = oversized.files;
    document.getElementById('aemFileInput').dispatchEvent(new Event('change'));
    check(text('#aemStatus').includes('too large'), 'admin rejects oversized portraits before sending');
    check(document.getElementById('aemAvatarImg').getAttribute('src') === savedPortrait, 'invalid upload leaves the current portrait unchanged');
    document.getElementById('aemCancelBtn').click();
    check(!fixture.requests.some((request) => ['dispatch', 'bucketUpload', 'setSecret'].includes(request.action)), 'browser checks never submit downloads or change integrations');
  } else {
    const { state, trackKey } = await import('/src/core/state.ts');
    const home = await import('/src/features/home.ts');
    const library = await import('/src/features/library.ts');
    const playlists = await import('/src/features/playlists.ts');
    const player = await import('/src/features/player.ts');
    const { goTab } = await import('/src/ui/nav.ts');
    await until(() => !document.getElementById('auraLoader'), 'intro loader dismissal', 10000);
    await until(() => !state.catalogLoading && state.songs.some((song) => song.isLocal && song.url?.startsWith('blob:')), 'catalog and IndexedDB hydration');
    check(catalog.getCachedArtistDirectory().revision === 0, 'artist pages start before cloud profiles load');
    const handUpload = state.songs.find((song) => song.title === 'Hand upload');
    const localTrack = state.songs.find((song) => song.isLocal);
    check(!localTrack.missing, 'local audio is restored from IndexedDB');
    home.openArtistDetail('Old Artist', false);
    library.setLibView('artists');
    library.openArtist(library.getArtistGroups().findIndex((group) => group.name === 'Old Artist'));
    check(text('.artist-hero-name') === 'Old Artist' && text('.artist-page-name') === 'Old Artist', 'Home and Library can open the same uncached artist');

    state.audio.muted = true;
    player.playSong(state.songs.indexOf(handUpload));
    await state.audio.play();
    state.audio.currentTime = 41;
    state.audio.playbackRate = 1.25;
    await flush();
    document.getElementById('miniExpandBtn').click();
    const fullPlayer = document.getElementById('fullPlayerOverlay');
    await settleTransition(fullPlayer);
    const desktop = matchMedia('(min-width:900px)').matches;
    const transportButton = document.getElementById(desktop ? 'playPauseBtn' : 'fullPlayBtn');
    const rect = transportButton.getBoundingClientRect();
    check((desktop || getComputedStyle(document.getElementById('miniPlayer')).display === 'none') && transportButton.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), 'full player keeps playback controls unobstructed');
    document.getElementById('closeFullPlayerBtn').click();
    await settleTransition(fullPlayer);
    check(!state.audio.paused && getComputedStyle(document.getElementById('miniPlayer')).display === 'flex', 'minimizing the full player restores the strip without pausing audio');
    const playback = { src: state.audio.getAttribute('src'), time: state.audio.currentTime, rate: state.audio.playbackRate, id: handUpload.id };
    let resets = 0;
    const onReset = () => resets++;
    for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.addEventListener(event, onReset);
    try {
      await fixture.publish({ ...fixture.cloud(1), trackArtists: {} });
      check(text('.artist-hero-name') === 'New Artist' && text('.artist-page-name') === 'New Artist', 'first cloud load preserves both open artist pages');
      check(document.querySelectorAll('#artistSongsList .artist-song-row').length === 2 && document.querySelectorAll('.artist-page .song-item').length === 2, 'profile-only rename keeps both tracks on the open pages');
      check(text('#artistHeroCard .artist-bio') === text('.artist-page .artist-bio'), 'Home and Library share biography details');
      await fixture.publish(fixture.cloud(2, 'Renamed Artist', '/api/artist-image?id=two.jpg'));
      check(text('.artist-hero-name') === 'Renamed Artist' && text('.artist-page-name') === 'Renamed Artist', 'track rename preserves the selected artist through aliases');
      check(document.querySelector('.artist-hero-img').getAttribute('src') === '/api/artist-image?id=two.jpg' && document.querySelector('.artist-page-avatar').getAttribute('src') === '/api/artist-image?id=two.jpg', 'portrait replacement updates both open artist pages');
      check(document.getElementById('artistSpotlightContainer').textContent.includes('Renamed Artist'), 'Home spotlight receives profile changes too');
      const variant = library.getArtistGroups().find((group) => group.name === 'Anirudh Ravichander');
      check(variant.songs.length === 2 && variant.cover === '/api/artist-image?id=anirudh.jpg', 'managed spelling variants share one portrait and track group');
      check(trackKey(state.songs.find((song) => song.id === handUpload.id)) === 'lk:hand upload|old artist', 'no-ID tracks retain their legacy playlist identity');
      check(text('#currentArtist') === 'Renamed Artist' && text('#fullArtist') === 'Renamed Artist', 'player attribution updates without changing tracks');
      check(!navigator.mediaSession || navigator.mediaSession.metadata.artist === 'Renamed Artist', 'media-session attribution follows artist corrections');
      check(!catalog.cacheArtistDirectory(fixture.cloud(1, 'Stale Artist')), 'late snapshots are rejected');

      const originalFetch = window.fetch;
      let finish;
      let requests = 0;
      window.fetch = (input, init) => String(typeof input === 'string' ? input : input.url).includes('/api/artists')
        ? (requests++, new Promise((resolve) => { finish = resolve; })) : originalFetch(input, init);
      try {
        const first = catalog.fetchArtistDirectory();
        const second = catalog.fetchArtistDirectory();
        check(first === second && requests === 1, 'overlapping browser refreshes share a single request');
        await fixture.publish(fixture.cloud(4, 'Latest Artist'));
        finish(Response.json(fixture.cloud(3, 'Late response')));
        check((await first).revision === 4, 'in-flight older refresh cannot overwrite a newer edit');
      } finally { window.fetch = originalFetch; }

      fixture.directory = fixture.cloud(5, 'Cross-tab Artist');
      localStorage.setItem(catalog.CLOUD_ARTISTS_CACHE_KEY, JSON.stringify(fixture.directory));
      window.dispatchEvent(new StorageEvent('storage', { key: catalog.CLOUD_ARTISTS_CACHE_KEY, storageArea: localStorage }));
      await flush();
      check(text('.artist-page-name') === 'Cross-tab Artist' && text('.artist-hero-name') === 'Cross-tab Artist', 'cross-tab cache updates preserve both selections');
      check(resets === 0 && !state.audio.paused && state.isPlaying && state.audio.getAttribute('src') === playback.src && state.audio.playbackRate === playback.rate && state.songs[state.currentIndex].id === playback.id && state.audio.currentTime >= playback.time && state.audio.currentTime < playback.time + 3, 'artist refresh never reloads, pauses or seeks active audio');
    } finally {
      for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.removeEventListener(event, onReset);
    }

    home.openArtistDetail('Old Artist', false);
    check(text('.artist-hero-name') === 'Cross-tab Artist', 'old readable names still open the renamed profile');
    playlists.openPlaylistPage('fixture-playlist');
    check(document.querySelectorAll('#tabPlaylist [data-play-index]').length === 3, 'existing playlist resolves no-ID, video-ID and local entries');
    check(document.getElementById('tabPlaylist').textContent.includes('Cross-tab Artist'), 'open playlist displays corrected artist names');
    await fixture.publish(fixture.cloud(6, 'Playlist Artist'));
    check(document.getElementById('tabPlaylist').textContent.includes('Playlist Artist'), 'open playlist repaints during metadata refresh');
    check(localStorage.getItem('auraPlaylists') === fixture.playlist, 'metadata refresh leaves playlist storage byte-for-byte unchanged');
    const { resolveTrack } = await import('/src/rooms/appTarget.ts');
    check(Boolean(resolveTrack('lk:hand upload|old artist')) && !resolveTrack('lk:on this device|local artist'), 'room resolution keeps catalog identity and excludes device-local files');
    player.playSong(state.songs.findIndex((song) => song.id === localTrack.id));
    await state.audio.play();
    state.audio.currentTime = 17;
    await flush();
    const localSrc = state.audio.getAttribute('src');
    await fixture.publish(fixture.cloud(7, 'Final Artist'));
    check(state.songs[state.currentIndex] === localTrack && state.audio.getAttribute('src') === localSrc && state.audio.currentTime >= 17 && !state.audio.paused, 'local-track playback survives cloud refresh unchanged');
    check(typeof window.playArtist === 'function', 'Library artist play handler is exposed');
    library.setLibView('artists');
    library.openArtist(library.getArtistGroups().findIndex((group) => group.key === 'profile:old artist'));
    document.querySelector('.artist-page-actions button').click();
    await state.audio.play();
    check(state.songs[state.currentIndex].artist === 'Final Artist', 'Library artist play button uses its current reconciled group');
    document.getElementById('closeFullPlayerBtn').click();
    goTab('tabSearch');
    document.getElementById('searchTabInput').value = 'Hand upload';
    (await import('/src/features/search.ts')).filterSearchTab();
    check(document.querySelectorAll('#searchResultsList .song-item').length === 1, 'public Search filters only the saved library');
    check(!fixture.requests.some((request) => request.action === 'search'), 'public search does not request external discovery');
    state.audio.pause();
    player.updatePlayState();
    home.closeArtistDetail();
    goTab('tabHome');
    home.showDefaultHomeView();
  }
  check(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)', 'black canvas ignores old light-theme preferences');
  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'page has no horizontal overflow');
  check(fixture.errors.length === 0, 'browser has no uncaught errors');
  fixture.testResults = results;
  return { page: fixture.page, passed: results.length, checks: results };
}
