import { auraMasterCtx, effectCtx } from './ambience';
import { fmt, toast } from '../core/dom';
import { addToRecent, renderSongs, updateLibCount, updateLibNowPlaying } from './library';
import { clearArtistPlayback, closeUpNext, playNext, playPrevious, renderUpNext, retainPlaybackInterruptions } from './queue';
import { currentRadioStation, escapeHtml, radioAudio, resumeRadioAfterForeground, setupRadioMediaSession, stopRadio } from './radio';
import { auraYTQueue, extractYouTubeId } from './search';
import { auraSettings } from './settings';
import { roomModeActive } from '../rooms/roomFlag';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
import { beginPlaybackIntent, getPlaybackIntent } from '../core/playbackIntent';
import { createPlaybackContext } from '../core/playback-context';
import { stableTrackRef, trackAvailable } from '../core/track-identity';
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
    let playRequestSequence = 0;
    let playbackIntent = false;
    export function currentPlaybackTime(): number {
      return getActivePlaybackTime();
    }
    export function pausePlayback(): void {
      setMainPlaybackPlaying(false);
    }
    export function stopPersonalPlaybackForRadio(): void {
      pausePlayback();
      beginPlaybackIntent();
      retainPlaybackInterruptions();
      clearArtistPlayback();
      retireAuraYouTube();
      resetFullPlayerArtToImage(state.activeTrack?.img || '');
    }
    export function cancelRadioForegroundResume(): void { radioWasPlayingBeforeHidden = false; }

    export function resumePlayback(): void {
      setMainPlaybackPlaying(true);
    }
    export function restartCurrentTrack(): void {
      if (seekActivePlayback(0)) resumePlayback();
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
      playbackIntent = true;
      state.audio.play().catch(err => {
        if(intent !== getPlaybackIntent() || revision !== audioLoadRevision || !isAudioSourceActive()) return;
        if(err?.name === 'AbortError') return;
        playbackIntent = false;
        state.isPlaying = false;
        updatePlayState();
        updateMainMediaSession();
        if(err?.name === 'NotAllowedError') toast('Press Play to allow audio in this browser.', 'circle-info');
      });
    }

    export function ensureYouTubeAPI(): Promise<void> {
      if (window.YT?.Player) return Promise.resolve();
      if (auraYTReadyPromise) return auraYTReadyPromise;
      auraYTReadyPromise = new Promise<void>((resolve, reject) => {
        const previous = window.onYouTubeIframeAPIReady;
        const script = document.createElement('script');
        const timeout = setTimeout(() => fail(), 15000);
        const cleanup = () => clearTimeout(timeout);
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
      clearArtistPlayback();
      if(youtubePlayback || auraYTPlayer || auraYTVideoId) beginPlaybackIntent();
      retireAuraYouTube();
    }

    export async function playYouTubeInsideAura(videoId,title,poster,liked=false,autoPlay=true, options: { catalogSong?: any; preserveArtist?: boolean; preserveContext?: boolean } = {}){
      if(!/^[A-Za-z0-9_-]{11}$/.test(String(videoId))){toast('The YouTube video ID is invalid.','triangle-exclamation');return;}
      if(!options.preserveArtist && !options.preserveContext) { retainPlaybackInterruptions(); clearArtistPlayback(); }
      lastPlayRequestAt = Date.now();
      if(!options.catalogSong) playRequestSequence += 1;
      stopRadio();
      const playback: YouTubePlayback = {
        intent: beginPlaybackIntent(), videoId: String(videoId), player: null,
        ended: false, advanceTimer: null,
      };
      retireAuraYouTube();
      youtubePlayback = playback;
      activePlaybackSource = 'youtube';
      if(state.audio){ try{state.audio.pause();}catch(e){} }
      playbackIntent = autoPlay;
      audioLoadRevision += 1;
      state.isPlaying=false;
      auraYTPendingPlay=false;
      auraYTDesiredPlaying=autoPlay;
      auraYTPlayerReady=false;
      auraYTVideoId=playback.videoId;
      auraYTPoster=poster||'';

      let ytArtist = 'YouTube Music';
      let ytTitle = title || 'YouTube Music';
      const catalogSong = options.catalogSong && state.songs.includes(options.catalogSong) && String(options.catalogSong.videoId) === String(videoId)
        ? options.catalogSong : null;
      if(catalogSong) {
        ytArtist = catalogSong.artist || 'YouTube Music';
        ytTitle = catalogSong.title || ytTitle;
      } else if (ytTitle.includes(' - ')) {
        const parts = ytTitle.split(' - ');
        ytArtist = parts[0].trim();
        ytTitle = parts.slice(1).join(' - ').trim();
      }
      auraYTTitle = ytTitle;

      let idx=catalogSong ? state.songs.indexOf(catalogSong) : state.songs.findIndex(x=>x.isYouTube && String(x.videoId)===auraYTVideoId);
      if(idx===-1){
        state.songs.push({id:`youtube-${auraYTVideoId}`,title:ytTitle,artist:ytArtist,img:auraYTPoster,url:'',favorite:!!liked,isLocal:false,missing:false,isYouTube:true,videoId:auraYTVideoId});
        idx=state.songs.length-1;
      }
      // Direct retained-video selection uses ordinary library/search transport.
      // Scoped playlist/artist selection keeps its source and current identity.
      if (!options.preserveContext && !options.preserveArtist) state.playbackContext = createPlaybackContext(state.songs.filter(trackAvailable).map(stableTrackRef), {
        source:'library',label:'Library',startId:stableTrackRef(state.songs[idx]),shuffle:state.isShuffle,
      });
      state.currentIndex=idx;
      if(!catalogSong) state.songs[idx].favorite = !!state.songs[idx].favorite || !!liked || !!savedLikeMap[String(state.songs[idx].id)];
      ytTitle = state.songs[idx].title; ytArtist = state.songs[idx].artist;
      auraYTTitle = ytTitle; auraYTPoster = state.songs[idx].img || auraYTPoster;
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
      const host = document.createElement('div');
      host.id = 'auraYTFrameHost';
      host.style.cssText = 'width:100%;height:100%;background:#000';
      replaceFullPlayerArtMedia(host);
      refreshTrackMetadata(state.songs[idx]);
      updatePlayState();
      setupMainMediaSession();
      updateMainMediaSession();
      if (lyricsPanelOpen()) {
        prepareLyricsForNewSong(ytTitle, ytArtist, videoId);
        void fetchLyricsForTrack(ytTitle, ytArtist, state.songs[idx].duration, videoId).then((lyrics) => {
          if (isCurrentYouTube(playback) && lyricsPanelOpen()) renderLyrics(lyrics);
        });
      }

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
                recordPlaybackStart();
                updatePlayState();
                updateMainMediaSession();
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
                    void playNext(false, 'ended');
                  },250);
                }
              }
              // BUFFERING / CUED / UNSTARTED do not change the AURA play state.
            },
            onAutoplayBlocked:(e)=>{
              if(!ownsEvent(e)) return;
              cancelYouTubeAdvance(playback);
              playbackIntent = false;
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
              playbackIntent = false;
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

    export async function playYouTubeProResult(meta: any): Promise<void> {
      const videoId = extractYouTubeId(meta);
      if (!videoId) { toast('This result has no playable YouTube ID', 'triangle-exclamation'); return; }
      const index = auraYTQueue.findIndex(item => String(item?.id) === String(meta?.id));
      if (index >= 0) state.auraYTQueueIndex = index;
      await playYouTubeInsideAura(videoId, meta?.title || meta?.name || 'YouTube Music', meta?.img || meta?.poster || '', !!meta?.favorite);
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
      const resumeRadio = radioWasPlayingBeforeHidden, resumeAudio = audioWasPlayingBeforeHidden;
      radioWasPlayingBeforeHidden = audioWasPlayingBeforeHidden = false;
      if(intent === getPlaybackIntent() && resumeRadio && currentRadioStation && radioAudio.paused) resumeRadioAfterForeground();
      if(intent === getPlaybackIntent() && resumeAudio && playbackIntent && isAudioSourceActive() && state.audio.paused){
        requestAudioPlayback(intent);
        updatePlayState();
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
      if(roomModeActive()) return;
      if(currentRadioStation) { setupRadioMediaSession(); return; }
      mediaSessionAction('play',resumePlayback);
      mediaSessionAction('pause',pausePlayback);
      mediaSessionAction('stop',pausePlayback);
      mediaSessionAction('previoustrack',()=>{ playPrevious(); });
      mediaSessionAction('nexttrack',()=>{ playNext(); });
      mediaSessionAction('seekto',(event)=>{
        if (!Number.isFinite(event.seekTime)) return;
        seekActivePlayback(event.seekTime);
      });
    }
    // Authenticated app.ready performs the first setup after feature imports
    // and local hydration. Eager setup enters the cyclic radio binding too soon.

    export function updateMainMediaSession(){
      if(!('mediaSession' in navigator)) return;
      const s = state.songs[state.currentIndex];
      if(!s || currentRadioStation || roomModeActive()) return;
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
      updateMainMediaSession();
    }

    export function loadSong(i){
      const song=state.songs[i]; if(!song) return;
      // Bootstrap/metadata preparation is passive; it never claims a newer
      // playback intent or replaces an already selected YouTube source.
      if(youtubePlayback) return;
      activePlaybackSource = song.isYouTube ? null : 'audio';
      const revision = ++audioLoadRevision;
      if(song.isYouTube || !song.url || song.missing) state.audio.removeAttribute('src');
      else state.audio.src=song.url;
      const source = state.audio.src;
      // Resilient fallback: if edge proxy has a transient failure, seamlessly fall back to direct Hugging Face URL
      state.audio.onerror = () => {
        if (revision !== audioLoadRevision || !isAudioSourceActive()) return;
        let fallback = '';
        try { if(song.hfUrl) fallback = new URL(song.hfUrl, location.href).href; } catch (_) {}
        /* src is always the resolved absolute URL; comparing it to a possibly
           relative hfUrl meant a broken file reloaded itself forever. Once the
           fallback is in place, let the failure stand. */
        if (fallback && state.audio.src === source && state.audio.src !== fallback) {
          const position = currentPlaybackTime();
          const shouldResume = playbackIntent;
          const intent = getPlaybackIntent();
          state.audio.src = fallback;
          state.audio.addEventListener('loadedmetadata', () => {
            if (revision !== audioLoadRevision || !isAudioSourceActive() || state.audio.src !== fallback) return;
            try { state.audio.currentTime = Math.min(position, Number.isFinite(state.audio.duration) ? state.audio.duration : position); } catch { /* non-seekable source */ }
            if (shouldResume && playbackIntent && intent === getPlaybackIntent()) requestAudioPlayback(intent);
          }, {once:true});
          state.audio.load();
          return;
        }
        playbackIntent = false;
        state.isPlaying = false;
        updatePlayState();
        if (lastPlayRequestAt) toast('This audio source could not be played. Try another track or check your connection.', 'triangle-exclamation');
      };
      if(!$('fullImg')) resetFullPlayerArtToImage(song.img);
      refreshTrackMetadata(song);
      $('progressFill').style.width = '0%';
      $('fullSeekSlider').value = 0;
      $('fullCurrentTime').textContent = '0:00';
      $('fullDurationTime').textContent = '0:00';
      const resetApi = (window as any).__auraMiniProgress;
      resetApi?.reset?.(false);
      applyDynamicPlayerColor(song.img);
      setupMainMediaSession();
      state.audio.load();
      /* Lyrics used to be fetched and rendered on every play, which meant a
         handful of provider requests plus a full lyrics DOM build on the main
         thread in the same moment the audio started — very noticeable on
         phones. The lyrics panel already fetches on demand when it opens, so
         only do the eager work when it is actually on screen. */
      if(lyricsPanelOpen()){
          prepareLyricsForNewSong(song.title,song.artist,song.videoId);
          void fetchLyricsForTrack(song.title,song.artist,song.duration,song.videoId).then((lyrics) => {
          if (revision === audioLoadRevision && isAudioSourceActive() && lyricsPanelOpen()) renderLyrics(lyrics);
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
      if (!preserveContext) {
        retainPlaybackInterruptions();
        clearArtistPlayback();
        state.playbackContext = createPlaybackContext(state.songs.filter(trackAvailable).map(stableTrackRef), {
          source: 'library', label: 'Library', startId: stableTrackRef(song), shuffle: state.isShuffle,
        });
      }
      state.currentIndex = i;
      if (song.isYouTube) {
        void playYouTubeInsideAura(song.videoId,song.title,song.img,!!song.favorite,true,{catalogSong:song,preserveContext:true});
        return true;
      }
      stopRadio();
      const intent = beginPlaybackIntent();
      retireAuraYouTube();
      state.auraYTQueueIndex = -1;
      state.audio.pause();
      state.isPlaying = false;
      resetFullPlayerArtToImage(song.img || '');
      loadSong(i);
      $('miniPlayer').classList.add('active');
      if (keepFull) $('fullPlayerOverlay').classList.add('active');
      updatePlayState();
      requestAudioPlayback(intent);
      if ($('tabLibrary')?.classList.contains('active')) filterSongs();
      updateLibNowPlaying();
      renderUpNext();
      return true;
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
      window.dispatchEvent?.(new Event('aura:playback-changed'));
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
      playbackIntent = playing;
      audioWasPlayingBeforeHidden = false;
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
        if(playing) {
          const song = state.songs[state.currentIndex];
          playSong(state.currentIndex >= 0 ? state.currentIndex : 0, false, !!song && state.playbackContext?.currentId === stableTrackRef(song));
        }
        else beginPlaybackIntent();
        return;
      }
      const intent = beginPlaybackIntent();
      if(playing) requestAudioPlayback(intent);
      else{ state.audio.pause(); state.isPlaying=false; }
      updatePlayState();
      updateMainMediaSession();
    }

    export function togglePlay(){
      const playing = activePlaybackSource === 'youtube' ? auraYTDesiredPlaying || state.isPlaying : state.isPlaying;
      setMainPlaybackPlaying(!playing);
    }

    export function pauseMainPlayback(){ setMainPlaybackPlaying(false); }
    export function isMainPlaybackPlaying(): boolean {
      if(currentRadioStation || roomModeActive()) return false;
      return activePlaybackSource === 'youtube' ? auraYTDesiredPlaying || state.isPlaying : state.isPlaying;
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
    state.audio.addEventListener('playing',()=>{
      if (!isAudioSourceActive()) return;
      state.isPlaying=true;
      recordPlaybackStart();
      updatePlayState();
      updateMainMediaSession();
    });
    state.audio.addEventListener('pause',()=>{
      if (!isAudioSourceActive() || !state.audio.paused) return;
      state.isPlaying=false;
      updatePlayState();
      updateMainMediaSession();
    });
    /* A listening room owns what plays next, so the personal autoplay rules
       stand down while one is active — otherwise a track finishing would race
       the room and start something nobody else was expecting. */
    state.audio.addEventListener('ended',()=>{
      if(!isAudioSourceActive() || !state.audio.ended) return;
      if(state.repeatMode==='one'){state.audio.currentTime=0;requestAudioPlayback(beginPlaybackIntent());updatePlayState();return;}
      state.isPlaying=false;
      updatePlayState();
      if(auraSettings.autoplayNext) void playNext(false, 'ended');
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
        return { title: song?.title || auraYTTitle, artist: song?.artist || 'YouTube Music', videoId: auraYTVideoId, duration: song?.duration };
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
      if (sheet) sheet.setAttribute('data-tab', tab);
      for (const name of ['lyrics','related','queue'] as const) {
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
        const panel = $(`ytm${capitalized}Panel`);
        if (panel) { panel.hidden = name !== tab; panel.style.setProperty('display', name === tab ? 'flex' : 'none', 'important'); }
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
      const playback = youtubePlayback, revision = audioLoadRevision;
      const key = getTrackKey(cur.title,cur.artist);
      if (lyricsCache.has(key)) renderLyrics(lyricsCache.get(key) || null);
      else {
        prepareLyricsForNewSong(cur.title,cur.artist,cur.videoId);
        void fetchLyricsForTrack(cur.title,cur.artist,cur.duration,cur.videoId).then((lyrics) => {
          if (request === playRequestSequence && lyricsPanelOpen() &&
            (playback ? isCurrentYouTube(playback) : revision === audioLoadRevision && isAudioSourceActive())) renderLyrics(lyrics);
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
