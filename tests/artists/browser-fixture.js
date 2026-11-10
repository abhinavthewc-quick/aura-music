/* Browser-only fixtures. Loaded by the dedicated local Vite config, never in
   a production build. No real login, submissions or remote mutations. */
(async () => {
  const options = new URLSearchParams(location.search);
  const realFetch = window.fetch.bind(window);
  const page = options.get('page') || 'main';
  const signedOut = options.has('signed-out');
  const tracks = [
    ['Old Artist', 'Hand upload', ''],
    ['Old Artist', 'After the rain', 'abcdefghijk'],
    ['Anirudh Ravichander', 'Feel the beat', 'bcdefghijkl'],
    ['Anirudh Ravichandran', 'Quiet road', 'cdefghijklm'],
    ['A. R. Rahman', 'Love song', 'defghijklmn'],
    ['A.R. Rahman - Topic', 'Journey', 'efghijklmno'],
    ['The National', 'Slow morning', 'fghijklmnop'],
    ['National', 'City lights', 'ghijklmnopq'],
    ['Sushin Shyam', 'Blue hour', 'hijklmnopqr'],
    ['Vishnu Vijay', 'Stay a while', 'ijklmnopqrs'],
    ['Jakes Bejoy', 'First light', 'jklmnopqrst'],
    ['Local Ensemble', 'Night drive', 'klmnopqrstu'],
  ].map(([artist, title, videoId], index) => {
    const hfPath = `${artist} - ${title}${videoId ? ` [${videoId}]` : ''}.opus`;
    return {
      id: 'hf:' + hfPath, hfPath, artist, title, videoId,
      album: index < 2 ? 'After hours' : 'Singles', year: '2026', duration: 120,
      url: '/api/audio?path=' + encodeURIComponent(hfPath), isHf: true,
      img: index % 2 ? '/src/assets/radio-hero.jpg' : '/src/assets/brand-logo.webp',
    };
  });
  const localTrack = { id: 'fixture:local', title: 'On this device', artist: 'Local Artist', isLocal: true, img: '/src/assets/brand-logo.webp', duration: 120 };
  const playlist = JSON.stringify([{ id: 'fixture-playlist', title: 'Evening records', description: 'A collection saved on this device.', privacy: 'Private', year: 2026, createdAt: 1780000000000, tracks: ['lk:hand upload|old artist', 'vid:abcdefghijk', 'lk:on this device|local artist'] }], null, 2);
  localStorage.clear();
  localStorage.setItem('auraTheme', 'light'); // Removed preference must not change the black UI.
  localStorage.setItem('auraHfCatalog_v1', JSON.stringify({ tracks, at: Date.now() }));
  localStorage.setItem('addedTracks', JSON.stringify([localTrack]));
  localStorage.setItem('auraPlaylists', playlist);
  localStorage.setItem('auraUserName', 'Record listener');
  localStorage.setItem('auraLikedSongs_v2', JSON.stringify([tracks[0]]));
  localStorage.setItem('recentlyPlayed', JSON.stringify(tracks.slice(0, 4)));
  if (!signedOut) localStorage.setItem('auraSession_v2', JSON.stringify({ email: page === 'admin' ? 'abhinavthewc@gmail.com' : 'listener@example.test', name: 'Record listener', picture: '', exp: Math.floor(Date.now() / 1000) + 3600, token: 'fixture:not-a-real-credential' }));

  const fixture = window.__auraFixture = {
    directory: { artists: {}, trackArtists: {}, revision: 0 },
    requests: [], errors: [], playlist, tracks, page,
    cloud(revision = 1, name = 'New Artist', img = '/api/artist-image?id=one.jpg') {
      const profile = { key: 'old artist', name, img, bio: 'Independent music, made for long evenings.', genres: ['Soul', 'Alternative'], social: 'https://example.com', version: revision, updated: Date.now() };
      return { artists: { 'old artist': profile, 'new artist': profile, [name.toLowerCase()]: profile, 'anirudh ravichander': { key: 'anirudh ravichander', name: 'Anirudh Ravichander', bio: 'Composer and performer.', img: '/api/artist-image?id=anirudh.jpg', version: 1 } }, trackArtists: Object.fromEntries(tracks.slice(0, 2).map((track) => [track.videoId ? 'vid:' + track.videoId : 'hf:' + track.hfPath, name])), revision };
    },
    async publish(directory) {
      fixture.directory = directory;
      const { cacheArtistDirectory } = await import('/src/core/catalog.ts');
      cacheArtistDirectory(directory);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
  };
  if (page === 'admin' || options.has('cloud')) fixture.directory = fixture.cloud();
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const method = init.method || 'GET';
    if (url.pathname.startsWith('/api/') || url.origin !== location.origin) fixture.requests.push({ method, path: url.pathname, action: body.action, version: body.version, artistKey: body.artistKey, name: body.name, img: body.img, bio: body.bio });
    if (url.hostname === 'huggingface.co' || (url.pathname.startsWith('/__fixture_hf/') && url.pathname.endsWith('manifest.json'))) {
      if (url.pathname.endsWith('manifest.json')) return Response.json({ v: 1, artists: {}, tracks: Object.fromEntries(tracks.filter((t) => t.videoId).map((t) => [t.videoId, { t: t.title, a: t.artist, al: t.album, y: t.year, d: t.duration }])) });
      return Response.json(tracks.flatMap((t) => [
        { type: 'file', path: t.hfPath, size: 1024, contentType: 'audio/ogg' },
        { type: 'file', path: t.hfPath.replace(/\.opus$/, '.jpg'), size: 256, contentType: 'image/jpeg' },
      ]));
    }
    if (url.pathname === '/api/artists') return Response.json(fixture.directory);
    if (url.pathname === '/api/admin') {
      if (body.action === 'library') return Response.json({ files: tracks.flatMap((t) => [{ path: t.hfPath, size: 1024 }, { path: t.hfPath.replace(/\.opus$/, '.jpg'), size: 256 }]), videoIds: tracks.map((t) => t.videoId).filter(Boolean), bucketId: 'fixture', manifest: {}, ...fixture.directory });
      if (body.action === 'status') return Response.json({ secrets: ['HF_TOKEN', 'HF_BUCKET_ID', 'YOUTUBE_COOKIES'] });
      if (body.action === 'runs') return Response.json({ runs: [] });
      if (body.action === 'artistSet') {
        const current = fixture.directory.artists[body.artistKey];
        if (body.version !== (current?.version || 0)) return Response.json({ error: 'This artist was changed in another tab. Reload the artist list, then reapply your changes.' }, { status: 409 });
        const profile = { key: body.artistKey, name: body.name, img: body.img?.startsWith('data:') ? `/api/artist-image?id=upload-${fixture.directory.revision + 1}.png` : body.img, bio: body.bio, genres: body.genres, social: body.social, version: body.version + 1, updated: Date.now() };
        const artists = Object.fromEntries(Object.entries(fixture.directory.artists).map(([alias, saved]) => [alias, saved.key === body.artistKey ? profile : saved]));
        fixture.directory = { ...fixture.directory, artists: { ...artists, [body.artistKey]: profile, [body.name.toLowerCase()]: profile }, revision: fixture.directory.revision + 1 };
        return Response.json({ ...fixture.directory, ok: true, persisted: true, artist: profile, renamedTrackCount: 0 });
      }
      return Response.json({ error: 'Fixture blocked a real admin action' }, { status: 400 });
    }
    if (url.pathname === '/api/bot') {
      if (body.action === 'overview') return Response.json({ counts: { queued: 0, downloaded: 12, failed: 0, users: 2 }, settings: { threshold: 25, channelIds: 'fixture' }, bot: { online: true, botUser: 'Aura Farmer', latencyMs: 42 }, worker: { version: 'fixture' } });
      if (['queue', 'batches', 'users', 'settings', 'audit'].includes(body.action)) return Response.json({ items: [], total: 0, settings: {} });
      return Response.json({ error: 'Fixture blocked a real bot mutation' }, { status: 400 });
    }
    if (url.pathname.startsWith('/api/') && method !== 'GET') return Response.json({ error: 'Blocked by local fixture' }, { status: 400 });
    if (url.origin !== location.origin) return Response.json({}, { status: 404 });
    return realFetch(input, init);
  };
  navigator.sendBeacon = (url) => { fixture.requests.push({ method: 'BEACON', path: String(url) }); return true; };
  if (page === 'rooms') (await import('/tests/artists/browser-rooms.js')).installRoomFixture(fixture);

  // A real IndexedDB blob verifies local-track hydration without any upload.
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('auraMusicDB', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('audioFiles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const sound = await realFetch('/__fixture_audio.wav').then((response) => response.blob());
  await new Promise((resolve, reject) => {
    const tx = db.transaction('audioFiles', 'readwrite');
    tx.objectStore('audioFiles').put(sound, localTrack.id);
    tx.oncomplete = resolve; tx.onerror = reject;
  });
  db.close();
  let html = await realFetch(page === 'main' ? '/index.html' : `/${page}.html`).then((response) => response.text());
  html = html.replace('<head>', '<head><base href="/">');
  document.open(); document.write(html); document.close();
  window.addEventListener('error', (event) => fixture.errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => fixture.errors.push(String(event.reason)));
})();
