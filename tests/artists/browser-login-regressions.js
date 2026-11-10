/* Run on a fresh ?signed-out fixture (or ?page=admin&signed-out).
   Google UI, signing keys and server auth responses are synthetic and local. */
const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}

export async function runLoginRegressions({ method = 'local' } = {}) {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || !fixture || localStorage.getItem('auraSession_v2')) {
    throw new Error('Use a freshly loaded, signed-out local fixture.');
  }
  const admin = fixture.page === 'admin';
  if (!['main', 'admin'].includes(fixture.page)) throw new Error('Use the main or admin fixture.');
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const $ = (id) => document.getElementById(id);
  const resources = () => performance.getEntriesByType('resource').map((entry) => entry.name);
  const runtimeRequested = () => resources().some((url) => /\/src\/(runtime|app)\.ts|\/src\/features\//.test(url));
  const start = $(admin ? 'adminGoogleStart' : 'googleSignInBtn');
  const native = $(admin ? 'adminGoogleNative' : 'googleSignInDiv');
  const note = $(admin ? 'gateStatus' : 'googleAuthNote');
  await flush();
  check(start && !start.hidden && !start.disabled, 'Google sign-in is usable before its SDK loads');
  check(!resources().some((url) => url.includes('accounts.google.com')), 'signed-out entry makes no Google request');
  check(fixture.requests.length === 0, 'signed-out entry makes no catalogue or admin API request');
  if (!admin) {
    check(!runtimeRequested(), 'signed-out entry does not import the music runtime');
    check($('musicApp').hidden && $('musicApp').inert && !$('audioPlayer').getAttribute('src'), 'music and audio remain idle until sign-in');
  }

  const originalAppend = document.head.appendChild;
  const originalFetch = window.fetch;
  const originalGoogle = window.google;
  const { GOOGLE_CLIENT_ID, ADMIN_EMAILS } = await import('/src/core/config.ts');
  const { getSession, setProfileUsername } = await import('/src/core/session.ts');
  let attempts = 0;
  let initialized = 0;
  let callback;
  let jwk;
  let authAction = '';
  const authEmail = ADMIN_EMAILS[0];
  const mock = { accounts: { id: {
    initialize(options) { initialized++; callback = options.callback; },
    renderButton(host) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Google fixture';
      host.replaceChildren(button);
    },
    prompt() {},
    disableAutoSelect() {},
  } } };

  document.head.appendChild = function (node) {
    if (!(node instanceof HTMLScriptElement) || !node.src.includes('accounts.google.com/gsi/client')) return originalAppend.call(this, node);
    attempts++;
    queueMicrotask(() => {
      if (attempts === 1) node.dispatchEvent(new Event('error'));
      else { window.google = mock; node.dispatchEvent(new Event('load')); }
    });
    return node;
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (url.pathname === '/api/admin' && ['login', 'exchange'].includes(body.action)) {
      authAction = body.action;
      fixture.requests.push({ method: 'POST', path: url.pathname, action: body.action });
      return Response.json({ email: authEmail, exp: Math.floor(Date.now() / 1000) + 604800, token: 'v1.fixture-session' });
    }
    return originalFetch(input, init);
  };

  try {
    start.click();
    await until(() => !start.disabled && note.textContent.includes('Could not load Google'), 'retryable Google network error');
    check(!start.hidden && native.hidden && attempts === 1, 'failed SDK download leaves a visible retry button');
    start.click(); start.click();
    await until(() => !native.hidden && callback, 'Google SDK retry');
    check(attempts === 2 && initialized === 1, 'retry initializes Google once and ignores duplicate clicks');
    await callback({ credential: 'not-an-id-token' });
    check(note.textContent.includes('Sign-in failed') && !getSession(), 'invalid Google credentials cannot create a session');
    check(admin ? !$('gateCard').hidden : !runtimeRequested(), 'invalid credentials leave the application locked');

    if (method === 'google') {
      const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
      jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'fixture', use: 'sig', alg: 'RS256' };
      const base64 = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const encode = (value) => base64(new TextEncoder().encode(JSON.stringify(value)));
      const credential = async (email) => {
        const now = Math.floor(Date.now() / 1000);
        const text = encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode({ email, email_verified: true, name: 'Google listener', sub: 'fixture', iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, iat: now, exp: now + 3600 });
        const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(text));
        return text + '.' + base64(new Uint8Array(signature));
      };
      if (admin) {
        await callback({ credential: await credential('unlisted@example.test') });
        check(note.textContent.includes('Access denied') && !getSession() && !authAction, 'admin allowlist rejects a verified but unlisted Google account');
        await callback({ credential: await credential(authEmail) });
      } else {
        setProfileUsername('google-listener@example.test', 'Cloud listener');
        await callback({ credential: await credential('google-listener@example.test') });
      }
    } else if (admin) {
      $('admEmailInput').value = authEmail;
      $('admPasswordInput').value = 'fixture-not-a-secret';
      $('admPasswordBtn').click();
    } else {
      $('emailAuthToggle').click();
      $('authSwitch').click();
      $('authEmailInput').value = 'bootstrap@example.test';
      $('authPasswordInput').value = 'fixture-password';
      $('authPassword2Input').value = 'mismatch';
      $('authGo').click();
      check($('authErr').textContent.includes("don't match") && !getSession(), 'password confirmation is validated before account creation');
      $('authPassword2Input').value = 'fixture-password';
      $('authGo').click();
      await until(() => !$('usernameStep').hidden, 'first-entry username picker');
      check(!getSession() && !runtimeRequested(), 'first-entry username selection precedes runtime loading');
      check(!$('authPasswordInput').value && !$('authPassword2Input').value, 'successful local verification clears password fields');
      $('pickUsernameInput').value = '!';
      $('pickUsernameGo').click();
      check(!$('pickUsernameErr').hidden && !getSession(), 'invalid usernames leave the entry gate active');
      $('pickUsernameInput').value = 'New listener';
      $('pickUsernameGo').click();
    }

    if (admin) {
      await until(() => $('gateCard').hidden && !$('sessionBar').hidden, 'admin sign-in completion');
      check(getSession()?.email === authEmail && getSession()?.token === 'v1.fixture-session', 'admin stores the server-issued session');
      check(authAction === (method === 'google' ? 'exchange' : 'login'), 'admin uses the existing server authentication path');
      check(!document.getElementById('panelAdd').hidden && fixture.requests.some((request) => request.action === 'library'), 'successful admin login loads the management panels');
      if (method !== 'google') check(!$('admPasswordInput').value, 'password fallback clears its password after sign-in');
    } else {
      await until(() => !$('musicApp').hidden && !$('loginOverlay').classList.contains('active'), 'authenticated music bootstrap');
      const name = method === 'google' ? 'Cloud listener' : 'New listener';
      check(getSession()?.name === name && $('displayUserName').textContent === name && $('popupProfileName').textContent === name, 'sign-in updates the session, greeting and profile');
      check($('welcomeScreen').inert && $('welcomeScreen').getAttribute('aria-hidden') === 'true' && !$('musicApp').inert, 'completed bootstrap transfers interaction and accessibility to the library');
      check(document.activeElement === document.querySelector('.app-container'), 'successful sign-in moves keyboard focus into the library');
      await until(() => window.state?.songs.some((song) => song.isLocal && song.url?.startsWith('blob:')), 'local audio hydration after login');
      check(localStorage.getItem('auraPlaylists') === fixture.playlist, 'bootstrap preserves existing local playlists');
      check(window.state.songs.some((song) => song.title === 'Hand upload') && fixture.requests.some((request) => request.path === '/api/artists'), 'bootstrap loads cached tracks and refreshes cloud artists');
      check(typeof window.playSong === 'function' && !$('loginRetry').offsetParent, 'playback becomes ready and loading feedback is dismissed');
    }
    const missingIcons = [...document.querySelectorAll('.fa-solid,.fa-regular,.fa-brands')].filter((icon) => !getComputedStyle(icon).getPropertyValue('--aura-icon').trim());
    check(missingIcons.length === 0, 'local icon masks cover the rendered UI');
    check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'sign-in completion has no horizontal overflow');
    check(fixture.errors.length === 0, 'sign-in has no uncaught browser errors');
    return { page: fixture.page, method, passed: checks.length, checks };
  } finally {
    document.head.appendChild = originalAppend;
    window.fetch = originalFetch;
    window.google = originalGoogle;
  }
}
