import { auraMasterCtx, effectCtx, ensureMusicOutput } from './ambience';
import { fmt, toast } from '../core/dom';
import { addToRecent, renderSongs, updateLibCount, updateLibNowPlaying } from './library';
import { closeUpNext, playNext, playPrevious, renderUpNext } from './queue';
import { currentRadioStation, escapeHtml, radioAudio, resumeRadioAfterForeground, setupRadioMediaSession, stopRadio, updateRadioPlayerUI } from './radio';
import { auraSettings } from './settings';
import { roomModeActive } from '../rooms/roomFlag';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
import { createPlaybackContext } from '../core/playback-context';
import { stableTrackRef, trackAvailable } from '../core/track-identity';
import { getAudioStreamUrl, hfFileUrl } from '../core/catalog';
import { AUDIO_VERSION_LABELS, AUDIO_VERSION_PREFERENCE_KEY, isAudioVersion, normalizeAudioVersions, resolveAudioVersion, type AudioVersion } from '../core/audio-versions';
import { ParallelAudioDeck, type VersionSources } from '../core/parallel-audio-deck';
import { fetchLyricsForTrack, renderLyrics, updateLyricsProgress, prepareLyricsForNewSong, getTrackKey, lyricsCache, startLyricsSyncLoop } from './lyrics';
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
    let playRequestSequence = 0;
    let youtubeGeneration = 0;
    let playbackIntent = false;
    export function currentPlaybackTime(): number {
      if (auraYTPlayer && auraYTPlayerReady) {
        try { return Number(auraYTPlayer.getCurrentTime()) || 0; } catch { return 0; }
      }
      return Number(state.audio.currentTime) || 0;
    }
    export function pausePlayback(): void {
      playbackIntent = false;
      auraYTDesiredPlaying = false;
      auraYTPendingPlay = false;
      try { if (auraYTPlayer) auraYTPlayer.pauseVideo(); else state.audio.pause(); } catch { /* already stopped */ }
      state.isPlaying = false;
      updatePlayState();
      updateMainMediaSession();
    }
    export function stopPersonalPlaybackForRadio(): void {
      pausePlayback();
      parallelDeck.dispose();
      state.activeAudioVersion = 'original';
      audioLoadGeneration += 1;
      clearPendingAudioMetadata();
      state.audio.onerror = null;
      stopAuraYouTube();
      resetFullPlayerArtToImage(state.activeTrack?.img || '');
    }
    export function cancelRadioForegroundResume(): void { radioWasPlayingBeforeHidden = false; }

    export function resumePlayback(): void {
      playbackIntent = true;
      /* index.html ships preload="none" so boot does not fetch audio for the
         track it displays. The first real play upgrade to "auto" so buffering
         starts immediately on the tap that asked for it. */
      state.audio.preload = 'auto';
      if (auraYTVideoId) {
        auraYTDesiredPlaying = true;
        auraYTPendingPlay = true;
        if (!auraYTPlayer || !auraYTPlayerReady) { state.isPlaying = false; updatePlayState(); return; }
        try { auraYTPlayer.playVideo(); } catch { state.isPlaying = false; updatePlayState(); }
        return;
      }
      if (!state.audio.getAttribute('src')) {
        const preserve = !!state.activeTrack && state.playbackContext?.currentId === stableTrackRef(state.activeTrack);
        playSong(state.currentIndex >= 0 ? state.currentIndex : 0,false,preserve);
        return;
      }
      if (!parallelDeck.loaded && !currentRadioStation) prepareAudioVersions(state.activeTrack);
      const request = playRequestSequence;
      const generation = audioLoadGeneration;
      void state.audio.play().catch((error) => {
        if (request !== playRequestSequence || generation !== audioLoadGeneration || error?.name === 'AbortError') return;
        playbackIntent = false;
        state.isPlaying = false;
        updatePlayState();
        if (error?.name === 'NotAllowedError') toast('Press Play to allow audio in this browser.', 'circle-info');
      });
      updatePlayState();
    }
    export function restartCurrentTrack(): void {
      try { if (auraYTPlayer) auraYTPlayer.seekTo(0, true); else state.audio.currentTime = 0; } catch { /* metadata may still be loading */ }
      resumePlayback();
    }
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

    export function ensureYouTubeAPI(): Promise<void> {
      if (window.YT?.Player) return Promise.resolve();
      if (auraYTReadyPromise) return auraYTReadyPromise;
      auraYTReadyPromise = new Promise<void>((resolve, reject) => {
        const previous = window.onYouTubeIframeAPIReady;
        const script = document.createElement('script');
        const timeout = window.setTimeout(() => fail(), 15000);
        const cleanup = () => window.clearTimeout(timeout);
        const fail = () => { cleanup(); auraYTReadyPromise = null; script.remove(); reject(new Error('YouTube API unavailable')); };
        window.onYouTubeIframeAPIReady = () => {
          cleanup();
          try { if (typeof previous === 'function') previous(); } catch { /* another consumer */ }
          auraYTReady = true;
          resolve();
        };
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.onerror = fail;
        document.head.appendChild(script);
      });
      return auraYTReadyPromise;
    }

    /* The YouTube IFrame API is loaded on demand by playYouTubeInsideAura().
       Preloading it here pulled YouTube's third-party script on every visit,
       including the majority that only play library/radio audio. */

    export function resetFullPlayerArtToImage(poster){
      const art=$('fullPlayerArt');
      if(!art) return;
      art.classList.remove('youtube-mode');
      art.innerHTML=`<img id="fullImg" src="${escapeHtml(poster||'')}" alt="">`;
      $('youtubeModeBadge').classList.remove('active');
    }

    export function stopAuraYouTube(){
      youtubeGeneration += 1;
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

    export async function playYouTubeInsideAura(videoId,title,poster,liked=false,autoPlay=true,selectedSong?:any){
      if(!/^[A-Za-z0-9_-]{11}$/.test(String(videoId))){toast('The YouTube video ID is invalid.','triangle-exclamation');return;}
      stopAuraYouTube();
      const generation = youtubeGeneration;
      const isCurrent = () => generation === youtubeGeneration && auraYTVideoId === String(videoId);
      lastPlayRequestAt = Date.now();
      if (!selectedSong) playRequestSequence += 1;
      stopRadio();
      parallelDeck.dispose();
      clearPendingAudioMetadata();
      audioVersionMessage = '';
      audioLoadGeneration += 1;
      if(state.audio){ try{state.audio.pause(); state.audio.removeAttribute('src'); state.audio.load();}catch(e){} }
      playbackIntent = autoPlay;
      state.isPlaying=false;
      auraYTPendingPlay=false;
      auraYTDesiredPlaying=false;
      auraYTPlayerReady=false;
      auraYTVideoId=String(videoId);
      auraYTPoster=poster||'';

      let ytArtist = selectedSong?.artist || 'YouTube';
      let ytTitle = selectedSong?.title || title || 'YouTube video';
      if (!selectedSong?.artist && ytTitle.includes(' - ')) {
        const parts = ytTitle.split(' - ');
        ytArtist = parts[0].trim();
        ytTitle = parts.slice(1).join(' - ').trim();
      }
      auraYTTitle = ytTitle;
      let idx = selectedSong ? state.songs.indexOf(selectedSong) : state.songs.findIndex((song) => song.isYouTube && String(song.videoId) === String(videoId));
      if (idx < 0) {
        const temporary = {id:`youtube-${videoId}`,title:ytTitle,artist:ytArtist,img:auraYTPoster,url:'',favorite:!!liked,isLocal:false,missing:false,isYouTube:true,videoId:String(videoId)};
        state.songs.push(temporary);
        idx = state.songs.length - 1;
      }
      if (!selectedSong) state.playbackContext = createPlaybackContext([stableTrackRef(state.songs[idx])], {
        source: 'manual', label: 'YouTube video', startId: stableTrackRef(state.songs[idx]),
      });
      state.currentIndex=idx;
      state.activeAudioVersion = 'original';
      state.songs[idx].favorite = !!liked || !!savedLikeMap[String(state.songs[idx].id)];
      $('currentImg').src=auraYTPoster;
      $('currentTitle').textContent=ytTitle;
      $('currentArtist').textContent=ytArtist;
      $('fullTitle').textContent=ytTitle;
      $('fullArtist').textContent=ytArtist;
      $('fullHeaderTitle').textContent=ytTitle;
      $('fullLikeBtn').className=`like-btn ${state.songs[idx].favorite?'active':''}`;
      $('fullLikeBtn').innerHTML=`<i class="fa-${state.songs[idx].favorite?'solid':'regular'} fa-heart"></i>`;
      applyDynamicPlayerColor(auraYTPoster);
      $('miniPlayer').classList.add('active');
      $('fullPlayerOverlay').classList.add('active');
      $('youtubeModeBadge').classList.add('active');
      updateLibCount();
      renderUpNext();
      if(state.songs[idx].favorite) persistLikedHistory();

      const art=$('fullPlayerArt');
      art.classList.add('youtube-mode');
      art.innerHTML=`<div id="auraYTFrameHost" style="width:100%;height:100%;background:#000"></div>`;
      refreshTrackMetadata(state.songs[idx]);
      updatePlayState();
      setupMainMediaSession();
      updateMainMediaSession();
      if (lyricsPanelOpen()) {
        prepareLyricsForNewSong(ytTitle, ytArtist, videoId);
        void fetchLyricsForTrack(ytTitle, ytArtist, state.songs[idx].duration, videoId).then((lyrics) => {
          if (isCurrent() && lyricsPanelOpen()) renderLyrics(lyrics);
        });
      }

      try{
        // IMPORTANT: finish loading the API and create the player before the
        // user is expected to press AURA Play. This avoids the mobile race where
        // playVideo() is called before the iframe is ready and gets blocked.
        await ensureYouTubeAPI();
        if (!isCurrent()) return;
        auraYTPlayer=new YT.Player('auraYTFrameHost',{
          videoId:auraYTVideoId,
          width:'100%',height:'100%',
          playerVars:{autoplay:0,playsinline:1,rel:0,controls:1,enablejsapi:1,origin:(location.protocol==='http:'||location.protocol==='https:')?location.origin:undefined},
          events:{
            onReady:()=>{
              if (!isCurrent()) return;
              auraYTPlayerReady=true;
              auraYTPendingPlay=false;
              state.isPlaying=false;
              updatePlayState();
              if(playbackIntent){
                try{ auraYTDesiredPlaying=true; auraYTPendingPlay=true; auraYTPlayer.playVideo(); }catch(e){}
              } else { try { auraYTPlayer.pauseVideo(); } catch { /* already paused */ } }
            },
            onStateChange:(e)=>{
              if(!window.YT || !isCurrent()) return;
              if(e.data===YT.PlayerState.PLAYING){
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=true;
                state.isPlaying=true;
                recordPlaybackStart();
                updatePlayState();
                updateMainMediaSession();
              }else if(e.data===YT.PlayerState.PAUSED){
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=false;
                state.isPlaying=false;
                updatePlayState();
              }else if(e.data===YT.PlayerState.ENDED){
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=false;
                state.isPlaying=false;
                updatePlayState();
                if (!roomModeActive() && (auraSettings.autoplayNext || state.repeatMode === 'one')) {
                  playNext(false, 'ended');
                }
              }
              // BUFFERING / CUED / UNSTARTED do not change the AURA play state.
            },
            onAutoplayBlocked:()=>{
              if (!isCurrent()) return;
              playbackIntent = false;
              // Do not flip AURA into a fake playing state when the browser blocks
              // scripted playback. The user can press AURA Play again directly.
              auraYTPendingPlay=false;
              auraYTDesiredPlaying=false;
              state.isPlaying=false;
              updatePlayState();
            },
            onError:(e)=>{
              if (!isCurrent()) return;
              playbackIntent = false;
              auraYTPlayerReady=false;
              state.isPlaying=false;
              updatePlayState();
              toast('This YouTube video cannot be embedded. Try another song.','triangle-exclamation');
            }
          }
        });
      }catch(err){
        if (!isCurrent()) return;
        auraYTPlayerReady=false;
        playbackIntent = false;
        state.isPlaying = false;
        updatePlayState();
        toast('YouTube player could not load. Select the track again to retry.','triangle-exclamation');
      }
    }

    export function closeYouTubePlayer(){
      stopAuraYouTube();
      const art=$('fullPlayerArt');
      if(art) art.classList.remove('youtube-mode');
      const badge=$('youtubeModeBadge');
      if(badge) badge.classList.remove('active');
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
      const resumeRadio = radioWasPlayingBeforeHidden, resumeAudio = audioWasPlayingBeforeHidden;
      radioWasPlayingBeforeHidden = audioWasPlayingBeforeHidden = false;
      if(resumeRadio && currentRadioStation && radioAudio.paused) resumeRadioAfterForeground();
      if(resumeAudio && playbackIntent && !auraYTVideoId && state.audio.src && state.audio.paused) resumePlayback();
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
      if(currentRadioStation) { setupRadioMediaSession(); return; }
      mediaSessionAction('play',resumePlayback);
      mediaSessionAction('pause',pausePlayback);
      mediaSessionAction('stop',pausePlayback);
      mediaSessionAction('previoustrack',()=>{ playPrevious(); });
      mediaSessionAction('nexttrack',()=>{ playNext(); });
      mediaSessionAction('seekto',(event)=>{
        if (!Number.isFinite(event.seekTime)) return;
        try { if (auraYTPlayer) auraYTPlayer.seekTo(event.seekTime,true); else state.audio.currentTime=event.seekTime; } catch { /* no seekable media */ }
      });
    }
    setupMainMediaSession();

    export function updateMainMediaSession(){
      if(!('mediaSession' in navigator)) return;
      const s = state.songs[state.currentIndex];
      if(!s || currentRadioStation) return;
      try{
        navigator.mediaSession.metadata = new MediaMetadata({
          title: s.title || 'Aura Music',
          artist: s.artist || '',
          album: s.album || 'Aura Music',
          artwork: s.img ? [{src:new URL(s.img,location.href).href}] : []
        });
        navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
      }catch(e){}
    }

    let audioLoadGeneration = 0;
    let pendingAudioPosition: number | null = null;
    let pendingAudioMetadata: (() => void) | null = null;
    let audioVersionMessage = '';
    const parallelDeck = new ParallelAudioDeck(state.audio, ensureMusicOutput, (version, message) => {
      state.activeAudioVersion = version;
      audioVersionMessage = message;
      refreshAudioVersionControls();
    });
    function prepareAudioVersions(song: any): void {
      if (!song?.isHf || song.isLocal || song.isYouTube || roomModeActive()) return;
      const files = normalizeAudioVersions(song.audioVersions);
      if (!Object.keys(files).length) return;
      const sources: VersionSources = {original: [song.url, song.hfUrl].filter(Boolean)};
      for (const [version, file] of Object.entries(files)) {
        sources[version] = [getAudioStreamUrl(file.path), hfFileUrl(file.path)];
      }
      parallelDeck.load(sources, resolveAudioVersion(song, state.preferredAudioVersion));
    }
    window.addEventListener('aura:room-mode-changed', () => {
      if (roomModeActive()) { parallelDeck.dispose(); state.activeAudioVersion = 'original'; }
      refreshAudioVersionControls();
    });

    function clearPendingAudioMetadata(): void {
      if (pendingAudioMetadata) state.audio.removeEventListener('loadedmetadata', pendingAudioMetadata);
      pendingAudioMetadata = null;
      pendingAudioPosition = null;
    }

    export function refreshAudioVersionControls(): void {
      const song = state.activeTrack;
      const files = normalizeAudioVersions(song?.audioVersions);
      const visible = !!song?.isHf && !song.isLocal && !song.isYouTube;
      const blocked = !!currentRadioStation || roomModeActive() || !visible;
      for (const id of ['miniVersionControl', 'fullVersionControl']) {
        const control = $(id);
        if (control) control.hidden = !visible;
      }
      for (const id of ['miniAudioVersion', 'fullAudioVersion']) {
        const group = $(id);
        if (!group) continue;
        const selected = audioVersionMessage && parallelDeck.requested !== 'original'
          ? parallelDeck.requested : state.activeAudioVersion;
        group.style.setProperty('--version-index', String(['original', 'bass', 'bass-reverb'].indexOf(selected)));
        for (const button of group.querySelectorAll<HTMLButtonElement>('[data-audio-version]')) {
          const version = button.dataset.audioVersion as AudioVersion;
          const available = version === 'original' || !!files[version];
          button.disabled = blocked || !available;
          button.setAttribute('aria-checked', String(version === selected));
          button.tabIndex = version === selected && !button.disabled ? 0 : -1;
          button.dataset.loadState = parallelDeck.states[version] || (available ? 'ready' : 'unavailable');
        }
      }
      const status = $('audioVersionStatus');
      if (status) {
        const unavailable = state.preferredAudioVersion !== 'original' && !files[state.preferredAudioVersion];
        const text = blocked ? '' : audioVersionMessage || (unavailable
          ? `${AUDIO_VERSION_LABELS[state.preferredAudioVersion]} isn't available for this song. Using Original.` : '');
        status.textContent = text;
        status.hidden = !text;
      }
    }

    /** Changing a source does not select a song, mutate its identity or record
     * another listen. All retries share the same personal transport intent. */
    function loadAudioVersionSource(song: any, version: AudioVersion, position?: number, resumeWhenReady = false): void {
      const file = version === 'original' ? null : normalizeAudioVersions(song.audioVersions)[version];
      const sources: Array<{url: string; version: AudioVersion}> = [];
      if (file) sources.push(
        {url: getAudioStreamUrl(file.path), version}, {url: hfFileUrl(file.path), version},
      );
      if (song.url && !song.missing) sources.push({url: song.url, version: 'original'});
      if (song.hfUrl && !song.missing && song.hfUrl !== song.url) sources.push({url: song.hfUrl, version: 'original'});
      let sourceIndex = 0;
      let restorePosition = Math.max(0, Number(position) || 0);
      audioVersionMessage = '';
      const attempt = (resume: boolean) => {
        const source = sources[sourceIndex];
        const generation = ++audioLoadGeneration;
        clearPendingAudioMetadata();
        state.activeAudioVersion = source?.version || 'original';
        if (source?.version === 'original' && file) {
          audioVersionMessage = `Couldn't load ${AUDIO_VERSION_LABELS[version]}. Using Original.`;
        }
        refreshAudioVersionControls();
        const isCurrent = () => generation === audioLoadGeneration && !auraYTVideoId && !currentRadioStation;
        state.audio.onerror = () => {
          if (!isCurrent()) return;
          if (state.audio.readyState >= 1) restorePosition = currentPlaybackTime();
          const shouldResume = playbackIntent;
          sourceIndex += 1;
          if (sources[sourceIndex]) { attempt(shouldResume); return; }
          clearPendingAudioMetadata();
          parallelDeck.dispose();
          playbackIntent = false;
          state.isPlaying = false;
          audioVersionMessage = 'This audio could not load. Try another version or check your connection.';
          updatePlayState();
          if (lastPlayRequestAt) toast(audioVersionMessage, 'triangle-exclamation');
        };
        if (!source) { state.audio.removeAttribute('src'); state.audio.load(); return; }
        const restore = position !== undefined || sourceIndex > 0;
        pendingAudioPosition = restore ? restorePosition : null;
        pendingAudioMetadata = () => {
          if (!isCurrent()) return;
          clearPendingAudioMetadata();
          const duration = state.audio.duration;
          if (restore) {
            try { state.audio.currentTime = Number.isFinite(duration) && duration > 0
              ? Math.min(restorePosition, Math.max(0, duration - .05)) : restorePosition; } catch { /* non-seekable source */ }
          }
          if (resume && playbackIntent) resumePlayback();
          updateMainMediaSession();
        };
        state.audio.addEventListener('loadedmetadata', pendingAudioMetadata, {once: true});
        state.audio.src = source.url;
        state.audio.load();
      };
      attempt(resumeWhenReady);
    }

    export function selectAudioVersion(value: unknown): boolean {
      const song = state.activeTrack;
      if (!isAudioVersion(value) || !song?.isHf || song.isLocal || song.isYouTube || currentRadioStation || roomModeActive()) return false;
      if (value !== 'original' && resolveAudioVersion(song, value) !== value) { refreshAudioVersionControls(); return false; }
      state.preferredAudioVersion = value;
      try { localStorage.setItem(AUDIO_VERSION_PREFERENCE_KEY, value); } catch { /* selection still works for this tab */ }
      parallelDeck.select(value);
      return true;
    }

    for (const id of ['miniAudioVersion', 'fullAudioVersion']) {
      const group = $(id);
      group?.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-audio-version]');
        if (button && !button.disabled) selectAudioVersion(button.dataset.audioVersion);
      });
      group?.addEventListener('keydown', (event: KeyboardEvent) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...group.querySelectorAll<HTMLButtonElement>('[data-audio-version]')].filter(button => !button.disabled);
        if (!buttons.length) return;
        event.preventDefault();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next].focus();
        selectAudioVersion(buttons[next].dataset.audioVersion);
      });
    }
    export function refreshTrackMetadata(song: any): void {
      if (!song) return;
      state.activeTrack = song;
      for (const id of ['currentTitle','fullTitle','fullHeaderTitle']) {
        const title = $(id);
        if (title) { title.textContent = song.title || 'Untitled'; title.dataset.rawTitle = song.title || 'Untitled'; }
      }
      $('currentArtist').textContent = $('fullArtist').textContent = song.artist || 'Unknown artist';
      ($('currentImg') as HTMLImageElement).src = song.img || '';
      const image = $('fullImg') as HTMLImageElement | null;
      if (image) image.src = song.img || '';
      $('fullLikeBtn').classList.toggle('active', !!song.favorite);
      $('fullLikeBtn').setAttribute('aria-pressed', song.favorite ? 'true' : 'false');
      $('fullLikeBtn').innerHTML = `<i class="fa-${song.favorite ? 'solid' : 'regular'} fa-heart"></i>`;
      refreshAudioVersionControls();
      updateMainMediaSession();
    }

    export function loadSong(i, prepareVersions = true, loadSource = true){
      const song = state.songs[i];
      if (!song) return;
      parallelDeck.dispose();
      refreshTrackMetadata(song);
      /* Boot also skips the <audio> source: Chrome's load() starts a range
         request even with preload="none", so assigning it for artwork alone
         pulled audio the listener never asked for. First play assigns it. */
      if (loadSource) loadAudioVersionSource(song, 'original');
      else { state.activeAudioVersion = 'original'; audioVersionMessage = ''; refreshAudioVersionControls(); }
      /* Boot primes the player bar with art and metadata only. Preparing the
         bass / bass-reverb renditions downloads and decodes every version of
         the track, which must never happen before the listener presses play
         (tools/bench, docs/performance.md: this was megabytes on mobile). */
      if (prepareVersions) prepareAudioVersions(song);
      const generation = audioLoadGeneration;
      $('progressFill').style.width = '0%';
      $('fullSeekSlider').value = 0;
      $('fullCurrentTime').textContent = '0:00';
      $('fullDurationTime').textContent = '0:00';
      const resetApi = (window as any).__auraMiniProgress;
      resetApi?.reset?.(false);
      applyDynamicPlayerColor(song.img);
      setupMainMediaSession();
      if (lyricsPanelOpen()) {
        prepareLyricsForNewSong(song.title,song.artist,song.videoId);
        void fetchLyricsForTrack(song.title,song.artist,song.duration,song.videoId).then((lyrics) => {
          if (generation === audioLoadGeneration && lyricsPanelOpen()) renderLyrics(lyrics);
        });
      }
    }

    /* True while the lyrics sheet is showing the lyrics tab (not Related). */
    function lyricsPanelOpen(): boolean{
      const sheet = $('upNextSheet');
      return !!sheet && sheet.classList.contains('active') && (sheet.getAttribute('data-tab') || 'lyrics') === 'lyrics';
    }

    /* The lyrics sheet can also be opened from outside the player (the Up Next
       button). Because lyrics are no longer fetched on every play, make sure
       what the panel shows belongs to the track that is actually playing. */
    export function refreshLyricsForOpenSheet(){
      if(!lyricsPanelOpen()) return;
      switchRightPanelTab('lyrics');
    }

    /* Some direct/streamed MP3 links don't report a usable duration right
       away (or report Infinity on Chrome for chunked streams). Show it as soon
       as it is known; 'durationchange' fires again when it resolves. */
    export function refreshDurationDisplay(){
      const d = state.audio.duration;
      /* Streamed MP3s can report Infinity until the browser has probed further
         into the file. The old code forced that probe by seeking to 1e101 and
         then snapping the playhead back to 0: on mobile WebViews that seek can
         hang the element (audio stops, progress freezes) and it threw away the
         listener's position. 'durationchange' fires again once the real length
         is known, so simply show it when it is available. */
      if(!d || !isFinite(d)) return;
      $('fullDurationTime').textContent = fmt(d);
    }
    state.audio.addEventListener('loadedmetadata', refreshDurationDisplay);
    state.audio.addEventListener('durationchange', refreshDurationDisplay);

    export let lastPlayRequestAt=0;
    let lastRecordedRequest = -1;
    function recordPlaybackStart(): void {
      if (!playRequestSequence || lastRecordedRequest === playRequestSequence || roomModeActive()) return;
      lastRecordedRequest = playRequestSequence;
      const song = state.songs[state.currentIndex];
      if (song) addToRecent(song);
    }
    export function playSong(i, keepFull=false, preserveContext=false): boolean {
      const song = state.songs[i];
      if (!trackAvailable(song)) {
        toast('This track is unavailable. Relink the file in its playlist or select another track.', 'triangle-exclamation');
        return false;
      }
      lastPlayRequestAt = Date.now();
      playRequestSequence += 1;
      playbackIntent = true;
      state.audio.preload = 'auto';
      if (!preserveContext) {
        state.playbackContext = createPlaybackContext(state.songs.filter(trackAvailable).map(stableTrackRef), {
          source: 'library', label: 'Library', startId: stableTrackRef(song), shuffle: state.isShuffle,
        });
      }
      state.currentIndex = i;
      if (song.isYouTube) {
        void playYouTubeInsideAura(song.videoId,song.title,song.img,!!song.favorite,true,song);
        return true;
      }
      stopAuraYouTube();
      state.audio.pause();
      state.isPlaying = false;
      stopRadio();
      resetFullPlayerArtToImage(song.img || '');
      loadSong(i);
      $('miniPlayer').classList.add('active');
      if (keepFull) $('fullPlayerOverlay').classList.add('active');
      updatePlayState();
      resumePlayback();
      if ($('tabLibrary')?.classList.contains('active')) filterSongs();
      updateLibNowPlaying();
      renderUpNext();
      return true;
    }

    export function updatePlayState(){
      refreshAudioVersionControls();
      const pending = playbackIntent && ((!!auraYTVideoId && !auraYTPlayerReady) ||
        (!auraYTVideoId && !currentRadioStation && !state.isPlaying && !state.audio.paused));
      const icon = state.isPlaying ? 'fa-solid fa-pause' : pending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play';
      $('playIcon').className = $('fullPlayIcon').className = icon;
      const label = state.isPlaying ? 'Pause' : pending ? 'Cancel pending playback' : 'Play';
      $('fullPlayBtn')?.setAttribute('aria-label', label);
      $('playPauseBtn')?.setAttribute('aria-label', label);
      // Apple-Music artwork pulse: springs between scale(1) and scale(.8)
      $('fullPlayerOverlay').classList.toggle('art-paused', !state.isPlaying);
      window.dispatchEvent(new Event('aura:playback-changed'));
    }

    // AURA play/pause controls — explicitly wired here so both the mini
    // player button and the full-player button always use the same handler.
    // This is especially important for YouTube playback because the button
    // must call the YouTube IFrame API player instance.
    $('playPauseBtn').onclick=e=>{ e.stopPropagation(); togglePlay(); };
    $('fullPlayBtn').onclick=e=>{ e.stopPropagation(); togglePlay(); };

/* ===== 6185-6273 ===== */
    export function togglePlay(){
      if (auraYTVideoId && !auraYTPlayerReady) {
        if (playbackIntent) pausePlayback(); else resumePlayback();
        return;
      }
      if (state.isPlaying || auraYTPendingPlay || (!auraYTVideoId && playbackIntent && !state.audio.paused)) pausePlayback();
      else resumePlayback();
    }
    
    state.audio.addEventListener('loadedmetadata', ()=>{
      if(state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
        const lmdApi = (window as any).__auraMiniProgress;
        if(lmdApi && lmdApi.apply) lmdApi.apply(0, false);
      }
    });
    /* While a thumb is being dragged, timeupdate must not write the value back
       — otherwise the playhead fights the finger and seeking feels stuck. */
    let fullSeekDragging = false;
    const fullSeekEl = $('fullSeekSlider') as HTMLInputElement;
    fullSeekEl.addEventListener('pointerdown', ()=>{ fullSeekDragging = true; });
    fullSeekEl.addEventListener('change', ()=>{ fullSeekDragging = false; });
    window.addEventListener('pointerup', ()=>{ fullSeekDragging = false; });
    window.addEventListener('pointercancel', ()=>{ fullSeekDragging = false; });

    /* Throttled timeupdate handler — mobile browsers fire this very frequently
   (4-10x/sec). We batch DOM writes to avoid layout thrashing and lag.
   Lyrics progress is now handled by the dedicated lyrics sync loop. */
    let timeUpdateRaf = 0;
    let lastTimeUpdate = 0;
    state.audio.addEventListener('timeupdate', ()=>{
      const now = performance.now();
      // Throttle to ~30fps (33ms) max to prevent UI lag on mobile
      if (now - lastTimeUpdate < 33) return;
      lastTimeUpdate = now;

      if (timeUpdateRaf) cancelAnimationFrame(timeUpdateRaf);
      timeUpdateRaf = requestAnimationFrame(() => {
        if(state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
          const pct=(state.audio.currentTime/state.audio.duration)*100;
          $('progressFill').style.width=pct+'%';
          if(!fullSeekDragging) $('fullSeekSlider').value=pct;
          $('fullCurrentTime').textContent=fmt(state.audio.currentTime);
          $('fullDurationTime').textContent=fmt(state.audio.duration);
          const tuApi = (window as any).__auraMiniProgress;
          if(tuApi && tuApi.apply) tuApi.apply(pct);
        }
        // updateLyricsProgress moved to lyrics sync loop to avoid duplicate work
      });
    });
    state.audio.addEventListener('playing',()=>{
      if (auraYTVideoId || currentRadioStation) return;
      state.isPlaying=true;
      recordPlaybackStart();
      updatePlayState();
      updateMainMediaSession();
    });
    state.audio.addEventListener('pause',()=>{
      if (auraYTVideoId) return;
      state.isPlaying=false;
      updatePlayState();
      updateMainMediaSession();
    });
    /* A listening room owns what plays next, so the personal autoplay rules
       stand down while one is active — otherwise a track finishing would race
       the room and start something nobody else was expecting. */
    state.audio.addEventListener('ended',()=>{
      if(roomModeActive() || auraYTVideoId || currentRadioStation) return;
      state.isPlaying = false;
      updatePlayState();
      if (auraSettings.autoplayNext || state.repeatMode === 'one') playNext(false, 'ended');
    });
    setInterval(()=>{
      if(!auraYTPlayer || document.hidden) return;
      try{
        const d=auraYTPlayer.getDuration()||0, c=auraYTPlayer.getCurrentTime()||0;
        if(d){ if(!fullSeekDragging) $('fullSeekSlider').value=(c/d)*100; $('fullCurrentTime').textContent=fmt(c); $('fullDurationTime').textContent=fmt(d); }
        // updateLyricsProgress handled by lyrics sync loop
      }catch(e){}
    },1000); // Reduced from 500ms to 1000ms for mobile performance
    $('fullSeekSlider').oninput=()=>{
      const pct=Number($('fullSeekSlider').value)||0;
      if(auraYTPlayer){
        try{
          const d=auraYTPlayer.getDuration();
          if(isFinite(d) && d>0){
            const t=(pct/100)*d;
            auraYTPlayer.seekTo(t,true);
            $('fullCurrentTime').textContent=fmt(t);
            updateLyricsProgress(t);
          }
        }catch(e){} return;
      }
      if(state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
        const targetTime = (pct/100)*state.audio.duration;
        state.audio.currentTime=targetTime;
        $('fullCurrentTime').textContent=fmt(targetTime);
        updateLyricsProgress(targetTime);
      }
    };

    /* Tap the big artwork to play/pause — same handler as the play button so
       both stay in sync and share the grow/shrink pulse. Swipes and drags are
       ignored (only a short, still pointer press counts as a tap). */
    const artTap = $('fullPlayerArt');
    let artTapDownX = 0, artTapDownY = 0, artTapDownT = 0;
    artTap.addEventListener('pointerdown', e => {
      artTapDownX = e.clientX; artTapDownY = e.clientY; artTapDownT = Date.now();
    });
    artTap.addEventListener('pointerup', e => {
      if(Math.abs(e.clientX - artTapDownX) > 12 || Math.abs(e.clientY - artTapDownY) > 12) return;
      if(Date.now() - artTapDownT > 600) return;
      togglePlay();
    });


    $('miniTrackOpenBtn').onclick=()=>{
      $('fullPlayerOverlay').classList.add('active'); renderUpNext();
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

    export function getCurrentActiveTrack(): { title: string; artist: string; videoId?: string; duration?: number } | null {
      if (auraYTVideoId) {
        const song = state.songs[state.currentIndex];
        return { title: song?.title || auraYTTitle, artist: song?.artist || 'YouTube', videoId: auraYTVideoId, duration: song?.duration };
      }
      const s = state.songs[state.currentIndex];
      if (!s) return null;
      let title = s.title || '';
      let artist = s.artist || '';
      if ((!artist || artist === 'YouTube Music' || artist === 'Unknown Artist') && title.includes(' - ')) {
        const parts = title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
      return { title, artist, videoId: s.videoId, duration: s.duration };
    }

    export type PlayerSheetTab = 'lyrics' | 'related' | 'queue';
    export function switchRightPanelTab(tab: PlayerSheetTab) {
      const sheet = $('upNextSheet');
      if (sheet) sheet.dataset.tab = tab;
      for (const name of ['lyrics','related','queue'] as const) {
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
        const panel = $(`ytm${capitalized}Panel`);
        if (panel) panel.hidden = name !== tab;
        for (const id of [`ytmTab${capitalized}Btn`,`playerTab${capitalized}Btn`]) {
          const button = $(id);
          button?.classList.toggle('active',name === tab);
          button?.setAttribute('aria-selected',String(name === tab));
        }
      }
      if (tab === 'queue') { renderUpNext(); return; }
      if (tab === 'related') { renderRelated(); return; }
      const cur = getCurrentActiveTrack();
      if (!cur) return;
      const request = playRequestSequence;
      const key = getTrackKey(cur.title,cur.artist);
      if (lyricsCache.has(key)) renderLyrics(lyricsCache.get(key) || null);
      else {
        prepareLyricsForNewSong(cur.title,cur.artist,cur.videoId);
        void fetchLyricsForTrack(cur.title,cur.artist,cur.duration,cur.videoId).then((lyrics) => {
          if (request === playRequestSequence && lyricsPanelOpen()) renderLyrics(lyrics);
        });
      }
      setTimeout(() => { if (lyricsPanelOpen()) (window as any).centerActiveLyricLine?.(undefined,false); },50);
    }

    export function openPlayerSheet(tab: PlayerSheetTab = 'lyrics') {
      switchRightPanelTab(tab);
      const sheet = $('upNextSheet');
      if (sheet) {
        sheet.classList.add('active');
        sheet.setAttribute('aria-hidden', 'false');
        if (tab === 'lyrics') {
          /* The lyrics loop only runs while this sheet is on screen. */
          startLyricsSyncLoop();
          setTimeout(() => {
            (window as any).centerActiveLyricLine?.(undefined, false);
          }, 180);
        }
      }
    }

    export function closePlayerSheet() {
      const sheet = $('upNextSheet');
      if (sheet) {
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
      }
    }

    export function renderRelated() {
      const container = $('ytmRelatedList');
      if (!container) return;
      const currentSong = state.songs[state.currentIndex];
      if (!currentSong) return;

      const currentArtist = (currentSong.artist || '').toLowerCase().trim();

      // Tracks by same artist
      const sameArtistSongs = state.songs.filter((s, idx) => {
        if (idx === state.currentIndex) return false;
        const a = (s.artist || '').toLowerCase().trim();
        return a && (a === currentArtist || a.includes(currentArtist) || currentArtist.includes(a));
      });

      // Other recommended tracks
      const otherSongs = state.songs.filter((s, idx) => {
        if (idx === state.currentIndex) return false;
        return !sameArtistSongs.some(same => same.id === s.id);
      });

      const youMightLike = otherSongs.slice(0, 5);

      let html = '';

      // Section 1: You might also like
      if (youMightLike.length > 0) {
        html += `
          <div class="ytm-rel-section">
            <div class="ytm-rel-section-title">More from your library</div>
            <div class="ytm-rel-grid">
              ${youMightLike.map(s => {
                const originalIdx = state.songs.findIndex(x => x.id === s.id);
                return `
                  <div class="ytm-rel-card" data-play-song-id="${escapeHtml(s.id)}" role="button" tabindex="0">
                    <div class="ytm-rel-art-wrap">
                      <img src="${escapeHtml(s.img || '')}" alt="" loading="lazy">
                      <div class="ytm-rel-play-overlay"><i class="fa-solid fa-play"></i></div>
                    </div>
                    <div class="ytm-rel-info">
                      <div class="ytm-rel-title">${escapeHtml(s.title || '')}</div>
                      <div class="ytm-rel-artist">${escapeHtml(s.artist || '')}</div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }

      // Section 3: More from this artist
      if (sameArtistSongs.length > 0) {
        html += `
          <div class="ytm-rel-section">
            <div class="ytm-rel-section-title">More by ${escapeHtml(currentSong.artist || '')}</div>
            <div class="ytm-rel-list">
              ${sameArtistSongs.map(s => {
                const originalIdx = state.songs.findIndex(x => x.id === s.id);
                return `
                  <div class="ytm-rel-row" data-play-song-id="${escapeHtml(s.id)}" role="button" tabindex="0">
                    <img class="ytm-rel-row-img" src="${escapeHtml(s.img || '')}" alt="" loading="lazy">
                    <div class="ytm-rel-row-meta">
                      <div class="ytm-rel-row-title">${escapeHtml(s.title || '')}</div>
                      <div class="ytm-rel-row-sub">${escapeHtml(s.artist || '')}</div>
                    </div>
                    <span class="ytm-rel-row-play" aria-hidden="true"><i class="fa-solid fa-play"></i></span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
    }

    if (typeof window !== 'undefined') {
      (window as any).switchRightPanelTab = switchRightPanelTab;
      (window as any).openPlayerSheet = openPlayerSheet;
      (window as any).closePlayerSheet = closePlayerSheet;
    }
