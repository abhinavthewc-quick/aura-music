import { GOOGLE_CLIENT_ID } from '../core/config';
import { verifyGoogleCredential } from '../core/google-auth';
import {
  clearSession, getSession, getProfileUsername, isValidUsername, normalizeUsername,
  setProfileUsername, setSession,
} from '../core/session';
import { loginLocalAccount, normEmail, registerLocalAccount } from '../core/local-auth';
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
      const box = $('googleSignInBox'), step = $('usernameStep'), emailBox = $('emailAuthBox');
      if(!box || !step) return;
      $('pickEmail').textContent = 'Signed in as ' + email;
      const err = $('pickUsernameErr'); if(err){ err.hidden = true; err.textContent = ''; }
      const input = $('pickUsernameInput') as HTMLInputElement;
      if(input) input.value = '';
      box.hidden = true;
      if(emailBox) emailBox.hidden = true;
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

    /* Shared entry: saved username → straight in; otherwise ask for one. */
    function enterWithProfile(p: { email: string; name: string; picture: string; exp: number }, token: string){
      const saved = getProfileUsername(p.email);
      if(saved){
        setSession({ email: p.email, name: saved, picture: p.picture, exp: p.exp, token });
        playLoginAnimation(saved);
        return;
      }
      pending = { profile: p, credential: token };
      showUsernamePicker(p.email);
    }

    async function handleCredential(credential: string){
      try{
        const p = await verifyGoogleCredential(credential, GOOGLE_CLIENT_ID);
        enterWithProfile(p, credential);
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

    /* ---------- Email + password fallback (local accounts) ---------- */
    let authMode: 'login' | 'register' = 'login';

    function setAuthErr(msg: string){
      const err = $('authErr');
      if(!err) return;
      err.textContent = msg;
      err.hidden = !msg;
    }

    function setAuthMode(m: 'login' | 'register'){
      authMode = m;
      const p2 = $('authPassword2Wrap');
      if(p2) p2.hidden = m === 'login';
      const pw = $('authPasswordInput') as HTMLInputElement;
      if(pw) pw.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      const go = $('authGo');
      if(go) go.textContent = m === 'login' ? 'Sign in' : 'Create account';
      const sw = $('authSwitch');
      if(sw) sw.textContent = m === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
      setAuthErr('');
    }

    function showEmailAuth(){
      const box = $('googleSignInBox'), emailBox = $('emailAuthBox');
      if(!emailBox) return;
      if(box) box.hidden = true;
      emailBox.hidden = false;
      setAuthMode('login');
      setTimeout(()=>{ try{ ($('authEmailInput') as HTMLInputElement)?.focus(); }catch{ /* ignore */ } }, 60);
    }

    function showGoogleAuth(){
      const box = $('googleSignInBox'), emailBox = $('emailAuthBox');
      if(emailBox) emailBox.hidden = true;
      if(box) box.hidden = false;
    }

    async function submitEmailAuth(){
      setAuthErr('');
      const email = normEmail(($('authEmailInput') as HTMLInputElement)?.value || '');
      const pw = ($('authPasswordInput') as HTMLInputElement)?.value || '';
      const pw2 = ($('authPassword2Input') as HTMLInputElement)?.value || '';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ setAuthErr('Enter a valid email address.'); return; }
      if(pw.length < 6){ setAuthErr('Password needs at least 6 characters.'); return; }
      if(authMode === 'register'){
        if(pw !== pw2){ setAuthErr('Passwords don\'t match.'); return; }
        try{ await registerLocalAccount(email, pw); }
        catch(e){ setAuthErr((e as Error).message); return; }
      }else{
        try{
          if(!await loginLocalAccount(email, pw)){ setAuthErr('Wrong password for this account.'); return; }
        }catch(e){ setAuthErr((e as Error).message); return; }
      }
      const pwEl = $('authPasswordInput') as HTMLInputElement;
      const pw2El = $('authPassword2Input') as HTMLInputElement;
      if(pwEl) pwEl.value = '';
      if(pw2El) pw2El.value = '';
      enterWithProfile(
        { email, name: email, picture: '', exp: Math.floor(Date.now() / 1000) + 180 * 24 * 3600 },
        'local:' + email,
      );
    }

    $('emailAuthToggle')?.addEventListener('click', showEmailAuth);
    $('authGoogleBack')?.addEventListener('click', showGoogleAuth);
    $('authSwitch')?.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
    $('authGo')?.addEventListener('click', submitEmailAuth);
    [$('authPasswordInput'), $('authPassword2Input')].forEach(el =>
      el?.addEventListener('keydown', (e: KeyboardEvent) => { if(e.key === 'Enter') submitEmailAuth(); }),
    );

    export function initGoogleAuth(){
      const box = $('googleSignInBox'), div = $('googleSignInDiv'), note = $('googleAuthNote');
      if(!box || !div) return;
      if(!GOOGLE_CLIENT_ID){
        if(note) note.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Google sign-in is not configured yet — you can still continue with email &amp; password below.';
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
