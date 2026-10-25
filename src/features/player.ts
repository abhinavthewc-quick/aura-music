import { auraMasterCtx, effectCtx } from './ambience';
import { fmt, toast } from '../core/dom';
import { addToRecent, renderSongs, updateLibCount, updateLibNowPlaying } from './library';
import { closeUpNext, playNext, playPrevious, renderUpNext } from './queue';
import { currentRadioStation, escapeHtml, radioAudio, stopRadio, updateRadioPlayerUI } from './radio';
import { auraYTQueue, extractYouTubeId } from './search';
import { auraSettings } from './settings';
import { roomModeActive } from '../rooms/roomFlag';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
/* ===== 2955-2994 ===== */
    export const dynamicColorCache = {};

    /* ---------- color helpers ---------- */
    function rgbToHsl(r,g,b){
      r/=255; g/=255; b/=255;
      const max=Math.max(r,g,b), min=Math.min(r,g,b);
      let h=0, s=0; const l=(max+min)/2;
      if(max!==min){
        const d=max-min;
        s = l>0.5 ? d/(2-max-min) : d/(max+min);
        if(max===r) h=(g-b)/d + (g<b?6:0);
        else if(max===g) h=(b-r)/d + 2;
        else h=(r-g)/d + 4;
        h/=6;
      }
      return [h,s,l];
    }
    function hue2rgb(p,q,t){
      if(t<0) t+=1; if(t>1) t-=1;
      if(t<1/6) return p+(q-p)*6*t;
      if(t<1/2) return q;
      if(t<2/3) return p+(q-p)*(2/3-t)*6;
      return p;
    }
    function hslToRgb(h,s,l){
      if(s===0){ const v=Math.round(l*255); return [v,v,v]; }
      const q = l<0.5 ? l*(1+s) : l+s-l*s;
      const p = 2*l-q;
      return [Math.round(hue2rgb(p,q,h+1/3)*255), Math.round(hue2rgb(p,q,h)*255), Math.round(hue2rgb(p,q,h-1/3)*255)];
    }
    function relLum(r,g,b){
      const f=v=>{ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
      return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);
    }
    function contrastWithWhite(r,g,b){ return 1.05/(relLum(r,g,b)+0.05); }

    /* Derive a color from a hue-weighted bucket: saturation boosted, lightness
       clamped and contrast-checked against white text (>=4.5). */
    function pickColor(bk, satF, targetL){
      const avg = [bk.r/bk.w, bk.g/bk.w, bk.b/bk.w];
      const [h, s0] = rgbToHsl(avg[0], avg[1], avg[2]);
      const s = Math.min(1, s0*satF + 0.06);
      let l = targetL, guard = 0;
      let rgb = hslToRgb(h, s, l);
      while(contrastWithWhite(rgb[0], rgb[1], rgb[2]) < 4.5 && l > 0.10 && guard++ < 40){
        l -= 0.02;
        rgb = hslToRgb(h, s, l);
      }
      return rgb;
    }

    /* The scanned cover color drives more than the full player's background:
       every transport control (play buttons, seek fills, active toggles)
       reads the --dyn-* variables. They are written on <html> so all
       surfaces inherit, and when nothing scanned they are removed so the
       warm :root defaults in base.css take back over — a control never sits
       on an undefined var. */
    export function setDynamicColorVar(rgbStr){
      const root = document.documentElement.style;
      if(!rgbStr){
        root.removeProperty('--dyn-rgb');
        root.removeProperty('--dyn-rgb-hi');
        root.removeProperty('--dyn-rgb-lo');
        root.removeProperty('--dyn-fg');
        return;
      }
      const [r,g,b] = String(rgbStr).split(',').map(Number);
      if([r,g,b].some(v => !Number.isFinite(v))) return;
      // Soft-lit gradient stops around the base color, like the hard-coded
      // warm ramp this replaces (240/226/201 ≈ +6% / 0% / -11%).
      const clamp=c=>Math.max(0,Math.min(255,Math.round(c)));
      const hi=[r,g,b].map(c=>clamp(c+(255-c)*0.35));
      const lo=[r,g,b].map(c=>clamp(c*0.88));
      root.setProperty('--dyn-rgb',`${Math.round(r)},${Math.round(g)},${Math.round(b)}`);
      root.setProperty('--dyn-rgb-hi',hi.join(','));
      root.setProperty('--dyn-rgb-lo',lo.join(','));
      // The color that reaches here (pickColor above) is lightness-clamped
      // until white text clears 4.5:1 on it, so the control label is always
      // white while art colors are active; the warm fallback keeps its dark.
      root.setProperty('--dyn-fg','#ffffff');
    }

    /* Cross-fade (600ms, CSS opacity on .fp-bg-layer) the art-derived gradient
       in the full player between two stacked layers. Never blocks opening the
       player: it is a plain DOM style update, no image wait. */
    let fpGradientKey = '';
    let fpBgSlot = 0;
    function applyPlayerGradient(c){
      const a = $('fpBgA'), b = $('fpBgB');
      if(!a || !b) return;
      const key = c ? c.top + c.mid + c.bottom : 'none';
      if(key === fpGradientKey) return;
      fpGradientKey = key;
      const layers = [a, b];
      const cur = layers[fpBgSlot], next = layers[1 - fpBgSlot];
      next.style.background = c ? `linear-gradient(180deg, ${c.top} 0%, ${c.mid} 52%, ${c.bottom} 100%)` : '';
      void next.offsetWidth;
      next.classList.add('fp-bg-on');
      cur.classList.remove('fp-bg-on');
      fpBgSlot = 1 - fpBgSlot;
      const art = $('fullPlayerArt');
      if(art) art.style.setProperty('--art-shadow', c ? c.shadow : 'rgba(0,0,0,.5)');
    }

    export function applyDynamicPlayerColor(imgUrl){
      if(!imgUrl){ applyPlayerGradient(null); setDynamicColorVar(null); return; }
      const cached = dynamicColorCache[imgUrl];
      if(cached !== undefined){
        applyPlayerGradient(cached);
        setDynamicColorVar(cached ? cached.top.slice(4,-1) : null);
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try{
          const size = 32, HUES = 14;
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          const buckets:any[] = new Array(HUES).fill(null).map(()=>({r:0,g:0,b:0,w:0}));
          let vibrant = 0, muted = 0;
          for(let i=0;i<data.length;i+=4){
            if(data[i+3] < 128) continue;
            const r=data[i], g=data[i+1], b=data[i+2];
            const [h,s,l] = rgbToHsl(r,g,b);
            if(s < .16 || l < .08 || l > .93){ muted++; continue; }   // dull/near-black/near-white
            const w = s * (1 - Math.abs(l-0.45)*1.4);                 // favour vivid, mid-tone pixels
            if(w <= 0){ muted++; continue; }
            const bk = buckets[Math.min(HUES-1, Math.floor(h*HUES))];
            bk.r += r*w; bk.g += g*w; bk.b += b*w; bk.w += w;
            vibrant++;
          }
          // Art that is overwhelmingly gray/bright or washed out -> dark tint fallback.
          if(!vibrant || vibrant/(vibrant+muted) < 0.06) throw new Error('art is too gray');
          // Dominant hue bucket...
          let d = 0;
          for(let k=1;k<HUES;k++) if(buckets[k].w > buckets[d].w) d = k;
          // ...and a secondary hue at least 3 bins away (dropped if negligible).
          let s2 = -1;
          for(let k=0;k<HUES;k++){
            if(k===d) continue;
            const dist = Math.min(Math.abs(k-d), HUES-Math.abs(k-d));
            if(dist < 3) continue;
            if(s2 === -1 || buckets[k].w > buckets[s2].w) s2 = k;
          }
          if(s2 !== -1 && buckets[s2].w < buckets[d].w*0.18) s2 = -1;
          const topRgb = pickColor(buckets[d], 1.25, 0.44);
          const midSrc = s2 !== -1 ? buckets[s2] : buckets[d];
          const midRgb = pickColor(midSrc, 1.1, 0.20);
          const botRgb = pickColor(buckets[d], 0.55, 0.07);
          dynamicColorCache[imgUrl] = {
            top: `rgb(${topRgb.join(',')})`,
            mid: `rgb(${midRgb.join(',')})`,
            bottom: `rgb(${botRgb.join(',')})`,
            shadow: `rgba(${topRgb.join(',')},.4)`
          };
          applyPlayerGradient(dynamicColorCache[imgUrl]);
          setDynamicColorVar(topRgb.join(','));
        }catch(err){
          dynamicColorCache[imgUrl] = null;
          applyPlayerGradient(null);
          setDynamicColorVar(null);
        }
      };
      img.onerror = () => { dynamicColorCache[imgUrl] = null; applyPlayerGradient(null); setDynamicColorVar(null); };
      img.src = imgUrl;
    }

/* ===== 3057-3057 ===== */
    export function mediaSessionAction(action,handler){ try{ navigator.mediaSession.setActionHandler(action,handler); }catch(e){} }
/* ===== 5363-5555 ===== */
    /* Integrated YouTube player: the existing AURA full-player becomes the
       Now Playing screen for YouTube results. The official YouTube iframe stays
       visible; it is not hidden behind a custom/fake state.audio element. */
    export let auraYTPlayer = null;
    export let auraYTReady = false;
    export let auraYTVideoId = '';
    export let auraYTTitle = '';
    export let auraYTPoster = '';
    export let auraYTReadyPromise = null;
    export let auraYTPendingPlay = false;
    export let auraYTPlayerReady = false;
    // The AURA UI owns the user's playback intent. YouTube state can lag by a
    // moment (especially on mobile), so we keep the requested state separately.
    export let auraYTDesiredPlaying = false;

    export function ensureYouTubeAPI(){
      if(window.YT && window.YT.Player) return Promise.resolve();
      if(auraYTReadyPromise) return auraYTReadyPromise;
      auraYTReadyPromise = new Promise<void>((resolve,reject)=>{
        const previous=window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady=()=>{ try{ if(typeof previous==='function') previous(); }catch(e){} auraYTReady=true; resolve(); };
        const script=document.createElement('script');
        script.src='https://www.youtube.com/iframe_api';
        script.async=true;
        script.onerror=()=>{ auraYTReadyPromise=null; reject(new Error('YouTube API failed')); };
        document.head.appendChild(script);
      });
      return auraYTReadyPromise;
    }

    // Preload the official YouTube IFrame API early so the first AURA Play
    // tap is not lost while the API script is still downloading.
    setTimeout(()=>{ try{ ensureYouTubeAPI().catch(()=>{}); }catch(e){} },0);

    export function resetFullPlayerArtToImage(poster){
      const art=$('fullPlayerArt');
      if(!art) return;
      art.classList.remove('youtube-mode');
      art.innerHTML=`<img id="fullImg" src="${escapeHtml(poster||'')}" alt="">`;
      $('youtubeModeBadge').classList.remove('active');
    }

    export function stopAuraYouTube(){
      try{ if(auraYTPlayer && typeof auraYTPlayer.stopVideo==='function') auraYTPlayer.stopVideo(); }catch(e){}
      try{ if(auraYTPlayer && typeof auraYTPlayer.destroy==='function') auraYTPlayer.destroy(); }catch(e){}
      auraYTPlayer=null;
      auraYTPendingPlay=false;
      auraYTDesiredPlaying=false;
      auraYTPlayerReady=false;
      auraYTVideoId='';
      auraYTTitle='';
      auraYTPoster='';
    }

    export async function playYouTubeInsideAura(videoId,title,poster,liked=false,autoPlay=true){
      if(!videoId){toast('YouTube video ID was missing','triangle-exclamation');return;}
      stopRadio();
      if(state.audio){ try{state.audio.pause();}catch(e){} }
      state.isPlaying=false;
      auraYTPendingPlay=false;
      auraYTDesiredPlaying=false;
      auraYTPlayerReady=false;
      auraYTVideoId=String(videoId);
      auraYTTitle=title||'YouTube Music';
      auraYTPoster=poster||'';

      let idx=state.songs.findIndex(x=>String(x.id)===`youtube-${auraYTVideoId}`);
      if(idx===-1){
        state.songs.push({id:`youtube-${auraYTVideoId}`,title:auraYTTitle,artist:'YouTube Music',img:auraYTPoster,url:'',favorite:!!liked,isLocal:false,missing:false,isYouTube:true,videoId:auraYTVideoId});
        idx=state.songs.length-1;
      }else{
        state.songs[idx].title=auraYTTitle;
        state.songs[idx].img=auraYTPoster||state.songs[idx].img;
        state.songs[idx].isYouTube=true;
        state.songs[idx].videoId=auraYTVideoId;
      }
      state.currentIndex=idx;
      state.songs[idx].favorite = !!savedLikeMap[String(state.songs[idx].id)];
      $('currentImg').src=auraYTPoster;
      $('currentTitle').textContent=auraYTTitle;
      $('currentArtist').textContent='YouTube Music';
      $('fullTitle').textContent=auraYTTitle;
      $('fullArtist').textContent='YouTube Music';
      $('fullHeaderTitle').textContent=auraYTTitle;
      $('fullLikeBtn').className=`like-btn ${state.songs[idx].favorite?'active':''}`;
      $('fullLikeBtn').innerHTML=`<i class="fa-${state.songs[idx].favorite?'solid':'regular'} fa-heart"></i>`;
      applyDynamicPlayerColor(auraYTPoster);
      $('miniPlayer').classList.add('active');
      $('fullPlayerOverlay').classList.add('active');
      $('youtubeModeBadge').classList.add('active');
      updateLibCount();
      addToRecent(state.songs[idx]);
      if(state.songs[idx].favorite) persistLikedHistory();

      const art=$('fullPlayerArt');
      art.classList.add('youtube-mode');
      art.innerHTML=`<div id="auraYTFrameHost" style="width:100%;height:100%;background:#000"></div>`;
      updatePlayState();

      try{
        // IMPORTANT: finish loading the API and create the player before the
        // user is expected to press AURA Play. This avoids the mobile race where
        // playVideo() is called before the iframe is ready and gets blocked.
        await ensureYouTubeAPI();
        auraYTPlayer=new YT.Player('auraYTFrameHost',{
          videoId:auraYTVideoId,
          width:'100%',height:'100%',
          playerVars:{autoplay:autoPlay?1:0,playsinline:1,rel:0,controls:1,enablejsapi:1,origin:(location.protocol==='http:'||location.protocol==='https:')?location.origin:undefined},
          events:{
            onReady:()=>{
              auraYTPlayerReady=true;
              auraYTPendingPlay=false;
              if(autoPlay){
                try{ auraYTDesiredPlaying=true; auraYTPendingPlay=true; auraYTPlayer.playVideo(); }catch(e){}
              }
              state.isPlaying=false;
              updatePlayState();
            },
            onStateChange:(e)=>{
              if(!window.YT) return;
              if(e.data===YT.PlayerState.PLAYING){
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=true;
                state.isPlaying=true;
                updatePlayState();
              }else if(e.data===YT.PlayerState.PAUSED){
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=false;
                state.isPlaying=false;
                updatePlayState();
              }else if(e.data===YT.PlayerState.ENDED){
                if(state.repeatMode==='one'){ try{ auraYTPlayer.seekTo(0,true); auraYTPlayer.playVideo(); }catch(_){} return; }
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=false;
                state.isPlaying=false;
                updatePlayState();
                if(auraSettings.autoplayNext && auraYTQueue.length){ setTimeout(()=>{ playNext(); },250); }
              }
              // BUFFERING / CUED / UNSTARTED do not change the AURA play state.
            },
            onAutoplayBlocked:()=>{
              // Do not flip AURA into a fake playing state when the browser blocks
              // scripted playback. The user can press AURA Play again directly.
              auraYTPendingPlay=false;
              auraYTDesiredPlaying=false;
              state.isPlaying=false;
              updatePlayState();
            },
            onError:(e)=>{
              auraYTPlayerReady=false;
              state.isPlaying=false;
              updatePlayState();
              toast('This YouTube video cannot be embedded. Try another song.','triangle-exclamation');
            }
          }
        });
      }catch(err){
        console.warn('YouTube player load error:',err);
        auraYTPlayerReady=false;
        toast('YouTube player could not load. Try again.','triangle-exclamation');
      }
    }

    export function closeYouTubePlayer(){
      stopAuraYouTube();
      const art=$('fullPlayerArt');
      if(art) art.classList.remove('youtube-mode');
      const badge=$('youtubeModeBadge');
      if(badge) badge.classList.remove('active');
    }

    export async function playYouTubeProResult(meta){
      const id=meta?.id || meta?.videoId;
      if(id && auraYTQueue.length){
        const qi=auraYTQueue.findIndex(x=>String(x?.id)===String(id));
        if(qi>=0) state.auraYTQueueIndex=qi;
      }
      const youtubeId=meta?._auraYoutubeId || meta?.videoId || extractYouTubeId(meta);
      if(!youtubeId){toast('This result has no playable YouTube ID','triangle-exclamation');return;}
      try{
        await playYouTubeInsideAura(
          youtubeId,
          meta?.title || meta?.name || 'YouTube Music',
          meta?.img || meta?.poster || '',
          !!meta?.favorite,
          true
        );
      }catch(err){
        console.warn('YouTube playback error:',err);
        toast('This YouTube video could not be played','triangle-exclamation');
      }
    }

/* ===== 5820-5852 ===== */
    /* ---------- Background/foreground playback resilience ----------
       Mobile browsers can silently pause an <state.audio> element (radio or the
       main player) when the screen locks or the tab is backgrounded. We
       can't override that OS-level policy from JS, but we CAN snapshot
       "was this actually playing right before we lost focus" and resume
       automatically the instant the tab/screen comes back — so playback
       picks back up on its own instead of staying stuck paused. */
    export let radioWasPlayingBeforeHidden = false;
    export let audioWasPlayingBeforeHidden = false;

    export function auraCaptureBackgroundState(){
      radioWasPlayingBeforeHidden = !!(currentRadioStation && state.radioIsPlaying && !radioAudio.paused);
      audioWasPlayingBeforeHidden = !!(state.isPlaying && state.audio.src && !state.audio.paused && !auraYTPlayer && !auraYTVideoId);
    }

    export function auraResumeAfterForeground(){
      if(radioWasPlayingBeforeHidden && currentRadioStation && radioAudio.paused){
        radioAudio.play().then(()=>{state.radioIsPlaying=true;updateRadioPlayerUI();}).catch(()=>{});
      }
      if(audioWasPlayingBeforeHidden && state.audio.src && state.audio.paused){
        state.audio.play().then(()=>{state.isPlaying=true;updatePlayState();}).catch(()=>{});
      }
      if(typeof effectCtx!=='undefined' && effectCtx && effectCtx.state==='suspended'){ effectCtx.resume().catch(()=>{}); }
      if(typeof auraMasterCtx!=='undefined' && auraMasterCtx && auraMasterCtx.state==='suspended'){ auraMasterCtx.resume().catch(()=>{}); }
    }

    document.addEventListener('visibilitychange', () => {
      if(document.hidden) auraCaptureBackgroundState();
      else auraResumeAfterForeground();
    });
    window.addEventListener('pageshow', auraResumeAfterForeground);
    window.addEventListener('focus', auraResumeAfterForeground);

/* ===== 5888-5985 ===== */
    export function setupMainMediaSession(){
      if(!('mediaSession' in navigator)) return;
      mediaSessionAction('play',()=>{ if(state.audio.src) state.audio.play().catch(()=>{}); });
      mediaSessionAction('pause',()=>{ state.audio.pause(); });
      mediaSessionAction('previoustrack',()=>{ playPrevious(); });
      mediaSessionAction('nexttrack',()=>{ playNext(); });
    }
    setupMainMediaSession();

    export function updateMainMediaSession(){
      if(!('mediaSession' in navigator)) return;
      const s = state.songs[state.currentIndex];
      if(!s || (auraYTPlayer || auraYTVideoId)) return; // YouTube playback manages its own session state
      try{
        navigator.mediaSession.metadata = new MediaMetadata({
          title: s.title || 'AURA Music',
          artist: s.artist || '',
          album: 'AURA Music',
          artwork: s.img ? [{src:s.img, sizes:'512x512', type:'image/png'}] : []
        });
        navigator.mediaSession.playbackState = state.audio.paused ? 'paused' : 'playing';
      }catch(e){}
    }

    export function loadSong(i){
      const s=state.songs[i]; if(!s) return; state.audio.src=s.url;
      $('currentImg').src=$('fullImg').src=s.img;
      $('currentTitle').textContent=$('fullTitle').textContent=$('fullHeaderTitle').textContent=s.title;
      $('currentArtist').textContent=$('fullArtist').textContent=s.artist;
      $('fullLikeBtn').className=`like-btn ${s.favorite?'active':''}`;
      $('fullLikeBtn').innerHTML=`<i class="fa-${s.favorite?'solid':'regular'} fa-heart"></i>`;
      $('progressFill').style.width = '0%';
      $('fullSeekSlider').value = 0;
      $('fullCurrentTime').textContent = '0:00';
      $('fullDurationTime').textContent = '0:00';
      const resetApi = (window as any).__auraMiniProgress;
      if(resetApi && resetApi.reset) resetApi.reset(false);
      applyDynamicPlayerColor(s.img);
      updateMainMediaSession();
      state.audio.load();
    }

    /* Some direct/streamed MP3 links don't report a usable duration right
       away (or report Infinity on Chrome for chunked/streamed state.audio).
       This forces the browser to resolve the real duration and keeps the
       duration label from being stuck at 0:00. */
    export function refreshDurationDisplay(){
      const d = state.audio.duration;
      if(!d || !isFinite(d)){
        if(d === Infinity){
          const onTimeUpdate = () => {
            state.audio.removeEventListener('timeupdate', onTimeUpdate);
            state.audio.currentTime = 0;
            if(isFinite(state.audio.duration)) $('fullDurationTime').textContent = fmt(state.audio.duration);
          };
          state.audio.addEventListener('timeupdate', onTimeUpdate);
          state.audio.currentTime = 1e101;
        }
        return;
      }
      $('fullDurationTime').textContent = fmt(d);
    }
    state.audio.addEventListener('loadedmetadata', refreshDurationDisplay);
    state.audio.addEventListener('durationchange', refreshDurationDisplay);

    export let lastPlayRequestAt=0;
    export function playSong(i, keepFull=false){
      lastPlayRequestAt=Date.now();
      const s=state.songs[i];
      if(!s) return;
      if(s.isYouTube && s.videoId){
        state.currentIndex=i;
        playYouTubeInsideAura(s.videoId,s.title,s.img,!!s.favorite,true);
        if(keepFull && !window.matchMedia('(min-width:900px)').matches){
          $('fullPlayerOverlay').classList.add('active');
        }
        return;
      }
      stopAuraYouTube();
      state.auraYTQueueIndex=-1;
      resetFullPlayerArtToImage(s.img||'');
      const keepBigPlayer = window.matchMedia('(min-width:900px)').matches && $('fullPlayerOverlay').classList.contains('active');
      stopRadio();
      if(keepBigPlayer || keepFull) $('fullPlayerOverlay').classList.add('active');
      if(s.missing){ toast('This file is unavailable — please re-add it', 'triangle-exclamation'); return; }
      state.currentIndex=i; loadSong(i); state.audio.play(); state.isPlaying=true;
      $('miniPlayer').classList.add('active');
      updatePlayState(); filterSongs(); addToRecent(s);
      updateLibNowPlaying();
      if(keepFull && !window.matchMedia('(min-width:900px)').matches){
        $('fullPlayerOverlay').classList.add('active');
      }
    }

    export function updatePlayState(){
      const icon = state.isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
      $('playIcon').className = $('fullPlayIcon').className = icon;
      // Apple-Music artwork pulse: springs between scale(1) and scale(.8)
      $('fullPlayerOverlay').classList.toggle('art-paused', !state.isPlaying);
    }

    // AURA play/pause controls — explicitly wired here so both the mini
    // player button and the full-player button always use the same handler.
    // This is especially important for YouTube playback because the button
    // must call the YouTube IFrame API player instance.
    $('playPauseBtn').onclick=e=>{ e.stopPropagation(); togglePlay(); };
    $('fullPlayBtn').onclick=e=>{ e.stopPropagation(); togglePlay(); };

/* ===== 6185-6273 ===== */
    export function togglePlay(){
      if(auraYTPlayer){
        if(!auraYTPlayerReady){
          toast('AURA player is still loading…','spinner');
          return;
        }
        try{
          const ytState=auraYTPlayer.getPlayerState();
          if(window.YT && ytState===YT.PlayerState.PLAYING){
            auraYTDesiredPlaying=false;
            auraYTPendingPlay=false;
            auraYTPlayer.pauseVideo();
            state.isPlaying=false;
          }else{
            auraYTDesiredPlaying=true;
            auraYTPendingPlay=true;
            auraYTPlayer.playVideo();
            state.isPlaying=true;
          }
        }catch(e){
          state.isPlaying=false;
        }
        updatePlayState();
        return;
      }
      if(auraYTVideoId){
        toast('AURA player is still loading…','spinner');
        return;
      }
      if(!state.audio.src) playSong(0);
      else if(state.isPlaying){ state.audio.pause(); state.isPlaying=false; }
      else{ state.audio.play(); state.isPlaying=true; }
      updatePlayState();
    }
    
    state.audio.addEventListener('loadedmetadata', ()=>{
      if(state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
        const lmdApi = (window as any).__auraMiniProgress;
        if(lmdApi && lmdApi.apply) lmdApi.apply(0, false);
      }
    });
    state.audio.addEventListener('timeupdate', ()=>{
      if(state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
        const pct=(state.audio.currentTime/state.audio.duration)*100;
        $('progressFill').style.width=pct+'%';
        $('fullSeekSlider').value=pct;
        $('fullCurrentTime').textContent=fmt(state.audio.currentTime);
        $('fullDurationTime').textContent=fmt(state.audio.duration);
        const tuApi = (window as any).__auraMiniProgress;
        if(tuApi && tuApi.apply) tuApi.apply(pct);
      }
    });
    state.audio.addEventListener('play',()=>{state.isPlaying=true;updatePlayState();updateMainMediaSession();});
    state.audio.addEventListener('pause',()=>{state.isPlaying=false;updatePlayState();updateMainMediaSession();});
    /* A listening room owns what plays next, so the personal autoplay rules
       stand down while one is active — otherwise a track finishing would race
       the room and start something nobody else was expecting. */
    state.audio.addEventListener('ended',()=>{
      if(roomModeActive()) return;
      if(state.repeatMode==='one'){state.audio.currentTime=0;state.audio.play();state.isPlaying=true;updatePlayState();return;}
      if(auraSettings.autoplayNext){playNext();}else if(!state.isPlaying) updatePlayState();
    });
    setInterval(()=>{
      if(!auraYTPlayer) return;
      try{
        const d=auraYTPlayer.getDuration()||0, c=auraYTPlayer.getCurrentTime()||0;
        if(d){ $('fullSeekSlider').value=(c/d)*100; $('fullCurrentTime').textContent=fmt(c); $('fullDurationTime').textContent=fmt(d); }
      }catch(e){}
    },500);
    $('fullSeekSlider').oninput=()=>{
      const pct=Number($('fullSeekSlider').value)||0;
      if(auraYTPlayer){
        try{
          const d=auraYTPlayer.getDuration();
          if(isFinite(d) && d>0){
            const t=(pct/100)*d;
            auraYTPlayer.seekTo(t,true);
            $('fullCurrentTime').textContent=fmt(t);
          }
        }catch(e){} return;
      }
      if(state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
        state.audio.currentTime=(pct/100)*state.audio.duration;
        $('fullCurrentTime').textContent=fmt((pct/100)*state.audio.duration);
      }
    };


    $('miniPlayer').onclick=e=>{
      if(e.target.closest('button,input')) return;
      if(window.matchMedia('(min-width:900px)').matches && !e.target.closest('.song-info')) return;
      $('fullPlayerOverlay').classList.add('active'); renderUpNext();
    };
    // Minimize the AURA full player without touching playback. The previous
    // handler paused the YouTube iframe when the user tapped the down arrow,
    // which made the song stop unexpectedly. Hiding the overlay is enough:
    // the YouTube IFrame remains alive and keeps playing underneath it.
    $('closeFullPlayerBtn').onclick=()=>{
      $('fullPlayerOverlay').classList.remove('active');
      closeUpNext();
      if(auraYTPlayer){
        try{
          const ytState=auraYTPlayer.getPlayerState();
          if(ytState===YT.PlayerState.PLAYING){
            state.isPlaying=true;
          } else if(ytState===YT.PlayerState.PAUSED){
            state.isPlaying=false;
          }
        }catch(e){}
      }
      updatePlayState();
    };

    export function filterSongs(){
      renderSongs(state.songs);
    }

