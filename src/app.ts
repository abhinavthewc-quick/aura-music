import { toast } from './core/dom';
import { markAppReady } from './core/boot';
import { fetchCatalog } from './core/catalog';
import { getProfileUsername, getSession, setProfileUsername } from './core/session';
import { renderQuickPicks, setGreeting, setupMoodChips } from './features/home';
import { applyPlayDeepLink } from './features/deeplink';
import { hydrateLocalTracks, renderLibrary, renderRecent, renderSongs, updateLibCount } from './features/library';
import { auraYTPlayer, auraYTVideoId, lastPlayRequestAt, loadSong } from './features/player';
import { updateProfilePopup } from './features/settings';
import { $, setHfTracks, state } from './core/state';
/* ===== 4669-4686 ===== */

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
        // The source loader reports terminal errors after its proxy/direct and
        // rendition/original retries. Avoid a premature toast during recovery.
        if(typeof state.audio.onerror === 'function' || !state.audio.getAttribute('src') || auraYTPlayer || auraYTVideoId || Date.now()-lastPlayRequestAt>20000) return;
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
      /* Paint skeletons (instead of "no tracks") while the first remote
         catalogue request is in flight and there is no cache to show. */
      state.catalogLoading = !state.hfSongs.length;
      state.catalogError = false;

      /* Paint from the localStorage catalogue immediately (state.ts seeds
         hfSongs there) instead of waiting for IndexedDB to hand back local
         files: hydrateLocalTracks() only rewrites blob URLs for tracks this
         device owns, so it can settle after the first paint. */
      renderSongs(state.songs);
      if(state.songs.length) loadSong(0, false, false);
      updateLibCount();
      renderRecent();
      renderQuickPicks();
      /* First screen is on screen: the welcome screen needs nothing else, and
         a cached/local library is already usable. A cold catalogue waits for
         the refresh below, so the splash (when the intro gate showed it) keeps
         covering exactly the part that has nothing to show yet. */
      if(!session) markAppReady('welcome');
      else if(state.songs.length) markAppReady('cached');
      updateProfilePopup();
      applyPlayDeepLink();
      void hydrateLocalTracks().then(() => { renderRecent(); renderQuickPicks(); });

      /* The catalogue arrives from the edge-cached /api/catalog Function as one
         small response, so even a cold visit resolves around the end of the
         logo reveal. With a cached library the page is already useful, so that
         refresh waits for an idle slot instead of competing with the first
         paint, fonts and visible artwork. On a cold visit it runs immediately
         because there is nothing else to show. */
      const refreshCatalog = () => fetchCatalog().then((tracks)=>{
        state.catalogLoading = false;
        state.catalogError = false;
        const hadSongs = state.songs.length > 0;
        setHfTracks(tracks);
        renderSongs(state.songs);
        renderRecent();
        renderQuickPicks();
        updateLibCount();
        if(!hadSongs && state.songs.length) loadSong(state.currentIndex, false, false);
        if($('tabLibrary').classList.contains('active')) renderLibrary();
        applyPlayDeepLink();
        markAppReady('catalog');
      }).catch(()=>{
        state.catalogLoading = false;
        state.catalogError = true;
        renderSongs(state.songs);
        if($('tabLibrary').classList.contains('active')) renderLibrary();
         if(!state.hfSongs.length) toast('Could not load the Aura catalogue. Try again when your connection is stable.','triangle-exclamation');
        markAppReady('catalog-error');
      });
      if(!state.hfSongs.length) refreshCatalog();
      else {
        const idle = (window as any).requestIdleCallback;
        if(typeof idle === 'function') idle(refreshCatalog, { timeout: 3200 });
        else setTimeout(refreshCatalog, 1600);
      }
    })();
