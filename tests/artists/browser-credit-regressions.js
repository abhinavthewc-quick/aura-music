/* Dedicated fresh fixtures only: ?credits&cloud (main) or ?page=admin&credits.
   Metadata and saves are mocked; track/audio requests remain on this machine. */
const flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}
const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const collaborations = [
  ['Hamsika Iyer & Yogi B', ['Hamsika Iyer', 'Yogi B']],
  ['Siri Xander & Arra Aria Khayal', ['Siri Xander', 'Arra Aria Khayal']],
  ['Narayani Gopan & Mithun Jayaraj', ['Narayani Gopan', 'Mithun Jayaraj']],
  ['Saurav Srisan & Tanisha Gnanavel', ['Saurav Srisan', 'Tanisha Gnanavel']],
  ['M. G. Sreekumar & Bindu Anirudhan', ['M. G. Sreekumar', 'Bindu Anirudhan']],
  ['A.R. Ameen, Vaishali Samant, Rakshita Suresh & Antara Nandy', ['A.R. Ameen', 'Vaishali Samant', 'Rakshita Suresh', 'Antara Nandy']],
  ['Manikandan Ayyappa, Chemban Vinod Jose, Himna Hilari & Hinitha Hilary', ['Manikandan Ayyappa', 'Chemban Vinod Jose', 'Himna Hilari', 'Hinitha Hilary']],
];
const fixtureFor = page => {
  if (location.hostname !== '127.0.0.1' || !new URLSearchParams(location.search).has('credits') || window.__auraFixture?.page !== page) {
    throw new Error('Use a fresh local ' + page + ' artist-credit fixture.');
  }
  return window.__auraFixture;
};
const assertions = () => {
  const checks = [];
  return { checks, check(condition, label) { if (!condition) throw new Error(label); checks.push(label); } };
};

export async function runArtistCreditRegressions() {
  const fixture = fixtureFor('main'), { checks, check } = assertions();
  const { state, trackKey } = await import('/src/core/state.ts');
  const catalog = await import('/src/core/catalog.ts');
  const library = await import('/src/features/library.ts');
  const home = await import('/src/features/home.ts');
  const player = await import('/src/features/player.ts');
  const metadata = await import('/src/core/artistMetadata.ts');
  const { goTab } = await import('/src/ui/nav.ts');
  await until(() => !state.catalogLoading && catalog.getCachedArtistDirectory().revision === 1 &&
    state.songs.some(song => song.title === 'Shared recording'), 'loaded collaboration catalogue and cloud profiles');
  const songs = state.songs.slice(), keys = songs.map(trackKey), before = JSON.stringify(songs);
  const profilesBefore = JSON.stringify(catalog.getCachedArtistDirectory());
  const shared = songs.find(song => song.title === 'Shared recording');
  const group = name => library.getArtistGroups().find(artist => artist.name === name);
  check(group('Anirudh Ravichander')?.songs.length === 5 && group('Dhanush')?.songs.length === 4,
    'Anirudh spelling variants form one artist; Dhanush stays a separate person with all three collaborations');
  check(group('Anirudh Ravichander').songs.includes(shared) && group('Dhanush').songs.includes(shared),
    'both artist pages reference the same recording object, not duplicate library tracks');
  check(group('Anirudh Ravichander').songs.filter(song => song.title === 'Repeated credit').length === 1 &&
    group('Dhanush').songs.filter(song => song.title === 'Repeated credit').length === 1,
    'repeated aliases count a collaborative recording once per artist');
  for (const [combined, names] of collaborations) {
    check(!group(combined), combined + ' is not a fake combined artist');
    for (const name of names) check(group(name)?.songs.length === 1, name + ' receives the collaborative recording independently');
  }
  check(['Earth, Wind & Fire', 'Strangers & Friends', 'Local One & Local Two', 'Edited One & Edited Two'].every(name => !!group(name)),
    'bands, saved joint projects and intentional track corrections remain intact');
  check(!group('Earth') && !group('Local One') && !group('Edited One') && !group('MG'),
    'filename evidence cannot invent performers, short-name aliases or split protected owners');
  check(group('Anirudh Ravichander').profile.img === '/api/artist-image?id=anirudh.jpg' && !group('Dhanush').cover,
    'the saved Anirudh portrait remains private to his identity, not copied to Dhanush');
  check(same(home.getAllArtists().map(artist => artist.key), library.getArtistGroups().map(artist => artist.key)),
    'Home and Library use identical split identities and ordering');
  home.renderArtistsFullGrid();
  const homeKeys = [...document.querySelectorAll('#homeArtistsFullGrid [data-artist-open]')].map(card => card.dataset.artistOpen);
  check(new Set(homeKeys).size === homeKeys.length && homeKeys.length === library.getArtistGroups().length,
    'Home renders one card per artist, with no collaboration duplicates');
  library.renderStatsPanel();
  const artistStat = [...document.querySelectorAll('#statsPanel .stats-cell')].find(cell => cell.querySelector('.stat-label')?.textContent === 'Artists');
  check(artistStat?.querySelector('.stat-num')?.textContent === String(library.getArtistGroups().length),
    'artist statistics count the split identities without adding library recordings');

  state.audio.muted = true;
  player.playSong(state.songs.indexOf(shared));
  await state.audio.play();
  state.audio.currentTime = 23;
  await flush();
  const audio = { src: state.audio.getAttribute('src'), index: state.currentIndex, time: state.audio.currentTime, rate: state.audio.playbackRate };
  let resets = 0;
  const reset = () => resets++;
  for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.addEventListener(event, reset);
  const originalPlay = window.playSong, calls = [];
  try {
    goTab('tabHome');
    home.openArtistDetail(group('Dhanush').key, false);
    check(document.querySelector('.artist-hero-name')?.textContent === 'Dhanush' &&
      document.querySelectorAll('#artistSongsList .artist-song-row').length === 4,
      'Home opens Dhanush with solo and collaborative songs, not Anirudh’s solo catalogue');
    goTab('tabLibrary');
    library.setLibView('artists');
    library.openArtist(library.getArtistGroups().findIndex(artist => artist.name === 'Dhanush'));
    check(document.querySelector('.artist-page-name')?.textContent === 'Dhanush' &&
      document.querySelectorAll('.artist-page .song-item').length === 4,
      'Library opens the same four Dhanush recordings');
    window.playSong = (...args) => calls.push(args);
    const sharedRow = [...document.querySelectorAll('.artist-page .song-item')].find(row => row.querySelector('.song-title')?.textContent === shared.title);
    sharedRow?.querySelector('.song-item-play')?.click();
    check(calls.length === 1 && calls[0][0] === state.songs.indexOf(shared),
      'a shared recording’s play control uses its original library index exactly once');
    window.playSong = originalPlay;
    await fixture.publishMetadata('Dhanush', fixture.readyMetadata('Dhanush', { img: '/api/artist-image?id=dhanush-automatic.jpg', bio: 'A distinct verified performer.' }));
    check(group('Dhanush').cover === '/api/artist-image?id=dhanush-automatic.jpg' &&
      group('Anirudh Ravichander').cover === '/api/artist-image?id=anirudh.jpg',
      'automatic metadata is requested/composed for Dhanush independently, leaving Anirudh’s saved portrait unchanged');
    check(document.querySelector('.artist-page-avatar')?.getAttribute('src') === group('Dhanush').cover &&
      document.querySelector('.artist-hero-img')?.getAttribute('src') === group('Dhanush').cover,
      'automatic arrival refreshes both open artist portraits without replacing the selected person');
    check(document.getElementById('currentArtist').textContent === shared.artist && document.getElementById('fullArtist').textContent === shared.artist,
      'player attribution still shows the original complete collaboration credit');
    check(!navigator.mediaSession || navigator.mediaSession.metadata.artist === shared.artist,
      'media-session attribution retains both collaborators');
    check(resets === 0 && !state.audio.paused && state.isPlaying && state.audio.getAttribute('src') === audio.src &&
      state.currentIndex === audio.index && state.audio.currentTime >= audio.time && state.audio.playbackRate === audio.rate,
      'artist navigation and enrichment never reload, pause, seek or replace the playing recording');
  } finally {
    window.playSong = originalPlay;
    for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.removeEventListener(event, reset);
    state.audio.pause();
    player.updatePlayState();
    home.closeArtistDetail();
  }
  const evidenceTrack = { id: 'fixture:credit-evidence', title: 'Ephemeral evidence',
    artist: 'Evidence Performer & Evidence Guest', hfPath: 'Unrelated Source - Evidence.opus' };
  state.songs.push(evidenceTrack);
  try {
    const originalGroups = library.getArtistGroups();
    check(originalGroups.some(artist => artist.name === evidenceTrack.artist) && library.getArtistGroups() === originalGroups,
      'an unsupported credit remains intact and repeated renders reuse the grouping snapshot');
    evidenceTrack.hfPath = 'Evidence Performer - Evidence.opus';
    const supportedGroups = library.getArtistGroups();
    check(supportedGroups !== originalGroups && !supportedGroups.some(artist => artist.name === evidenceTrack.artist) &&
      ['Evidence Performer', 'Evidence Guest'].every(name => supportedGroups.some(artist => artist.name === name && artist.songs[0] === evidenceTrack)),
      'an in-place filename evidence change invalidates cached grouping without rewriting the recording');
  } finally { state.songs.pop(); }
  check(same(state.songs.map(trackKey), keys) && state.songs.every((song, index) => song === songs[index]) && JSON.stringify(state.songs) === before,
    'grouping and automatic details preserve every track object, ID, artwork and persistence key');
  check(localStorage.getItem('auraPlaylists') === fixture.playlist && JSON.stringify(catalog.getCachedArtistDirectory()) === profilesBefore,
    'saved playlists and the artist directory remain byte-for-byte unchanged');
  check(!fixture.requests.some(request => request.path === '/api/artist-metadata' && collaborations.some(([name]) => name === request.queryName)),
    'automatic enrichment never requests a fake combined collaboration identity');
  check(!fixture.requests.some(request => ['artistSet', 'dispatch', 'search', 'bucketUpload', 'setSecret'].includes(request.action)),
    'listener credit checks never save profiles, submit songs, search externally or change integrations');
  check(metadata.getArtistMetadataRevision() >= 1 && fixture.errors.length === 0,
    'split-identity metadata refresh finishes without uncaught browser errors');
  check(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    'the true-black artist UI retains responsive bounds');
  return { passed: checks.length, checks };
}

export async function runAdminArtistCreditRegressions() {
  const fixture = fixtureFor('admin'), { checks, check } = assertions();
  const catalog = await import('/src/core/catalog.ts');
  const { buildArtistGroups } = await import('/src/core/artistGroups.ts');
  const before = JSON.stringify(fixture.tracks), keys = fixture.tracks.map(track => track.id);
  const card = name => [...document.querySelectorAll('#artistGrid .adm-acard')].find(element => element.dataset.artist === name);
  const open = name => card(name).querySelector('[data-artist-edit]').click();
  const save = async () => { document.getElementById('aemSaveBtn').click(); await until(() => document.getElementById('modalHost').hidden, 'mocked artist save'); };
  const view = async name => { card(name).querySelector('[data-artist-view]').click(); await flush(); };
  const libraryPaths = () => [...document.querySelectorAll('#libGrid .adm-lcard')].map(element => element.dataset.path);
  await until(() => fixture.adminGateConfirmed && card('Dhanush'), 'authorized admin artist list');
  document.querySelector('[data-panel="panelArtists"]').click();
  const listeners = buildArtistGroups(catalog.applyArtistTrackOverrides(fixture.tracks), fixture.directory.artists, {
    authoritativeProfiles: fixture.directory.artists, authoritativeNames: Object.values(fixture.directory.trackArtists),
  });
  for (const group of listeners) {
    const found = document.querySelector(`[data-artist-identity="${CSS.escape(group.key)}"]`);
    check(!!found && found.querySelector('.adm-acard-count').textContent.startsWith(group.songs.length + ' '),
      group.name + ' has the same identity and track count in admin and listener views');
  }
  check(card('Anirudh Ravichander').querySelector('.adm-acard-count').textContent.startsWith('5 ') &&
    card('Dhanush').querySelector('.adm-acard-count').textContent.startsWith('4 '),
    'admin consolidates Anirudh spellings and credits Dhanush separately, including their collaborations');
  check(!card('Anirudh Ravichander & Dhanush') && !card('Anirudh Ravichandran') && collaborations.every(([combined]) => !card(combined)),
    'admin no longer creates extra artist cards for the confirmed collaboration credits');
  check(card('Anirudh Ravichander').querySelector('[data-artist-portrait]').getAttribute('src') === '/api/artist-image?id=anirudh.jpg' &&
    card('Dhanush').querySelector('[data-artist-portrait]').getAttribute('src') !== '/api/artist-image?id=anirudh.jpg',
    'admin preserves the saved Anirudh portrait without giving it to Dhanush');
  await view('Dhanush');
  const expectedDhanush = fixture.tracks.filter(track => track.artist === 'Dhanush' || /^Anirudh .*Dhanush$/.test(track.artist)).map(track => track.hfPath);
  check(same(libraryPaths().sort(), expectedDhanush.sort()),
    'admin Tracks uses exact split membership and excludes the unrelated Dhanush Ensemble');
  document.querySelector('[data-panel="panelArtists"]').click();
  await view('Anirudh Ravichander');
  const expectedAnirudh = fixture.tracks.filter(track => /^Anirudh Ravichand(?:er|ran)/.test(track.artist)).map(track => track.hfPath);
  check(same(libraryPaths().sort(), expectedAnirudh.sort()),
    'admin Tracks includes every spelling variant and collaboration without fuzzy substring matching');
  const input = document.getElementById('libSearchInput'); input.value = ''; input.dispatchEvent(new Event('input'));
  await until(() => libraryPaths().length === fixture.tracks.length, 'ordinary library search resumes');
  check(libraryPaths().length === fixture.tracks.length, 'editing the search exits exact artist filtering and restores the full unchanged library');
  document.querySelector('[data-panel="panelArtists"]').click();
  open('Dhanush');
  check(document.querySelectorAll('#aemSongsList .adm-artist-song-item').length === 4 && document.getElementById('aemRenameTracks').checked &&
    document.getElementById('aemRenameTracks').parentElement.textContent.includes('1'),
    'Dhanush’s editor shows four recordings but clearly limits batch rename to his one whole-credit track');
  document.getElementById('aemRenameTracks').checked = false;
  document.getElementById('aemBio').value = 'Dhanush profile, independent of Anirudh.';
  await save();
  check(fixture.directory.artists.dhanush.name === 'Dhanush' && fixture.directory.artists.dhanush.bio === 'Dhanush profile, independent of Anirudh.' &&
    fixture.directory.artists['anirudh ravichander'].version === 1 && !fixture.directory.artists['anirudh ravichander & dhanush'],
    'a collaborator profile save owns only that person, not the joint recording or another saved profile');
  await view('Arra Aria Khayal');
  const collaboratorPaths = libraryPaths();
  document.querySelector('[data-panel="panelArtists"]').click();
  open('Arra Aria Khayal');
  const rename = document.getElementById('aemRenameTracks');
  check(rename.disabled && !rename.checked && document.querySelectorAll('#aemSongsList .adm-artist-song-item').length === 1,
    'a collaboration-only artist can be edited without offering a destructive whole-credit batch rename');
  await save();
  const request = fixture.requests.filter(item => item.action === 'artistSet').at(-1);
  check(request.artistKey === 'arra aria khayal' && request.renameTracks === false && request.img === '' && request.imgOverride === false &&
    request.bio === '' && request.bioOverride === false,
    'a new collaborator saves its own key with automatic fields unlocked and no copied artwork or credit rewrite');
  check(card('Siri Xander') && card('Arra Aria Khayal') && !card('Siri Xander & Arra Aria Khayal'),
    'saving a collaborator profile keeps the same independent artist groups');
  check(collaboratorPaths.length === 1 && same(libraryPaths(), collaboratorPaths),
    'an exact Tracks filter survives a new collaborator profile changing its display identity to a saved owner');
  for (const key of ['alex north', 'second alex']) {
    document.querySelector(`[data-artist-identity="profile:${key}"] [data-artist-view]`).click();
    await flush();
    check(libraryPaths().length === 0, 'a zero-track same-name owner cannot borrow the unresolved recording: ' + key);
    document.querySelector('[data-panel="panelArtists"]').click();
  }
  document.querySelector('[data-artist-identity="unresolved:alex north"] [data-artist-view]').click();
  await flush();
  check(same(libraryPaths(), [fixture.tracks.find(track => track.title === 'Ambiguous owner recording').hfPath]),
    'an unresolved same-name Tracks action selects its recording by display identity, not a saved profile key');
  document.querySelector('[data-panel="panelArtists"]').click();
  for (const [key, bio] of [['alex north', 'First owner biography.'], ['second alex', 'Second owner biography.']]) {
    document.querySelector(`[data-artist-identity="profile:${key}"] [data-artist-edit]`).click();
    check(document.getElementById('aemBio').value === bio, 'duplicate display labels open the correct saved owner: ' + key);
    document.getElementById('aemCancelBtn').click();
  }
  document.querySelector('[data-artist-identity="unresolved:alex north"] [data-artist-edit]').click();
  check(document.getElementById('aemBio').value === '' && document.getElementById('aemAutomaticPreview').textContent.includes('ownership is unclear'),
    'an unresolved same-name recording does not borrow the owner whose saved key equals its normalized label');
  document.getElementById('aemCancelBtn').click();
  open('Local One & Local Two');
  check(document.getElementById('aemAvatarImg').getAttribute('src') === '/api/artist-image?id=joint.jpg' &&
    document.querySelectorAll('#aemSongsList .adm-artist-song-item').length === 1,
    'the intentionally saved joint project retains its own portrait and complete recording');
  document.getElementById('aemCancelBtn').click();
  open('Anirudh Ravichander');
  const savedPortrait = document.getElementById('aemAvatarImg').getAttribute('src');
  document.getElementById('aemName').value = 'Reviewed Anirudh';
  await save();
  check(fixture.directory.trackArtists['vid:bcdefghijkl'] === 'Reviewed Anirudh' &&
    ['lmnopqrstu2', 'lmnopqrstu3', 'lmnopqrstu4'].every(id => !fixture.directory.trackArtists['vid:' + id]),
    'an intentional batch rename changes only owned whole credits, never erasing Dhanush from a collaboration');
  check(fixture.directory.artists['anirudh ravichander'].img === savedPortrait && card('Reviewed Anirudh').querySelector('.adm-acard-count').textContent.startsWith('5 ') &&
    card('Dhanush').querySelector('.adm-acard-count').textContent.startsWith('4 '),
    'renaming a saved artist retains the portrait and all split memberships');
  check(JSON.stringify(fixture.tracks) === before && same(fixture.tracks.map(track => track.id), keys) && localStorage.getItem('auraPlaylists') === fixture.playlist,
    'admin grouping and mocked profile saves leave catalogue objects, recording IDs, artwork and playlist bytes unchanged');
  check(!fixture.requests.some(item => ['dispatch', 'search', 'bucketUpload', 'setSecret', 'batchManifestSet'].includes(item.action)) &&
    fixture.requests.filter(item => item.path === '/api/artist-metadata').every(item => item.gateConfirmed),
    'admin checks use only intentional mocked profile saves and gated metadata, never music submissions or integration changes');
  check(fixture.errors.length === 0 && getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' &&
    document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    'split admin artists retain the true-black responsive UI without uncaught errors');
  return { passed: checks.length, checks };
}
