import { renderLibrary } from '../features/library';
import { loadRadioStations } from '../features/radio';
import { filterSearchTab } from '../features/search';
import { $ } from '../core/state';
/* ===== 3073-3074 ===== */
    export function goTab(tabId){ const b=document.querySelector(`.desktop-nav-btn[data-tab="${tabId}"]`)||document.querySelector(`[onclick*="'${tabId}'"]`); if(b) navClick(b,tabId); }

/* ===== 4872-4924 ===== */
    setTimeout(()=>{ const initial=document.querySelector('.nav-bar .nav-btn.active'); if(initial) moveNavIndicator(initial,true); }, 0);

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

      const iw=Math.min(78, Math.max(58, w-8));
      const ih=Math.min(46, h);
      const xCentered=x + (w-iw)/2;
      const yCentered=y + (h-ih)/2;

      indicator.style.width=`${iw}px`;
      indicator.style.height=`${ih}px`;

      if(instant){
        indicator.style.transition='none';
        indicator.style.setProperty('--nav-indicator-x', `${xCentered}px`);
        indicator.style.setProperty('--nav-indicator-y', `${yCentered}px`);
        indicator.offsetHeight;
        indicator.style.transition='transform .55s cubic-bezier(.16,1,.3,1)';
      }else{
        indicator.style.setProperty('--nav-indicator-x', `${xCentered}px`);
        indicator.style.setProperty('--nav-indicator-y', `${yCentered}px`);
      }
    }

    export function navClick(el,tabId){
      document.querySelectorAll('.nav-bar .nav-btn').forEach(b=>b.classList.remove('active'));
      if(el && el.classList) el.classList.add('active');
      if(el && el.classList && el.classList.contains('nav-btn')) moveNavIndicator(el);
      document.querySelectorAll('.desktop-nav-btn[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tabId));
      document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
      $(tabId).classList.add('active');
      if(tabId==='tabLibrary')renderLibrary();
      if(tabId==='tabSearch')filterSearchTab();
      if(tabId==='tabRadio' && !$('radioStationList').dataset.loaded){ $('radioStationList').dataset.loaded='1'; loadRadioStations('top'); }
    }

    window.addEventListener('resize',()=>{
      const active=document.querySelector('.nav-bar .nav-btn.active');
      if(active) moveNavIndicator(active,true);
    });

