import { toast } from '../core/dom';
import { toggleFavorite } from '../features/library';
import { auraYTPlayer, auraYTPlayerReady } from '../features/player';
import { playPrevious, renderUpNext } from '../features/queue';
import { auraSettings } from '../features/settings';
import { state } from '../core/state';
(function(){
  const $ = id => document.getElementById(id);
  const mq = window.matchMedia('(min-width:900px)');
  const overlay = $('fullPlayerOverlay'), radioOverlay = $('radioFullPlayerOverlay');
  const mini = $('miniPlayer'), radioMini = $('radioMiniPlayer');
  const isOn = el => el && el.classList.contains('active');

  /* ---- body state classes (drive the CSS) ---- */
  function syncBody(){
    document.body.classList.toggle('np-track-open', isOn(overlay));
    document.body.classList.toggle('np-open', isOn(overlay) || isOn(radioOverlay));
    document.body.classList.toggle('has-mini', isOn(mini) || isOn(radioMini));
    const ex = $('miniExpandBtn'); if(ex) ex.classList.toggle('open', isOn(overlay));
    if(isOn(overlay) && mq.matches){ try{ renderUpNext(); }catch(e){} }
  }
  const mo = new MutationObserver(syncBody);
  [overlay, radioOverlay, mini, radioMini].forEach(el => el && mo.observe(el, {attributes:true, attributeFilter:['class']}));
  syncBody();

  /* keep the docked queue fresh when the track changes */
  let qRaf = 0;
  new MutationObserver(()=>{
    if(!isOn(overlay) || !mq.matches) return;
    cancelAnimationFrame(qRaf); qRaf = requestAnimationFrame(()=>{ try{ renderUpNext(); }catch(e){} });
  }).observe($('fullTitle'), {childList:true, characterData:true, subtree:true});

  /* ---- big-player buttons that had no handler at all ---- */
  function syncModes(){
    const rep = state.repeatMode === 'one';
    [['shuffleBtn','mode-active',state.isShuffle],['repeatBtn','mode-active',rep],['repeatBtn','repeat-one',rep]].forEach(([id,cls,on])=>{
      const el=$(id as string); if(el) el.classList.toggle(cls as string, !!on);
    });
    $('miniShuffleBtn').classList.toggle('active', state.isShuffle);
    $('miniRepeatBtn').classList.toggle('active', rep);
    $('miniRepeatBtn').classList.toggle('repeat-one', rep);
  }
  function toggleShuffle(e){
    if(e) e.stopPropagation();
    state.isShuffle = !state.isShuffle; syncModes();
    toast(state.isShuffle ? 'Shuffle on' : 'Shuffle off', 'shuffle');
  }
  function toggleRepeat(e){
    if(e) e.stopPropagation();
    state.repeatMode = state.repeatMode === 'one' ? 'all' : 'one'; syncModes();
    toast(state.repeatMode === 'one' ? 'Repeating this song' : 'Repeat off', 'repeat');
  }
  function likeCurrent(e){
    if(e) e.stopPropagation();
    const s = state.songs[state.currentIndex];
    if(!s){ toast('Nothing playing right now', 'circle-info'); return; }
    toggleFavorite(null, s.id);
    syncLike(true);
  }
  $('shuffleBtn').onclick = toggleShuffle;
  $('repeatBtn').onclick = toggleRepeat;
  $('fullLikeBtn').onclick = likeCurrent;

  /* ---- bar buttons ---- */
  $('miniShuffleBtn').onclick = toggleShuffle;
  $('miniRepeatBtn').onclick = toggleRepeat;
  $('miniLikeBtn').onclick = likeCurrent;
  $('miniPrevBtn').onclick = e => { e.stopPropagation(); playPrevious(); };
  $('miniExpandBtn').onclick = e => {
    e.stopPropagation();
    if(isOn(overlay)) $('closeFullPlayerBtn').click();
    else { overlay.classList.add('active'); try{ renderUpNext(); }catch(_){} }
  };

  /* ---- seek line ---- */
  const seek = $('miniSeek'), fullSeek = $('fullSeekSlider');
  const miniProgressFill = $('progressFill'), miniProgressTrack = $('miniProgressTrack');
  const miniProgressDash = $('miniProgressTap');
  const edgeHost = $('miniEdgeProgress');
  const edgeFill = $('miniEdgeFill');
  let edgeDragActive = false;
  let miniProgressPct = 0;
  function applyMiniProgress(pct, animate=true){
    miniProgressPct = pct;
    if(miniProgressFill && miniProgressTrack){
      miniProgressFill.style.transition = animate ? 'transform .1s linear' : 'none';
      miniProgressFill.style.transform = `scaleX(${pct / 100})`;
      miniProgressTrack.style.transform = `scaleX(${pct / 100})`;
    }
    if(miniProgressDash){
        miniProgressDash.style.transform = `scaleX(${pct / 100})`;
    }
    if(edgeFill){
      edgeFill.style.transition = animate ? 'transform .1s linear' : 'none';
      edgeFill.style.transform = `scaleX(${pct / 100})`;
    }
  }
  function resetMiniProgress(animate=false){
    applyMiniProgress(0, animate);
  }
  /* Exposed for player.ts: loadSong() resets the line on song change and the
     state.audio 'timeupdate' listener keeps it in sync with the full player. */
  (window as any).__auraMiniProgress = { apply: applyMiniProgress, reset: resetMiniProgress };
  seek.addEventListener('input', () => {
    seek.style.setProperty('--seek-pct', seek.value + '%');
    fullSeek.value = seek.value;
    fullSeek.dispatchEvent(new Event('input'));   // reuses the existing seek logic (state.audio + YouTube)
  });
  if(miniProgressDash){
    miniProgressDash.addEventListener('pointerdown', e => {
      e.stopPropagation();
      e.preventDefault();
      miniProgressDash.setPointerCapture?(miniProgressDash.setPointerCapture(e.pointerId)):(miniProgressDash.addEventListener('pointermove', onMiniProgressDrag));
      updateMiniProgressFromPointer(e);
    });
    miniProgressDash.addEventListener('pointermove', onMiniProgressDrag);
    miniProgressDash.addEventListener('pointerup', e => {
      e.stopPropagation();
      e.preventDefault();
      miniProgressDash.releasePointerCapture?.(e.pointerId);
    });
    miniProgressDash.addEventListener('pointercancel', e => {
      e.stopPropagation();
      miniProgressDash.removeEventListener('pointermove', onMiniProgressDrag);
    });
  }
  function onMiniProgressDrag(e){
    if(!miniProgressDash) return;
    updateMiniProgressFromPointer(e);
  }
  function updateMiniProgressFromPointer(e){
    if(!miniProgressDash || !state.audio || !isFinite(state.audio.duration) || state.audio.duration <= 0) return;
    const rect = miniProgressDash.getBoundingClientRect();
    if(rect.width <= 0) return;
    const x = Math.max(0, Math.min(rect.width, (e.clientX || 0) - rect.left));
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    if(state.audio.duration){
      state.audio.currentTime = (pct / 100) * state.audio.duration;
    }
  }
  /* Optional: tap/drag the bottom-edge progress line to seek. stopPropagation
     on every event keeps the taps from opening the full player or touching the
     pause/next buttons above the line. */
  if(edgeHost){
    const edgeSeek = e => {
      if(!state.audio || !isFinite(state.audio.duration) || state.audio.duration <= 0) return;
      const rect = edgeHost.getBoundingClientRect();
      if(rect.width <= 0) return;
      const x = Math.max(0, Math.min(rect.width, (e.clientX || 0) - rect.left));
      const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
      if(edgeFill){
        edgeFill.style.transition = 'none';
        edgeFill.style.transform = `scaleX(${pct / 100})`;
      }
      state.audio.currentTime = (pct / 100) * state.audio.duration;
    };
    edgeHost.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      edgeDragActive = true;
      edgeHost.setPointerCapture?.(e.pointerId);
      edgeSeek(e);
    });
    edgeHost.addEventListener('pointermove', e => { if(edgeDragActive){ e.preventDefault(); edgeSeek(e); } });
    edgeHost.addEventListener('pointerup', e => {
      e.stopPropagation();
      edgeDragActive = false;
      edgeHost.releasePointerCapture?.(e.pointerId);
    });
    edgeHost.addEventListener('pointercancel', () => { edgeDragActive = false; });
    edgeHost.addEventListener('click', e => e.stopPropagation());
  }

  /* ---- volume (also finally makes the "Remember volume" setting meaningful) ---- */
  const vol = $('miniVolume'), volIcon = $('miniVolIcon');
  let volume = 0.8, lastNonZero = 0.8, ytSeen = null;
  try{
    const saved = parseFloat(localStorage.getItem('auraVolume'));
    const remember = (typeof auraSettings === 'undefined') || auraSettings.rememberVolume;
    if(remember && isFinite(saved) && saved >= 0 && saved <= 1) volume = saved;
  }catch(e){}
  if(volume > 0) lastNonZero = volume;
  function applyVolume(persist){
    state.audio.volume = volume;
    try{ if(auraYTPlayer && auraYTPlayerReady){ auraYTPlayer.setVolume(Math.round(volume*100)); ytSeen = auraYTPlayer; } }catch(e){}
    vol.value = Math.round(volume*100);
    vol.style.setProperty('--vol-pct', vol.value + '%');
    volIcon.className = 'fa-solid ' + (volume === 0 ? 'fa-volume-xmark' : volume < .5 ? 'fa-volume-low' : 'fa-volume-high');
    if(persist){ try{ if(typeof auraSettings === 'undefined' || auraSettings.rememberVolume) localStorage.setItem('auraVolume', String(volume)); }catch(e){} }
  }
  vol.addEventListener('input', () => { volume = vol.value/100; if(volume > 0) lastNonZero = volume; applyVolume(true); });
  $('miniVolBtn').onclick = e => { e.stopPropagation(); volume = volume === 0 ? (lastNonZero || .8) : 0; applyVolume(true); };
  applyVolume(false);

  /* ---- mirror state into the bar (works for library state.audio and the YouTube player alike) ---- */
  function syncLike(force){
    const liked = $('fullLikeBtn').classList.contains('active');
    const ml = $('miniLikeBtn');
    if(force || ml.classList.contains('active') !== liked){
      ml.classList.toggle('active', liked);
      ml.innerHTML = '<i class="fa-' + (liked ? 'solid' : 'regular') + ' fa-heart"></i>';
      if(liked){ ml.classList.remove('mini-heart-pop'); void ml.offsetWidth; ml.classList.add('mini-heart-pop'); }
    }
  }
  let lastMiniPct = -1;
  setInterval(() => {
    if(!mq.matches) return;
    if(document.activeElement !== seek){ seek.value = fullSeek.value; seek.style.setProperty('--seek-pct', (parseFloat(fullSeek.value)||0) + '%'); }
    $('miniTime').textContent = $('fullCurrentTime').textContent + ' / ' + $('fullDurationTime').textContent;
    syncLike(false); syncModes();
    try{ if(auraYTPlayer && auraYTPlayerReady && auraYTPlayer !== ytSeen) applyVolume(false); }catch(e){}
    const pct = Number(fullSeek.value)||0;
    if(pct !== lastMiniPct){
      lastMiniPct = pct;
      if(edgeFill && !edgeDragActive){
        edgeFill.style.transition = 'transform .1s linear';
        edgeFill.style.transform = `scaleX(${pct / 100})`;
      }
    }
  }, 250);


  /* ---- keyboard: Esc closes the big player ---- */
  document.addEventListener('keydown', e => {
    if(e.key !== 'Escape' || !mq.matches) return;
    const t = e.target && e.target.tagName;
    if(t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    if(document.querySelector('.modal-overlay.active, .track-sheet-overlay.active, .beeboo-chat-overlay.active')) return;
    if(isOn(overlay)) $('closeFullPlayerBtn').click();
    else if(isOn(radioOverlay)) $('closeRadioFullPlayerBtn').click();
  });
})();
