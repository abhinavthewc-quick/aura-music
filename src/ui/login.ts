import { toast } from '../core/dom';
import { updateProfilePopup } from '../features/settings';
import { $ } from '../core/state';
/* ===== 4706-4725 ===== */

    /* Merged home greeting (desktop hero) + welcome screen v2 */
    (function(){
      const lab=$('greetingLabel'), nm=$('displayUserName');
      function syncHero(){
        const hl=$('heroGreetLabel'), hn=$('heroGreetName');
        if(hl&&lab) hl.textContent=(lab.textContent||'Welcome back');
        if(hn&&nm) hn.textContent=(nm.textContent||'User');
      }
      if(lab&&nm){ const mo=new MutationObserver(syncHero); [lab,nm].forEach(e=>mo.observe(e,{childList:true,characterData:true,subtree:true})); syncHero(); }
                  const inp=$('userNameInput'), av=$('wcAvatar');
      if(inp&&av){
        const upd=()=>{
          const n=inp.value.trim();
          if(n){ av.textContent=n.charAt(0).toUpperCase(); }
          else{ av.innerHTML='<i class="fa-solid fa-user"></i>'; }
        };
        inp.addEventListener('input',upd); upd();
      }
    })();
/* ===== 4813-4871 ===== */
    export function finishLogin(n){
      const now = new Date().toISOString();
      if(!localStorage.getItem('auraFirstLogin')) localStorage.setItem('auraFirstLogin', now);
      localStorage.setItem('auraLastLogin', now);
      localStorage.setItem('auraUserName', n);
      $('displayUserName').textContent=$('profileName').textContent=n;
      $('welcomeScreen').classList.add('hidden');
      updateProfilePopup();
    }

    export function playLoginAnimation(n){
      const overlay=$('loginOverlay');
      const wn=$('loginWelcomeName'); if(wn) wn.textContent='Welcome, '+n;
      overlay.classList.add('active');
      overlay.setAttribute('aria-hidden','false');
      setTimeout(()=>{
        finishLogin(n);
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden','true');
      },1500);
    }

    $('doneBtn').onclick=()=>{
      const n=$('userNameInput').value.trim();
      if(!n){ $('userNameInput').focus(); toast('Please enter your name', 'circle-exclamation'); return; }
      playLoginAnimation(n);
    };

    $('userNameInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') $('doneBtn').click(); });
    $('welcomeInfo').onclick=(e)=>{
      e.stopPropagation();
      const panel=$('welcomeInfoPanel');
      const open=panel.classList.toggle('active');
      $('welcomeInfo').setAttribute('aria-expanded',String(open));
    };

    document.addEventListener('click',(e)=>{
      const panel=$('welcomeInfoPanel'), btn=$('welcomeInfo');
      if(panel && panel.classList.contains('active') && !panel.contains(e.target as any) && e.target!==btn && !btn.contains(e.target as any)){
        panel.classList.remove('active');
        btn.setAttribute('aria-expanded','false');
      }
    });

    $('profileBtn').onclick=(e)=>{
      e.stopPropagation();
      const pop=$('profilePopover');
      const open=pop.classList.toggle('active');
      $('profileBtn').setAttribute('aria-expanded', String(open));
      if(open) updateProfilePopup();
    };

    document.addEventListener('click',(e)=>{
      if(!e.target.closest('#profileWrap')){
        $('profilePopover').classList.remove('active');
        $('profileBtn').setAttribute('aria-expanded','false');
      }
    });

