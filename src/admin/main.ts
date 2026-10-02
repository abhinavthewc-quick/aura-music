import './admin.css';
import { ADMIN_EMAILS, GOOGLE_CLIENT_ID } from '../core/config';
import { cleanArtist, cleanTitle } from '../core/catalog';
import { verifyGoogleCredential } from '../core/google-auth';
import { clearSession, exchangeGoogleToken, getSession, setSession } from '../core/session';

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
      /* Server-issued sessions are dead for good; a raw Google token may
         only be stale here — keep it so the main-site login survives. */
      if (session.token.startsWith('v1.') || session.token.startsWith('local:')) clearSession();
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
      /* The Google ID token dies in ~1h — exchange it for a 7-day
         server-signed session so the panel stays open. */
      const swapped = await exchangeGoogleToken(resp?.credential || '');
      setSession(swapped
        ? { email: p.email, name: p.name, picture: p.picture, exp: swapped.exp, token: swapped.token }
        : { email: p.email, name: p.name, picture: p.picture, exp: p.exp, token: resp.credential });
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
  void refreshLibrary(); // populate "already uploaded" marks for search/queue/dispatch
  void loadLibraryManager(); // bucket file list for the management card
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

/* ---------- what is already in the bucket ("library") ----------
   One video ID drives every dedupe surface: search rows, pasted links,
   artist expansion and the dispatch filter on the server. */
let libraryIdSet = new Set<string>();
let libraryLoaded = false;
let libraryLoading: Promise<void> | null = null;

async function refreshLibrary(force = false): Promise<void> {
  if (libraryLoading) return libraryLoading;
  if (libraryLoaded && !force) return;
  libraryLoading = (async () => {
    try {
      const data = await adminApi<{ videoIds?: string[] }>('library');
      libraryIdSet = new Set((data.videoIds || []).filter(Boolean));
      libraryLoaded = true;
      syncResultRows();
      renderQueue();
    } catch { /* status line already surfaced */ }
    finally { libraryLoading = null; }
  })();
  return libraryLoading;
}

const inLibrary = (id: string) => libraryIdSet.has(id);

/* YT Music sub = "Lead artist, co-artist… • Album • 6:10" (music) or channel
   (video). The primary artist is what we search & match on — full credit
   lists would almost never match exactly across songs. */
function artistOf(sub: string, mode: 'music' | 'video'): string {
  const first = mode === 'music' ? (sub || '').split('•')[0] : sub;
  return normalizeArtist(first.split(',')[0]);
}

function normalizeArtist(name: string): string {
  return (name || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\.\s*/g, '.') // "A. R." === "AR"
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();
}

function addToQueue(item: QueueItem, silent = false): boolean {
  if (queueHas(item.id) || inLibrary(item.id)) return false;
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
    row.querySelector('.s')!.textContent =
      item.sub + (inLibrary(item.id) ? (item.sub ? ' · ' : '') + '✓ already in library' : '');
    row.querySelector('.adm-qremove')!.addEventListener('click', () => removeFromQueue(item.id));
    queueList.appendChild(row);
  }
}

/* ----- paste ingestion: valid lines are pulled into the queue automatically;
   playlist/album links expand into their individual tracks ----- */
const PLAYLIST_RE = /[?&]list=[A-Za-z0-9_-]{6,}/;
const isPlaylistLine = (l: string) =>
  PLAYLIST_RE.test(l) && !/watch\?v=|youtu\.be\/|shorts\//.test(l);

function ingestPasted() {
  const lines = urlsInput.value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const valid: string[] = [];
  const playlists: string[] = [];
  const keep: string[] = [];
  for (const l of lines) {
    if (isPlaylistLine(l)) playlists.push(l);
    else if (YT_RE.test(l)) valid.push(l);
    else keep.push(l);
  }
  urlsInput.value = keep.join('\n');
  if (playlists.length) playlists.forEach((u) => void expandPlaylist(u));
  if (!valid.length && !playlists.length) return;
  let added = 0;
  let alreadyQueued = 0;
  let alreadyUploaded = 0;
  for (const u of valid) {
    const id = YT_RE.exec(u)![1];
    if (queueHas(id)) { alreadyQueued++; continue; }
    if (inLibrary(id)) { alreadyUploaded++; continue; }
    if (addToQueue({ id, url: u, title: 'Reading title…', sub: '', thumb: '', source: 'paste' }, true)) {
      added++;
      void enrichPaste(id, u);
    }
  }
  const skipped = alreadyQueued + alreadyUploaded;
  if (added) toast(`Added ${added} link${added === 1 ? '' : 's'} to queue${skipped ? ` · ${skipped} skipped` : ''}`, 'ok');
  else if (skipped) toast('Already in the queue or library', 'err');
}

/* Expand a /playlist?list=… (or album) link server-side and queue each track. */
async function expandPlaylist(url: string) {
  setStatus(searchStatus, 'Reading playlist…');
  try {
    const data = await adminApi<{ type: string; title: string; tracks: SearchResult[] }>('expand', { url });
    let added = 0;
    let skipped = 0;
    for (const t of data.tracks || []) {
      if (queueHas(t.videoId) || inLibrary(t.videoId)) { skipped++; continue; }
      if (addToQueue({
        id: t.videoId,
        url: `https://music.youtube.com/watch?v=${t.videoId}`,
        title: t.title || t.videoId,
        sub: t.sub,
        thumb: t.thumbnail || '',
        source: 'paste',
      }, true)) added++;
    }
    const kind = data.type === 'album' ? 'Album' : 'Playlist';
    setStatus(searchStatus, `${kind} “${data.title}” — ${added} track${added === 1 ? '' : 's'} queued${skipped ? `, ${skipped} skipped` : ''}`, 'ok');
    toast(`${kind} expanded — ${added} track${added === 1 ? '' : 's'} queued`, 'ok');
    syncResultRows();
  } catch (e) {
    setStatus(searchStatus, '✗ ' + ((e as Error).message || 'could not read that playlist'), 'err');
  }
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
    const artist = artistOf(r.sub, searchMode);
    const uploaded = inLibrary(r.videoId);
    const row = document.createElement('div');
    row.className = 'adm-res' + (queueHas(r.videoId) ? ' added' : '') + (uploaded ? ' in-lib' : '');
    row.setAttribute('data-id', r.videoId);
    row.setAttribute('data-url', url);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML =
      '<img alt="" loading="lazy">' +
      '<div class="adm-res-txt"><div class="t"></div><div class="s"></div></div>' +
      '<span class="adm-res-x"></span>' +
      '<button type="button" class="adm-res-artist" title="Queue every track by this artist"></button>' +
      '<span class="adm-res-add"></span>';
    const img = row.querySelector('img') as HTMLImageElement;
    if (r.thumbnail) img.src = r.thumbnail;
    row.querySelector('.t')!.textContent = r.title;
    row.querySelector('.s')!.textContent = [r.sub, r.extra].filter(Boolean).join(' · ');
    row.querySelector('.adm-res-x')!.textContent = r.isLive ? 'LIVE' : r.duration || '';
    row.querySelector('.adm-res-add')!.textContent = uploaded ? 'library' : queueHas(r.videoId) ? '✓' : '＋';
    const artistBtn = row.querySelector('.adm-res-artist') as HTMLButtonElement;
    artistBtn.textContent = '+ all';
    artistBtn.title = 'Queue every track by ' + (artist || 'this artist');
    artistBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void queueArtist(artist, searchMode);
    });
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
  if (inLibrary(r.videoId)) {
    toast('Already in your library', '');
    return;
  }
  if (queueHas(r.videoId)) removeFromQueue(r.videoId);
  else addToQueue({ id: r.videoId, url, title: r.title, sub: r.sub, thumb: r.thumbnail || '', source: 'search' });
  syncResultRows();
}

function syncResultRows() {
  searchResults.querySelectorAll<HTMLElement>('.adm-res').forEach((el) => {
    const id = el.getAttribute('data-id') || '';
    const added = queueHas(id);
    const uploaded = inLibrary(id);
    el.classList.toggle('added', added);
    el.classList.toggle('in-lib', uploaded);
    const add = el.querySelector('.adm-res-add');
    if (add) add.textContent = uploaded ? 'library' : added ? '✓' : '＋';
  });
}

/* "+ all by artist" — re-queries search, keeps only rows whose artist
   (first segment of the YT Music sub line) matches exactly, queues ≤ 20. */
const ARTIST_MAX = 20;
let artistBusy = false;

async function queueArtist(artist: string, mode: 'music' | 'video'): Promise<void> {
  const q = (artist || '').replace(/\s*-\s*Topic$/i, '').trim();
  if (!q) return;
  if (artistBusy) {
    toast('Artist lookup already running', '');
    return;
  }
  artistBusy = true;
  setStatus(searchStatus, `Finding tracks by ${q}…`);
  try {
    const data = await adminApi<{ results: SearchResult[] }>('search', { q, mode });
    const norm = normalizeArtist(q);
    const matches = (data.results || []).filter(
      (r) => artistOf(r.sub, mode) === norm,
    );
    let added = 0;
    let skipped = 0;
    for (const r of matches.slice(0, ARTIST_MAX)) {
      if (queueHas(r.videoId) || inLibrary(r.videoId)) {
        skipped++;
        continue;
      }
      const url =
        mode === 'music'
          ? `https://music.youtube.com/watch?v=${r.videoId}`
          : `https://www.youtube.com/watch?v=${r.videoId}`;
      if (addToQueue({ id: r.videoId, url, title: r.title, sub: r.sub, thumb: r.thumbnail || '', source: 'search' }, true)) {
        added++;
      }
    }
    if (!matches.length) {
      setStatus(searchStatus, `No tracks found for “${q}”`, 'err');
      toast('No matching tracks found', 'err');
    } else {
      const more = matches.length > ARTIST_MAX ? ` (top ${ARTIST_MAX} of ${matches.length})` : '';
      const note = skipped ? ` · ${skipped} already queued/library` : '';
      setStatus(searchStatus, `${added} track${added === 1 ? '' : 's'} by ${q} queued${more}${note}`, 'ok');
      toast(added ? `Queued ${added} by ${q}` : 'Nothing new to queue', added ? 'ok' : '');
    }
    syncResultRows();
  } catch (e) {
    setStatus(searchStatus, '✗ ' + ((e as Error).message || 'artist search failed'), 'err');
  } finally {
    artistBusy = false;
  }
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

/* ---------- bucket library manager (F6) ----------
   Rename/delete are direct HF batch mutations (instant); cover art stages
   the image in the repo and rides manage-music.yml (~1 min). */
const AUDIO_FILE_RE = /\.(opus|mp3|ogg|m4a|webm)$/i;
const MAX_COVER_BYTES = 1.5 * 1024 * 1024;
let libFiles: { path: string; size: number }[] = [];
let coverPicker: HTMLInputElement | null = null;

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function renderLibList() {
  const list = $('libList');
  list.innerHTML = '';
  if (!libFiles.length) {
    list.innerHTML = '<span class="adm-chip dim">the bucket is empty</span>';
    return;
  }
  for (const f of libFiles) {
    const stem = f.path.replace(/\.[^.]+$/, '');
    const row = document.createElement('div');
    row.className = 'adm-lib';
    row.innerHTML =
      '<span class="nm"></span><span class="sz"></span>' +
      '<span class="acts">' +
      '<button type="button" class="adm-libbtn" data-a="ren" title="Rename track">✎ rename</button>' +
      '<button type="button" class="adm-libbtn" data-a="cov" title="Replace cover art">🖼 cover</button>' +
      '<button type="button" class="adm-libbtn danger" data-a="del" title="Delete track and cover">🗑 delete</button>' +
      '</span>';
    row.querySelector('.nm')!.textContent = stem;
    row.querySelector('.sz')!.textContent = fmtSize(f.size);
    row.querySelector('[data-a="ren"]')!.addEventListener('click', () => startLibRename(row, f.path));
    row.querySelector('[data-a="cov"]')!.addEventListener('click', () => pickLibCover(f.path));
    row.querySelector('[data-a="del"]')!.addEventListener('click', () => deleteLibTrack(f.path));
    list.appendChild(row);
  }
}

async function loadLibraryManager(notify = false): Promise<void> {
  if (notify) setStatus($('libStatus'), 'Loading bucket…');
  try {
    const data = await adminApi<{ files: { path: string; size: number }[] }>('library');
    libFiles = (data.files || []).filter((f) => AUDIO_FILE_RE.test(f.path));
    renderLibList();
    if (notify) setStatus($('libStatus'), `${libFiles.length} tracks in the bucket`, 'ok');
  } catch (e) {
    $('libList').innerHTML = '<span class="adm-chip dim">could not load the bucket</span>';
    if (notify) setStatus($('libStatus'), '✗ ' + ((e as Error).message || 'load failed'), 'err');
  }
}

function startLibRename(row: HTMLElement, path: string) {
  if (row.classList.contains('editing')) return;
  row.classList.add('editing');
  const stem = path.replace(/\.[^.]+$/, '');
  const ext = path.slice(stem.length);
  const input = document.createElement('input');
  input.className = 'adm-input adm-libedit';
  input.value = stem;
  input.spellcheck = false;
  row.querySelector('.nm')!.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const to = (input.value || '').trim() + ext;
    if (!to || to === path) {
      row.classList.remove('editing');
      renderLibList();
      return;
    }
    setStatus($('libStatus'), 'Renaming…');
    try {
      const res = await adminApi<{ renamed?: string[] }>('bucketRename', { from: path, to });
      setStatus($('libStatus'), '✓ renamed → ' + (res.renamed || []).join(', '), 'ok');
      toast('Track renamed', 'ok');
      await Promise.all([loadLibraryManager(false), refreshLibrary(true)]);
    } catch (e) {
      setStatus($('libStatus'), '✗ ' + ((e as Error).message || 'rename failed'), 'err');
      row.classList.remove('editing');
      renderLibList();
    }
  };
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    else if (e.key === 'Escape') { row.classList.remove('editing'); renderLibList(); }
  });
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (row.classList.contains('editing') && document.activeElement !== input) {
        row.classList.remove('editing');
        renderLibList();
      }
    }, 150);
  });
}

function pickLibCover(path: string) {
  if (!coverPicker) {
    coverPicker = document.createElement('input');
    coverPicker.type = 'file';
    coverPicker.accept = 'image/webp,image/jpeg,image/png';
    coverPicker.style.display = 'none';
    document.body.appendChild(coverPicker);
  }
  coverPicker.onchange = () => {
    const file = coverPicker!.files?.[0];
    coverPicker!.value = '';
    if (!file) return;
    if (file.size > MAX_COVER_BYTES) {
      setStatus($('libStatus'), '✗ cover image too large (max 1.5 MB)', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      setStatus($('libStatus'), 'Uploading cover — queueing workflow…');
      try {
        const res = await adminApi<{ target?: string }>('bucketCover', { path, data: reader.result });
        setStatus($('libStatus'), `✓ cover upload started → ${res.target} — new art appears in about a minute`, 'ok');
        toast('Cover upload started', 'ok');
      } catch (e) {
        setStatus($('libStatus'), '✗ ' + ((e as Error).message || 'cover upload failed'), 'err');
      }
    };
    reader.readAsDataURL(file);
  };
  coverPicker.click();
}

async function deleteLibTrack(path: string): Promise<void> {
  const stem = path.replace(/\.[^.]+$/, '');
  if (!window.confirm(`Delete “${stem}” from the bucket?\n\nThe track AND its cover art will be removed.`)) return;
  setStatus($('libStatus'), 'Deleting…');
  try {
    const res = await adminApi<{ deleted?: string[] }>('bucketDelete', { path });
    setStatus($('libStatus'), `✓ deleted ${res.deleted?.length || 1} file(s)`, 'ok');
    toast('Deleted from the bucket', 'ok');
    await Promise.all([loadLibraryManager(false), refreshLibrary(true)]);
  } catch (e) {
    setStatus($('libStatus'), '✗ ' + ((e as Error).message || 'delete failed'), 'err');
  }
}

/* ---------- runs: list + expandable live job/step progress ---------- */
interface Run {
  id: number; status: string; conclusion: string | null;
  created_at: string; html_url: string; display_title: string;
}
interface RunStep { number: number; name: string; status: string; conclusion: string | null; }
interface RunJob {
  id: number; name: string; status: string; conclusion: string | null;
  started_at: string | null; completed_at: string | null; steps: RunStep[];
}

let expandedRunId: number | null = null;
let jobsCache: Record<number, RunJob[]> = {};
let runsActive = false;
let runsTimer: number | undefined;

function stepIcon(s: RunStep): string {
  if (s.status === 'completed') {
    if (s.conclusion === 'success') return '✓';
    if (s.conclusion === 'skipped') return '·';
    return '✗';
  }
  if (s.status === 'in_progress') return '⟳';
  return '·';
}

function renderRunJobs(runId: number, jobs: RunJob[]) {
  const host = document.getElementById('rundetail-' + runId);
  if (!host) return;
  if (!jobs.length) {
    host.innerHTML = '<span class="adm-chip dim">job not started yet…</span>';
    return;
  }
  const wrap = document.createElement('div');
  for (const job of jobs) {
    const block = document.createElement('div');
    block.className = 'adm-job';
    const done = job.steps.filter((s) => s.status === 'completed').length;
    const head = document.createElement('div');
    head.className = 'adm-job-head';
    head.innerHTML =
      '<span class="adm-job-name"></span>' +
      `<span class="adm-job-count">${done}/${job.steps.length} steps · ${job.conclusion || job.status}</span>`;
    head.querySelector('.adm-job-name')!.textContent = job.name;
    block.appendChild(head);
    for (const s of job.steps) {
      const row = document.createElement('div');
      row.className = 'adm-step' + (s.status === 'in_progress' ? ' running' : '');
      row.innerHTML = `<span class="ic">${stepIcon(s)}</span><span class="nm"></span>`;
      row.querySelector('.nm')!.textContent = s.name;
      block.appendChild(row);
    }
    wrap.appendChild(block);
  }
  host.innerHTML = '';
  host.appendChild(wrap);
}

async function refreshRunJobs(runId: number): Promise<void> {
  try {
    const data = await adminApi<{ jobs: RunJob[] }>('runJobs', { run_id: runId });
    jobsCache[runId] = data.jobs || [];
    renderRunJobs(runId, jobsCache[runId]);
  } catch (e) {
    const host = document.getElementById('rundetail-' + runId);
    if (host) host.innerHTML = `<span class="adm-chip dim">could not load steps — ${(e as Error).message}</span>`;
  }
}

function toggleRunDetail(runId: number) {
  const wasOpen = expandedRunId === runId;
  expandedRunId = wasOpen ? null : runId;
  runsList.querySelectorAll('.adm-run-detail').forEach((el) => {
    el.hidden = el.id !== 'rundetail-' + (expandedRunId ?? -1);
  });
  runsList.querySelectorAll('.adm-run').forEach((el) => {
    el.classList.toggle('open', Number(el.getAttribute('data-run')) === expandedRunId);
  });
  if (!wasOpen) {
    renderRunJobs(runId, jobsCache[runId] || []);
    void refreshRunJobs(runId);
  }
  scheduleRunsPoll();
}

async function refreshRuns() {
  if (!getSession()) return;
  try {
    const data = await adminApi<{ runs: Run[] }>('runs');
    const runs = data.runs || [];
    runsActive = runs.some((r) => r.status === 'in_progress' || r.status === 'queued');
    if (!runs.length) {
      runsList.innerHTML = '<span class="adm-chip dim">no runs yet — start a download above</span>';
      return;
    }
    runsList.innerHTML = '';
    for (const run of runs) {
      const item = document.createElement('div');
      item.className = 'adm-run-item';
      const row = document.createElement('div');
      row.className = 'adm-run';
      row.setAttribute('data-run', String(run.id));
      const when = new Date(run.created_at).toLocaleString();
      const label = run.conclusion || run.status;
      row.innerHTML =
        `<span class="chev"></span>` +
        `<span class="dot ${label}"></span>` +
        `<span class="title"></span>` +
        `<span class="meta">${label} · ${when}</span>` +
        `<a href="${run.html_url}" target="_blank" rel="noopener">logs</a>`;
      row.querySelector('.title')!.textContent = run.display_title;
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        toggleRunDetail(run.id);
      });
      const detail = document.createElement('div');
      detail.className = 'adm-run-detail';
      detail.id = 'rundetail-' + run.id;
      detail.hidden = expandedRunId !== run.id;
      if (!detail.hidden) renderRunJobs(run.id, jobsCache[run.id] || []);
      item.appendChild(row);
      item.appendChild(detail);
      runsList.appendChild(item);
    }
  } catch {
    runsActive = false;
    runsList.innerHTML = '<span class="adm-chip dim">could not load runs</span>';
  }
}

/* Poll aggressively (3s) while anything is running or a run is expanded,
   otherwise back off to 10s — always self-scheduling so nothing stacks. */
function scheduleRunsPoll() {
  window.clearTimeout(runsTimer);
  const fast = runsActive || expandedRunId !== null;
  runsTimer = window.setTimeout(tickRuns, fast ? 3000 : 10000);
}

async function tickRuns() {
  try {
    if (document.visibilityState === 'visible' && getSession()) {
      await refreshRuns();
      if (expandedRunId !== null) await refreshRunJobs(expandedRunId);
    }
  } catch { /* transient */ }
  scheduleRunsPoll();
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
    const pending = queue.filter((i) => !inLibrary(i.id));
    const urls = pending.map((i) => i.url);
    if (!urls.length) {
      setStatus(
        downloadStatus,
        queue.length ? 'Every queued track is already in your library.' : 'Queue is empty — search for a song or paste a link first.',
        'err',
      );
      return;
    }
    btn.disabled = true;
    setStatus(downloadStatus, 'Starting GitHub Actions run…');
    try {
      const batches: string[][] = [];
      for (let i = 0; i < urls.length; i += MAX_PER_RUN) batches.push(urls.slice(i, i + MAX_PER_RUN));
      /* Clean names/albums for manifest.json — YT Music sub lines carry
         "Artist • Album • 6:10"; paste rows only carry the title. */
      const metaOf = (item: QueueItem) => {
        const segs = item.sub.split('•').map((s) => s.trim()).filter(Boolean);
        const artist = segs[0] ? cleanArtist(segs[0].split(',')[0]) : '';
        return {
          id: item.id,
          title: cleanTitle(item.title || ''),
          artist: artist === 'Unknown Artist' ? '' : artist,
          album: segs[1] || '',
        };
      };
      let totalDispatched = 0;
      let totalSkipped = 0;
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const batchItems = pending.filter((i) => batch.some((u) => u === i.url));
        const res = await adminApi<{ dispatched?: number; skipped?: number }>('dispatch', {
          urls: batch,
          meta: batchItems.map(metaOf),
        });
        totalDispatched += res.dispatched || 0;
        totalSkipped += res.skipped || 0;
      }
      queue = queue.filter((i) => !pending.some((p) => p.id === i.id));
      saveQueue();
      renderQueue();
      syncResultRows();
      void refreshLibrary(true);
      const runsNote = batches.length > 1 && totalDispatched ? ` across ${batches.length} runs` : '';
      const skipNote = totalSkipped ? ` · ${totalSkipped} already in library` : '';
      setStatus(
        downloadStatus,
        totalDispatched
          ? `✓ ${totalDispatched} track${totalDispatched === 1 ? '' : 's'} dispatched${runsNote}${skipNote} — watch ${totalDispatched === 1 ? 'it' : 'them'} below.`
          : `Nothing new to dispatch${skipNote}.`,
        'ok',
      );
      if (totalDispatched) toast('Download started on GitHub Actions', 'ok');
      setTimeout(refreshRuns, 2500);
    } catch (e) {
      setStatus(downloadStatus, '✗ ' + (e as Error).message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('runsRefreshBtn').addEventListener('click', () => {
    refreshRuns();
    if (expandedRunId !== null) void refreshRunJobs(expandedRunId);
  });

  $('libRefreshBtn').addEventListener('click', () => loadLibraryManager(true));

  scheduleRunsPoll(); // replaces a fixed interval: 3s while active/expanded, else 10s
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
