import { toast } from './core/dom';
import { fetchHfCatalog } from './core/catalog';
import { getProfileUsername, getSession, setProfileUsername } from './core/session';
import { setGreeting } from './features/home';
import { hydrateLocalTracks, renderRecent, renderSongs, updateLibCount } from './features/library';
import { auraYTPlayer, auraYTVideoId, lastPlayRequestAt, loadSong } from './features/player';
import { updateProfilePopup } from './features/settings';
import { $, setHfTracks, state } from './core/state';
/* ===== 4669-4686 ===== */

    /* Network + playback error states */
    (function(){
      const nb=$('netBanner'); let t;
      function show(kind,html,ms?){ nb.className='net-banner show '+kind; nb.innerHTML=html; clearTimeout(t); if(ms) t=setTimeout(()=>nb.classList.remove('show'),ms); }
      const offline=()=>show('offline','<i class="fa-solid fa-wifi"></i> You\'re offline — your library and local files still work.');
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
        $('displayUserName').textContent=$('profileName').textContent=name;
        $('welcomeScreen').classList.add('hidden');
        localStorage.setItem('auraLastLogin', new Date().toISOString());
        if(!localStorage.getItem('auraUserName')) localStorage.setItem('auraUserName', name);
      }
      setGreeting();
      await hydrateLocalTracks();
      renderSongs(state.songs); if(state.songs.length) loadSong(0); updateLibCount(); renderRecent();
      updateProfilePopup();

      /* Catalog lives in the Hugging Face bucket — refresh it in the background
         (the list is painted instantly from localStorage cache, if any). */
      fetchHfCatalog().then((tracks)=>{
        const hadSongs = state.songs.length > 0;
        setHfTracks(tracks);
        renderSongs(state.songs);
        renderRecent();
        updateLibCount();
        if(!hadSongs && state.songs.length) loadSong(state.currentIndex);
      }).catch(()=>{
        if(!state.hfSongs.length) toast('Could not load the Hugging Face catalog — showing local files only.','triangle-exclamation');
      });
    })();
