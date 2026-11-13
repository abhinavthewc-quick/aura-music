/* Browser-only fixtures. Loaded by the dedicated local Vite config, never in
   a production build. No real login, submissions or remote mutations. */
(async () => {
  const options = new URLSearchParams(location.search);
  const realFetch = window.fetch.bind(window);
  const page = options.get('page') || 'main';
  const signedOut = options.has('signed-out');
  const metadataKey = (name) => String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const metadataCacheKey = 'auraAutomaticArtistMetadata_v1';
  const vevoPairs = [
    ['Kendrick Lamar', 'KendrickLamarVEVO', 3],
    ['Lewis Capaldi', 'LewisCapaldiVEVO', 2],
    ['Post Malone', 'PostMaloneVEVO', 3],
    ['The Kid LAROI.', 'TheKidLAROIVEVO', 2],
    ['The Neighbourhood', 'TheNeighbourhoodVEVO', 2],
    ['Travis Scott', 'TravisScottVEVO', 2],
  ];
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
    ...(options.has('artist-page') ? vevoPairs.flatMap(([name, channel, total]) =>
      Array.from({ length: total }, (_, index) => [index === 0 ? name : channel, `${name} recording ${index + 1}`, ''])) : []),
    ...(options.has('credits') ? [
      ['Dhanush', 'Separate voice', 'lmnopqrstu1'],
      ['Anirudh Ravichander & Dhanush', 'Shared recording', 'lmnopqrstu2', 'Anirudh Ravichander'],
      ['Anirudh Ravichandran & Dhanush', 'Spelling duet', 'lmnopqrstu3', 'Anirudh Ravichander'],
      ['Anirudh Ravichander, Anirudh Ravichandran & Dhanush', 'Repeated credit', 'lmnopqrstu4', 'Anirudh Ravichander'],
      ['Hamsika Iyer & Yogi B', 'Be Notorious', 'lmnopqrstu5', 'Hamsika Iyer'],
      ['Siri Xander & Arra Aria Khayal', 'Pesamale', 'lmnopqrstu6', 'Siri Xander'],
      ['Narayani Gopan & Mithun Jayaraj', 'Uyire', 'lmnopqrstu7', 'Narayani Gopan'],
      ['Saurav Srisan & Tanisha Gnanavel', 'Rathinamo', 'lmnopqrstu8', 'Saurav Srisan'],
      ['M. G. Sreekumar & Bindu Anirudhan', 'Digi Rigi Dum Dum', 'lmnopqrstu9', 'MG'],
      ['A.R. Ameen, Vaishali Samant, Rakshita Suresh & Antara Nandy', "Sita's Aspiration", 'lmnopqrst10', 'A. R. Ameen'],
      ['Manikandan Ayyappa, Chemban Vinod Jose, Himna Hilari & Hinitha Hilary', 'Aadame', 'lmnopqrst11', 'Manikandan Ayyappa'],
      ['Earth, Wind & Fire', 'Band recording', 'lmnopqrst12'],
      ['Local One & Local Two', 'Joint project recording', 'lmnopqrst13', 'Local One'],
      ['Edited One & Edited Two', 'Intentional correction', 'lmnopqrst14', 'Edited One'],
      ['Strangers & Friends', 'Compound name', 'lmnopqrst15'],
      ['The Dhanush Ensemble', 'Unrelated recording', 'lmnopqrst16'],
      ['Alex North', 'Ambiguous owner recording', 'lmnopqrst17'],
    ] : []),
  ].map(([artist, title, videoId, source], index) => {
    const hfPath = `${source || artist} - ${title}${videoId ? ` [${videoId}]` : ''}.opus`;
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
    requests: [], errors: [], playlist, tracks, page, vevoPairs,
    metadataCases: new Map(), metadataPending: new Map(), adminGateConfirmed: false,
    adminGate: options.get('admin-gate') || 'ready', releaseAdminGate: null,
    readyMetadata(name, fields = {}) {
      const fetchedAt = Date.now();
      return { key: metadataKey(name), status: 'ready', metadata: {
        name: 'Provider spelling is display-only', entityId: 'Q42',
        img: '/api/artist-image?id=automatic.jpg', bio: 'Verified fixture biography.',
        imageCredit: { title: 'Fixture artist portrait', url: 'https://commons.wikimedia.org/wiki/File:Fixture_artist.jpg', author: 'Fixture photographer', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
        bioCredit: { title: 'Fixture artist article', url: 'https://en.wikipedia.org/wiki/Fixture_artist', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
        fetchedAt, expiresAt: fetchedAt + 7 * 24 * 3600 * 1000, ...fields,
      } };
    },
    setMetadata(name, response, controls = {}) {
      fixture.metadataCases.set(metadataKey(name), { response, ...controls });
    },
    releaseMetadata(name) { fixture.metadataPending.get(metadataKey(name))?.(); },
    async publishMetadata(name, response) {
      const key = metadataKey(name);
      const cache = JSON.parse(localStorage.getItem(metadataCacheKey) || '{"v":1,"entries":[]}');
      const previous = cache.entries.find(entry => entry.key === key);
      const checkedAt = Math.max(Date.now(), (previous?.checkedAt || 0) + 1);
      const entry = { key, name, status: response.status, metadata: response.metadata,
        checkedAt, usedAt: checkedAt, failures: response.status === 'retry' ? 1 : 0,
        nextRequestAt: checkedAt + (response.status === 'ready' ? Math.max(1500, response.metadata.expiresAt - checkedAt)
          : response.status === 'retry' ? Math.max(30000, (response.retryAfter || 0) * 1000) : 24 * 3600 * 1000) };
      cache.entries = [entry, ...cache.entries.filter(saved => saved.key !== key)].slice(0, 320);
      localStorage.setItem(metadataCacheKey, JSON.stringify(cache));
      window.dispatchEvent(new StorageEvent('storage', { key: metadataCacheKey, storageArea: localStorage }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    cloud(revision = 1, name = 'New Artist', img = '/api/artist-image?id=one.jpg') {
      const profile = { key: 'old artist', name, img, bio: 'Independent music, made for long evenings.', genres: ['Soul', 'Alternative'], social: 'https://example.com', version: revision, updated: Date.now(), source: 'admin', imgOverride: true, bioOverride: true };
      return { artists: { 'old artist': profile, 'new artist': profile, [name.toLowerCase()]: profile, 'anirudh ravichander': { key: 'anirudh ravichander', name: 'Anirudh Ravichander', bio: 'Composer and performer.', img: '/api/artist-image?id=anirudh.jpg', version: 1, source: 'admin', imgOverride: true, bioOverride: true },
        ...(options.has('credits') ? {
          'local one & local two': { key: 'joint project', name: 'Local One & Local Two', img: '/api/artist-image?id=joint.jpg', version: 1, source: 'admin', imgOverride: true, bioOverride: false },
          'first alex': { key: 'alex north', name: 'Alex North', bio: 'First owner biography.', version: 1, source: 'admin', imgOverride: false, bioOverride: true },
          'second alex': { key: 'second alex', name: 'Alex North', bio: 'Second owner biography.', version: 1, source: 'admin', imgOverride: false, bioOverride: true },
        } : {}),
      }, trackArtists: { ...Object.fromEntries(tracks.slice(0, 2).map((track) => [track.videoId ? 'vid:' + track.videoId : 'hf:' + track.hfPath, name])),
        ...(options.has('credits') ? { 'vid:lmnopqrst14': 'Edited One & Edited Two' } : {}),
      }, revision };
    },
    async publish(directory) {
      fixture.directory = directory;
      const { cacheArtistDirectory } = await import('/src/core/catalog.ts');
      cacheArtistDirectory(directory);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
  };
  if (page === 'admin' || options.has('cloud')) fixture.directory = fixture.cloud();
  const metadataMode = options.get('metadata');
  if (metadataMode) {
    const name = fixture.directory.artists['old artist']?.name || 'Old Artist';
    const response = metadataMode === 'ambiguous' || metadataMode === 'retry'
      ? { key: metadataKey(name), status: metadataMode, ...(metadataMode === 'retry' ? { retryAfter: 120 } : {}) }
      : fixture.readyMetadata(name);
    fixture.setMetadata(name, response, { hold: metadataMode === 'held-ready' });
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const method = init.method || 'GET';
    if (url.pathname.startsWith('/api/') || url.origin !== location.origin) fixture.requests.push({ method, path: url.pathname, queryName: url.searchParams.get('name') || undefined, action: body.action, version: body.version, artistKey: body.artistKey, name: body.name, img: body.img, bio: body.bio, imgOverride: body.imgOverride, bioOverride: body.bioOverride, renameTracks: body.renameTracks,
      ...(url.pathname === '/api/artist-metadata' ? { intent: new Headers(init.headers).get('X-Aura-Artist-Intent'), gateConfirmed: fixture.adminGateConfirmed, appVisible: !!document.getElementById('musicApp') && !document.getElementById('musicApp').hidden && !document.getElementById('musicApp').inert } : {}) });
    if (url.hostname === 'huggingface.co' || (url.pathname.startsWith('/__fixture_hf/') && url.pathname.endsWith('manifest.json'))) {
      if (url.pathname.endsWith('manifest.json')) return Response.json({ v: 1, artists: {}, tracks: Object.fromEntries(tracks.filter((t) => t.videoId).map((t) => [t.videoId, { t: t.title, a: t.artist, al: t.album, y: t.year, d: t.duration }])) });
      return Response.json(tracks.flatMap((t) => [
        { type: 'file', path: t.hfPath, size: 1024, contentType: 'audio/ogg' },
        { type: 'file', path: t.hfPath.replace(/\.opus$/, '.jpg'), size: 256, contentType: 'image/jpeg' },
      ]));
    }
    if (url.pathname === '/api/artists') return Response.json(fixture.directory);
    if (url.pathname === '/api/artist-metadata') {
      const name = url.searchParams.get('name') || '', key = metadataKey(name);
      const spec = fixture.metadataCases.get(key) || { response: { key, status: 'not-found' } };
      if (spec.hold || spec.delay) await new Promise((resolve, reject) => {
        let timer;
        const finish = () => { clearTimeout(timer); fixture.metadataPending.delete(key); init.signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); fixture.metadataPending.delete(key); reject(new DOMException('Fixture lookup aborted', 'AbortError')); };
        if (init.signal?.aborted) { abort(); return; }
        init.signal?.addEventListener('abort', abort, { once: true });
        if (spec.hold) fixture.metadataPending.set(key, finish);
        else timer = setTimeout(finish, spec.delay);
      });
      return Response.json(typeof spec.response === 'function' ? spec.response(name) : spec.response, {
        status: spec.httpStatus || 200, headers: spec.retryAfter ? { 'Retry-After': String(spec.retryAfter) } : {},
      });
    }
    if (url.hostname === 'de1.api.radio-browser.info' && url.pathname === '/json/stations/search') {
      const query = (url.searchParams.get('name') || '').toLowerCase();
      return Response.json(['Evening frequency', 'Quiet signals'].filter(name => name.toLowerCase().includes(query)).map(name => ({ name, url: location.origin + '/__fixture_audio.wav', country: 'Local fixture', tags: 'ambient,night', favicon: '/src/assets/brand-logo.webp' })));
    }
    if (url.pathname === '/api/admin') {
      if (body.action === 'library') return Response.json({ files: tracks.flatMap((t) => [{ path: t.hfPath, size: 1024 }, { path: t.hfPath.replace(/\.opus$/, '.jpg'), size: 256 }]), videoIds: tracks.map((t) => t.videoId).filter(Boolean), bucketId: 'fixture', manifest: options.has('credits') ? Object.fromEntries(tracks.filter(t => t.videoId).map(t => [t.videoId, { t: t.title, a: t.artist, al: t.album, y: t.year, d: t.duration }])) : {}, ...fixture.directory });
      if (body.action === 'status') {
        if (fixture.adminGate === 'held') await new Promise(resolve => { fixture.releaseAdminGate = resolve; });
        if (fixture.adminGate === 'denied') return Response.json({ error: 'Fixture admin access denied' }, { status: 403 });
        fixture.adminGateConfirmed = true;
        return Response.json({ secrets: ['HF_TOKEN', 'HF_BUCKET_ID', 'YOUTUBE_COOKIES'] });
      }
      if (body.action === 'runs') return Response.json({ runs: [] });
      if (body.action === 'artistSet') {
        const current = fixture.directory.artists[body.artistKey];
        if (body.version !== (current?.version || 0)) return Response.json({ error: 'This artist was changed in another tab. Reload the artist list, then reapply your changes.' }, { status: 409 });
        const has = field => Object.prototype.hasOwnProperty.call(body, field);
        const img = has('img') ? body.img : current?.img || '';
        const profile = { ...current, key: body.artistKey, name: body.name, img: img?.startsWith('data:') ? `/api/artist-image?id=upload-${fixture.directory.revision + 1}.png` : img,
          bio: has('bio') ? body.bio : current?.bio || '',
          imgOverride: typeof body.imgOverride === 'boolean' ? body.imgOverride : has('img') ? true : current?.imgOverride ?? !!current?.version,
          bioOverride: typeof body.bioOverride === 'boolean' ? body.bioOverride : has('bio') ? true : current?.bioOverride ?? !!current?.version,
          source: 'admin', genres: body.genres, social: body.social, version: body.version + 1, updated: Date.now() };
        const artists = Object.fromEntries(Object.entries(fixture.directory.artists).map(([alias, saved]) => [alias, saved.key === body.artistKey ? profile : saved]));
        const trackArtists = { ...fixture.directory.trackArtists };
        let renamedTrackCount = 0;
        if (options.has('credits') && body.renameTracks) {
          const aliases = new Set([body.artistKey, body.artist?.toLowerCase(), body.name.toLowerCase(),
            ...Object.entries(fixture.directory.artists).filter(([, saved]) => saved.key === body.artistKey).map(([alias]) => alias)]);
          for (const track of tracks) {
            const id = track.videoId ? 'vid:' + track.videoId : 'hf:' + track.hfPath;
            const artist = trackArtists[id] || track.artist;
            if (aliases.has(artist.toLowerCase()) && artist !== body.name) {
              trackArtists[id] = body.name;
              renamedTrackCount++;
            }
          }
        }
        fixture.directory = { ...fixture.directory, artists: { ...artists, [body.artistKey]: profile, [body.name.toLowerCase()]: profile }, trackArtists, revision: fixture.directory.revision + 1 };
        return Response.json({ ...fixture.directory, ok: true, persisted: true, artist: profile, renamedTrackCount });
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
