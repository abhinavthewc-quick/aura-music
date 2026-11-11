/* Dedicated local checks; import this module only after the fixture loads.
   Fresh main: runAutomaticMetadataRegressions()
   Fresh main ?metadata=held-ready: runMetadataLookupRegressions()
   Fresh ?page=admin: runAdminMetadataRegressions()
   Fresh ?page=admin&admin-gate=held (or denied): runAdminMetadataGateRegressions()
   Fresh ?signed-out (main or admin): runSignedOutMetadataRegressions()
   No real login, provider requests, downloads, uploads or remote mutations. */
const flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}
function fixtureFor(page) {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== page) throw new Error('Use the dedicated local ' + page + ' fixture.');
  return fixture;
}
const assertions = () => {
  const checks = [];
  return { checks, check(value, label) { if (!value) throw new Error(label); checks.push(label); } };
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export async function runAutomaticMetadataRegressions() {
  const fixture = fixtureFor('main'), { check, checks } = assertions();
  const { state, trackKey } = await import('/src/core/state.ts');
  const home = await import('/src/features/home.ts');
  const library = await import('/src/features/library.ts');
  const { manualQueue } = await import('/src/features/queue.ts');
  const { goTab } = await import('/src/ui/nav.ts');
  const metadata = await import('/src/core/artistMetadata.ts');
  await until(() => !state.catalogLoading && !document.getElementById('musicApp').hidden && state.songs.some(song => song.isLocal && song.url?.startsWith('blob:')), 'signed-in library paint and local hydration');
  await until(() => fixture.requests.some(request => request.path === '/api/artist-metadata'), 'lazy automatic client activation');
  const group = library.getArtistGroups().find(artist => artist.name === 'Sushin Shyam');
  if (!group || group.profile?.img) throw new Error('Use a fresh fixture with an unprofiled Sushin Shyam.');
  goTab('tabHome');
  home.openArtistDetail(group.key, false);
  library.setLibView('artists');
  library.openArtist(library.getArtistGroups().findIndex(artist => artist.key === group.key));
  const homeRow = document.querySelector('#artistSongsList .artist-song-row');
  let libraryRow = document.querySelector('.artist-page .song-item-play');
  check(homeRow instanceof HTMLButtonElement && libraryRow instanceof HTMLButtonElement, 'both open artist pages have native track controls');
  check(document.querySelector('.artist-hero-img').getAttribute('src') === metadata.DEFAULT_ARTIST_PORTRAIT && !!document.querySelector('.artist-page .artist-avatar-fallback'), 'missing artist portraits use a neutral silhouette or initial, never album artwork');
  const homeCover = document.querySelector('#artistSongsList .artist-song-cover').getAttribute('src');
  const libraryCover = document.querySelector('.artist-page .song-info img').getAttribute('src');
  check(homeCover === group.songs[0].img && libraryCover === group.songs[0].img, 'actual track artwork is retained in both artist pages');

  const original = {
    songs: state.songs, hf: state.hfSongs, added: state.addedSongs, members: [...state.songs],
    identities: state.songs.map(song => [song.id, trackKey(song), song.artist, song.img]),
    queue: [...manualQueue], playlists: localStorage.getItem('auraPlaylists'), local: localStorage.getItem('addedTracks'),
    directory: localStorage.getItem('auraCloudArtists_v1'), manifest: localStorage.getItem('auraHfArtists_v1'),
    playlistMarkup: document.getElementById('tabPlaylist').innerHTML,
    src: state.audio.getAttribute('src'), time: state.audio.currentTime, rate: state.audio.playbackRate,
    index: state.currentIndex, playing: state.isPlaying, paused: state.audio.paused,
    media: navigator.mediaSession?.metadata,
  };
  const storageWrites = [], audioEvents = [];
  const nativeSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) { storageWrites.push(key); return nativeSet.call(this, key, value); };
  const onAudio = event => audioEvents.push(event.type);
  for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.addEventListener(event, onAudio);
  try {
    goTab('tabHome');
    homeRow.focus({ preventScroll: true });
    const scroll = { x: window.scrollX, y: window.scrollY };
    const first = fixture.readyMetadata(group.name, { bio: 'Verified text <img data-provider-injection="yes"> stays plain.' });
    await fixture.publishMetadata(group.name, first);
    check(document.activeElement === homeRow && homeRow.isConnected && document.querySelector('#artistSongsList .artist-song-row') === homeRow, 'a late automatic arrival retains the focused Home track button without replacing it');
    check(libraryRow.isConnected && document.querySelector('.artist-page .song-item-play') === libraryRow, 'the hidden Library artist page also keeps its original track controls');
    check(window.scrollX === scroll.x && window.scrollY === scroll.y, 'metadata-only paint does not scroll the focused Home page');
    check(document.querySelector('.artist-hero-img').getAttribute('src') === first.metadata.img && document.querySelector('.artist-page-avatar').getAttribute('src') === first.metadata.img, 'both open artist pages receive the verified portrait');
    check(document.querySelector('#artistHeroCard .artist-bio').textContent === first.metadata.bio && document.querySelector('.artist-page .artist-bio').textContent === first.metadata.bio && !document.querySelector('[data-provider-injection]'), 'biographies are shared, bounded plaintext rather than provider HTML');
    check(document.querySelectorAll('#artistHeroCard [data-artist-credit]').length === 2 && document.querySelectorAll('.artist-page [data-artist-credit]').length === 2, 'only used automatic image and biography fields show credits');
    check([...document.querySelectorAll('[data-artist-credit] a')].every(link => link.protocol === 'https:' && link.rel.includes('noopener') && link.rel.includes('noreferrer')), 'source links are HTTPS and safely isolated');
    check(document.querySelector('#artistHeroCard [data-artist-credit="image"]').textContent.includes('Cropped to fit'), 'portrait credit discloses cropping');
    const current = library.getArtistGroups().find(artist => artist.key === group.key);
    check(current?.name === group.name && !current.profile?.name && !current.profile?.key && same(current.songs, group.songs), 'provider spelling and entity IDs cannot acquire artist ownership or rename the credit');

    const bioLicense = document.querySelector('#artistHeroCard [data-artist-credit="bio"] a:last-of-type');
    bioLicense.focus({ preventScroll: true });
    await fixture.publishMetadata(group.name, fixture.readyMetadata(group.name, { bio: 'Updated text keeps the same biography source and license.' }));
    check(document.activeElement instanceof HTMLAnchorElement && document.activeElement.href === bioLicense.href && document.activeElement.closest('[data-artist-credit]')?.dataset.artistCredit === 'bio', 'a refreshed biography keeps its focused license link rather than jumping to the photo’s identical license');

    goTab('tabLibrary');
    libraryRow = document.querySelector('.artist-page .song-item-play');
    libraryRow.focus({ preventScroll: true });
    const imageOnly = fixture.readyMetadata(group.name, { img: '/api/artist-image?id=image-only.jpg', bio: undefined });
    await fixture.publishMetadata(group.name, imageOnly);
    check(document.activeElement === libraryRow && libraryRow.isConnected && document.querySelector('.artist-page .song-item-play') === libraryRow, 'an image-only arrival retains the focused Library track button');
    check(!!document.querySelector('.artist-page [data-artist-credit="image"]') && !document.querySelector('.artist-page .artist-bio, .artist-page [data-artist-credit="bio"]'), 'image-only metadata still has a photo credit without an unused biography credit');

    const bioOnly = fixture.readyMetadata(group.name, { img: undefined, bio: 'A biography without a verified portrait.' });
    await fixture.publishMetadata(group.name, bioOnly);
    check(document.activeElement === libraryRow && !!document.querySelector('.artist-page .artist-avatar-fallback'), 'a bio-only arrival keeps focus and restores a neutral artist initial');
    check(document.querySelector('.artist-hero-img').getAttribute('src') === metadata.DEFAULT_ARTIST_PORTRAIT && !document.querySelector('.artist-page [data-artist-credit="image"]') && !!document.querySelector('.artist-page [data-artist-credit="bio"]'), 'bio-only metadata never falls back to an album cover or shows a misleading photo credit');

    goTab('tabHome');
    home.openHomeArtistsTab();
    const artistCard = [...document.querySelectorAll('#homeArtistsFullGrid [data-artist-open]')].find(card => card.dataset.artistOpen === group.key);
    artistCard.focus({ preventScroll: true });
    await fixture.publishMetadata(group.name, fixture.readyMetadata(group.name, { img: '/api/artist-image?id=card-update.jpg' }));
    check(document.activeElement === artistCard && artistCard.isConnected, 'automatic portraits update a focused Home artist card in place');

    goTab('tabLibrary');
    library.setLibView('tracks');
    const trackControl = document.querySelector('#librarySongList .song-item-play');
    trackControl.focus({ preventScroll: true });
    await fixture.publishMetadata(group.name, { key: group.name.toLowerCase(), status: 'ambiguous' });
    check(document.activeElement === trackControl && trackControl.isConnected, 'automatic arrivals never rebuild the ordinary Library track list');
    check(library.getArtistGroups().find(artist => artist.key === group.key)?.cover === '', 'an ambiguous refresh returns the artist to neutral instead of retaining an uncertain portrait');
    check(state.songs === original.songs && state.hfSongs === original.hf && state.addedSongs === original.added && state.songs.every((song, index) => song === original.members[index]), 'automatic metadata never reconstructs catalogue or local track objects');
    check(same(state.songs.map(song => [song.id, trackKey(song), song.artist, song.img]), original.identities) && same(manualQueue, original.queue), 'track attribution, identities, artwork and the queue are unchanged');
    check(localStorage.getItem('auraPlaylists') === original.playlists && original.playlists === fixture.playlist && localStorage.getItem('addedTracks') === original.local && document.getElementById('tabPlaylist').innerHTML === original.playlistMarkup, 'playlist bytes, playlist rendering and device-local storage remain untouched');
    check(localStorage.getItem('auraCloudArtists_v1') === original.directory && localStorage.getItem('auraHfArtists_v1') === original.manifest && storageWrites.every(key => key === metadata.ARTIST_METADATA_CACHE_KEY), 'automatic cache writes stay outside both artist directories and all saved-music keys');
    check(audioEvents.length === 0 && state.audio.getAttribute('src') === original.src && state.audio.playbackRate === original.rate && state.currentIndex === original.index && state.isPlaying === original.playing && state.audio.paused === original.paused && state.audio.currentTime >= original.time && navigator.mediaSession?.metadata === original.media, 'automatic metadata does not load, pause, seek, retitle or replace playback');
  } finally {
    Storage.prototype.setItem = nativeSet;
    for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.removeEventListener(event, onAudio);
    home.closeArtistDetail();
    home.showDefaultHomeView();
    goTab('tabHome');
  }
  check(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' && document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'automatic reading blocks preserve the black canvas without horizontal overflow');
  check(fixture.errors.length === 0, 'automatic metadata causes no uncaught browser errors');
  return { passed: checks.length, checks };
}

export async function runMetadataLookupRegressions() {
  const fixture = fixtureFor('main'), { check, checks } = assertions();
  const options = new URLSearchParams(location.search);
  if (options.get('metadata') !== 'held-ready' || options.has('cloud')) throw new Error('Use a fresh main ?metadata=held-ready fixture without cloud profiles.');
  const { state } = await import('/src/core/state.ts');
  const home = await import('/src/features/home.ts');
  const metadata = await import('/src/core/artistMetadata.ts');
  const { goTab } = await import('/src/ui/nav.ts');
  const name = fixture.directory.artists['old artist']?.name || 'Old Artist';
  await until(() => !state.catalogLoading && fixture.metadataPending.has(name.toLowerCase()), 'held canonical metadata GET');
  const members = state.songs.map(song => [song.id, song.artist, song.img]);
  goTab('tabHome'); home.openArtistDetail(name, false);
  const track = document.querySelector('#artistSongsList .artist-song-row');
  track.focus({ preventScroll: true });
  const latest = fixture.readyMetadata(name, { img: '/api/artist-image?id=cross-tab-winner.jpg', bio: 'Newer cross-tab details.' });
  await fixture.publishMetadata(name, latest);
  fixture.releaseMetadata(name);
  await flush();
  check(metadata.getAutomaticArtistMetadata(name)?.img === latest.metadata.img && document.querySelector('.artist-hero-img').getAttribute('src') === latest.metadata.img, 'a held older GET cannot overwrite a newer accepted cross-tab portrait');
  check(document.activeElement === track && track.isConnected, 'late request completion retains focus on the same artist track');
  check(document.querySelector('.artist-hero-name').textContent === name && same(state.songs.map(song => [song.id, song.artist, song.img]), members), 'late provider results never rename artists or tracks');
  const requests = fixture.requests.filter(request => request.path === '/api/artist-metadata');
  check(requests.filter(request => request.queryName === name).length === 1, 'opening an already in-flight artist reuses its single request');
  check(requests.every(request => request.method === 'GET' && request.appVisible && !!request.queryName), 'automatic GETs use canonical names only after the signed-in library is visible');

  const backgroundName = 'Directory Refresh Artist';
  await fixture.publish(fixture.cloud(1, backgroundName));
  await until(() => fixture.requests.some(request => request.path === '/api/artist-metadata' && request.queryName === backgroundName), 'metadata for a directory-driven artist rename');
  check(fixture.requests.find(request => request.path === '/api/artist-metadata' && request.queryName === backgroundName)?.intent === null, 'a directory-driven Home repaint does not turn background or visible work into an interactive lookup');
  home.closeArtistDetail();
  return { passed: checks.length, checks };
}

export async function runAdminMetadataRegressions() {
  const fixture = fixtureFor('admin'), { check, checks } = assertions();
  const catalog = await import('/src/core/catalog.ts');
  const metadata = await import('/src/core/artistMetadata.ts');
  const name = 'Sushin Shyam';
  const open = () => document.querySelector(`[data-artist-edit="${name}"]`).click();
  const save = async () => { document.getElementById('aemSaveBtn').click(); await until(() => document.getElementById('modalHost').hidden, 'artist profile save'); };
  await until(() => fixture.adminGateConfirmed && document.querySelector(`[data-artist-edit="${name}"]`), 'real admin gate and artist list');
  await until(() => fixture.requests.some(request => request.path === '/api/artist-metadata'), 'authorized automatic client activation');
  document.querySelector('[data-panel="panelArtists"]').click();
  open();
  const blankBio = document.getElementById('aemBio');
  blankBio.focus({ preventScroll: true });
  await fixture.publishMetadata(name, fixture.readyMetadata(name));
  check(blankBio.value === '' && document.getElementById('aemImgUrl').value === '' && document.getElementById('aemAvatarImg').getAttribute('src') === metadata.DEFAULT_ARTIST_PORTRAIT, 'automatic previews never populate a new artist’s manual biography or picture draft');
  check(document.activeElement === blankBio && blankBio.isConnected && !!document.querySelector('#aemAutomaticPreview [data-artist-credit="image"]'), 'an automatic preview preserves incoming admin draft focus');
  await save();
  let request = fixture.requests.filter(item => item.action === 'artistSet').at(-1);
  check(request.version === 0 && request.img === '' && request.bio === '' && request.imgOverride === false && request.bioOverride === false, 'an untouched new profile saves empty fields explicitly unlocked, not accidentally cleared');

  open();
  const bio = document.getElementById('aemBio'), nameInput = document.getElementById('aemName');
  nameInput.value = 'Unsaved artist draft';
  bio.value = 'Unsaved custom biography'; bio.dispatchEvent(new Event('input'));
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2XcAAAAASUVORK5CYII='), character => character.charCodeAt(0));
  const files = new DataTransfer(); files.items.add(new File([png], 'draft.png', { type: 'image/png' }));
  document.getElementById('aemFileInput').files = files.files;
  document.getElementById('aemFileInput').dispatchEvent(new Event('change'));
  await until(() => document.getElementById('aemAvatarImg').getAttribute('src').startsWith('data:image/png'), 'local portrait draft');
  const portraitDraft = document.getElementById('aemAvatarImg').getAttribute('src');
  bio.focus({ preventScroll: true });
  const refreshed = fixture.readyMetadata(name, { img: '/api/artist-image?id=admin-preview-update.jpg', bio: 'Refreshed automatic biography.' });
  await fixture.publishMetadata(name, refreshed);
  check(nameInput.value === 'Unsaved artist draft' && bio.value === 'Unsaved custom biography' && document.getElementById('aemAvatarImg').getAttribute('src') === portraitDraft && document.activeElement === bio, 'automatic refresh leaves the name, biography, local picture draft and keyboard focus intact');
  check(document.querySelector('#aemAutomaticPreview .adm-automatic-bio').textContent === refreshed.metadata.bio, 'only the separate read-only automatic preview refreshes');

  nameInput.value = name;
  document.getElementById('aemRenameTracks').checked = false;
  document.getElementById('aemClearPicBtn').click(); document.getElementById('aemClearBioBtn').click();
  await save();
  request = fixture.requests.filter(item => item.action === 'artistSet').at(-1);
  check(request.version === 1 && request.img === '' && request.bio === '' && request.imgOverride === true && request.bioOverride === true, 'explicit per-field clears preserve the captured edit version and manual blank intent');
  check(catalog.getArtistMeta(name).img === '' && catalog.getArtistMeta(name).bio === '' && document.querySelector(`[data-artist="${name}"] [data-artist-portrait]`).getAttribute('src') === metadata.DEFAULT_ARTIST_PORTRAIT, 'saved clears suppress automatic fields and restore the neutral portrait');

  open();
  document.getElementById('aemUseAutomaticImg').click(); document.getElementById('aemUseAutomaticBio').click();
  await save();
  request = fixture.requests.filter(item => item.action === 'artistSet').at(-1);
  check(request.version === 2 && request.imgOverride === false && request.bioOverride === false && request.img === '' && request.bio === '', 'Use automatic unlocks each field without copying provider values into the saved profile');
  check(catalog.getArtistMeta(name).img === refreshed.metadata.img && catalog.getArtistMeta(name).bio === refreshed.metadata.bio && fixture.directory.artists['sushin shyam'].version === 3, 'unlocked fields compose from the automatic cache while the profile version stays manual');

  open();
  const license = document.querySelector('#aemAutomaticPreview [data-artist-credit="bio"] a:last-of-type');
  license.focus({ preventScroll: true });
  await fixture.publishMetadata(name, fixture.readyMetadata(name, { img: refreshed.metadata.img, bio: 'A later read-only biography.' }));
  check(document.activeElement instanceof HTMLAnchorElement && document.activeElement.href === license.href && document.activeElement.closest('[data-artist-credit]')?.dataset.artistCredit === 'bio' && document.getElementById('aemBio').value === '', 'read-only preview refresh keeps the equivalent biography source focused without changing the draft');
  document.getElementById('aemCancelBtn').click();
  check(localStorage.getItem('auraPlaylists') === fixture.playlist && !fixture.requests.some(item => ['dispatch', 'bucketUpload', 'setSecret'].includes(item.action)), 'admin metadata checks never change playlists or submit unrelated admin operations');
  check(fixture.requests.filter(item => item.path === '/api/artist-metadata').every(item => item.gateConfirmed), 'all admin metadata requests wait for the real gate');
  check(fixture.errors.length === 0, 'admin previews and clears have no uncaught browser errors');
  return { passed: checks.length, checks };
}

export async function runAdminMetadataGateRegressions() {
  const fixture = fixtureFor('admin'), { check, checks } = assertions();
  if (!['held', 'denied'].includes(fixture.adminGate)) throw new Error('Use a fresh ?page=admin&admin-gate=held or denied fixture.');
  await until(() => fixture.requests.some(request => request.action === 'status'), 'admin authorization request');
  if (fixture.adminGate === 'denied') {
    await until(() => !document.getElementById('gateCard').hidden, 'server-denied admin lock');
    await flush();
    check(!fixture.adminGateConfirmed && !fixture.requests.some(request => request.path === '/api/artist-metadata'), 'a restored but server-denied admin session makes no metadata request');
  } else {
    const name = 'Sushin Shyam';
    await until(() => fixture.releaseAdminGate && document.querySelector(`[data-artist-edit="${name}"]`), 'held gate and painted artist list');
    document.querySelector('[data-panel="panelArtists"]').click();
    document.querySelector(`[data-artist-edit="${name}"]`).click();
    const bio = document.getElementById('aemBio'); bio.focus({ preventScroll: true });
    fixture.setMetadata(name, fixture.readyMetadata(name));
    await flush();
    check(!fixture.requests.some(request => request.path === '/api/artist-metadata') && document.querySelector('#aemAutomaticPreview').textContent.includes('admin access'), 'opening the editor cannot bypass a pending server admin gate');
    fixture.releaseAdminGate();
    await until(() => document.querySelector('#aemAutomaticPreview .adm-automatic-bio'), 'verified automatic preview after gate release');
    const requests = fixture.requests.filter(request => request.path === '/api/artist-metadata');
    check(requests.every(request => request.gateConfirmed) && requests.find(request => request.queryName === name)?.intent === 'view', 'the confirmed editor lookup carries view intent while gate authorization remains mandatory');
    check(document.activeElement === bio && bio.value === '' && bio.isConnected, 'gate release and first metadata arrival keep the untouched draft focused');
    document.getElementById('aemCancelBtn').click();
  }
  return { passed: checks.length, checks };
}

export async function runSignedOutMetadataRegressions() {
  const fixture = window.__auraFixture, { check, checks } = assertions();
  if (location.hostname !== '127.0.0.1' || !fixture || localStorage.getItem('auraSession_v2')) throw new Error('Use a fresh signed-out local fixture.');
  await flush();
  check(!fixture.requests.some(request => request.path === '/api/artist-metadata'), 'signed-out entry never starts automatic metadata requests');
  if (fixture.page === 'main') {
    check(!performance.getEntriesByType('resource').some(resource => /\/src\/(?:core\/artistMetadata|app|runtime)\.ts/.test(resource.name)), 'signed-out main entry does not import the metadata client or listening runtime');
    check(document.getElementById('musicApp').hidden && document.getElementById('musicApp').inert, 'signed-out metadata stays behind the lazy listening gate');
  } else check(!document.getElementById('gateCard').hidden, 'signed-out admin keeps its real access gate visible');
  return { passed: checks.length, checks };
}
