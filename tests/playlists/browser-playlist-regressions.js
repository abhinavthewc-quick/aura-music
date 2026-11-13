/* Run only on /tests/artists/browser.html from the isolated fixture server.
   Exercises shipped DOM/modules, real local audio, and synthetic share APIs. */
const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}
const $ = (id) => document.getElementById(id);
const text = (selector) => document.querySelector(selector)?.textContent.trim() || '';
const saved = () => {
  const store = JSON.parse(localStorage.getItem('auraPlaylists') || '[]');
  return Array.isArray(store) ? store : store.playlists;
};
const savedKeys = (playlist) => playlist.tracks.map((track) => typeof track === 'string' ? track : track.legacyKey);
function fixtureOnly() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'main') throw new Error('Use the dedicated local main-app fixture.');
  return fixture;
}
function checks() {
  const passed = [];
  return { passed, check(value, label) { if (!value) throw new Error(label); passed.push(label); } };
}
function readWire(link) {
  const encoded = new URL(link, location.href).hash.slice('#playlist='.length);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))));
}
function wireLink(payload) {
  const binary = Array.from(new TextEncoder().encode(JSON.stringify(payload)), (byte) => String.fromCharCode(byte)).join('');
  return location.origin + '/#playlist=' + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function arrive(link, play = false) {
  const next = new URL(location.href);
  next.hash = new URL(link, location.href).hash;
  if (play) next.searchParams.set('play', 'yt:abcdefghijk');
  history.replaceState(history.state, '', next);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export async function runPlaylistSharingRegressions() {
  const fixture = fixtureOnly();
  const { passed, check } = checks();
  await until(() => !$('musicApp')?.hidden && window.state?.songs.length, 'music bootstrap');
  const { state, trackKey } = await import('/src/core/state.ts');
  const playlists = await import('/src/features/playlists.ts');
  const player = await import('/src/features/player.ts');
  await until(() => !state.catalogLoading && state.songs.some((song) => song.isLocal && song.url?.startsWith('blob:')), 'library hydration');
  await fixture.publish(fixture.cloud(2, 'Renamed Artist'));
  const senderOnly = { id: 'sender-only', title: 'மழை 🎵', artist: '遠い音', videoId: 'zyxwvutsrqp', url: '/__fixture_audio.wav', img: '/src/assets/brand-logo.webp' };
  state.songs.push(senderOnly);
  const source = {
    id: 'share-fixture', title: 'மாலை 🎧 · Café <3', description: '<b>Snapshot only</b>\nMusic & friends',
    privacy: 'Private', year: 2026, createdAt: 1780000000000, owner: { email: 'never-shared@example.test' },
    tracks: ['lk:hand upload|old artist', 'lk:hand upload|renamed artist', 'vid:abcdefghijk', 'vid:zyxwvutsrqp', 'lk:on this device|local artist', 'vid:gonegonegon'],
  };
  localStorage.setItem('auraPlaylists', JSON.stringify([source, ...saved()]));
  const sourceStorage = localStorage.getItem('auraPlaylists');
  const addedBefore = localStorage.getItem('addedTracks');
  playlists.openPlaylistPage(source.id);
  state.audio.muted = true;
  player.playSong(state.songs.findIndex((song) => song.title === 'Hand upload'));
  await state.audio.play();
  state.audio.currentTime = 18;
  state.audio.playbackRate = 1.25;
  await flush();
  const playback = { src: state.audio.getAttribute('src'), id: state.songs[state.currentIndex].id, rate: state.audio.playbackRate };
  let resets = 0;
  const onReset = () => resets++;
  const playbackEvents = ['loadstart', 'emptied', 'pause', 'seeking'];
  for (const event of playbackEvents) state.audio.addEventListener(event, onReset);
  const descriptors = new Map(['share', 'canShare', 'clipboard'].map((key) => [key, Object.getOwnPropertyDescriptor(navigator, key)]));
  const execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const stub = (key, value) => Object.defineProperty(navigator, key, { configurable: true, writable: true, value });
  const originalSetItem = Storage.prototype.setItem;
  const copies = [];
  let link;
  const requestsBefore = fixture.requests.length;
  try {
    let shared;
    stub('clipboard', { writeText: async (value) => { copies.push(value); } });
    stub('canShare', () => true);
    stub('share', async (data) => { shared = data; });
    await playlists.playlistPageShare();
    await until(() => {
      const button = document.querySelector('[data-copy-share]');
      if (!button) return false;
      const bounds = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
    }, 'share controls clear of fixed navigation');
    link = shared.url;
    const payload = readWire(link);
    check(shared.title === source.title && payload.title === source.title && payload.description === source.description, 'native sharing carries a Unicode playlist link and its exact description');
    check(JSON.stringify(payload.tracks.map((track) => track.key)) === JSON.stringify(['lk:hand upload|old artist', 'vid:abcdefghijk', 'vid:zyxwvutsrqp']), 'outgoing keys deduplicate legacy artist aliases in playlist order');
    check(payload.omitted.local === 1 && payload.omitted.unavailable === 1 && text('#playlistSharePanel').includes('1 local file'), 'sender sees explicit local-file and unresolved-track omissions');
    check(!/blob:|data:|never-shared|fixture:local|owner|email|\.opus|\/api\//.test(JSON.stringify(payload)), 'snapshot excludes account, local-file, artwork and media URL data');
    check(new URL(link).pathname === '/' && !new URL(link).search && text('#playlistShareStatus') === 'Playlist link shared.' && text('#toastContainer').includes('Playlist link shared.'), 'native success provides an app-root link, visible controls and clear completion feedback');
    check(localStorage.getItem('auraPlaylists') === sourceStorage, 'sharing does not rewrite the source playlist');

    document.querySelector('[data-copy-share]').click();
    await until(() => text('#playlistShareStatus').startsWith('Playlist link copied.'), 'explicit copy');
    check(copies.at(-1) === link, 'Copy link writes the recipient-usable URL');
    const copiesBeforeCancel = copies.length;
    stub('share', async () => { throw new DOMException('Dismissed', 'AbortError'); });
    await playlists.playlistPageShare();
    check(text('#playlistShareStatus').includes('canceled') && copies.length === copiesBeforeCancel && !document.querySelector('[data-copy-share]').disabled, 'native cancel is distinct and never silently copies');
    stub('share', async () => { throw new DOMException('Blocked', 'NotAllowedError'); });
    await playlists.playlistPageShare();
    check(text('#playlistShareStatus').includes('copied instead') && copies.at(-1) === link, 'native rejection falls back to the clipboard with honest feedback');
    let nativeCalls = 0;
    stub('share', async () => { nativeCalls++; });
    stub('canShare', () => false);
    await playlists.playlistPageShare();
    check(nativeCalls === 0 && text('#playlistShareStatus').includes('copied instead'), 'unsupported native share data uses the copy fallback');

    stub('share', undefined);
    stub('clipboard', { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    let legacyCopy = '';
    Object.defineProperty(document, 'execCommand', { configurable: true, value: (command) => {
      const field = $('playlistShareLink');
      if (command === 'copy') legacyCopy = field.value.slice(field.selectionStart, field.selectionEnd);
      return command === 'copy';
    } });
    await playlists.playlistPageShare();
    check(legacyCopy === link && text('#playlistShareStatus').startsWith('Playlist link copied.'), 'clipboard permission failure selects and copies the full link with the legacy fallback');
    stub('clipboard', undefined);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    await playlists.playlistPageShare();
    check(text('#playlistShareStatus').includes('Select and copy') && $('playlistShareLink').value === link && $('playlistShareLink').readOnly && !document.querySelector('[data-copy-share]').disabled, 'blocked copying leaves a selectable link and a usable retry instead of a false success');
    check($('playlistShareLink').selectionEnd === link.length, 'manual fallback includes the entire Unicode-safe URL');
    playlists.refreshPlaylistViews();
    check(document.activeElement === $('playlistShareLink') && $('playlistShareLink').selectionEnd === link.length, 'library repaint preserves manual-copy focus and selection');
    document.querySelector('[data-close-share]').click();
    check(!$('playlistSharePanel').firstElementChild && document.activeElement === document.querySelector('[data-share-current]'), 'closing inline sharing restores focus to Share');

    const oversized = { ...source, tracks: Array.from({ length: 101 }, (_, index) => `lk:overflow ${index}|artist`) };
    localStorage.setItem('auraPlaylists', JSON.stringify([oversized]));
    const oversizedStorage = localStorage.getItem('auraPlaylists');
    playlists.openPlaylistPage(oversized.id);
    await playlists.playlistPageShare();
    check(text('#playlistSharePanel [role="alert"]').includes('too large') && !$('playlistShareLink') && localStorage.getItem('auraPlaylists') === oversizedStorage, 'oversized sharing fails clearly without truncating or modifying the playlist');
    localStorage.setItem('auraPlaylists', sourceStorage);
    playlists.openPlaylistPage(source.id);

    let finishShare;
    nativeCalls = 0;
    stub('canShare', () => true);
    stub('share', () => { nativeCalls++; return new Promise((resolve) => { finishShare = resolve; }); });
    const pending = playlists.playlistPageShare();
    await playlists.playlistPageShare();
    check(nativeCalls === 1 && document.querySelector('[data-share-current]').disabled, 'duplicate clicks cannot launch overlapping native shares');
    await fixture.publish(fixture.cloud(3, 'Latest Artist'));
    finishShare();
    await pending;
    check($('playlistShareLink').value === link && text('#playlistShareStatus') === 'Playlist link shared.', 'artist refresh preserves the in-flight snapshot and completion feedback');

    $('miniExpandBtn').click();
    const fullPlayer = $('fullPlayerOverlay');
    const desktop = matchMedia('(min-width:900px)').matches;
    const playerOwnsFocus = () => (matchMedia('(min-width:900px)').matches ? [fullPlayer, $('upNextSheet'), $('miniPlayer')] : [fullPlayer])
      .some(root => root.contains(document.activeElement));
    if (desktop) $('playPauseBtn').focus();
    await until(playerOwnsFocus, 'full-player workspace focus');
    arrive(link, true);
    check(fullPlayer.classList.contains('active') && (desktop ? document.activeElement === $('sharedPlaylistHeading') : playerOwnsFocus()),
      desktop ? 'received preview can focus its heading beside the nonmodal desktop player' : 'received inline preview respects the modal phone player focus');
    if (desktop) {
      for (const id of ['playPauseBtn', 'ytmTabLyricsBtn']) {
        $(id).focus();
        arrive(link);
        await flush();
        check(document.activeElement === $('sharedPlaylistHeading') && fullPlayer.classList.contains('active'), `received preview remains reachable from the nonmodal desktop ${id} control`);
      }
    }
    $('closeFullPlayerBtn').focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(tab);
    check(desktop ? !tab.defaultPrevented && fullPlayer.getAttribute('aria-modal') === 'false' && $('upNextSheet').getAttribute('role') === 'region' && !$('upNextSheet').hasAttribute('aria-modal')
      : tab.defaultPrevented && fullPlayer.contains(document.activeElement) && document.activeElement !== $('closeFullPlayerBtn'),
      desktop ? 'desktop player and companion do not trap Tab or claim modal focus' : 'phone Tab stays in the active player while a received preview waits behind it');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    check(!fullPlayer.classList.contains('active') && $('tabPlaylist').classList.contains('active') && document.querySelector('[data-save-shared]'), 'Escape closes the player alone and leaves the received preview ready');
    check(text('#sharedPlaylistHeading') === source.title && localStorage.getItem('auraPlaylists') === sourceStorage, 'received link opens a read-only preview without saving');
    check(!new URLSearchParams(location.search).has('play') && !fixture.requests.slice(requestsBefore).some((request) => request.path.includes('oembed')), 'playlist links suppress combined playback and metadata-fetch parameters');
    check(document.querySelectorAll('[data-shared-track]').length === 3 && [...document.querySelectorAll('.pl-track-availability')].filter((node) => node.textContent === 'Not in your library').length === 1, 'recipient preview distinguishes existing library tracks from missing ones');
    check(text('#tabPlaylist').includes('1 local file') && text('#tabPlaylist').includes('மழை 🎵'), 'recipient sees both omitted local files and missing-track names');
    Storage.prototype.setItem = function (key, value) {
      if (key === 'auraPlaylists') throw new DOMException('Full', 'QuotaExceededError');
      return originalSetItem.call(this, key, value);
    };
    document.querySelector('[data-save-shared]').click();
    await until(() => text('#playlistImportStatus').includes('Could not save'), 'failed asynchronous playlist save');
    check(text('#playlistImportStatus').includes('Could not save') && localStorage.getItem('auraPlaylists') === sourceStorage, 'storage failure preserves the preview and existing playlists for retry');
    Storage.prototype.setItem = originalSetItem;
    document.querySelector('[data-save-shared]').click();
    await until(() => saved()[0]?.id !== source.id && !document.querySelector('[data-save-shared]'), 'explicit shared snapshot save');
    const imported = saved()[0];
    check(imported.id !== source.id && imported.privacy === 'Private' && imported.schemaVersion === 2 && JSON.stringify(savedKeys(imported)) === JSON.stringify(payload.tracks.map((track) => track.key)) &&
      new Set(imported.tracks.map(track => track.ref)).size === payload.tracks.length, 'Save playlist creates a new private version-2 copy with stable ordered references and source keys');
    check(localStorage.getItem('auraPlaylists_backup_v1') === sourceStorage, 'explicit legacy migration keeps a byte-exact recovery copy');
    check(localStorage.getItem('addedTracks') === addedBefore && !state.songs.some((song) => song.id === senderOnly.id), 'import neither adds missing music nor changes saved library tracks');
    check(document.querySelectorAll('#tabPlaylist [data-play-index]').length === 2 && document.querySelectorAll('[data-unavailable-track]').length === 1 && text('#tabPlaylist').includes('மழை 🎵'), 'saved playlist retains an honest, named placeholder for missing music');
    check(text(`[data-playlist-id="${imported.id}"] .playlist-card-copy p`).includes('3 tracks on this device. 1 unavailable'), 'playlist overview counts saved missing tracks without pretending they are playable');
    const importedStorage = localStorage.getItem('auraPlaylists');
    const count = saved().length;
    arrive(link);
    check(text('[data-save-shared]') === 'Open saved playlist', 'reopening the same snapshot identifies the saved copy');
    document.querySelector('[data-save-shared]').click();
    await until(() => !document.querySelector('[data-save-shared]'), 'open an already saved snapshot');
    check(saved().length === count && localStorage.getItem('auraPlaylists') === importedStorage, 'repeated import does not create duplicates or rewrite storage');
    state.songs.push(senderOnly);
    playlists.refreshPlaylistViews();
    check(document.querySelectorAll('#tabPlaylist [data-play-index]').length === 3 && !document.querySelector('[data-unavailable-track]') && localStorage.getItem('auraPlaylists') === importedStorage, 'a later library update resolves missing keys without mutating the saved playlist');
    await playlists.addTrackToPlaylist(imported.id, String(state.songs.find((song) => trackKey(song) === 'lk:hand upload|old artist').id));
    check(saved()[0].tracks.length === 3 && localStorage.getItem('auraPlaylists') === importedStorage, 'adding a renamed existing track to the imported copy stays deduplicated');

    const untrusted = { v: 1, title: '<img src=x onerror=window.__playlistInjected=1>', description: '<b>தமிழ் 🎧</b>', tracks: [{ key: 'vid:xxxxxxxxxxx', title: '<svg onload=window.__playlistInjected=1>', artist: 'Untrusted <artist>' }], omitted: { local: 0, unavailable: 0 } };
    arrive(wireLink(untrusted));
    check(text('#sharedPlaylistHeading') === untrusted.title && text('#tabPlaylist').includes(untrusted.tracks[0].title) && !$('tabPlaylist').querySelector('img,svg,b b') && !window.__playlistInjected, 'untrusted titles render as text without executing markup or requesting artwork');
    arrive(location.origin + '/#playlist=%not-valid');
    check(Boolean(document.querySelector('.pl-link-error [role="alert"]')) && localStorage.getItem('auraPlaylists') === importedStorage, 'malformed received links show a recoverable error without mutations');
    document.querySelector('[data-dismiss-shared]').click();
    check(!location.hash && $('tabPlaylists').classList.contains('active'), 'dismissing an invalid link clears it and returns to Playlists');
    check(resets === 0 && !state.audio.paused && state.audio.getAttribute('src') === playback.src && state.audio.playbackRate === playback.rate && state.songs[state.currentIndex].id === playback.id, 'sharing, preview, import and refresh never pause, seek or reload active audio');
    check(!fixture.requests.slice(requestsBefore).some((request) => request.method !== 'GET' && request.method !== 'BEACON'), 'playlist operations make no remote mutation or submission requests');
    check(!fixture.requests.some((request) => ['search', 'dispatch', 'bucketUpload'].includes(request.action)), 'playlist matching never invokes external search or downloads');
    arrive(link);
    check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'playlist preview has no horizontal overflow');
    check(fixture.errors.length === 0, 'all sharing states finish without uncaught browser errors');
    return { passed: passed.length, checks: passed, arrivalLink: link };
  } finally {
    Storage.prototype.setItem = originalSetItem;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else delete navigator[key];
    }
    if (execDescriptor) Object.defineProperty(document, 'execCommand', execDescriptor);
    else delete document.execCommand;
    for (const event of playbackEvents) state.audio.removeEventListener(event, onReset);
    state.audio.pause();
    player.updatePlayState();
  }
}

/** Open a NEW fixture page with #playlist= from arrivalLink above. Add
    ?signed-out and pass { signIn: true } to exercise a fresh first entry. */
export async function runPlaylistArrivalRegressions({ signIn = false } = {}) {
  const fixture = fixtureOnly();
  const { passed, check } = checks();
  if (!location.hash.startsWith('#playlist=')) throw new Error('Open a fresh fixture page with a received playlist fragment.');
  const incomingHash = location.hash;
  const payload = readWire(location.href);
  if (signIn) {
    check(!localStorage.getItem('auraSession_v2') && $('musicApp').hidden && !window.state, 'fresh received link stays behind the existing sign-in gate');
    check(fixture.requests.length === 0 && !performance.getEntriesByType('resource').some((entry) => /\/src\/(runtime|app)\.ts/.test(entry.name)), 'fresh arrival does not eagerly load music or make catalogue requests');
    localStorage.removeItem('auraPlaylists');
    localStorage.removeItem('auraHfCatalog_v1');
    localStorage.setItem('addedTracks', '[]');
    $('emailAuthToggle').click();
    $('authSwitch').click();
    $('authEmailInput').value = 'playlist-recipient@example.test';
    $('authPasswordInput').value = 'fixture-playlist-password';
    $('authPassword2Input').value = 'fixture-playlist-password';
    $('authGo').click();
    await until(() => !$('usernameStep').hidden, 'recipient username step');
    check(location.hash === incomingHash && !window.state, 'received fragment survives account and username entry without importing');
    $('pickUsernameInput').value = 'Playlist guest';
    $('pickUsernameGo').click();
  }
  const before = localStorage.getItem('auraPlaylists');
  await until(() => !$('musicApp').hidden && $('sharedPlaylistHeading'), 'received preview after bootstrap');
  await until(() => !window.state.catalogLoading, 'recipient catalogue load');
  await flush();
  check(text('#sharedPlaylistHeading') === payload.title && location.hash === incomingHash, 'bootstrap opens the received Unicode snapshot on the playlist preview');
  check(localStorage.getItem('auraPlaylists') === before, 'arrival never auto-saves or replaces recipient playlists');
  check(window.state.audio.paused && !window.state.isPlaying, 'opening a received snapshot never autoplays');
  check(text('#tabPlaylist').includes('Not in your library') && text('#tabPlaylist').includes('Local audio isn’t transferred'), 'fresh/returning recipient sees missing and local-only feedback');
  const count = saved().length;
  document.querySelector('[data-save-shared]').click();
  await until(() => saved().length === count + 1 && !document.querySelector('[data-save-shared]'), 'explicit asynchronous arrival save');
  check(saved().length === count + 1 && saved()[0].schemaVersion === 2 && JSON.stringify(savedKeys(saved()[0])) === JSON.stringify(payload.tracks.map((track) => track.key)), 'explicit save appends a version-2 local playlist while preserving source keys');
  check(!location.hash && text('#tabPlaylist').includes(payload.title) && document.querySelector('[data-unavailable-track]'), 'saved arrival keeps missing-track details and consumes the link');
  check(!fixture.requests.some((request) => ['search', 'dispatch', 'bucketUpload'].includes(request.action)), 'arrival and local import never trigger remote discovery or submissions');
  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth && fixture.errors.length === 0, 'arrival completes without overflow or uncaught errors');
  return { session: signIn ? 'fresh' : 'returning', passed: passed.length, checks: passed };
}
