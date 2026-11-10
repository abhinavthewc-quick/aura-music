import { toast } from './core/dom';
import { applyArtistTrackOverrides, fetchArtistDirectory, fetchHfCatalog } from './core/catalog';
import { getProfileUsername, getSession, setProfileUsername } from './core/session';
import { refreshArtistViews, renderQuickPicks, setGreeting, setupHeaderSearch, setupMoodChips } from './features/home';
import { applyPlayDeepLink } from './features/deeplink';
import { hydrateLocalTracks, renderLibrary, renderRecent, renderSongs, updateLibCount } from './features/library';
import { auraYTPlayer, auraYTVideoId, lastPlayRequestAt, loadSong, updateMainMediaSession } from './features/player';
import { updateProfilePopup } from './features/settings';
import { filterSearchTab } from './features/search';
import { renderUpNext } from './features/queue';
import { refreshPlaylistViews } from './features/playlists';
import { $, setHfTracks, state } from './core/state';
/* ===== 4669-4686 ===== */

    let artistPaint = 0;
    window.addEventListener('aura:artists-updated', () => {
      if(artistPaint) return;
      artistPaint = requestAnimationFrame(() => {
        artistPaint = 0;
        /* Reconcile metadata without reloading audio, seeking, or replacing
           browser-local playlists. The current track keeps its stable ID. */
        setHfTracks(applyArtistTrackOverrides(state.hfSongs));
        renderSongs(state.songs);
        renderRecent();
        refreshArtistViews();
        refreshPlaylistViews();
        if($('tabLibrary')?.classList.contains('active')) renderLibrary();
        if($('tabSearch')?.classList.contains('active')) filterSearchTab();
        if($('upNextSheet')?.classList.contains('active')) renderUpNext();
        const song = state.songs[state.currentIndex];
        if(song){
          for(const id of ['currentArtist', 'fullArtist']) if($(id)) $(id).textContent = song.artist;
          updateMainMediaSession();
        }
      });
    });

    let lastArtistRefresh = 0;
    const refreshArtists = () => {
      if(document.visibilityState === 'hidden' || Date.now() - lastArtistRefresh < 15000) return;
      lastArtistRefresh = Date.now();
      void fetchArtistDirectory();
    };
    window.addEventListener('focus', refreshArtists);
    window.addEventListener('online', refreshArtists);
    document.addEventListener('visibilitychange', refreshArtists);
    setInterval(refreshArtists, 60000);

    /* Network + playback error states */
    (function(){
      const nb=$('netBanner'); let t;
      function show(kind,html,ms?){ nb.className='net-banner show '+kind; nb.innerHTML=html; clearTimeout(t); if(ms) t=setTimeout(()=>nb.classList.remove('show'),ms); }
       const offline=()=>show('offline','<i class="fa-solid fa-wifi"></i> You\'re offline — your saved Aura library still works.');
      window.addEventListener('offline',offline);
      window.addEventListener('online',()=>show('ok','<i class="fa-solid fa-circle-check"></i> Back online',2600));
      const c=navigator.connection||navigator.mozConnection;
      const slow=()=>{ if(navigator.onLine && c && (c.saveData||/(^|-)2g$/.test(c.effectiveType||''))) show('slow','<i class="fa-solid fa-hourglass-half"></i> Slow connection — searching and streaming may take longer.',6000); };
      if(c&&c.addEventListener) c.addEventListener('change',slow);
      if(!navigator.onLine) offline(); else slow();
      state.audio.addEventListener('error',()=>{
        if(!state.audio.getAttribute('src') || auraYTPlayer || auraYTVideoId || Date.now()-lastPlayRequestAt>20000) return;
        toast(navigator.onLine ? "Couldn't play this track — the source may be blocked or removed. Try another." : 'No internet connection — this track needs a connection to play','triangle-exclamation');
      });
    })();

/* ===== 6274-6287 ===== */
    (async function init(){
      const session = getSession();
      if(session){
        const name = session.name || 'Listener';
        if(!getProfileUsername(session.email) && session.name) setProfileUsername(session.email, session.name);
        const displayName = $('displayUserName');
        if(displayName) displayName.textContent=name;
        $('welcomeScreen').classList.add('hidden');
        localStorage.setItem('auraLastLogin', new Date().toISOString());
        if(!localStorage.getItem('auraUserName')) localStorage.setItem('auraUserName', name);
      }
      setGreeting();
      setupMoodChips();
      setupHeaderSearch();
      /* Paint skeletons (instead of "no tracks") while the first remote
         catalogue request is in flight and there is no cache to show. */
      state.catalogLoading = !state.hfSongs.length;
      state.catalogError = false;
      await hydrateLocalTracks();
      renderSongs(state.songs); if(state.songs.length) loadSong(0); updateLibCount(); renderRecent(); renderQuickPicks();
      updateProfilePopup();

      /* A PreMiD "Listen in Aura Music" button lands here. Cached/local tracks
         can start immediately; bucket tracks are retried after the fetch. */
      applyPlayDeepLink();

      /* Catalog lives in the Hugging Face bucket — refresh it in the background
         (the list is painted instantly from localStorage cache, if any). */
      fetchHfCatalog().then((tracks)=>{
        state.catalogLoading = false;
        state.catalogError = false;
        const hadSongs = state.songs.length > 0;
        setHfTracks(tracks);
        renderSongs(state.songs);
        renderRecent();
        renderQuickPicks();
        refreshArtistViews();
        refreshPlaylistViews();
        updateLibCount();
        const song = state.songs[state.currentIndex];
        if(song){
          for(const id of ['currentArtist', 'fullArtist']) if($(id)) $(id).textContent = song.artist;
          updateMainMediaSession();
        }
        if(!hadSongs && state.songs.length) loadSong(state.currentIndex);
        if($('tabLibrary').classList.contains('active')) renderLibrary();
        applyPlayDeepLink();
      }).catch(()=>{
        state.catalogLoading = false;
        state.catalogError = true;
        renderSongs(state.songs);
        if($('tabLibrary').classList.contains('active')) renderLibrary();
         if(!state.hfSongs.length) toast('Could not load the Aura catalogue. Try again when your connection is stable.','triangle-exclamation');
      });
    })();
