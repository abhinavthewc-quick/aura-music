import { GOOGLE_CLIENT_ID, ADMIN_EMAILS } from '../core/config';
import { verifyGoogleCredential } from '../core/google-auth';
import {
  exchangeGoogleToken, getProfileUsername, getSession, isValidUsername, normalizeUsername,
  SESSION_TTL_SEC, setProfileUsername, setSession,
} from '../core/session';
import { loginLocalAccount, normEmail, registerLocalAccount } from '../core/local-auth';
import { loadApplication } from '../core/bootstrap';
import { loadGoogleIdentity } from '../core/google-identity';

// Keep the entry independent of the music store and feature modules.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ===== 4813-4871 ===== */
    export async function finishLogin(n: string){
      const now = new Date().toISOString();
      if(!localStorage.getItem('auraFirstLogin')) localStorage.setItem('auraFirstLogin', now);
      localStorage.setItem('auraLastLogin', now);
      localStorage.setItem('auraUserName', n);
      await loadApplication();
    }

    export function showSignIn(message = ''){
      const welcome = $('welcomeScreen'), overlay = $('loginOverlay');
      const wasRestoring = document.documentElement.hasAttribute('data-aura-entry');
      const app = $('musicApp');
      app.hidden = true;
      app.inert = true;
      welcome.hidden = false;
      welcome.classList.remove('hidden');
      welcome.inert = false;
      welcome.setAttribute('aria-hidden', 'false');
      overlay.hidden = true;
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      $('loginRetry').hidden = true;
      document.documentElement.removeAttribute('data-aura-entry');
      if(message || wasRestoring) setGoogleNote(message || 'Please sign in again to continue.', true);
      if(wasRestoring) welcome.focus({ preventScroll: true });
    }

    function showLibraryError(message: string){
      document.documentElement.dataset.auraEntry = 'failed';
      const status = $('loginStatus');
      status.textContent = message;
      status.classList.add('login-error');
      $('loginRetry').hidden = false;
    }

    let libraryOpening = false;
    export async function playLoginAnimation(n: string, restoring = false){
      if(libraryOpening) return;
      if(!getSession()) { showSignIn('Your session has ended. Please sign in again.'); return; }
      libraryOpening = true;
      const overlay=$('loginOverlay');
      const wn=$('loginWelcomeName'); if(wn) wn.textContent=restoring ? 'Aura Music' : 'Welcome, '+n;
      const status=$('loginStatus');
      status.textContent='Getting your music ready…';
      status.classList.remove('login-error');
      $('loginRetry').hidden=true;
      const welcome=$('welcomeScreen');
      welcome.hidden=true;
      welcome.classList.add('hidden');
      welcome.inert=true;
      welcome.setAttribute('aria-hidden','true');
      overlay.hidden=false;
      overlay.classList.add('active');
      overlay.setAttribute('aria-hidden','false');
      document.documentElement.dataset.auraEntry='loading';
      overlay.focus({ preventScroll: true });
      const timeout=window.setTimeout(() => showLibraryError('Aura is taking longer than expected. Reload to try again.'), 15000);
      try{
        await finishLogin(n);
        $('loginRetry').hidden=true;
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden','true');
        document.querySelector<HTMLElement>('.app-container')?.focus({ preventScroll: true });
      }catch{
        if(!getSession()) showSignIn('Your session has ended. Please sign in again.');
        else {
          showLibraryError('Could not open your library. Check your connection and try again.');
          $('loginRetry').focus();
        }
      }finally{
        clearTimeout(timeout);
        libraryOpening=false;
      }
    }

    /* ---------- Google Sign-In (any Google account; username picked on first entry) ---------- */
    let gisInitialized = false;
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

    async function submitUsername(){
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
      await playLoginAnimation(n);
    }

    /* Shared entry: saved username → straight in; otherwise ask for one. */
    async function enterWithProfile(p: { email: string; name: string; picture: string; exp: number }, token: string){
      const saved = getProfileUsername(p.email);
      if(saved){
        setSession({ email: p.email, name: saved, picture: p.picture, exp: p.exp, token });
        await playLoginAnimation(saved);
        return;
      }
      pending = { profile: p, credential: token };
      showUsernamePicker(p.email);
    }

    async function handleCredential(credential: string){
      try{
        const p = await verifyGoogleCredential(credential, GOOGLE_CLIENT_ID);
        /* The Google ID token expires in ~1h. Give the site session a full
           7 days instead; allow-listed admins additionally exchange it at the
           server for a signed token the admin panel can keep using. */
        let token = credential;
        let exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
        if (ADMIN_EMAILS.includes(p.email)) {
          const swapped = await exchangeGoogleToken(credential);
          if (swapped) { token = swapped.token; exp = swapped.exp; }
        }
        await enterWithProfile({ ...p, exp }, token);
      }catch(err){
        setGoogleNote('Sign-in failed — ' + (((err as Error).message)||'please try again'), true);
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

    let authBusy = false;
    async function submitEmailAuth(){
      if(authBusy) return;
      setAuthErr('');
      const email = normEmail(($('authEmailInput') as HTMLInputElement)?.value || '');
      const pw = ($('authPasswordInput') as HTMLInputElement)?.value || '';
      const pw2 = ($('authPassword2Input') as HTMLInputElement)?.value || '';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ setAuthErr('Enter a valid email address.'); return; }
      if(pw.length < 6){ setAuthErr('Password needs at least 6 characters.'); return; }
      if(authMode === 'register' && pw !== pw2){ setAuthErr('Passwords don\'t match.'); return; }

      const go = $('authGo') as HTMLButtonElement;
      const goLabel = go ? go.textContent : '';
      authBusy = true;
      if(go){ go.disabled = true; go.setAttribute('aria-busy','true'); go.textContent = authMode === 'register' ? 'Creating account…' : 'Signing in…'; }
      try{
        if(authMode === 'register'){
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
        await enterWithProfile(
          { email, name: email, picture: '', exp: Math.floor(Date.now() / 1000) + 180 * 24 * 3600 },
          'local:' + email,
        );
      }finally{
        authBusy = false;
        if(go){ go.disabled = false; go.removeAttribute('aria-busy'); go.textContent = goLabel; }
      }
    }

    $('emailAuthToggle')?.addEventListener('click', showEmailAuth);
    $('authGoogleBack')?.addEventListener('click', showGoogleAuth);
    $('authSwitch')?.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
    $('authGo')?.addEventListener('click', submitEmailAuth);
    [$('authEmailInput'), $('authPasswordInput'), $('authPassword2Input')].forEach(el =>
      el?.addEventListener('keydown', (e: KeyboardEvent) => { if(e.key === 'Enter') submitEmailAuth(); }),
    );

    function setGoogleNote(message: string, error = false){
      const note = $('googleAuthNote');
      if(note){ note.textContent = message; note.classList.toggle('login-error', error); }
    }

    export function initGoogleAuth(){
      const box = $('googleSignInBox'), div = $('googleSignInDiv');
      const ours = $<HTMLButtonElement>('googleSignInBtn');
      if(!box || !div || !ours) return;
      if(!GOOGLE_CLIENT_ID){
        setGoogleNote('Google sign-in is not configured yet — continue with email & password below.', true);
        ours.hidden = true;
        return;
      }

      const w = window as any;
      const drawNativeButton = () => {
        const slot = Math.floor(div.getBoundingClientRect().width) || 275;
        // Google's personalized iframe adds padding beyond its width option.
        const width = Math.min(360, Math.max(200, slot - 40));
        w.google.accounts.id.renderButton(div, {
          theme: 'filled_black', size: 'large', shape: 'pill',
          text: 'signin_with', width,
        });
      };

      let resizeTimer: number | undefined;
      const onResize = () => {
        if(resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if(!w.google?.accounts?.id || div.hidden) return;
          div.replaceChildren();
          try{ drawNativeButton(); }catch{ /* keep the email fallback available */ }
        }, 200);
      };
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);

      ours.addEventListener('click', async () => {
        if(ours.disabled) return;
        ours.disabled = true;
        ours.setAttribute('aria-busy', 'true');
        setGoogleNote('Loading Google sign-in…');
        try{
          await loadGoogleIdentity();
          if(box.hidden || $('welcomeScreen').classList.contains('hidden')) return;
          if(!gisInitialized){
            w.google.accounts.id.initialize({
              client_id: GOOGLE_CLIENT_ID,
              callback: (resp: any) => handleCredential(resp?.credential || ''),
            });
            gisInitialized = true;
          }
          // One Tap is requested only by a click. The native button also lets
          // browsers that block One Tap open a fresh, user-initiated popup.
          ours.hidden = true;
          div.hidden = false;
          drawNativeButton();
          setGoogleNote('Choose your Google account to continue. You can also use the Google button above.');
          try{ w.google.accounts.id.prompt(); }catch{ /* native popup sign-in remains available */ }
        }catch(error){
          div.replaceChildren();
          div.hidden = true;
          ours.hidden = false;
          setGoogleNote((error as Error).message || 'Could not load Google sign-in. Try again or use email and password.', true);
        }finally{
          ours.disabled = false;
          ours.removeAttribute('aria-busy');
        }
      });
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
