/* Isolated local fixture. Real IndexedDB/files/player, with explicitly delayed
   callbacks and denied storage writes; no live accounts or remote mutations. */
const $ = id => document.getElementById(id);
const flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}
const tail = async blob => new Uint8Array(await blob.slice(-1).arrayBuffer())[0];

export async function runLocalStorageRaceRegressions() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'main') throw new Error('Use the dedicated local main fixture.');
  const checks = [], cleanup = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const { state, rebuildSongs } = await import('/src/core/state.ts');
  const library = await import('/src/features/library.ts');
  const playlists = await import('/src/features/playlists.ts');
  const player = await import('/src/features/player.ts');
  const { getPlaybackIntent } = await import('/src/core/playbackIntent.ts');
  await (await import('/src/app.ts')).ready;
  await until(() => !state.catalogLoading && state.songs.some(song => song.isLocal && song.url), 'hydrated fixture');
  const sound = await fetch('/__fixture_audio.wav').then(response => response.blob());
  const file = (name, byte = 127) => new File([sound.slice(0, -1), Uint8Array.of(byte)], name + '.wav', { type: 'audio/wav' });
  const current = () => state.songs[state.currentIndex];
  const local = () => state.addedSongs.find(song => song.id === 'fixture:local');
  const savedTracks = () => JSON.parse(localStorage.getItem('addedTracks'));
  const hasToast = text => $('toastContainer').textContent.includes(text);
  state.audio.muted = true;
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  cleanup.push(() => { window.confirm = originalConfirm; });
  const play = async id => {
    player.playSong(state.songs.findIndex(song => String(song.id) === String(id)));
    await state.audio.play();
    await flush();
  };
  const watchPlayback = () => {
    const before = { id: current()?.id, source: state.audio.getAttribute('src'), paused: state.audio.paused,
      position: state.audio.currentTime, rate: state.audio.playbackRate, intent: getPlaybackIntent() };
    let resets = 0;
    const events = ['emptied', 'loadstart', 'pause', 'seeking'];
    const count = () => resets++;
    events.forEach(event => state.audio.addEventListener(event, count));
    const stop = () => events.forEach(event => state.audio.removeEventListener(event, count));
    cleanup.push(stop);
    return { before, stop, unchanged: () => resets === 0 && current()?.id === before.id && state.audio.getAttribute('src') === before.source &&
      state.audio.paused === before.paused && state.audio.currentTime >= before.position && state.audio.playbackRate === before.rate && getPlaybackIntent() === before.intent };
  };
  const denyWrites = key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) {
      if (this === localStorage && name === key) throw new DOMException('Isolated storage denial', 'QuotaExceededError');
      return original.call(this, name, value);
    };
    const restore = () => { Storage.prototype.setItem = original; };
    cleanup.push(restore); return restore;
  };
  const holdPlaylistWrites = () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks'), pending = [];
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request(name, work) {
      if (name !== 'aura-playlists-write') throw new Error('Unexpected fixture lock: ' + name);
      return new Promise((resolve, reject) => pending.push(() => { try { resolve(work()); } catch (error) { reject(error); } }));
    } } });
    const restore = () => { if (descriptor) Object.defineProperty(navigator, 'locks', descriptor); else delete navigator.locks; };
    cleanup.push(restore);
    return { pending, restore, release: () => pending.shift()() };
  };
  const picker = open => {
    const original = HTMLInputElement.prototype.click;
    let input;
    HTMLInputElement.prototype.click = function() { if (this.type === 'file') input = this; else original.call(this); };
    try { open(); } finally { HTMLInputElement.prototype.click = original; }
    if (!input || !input.accept.includes('audio')) throw new Error('The real local-audio picker was not opened');
    return selected => {
      const transfer = new DataTransfer(); transfer.items.add(selected); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
  };
  const observeBlobWrites = () => {
    const originals = { put: IDBObjectStore.prototype.put, delete: IDBObjectStore.prototype.delete }, completed = [];
    for (const name of ['put', 'delete']) IDBObjectStore.prototype[name] = function(...args) {
      const request = originals[name].apply(this, args);
      if (this.transaction.db.name === library.LOCAL_DB_NAME) {
        const entry = { operation: name, id: name === 'put' ? args[1] : args[0] };
        this.transaction.addEventListener('complete', () => completed.push(entry), { once: true });
      }
      return request;
    };
    const restore = () => { Object.assign(IDBObjectStore.prototype, originals); };
    cleanup.push(restore); return { completed, restore };
  };
  const holdLocalOpen = ordinal => {
    const original = indexedDB.open;
    let opens = 0, release;
    indexedDB.open = function(...args) {
      const request = original.apply(this, args);
      if (args[0] !== library.LOCAL_DB_NAME || ++opens !== ordinal) return request;
      const delayed = { get result() { return request.result; }, get error() { return request.error; }, onsuccess: null, onerror: null, onupgradeneeded: null };
      request.onsuccess = () => { release = () => delayed.onsuccess?.({ target: delayed }); };
      request.onerror = () => delayed.onerror?.({ target: delayed });
      request.onupgradeneeded = () => delayed.onupgradeneeded?.({ target: delayed });
      return delayed;
    };
    const restore = () => { indexedDB.open = original; };
    cleanup.push(restore); return { restore, ready: () => !!release, release: () => release() };
  };
  const holdLocalRead = id => {
    const original = IDBObjectStore.prototype.get;
    let captured = false, release;
    IDBObjectStore.prototype.get = function(key) {
      const request = original.call(this, key);
      if (captured || this.transaction.db.name !== library.LOCAL_DB_NAME || String(key) !== String(id)) return request;
      captured = true;
      const delayed = { get result() { return request.result; }, get error() { return request.error; }, onsuccess: null, onerror: null };
      request.onsuccess = () => { release = () => delayed.onsuccess?.({ target: delayed }); };
      request.onerror = () => delayed.onerror?.({ target: delayed });
      return delayed;
    };
    const restore = () => { IDBObjectStore.prototype.get = original; };
    cleanup.push(restore); return { restore, ready: () => !!release, release: () => release() };
  };
  const makeLocal = async suffix => {
    const song = { id: 'fixture:storage-' + suffix, title: 'Storage ' + suffix, artist: 'Local fixture', isLocal: true,
      img: '/src/assets/brand-logo.webp', duration: 120, url: URL.createObjectURL(sound) };
    await library.saveLocalBlob(song.id, sound);
    state.addedSongs.push(song); check(library.persistAddedSongs(), 'local race setup persists its metadata'); rebuildSongs();
    return song;
  };
  try {
    await play(local().id);
    state.audio.currentTime = 16; state.audio.playbackRate = 1.25; await flush();
    const originalLibrary = localStorage.getItem('addedTracks'), originalSong = local(), originalBlob = await library.getLocalBlob(originalSong.id);
    const originalPlaylists = localStorage.getItem('auraPlaylists');
    check(originalPlaylists === fixture.playlist && !localStorage.getItem('auraPlaylists_backup_v1'), 'startup and hydration preserve legacy playlist bytes without migration');
    library.openEditModal(null, originalSong.id); $('editTitleInput').value = 'Recovered local title'; $('editArtistInput').value = 'Recovered local artist';
    const restoreBackup = denyWrites('auraPlaylists_backup_v1'), backupPlayback = watchPlayback();
    await library.saveEditedTrack(); await flush();
    check(localStorage.getItem('auraPlaylists') === originalPlaylists && !localStorage.getItem('auraPlaylists_backup_v1') &&
      localStorage.getItem('addedTracks') === originalLibrary && local() === originalSong, 'denied mandatory backup aborts both playlist migration and track edits');
    check($('editTrackModal').classList.contains('active') && $('editTitleInput').value === 'Recovered local title' && backupPlayback.unchanged(), 'backup failure keeps the draft and current audio available for retry');
    restoreBackup(); backupPlayback.stop();
    await library.saveEditedTrack(); await flush();
    const migrated = JSON.parse(localStorage.getItem('auraPlaylists'));
    check(migrated.version === 2 && migrated.playlists[0].tracks.at(-1).ref === 'id:fixture:local' &&
      localStorage.getItem('auraPlaylists_backup_v1') === originalPlaylists && local().title === 'Recovered local title', 'explicit edit retry migrates once with byte-exact backup and unchanged local membership');

    const heldEdit = holdPlaylistWrites(), beforeEdit = local();
    library.openEditModal(null, beforeEdit.id); $('editTitleInput').value = 'Canceled stale title';
    const canceledEdit = library.saveEditedTrack(); await until(() => heldEdit.pending.length === 1, 'queued stale edit');
    library.closeEditModal(); library.openEditModal(null, beforeEdit.id); $('editTitleInput').value = 'Newer unsaved draft';
    heldEdit.release(); await canceledEdit; heldEdit.restore(); await flush();
    check(local() === beforeEdit && $('editTrackModal').classList.contains('active') && $('editTitleInput').value === 'Newer unsaved draft', 'a delayed canceled edit cannot save or close a newer editor for the same track');
    library.closeEditModal();

    const heldPlaylist = holdPlaylistWrites();
    playlists.openPlaylistModal('fixture-playlist'); $('playlistTitleInput').value = 'Explicit earlier playlist edit';
    const earlierSubmit = playlists.submitPlaylistModal(); await until(() => heldPlaylist.pending.length === 1, 'queued playlist edit');
    playlists.closePlaylistModal(); playlists.openPlaylistModal(); $('playlistTitleInput').value = 'Newer playlist draft';
    const tabBefore = document.querySelector('.tab-content.active')?.id;
    heldPlaylist.release(); await earlierSubmit; heldPlaylist.restore(); await flush();
    check(JSON.parse(localStorage.getItem('auraPlaylists')).playlists[0].title === 'Explicit earlier playlist edit' &&
      $('playlistModal').classList.contains('active') && $('playlistTitleInput').value === 'Newer playlist draft' &&
      document.querySelector('.tab-content.active')?.id === tabBefore, 'an earlier playlist save cannot close, replace or navigate away from a newer modal');
    playlists.closePlaylistModal();

    const originalReader = window.FileReader, pendingImages = [];
    window.FileReader = class extends originalReader {
      readAsDataURL(selected) {
        const finish = this.onload; this.onload = event => pendingImages.push(() => finish.call(this, event));
        super.readAsDataURL(selected);
      }
    };
    const restoreReader = () => { window.FileReader = originalReader; }; cleanup.push(restoreReader);
    library.openEditModal(null, local().id);
    const cover = new DataTransfer(); cover.items.add(new File(['fixture cover'], 'cover.png', { type: 'image/png' }));
    $('editCoverFileInput').files = cover.files; $('editCoverFileInput').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => pendingImages.length === 1, 'delayed cover FileReader');
    library.closeEditModal(); library.openEditModal(null, local().id);
    const latestCover = { image: library.editPendingImg, preview: $('editCoverPreview').getAttribute('src'), url: $('editImgUrlInput').value };
    pendingImages.shift()(); await flush(); restoreReader();
    check(library.editPendingImg === latestCover.image && $('editCoverPreview').getAttribute('src') === latestCover.preview &&
      $('editImgUrlInput').value === latestCover.url, 'a stale FileReader cannot replace artwork in a newer track editor');
    library.closeEditModal();

    const beforeDeniedEdit = local(), storedBeforeDeniedEdit = localStorage.getItem('addedTracks');
    library.openEditModal(null, local().id); $('editTitleInput').value = 'Denied metadata title';
    const restoreEditWrite = denyWrites('addedTracks'), editPlayback = watchPlayback();
    await library.saveEditedTrack(); await flush();
    check(local() === beforeDeniedEdit && localStorage.getItem('addedTracks') === storedBeforeDeniedEdit &&
      $('editTrackModal').classList.contains('active') && editPlayback.unchanged(), 'denied metadata persistence keeps the old record, draft, source and playhead');
    restoreEditWrite(); editPlayback.stop(); library.closeEditModal();

    const failedWrites = observeBlobWrites(), restoreFileWrite = denyWrites('addedTracks'), beforeReplacement = local(), replacementPlayback = watchPlayback();
    picker(() => library.restoreLocalFile(String(local().id)))(file('Denied replacement', 126));
    await until(() => failedWrites.completed.filter(write => write.operation === 'put').length === 2, 'replacement blob rollback');
    await flush();
    check(await tail(await library.getLocalBlob(local().id)) === await tail(originalBlob) && local() === beforeReplacement &&
      localStorage.getItem('addedTracks') === storedBeforeDeniedEdit, 'failed replacement restores the exact previous blob and leaves metadata unchanged');
    check(replacementPlayback.unchanged(), 'replacement rollback does not reset current native playback');
    restoreFileWrite(); failedWrites.restore(); replacementPlayback.stop();

    const failedImportWrites = observeBlobWrites(), restoreImportWrite = denyWrites('addedTracks'), idsBeforeImport = state.addedSongs.map(song => song.id);
    picker(() => library.importLocalAudio())(file('Denied new import', 125));
    await until(() => failedImportWrites.completed.some(write => write.operation === 'delete'), 'new import blob rollback');
    const failedId = failedImportWrites.completed.find(write => write.operation === 'put').id;
    check(await library.getLocalBlob(failedId) === undefined && JSON.stringify(state.addedSongs.map(song => song.id)) === JSON.stringify(idsBeforeImport) &&
      localStorage.getItem('addedTracks') === storedBeforeDeniedEdit, 'failed new import removes its orphaned blob without adding a phantom library record');
    restoreImportWrite(); failedImportWrites.restore();

    for (const paused of [false, true]) {
      await play(local().id); state.audio.currentTime = 22; state.audio.playbackRate = 1.25;
      if (paused) { state.audio.pause(); player.updatePlayState(); }
      await flush();
      const heldFile = holdLocalOpen(2), beforeFile = local(), filePlayback = watchPlayback();
      picker(() => library.restoreLocalFile(String(beforeFile.id)))(file(paused ? 'Paused replacement' : 'Playing replacement', paused ? 123 : 124));
      await until(heldFile.ready, 'delayed replacement write'); heldFile.restore();
      library.openEditModal(null, local().id); $('editTitleInput').value = paused ? 'Paused fresh metadata' : 'Playing fresh metadata';
      await library.saveEditedTrack();
      const favorite = !local().favorite; library.toggleFavorite(null, String(local().id));
      heldFile.release(); await until(() => local().url !== beforeFile.url && local().title.includes('fresh metadata'), 'committed replacement'); await flush();
      check(local().favorite === favorite && current() === local() && filePlayback.unchanged(), `${paused ? 'paused' : 'playing'} restoration retains post-await metadata/favorites and the selected source, intent and playhead`);
      check((await fetch(filePlayback.before.source)).ok && local().url !== filePlayback.before.source, `${paused ? 'paused' : 'playing'} audio keeps its retired blob URL usable until the source changes`);
      check(savedTracks().find(song => song.id === local().id).url === undefined && savedTracks().find(song => song.id === local().id).missing === undefined,
        'successful restoration never serializes session-only blob URLs or missing flags');
      filePlayback.stop();
      await play(fixture.tracks[0].id);
      const revoked = await fetch(filePlayback.before.source).then(() => false, () => true);
      check(revoked, 'retired local URLs are released after the native source actually changes');
    }

    const removedAtPicker = await makeLocal('picker-deleted');
    const deliverRemoved = picker(() => library.restoreLocalFile(String(removedAtPicker.id)));
    await library.deleteTrack(null, removedAtPicker.id); deliverRemoved(file('Too late picker', 122));
    await until(() => hasToast('removed while the file picker was open'), 'retired file-picker refusal');
    check(!state.addedSongs.some(song => song.id === removedAtPicker.id) && !savedTracks().some(song => song.id === removedAtPicker.id) &&
      await library.getLocalBlob(removedAtPicker.id) === undefined, 'a file picker opened before deletion cannot resurrect the deleted track or blob');

    const removedDuringWrite = await makeLocal('write-deleted'), heldDeletion = holdLocalOpen(2);
    picker(() => library.restoreLocalFile(String(removedDuringWrite.id)))(file('Too late write', 121));
    await until(heldDeletion.ready, 'replacement awaiting database'); heldDeletion.restore();
    const deletion = library.deleteTrack(null, removedDuringWrite.id);
    await play(fixture.tracks[2].id); state.audio.currentTime = 26; await flush();
    const deletionPlayback = watchPlayback(); heldDeletion.release(); await deletion; await flush();
    check(!state.addedSongs.some(song => song.id === removedDuringWrite.id) && !savedTracks().some(song => song.id === removedDuringWrite.id) &&
      await library.getLocalBlob(removedDuringWrite.id) === undefined, 'deletion during a file write serializes rollback before final blob removal without resurrection');
    check(deletionPlayback.unchanged(), 'a superseded file write and deletion preserve the newer catalogue playback'); deletionPlayback.stop();

    for (const action of ['restore', 'delete']) {
      const hydratingSong = await makeLocal('hydrate-' + action), heldRead = holdLocalRead(hydratingSong.id);
      const hydrating = library.hydrateLocalTracks(); await until(heldRead.ready, 'stale hydration read'); heldRead.restore();
      let replacementURL;
      if (action === 'restore') {
        picker(() => library.restoreLocalFile(String(hydratingSong.id)))(file('New hydration winner', 120));
        await until(() => state.addedSongs.find(song => song.id === hydratingSong.id)?.url !== hydratingSong.url, 'newer hydration replacement');
        replacementURL = state.addedSongs.find(song => song.id === hydratingSong.id).url;
      } else await library.deleteTrack(null, hydratingSong.id);
      heldRead.release(); await hydrating; await flush();
      const remaining = state.addedSongs.find(song => song.id === hydratingSong.id);
      check(action === 'restore' ? remaining?.url === replacementURL && !remaining.missing && await tail(await library.getLocalBlob(hydratingSong.id)) === 120
        : !remaining && !state.songs.some(song => song.id === hydratingSong.id) && await library.getLocalBlob(hydratingSong.id) === undefined,
      `stale hydration cannot overwrite a newer ${action === 'restore' ? 'file replacement' : 'track deletion'}`);
    }
    check(fixture.errors.length === 0, 'local edit/storage races have no uncaught browser errors');
    return { page: 'main', passed: checks.length, checks };
  } finally {
    cleanup.reverse().forEach(restore => restore());
    library.closeEditModal(); playlists.closePlaylistModal(); state.audio.pause();
  }
}
