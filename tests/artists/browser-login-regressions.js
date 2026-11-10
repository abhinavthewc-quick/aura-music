/* Run on a fresh ?signed-out fixture (or ?page=admin&signed-out).
   Google UI, signing keys and server auth responses are synthetic and local.
   On a separate fresh main fixture, runEntryRegressions() checks the real HEAD
   before allowing any entry modules to execute. No extra fixture flags needed. */
const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}

export async function runEntryRegressions() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'main' || localStorage.getItem('auraSession_v2')) {
    throw new Error('Use a freshly loaded, signed-out main fixture.');
  }
  const checks = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const savedStorage = Object.entries(localStorage);
  const source = await fetch('/index.html').then((response) => response.text());
  const template = new DOMParser().parseFromString(source, 'text/html');
  const entrySrc = [...template.querySelectorAll('script[type="module"][src]')]
    .find((script) => /\/src\/main\.ts(?:\?|$)/.test(script.getAttribute('src')))?.getAttribute('src');
  check(entrySrc, 'fixture contains the real entry module');
  // Keep the production classic HEAD script and render-blocking CSS intact.
  // Holding modules makes a HEAD regression fail even with a warm module cache.
  template.querySelectorAll('script[type="module"],link[rel="modulepreload"]').forEach((node) => node.remove());
  const base = template.createElement('base');
  base.href = location.origin + '/';
  template.head.prepend(base);
  const session = (overrides = {}) => JSON.stringify({
    email: 'listener@example.test', name: 'Record listener', picture: '',
    exp: Math.floor(Date.now() / 1000) + 3600, token: 'fixture:not-a-real-credential', ...overrides,
  });
  const cases = [
    { name: 'signed out', raw: null },
    { name: 'returning Google session', raw: session(), restoring: true },
    { name: 'returning extended site session', raw: session({ token: 'v1.fixture-session' }), restoring: true },
    { name: 'returning local session', raw: session({ token: 'local:listener@example.test' }), restoring: true },
    { name: 'returning session without optional name', raw: session({ name: undefined }), restoring: true, fallbackName: true },
    { name: 'expired session', raw: session({ exp: Math.floor(Date.now() / 1000) - 1 }) },
    { name: 'expiry boundary', raw: session({ exp: Math.floor(Date.now() / 1000) }) },
    { name: 'malformed JSON', raw: '{broken' },
    { name: 'malformed expiry', raw: session({ exp: String(Math.floor(Date.now() / 1000) + 3600) }) },
    // JSON.stringify(Infinity) produces null; retain the actual overflow input.
    { name: 'non-finite expiry', raw: '{"email":"listener@example.test","token":"fixture:not-a-real-credential","exp":1e999}' },
    { name: 'missing token', raw: session({ token: '' }) },
    { name: 'missing email', raw: session({ email: '' }) },
    { name: 'blank token', raw: session({ token: ' \t\n' }) },
    { name: 'blank email', raw: session({ email: ' \t\n' }) },
    { name: 'numeric token', raw: session({ token: 123 }) },
    { name: 'numeric email', raw: session({ email: 123 }) },
    { name: 'boolean token', raw: session({ token: true }) },
    { name: 'boolean email', raw: session({ email: true }) },
    { name: 'object token', raw: session({ token: {} }) },
    { name: 'object email', raw: session({ email: {} }) },
    { name: 'array token', raw: session({ token: ['fixture'] }) },
    { name: 'array email', raw: session({ email: ['listener@example.test'] }) },
    { name: 'unavailable storage', raw: session(), blockedStorage: true },
    { name: 'expired while modules load', raw: session(), restoring: true, invalidate: 'expired' },
    { name: 'malformed while modules load', raw: session(), restoring: true, invalidate: 'malformed' },
    { name: 'entry module unavailable', raw: session(), restoring: true, timeout: true },
    { name: 'boot failure', raw: session(), restoring: true, failedWrite: true },
  ];
  let frame;
  try {
    for (const test of cases) {
      if (test.raw === null) localStorage.removeItem('auraSession_v2');
      else localStorage.setItem('auraSession_v2', test.raw);
      const html = template.cloneNode(true);
      const probe = html.createElement('script');
      probe.textContent = `(() => {
        ${test.blockedStorage ? "Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Fixture storage unavailable', 'SecurityError'); } });" : ''}
        const nativeTimeout = window.setTimeout.bind(window);
        window.__entryTimeouts = [];
        window.setTimeout = (callback, delay, ...args) => {
          const id = nativeTimeout(callback, delay, ...args);
          window.__entryTimeouts.push(() => { clearTimeout(id); callback(...args); });
          return id;
        };
        window.__restoreTimeouts = () => { window.setTimeout = nativeTimeout; };
        window.__entryPaints = [];
        window.__entryVisible = (element) => {
          if (!element || !element.getClientRects().length) return false;
          const style = getComputedStyle(element);
          return style.visibility === 'visible' && Number(style.opacity) > 0;
        };
        const sample = () => {
          const welcome = document.getElementById('welcomeScreen');
          const overlay = document.getElementById('loginOverlay');
          if (welcome && overlay) window.__entryPaints.push({ welcome: window.__entryVisible(welcome), overlay: window.__entryVisible(overlay) });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      })();`;
      html.head.prepend(probe);
      frame = document.createElement('iframe');
      frame.title = 'Aura entry regression';
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:#000';
      let loaded = false;
      frame.onload = () => { loaded = true; };
      frame.srcdoc = '<!DOCTYPE html>' + html.documentElement.outerHTML;
      document.body.appendChild(frame);
      await until(() => loaded && frame.contentWindow.__entryPaints?.length >= 2, test.name + ' first paints');
      const child = frame.contentWindow;
      const $ = (id) => child.document.getElementById(id);
      const visible = child.__entryVisible;
      const resources = () => child.performance.getEntriesByType('resource').map((entry) => entry.name);
      const runtimeRequested = () => resources().some((url) => /\/src\/(runtime|app)\.ts|\/src\/features\//.test(url));
      const root = child.document.documentElement;
      const assert = (value, label) => check(value, test.name + ': ' + label);
      child.__restoreTimeouts();
      assert(!resources().some((url) => /\/src\/main\.ts/.test(url)), 'first-paint checks precede entry module execution');
      assert(child.__entryPaints.every((paint) => paint.welcome === !test.restoring && paint.overlay === !!test.restoring), 'correct surface on every pre-module frame');
      assert($('musicApp').hidden && $('musicApp').inert && !runtimeRequested(), 'music stays hidden and idle before validation');
      if (test.restoring) {
        assert(root.dataset.auraEntry === 'restoring' && child.getComputedStyle($('welcomeScreen')).display === 'none', 'HEAD removes sign-in from rendering and keyboard navigation');
        assert($('loginOverlay').getAttribute('aria-hidden') !== 'true' && $('loginStatus').getAttribute('role') === 'status' && $('loginStatus').textContent.includes('Restoring'), 'restoration status is accessible before modules');
        assert(child.getComputedStyle($('loginOverlay')).backgroundColor === 'rgb(0, 0, 0)', 'restoration has a neutral black background');
      } else {
        assert(!root.hasAttribute('data-aura-entry') && !$('welcomeScreen').inert && !$('googleSignInBtn').disabled, 'signed-out controls are immediately accessible');
        assert(child.__entryTimeouts.length === 0, 'invalid or absent sessions do not install a loading gate');
      }

      if (test.timeout) {
        assert(child.__entryTimeouts.length === 1, 'HEAD installs a module-independent recovery timeout');
        child.__entryTimeouts[0]();
        await flush();
        assert(visible($('loginRetry')) && $('loginRetry').tagName === 'A' && $('loginRetry').hasAttribute('href'), 'failed module download offers native reload without JavaScript modules');
        assert($('loginStatus').textContent.includes('Reload') && !visible($('welcomeScreen')), 'timeout keeps clear recovery feedback instead of flashing sign-in');
        // A late module may still recover; it must also clear a failed HEAD gate.
      }
      if (test.invalidate) localStorage.setItem('auraSession_v2', test.invalidate === 'expired' ? session({ exp: 1 }) : '{broken');
      if (test.failedWrite) child.Storage.prototype.setItem = () => { throw new DOMException('Fixture write failed', 'QuotaExceededError'); };
      const errors = [];
      child.addEventListener('error', (event) => errors.push(event.message));
      child.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
      // Reuse the dedicated fixture's local API and beacon mocks in this realm.
      child.fetch = window.fetch.bind(window);
      child.navigator.sendBeacon = navigator.sendBeacon.bind(navigator);
      const requestsBefore = fixture.requests.length;
      const entry = child.document.createElement('script');
      entry.type = 'module'; entry.src = entrySrc;
      let started = false;
      entry.onload = () => { started = true; };
      entry.onerror = () => errors.push('Entry module failed');
      child.document.head.appendChild(entry);
      await until(() => started, test.name + ' entry startup');
      if (test.failedWrite) {
        await until(() => visible($('loginRetry')), 'retryable boot error');
        assert(root.dataset.auraEntry === 'failed' && $('loginStatus').textContent.includes('Could not open'), 'boot rejection becomes an explicit retryable error');
        assert($('musicApp').hidden && $('musicApp').inert && child.document.activeElement === $('loginRetry'), 'failed boot keeps the library locked and focuses recovery');
      } else if (test.restoring && !test.invalidate) {
        await until(() => !$('musicApp').hidden && !$('loginOverlay').classList.contains('active'), test.name + ' restoration');
        await flush();
        assert(!root.hasAttribute('data-aura-entry') && $('welcomeScreen').hidden && $('welcomeScreen').inert && !$('musicApp').inert, 'runtime readiness clears the gate and transfers accessibility');
        assert(child.document.activeElement === child.document.querySelector('.app-container'), 'restoration focuses the library');
        if (test.fallbackName) assert($('displayUserName').textContent === 'Listener', 'omitting the optional name keeps the listener fallback');
        assert(child.__entryPaints.every((paint) => !paint.welcome), 'returning session never paints sign-in, including the runtime handoff');
      } else {
        await flush();
        assert(!root.hasAttribute('data-aura-entry') && visible($('welcomeScreen')) && !$('welcomeScreen').inert && $('welcomeScreen').getAttribute('aria-hidden') !== 'true', 'authoritative validation releases sign-in without a stuck gate');
        assert(!visible($('loginOverlay')) && $('musicApp').hidden && $('musicApp').inert, 'invalid sessions leave only sign-in available');
        assert(!runtimeRequested() && fixture.requests.length === requestsBefore, 'invalid sessions do not fetch the runtime or catalogue');
      }
      assert(!resources().some((url) => url.includes('accounts.google.com')), 'restoration never downloads the Google SDK');
      assert(errors.length === 0, 'entry has no uncaught browser errors');
      frame.remove();
      frame = null;
    }
    return { page: fixture.page, passed: checks.length, checks };
  } finally {
    frame?.remove();
    localStorage.clear();
    for (const [key, value] of savedStorage) localStorage.setItem(key, value);
  }
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
    check(!document.documentElement.hasAttribute('data-aura-entry') && !$('welcomeScreen').inert, 'signed-out entry has no restoration gate');
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
      check(!document.documentElement.hasAttribute('data-aura-entry') && $('welcomeScreen').hidden, 'successful sign-in clears the entry gate without exposing sign-in');
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
