/* Fresh local fixture only: ?artist-page. Real shipped artist DOM and audio;
   the six catalogue pairs, provider metadata and all remote writes stay local. */
const flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const longBio = 'A performer and songwriter whose recordings are kept in this isolated music catalogue. '.repeat(18).trim();
async function setup() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'main' || !new URLSearchParams(location.search).has('artist-page')) {
    throw new Error('Use a fresh local main ?artist-page fixture.');
  }
  const { state, trackKey, savedLikeMap } = await import('/src/core/state.ts');
  const home = await import('/src/features/home.ts');
  const library = await import('/src/features/library.ts');
  const queue = await import('/src/features/queue.ts');
  const player = await import('/src/features/player.ts');
  const { goTab } = await import('/src/ui/nav.ts');
  await until(() => document.getElementById('musicApp') && !document.getElementById('musicApp').hidden && !state.catalogLoading &&
    state.hfSongs.length && state.hfSongs.every(song => song.hfUrl) &&
    state.songs.some(song => song.isLocal && song.url?.startsWith('blob:')), 'signed-in fixture and local audio hydration');
  await (await import('/src/app.ts')).ready;
  await flush(); // Allow the deferred metadata storage listener to start.
  const checks = [], check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  return { fixture, state, trackKey, savedLikeMap, home, library, queue, player, goTab, checks, check };
}

export async function runArtistPageRegressions() {
  const { fixture, state, trackKey, home, library, goTab, checks, check } = await setup();
  const original = {
    members: [...state.songs], tracks: JSON.stringify(state.songs), keys: state.songs.map(trackKey),
    playlists: localStorage.getItem('auraPlaylists'), added: localStorage.getItem('addedTracks'),
    src: state.audio.getAttribute('src'), index: state.currentIndex, playing: state.isPlaying,
  };
  const originalPlay = window.playTrackSequence, sequences = [];
  window.playTrackSequence = (...args) => { sequences.push(args); return true; };
  try {
    home.renderFeaturedArtistsShelf();
    home.renderArtistSpotlight();
    home.openHomeArtistsTab();
    const groups = library.getArtistGroups();
    check(same(groups.map(group => group.key), home.getAllArtists().map(artist => artist.key)), 'all Home and Library entry points use the same reviewed artist identities');
    for (const [name, channel, total] of fixture.vevoPairs) {
      const group = groups.find(artist => artist.name === name);
      check(group?.songs.length === total && !groups.some(artist => artist.name === channel), name + ' has one merged group and all ' + total + ' recordings');
      const card = [...document.querySelectorAll('#homeArtistsFullGrid [data-artist-open]')].filter(card => card.dataset.artistOpen === group.key);
      check(card.length === 1 && card[0].querySelector('.ytm-artist-name').textContent === name &&
        card[0].querySelector('.ytm-artist-sub').textContent === total + ' songs', name + ' has one correctly counted Home artist card');
      const shelf = [...document.querySelectorAll('#homeFeaturedArtistsShelf [data-artist-open]')].find(card => card.dataset.artistOpen === group.key);
      check(shelf?.querySelector('.ytm-artist-sub').textContent === total + ' songs', name + ' is merged in the featured shelf');
      const spotlights = [...document.querySelectorAll('.artist-spotlight-block')].filter(block => block.querySelector('.spotlight-header p:last-child').textContent === name);
      check(spotlights.length === 1 && spotlights[0].querySelectorAll('.spotlight-card').length === total, name + ' keeps every recording in one spotlight');

      goTab('tabHome'); home.openArtistDetail(channel, false);
      check(document.getElementById('artistName').textContent === name && document.querySelectorAll('#artistSongsList .artist-song-row').length === total,
        name + ' opens from its old VEVO label without dropping tracks');
      document.getElementById('artistPlayAllBtn').click();
      document.getElementById('artistShuffleBtn').click();
      const row = document.querySelector('#artistSongsList .artist-song-row'); row.click();
      const calls = sequences.slice(-3);
      check(calls.every(([ids, options]) => same(ids, group.songs.map(song => song.id)) && options.source === 'artist' && options.collectionId === group.key) &&
        calls[0][1].shuffle === false && calls[1][1].shuffle === true && calls[2][1].startId === row.dataset.artistTrackId,
        name + ' Play all, Shuffle and row controls retain original IDs through the artist transport boundary');

      goTab('tabLibrary'); library.setLibView('artists');
      const tiles = [...document.querySelectorAll('#librarySongList .artist-tile')].filter(tile => tile.dataset.artistKey === group.key);
      check(tiles.length === 1 && tiles[0].querySelector('.artist-name').textContent === name, name + ' has one canonical Library tile');
      tiles[0].click();
      check(document.getElementById('libraryArtistName').textContent === name &&
        document.querySelectorAll('#libraryArtistSongsList .artist-song-item').length === total, name + ' shares the same complete Library artist page');
      const libraryRow = document.querySelector('#libraryArtistSongsList .artist-song-row');
      check(libraryRow instanceof HTMLButtonElement && !libraryRow.querySelector('button, a, [tabindex]') &&
        libraryRow.parentElement.querySelectorAll('.artist-song-actions button').length === 2,
        name + ' Library playback, favorite and menu are independent named native buttons');
    }
    check(![...document.querySelectorAll('.ytm-artist-name, .artist-name')].some(element => /VEVO/.test(element.textContent)), 'no separate VEVO artist cards remain in Home or Library');
    library.renderStatsPanel();
    const stat = [...document.querySelectorAll('#statsPanel .stats-cell')].find(cell => cell.querySelector('.stat-label')?.textContent === 'Artists');
    check(stat?.querySelector('.stat-num').textContent === String(groups.length), 'artist statistics count merged identities without reducing library recordings');
    check(same(state.songs.map(trackKey), original.keys) && state.songs.every((song, index) => song === original.members[index]) && JSON.stringify(state.songs) === original.tracks,
      'merging all six artist pairs preserves every track object, title, artist credit, ID, stream URL, artwork and saved key');

    const name = fixture.vevoPairs[0][0];
    await fixture.publishMetadata(name, fixture.readyMetadata(name, { bio: longBio }));
    goTab('tabHome'); home.openHomeArtistsTab(); home.openArtistDetail(name, false);
    await flush();
    const root = document.getElementById('homeArtistDetailView');
    const image = root.querySelector('.artist-hero-image'), toggle = root.querySelector('[data-artist-bio-toggle]');
    check(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' && getComputedStyle(root.querySelector('.artist-hero-name')).color === 'rgb(255, 255, 255)', 'the supplied portrait design retains a true-black canvas and white artist title');
    check(getComputedStyle(root.querySelector('.artist-hero-card')).borderTopLeftRadius === '20px' &&
      image.getAttribute('src') === '/api/artist-image?id=automatic.jpg' && image.alt === '' &&
      root.querySelector('.artist-hero-backdrop').getAttribute('aria-hidden') === 'true', 'one decorative artist portrait fades into the rounded 20px hero');
    check(getComputedStyle(document.getElementById('artistPlayAllBtn')).backgroundColor === 'rgb(255, 255, 255)' &&
      root.querySelector('.artist-songs-list').tagName === 'OL' && getComputedStyle(root.querySelector('.artist-song-cover')).borderRadius === '6px',
      'the supplied white Play all action, ordered quiet rows and 44px track artwork are shared');
    check(!toggle.hidden && toggle.getAttribute('aria-expanded') === 'false' && getComputedStyle(root.querySelector('.artist-bio-text')).webkitLineClamp === '3', 'long composed biographies start at three lines with a named More control');
    check([...root.querySelectorAll('[data-artist-credit]')].every(credit => credit.getClientRects().length && getComputedStyle(credit).display !== 'none'), 'used biography and portrait credits remain visible while the biography is collapsed');
    toggle.click();
    check(toggle.textContent === 'Less' && toggle.getAttribute('aria-expanded') === 'true' && getComputedStyle(root.querySelector('.artist-bio-text')).display === 'block', 'More expands the existing biography without changing tracks');
    const track = root.querySelector('.artist-song-row'); track.focus({ preventScroll: true });
    await fixture.publishMetadata(name, fixture.readyMetadata(name, { bio: longBio + ' Updated details.' }));
    check(track.isConnected && root.querySelector('.artist-song-row') === track && document.activeElement === track &&
      root.querySelector('[data-artist-bio-toggle]').getAttribute('aria-expanded') === 'true', 'metadata updates retain the same focused track button and expanded biography');
    const focusedToggle = root.querySelector('[data-artist-bio-toggle]'); focusedToggle.focus({ preventScroll: true });
    await fixture.publishMetadata(name, fixture.readyMetadata(name, { bio: longBio + ' Second update.' }));
    check(document.activeElement?.matches('[data-artist-bio-toggle]') && document.activeElement.getAttribute('aria-expanded') === 'true', 'biography refresh restores focus to its equivalent toggle');
    root.querySelector('[data-artist-back]').click();
    check(root.style.display === 'none' && document.getElementById('homeArtistsView').style.display === 'block' &&
      document.activeElement === document.getElementById('homeArtistsChip'), 'Home Back to Artists returns to the artist grid and its keyboard opener');

    goTab('tabLibrary'); library.setLibView('artists');
    library.openArtist(library.getArtistGroups().findIndex(group => group.name === name));
    document.querySelector('#librarySongList [data-artist-back]').click();
    check(!!document.querySelector('#librarySongList .artist-tiles') && document.activeElement === document.querySelector('#libViewSeg [data-view="artists"]'), 'Library Back to Artists restores its own tile view and focused tab control');
    check(localStorage.getItem('auraPlaylists') === original.playlists && localStorage.getItem('addedTracks') === original.added &&
      state.audio.getAttribute('src') === original.src && state.currentIndex === original.index && state.isPlaying === original.playing,
      'artist design, metadata and intercepted controls never change saved music or active playback');
    check(fixture.errors.length === 0 && document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'artist design and six-pair regressions finish without errors or horizontal overflow');
  } finally { window.playTrackSequence = originalPlay; }
  return { passed: checks.length, checks };
}

export async function runArtistPagePlaybackRegressions() {
  const { fixture, state, home, library, queue, player, savedLikeMap, goTab, checks, check } = await setup();
  const name = fixture.vevoPairs[0][0], group = library.getArtistGroups().find(artist => artist.name === name);
  const ids = group.songs.map(song => String(song.id)), audio = state.audio;
  const originalSongs = state.songs;
  const settings = (await import('/src/features/settings.ts')).auraSettings;
  const waitForTrack = async id => until(() => String(state.songs[state.currentIndex]?.id) === id && state.isPlaying && !audio.paused && audio.readyState >= 2, 'artist audio ' + id);
  const playAll = async () => {
    goTab('tabHome'); home.openArtistDetail(name, false);
    document.getElementById('artistPlayAllBtn').click(); await waitForTrack(ids[0]);
  };
  audio.muted = true; state.repeatMode = 'off'; settings.autoplayNext = true;
  queue.manualQueue.splice(0);
  try {
    state.isShuffle = true; await playAll();
    check(queue.getArtistPlayback()?.collectionId === group.key && same(queue.getArtistPlayback().order, ids) && !state.isShuffle, 'artist Play all resets shuffle and starts the artist’s original ordered collection');
    const first = document.querySelector('#artistSongsList .artist-song-row'); first.focus({ preventScroll: true });
    first.click(); await until(() => !state.isPlaying && audio.paused, 'artist row pause');
    check(first.isConnected && !first.classList.contains('is-playing') && first.getAttribute('aria-label').startsWith('Play '), 'the selected row pauses its own transport in place');
    first.click(); await waitForTrack(ids[0]);
    check(first.classList.contains('is-playing') && first.getAttribute('aria-label').startsWith('Pause ') && document.activeElement === first, 'the same native row resumes with current playback semantics and focus');
    for (const id of ids.slice(1)) { await queue.playNext(); await waitForTrack(id); }
    await queue.playNext();
    check(String(state.songs[state.currentIndex].id) === ids.at(-1) && !state.isPlaying && audio.paused && !queue.getRollingUpNextItems().length,
      'Next at the artist boundary stops instead of entering unrelated library songs');
    await queue.playPrevious(); await waitForTrack(ids[1]);
    check(queue.getArtistPlayback().currentId === ids[1], 'Previous follows the artist’s actual listening history');

    const originalSequence = window.playTrackSequence;
    window.playTrackSequence = (ids, options) => originalSequence(ids, { ...options, random: () => 0 });
    try { document.getElementById('artistShuffleBtn').click(); } finally { window.playTrackSequence = originalSequence; }
    const order = [...queue.getArtistPlayback().playOrder], heard = [];
    for (let index = 0; index < order.length; index++) {
      if (index) await queue.playNext();
      await waitForTrack(order[index]); heard.push(String(state.songs[state.currentIndex].id));
    }
    check(state.isShuffle && same(heard, order) && new Set(heard).size === ids.length && heard.every(id => ids.includes(id)), 'Shuffle hears every artist track exactly once without leaking into the library');
    for (let index = order.length - 2; index >= 0; index--) { await queue.playPrevious(); await waitForTrack(order[index]); }
    check(String(state.songs[state.currentIndex].id) === order[0], 'shuffled Previous retraces the actual artist order');

    const outside = state.songs.find(song => song.artist === 'Sushin Shyam');
    await playAll(); queue.openTrackMenu(null, outside.id); queue.queueTrackAction('playNext');
    check(queue.manualQueue.some(id => String(id) === String(outside.id)) && queue.getRollingUpNextItems()[0] === outside, 'explicit manual interruptions are retained and previewed ahead of artist traversal');
    await queue.playNext(); await waitForTrack(String(outside.id));
    await queue.playNext(); await waitForTrack(ids[1]);
    await queue.playPrevious(); await waitForTrack(String(outside.id));
    check(queue.getArtistPlayback().collectionId === group.key, 'manual interruption returns to the artist and participates in Previous history');

    await playAll(); queue.openTrackMenu(null, outside.id); queue.queueTrackAction('addQueue');
    const reordered = [ids[2], String(outside.id), ids[1]];
    queue.promoteVisibleOrder(reordered);
    check(same(queue.getRollingUpNextItems().map(song => String(song.id)), reordered) &&
      queue.manualQueue.some(id => String(id) === String(outside.id)), 'Up Next reordering uses the same effective schedule without discarding unconsumed manual queue entries');
    for (const id of reordered) { await queue.playNext(); await waitForTrack(id); }
    await queue.playNext();
    check(!state.isPlaying && String(state.songs[state.currentIndex].id) === ids[1], 'reordered artist playback consumes its visible schedule once and stops at the correct boundary');

    await playAll(); state.songs = state.songs.filter(song => String(song.id) !== ids[1]);
    await queue.playNext(); await waitForTrack(ids[2]);
    check(String(state.songs[state.currentIndex].id) === ids[2], 'a removed artist recording is skipped in one bounded advance');
    state.songs = originalSongs; state.currentIndex = state.songs.findIndex(song => String(song.id) === ids[2]);
    state.repeatMode = 'all'; await queue.playNext(); await waitForTrack(ids[0]);
    state.repeatMode = 'one'; await queue.playNext(); await waitForTrack(ids[1]);
    check(queue.getArtistPlayback().collectionId === group.key, 'Repeat all wraps inside the artist while manual Next still advances during Repeat one');
    state.repeatMode = 'off'; await playAll();
    audio.currentTime = audio.duration - .08;
    await waitForTrack(ids[1]);
    check(String(state.songs[state.currentIndex].id) === ids[1], 'a real native audio ended event advances to the next artist recording');

    await fixture.publishMetadata(name, fixture.readyMetadata(name, { bio: longBio }));
    goTab('tabLibrary'); library.setLibView('artists');
    library.openArtist(library.getArtistGroups().findIndex(artist => artist.name === name));
    await flush();
    const root = document.querySelector('#librarySongList .artist-page'), row = root.querySelector('.artist-song-row');
    const toggle = root.querySelector('[data-artist-bio-toggle]'); toggle.click();
    const favorite = root.querySelector('[data-like-song-id]'), song = group.songs[0]; favorite.focus({ preventScroll: true });
    const before = { src: audio.getAttribute('src'), index: state.currentIndex, time: audio.currentTime, liked: !!song.favorite };
    favorite.click(); await flush();
    check(song.favorite !== before.liked && savedLikeMap[String(song.id)] === true && favorite.getAttribute('aria-pressed') === 'true' &&
      document.activeElement === favorite && row.isConnected && root.querySelector('.artist-song-row') === row && root.querySelector('[data-artist-bio-toggle]').getAttribute('aria-expanded') === 'true',
      'Library favorites use the saved song ID, retain focus and track nodes, and preserve expanded biography');
    root.querySelector('[data-song-menu]').click(); await flush();
    check(document.getElementById('trackSheetOverlay').classList.contains('active') && document.getElementById('trackSheetTitle').textContent === song.title &&
      state.currentIndex === before.index && audio.getAttribute('src') === before.src && audio.currentTime >= before.time && !audio.paused,
      'the capture-delegated artist menu opens the original track without bubbling into playback');
    queue.closeTrackMenu();

    const missing = { ...group.songs[0], id: 'fixture:artist-missing', artist: 'Unavailable Artist', isLocal: true, missing: true, url: '' };
    state.songs.push(missing);
    goTab('tabHome'); home.openArtistDetail(missing.artist, false);
    check(document.getElementById('artistPlayAllBtn').disabled && document.getElementById('artistShuffleBtn').disabled &&
      document.querySelector('#artistSongsList .artist-song-row').disabled, 'unavailable local artist tracks and bulk transport remain disabled');
    state.songs.pop();

    player.playSong(state.songs.indexOf(outside)); await waitForTrack(String(outside.id));
    check(queue.getArtistPlayback() === null, 'a direct ordinary library selection retires artist traversal');
    check(localStorage.getItem('auraPlaylists') === fixture.playlist && fixture.errors.length === 0, 'artist playback, favorite and menu checks preserve playlists and produce no browser errors');
  } finally {
    state.songs = originalSongs;
    audio.pause(); state.isPlaying = false; player.updatePlayState(); queue.clearArtistPlayback();
  }
  return { passed: checks.length, checks };
}
