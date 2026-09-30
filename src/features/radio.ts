import { copyToClipboard, showTrackSheet, stateHTML, toast } from '../core/dom';
import { mediaSessionAction, updatePlayState } from './player';
import { closeTrackMenu } from './queue';
import { $, state } from '../core/state';
/* ===== 5623-5819 ===== */
    /* Live Radio */
    export const radioAudio = new Audio();
    radioAudio.preload = 'none';
    radioAudio.autoplay = false;
    radioAudio.setAttribute('playsinline','');
    // Radio playback is independent of the visible tab. We never pause it just because
    // the user leaves Home or the page becomes hidden. Android/browser policies still apply.
    export const RADIO_STATE_KEY = 'auraRadioPlaybackState_v1';
    export let currentRadioStation = null;
    export let radioSearchToken = 0;
    export let currentRadioQuery = 'top';

    export function escapeHtml(value){
      return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    }

    export function radioApiUrl(params){
      const qs = new URLSearchParams(params);
      return `https://de1.api.radio-browser.info/json/stations/search?${qs.toString()}`;
    }

    export async function loadRadioStations(query='top'){
      currentRadioQuery = query || 'top';
      const token=++radioSearchToken;
      const list=$('radioStationList');
      list.innerHTML=stateHTML('loading','Finding stations…');
      try{
        const params = query==='top'
          ? {limit:'30',order:'votes',reverse:'true',hidebroken:'true',is_https:'true'}
          : {name:query,limit:'30',order:'votes',reverse:'true',hidebroken:'true',is_https:'true'};
        const res=await fetch(radioApiUrl(params),{headers:{'Accept':'application/json'}});
        if(!res.ok) throw new Error('Radio directory unavailable');
        const stations=await res.json();
        if(token!==radioSearchToken) return;
        const usable=stations.filter(s=>s.url_resolved || s.url);
        if(!usable.length){
          list.innerHTML=stateHTML('noresults','No stations found','Try another search or pick a genre above.');
          return;
        }
        list.innerHTML=usable.map((st,i)=>{
          const name=escapeHtml(st.name || 'Unknown Station');
          const country=escapeHtml(st.country || '');
          const tags=escapeHtml((st.tags||'').split(',').slice(0,2).join(' • '));
          const logo=st.favicon ? `<img src="${escapeHtml(st.favicon)}" alt="" onerror="this.style.display='none'">` : '<i class="fa-solid fa-radio"></i>';
          return `<div class="radio-station" data-radio-index="${i}">
            <div class="radio-station-art">${logo}</div>
            <div class="radio-station-main"><div class="radio-station-name">${name}</div><div class="radio-station-meta">${country}${country&&tags?' • ':''}${tags||'Live station'}</div></div>
            <button class="radio-play-btn" type="button" aria-label="Play ${name}"><i class="fa-solid fa-play"></i></button>
          </div>`;
        }).join('');
        usable.forEach((st,i)=>{
          list.querySelector(`[data-radio-index="${i}"]`).addEventListener('click',()=>playRadioStation(st));
        });
      }catch(err){
        if(token!==radioSearchToken) return;
        list.innerHTML=navigator.onLine ? stateHTML('error','Could not load stations','The radio directory did not respond. You can also paste a direct stream URL below.','Try again','loadRadioStations(currentRadioQuery)') : stateHTML('offline',"You're offline",'Connect to the internet to listen to live radio.','Try again','loadRadioStations(currentRadioQuery)');
      }
    }

    export function updateRadioPlayerUI(){
      const st=currentRadioStation;
      { const lt=$('radioLiveText'); if(lt) lt.textContent = st ? 'LIVE · '+(st.name||'On air') : 'LIVE'; }
      const playing=state.radioIsPlaying && !radioAudio.paused;
      $('radioMiniPlayer').classList.toggle('active',!!st);
      $('radioNowPlaying').classList.toggle('active',!!st);
      $('radioMiniName').textContent=st?.name || 'Live radio';
      $('radioMiniMeta').textContent=st ? `${st.country || 'Live station'}${st.tags ? ' • '+String(st.tags).split(',').slice(0,2).join(' • ') : ''}` : 'Live station';
      $('radioNowName').textContent=st?.name || 'Live radio';
      $('radioFullName').textContent=st?.name || 'Nothing playing';
      $('radioFullMeta').textContent=st ? `${st.country || 'Live station'}${st.tags ? ' • '+String(st.tags).split(',').slice(0,3).join(' • ') : ''}` : 'Live station';
      const logo=st?.favicon || '';
      ['radioMiniArt','radioNowArt'].forEach(id=>{ const el=$(id); if(!el)return; el.innerHTML=logo?`<img src="${escapeHtml(logo)}" alt="" onerror="this.style.display='none'">`:'<i class="fa-solid fa-radio"></i>'; });
      $('radioVinylCover').src=logo || '';
      $('radioMiniPlayBtn').innerHTML=`<i class="fa-solid fa-${playing?'pause':'play'}"></i>`;
      $('radioFullPlayIcon').className=`fa-solid fa-${playing?'pause':'play'}`;
      const vinyl=$('radioVinylRecord'); if(vinyl) vinyl.classList.toggle('spinning',playing);
      updateRadioMediaSession();
    }

    export function openRadioFullPlayer(){ if(!currentRadioStation) return toast('Nothing playing on radio','circle-info'); $('radioFullPlayerOverlay').classList.add('active'); updateRadioPlayerUI(); }
    export function closeRadioFullPlayer(){ $('radioFullPlayerOverlay').classList.remove('active'); }

    export function toggleRadioPlay(){
      if(!currentRadioStation) return;
      if(radioAudio.paused){ radioAudio.play().then(()=>{state.radioIsPlaying=true;updateRadioPlayerUI();}).catch(()=>toast('The radio stream could not be resumed','triangle-exclamation')); }
      else { radioAudio.pause(); state.radioIsPlaying=false; updateRadioPlayerUI(); }
    }

    export function playRadioStation(st){
      const url=st.url_resolved || st.url;
      if(!url){toast('This station has no playable stream','triangle-exclamation');return;}
      state.audio.pause();
      state.isPlaying=false;
      updatePlayState();
      $('miniPlayer').classList.remove('active');
      $('fullPlayerOverlay').classList.remove('active');
      currentRadioStation=st;
      saveRadioState(url);
      radioAudio.src=url;
      radioAudio.play().then(()=>{
        state.radioIsPlaying=true;
        updateRadioPlayerUI();
        document.querySelectorAll('.radio-play-btn').forEach(b=>{b.classList.remove('active');b.innerHTML='<i class="fa-solid fa-play"></i>';});
        const active=[...document.querySelectorAll('.radio-station')].find(el=>el.querySelector('.radio-station-name')?.textContent===String(st.name||'Unknown Station'));
        if(active){const b=active.querySelector('.radio-play-btn');b.classList.add('active');b.innerHTML='<i class="fa-solid fa-volume-high"></i>';}
      }).catch(()=>{state.radioIsPlaying=false;updateRadioPlayerUI();toast('This station could not be played by your browser','triangle-exclamation');});
    }

    export function playCustomRadio(){
      const url=$('customRadioUrl').value.trim();
      if(!/^https?:\/\//i.test(url)){toast('Enter a valid radio stream URL','triangle-exclamation');return;}
      state.audio.pause(); state.isPlaying=false; updatePlayState();
      $('miniPlayer').classList.remove('active');
      $('fullPlayerOverlay').classList.remove('active');
      currentRadioStation={name:'Custom radio station',country:'Custom stream',tags:'',favicon:'',url};
      saveRadioState(url);
      radioAudio.src=url;
      radioAudio.play().then(()=>{ state.radioIsPlaying=true; updateRadioPlayerUI(); }).catch(()=>{ state.radioIsPlaying=false; updateRadioPlayerUI(); toast('The stream could not be played. It may not be a browser-supported audio stream.','triangle-exclamation'); });
    }

    export function stopRadio(){
      if(!radioAudio.paused) radioAudio.pause();
      radioAudio.removeAttribute('src');
      radioAudio.load();
      state.radioIsPlaying=false;
      try{ localStorage.removeItem(RADIO_STATE_KEY); }catch(e){}
      currentRadioStation=null;
      $('radioMiniPlayer').classList.remove('active');
      $('radioFullPlayerOverlay').classList.remove('active');
      $('miniPlayer').classList.remove('active');
      $('fullPlayerOverlay').classList.remove('active');
      const now=$('radioNowPlaying'); if(now) now.classList.remove('active');
      const vinyl=$('radioVinylRecord'); if(vinyl) vinyl.classList.remove('spinning');
      document.querySelectorAll('.radio-play-btn').forEach(b=>{b.classList.remove('active');b.innerHTML='<i class="fa-solid fa-play"></i>';});
    }

    export function saveRadioState(url){
      if(!currentRadioStation || !url) return;
      try{
        localStorage.setItem(RADIO_STATE_KEY, JSON.stringify({url,station:currentRadioStation,playing:true,savedAt:Date.now()}));
      }catch(e){}
    }

    export function restoreRadioState(){
      try{
        const saved=JSON.parse(localStorage.getItem(RADIO_STATE_KEY)||'null');
        if(!saved || !saved.url || !saved.station) return;
        currentRadioStation=saved.station;
        radioAudio.src=saved.url;
        updateRadioPlayerUI();
      }catch(e){}
    }

    export function setupRadioMediaSession(){
      if(!('mediaSession' in navigator)) return;
      mediaSessionAction('play',()=>{if(currentRadioStation) radioAudio.play().catch(()=>{});});
      mediaSessionAction('pause',()=>radioAudio.pause());
      mediaSessionAction('stop',()=>stopRadio());
    }
    setupRadioMediaSession();

    export function updateRadioMediaSession(){
      if(!('mediaSession' in navigator) || !currentRadioStation) return;
      const st=currentRadioStation;
      try{
        navigator.mediaSession.metadata=new MediaMetadata({
          title:st.name || 'Live Radio',
          artist:st.country || 'Aura Music Radio',
          album:'Aura Music • Live Radio',
          artwork:st.favicon?[{src:st.favicon,sizes:'512x512',type:'image/png'}]:[]
        });
        navigator.mediaSession.playbackState=radioAudio.paused?'paused':'playing';
      }catch(e){}
    }

    radioAudio.addEventListener('error',()=>{
      if(currentRadioStation){ toast('Radio stream stopped or is not supported by this browser','triangle-exclamation'); }
    });

    $('radioSearchBtn').onclick=()=>loadRadioStations(currentRadioQuery || 'top');
    $('radioSearchInput').addEventListener('keydown',e=>{if(e.key==='Enter') loadRadioStations(e.target.value.trim()||'top');});
    document.querySelectorAll('.radio-chip').forEach(chip=>chip.addEventListener('click',()=>{
      document.querySelectorAll('.radio-chip').forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      $('radioSearchInput').value='';
      loadRadioStations(chip.dataset.radioQuery);
    }));
    $('radioStopBtn').onclick=stopRadio;
    $('customRadioPlayBtn').onclick=playCustomRadio;
    $('customRadioUrl').addEventListener('keydown',e=>{if(e.key==='Enter') playCustomRadio();});

    radioAudio.addEventListener('play',()=>{state.radioIsPlaying=true;if(currentRadioStation) saveRadioState(radioAudio.src);updateRadioPlayerUI();});
    radioAudio.addEventListener('pause',()=>{state.radioIsPlaying=false;updateRadioPlayerUI();});
    radioAudio.addEventListener('ended',()=>{state.radioIsPlaying=false;updateRadioPlayerUI();});
    restoreRadioState();

/* ===== 5853-5887 ===== */
    $('radioMiniPlayer').onclick=e=>{ if(!e.target.closest('.radio-mini-btn')) openRadioFullPlayer(); };
    $('radioMiniPlayBtn').onclick=e=>{e.stopPropagation();toggleRadioPlay();};
    $('radioMiniStopBtn').onclick=e=>{e.stopPropagation();stopRadio();};
    $('radioFullPlayBtn').onclick=toggleRadioPlay;
    $('radioFullStopBtn').onclick=stopRadio;
    $('radioFullCloseBtn').onclick=closeRadioFullPlayer;
    $('closeRadioFullPlayerBtn').onclick=closeRadioFullPlayer;
    /* Radio big-player three-dots menu */
    export function closeRadioSheetThen(fn){ closeTrackMenu(); setTimeout(fn,150); }
    export function openRadioMenu(e){
      if(e) e.stopPropagation();
      const st=currentRadioStation;
      if(!st) return toast('Nothing playing on radio','circle-info');
      const rows=[];
      rows.push(`<div class="track-sheet-row" onclick="closeRadioSheetThen(toggleRadioPlay)"><i class="fa-solid fa-${state.radioIsPlaying&&!radioAudio.paused?'pause':'play'}"></i>${state.radioIsPlaying&&!radioAudio.paused?'Pause':'Play'}</div>`);
      rows.push(`<div class="track-sheet-row" onclick="closeRadioSheetThen(radioMenuShare)"><i class="fa-solid fa-share-nodes"></i>Share station</div>`);
      rows.push(`<div class="track-sheet-row" onclick="closeRadioSheetThen(radioMenuCopy)"><i class="fa-solid fa-link"></i>Copy stream link</div>`);
      if(st.homepage) rows.push(`<div class="track-sheet-row" onclick="closeRadioSheetThen(radioMenuSite)"><i class="fa-solid fa-arrow-up-right-from-square"></i>Open station website</div>`);
      rows.push(`<div class="track-sheet-row danger" onclick="closeRadioSheetThen(stopRadio)"><i class="fa-solid fa-stop"></i>Stop radio</div>`);
      showTrackSheet({img:st.favicon||'', title:st.name||'Live station', artist:st.country||'Live radio', rowsHtml:rows.join('')});
    }
    export async function radioMenuShare(){
      const st=currentRadioStation; if(!st) return;
      const url=st.homepage||st.url_resolved||st.url||'';
      try{ if(navigator.share){ await navigator.share({title:st.name,text:'Listening to '+st.name+' on Aura Music',url}); return; } }catch(e){ return; }
      radioMenuCopy();
    }
    export function radioMenuCopy(){
      const st=currentRadioStation; if(!st) return;
      copyToClipboard(st.url_resolved||st.url||'','Stream link copied');
    }
    export function radioMenuSite(){ const st=currentRadioStation; if(st&&st.homepage) window.open(st.homepage,'_blank','noopener'); }
    $('radioHeaderMenuBtn').onclick=openRadioMenu;


