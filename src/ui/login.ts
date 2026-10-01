import { GOOGLE_CLIENT_ID } from '../core/config';
import { verifyGoogleCredential } from '../core/google-auth';
import {
  clearSession, getSession, getProfileUsername, isValidUsername, normalizeUsername,
  setProfileUsername, setSession,
} from '../core/session';
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

    /* ---------- Google Sign-In (any Google account; username picked on first entry) ---------- */
    let gisLoaded = false;
    let pending: { profile: { email: string; name: string; picture: string; exp: number }; credential: string } | null = null;

    function showUsernamePicker(email: string){
      const box = $('googleSignInBox'), step = $('usernameStep');
      if(!box || !step) return;
      $('pickEmail').textContent = 'Signed in as ' + email;
      const err = $('pickUsernameErr'); if(err){ err.hidden = true; err.textContent = ''; }
      const input = $('pickUsernameInput') as HTMLInputElement;
      if(input) input.value = '';
      box.hidden = true;
      step.hidden = false;
      setTimeout(()=>{ try{ input?.focus(); }catch{ /* ignore */ } }, 60);
    }

    function hideUsernamePicker(){
      const box = $('googleSignInBox'), step = $('usernameStep');
      if(step) step.hidden = true;
      if(box) box.hidden = false;
    }

    function submitUsername(){
      const err = $('pickUsernameErr');
      const n = normalizeUsername(($('pickUsernameInput') as HTMLInputElement)?.value || '');
      if(!isValidUsername(n)){
        if(err){
          err.textContent = '3–20 characters — letters, numbers, spaces, _ or -, starting with a letter or number.';
          err.hidden = false;
        }
        return;
      }
      if(!pending){ hideUsernamePicker(); return; }
      const { profile, credential } = pending;
      pending = null;
      setProfileUsername(profile.email, n);
      setSession({ email: profile.email, name: n, picture: profile.picture, exp: profile.exp, token: credential });
      hideUsernamePicker();
      playLoginAnimation(n);
    }

    async function handleCredential(credential: string){
      try{
        const p = await verifyGoogleCredential(credential, GOOGLE_CLIENT_ID);
        const saved = getProfileUsername(p.email);
        if(saved){
          setSession({ email: p.email, name: saved, picture: p.picture, exp: p.exp, token: credential });
          playLoginAnimation(saved);
          return;
        }
        pending = { profile: { email: p.email, name: p.name, picture: p.picture, exp: p.exp }, credential };
        showUsernamePicker(p.email);
      }catch(err){
        toast('Sign-in failed — ' + (((err as Error).message)||'please try again'), 'triangle-exclamation');
      }
    }

    $('pickUsernameGo')?.addEventListener('click', submitUsername);
    $('pickUsernameInput')?.addEventListener('keydown', (e: KeyboardEvent) => {
      if(e.key === 'Enter') submitUsername();
    });
    $('pickUsernameBack')?.addEventListener('click', () => {
      pending = null;
      hideUsernamePicker();
    });

    export function initGoogleAuth(){
      const box = $('googleSignInBox'), div = $('googleSignInDiv'), note = $('googleAuthNote');
      if(!box || !div) return;
      if(!GOOGLE_CLIENT_ID){
        if(note) note.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Google sign-in is not configured yet — add the Client ID in <code>src/core/config.ts</code>.';
        return;
      }
      if(getSession()) return; // already signed in this session

      const w = window as any;
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = () => {
        gisLoaded = true;
        try{
          w.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: (resp: any) => handleCredential(resp?.credential || ''),
          });
          w.google.accounts.id.renderButton(div, {
            theme: 'filled_black', size: 'large', shape: 'pill',
            text: 'signin_with', width: 275,
          });
          w.google.accounts.id.prompt();
        }catch{ /* button container keeps its note text */ }
      };
      s.onerror = () => {
        if(note) note.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Could not load Google sign-in — check your connection.';
      };
      document.head.appendChild(s);
    }
    initGoogleAuth();

    /* Dev-only preview of the username step (localhost): /?__pickuser */
    if(location.hostname === 'localhost' && new URLSearchParams(location.search).has('__pickuser')){
      pending = { profile: { email:'preview@example.com', name:'Preview', picture:'', exp: Math.floor(Date.now()/1000)+3600 }, credential:'dev-preview' };
      showUsernamePicker('preview@example.com');
    }

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

export { clearSession };
