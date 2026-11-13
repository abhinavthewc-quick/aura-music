/* Dedicated local fixture: exercise delayed IndexedDB deletion and catalogue /
   metadata continuations against the real player. No remote mutations. */
const flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}

export async function runLibraryRaceRegressions() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'main') throw new Error('Use the local main fixture.');
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const { state, setHfTracks, rebuildSongs } = await import('/src/core/state.ts');
  const library = await import('/src/features/library.ts');
  const player = await import('/src/features/player.ts');
  const radio = await import('/src/features/radio.ts');
  const { getPlaybackIntent } = await import('/src/core/playbackIntent.ts');
  const deep = await import('/src/features/deeplink.ts');
  const originalFetch = window.fetch;
  const originalConfirm = window.confirm;
  const originalOpen = indexedDB.open;
  const startURL = location.href;
  await until(() => !document.getElementById('musicApp').hidden && !state.catalogLoading && state.songs.some(song => song.isLocal && song.url), 'fixture startup');
  state.audio.muted = true;
  radio.radioAudio.muted = true;
  window.confirm = () => true;
  const play = async id => {
    player.playSong(state.songs.findIndex(song => String(song.id) === String(id)));
    await state.audio.play();
    await flush();
  };
  const currentId = () => state.songs[state.currentIndex]?.id;
  try {
    // A failed listing leaves the intent pending; retry uses the same final
    // reconciliation as initial load, including the still-valid track link.
    const target = fixture.tracks[1];
    await play(fixture.tracks[0].id);
    setHfTracks(state.hfSongs.filter(song => song.id !== target.id));
    history.replaceState(null, '', '?play=' + encodeURIComponent(target.id));
    deep.applyPlayDeepLink();
    check(currentId() !== target.id && location.search.includes('play='), 'an unavailable catalogue link waits without selecting a different track');
    window.fetch = (input, init) => new URL(typeof input === 'string' ? input : input.url, location.href).pathname.includes('/api/buckets/')
      ? Promise.resolve(Response.json({ error: 'fixture listing unavailable' }, { status: 503 })) : originalFetch(input, init);
    await library.retryCatalog();
    check(state.catalogError && location.search.includes('play=') && currentId() !== target.id, 'failed catalogue retries preserve the pending link and current audio');
    window.fetch = originalFetch;
    await library.retryCatalog();
    await until(() => currentId() === target.id && !state.audio.paused, 'retried deeplink playback');
    check(!state.catalogError && !location.search.includes('play='), 'successful retry applies and consumes the original track link');

    const late = await import('/src/features/deeplink.ts?library-races=late-metadata');
    let finishMetadata;
    window.fetch = (input, init) => new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/oembed'
      ? new Promise(resolve => { finishMetadata = () => resolve(Response.json({ title: 'Late artist - Old intent', author_name: 'Late artist' })); }) : originalFetch(input, init);
    history.replaceState(null, '', '?play=yt:zyxwvutsrqp');
    late.applyPlayDeepLink();
    await until(() => finishMetadata, 'pending YouTube metadata');
    await play(fixture.tracks[2].id);
    const manual = { id: currentId(), src: state.audio.getAttribute('src') };
    finishMetadata();
    await flush();
    check(currentId() === manual.id && state.audio.getAttribute('src') === manual.src && !state.audio.paused && !player.auraYTVideoId, 'late YouTube metadata cannot override a newer library selection');

    const lateRadio = await import('/src/features/deeplink.ts?library-races=radio-intent');
    finishMetadata = null;
    history.replaceState(null, '', '?play=yt:zyxwvutsrqp');
    lateRadio.applyPlayDeepLink();
    await until(() => finishMetadata, 'pending metadata before radio');
    radio.playRadioStation({ name: 'Local fixture radio', url: location.origin + '/__fixture_audio.wav', favicon: '', country: 'Fixture' });
    await radio.radioAudio.play();
    finishMetadata();
    await flush();
    check(!radio.radioAudio.paused && state.audio.paused && !player.auraYTVideoId, 'choosing radio also supersedes a delayed track link');
    radio.stopRadio();
    window.fetch = originalFetch;

    const stale = await import('/src/features/deeplink.ts?library-races=late-catalogue');
    const absent = fixture.tracks.at(-1);
    setHfTracks(state.hfSongs.filter(song => song.id !== absent.id));
    history.replaceState(null, '', '?play=' + encodeURIComponent(absent.id));
    stale.applyPlayDeepLink();
    await play(fixture.tracks[0].id);
    const chosen = currentId();
    setHfTracks([...state.hfSongs, absent]);
    stale.applyPlayDeepLink();
    check(currentId() === chosen && !location.search.includes('play='), 'a late catalogue result cannot override a newer manual choice');

    const sound = await originalFetch('/__fixture_audio.wav').then(response => response.blob());
    const makeLocal = async suffix => {
      const song = { id: 'fixture:delete-' + suffix, title: 'Delete ' + suffix, artist: 'Local fixture', isLocal: true, img: '/src/assets/brand-logo.webp', duration: 120, url: URL.createObjectURL(sound) };
      await library.saveLocalBlob(song.id, sound);
      state.addedSongs.push(song);
      rebuildSongs();
      return song;
    };
    const delayDelete = async song => {
      let release;
      indexedDB.open = function(...args) {
        const request = originalOpen.apply(this, args);
        const delayed = { get result() { return request.result; }, get error() { return request.error; }, onsuccess: null, onerror: null, onupgradeneeded: null };
        request.onsuccess = () => { release = () => delayed.onsuccess?.({ target: delayed }); };
        request.onerror = () => delayed.onerror?.({ target: delayed });
        request.onupgradeneeded = () => delayed.onupgradeneeded?.({ target: delayed });
        return delayed;
      };
      const done = library.deleteTrack(null, song.id);
      await until(() => release, 'delayed local database open');
      indexedDB.open = originalOpen;
      return { done, release: () => release() };
    };
    for (const initiallyPlaying of [true, false]) {
      const local = await makeLocal(initiallyPlaying ? 'active' : 'inactive');
      await play(initiallyPlaying ? local.id : fixture.tracks[0].id);
      const deletion = await delayDelete(local);
      await play(fixture.tracks[2].id);
      state.audio.currentTime = 24;
      state.audio.playbackRate = 1.25;
      await flush();
      const playback = { id: currentId(), src: state.audio.getAttribute('src') };
      let resets = 0;
      const onReset = () => resets++;
      for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.addEventListener(event, onReset);
      try { deletion.release(); await deletion.done; await flush(); }
      finally { for (const event of ['loadstart', 'emptied', 'pause', 'seeking']) state.audio.removeEventListener(event, onReset); }
      check(!state.addedSongs.some(song => song.id === local.id) && !state.songs.some(song => song.id === local.id), `delayed ${initiallyPlaying ? 'active' : 'inactive'} deletion removes only the requested local record`);
      check(resets === 0 && currentId() === playback.id && state.audio.getAttribute('src') === playback.src && !state.audio.paused && state.audio.currentTime >= 24 && state.audio.playbackRate === 1.25, `delayed ${initiallyPlaying ? 'active' : 'inactive'} deletion preserves the newer playback identity, source and position`);
      check(await library.getLocalBlob(local.id) === undefined, 'the requested local blob is actually deleted from IndexedDB');
    }
    for (const phase of ['playing', 'paused', 'starts-during-delete']) {
      const local = await makeLocal('radio-' + phase);
      await play(local.id);
      const station = { name: 'Radio during ' + phase, url: location.origin + '/__fixture_audio.wav', country: 'Fixture', favicon: '' };
      const startRadio = async () => {
        radio.playRadioStation(station);
        await radio.radioAudio.play();
        await flush();
      };
      if (phase !== 'starts-during-delete') await startRadio();
      if (phase === 'paused') { radio.toggleRadioPlay(); await flush(); }
      const deletion = await delayDelete(local);
      if (phase === 'starts-during-delete') await startRadio();
      const before = { intent: getPlaybackIntent(), station: radio.currentRadioStation, src: radio.radioAudio.src, paused: radio.radioAudio.paused, title: navigator.mediaSession.metadata?.title, playbackState: navigator.mediaSession.playbackState };
      deletion.release(); await deletion.done; await flush();
      check(!state.songs.some(song => song.id === local.id) && !state.addedSongs.some(song => song.id === local.id) && state.currentIndex === -1, `deleting the last local selection during ${phase} radio removes its ephemeral identity`);
      check(getPlaybackIntent() === before.intent && radio.currentRadioStation === before.station && radio.radioAudio.src === before.src && radio.radioAudio.paused === before.paused, `local deletion preserves ${phase} radio ownership and playback intent`);
      check(navigator.mediaSession.metadata?.title === before.title && navigator.mediaSession.playbackState === before.playbackState && before.title === station.name, `local deletion preserves ${phase} radio media-session controls`);
      radio.stopRadio();
    }
    const active = await makeLocal('confirmed-current');
    await play(active.id);
    await library.deleteTrack(null, active.id);
    check(state.audio.paused && !state.audio.getAttribute('src') && !state.isPlaying && !state.songs.some(song => song.id === active.id), 'explicitly deleting the still-current local track clears playback and its ephemeral identity');
    check(!document.getElementById('miniPlayer').classList.contains('active') && document.getElementById('currentTitle').textContent === 'Select Track', 'deleting current audio resets its visible transport');
    check(localStorage.getItem('auraPlaylists') === fixture.playlist, 'catalogue and deletion races preserve saved playlist bytes');
    check(fixture.errors.length === 0, 'race regressions have no uncaught browser errors');
    return { page: 'main', passed: checks.length, checks };
  } finally {
    window.fetch = originalFetch;
    window.confirm = originalConfirm;
    indexedDB.open = originalOpen;
    history.replaceState(null, '', startURL);
    state.audio.pause();
    radio.stopRadio();
  }
}
