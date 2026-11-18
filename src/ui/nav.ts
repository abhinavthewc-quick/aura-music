import { renderLibrary, flushPlaybackHomeRefresh } from '../features/library';
import { loadRadioStations } from '../features/radio';
import { $ } from '../core/state';
/* ===== 3073-3074 ===== */
    /* Set while a tab switch is a side effect of opening search, so activating
       Home does not immediately close the panel it is about to open. */
    let keepSearchOnHome = false;
    export function goTab(tabId: string, keepSearch = false){
      /* "Search" is no longer a tab. Deep links and older call sites still ask
         for it, so route them to the Home search panel instead of a dead id. */
      if(tabId === 'tabSearch'){
        (globalThis as any).openSearch?.(true);
        return;
      }
      const desktop = document.querySelector(`.desktop-nav-btn[data-tab="${tabId}"]`);
      const mobile = document.querySelector(`.nav-bar .nav-btn[onclick*="'${tabId}'"]`);
      const b = window.matchMedia('(max-width:899px)').matches ? (mobile || desktop) : (desktop || mobile);
      keepSearchOnHome = keepSearch;
      navClick(b, tabId);
      keepSearchOnHome = false;
    }

/* Playlist pseudo-tab — activates a generated tab without touching nav highlight */
    export function showPlaylistTab(tabId: string){
      const tab=$(tabId);
      if(!tab) return;
      (globalThis as any).closeSearch?.(true);
      document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.desktop-nav-btn[data-tab], .nav-bar .nav-btn, .nav-fab').forEach(b=>{
        const on = (b as HTMLElement).dataset.tab === 'tabPlaylists' || (b as HTMLElement).id === 'navPlaylistsBtn';
        b.classList.toggle('active', on);
        if(on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
      });
      const mobilePlaylists = document.getElementById('navPlaylistsBtn');
      const indicator = document.getElementById('navIndicator');
      if(indicator) indicator.style.opacity = '1';
      if(mobilePlaylists && window.matchMedia('(max-width:899px)').matches) moveNavIndicator(mobilePlaylists, true);
    }

/* ===== 4872-4924 ===== */
    setTimeout(()=>{
      const initial=document.querySelector('.nav-bar .nav-btn.active');
      if(initial) moveNavIndicator(initial,true);
      document.querySelectorAll('.nav-bar .nav-btn.active, .desktop-nav-btn.active[data-tab]').forEach(b => b.setAttribute('aria-current','page'));
    }, 0);

    export function moveNavIndicator(el, instant=false){
      const bar=$('mainNavBar'), indicator=$('navIndicator');
      if(!bar || !indicator || !el) return;

      // Position the indicator relative to the actual tab button.
      // The indicator is anchored at top:0, so the measured button offset
      // is used directly. This prevents the previous double vertical offset.
      const br=bar.getBoundingClientRect();
      const er=el.getBoundingClientRect();
      const x=er.left-br.left;
      const y=er.top-br.top;
      const w=er.width;
      const h=er.height;

      const iw=Math.min(80, Math.max(58, w-6));
      const ih=Math.min(60, h);
      const xCentered=x + (w-iw)/2;
      const yCentered=y + (h-ih)/2;

      indicator.style.width=`${iw}px`;
      indicator.style.height=`${ih}px`;

      if(instant){
        indicator.style.transition='none';
        indicator.style.setProperty('--nav-indicator-x', `${xCentered}px`);
        indicator.style.setProperty('--nav-indicator-y', `${yCentered}px`);
        indicator.offsetHeight;
        indicator.style.transition='';
      }else{
        indicator.style.setProperty('--nav-indicator-x', `${xCentered}px`);
        indicator.style.setProperty('--nav-indicator-y', `${yCentered}px`);
      }
    }

    export function navClick(el,tabId){
      document.querySelectorAll('.nav-bar .nav-btn, .nav-fab').forEach(b=>{ b.classList.remove('active'); b.removeAttribute('aria-current'); });
      if(el && el.classList){ el.classList.add('active'); el.setAttribute('aria-current','page'); }
      const ind=document.getElementById('navIndicator'); if(ind) ind.style.opacity = '1';
      if(el && el.classList && el.classList.contains('nav-btn')) moveNavIndicator(el);
      document.querySelectorAll('.desktop-nav-btn[data-tab]').forEach(b=>{
        const on = b.dataset.tab===tabId;
        b.classList.toggle('active', on);
        if(on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
      });
      document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
      $(tabId).classList.add('active');
      document.body.classList.remove('tab-search-active');
      /* Tapping Home from the nav returns to the feed; leaving Home closes the
         panel too, so coming back never lands on a stale query. */
      if(tabId !== 'tabHome' || !keepSearchOnHome) (globalThis as any).closeSearch?.(true);
      if(tabId==='tabLibrary')renderLibrary();
      if(tabId==='tabPlaylists') (globalThis as any).renderPlaylistsPage?.();
      if(tabId==='tabHome')flushPlaybackHomeRefresh();
      if(tabId==='tabRadio' && !$('radioStationList').dataset.loaded){ $('radioStationList').dataset.loaded='1'; loadRadioStations('top'); }
    }

    let navResizeRaf = 0;
    window.addEventListener('resize',()=>{
      if(navResizeRaf) return;
      navResizeRaf = requestAnimationFrame(()=>{
        navResizeRaf = 0;
        const active=document.querySelector('.nav-bar .nav-btn.active');
        if(active) moveNavIndicator(active,true);
      });
    });
