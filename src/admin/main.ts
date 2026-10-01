import './admin.css';
import { ALLOWED_EMAIL, GOOGLE_CLIENT_ID } from '../core/config';
import { verifyGoogleCredential } from '../core/google-auth';
import { clearSession, getSession, setSession } from '../core/session';

const SECRET_NAMES = ['HF_TOKEN', 'HF_BUCKET_ID', 'YOUTUBE_COOKIES'] as const;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing #' + id);
  return el as T;
};

const gateCard = $('gateCard');
const gateStatus = $('gateStatus');
const gBtnBox = $('adminGoogleBtn');
const urlsInput = $<HTMLTextAreaElement>('urlsInput');
const cookiesInput = $<HTMLTextAreaElement>('cookiesInput');
const secretsStatus = $('secretsStatus');
const downloadStatus = $('downloadStatus');
const previewList = $('previewList');
const runsList = $('runsList');
const urlCount = $('urlCount');
const toastHost = $('toastHost');
const gatedSections = Array.from(document.querySelectorAll<HTMLElement>('.adm-gated'));

/* ---------- toast ---------- */
function toast(msg: string, kind: 'ok' | 'err' | '' = '') {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function setStatus(el: HTMLElement, msg: string, kind: 'ok' | 'err' | '' = '') {
  el.textContent = msg;
  el.className = 'adm-status ' + kind;
}

/* ---------- server API (no tokens in this page — the server holds them
   and re-verifies the Google ID token on every single call) ---------- */
async function adminApi<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const session = getSession();
  if (!session) {
    lock('Your Google session expired — sign in again.');
    throw new Error('Sign in with Google first.');
  }
  let res: Response;
  try {
    res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: session.token, action, ...payload }),
    });
  } catch {
    throw new Error('network error — is the site reachable?');
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      clearSession();
      lock(data?.error || 'Sign-in required.');
    }
    throw new Error(data?.error || 'HTTP ' + res.status);
  }
  return data as T;
}

/* ---------- Google gate ---------- */
let gisInitialized = false;

function renderGisButton() {
  if (!GOOGLE_CLIENT_ID) {
    setStatus(gateStatus, 'Google sign-in unavailable — use email & password below.', 'err');
    return;
  }
  const w = window as any;
  const handleResp = async (resp: any) => {
    try {
      const p = await verifyGoogleCredential(resp?.credential || '', GOOGLE_CLIENT_ID);
      if (p.email !== (ALLOWED_EMAIL || '').toLowerCase()) {
        setStatus(gateStatus, 'Access denied — ' + p.email + ' is not allowed on this panel.', 'err');
        try { w.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* ignore */ }
        return;
      }
      setSession({ email: p.email, name: p.name, picture: p.picture, exp: p.exp, token: resp.credential });
      unlock();
    } catch (e) {
      setStatus(gateStatus, 'Sign-in failed — ' + ((e as Error).message || 'try again'), 'err');
    }
  };

  if (!document.getElementById('auraGsiScript')) {
    const s = document.createElement('script');
    s.id = 'auraGsiScript';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => {
      gisInitialized = true;
      try {
        w.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleResp,
        });
        w.google.accounts.id.renderButton(gBtnBox, {
          theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 275,
        });
      } catch {
        setStatus(gateStatus, 'Could not initialise Google sign-in.', 'err');
      }
    };
    s.onerror = () => setStatus(gateStatus, 'Could not load Google sign-in — check your connection.', 'err');
    document.head.appendChild(s);
  } else if (gisInitialized) {
    try {
      w.google.accounts.id.renderButton(gBtnBox, {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 275,
      });
    } catch { /* ignore */ }
  }
  setStatus(gateStatus, 'Waiting for Google sign-in…');
}

function unlock() {
  const session = getSession();
  if (!session) return lock();
  gateCard.hidden = true;
  const bar = $('sessionBar');
  bar.hidden = false;
  $('sessionEmail').textContent = session.email;
  gatedSections.forEach((s) => { s.hidden = false; });
  setStatus(gateStatus, '✓ Access granted.', 'ok');
  refreshSecretChips();
  refreshRuns();
}

function lock(msg?: string) {
  $('sessionBar').hidden = true;
  gatedSections.forEach((s) => { s.hidden = true; });
  gBtnBox.innerHTML = '';
  gateCard.hidden = false;
  renderGisButton();
  if (msg) setStatus(gateStatus, msg, 'err');
}

/* ---------- password fallback (server-issued token) ---------- */
async function passwordLogin() {
  const email = ($('admEmailInput') as HTMLInputElement).value.trim().toLowerCase();
  const password = ($('admPasswordInput') as HTMLInputElement).value;
  if (!email || !password) {
    setStatus(gateStatus, 'Enter your email and password.', 'err');
    return;
  }
  setStatus(gateStatus, 'Checking…');
  let data: any = null;
  let res: Response;
  try {
    res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password }),
    });
    data = await res.json().catch(() => null);
  } catch {
    setStatus(gateStatus, 'Network error — is the site reachable?', 'err');
    return;
  }
  if (!res.ok) {
    setStatus(gateStatus, data?.error || 'HTTP ' + res.status, 'err');
    return;
  }
  ($('admPasswordInput') as HTMLInputElement).value = '';
  setSession({ email: data.email, name: data.email, picture: '', exp: data.exp, token: data.token });
  unlock();
}

/* ---------- repository config status ---------- */
async function refreshSecretChips() {
  try {
    const data = await adminApi<{ secrets: string[] }>('status');
    const have = new Set(data.secrets || []);
    const host = document.getElementById('secretChips');
    if (!host) return;
    host.innerHTML = '';
    for (const name of SECRET_NAMES) {
      const chip = document.createElement('span');
      chip.className = 'adm-chip' + (have.has(name) ? '' : ' missing');
      chip.textContent = (have.has(name) ? '✓ ' : '✗ ') + name;
      host.appendChild(chip);
    }
  } catch { /* status line already shown */ }
}

/* ---------- preview ---------- */
const YT_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/;

function parseUrls(): string[] {
  const lines = urlsInput.value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!YT_RE.test(l)) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function updateUrlCount() {
  const all = urlsInput.value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const valid = parseUrls().length;
  if (!all.length) { urlCount.textContent = ''; return; }
  urlCount.textContent = valid === all.length ? `${valid} link${valid === 1 ? '' : 's'} ready` : `${valid}/${all.length} valid YouTube links`;
}

interface Oembed { title: string; author_name: string; thumbnail_url: string; }

async function fetchInfo(url: string): Promise<Oembed | null> {
  const res = await fetch(
    'https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json',
  );
  if (!res.ok) return null;
  return (await res.json()) as Oembed;
}

async function previewLinks() {
  const urls = parseUrls();
  previewList.innerHTML = '';
  updateUrlCount();
  if (!urls.length) return;
  previewList.innerHTML = '<span class="adm-chip dim">fetching titles…</span>';
  const results = await Promise.allSettled(
    urls.map(async (u) => ({ u, info: await fetchInfo(u) })),
  );
  previewList.innerHTML = '';
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'adm-prev-item';
    if (r.status === 'fulfilled' && r.value.info) {
      const { u, info } = r.value;
      item.innerHTML =
        `<img src="" alt="">` +
        `<div><div class="t"></div><div class="s"></div></div>`;
      (item.querySelector('img') as HTMLImageElement).src = info.thumbnail_url;
      item.querySelector('.t')!.textContent = info.title;
      item.querySelector('.s')!.textContent = info.author_name + ' · ' + YT_RE.exec(u)?.[1];
    } else {
      item.classList.add('bad');
      item.innerHTML = '<div><div class="t">Could not read this link</div><div class="s">not a valid YouTube URL?</div></div>';
    }
    previewList.appendChild(item);
  }
}

/* ---------- dispatch ---------- */
async function dispatchDownload() {
  const urls = parseUrls();
  if (!urls.length) throw new Error('Paste at least one valid YouTube link first.');
  await adminApi('dispatch', { urls });
}

/* ---------- runs ---------- */
interface Run {
  id: number; status: string; conclusion: string | null;
  created_at: string; html_url: string; display_title: string;
}

async function refreshRuns() {
  if (!getSession()) return;
  try {
    const data = await adminApi<{ runs: Run[] }>('runs');
    const runs = data.runs || [];
    if (!runs.length) {
      runsList.innerHTML = '<span class="adm-chip dim">no runs yet — start a download above</span>';
      return;
    }
    runsList.innerHTML = '';
    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'adm-run';
      const when = new Date(run.created_at).toLocaleString();
      const label = run.conclusion || run.status;
      row.innerHTML =
        `<span class="dot ${label}"></span>` +
        `<span class="title"></span>` +
        `<span class="meta">${label} · ${when}</span>` +
        `<a href="${run.html_url}" target="_blank" rel="noopener">logs</a>`;
      row.querySelector('.title')!.textContent = run.display_title;
      runsList.appendChild(row);
    }
  } catch {
    runsList.innerHTML = '<span class="adm-chip dim">could not load runs</span>';
  }
}

/* ---------- wiring ---------- */
function bind() {
  $('signOutBtn').addEventListener('click', () => {
    clearSession();
    location.reload();
  });
  $('admPasswordBtn').addEventListener('click', passwordLogin);
  $('admPasswordInput').addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') passwordLogin();
  });

  $('cookiesSaveBtn').addEventListener('click', async () => {
    try {
      const val = cookiesInput.value;
      if (!/#( Netscape HTTP Cookie File|http.cookie)/i.test(val) && !/^\S+\s+TRUE\s+\//m.test(val)) {
        throw new Error('This does not look like a Netscape cookies.txt file.');
      }
      await adminApi('setSecret', { name: 'YOUTUBE_COOKIES', value: val });
      setStatus(secretsStatus, 'YOUTUBE_COOKIES saved to the repository.', 'ok');
      toast('YouTube cookies uploaded', 'ok');
      refreshSecretChips();
    } catch (e) { setStatus(secretsStatus, (e as Error).message, 'err'); }
  });

  $('cookiesClearBtn').addEventListener('click', async () => {
    try {
      await adminApi('deleteSecret', { name: 'YOUTUBE_COOKIES' });
      cookiesInput.value = '';
      setStatus(secretsStatus, 'YOUTUBE_COOKIES removed.', 'ok');
      refreshSecretChips();
    } catch (e) { setStatus(secretsStatus, (e as Error).message, 'err'); }
  });

  $('cookiesFile').addEventListener('change', async () => {
    const input = $<HTMLInputElement>('cookiesFile');
    const file = input.files?.[0];
    if (!file) return;
    cookiesInput.value = await file.text();
    toast('Loaded ' + file.name, 'ok');
    input.value = '';
  });

  let previewTimer: number | undefined;
  urlsInput.addEventListener('input', () => {
    updateUrlCount();
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => { previewLinks().catch(() => {}); }, 700);
  });

  $('fetchBtn').addEventListener('click', () => {
    previewLinks().catch(() => toast('Title fetch failed (network?)', 'err'));
  });

  $('downloadBtn').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('downloadBtn');
    btn.disabled = true;
    setStatus(downloadStatus, 'Starting GitHub Actions run…');
    try {
      await dispatchDownload();
      setStatus(downloadStatus, '✓ Workflow dispatched — watch it below.', 'ok');
      toast('Download started on GitHub Actions', 'ok');
      urlsInput.value = '';
      previewList.innerHTML = '';
      updateUrlCount();
      setTimeout(refreshRuns, 2500);
    } catch (e) {
      setStatus(downloadStatus, '✗ ' + (e as Error).message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('runsRefreshBtn').addEventListener('click', () => refreshRuns());

  window.setInterval(() => {
    if (document.visibilityState === 'visible' && getSession()) refreshRuns();
  }, 10000);
}

/* ---------- boot ---------- */
try {
  localStorage.removeItem('auraAdmin_pat');
  localStorage.removeItem('auraAdmin_repo');
} catch { /* ignore */ }

bind();
if (getSession()) unlock();
else lock();
