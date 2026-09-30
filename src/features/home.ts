import { timeGreeting, toast } from '../core/dom';
import { playSong } from './player';
import { escapeHtml } from './radio';
import { $, state } from '../core/state';
/* ===== 3075-3096 ===== */
    export function setGreeting(){
      $('greetingLabel').textContent = timeGreeting();
    }

    /* Jump back in to the last played track */
    export function resumeLastPlayed(){
      if(!state.recentlyPlayed.length) return toast('Nothing played yet', 'circle-info');
      const idx = state.songs.findIndex(s=>s.id===state.recentlyPlayed[0].id);
      if(idx===-1) return toast('That track is no longer available', 'triangle-exclamation');
      playSong(idx);
      $('fullPlayerOverlay').classList.add('active');
    }

    /* Play a random track from the whole library */
    export function shuffleAll(){
      if(!state.songs.length) return toast('Your library is empty', 'circle-info');
      if(!state.isShuffle){ state.isShuffle=true; $('shuffleBtn').classList.add('mode-active'); }
      const idx = Math.floor(Math.random()*state.songs.length);
      playSong(idx);
      $('fullPlayerOverlay').classList.add('active');
    }

/* ===== 3105-3161 ===== */
    /* Home: quick-access tiles built from real library data */
    export function renderQuickAccess(){
      if(typeof updateDesktopHeroStats==='function') updateDesktopHeroStats();
      const favCount = state.songs.filter(s=>s.favorite).length;
      const last = state.recentlyPlayed[0] ? state.songs.find(s=>s.id===state.recentlyPlayed[0].id) : null;
      const localCount = state.songs.filter(s=>s.isLocal).length;

      const tiles = [
        `<div class="quick-tile" onclick="goToSearchCategory('favorites')">
          <div class="quick-tile-art cat-favorites"><i class="fa-solid fa-heart"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Liked Songs</div><div class="qt-sub">${favCount} track${favCount!==1?'s':''}</div></div>
        </div>`,
        last ? `<div class="quick-tile" onclick="resumeLastPlayed()">
          <div class="quick-tile-art"><img src="${last.img}"></div>
          <div class="quick-tile-text"><div class="qt-title">Jump Back In</div><div class="qt-sub">${last.title}</div></div>
        </div>` : `<div class="quick-tile" onclick="shuffleAll()">
          <div class="quick-tile-art cat-shuffle"><i class="fa-solid fa-shuffle"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Shuffle All</div><div class="qt-sub">Random pick</div></div>
        </div>`,
        `<div class="quick-tile" onclick="goToSearchCategory('local')">
          <div class="quick-tile-art cat-local"><i class="fa-solid fa-file-audio"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Local Files</div><div class="qt-sub">${localCount} added</div></div>
        </div>`,
        `<div class="quick-tile" onclick="goToSearchCategory('recent')">
          <div class="quick-tile-art cat-recent"><i class="fa-solid fa-clock-rotate-left"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Recently Played</div><div class="qt-sub">${state.recentlyPlayed.length} track${state.recentlyPlayed.length!==1?'s':''}</div></div>
        </div>`
      ];
      $('quickGrid').innerHTML = tiles.join('');
    }

    /* Home: spotlight EVERY artist who has 2+ tracks in the library,
       most-tracks-first — not just a single top artist. */
    export function renderArtistSpotlight(){
      const counts={};
      state.songs.forEach(s=>{ if(s.artist && s.artist!=='Unknown Artist') counts[s.artist]=(counts[s.artist]||0)+1; });
      const artists = Object.keys(counts).filter(a=>counts[a]>=2).sort((a,b)=>counts[b]-counts[a]);
      const container = $('artistSpotlightContainer');

      if(!artists.length){ container.innerHTML=''; return; }

      container.innerHTML = artists.map(artist=>{
        const tracks = state.songs.filter(s=>s.artist===artist);
        const cards = tracks.map(s=>{
          const idx = state.songs.findIndex(item=>item.id===s.id);
          return `<div class="spotlight-card" onclick="playSong(${idx})"><img src="${s.img}"><p class="sc-title">${s.title}</p><p class="sc-sub">${s.artist}</p></div>`;
        }).join('');
        return `<div class="artist-spotlight-block" style="margin-bottom:24px">
          <div class="spotlight-header">
            <img class="spotlight-avatar" src="${tracks[0].img}" alt="">
            <div><p style="font-size:11px;color:var(--text-sub)">More from</p><p style="font-size:16px;font-weight:800">${artist}</p></div>
          </div>
          <div class="recent-scroll">${cards}</div>
        </div>`;
      }).join('');
    }

/* ===== 4646-4660 ===== */
    export let auraPickIds=[];
    export function renderAuraPicks(force?){
      const c=$('auraPicksScroll'); if(!c||typeof state.songs==='undefined') return;
      const valid=auraPickIds.filter(id=>state.songs.some(s=>s.id===id));
      if(force||!valid.length||valid.length!==auraPickIds.length){
        const pool=[...state.songs].sort(()=>Math.random()-.5).slice(0,8);
        auraPickIds=pool.map(s=>s.id);
      }
      c.innerHTML=auraPickIds.map(id=>{
        const i=state.songs.findIndex(s=>s.id===id), s=state.songs[i]; if(!s) return '';
        return `<div class="aura-pick" onclick="playSong(${i})"><img src="${escapeHtml(s.img||'')}" alt="" loading="lazy"><span class="aura-pick-play"><i class="fa-solid fa-play"></i></span><div class="aura-pick-info"><b>${escapeHtml(s.title||'')}</b><span>${escapeHtml(s.artist||'')}</span></div></div>`;
      }).join('');
    }
    setTimeout(()=>renderAuraPicks(),0);

/* ===== 6288-6302 ===== */
    export function updateDesktopHeroStats(){
      const set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=String(val);};
      set('desktopHeroTrackCount', Array.isArray(state.songs)?state.songs.length:0);
      set('desktopHeroFavCount', Array.isArray(state.songs)?state.songs.filter(s=>s.favorite).length:0);
      set('desktopHeroRecentCount', Array.isArray(state.recentlyPlayed)?state.recentlyPlayed.length:0);
    }


    document.addEventListener('DOMContentLoaded',()=>{
      updateDesktopHeroStats();
      document.querySelectorAll('.desktop-nav-btn[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{
        document.querySelectorAll('.desktop-nav-btn[data-tab]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
      }));
    });
