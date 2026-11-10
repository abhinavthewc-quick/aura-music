import { auraMasterCtx, effectCtx } from './ambience';
import { fmt, toast } from '../core/dom';
import { addToRecent, renderSongs, updateLibCount, updateLibNowPlaying } from './library';
import { closeUpNext, playNext, playPrevious, renderUpNext } from './queue';
import { currentRadioStation, escapeHtml, radioAudio, stopRadio, toggleRadioPlay, updateRadioPlayerUI } from './radio';
import { auraYTQueue, extractYouTubeId } from './search';
import { auraSettings } from './settings';
import { roomModeActive } from '../rooms/roomFlag';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
import { beginPlaybackIntent, getPlaybackIntent } from '../core/playbackIntent';
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
      if(!imgUrl){ applyPlayerGradient(null); return; }
      const cached = dynamicColorCache[imgUrl];
      if(cached !== undefined){
        applyPlayerGradient(cached);
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
        }catch(err){
          dynamicColorCache[imgUrl] = null;
          applyPlayerGradient(null);
        }
      };
      img.onerror = () => { dynamicColorCache[imgUrl] = null; applyPlayerGradient(null); };
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

    type YouTubePlayback = {
      intent: number;
      videoId: string;
      player: any;
      ended: boolean;
      advanceTimer: ReturnType<typeof setTimeout> | null;
    };
    let youtubePlayback: YouTubePlayback | null = null;
    let activePlaybackSource: 'audio' | 'youtube' | null = null;
    let audioLoadRevision = 0;

    function isCurrentYouTube(playback: YouTubePlayback): boolean {
      return youtubePlayback === playback && playback.intent === getPlaybackIntent() &&
        activePlaybackSource === 'youtube' && !currentRadioStation && !roomModeActive();
    }

    function cancelYouTubeAdvance(playback = youtubePlayback): void {
      if(!playback) return;
      if(playback.advanceTimer !== null) clearTimeout(playback.advanceTimer);
      playback.advanceTimer = null;
      playback.ended = false;
    }

    function isAudioSourceActive(): boolean {
      return activePlaybackSource === 'audio' && !auraYTVideoId &&
        !currentRadioStation && !roomModeActive() && !!state.audio.getAttribute('src');
    }

    /* The selected source owns the clock even when paused or still loading.
       Never fall back to a previously loaded audio element when YouTube is at 0. */
    export function getActivePlaybackTime(): number {
      let time = 0;
      try{
        if(youtubePlayback && isCurrentYouTube(youtubePlayback)){
          if(auraYTPlayerReady) time = youtubePlayback.player.getCurrentTime();
        }else if(isAudioSourceActive()){
          time = state.audio.currentTime;
        }
      }catch(_){}
      return Number.isFinite(time) ? Math.max(0, time) : 0;
    }

    /* Seeking changes position only. In particular, a paused lyric click must
       not start playback, and an unavailable iframe must not seek library audio. */
    export function seekActivePlayback(time: number): boolean {
      if(!Number.isFinite(time)) return false;
      const target = Math.max(0, time);
      try{
        if(youtubePlayback && isCurrentYouTube(youtubePlayback)){
          if(!auraYTPlayerReady) return false;
          cancelYouTubeAdvance();
          youtubePlayback.player.seekTo(target, true);
          return true;
        }
        if(isAudioSourceActive()){
          state.audio.currentTime = target;
          return true;
        }
      }catch(_){}
      return false;
    }

    function requestAudioPlayback(intent = getPlaybackIntent()): void {
      const revision = audioLoadRevision;
      state.isPlaying = true;
      state.audio.play().catch(err => {
        if(intent !== getPlaybackIntent() || revision !== audioLoadRevision || !isAudioSourceActive()) return;
        if(err?.name === 'AbortError') return;
        state.isPlaying = false;
        updatePlayState();
      });
    }

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

    /* The YouTube IFrame API is loaded on demand by playYouTubeInsideAura().
       Preloading it here pulled YouTube's third-party script on every visit,
       including the majority that only play library/radio audio. */

    /* Move the existing tools, rather than recreating them: queue.ts binds the
       original Info/Share buttons and Like has its own inline listener. */
    function replaceFullPlayerArtMedia(media: HTMLElement): void {
      const art = $('fullPlayerArt');
      if(!art) return;
      const tools = art.querySelector('.ytm-art-overlay-tools');
      art.replaceChildren(media, ...(tools ? [tools] : []));
    }

    export function resetFullPlayerArtToImage(poster){
      const art=$('fullPlayerArt');
      if(!art) return;
      art.classList.remove('youtube-mode');
      const image = document.createElement('img');
      image.id = 'fullImg';
      image.src = poster || '';
      image.alt = '';
      image.decoding = 'async';
      replaceFullPlayerArtMedia(image);
      $('youtubeModeBadge').classList.remove('active');
    }

    function retireAuraYouTube(): void {
      const player = auraYTPlayer;
      cancelYouTubeAdvance();
      // Retire before calling the iframe: stop/destroy can emit late events.
      youtubePlayback = null;
      if(activePlaybackSource === 'youtube') activePlaybackSource = null;
      auraYTPlayer=null;
      auraYTPendingPlay=false;
      auraYTDesiredPlaying=false;
      auraYTPlayerReady=false;
      auraYTVideoId='';
      auraYTTitle='';
      auraYTPoster='';
      try{ player?.stopVideo?.(); }catch(e){}
      try{ player?.destroy?.(); }catch(e){}
    }

    export function stopAuraYouTube(){
      if(youtubePlayback || auraYTPlayer || auraYTVideoId) beginPlaybackIntent();
      retireAuraYouTube();
    }

    export async function playYouTubeInsideAura(videoId,title,poster,liked=false,autoPlay=true){
      if(!videoId){toast('YouTube video ID was missing','triangle-exclamation');return;}
      stopRadio();
      const playback: YouTubePlayback = {
        intent: beginPlaybackIntent(), videoId: String(videoId), player: null,
        ended: false, advanceTimer: null,
      };
      retireAuraYouTube();
      youtubePlayback = playback;
      activePlaybackSource = 'youtube';
      if(state.audio){ try{state.audio.pause();}catch(e){} }
      state.isPlaying=false;
      auraYTPendingPlay=false;
      auraYTDesiredPlaying=autoPlay;
      auraYTPlayerReady=false;
      auraYTVideoId=playback.videoId;
      auraYTPoster=poster||'';

      let ytArtist = 'YouTube Music';
      let ytTitle = title || 'YouTube Music';
      if (ytTitle.includes(' - ')) {
        const parts = ytTitle.split(' - ');
        ytArtist = parts[0].trim();
        ytTitle = parts.slice(1).join(' - ').trim();
      }
      auraYTTitle = ytTitle;

      let idx=state.songs.findIndex(x=>String(x.id)===`youtube-${auraYTVideoId}`);
      if(idx===-1){
        state.songs.push({id:`youtube-${auraYTVideoId}`,title:ytTitle,artist:ytArtist,img:auraYTPoster,url:'',favorite:!!liked,isLocal:false,missing:false,isYouTube:true,videoId:auraYTVideoId});
        idx=state.songs.length-1;
      }else{
        state.songs[idx].title=ytTitle;
        state.songs[idx].artist=ytArtist;
        state.songs[idx].img=auraYTPoster||state.songs[idx].img;
        state.songs[idx].isYouTube=true;
        state.songs[idx].videoId=auraYTVideoId;
      }
      state.currentIndex=idx;
      state.songs[idx].favorite = !!savedLikeMap[String(state.songs[idx].id)];
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
      addToRecent(state.songs[idx]);
      if(state.songs[idx].favorite) persistLikedHistory();

      const art=$('fullPlayerArt');
      art.classList.add('youtube-mode');
      const host = document.createElement('div');
      host.id = 'auraYTFrameHost';
      host.style.cssText = 'width:100%;height:100%;background:#000';
      replaceFullPlayerArtMedia(host);
      updatePlayState();
      prepareLyricsForNewSong(ytTitle, ytArtist, videoId);
      fetchLyricsForTrack(ytTitle, ytArtist, undefined, videoId).then(l => {
        if(isCurrentYouTube(playback)) renderLyrics(l);
      });

      try{
        // IMPORTANT: finish loading the API and create the player before the
        // user is expected to press AURA Play. This avoids the mobile race where
        // playVideo() is called before the iframe is ready and gets blocked.
        await ensureYouTubeAPI();
        if(!isCurrentYouTube(playback)) return;
        const ownsEvent = (event) => isCurrentYouTube(playback) && event.target === playback.player;
        const player=new YT.Player(host,{
          videoId:playback.videoId,
          width:'100%',height:'100%',
          playerVars:{autoplay:auraYTDesiredPlaying?1:0,playsinline:1,rel:0,controls:1,enablejsapi:1,origin:(location.protocol==='http:'||location.protocol==='https:')?location.origin:undefined},
          events:{
            onReady:(e)=>{
              if(!ownsEvent(e)) return;
              auraYTPlayerReady=true;
              auraYTPendingPlay=false;
              state.isPlaying=false;
              if(auraYTDesiredPlaying){
                try{ auraYTPendingPlay=true; playback.player.playVideo(); }catch(e){}
              }
              updatePlayState();
            },
            onStateChange:(e)=>{
              if(!ownsEvent(e) || !window.YT) return;
              if(e.data===YT.PlayerState.PLAYING){
                cancelYouTubeAdvance(playback);
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=true;
                state.isPlaying=true;
                updatePlayState();
              }else if(e.data===YT.PlayerState.PAUSED){
                cancelYouTubeAdvance(playback);
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=false;
                state.isPlaying=false;
                updatePlayState();
              }else if(e.data===YT.PlayerState.ENDED){
                if(playback.player.getPlayerState() !== YT.PlayerState.ENDED) return;
                if(playback.ended) return;
                playback.ended = true;
                if(state.repeatMode==='one'){ try{ playback.player.seekTo(0,true); playback.player.playVideo(); }catch(_){} return; }
                auraYTPendingPlay=false;
                auraYTDesiredPlaying=false;
                state.isPlaying=false;
                updatePlayState();
                if(auraSettings.autoplayNext){
                  const intent = playback.intent;
                  playback.advanceTimer = setTimeout(()=>{
                    playback.advanceTimer = null;
                    if(!isCurrentYouTube(playback) || intent !== getPlaybackIntent() || !playback.ended ||
                      !auraSettings.autoplayNext || state.repeatMode==='one') return;
                    // The retained library/playlist queue owns next-track order.
                    // A replay or seek during this small delay cancels the end.
                    try{ if(playback.player.getPlayerState() !== YT.PlayerState.ENDED) return; }catch(_){ return; }
                    void playNext();
                  },250);
                }
              }
              // BUFFERING / CUED / UNSTARTED do not change the AURA play state.
            },
            onAutoplayBlocked:(e)=>{
              if(!ownsEvent(e)) return;
              cancelYouTubeAdvance(playback);
              // Do not flip AURA into a fake playing state when the browser blocks
              // scripted playback. The user can press AURA Play again directly.
              auraYTPendingPlay=false;
              auraYTDesiredPlaying=false;
              state.isPlaying=false;
              updatePlayState();
            },
            onError:(e)=>{
              if(!ownsEvent(e)) return;
              cancelYouTubeAdvance(playback);
              auraYTPlayerReady=false;
              auraYTPendingPlay=false;
              auraYTDesiredPlaying=false;
              state.isPlaying=false;
              updatePlayState();
              toast('This YouTube video cannot be embedded. Try another song.','triangle-exclamation');
            }
          }
        });
        if(!isCurrentYouTube(playback)){ player.destroy(); return; }
        playback.player = player;
        auraYTPlayer = player;
      }catch(err){
        if(!isCurrentYouTube(playback)) return;
        console.warn('YouTube player load error:',err);
        auraYTPlayerReady=false;
        auraYTPendingPlay=false;
        auraYTDesiredPlaying=false;
        state.isPlaying=false;
        updatePlayState();
        toast('YouTube player could not load. Try again.','triangle-exclamation');
      }
    }

    export function closeYouTubePlayer(){
      const poster = auraYTPoster;
      stopAuraYouTube();
      resetFullPlayerArtToImage(poster);
      state.isPlaying=false;
      updatePlayState();
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
    let backgroundPlaybackIntent = 0;

    export function auraCaptureBackgroundState(){
      backgroundPlaybackIntent = getPlaybackIntent();
      radioWasPlayingBeforeHidden = !!(currentRadioStation && state.radioIsPlaying && !radioAudio.paused);
      audioWasPlayingBeforeHidden = !!(isAudioSourceActive() && state.isPlaying && !state.audio.paused);
    }

    export function auraResumeAfterForeground(){
      const intent = backgroundPlaybackIntent;
      if(intent === getPlaybackIntent() && radioWasPlayingBeforeHidden && currentRadioStation && radioAudio.paused){
        radioAudio.play().then(()=>{
          if(intent !== getPlaybackIntent() || !currentRadioStation) return;
          state.radioIsPlaying=true;updateRadioPlayerUI();
        }).catch(()=>{});
      }
      if(intent === getPlaybackIntent() && audioWasPlayingBeforeHidden && isAudioSourceActive() && state.audio.paused){
        requestAudioPlayback(intent);
        updatePlayState();
      }
      radioWasPlayingBeforeHidden = false;
      audioWasPlayingBeforeHidden = false;
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
      mediaSessionAction('play',()=>{
        if(currentRadioStation){ if(radioAudio.paused) toggleRadioPlay(); }
        else setMainPlaybackPlaying(true);
      });
      mediaSessionAction('pause',()=>{
        if(currentRadioStation){ if(!radioAudio.paused) toggleRadioPlay(); }
        else setMainPlaybackPlaying(false);
      });
      mediaSessionAction('previoustrack',()=>{ playPrevious(); });
      mediaSessionAction('nexttrack',()=>{ playNext(); });
    }
    setupMainMediaSession();

    export function updateMainMediaSession(){
      if(!('mediaSession' in navigator)) return;
      const s = state.songs[state.currentIndex];
      if(!s || !isAudioSourceActive()) return; // Other sources manage their own session state.
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
      const s=state.songs[i]; if(!s) return;
      // Bootstrap/metadata preparation is passive; it never claims a newer
      // playback intent or replaces an already selected YouTube source.
      if(youtubePlayback) return;
      activePlaybackSource = s.isYouTube ? null : 'audio';
      const revision = ++audioLoadRevision;
      if(s.isYouTube) state.audio.removeAttribute('src');
      else state.audio.src=s.url;
      const source = state.audio.src;
      // Resilient fallback: if edge proxy has a transient failure, seamlessly fall back to direct Hugging Face URL
      state.audio.onerror = () => {
        if (!s.hfUrl || revision !== audioLoadRevision || !isAudioSourceActive() || state.audio.src !== source) return;
        let fallback = s.hfUrl;
        try { fallback = new URL(s.hfUrl, location.href).href; } catch (_) {}
        /* src is always the resolved absolute URL; comparing it to a possibly
           relative hfUrl meant a broken file reloaded itself forever. Once the
           fallback is in place, let the failure stand. */
        if (state.audio.src === fallback) return;
        const resume = state.isPlaying;
        console.warn('[Aura Audio] Edge proxy unreachable, falling back to direct Hugging Face URL');
        state.audio.src = fallback;
        state.audio.load();
        if(resume) requestAudioPlayback();
      };
      if(!$('fullImg')) resetFullPlayerArtToImage(s.img);
      $('currentImg').src=$('fullImg').src=s.img;
      $('currentTitle').textContent=$('fullTitle').textContent=$('fullHeaderTitle').textContent=s.title;
      $('currentArtist').textContent=$('fullArtist').textContent=s.artist;
      $('fullLikeBtn').className=`like-btn ${s.favorite?'active':''}`;
      $('fullLikeBtn').setAttribute('aria-pressed', s.favorite ? 'true' : 'false');
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
      /* Lyrics used to be fetched and rendered on every play, which meant a
         handful of provider requests plus a full lyrics DOM build on the main
         thread in the same moment the audio started — very noticeable on
         phones. The lyrics panel already fetches on demand when it opens, so
         only do the eager work when it is actually on screen. */
      if(lyricsPanelOpen()){
        prepareLyricsForNewSong(s.title, s.artist, s.videoId);
        fetchLyricsForTrack(s.title, s.artist, s.duration, s.videoId).then(l => {
          if(revision === audioLoadRevision && isAudioSourceActive()) renderLyrics(l);
        });
      }
    }

    /* True while the lyrics sheet is showing the lyrics tab (not Related). */
    function lyricsPanelOpen(): boolean{
      const sheet = $('upNextSheet');
      return !!sheet && sheet.classList.contains('active') && sheet.getAttribute('data-tab') !== 'related';
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
      if(!isAudioSourceActive()) return;
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
    export function playSong(i, keepFull=false){
      const s=state.songs[i];
      if(!s) return;
      lastPlayRequestAt=Date.now();
      if(s.isYouTube && s.videoId){
        state.currentIndex=i;
        playYouTubeInsideAura(s.videoId,s.title,s.img,!!s.favorite,true);
        if(keepFull && !window.matchMedia('(min-width:900px)').matches){
          $('fullPlayerOverlay').classList.add('active');
        }
        return;
      }
      const intent = beginPlaybackIntent();
      retireAuraYouTube();
      state.auraYTQueueIndex=-1;
      resetFullPlayerArtToImage(s.img||'');
      const keepBigPlayer = window.matchMedia('(min-width:900px)').matches && $('fullPlayerOverlay').classList.contains('active');
      stopRadio();
      if(keepBigPlayer || keepFull) $('fullPlayerOverlay').classList.add('active');
      if(s.missing){ toast('This file is unavailable — please re-add it', 'triangle-exclamation'); return; }
      state.currentIndex=i; loadSong(i);
      requestAudioPlayback(intent);
      $('miniPlayer').classList.add('active');
      updatePlayState();
      /* Re-rendering the whole song list on every play froze the UI on phones.
         The list is already rebuilt when the Library tab opens, so only refresh
         it here when the user is actually looking at it. */
      if($('tabLibrary')?.classList.contains('active')) filterSongs();
      addToRecent(s);
      updateLibNowPlaying();
      if(keepFull && !window.matchMedia('(min-width:900px)').matches){
        $('fullPlayerOverlay').classList.add('active');
      }
    }

    export function updatePlayState(){
      // A pending iframe play can still be canceled with Pause. Keep the
      // transport label honest about that command without faking audio state.
      const playing = state.isPlaying || !!(youtubePlayback && isCurrentYouTube(youtubePlayback) && auraYTDesiredPlaying);
      const icon = playing ? "fa-solid fa-pause" : "fa-solid fa-play";
      $('playIcon').className = $('fullPlayIcon').className = icon;
      const label = playing ? 'Pause' : 'Play';
      $('fullPlayBtn')?.setAttribute('aria-label', label);
      $('playPauseBtn')?.setAttribute('aria-label', label);
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
    function setMainPlaybackPlaying(playing: boolean): void {
      if(currentRadioStation || roomModeActive()) return;
      const playback = youtubePlayback;
      if(playback && activePlaybackSource === 'youtube'){
        // A same-source command cancels pending work but retains this player's
        // callbacks. This also lets Pause cancel autoplay before onReady arrives.
        playback.intent = beginPlaybackIntent();
        cancelYouTubeAdvance(playback);
        auraYTDesiredPlaying=playing;
        auraYTPendingPlay=playing && auraYTPlayerReady;
        if(!auraYTPlayerReady || !playback.player){
          state.isPlaying=false;
          updatePlayState();
          return;
        }
        try{
          if(playing) playback.player.playVideo();
          else playback.player.pauseVideo();
          state.isPlaying=playing;
        }catch(e){
          auraYTDesiredPlaying=false;
          auraYTPendingPlay=false;
          state.isPlaying=false;
        }
        updatePlayState();
        return;
      }
      if(!isAudioSourceActive()){
        if(playing) playSong(state.currentIndex >= 0 ? state.currentIndex : 0);
        else beginPlaybackIntent();
        return;
      }
      const intent = beginPlaybackIntent();
      if(playing) requestAudioPlayback(intent);
      else{ state.audio.pause(); state.isPlaying=false; }
      updatePlayState();
    }

    export function togglePlay(){
      const playing = activePlaybackSource === 'youtube' ? auraYTDesiredPlaying || state.isPlaying : state.isPlaying;
      setMainPlaybackPlaying(!playing);
    }
    
    state.audio.addEventListener('loadedmetadata', ()=>{
      if(!isAudioSourceActive()) return;
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
      if(!isAudioSourceActive()) return;
      const now = performance.now();
      // Throttle to ~30fps (33ms) max to prevent UI lag on mobile
      if (now - lastTimeUpdate < 33) return;
      lastTimeUpdate = now;

      if (timeUpdateRaf) cancelAnimationFrame(timeUpdateRaf);
      timeUpdateRaf = requestAnimationFrame(() => {
        timeUpdateRaf = 0;
        if(!isAudioSourceActive()) return;
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
    state.audio.addEventListener('play',()=>{if(isAudioSourceActive() && !state.audio.paused){state.isPlaying=true;updatePlayState();updateMainMediaSession();}});
    state.audio.addEventListener('pause',()=>{if(isAudioSourceActive() && state.audio.paused){state.isPlaying=false;updatePlayState();updateMainMediaSession();}});
    /* A listening room owns what plays next, so the personal autoplay rules
       stand down while one is active — otherwise a track finishing would race
       the room and start something nobody else was expecting. */
    state.audio.addEventListener('ended',()=>{
      if(!isAudioSourceActive() || !state.audio.ended) return;
      if(state.repeatMode==='one'){state.audio.currentTime=0;requestAudioPlayback(beginPlaybackIntent());updatePlayState();return;}
      state.isPlaying=false;
      updatePlayState();
      if(auraSettings.autoplayNext) void playNext();
    });
    setInterval(()=>{
      if(!youtubePlayback || !isCurrentYouTube(youtubePlayback) || !auraYTPlayerReady || document.hidden) return;
      try{
        const d=auraYTPlayer.getDuration()||0, c=auraYTPlayer.getCurrentTime()||0;
        if(d){ if(!fullSeekDragging) $('fullSeekSlider').value=(c/d)*100; $('fullCurrentTime').textContent=fmt(c); $('fullDurationTime').textContent=fmt(d); }
        // updateLyricsProgress handled by lyrics sync loop
      }catch(e){}
    },1000); // Reduced from 500ms to 1000ms for mobile performance
    $('fullSeekSlider').oninput=()=>{
      const pct=Number($('fullSeekSlider').value)||0;
      if(youtubePlayback && isCurrentYouTube(youtubePlayback)){
        try{
          if(!auraYTPlayerReady) return;
          const d=auraYTPlayer.getDuration();
          if(isFinite(d) && d>0){
            const t=(pct/100)*d;
            if(seekActivePlayback(t)){
              $('fullCurrentTime').textContent=fmt(t);
              updateLyricsProgress(t);
            }
          }
        }catch(e){} return;
      }
      if(isAudioSourceActive() && state.audio.duration && isFinite(state.audio.duration) && state.audio.duration > 0){
        const targetTime = (pct/100)*state.audio.duration;
        if(seekActivePlayback(targetTime)){
          $('fullCurrentTime').textContent=fmt(targetTime);
          updateLyricsProgress(targetTime);
        }
      }
    };

    /* Tap the big artwork to play/pause — same handler as the play button so
       both stay in sync and share the grow/shrink pulse. Swipes and drags are
       ignored (only a short, still pointer press counts as a tap). */
    const artTap = $('fullPlayerArt');
    let artTapDownX = 0, artTapDownY = 0, artTapDownT = 0;
    let artTapPointer: number | null = null;
    artTap.addEventListener('pointerdown', e => {
      artTapPointer = null;
      if(e.button !== 0 || e.isPrimary === false || (e.target as HTMLElement).closest('button, a, input')) return;
      artTapPointer = e.pointerId;
      artTapDownX = e.clientX; artTapDownY = e.clientY; artTapDownT = Date.now();
    });
    artTap.addEventListener('pointermove', e => {
      if(e.pointerId === artTapPointer && (Math.abs(e.clientX - artTapDownX) > 12 || Math.abs(e.clientY - artTapDownY) > 12)) artTapPointer = null;
    });
    artTap.addEventListener('pointerup', e => {
      const tracked = e.pointerId === artTapPointer;
      artTapPointer = null;
      if((e.target as HTMLElement).closest('button, a, input')) return;
      if(!tracked) return;
      if(Math.abs(e.clientX - artTapDownX) > 12 || Math.abs(e.clientY - artTapDownY) > 12) return;
      if(Date.now() - artTapDownT > 600) return;
      togglePlay();
    });
    artTap.addEventListener('pointercancel', () => { artTapPointer = null; });
    window.addEventListener('pointerup', () => { artTapPointer = null; });
    window.addEventListener('pointercancel', () => { artTapPointer = null; });


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
      if(currentRadioStation || roomModeActive()) return null;
      if (auraYTVideoId) {
        const song = state.songs[state.currentIndex];
        let ytArtist = song?.videoId === auraYTVideoId ? song.artist || 'YouTube Music' : 'YouTube Music';
        let ytTitle = auraYTTitle;
        if (auraYTTitle.includes(' - ')) {
          const parts = auraYTTitle.split(' - ');
          ytArtist = parts[0].trim();
          ytTitle = parts.slice(1).join(' - ').trim();
        }
        return { title: ytTitle, artist: ytArtist, videoId: auraYTVideoId };
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

    export function switchRightPanelTab(tab: 'lyrics' | 'related') {
      const sheet = $('upNextSheet');
      if (sheet) sheet.setAttribute('data-tab', tab);

      const lBtn = $('ytmTabLyricsBtn');
      const rBtn = $('ytmTabRelatedBtn');
      const lPan = $('ytmLyricsPanel');
      const rPan = $('ytmRelatedPanel');

      const fullLyricsBtn = $('playerTabLyricsBtn');
      const fullRelatedBtn = $('playerTabRelatedBtn');
      fullLyricsBtn?.classList.toggle('active', tab === 'lyrics');
      fullRelatedBtn?.classList.toggle('active', tab === 'related');

      lBtn?.classList.toggle('active', tab === 'lyrics');
      rBtn?.classList.toggle('active', tab === 'related');

      if (lPan) lPan.style.setProperty('display', tab === 'lyrics' ? 'flex' : 'none', 'important');
      if (rPan) rPan.style.setProperty('display', tab === 'related' ? 'flex' : 'none', 'important');

      if (tab === 'lyrics') {
        const cur = getCurrentActiveTrack();
        if (cur) {
          const key = getTrackKey(cur.title, cur.artist);
          const playback = youtubePlayback;
          const revision = audioLoadRevision;
          prepareLyricsForNewSong(cur.title, cur.artist, cur.videoId);
          if (!lyricsCache.has(key)) {
            fetchLyricsForTrack(cur.title, cur.artist, cur.duration, cur.videoId).then(l => {
              if(playback ? isCurrentYouTube(playback) : revision === audioLoadRevision && isAudioSourceActive()) renderLyrics(l);
            });
          }
        }
        setTimeout(() => {
          (window as any).centerActiveLyricLine?.(undefined, false);
        }, 50);
      } else if (tab === 'related') {
        renderRelated();
      }
    }

    export function openPlayerSheet(tab: 'lyrics' | 'related' = 'lyrics') {
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
            <div class="ytm-rel-section-title">You might also like</div>
            <div class="ytm-rel-grid">
              ${youMightLike.map(s => {
                const originalIdx = state.songs.findIndex(x => x.id === s.id);
                return `
                  <div class="ytm-rel-card" onclick="playSong(${originalIdx >= 0 ? originalIdx : 0})" role="button" tabindex="0">
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

      // Section 2: About the artist spotlight card
      html += `
        <div class="ytm-rel-section">
          <div class="ytm-rel-section-title">About the artist</div>
          <div class="ytm-rel-artist-card">
            <div class="ytm-rel-artist-header">
              <div class="ytm-rel-artist-avatar">
                <i class="fa-solid fa-user-astronaut"></i>
              </div>
              <div>
                <div class="ytm-rel-artist-name">${escapeHtml(currentSong.artist || 'Artist')}</div>
                <div class="ytm-rel-artist-desc">Featured on AURA Music</div>
              </div>
            </div>
            <div class="ytm-rel-artist-tags">
              <span class="ytm-rel-tag"><i class="fa-solid fa-compact-disc"></i> Studio Track</span>
              <span class="ytm-rel-tag"><i class="fa-solid fa-wand-magic-sparkles"></i> High Fidelity</span>
              <span class="ytm-rel-tag"><i class="fa-solid fa-headphones"></i> Immersive</span>
            </div>
          </div>
        </div>
      `;

      // Section 3: More from this artist
      if (sameArtistSongs.length > 0) {
        html += `
          <div class="ytm-rel-section">
            <div class="ytm-rel-section-title">More by ${escapeHtml(currentSong.artist || '')}</div>
            <div class="ytm-rel-list">
              ${sameArtistSongs.map(s => {
                const originalIdx = state.songs.findIndex(x => x.id === s.id);
                const unavailable = originalIdx < 0 || s.missing || (s.isLocal && !s.url);
                return `
                  <button type="button" class="ytm-rel-row" data-related-id="${escapeHtml(s.id)}" aria-label="${escapeHtml(`Play ${s.title || 'Untitled'} by ${s.artist || 'Unknown Artist'}`)}" ${unavailable ? 'disabled' : ''}>
                    <img class="ytm-rel-row-img" src="${escapeHtml(s.img || '')}" alt="" loading="lazy">
                    <span class="ytm-rel-row-meta">
                      <span class="ytm-rel-row-title">${escapeHtml(s.title || '')}</span>
                      <span class="ytm-rel-row-sub">${escapeHtml(s.artist || '')}</span>
                    </span>
                    <span class="ytm-rel-row-play" aria-hidden="true"><i class="fa-solid fa-play"></i></span>
                  </button>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
      container.querySelectorAll<HTMLButtonElement>('.ytm-rel-row').forEach(button => {
        button.addEventListener('click', () => {
          const index = state.songs.findIndex(song => String(song.id) === button.dataset.relatedId);
          const song = state.songs[index];
          if(!song || song.missing || (song.isLocal && !song.url)){
            button.disabled = true;
            return;
          }
          playSong(index);
        });
      });
    }

    if (typeof window !== 'undefined') {
      (window as any).switchRightPanelTab = switchRightPanelTab;
      (window as any).openPlayerSheet = openPlayerSheet;
      (window as any).closePlayerSheet = closePlayerSheet;
    }
