import './admin.css';
import { ADMIN_EMAILS, GOOGLE_CLIENT_ID } from '../core/config';
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
const queueList = $('queueList');
const runsList = $('runsList');
const urlCount = $('urlCount');
const batchHint = $('batchHint');
const searchInput = $<HTMLInputElement>('searchInput');
const searchResults = $('searchResults');
const searchStatus = $('searchStatus');
const searchModes = $('searchModes');
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
      if (!ADMIN_EMAILS.includes(p.email)) {
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
          theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with',
          width: Math.max(240, Math.min(420, gBtnBox.clientWidth || 420)),
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
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with',
        width: Math.max(240, Math.min(420, gBtnBox.clientWidth || 420)),
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

/* ---------- unified queue: search adds + pasted links (one source of truth,
   persisted so a reload never loses what you queued) ---------- */
const YT_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([\w-]{11})/;
const QUEUE_KEY = 'auraAdmin_queue_v1';
const MAX_PER_RUN = 10; // server-side dispatch cap

interface QueueItem {
  id: string;
  url: string;
  title: string;
  sub: string;
  thumb: string;
  source: 'search' | 'paste';
}

let queue: QueueItem[] = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((i: any) => i && i.id && i.url) : [];
  } catch {
    return [];
  }
})();

function saveQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* private mode */ }
}

const queueHas = (id: string) => queue.some((i) => i.id === id);

function addToQueue(item: QueueItem, silent = false): boolean {
  if (queueHas(item.id)) return false;
  queue.push(item);
  saveQueue();
  renderQueue();
  if (!silent) toast('Added to queue', 'ok');
  return true;
}

function removeFromQueue(id: string) {
  queue = queue.filter((i) => i.id !== id);
  saveQueue();
  renderQueue();
  syncResultRows();
}

function updateCounts() {
  const n = queue.length;
  urlCount.textContent = n ? `${n} track${n === 1 ? '' : 's'}` : '';
  const batches = Math.ceil(n / MAX_PER_RUN);
  batchHint.textContent = n > MAX_PER_RUN ? `splits into ${batches} runs · max ${MAX_PER_RUN} per run` : '';
}

function renderQueue() {
  updateCounts();
  queueList.innerHTML = '';
  if (!queue.length) {
    const empty = document.createElement('span');
    empty.className = 'adm-chip dim';
    empty.textContent = 'queue is empty — search above or paste links';
    queueList.appendChild(empty);
    return;
  }
  for (const item of queue) {
    const row = document.createElement('div');
    row.className = 'adm-prev-item';
    row.innerHTML =
      '<img alt="" loading="lazy"><div><div class="t"></div><div class="s"></div></div>' +
      '<button type="button" class="adm-qremove" title="Remove" aria-label="Remove from queue">×</button>';
    const img = row.querySelector('img') as HTMLImageElement;
    if (item.thumb) img.src = item.thumb;
    row.querySelector('.t')!.textContent = item.title;
    row.querySelector('.s')!.textContent = item.sub;
    row.querySelector('.adm-qremove')!.addEventListener('click', () => removeFromQueue(item.id));
    queueList.appendChild(row);
  }
}

/* ----- paste ingestion: valid lines are pulled into the queue automatically ----- */
function ingestPasted() {
  const lines = urlsInput.value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const valid: string[] = [];
  const keep: string[] = [];
  for (const l of lines) (YT_RE.test(l) ? valid : keep).push(l);
  if (!valid.length) return;
  let added = 0;
  for (const u of valid) {
    const id = YT_RE.exec(u)![1];
    if (queueHas(id)) continue;
    if (addToQueue({ id, url: u, title: 'Reading title…', sub: '', thumb: '', source: 'paste' }, true)) {
      added++;
      void enrichPaste(id, u);
    }
  }
  urlsInput.value = keep.join('\n');
  if (added) toast(`Added ${added} link${added === 1 ? '' : 's'} to queue`, 'ok');
  else toast('Already in the queue', 'err');
}

interface Oembed { title: string; author_name: string; thumbnail_url: string; }

async function enrichPaste(id: string, url: string) {
  const settle = (title: string, sub: string, thumb: string) => {
    const item = queue.find((i) => i.id === id);
    if (!item) return; // removed while fetching
    item.title = title;
    item.sub = sub;
    item.thumb = thumb;
    saveQueue();
    renderQueue();
  };
  try {
    const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const info = (await res.json()) as Oembed;
    settle(info.title || id, info.author_name || '', info.thumbnail_url || '');
  } catch {
    settle(id, 'title unavailable — still downloadable', '');
  }
}

/* ---------- search: type → debounced InnerTube query → click/Enter to queue ---------- */
interface SearchResult {
  videoId: string;
  title: string;
  sub: string;
  extra: string;
  duration: string | null;
  thumbnail: string | null;
  isLive: boolean;
}

let searchMode: 'music' | 'video' = 'music';
let searchSeq = 0;
let searchTimer: number | undefined;
let lastResults: Array<{ r: SearchResult; url: string }> = [];
const searchMemo = new Map<string, SearchResult[]>();

function renderResults(results: SearchResult[]) {
  lastResults = results.map((r) => ({
    r,
    url:
      searchMode === 'music'
        ? `https://music.youtube.com/watch?v=${r.videoId}`
        : `https://www.youtube.com/watch?v=${r.videoId}`,
  }));
  searchResults.innerHTML = '';
  for (const { r, url } of lastResults) {
    const row = document.createElement('div');
    row.className = 'adm-res' + (queueHas(r.videoId) ? ' added' : '');
    row.setAttribute('data-id', r.videoId);
    row.setAttribute('data-url', url);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML =
      '<img alt="" loading="lazy">' +
      '<div class="adm-res-txt"><div class="t"></div><div class="s"></div></div>' +
      '<span class="adm-res-x"></span>' +
      '<span class="adm-res-add"></span>';
    const img = row.querySelector('img') as HTMLImageElement;
    if (r.thumbnail) img.src = r.thumbnail;
    row.querySelector('.t')!.textContent = r.title;
    row.querySelector('.s')!.textContent = [r.sub, r.extra].filter(Boolean).join(' · ');
    row.querySelector('.adm-res-x')!.textContent = r.isLive ? 'LIVE' : r.duration || '';
    row.querySelector('.adm-res-add')!.textContent = queueHas(r.videoId) ? '✓' : '＋';
    const toggle = () => toggleResult(r, url);
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    searchResults.appendChild(row);
  }
}

function toggleResult(r: SearchResult, url: string) {
  if (queueHas(r.videoId)) removeFromQueue(r.videoId);
  else addToQueue({ id: r.videoId, url, title: r.title, sub: r.sub, thumb: r.thumbnail || '', source: 'search' });
  syncResultRows();
}

function syncResultRows() {
  searchResults.querySelectorAll<HTMLElement>('.adm-res').forEach((el) => {
    const id = el.getAttribute('data-id') || '';
    const added = queueHas(id);
    el.classList.toggle('added', added);
    const add = el.querySelector('.adm-res-add');
    if (add) add.textContent = added ? '✓' : '＋';
  });
}

function addTopResult() {
  const next = lastResults.find((e) => !queueHas(e.r.videoId));
  if (!next) {
    if (lastResults.length) setStatus(searchStatus, 'Everything shown is already queued — keep typing for more.', '');
    return;
  }
  addToQueue({
    id: next.r.videoId,
    url: next.url,
    title: next.r.title,
    sub: next.r.sub,
    thumb: next.r.thumbnail || '',
    source: 'search',
  });
  syncResultRows();
}

async function runSearch() {
  window.clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults.innerHTML = '';
    lastResults = [];
    setStatus(searchStatus, '');
    return;
  }
  const seq = ++searchSeq;
  const memoKey = searchMode + '|' + q.toLowerCase();
  const memo = searchMemo.get(memoKey);
  if (memo) {
    renderResults(memo);
    setStatus(searchStatus, `${memo.length} result${memo.length === 1 ? '' : 's'} · instant — click to queue, Enter adds the top match`);
    return;
  }
  setStatus(searchStatus, 'Searching…');
  try {
    const data = await adminApi<{ results: SearchResult[] }>('search', { q, mode: searchMode });
    if (seq !== searchSeq) return; // a newer keystroke superseded this request
    const results = Array.isArray(data.results) ? data.results : [];
    searchMemo.set(memoKey, results);
    renderResults(results);
    setStatus(
      searchStatus,
      results.length
        ? `${results.length} result${results.length === 1 ? '' : 's'} — click to queue, Enter adds the top match`
        : `No results for “${q}”`,
    );
  } catch (e) {
    if (seq !== searchSeq) return;
    setStatus(searchStatus, '✗ ' + ((e as Error).message || 'search failed'), 'err');
  }
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

  /* paste → valid lines flow into the queue after a short pause */
  let ingestTimer: number | undefined;
  urlsInput.addEventListener('input', () => {
    window.clearTimeout(ingestTimer);
    ingestTimer = window.setTimeout(ingestPasted, 350);
  });

  /* search: 250 ms debounce; Enter queues the top not-yet-queued match */
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { runSearch().catch(() => {}); }, 250);
  });
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTopResult();
    } else if (e.key === 'Escape') {
      searchInput.value = '';
      searchResults.innerHTML = '';
      lastResults = [];
      setStatus(searchStatus, '');
    }
  });

  searchModes.querySelectorAll<HTMLElement>('.adm-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'video' ? 'video' : 'music';
      if (mode === searchMode) return;
      searchMode = mode;
      searchModes.querySelectorAll('.adm-seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      runSearch().catch(() => {}); // memo is mode-keyed → instant when cached
    });
  });

  $('clearQueueBtn').addEventListener('click', () => {
    if (!queue.length) return;
    queue = [];
    saveQueue();
    renderQueue();
    syncResultRows();
    toast('Queue cleared');
  });

  $('downloadBtn').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('downloadBtn');
    const urls = queue.map((i) => i.url);
    if (!urls.length) {
      setStatus(downloadStatus, 'Queue is empty — search for a song or paste a link first.', 'err');
      return;
    }
    btn.disabled = true;
    setStatus(downloadStatus, 'Starting GitHub Actions run…');
    try {
      const batches: string[][] = [];
      for (let i = 0; i < urls.length; i += MAX_PER_RUN) batches.push(urls.slice(i, i + MAX_PER_RUN));
      for (const batch of batches) await adminApi('dispatch', { urls: batch });
      queue = [];
      saveQueue();
      renderQueue();
      syncResultRows();
      setStatus(
        downloadStatus,
        batches.length > 1
          ? `✓ ${urls.length} tracks dispatched across ${batches.length} runs — watch them below.`
          : `✓ ${urls.length} track${urls.length === 1 ? '' : 's'} dispatched — watch it below.`,
        'ok',
      );
      toast('Download started on GitHub Actions', 'ok');
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
renderQueue();
if (getSession()) unlock();
else lock();
