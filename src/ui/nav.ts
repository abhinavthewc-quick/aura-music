import { renderLibrary, flushPlaybackHomeRefresh } from '../features/library';
import { loadRadioStations } from '../features/radio';
import { filterSearchTab } from '../features/search';
import { $ } from '../core/state';
/* ===== 3073-3074 ===== */
    export function goTab(tabId: string){
      const desktop = document.querySelector(`.desktop-nav-btn[data-tab="${tabId}"]`);
      const mobile = document.querySelector(`.nav-bar .nav-btn[onclick*="'${tabId}'"]`) ||
                     (tabId === 'tabSearch' ? document.getElementById('navSearchFab') : null);
      const b = window.matchMedia('(max-width:899px)').matches ? (mobile || desktop) : (desktop || mobile);
      navClick(b, tabId);
    }

/* Playlist pseudo-tab — activates a generated tab without touching nav highlight */
    export function showPlaylistTab(tabId: string){
      document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
      $(tabId).classList.add('active');
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

/* Mobile expandable search bar in the top header (desktop keeps the normal box) */
    export function openMobileSearch(){
      const bar=$('mobileSearchBar'); if(!bar) return;
      bar.classList.add('open');
      goTab('tabSearch');
      setTimeout(()=>{ (document.getElementById('mobileSearchInput') as HTMLInputElement)?.focus(); },90);
    }
    export function closeMobileSearch(){ $('mobileSearchBar')?.classList.remove('open'); }
    export function mobileSearchOnInput(el: HTMLInputElement){
      const input=$('searchTabInput') as HTMLInputElement | null;
      if(input){ input.value=el.value; }
      const headerInput=$('headerSearchInput') as HTMLInputElement | null;
      if(headerInput){ headerInput.value=el.value; }
      filterSearchTab();
    }
    export function mobileSearchClear(){
      const el=$('mobileSearchInput') as HTMLInputElement | null;
      if(el) el.value='';
      const input=$('searchTabInput') as HTMLInputElement | null;
      if(input){ input.value=''; }
      const headerInput=$('headerSearchInput') as HTMLInputElement | null;
      if(headerInput){ headerInput.value=''; }
      filterSearchTab();
      el?.focus();
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
      const ind=document.getElementById('navIndicator'); if(ind) ind.style.opacity = tabId==='tabSearch' ? '0' : '1';
      if(el && el.classList && el.classList.contains('nav-btn') && tabId!=='tabSearch') moveNavIndicator(el);
      document.querySelectorAll('.desktop-nav-btn[data-tab]').forEach(b=>{
        const on = b.dataset.tab===tabId;
        b.classList.toggle('active', on);
        if(on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
      });
      document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
      $(tabId).classList.add('active');
      document.body.classList.toggle('tab-search-active', tabId==='tabSearch');
      if(tabId==='tabLibrary')renderLibrary();
      if(tabId==='tabPlaylists') (globalThis as any).renderPlaylistsPage?.();
      if(tabId==='tabHome')flushPlaybackHomeRefresh();
      if(tabId==='tabSearch'){
        filterSearchTab();
        const tabInput = $('searchTabInput') as HTMLInputElement | null;
        if(tabInput){
          setTimeout(() => { tabInput.focus(); }, 60);
        }
      }
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

document.addEventListener('keydown',e=>{
  const bar=document.getElementById('mobileSearchBar');
  if(e.key==='Escape' && bar && bar.classList.contains('open')) bar.classList.remove('open');
});
