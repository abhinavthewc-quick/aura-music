import { getSavedUserName, toast } from './core/dom';
import { setGreeting } from './features/home';
import { hydrateLocalTracks, renderRecent, renderSongs, updateLibCount } from './features/library';
import { auraYTPlayer, auraYTVideoId, lastPlayRequestAt, loadSong } from './features/player';
import { updateProfilePopup } from './features/settings';
import { $, state } from './core/state';
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
      const savedName = getSavedUserName();
      if(savedName){
        $('displayUserName').textContent=$('profileName').textContent=savedName;
        $('userNameInput').value=savedName;
        $('welcomeScreen').classList.add('hidden');
        localStorage.setItem('auraLastLogin', new Date().toISOString());
      }
      setGreeting();
      await hydrateLocalTracks();
      renderSongs(state.songs); loadSong(0); updateLibCount(); renderRecent();
      updateProfilePopup();
    })();
  
