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
  void loadLibraryManager(); // bucket file list + Library tab badge
  switchTab('panelAdd');
}

function lock(msg?: string) {
  $('sessionBar').hidden = true;
  gatedSections.forEach((s) => { s.hidden = true; });
  ['panelAdd', 'panelLibrary', 'panelSettings'].forEach((id) => { $(id).hidden = true; });
  gBtnBox.innerHTML = '';
  gateCard.hidden = false;
  renderGisButton();
  if (msg) setStatus(gateStatus, msg, 'err');
}

/* ---------- top-level tabs ---------- */
function switchTab(panelId: string): void {
  document.querySelectorAll<HTMLElement>('.adm-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.panel === panelId);
  });
  for (const id of ['panelAdd', 'panelLibrary', 'panelSettings']) $(id).hidden = id !== panelId;
  if (panelId === 'panelLibrary') void loadLibraryManager();
  if (panelId === 'panelSettings') ($('configCard') as HTMLDetailsElement).open = true;
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
const MAX_PER_RUN = 25; // server-side dispatch cap

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
      const data = await adminApi<LibraryResponse>('library');
      libraryIdSet = new Set((data.videoIds || []).filter(Boolean));
      libraryLoaded = true;
      libLoadError = '';
      ingestLibraryData(data);
      syncResultRows();
      renderQueue();
      if (!$('panelLibrary').hidden) renderLibGrid();
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
/* People paste playlist links straight into the search box, which used to run
   them as a *text search* — YouTube then returned whatever vaguely matched the
   URL string. Detect link-shaped input and expand it instead. */
const LINK_LIKE_RE = /^(https?:\/\/|www\.)?(music\.|www\.)?(youtube\.com|youtu\.be)\//i;
const videoIdOf = (raw: string): string => /[?&]v=([A-Za-z0-9_-]{11})/.exec(raw)?.[1] || '';
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
    const data = await adminApi<{
      type: string; title: string; tracks: SearchResult[]; truncated?: boolean; viaArtist?: string; dupes?: number; junk?: number;
    }>('expand', { url });
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
    const total = (data.tracks || []).length;
    /* a channel uploads link expands to the artist's whole catalogue */
    const kind = data.type === 'album' ? 'Album' : data.type === 'artist' ? 'Artist' : 'Playlist';
    const extras = [
      data.viaArtist && data.type === 'artist' ? '' : '',
      data.dupes ? ` · ${data.dupes} duplicate versions merged` : '',
      data.junk ? ` · ${data.junk} non-song clips skipped` : '',
      data.truncated ? ` · showing first ${total}` : '',
      skipped ? ` · ${skipped} already queued/library` : '',
    ].filter(Boolean).join('');
    setStatus(
      searchStatus,
      `${kind} “${data.title}” — ${total} track${total === 1 ? '' : 's'} found, ${added} queued${extras}`,
      'ok',
    );
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

/* "+ all by artist" — crawls the artist's own channel uploads, so a 150-track
   artist no longer stops at the ~20 rows a search page returns. Falls back to
   filtering search results if the channel lookup finds nothing. */
const ARTIST_MAX = 500;
let artistBusy = false;

interface ArtistTrack {
  videoId: string;
  title: string;
  sub: string;
  thumbnail: string | null;
}

async function queueArtist(artist: string, mode: 'music' | 'video'): Promise<void> {
  const q = (artist || '').replace(/\s*-\s*Topic$/i, '').trim();
  if (!q) return;
  if (artistBusy) {
    toast('Artist lookup already running', '');
    return;
  }
  artistBusy = true;
  setStatus(searchStatus, `Finding every track by ${q}…`);
  try {
    let tracks: ArtistTrack[] = [];
    let truncated = false;
    let dupes = 0;
    let junkCount = 0;
    let channelNames: string[] = [];
    try {
      const data = await adminApi<{
        tracks?: ArtistTrack[];
        truncated?: boolean;
        dupes?: number;
        junk?: number;
        channels?: string[];
      }>('artist', { q });
      tracks = data.tracks || [];
      truncated = !!data.truncated;
      dupes = data.dupes || 0;
      junkCount = data.junk || 0;
      channelNames = (data.channels || []).slice(0, 2);
    } catch {
      /* channel crawl unavailable — fall through to search-based matching */
    }

    if (!tracks.length) {
      const data = await adminApi<{ results: SearchResult[] }>('search', { q, mode });
      const norm = normalizeArtist(q);
      tracks = (data.results || []).filter((r) => artistOf(r.sub, mode) === norm);
    }

    let added = 0;
    let skipped = 0;
    for (const t of tracks.slice(0, ARTIST_MAX)) {
      if (queueHas(t.videoId) || inLibrary(t.videoId)) {
        skipped++;
        continue;
      }
      const url = `https://music.youtube.com/watch?v=${t.videoId}`;
      if (addToQueue({ id: t.videoId, url, title: t.title, sub: t.sub, thumb: t.thumbnail || '', source: 'search' }, true)) {
        added++;
      }
    }
    renderQueue();
    if (!tracks.length) {
      setStatus(searchStatus, `No tracks found for “${q}”`, 'err');
      toast('No matching tracks found', 'err');
    } else {
      const capNote =
        truncated || tracks.length > ARTIST_MAX ? ` (first ${ARTIST_MAX} of many)` : '';
      const dupNote = dupes ? ` · ${dupes} duplicate versions merged` : '';
      const junkNote = junkCount ? ` · ${junkCount} non-song clips skipped` : '';
      const srcNote = channelNames.length ? ` from ${channelNames.join(' + ')}` : '';
      const note = skipped ? ` · ${skipped} already queued/library` : '';
      setStatus(
        searchStatus,
        `${tracks.length} track${tracks.length === 1 ? '' : 's'} found${srcNote} — ${added} queued${capNote}${dupNote}${junkNote}${note}`,
        'ok',
      );
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
  /* a pasted playlist/album link is not a search query */
  if (LINK_LIKE_RE.test(q)) {
    searchResults.innerHTML = '';
    lastResults = [];
    if (videoIdOf(q)) {
      /* a single watch link: queue it like the paste box does */
      urlsInput.value = urlsInput.value.trim() ? `${urlsInput.value.trim()}\n${q}` : q;
      setStatus(searchStatus, 'Link added to the paste box — it joins the queue.');
      searchInput.value = '';
      ingestPasted();
      return;
    }
    if (PLAYLIST_RE.test(q)) {
      searchInput.value = '';
      void expandPlaylist(q);
      return;
    }
    setStatus(searchStatus, '✗ that link has no video or playlist ID in it', 'err');
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

/* ---------- library tab: searchable grid browser over the bucket ----------
   Rename/delete are direct HF batch mutations (instant); cover art and
   manifest metadata edits stage a file in the repo and ride
   manage-music.yml (~1 min). */
const AUDIO_FILE_RE = /\.(opus|mp3|ogg|m4a|webm)$/i;
const IMG_FILE_RE = /\.(jpe?g|png|webp|gif)$/i;
const MAX_COVER_BYTES = 1.5 * 1024 * 1024;
const VID_SUFFIX_RE = / \[([A-Za-z0-9_-]{11})\]$/;
const VID_RE = /^[A-Za-z0-9_-]{11}$/;

interface LibFile { path: string; size: number; mtime?: string }
interface LibMeta { t?: string; a?: string; al?: string; y?: string; d?: number }
interface LibraryResponse {
  files?: LibFile[];
  videoIds?: string[];
  bucketId?: string;
  manifest?: Record<string, LibMeta>;
}
interface LibEntry {
  path: string; stem: string; ext: string; vid: string;
  size: number; mtime: string;
  title: string; artist: string; album: string; year: string; duration: number;
  coverUrl: string;
}

let libFiles: LibFile[] = [];
let libCovers = new Map<string, string>(); // audio stem -> cover path
let libManifest: Record<string, LibMeta> = {};
let libBucketId = '';
let libLoadError = '';
let libFilter = 'all';
let libSortMode = 'title';
let libQuery = '';
let libSelectMode = false;
let libSelected = new Set<string>();
let coverPicker: HTMLInputElement | null = null;

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function hfLibUrl(path: string): string {
  return 'https://huggingface.co/buckets/' + libBucketId + '/resolve/' + path.split('/').map(encodeURIComponent).join('/');
}

function ingestLibraryData(data: LibraryResponse): void {
  if (data.bucketId) libBucketId = data.bucketId;
  if (data.manifest) libManifest = data.manifest;
  const files = Array.isArray(data.files) ? data.files : [];
  libFiles = files.filter((f) => f && AUDIO_FILE_RE.test(f.path));
  libCovers = new Map();
  for (const f of files) {
    if (f && IMG_FILE_RE.test(f.path)) libCovers.set(f.path.replace(/\.[^.]+$/, ''), f.path);
  }
}

function buildLibEntries(): LibEntry[] {
  return libFiles.map((f) => {
    const stem = f.path.replace(/\.[^.]+$/, '');
    const ext = f.path.slice(stem.length);
    const vidM = VID_SUFFIX_RE.exec(stem);
    const vid = vidM ? vidM[1] : '';
    const base = stem.replace(VID_SUFFIX_RE, '');
    const fm = /^(.+?)\s+-\s+(.+)$/.exec(base);
    let artist = fm ? fm[1].trim() : '';
    let title = fm ? fm[2].trim() : base;
    let album = '', year = '', duration = 0;
    const m = vid ? libManifest[vid] : undefined;
    if (m) {
      if (m.t) title = m.t;
      if (m.a) artist = m.a;
      if (m.al) album = m.al;
      if (m.y) year = String(m.y);
      if (typeof m.d === 'number') duration = m.d;
    }
    const coverPath = libCovers.get(stem);
    return {
      path: f.path, stem, ext, vid,
      size: Number(f.size) || 0, mtime: f.mtime || '',
      title, artist, album, year, duration,
      coverUrl: coverPath ? hfLibUrl(coverPath) : '',
    };
  });
}

function libVisibleEntries(): LibEntry[] {
  let list = buildLibEntries();
  if (libFilter === 'nocover') list = list.filter((e) => !e.coverUrl);
  else if (libFilter === 'noid') list = list.filter((e) => !e.vid);
  const q = libQuery.toLowerCase();
  if (q) {
    list = list.filter((e) =>
      e.title.toLowerCase().includes(q) ||
      e.artist.toLowerCase().includes(q) ||
      e.album.toLowerCase().includes(q) ||
      e.stem.toLowerCase().includes(q) ||
      (e.vid && e.vid.toLowerCase().includes(q)),
    );
  }
  const cmp: Record<string, (a: LibEntry, b: LibEntry) => number> = {
    title: (a, b) => a.title.localeCompare(b.title),
    titleDesc: (a, b) => b.title.localeCompare(a.title),
    artist: (a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title),
    newest: (a, b) => (b.mtime || '').localeCompare(a.mtime || ''),
    oldest: (a, b) => (a.mtime || '').localeCompare(b.mtime || ''),
    largest: (a, b) => b.size - a.size,
  };
  return list.sort(cmp[libSortMode] || cmp.title);
}

function libCardHTML(e: LibEntry): string {
  const selected = libSelected.has(e.path);
  const thumb = e.coverUrl
    ? `<img src="${escHtml(e.coverUrl)}" alt="" loading="lazy" decoding="async">`
    : '<span class="adm-lcard-note" aria-hidden="true">♪</span>';
  const dur = e.duration ? `<span class="adm-lcard-dur">${fmtDur(e.duration)}</span>` : '';
  const check = libSelectMode
    ? `<span class="adm-lcard-check${selected ? ' on' : ''}" aria-hidden="true">${selected ? '✓' : ''}</span>`
    : '';
  const vid = e.vid ? `<span class="adm-lcard-vid" title="Video ID ${escHtml(e.vid)}">${escHtml(e.vid)}</span>` : '';
  return `<div class="adm-lcard${selected ? ' selected' : ''}" data-path="${escHtml(e.path)}" tabindex="0">
    <div class="adm-lcard-thumb">
      ${thumb}
      ${dur}
      ${check}
      <div class="adm-lcard-acts">
        <button type="button" data-a="ren" title="Rename &amp; edit metadata" aria-label="Rename">✎</button>
        <button type="button" data-a="cov" title="Replace cover art" aria-label="Cover">🖼</button>
        <button type="button" data-a="del" title="Delete track and cover" aria-label="Delete">🗑</button>
      </div>
    </div>
    <div class="adm-lcard-title" title="${escHtml(e.title)}">${escHtml(e.title)}</div>
    <div class="adm-lcard-sub">${escHtml(e.artist || 'Unknown artist')} · ${fmtSize(e.size)}</div>
    ${vid}
  </div>`;
}

function renderLibGrid(): void {
  const grid = $('libGrid');
  const all = buildLibEntries();
  const shown = libVisibleEntries();

  const counts = {
    all: all.length,
    nocover: all.filter((e) => !e.coverUrl).length,
    noid: all.filter((e) => !e.vid).length,
  };
  $('libFilters').querySelectorAll<HTMLElement>('button').forEach((b) => {
    const el = b.querySelector('b');
    if (el) el.textContent = String(counts[(b.dataset.f || 'all') as keyof typeof counts] ?? 0);
  });

  const bytes = shown.reduce((n, e) => n + e.size, 0);
  const covers = all.filter((e) => e.coverUrl).length;
  $('libStats').textContent = all.length
    ? `${shown.length === all.length ? all.length : shown.length + ' of ' + all.length} tracks · ${fmtSize(bytes)}${shown.length === all.length ? ` · ${covers} with cover art` : ''}`
    : '';
  $('libHeadSub').textContent = all.length ? `${all.length} tracks` : '';
  const badge = $('libTabCount');
  badge.hidden = !all.length;
  badge.textContent = String(all.length);

  if (libLoadError) {
    grid.innerHTML = '<span class="adm-chip dim">could not load the bucket</span>';
    return;
  }
  if (!all.length) {
    grid.innerHTML = '<span class="adm-chip dim">the bucket is empty — queue something above</span>';
    return;
  }
  if (!shown.length) {
    grid.innerHTML = '<span class="adm-chip dim">no tracks match this filter</span>';
    return;
  }
  grid.innerHTML = shown.map(libCardHTML).join('');
}

async function loadLibraryManager(force = false): Promise<void> {
  const statusEl = $('libStatus');
  if (force) setStatus(statusEl, 'Loading bucket…');
  try {
    const data = await adminApi<LibraryResponse>('library');
    libLoadError = '';
    ingestLibraryData(data);
    renderLibGrid();
    if (force) setStatus(statusEl, `${libFiles.length} tracks in the bucket`, 'ok');
  } catch (e) {
    libLoadError = (e as Error).message || 'load failed';
    renderLibGrid();
    setStatus(statusEl, '✗ ' + libLoadError, 'err');
  }
}

/* ---------- selection mode + bulk delete ---------- */
function updateSelectUI(): void {
  $('libSelectBtn').textContent = libSelectMode ? 'Done' : 'Select';
  $('libGrid').classList.toggle('selectmode', libSelectMode);
  const bar = $<HTMLElement>('libBulkBar');
  bar.hidden = !libSelectMode || libSelected.size === 0;
  $('libBulkCount').textContent = `${libSelected.size} selected`;
}

function toggleLibSelect(path: string): void {
  if (libSelected.has(path)) libSelected.delete(path);
  else libSelected.add(path);
  updateSelectUI();
  renderLibGrid();
}

/* ---------- modal host ---------- */
const modalHost = $('modalHost');
const modalCard = $('modalCard');

function openModal(html: string): void {
  modalCard.innerHTML = html;
  modalHost.hidden = false;
}
function closeModal(): void {
  modalHost.hidden = true;
  modalCard.innerHTML = '';
}
modalHost.addEventListener('click', (e) => { if (e.target === modalHost) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalHost.hidden) closeModal(); });

/* GitHub's runs list is the only handle we have on a just-dispatched run:
   the dispatch API returns 204 with no body, so look for the newest run. */
let lastKnownRunId = 0;




function confirmRuns(tracks: number, runs: number): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(`
      <h3 class="adm-modal-title">Start ${tracks} downloads?</h3>
      <p class="adm-modal-sub dim">That's ${runs} GitHub Actions runs (max ${MAX_PER_RUN} tracks each) — roughly
      ${Math.max(1, Math.round(runs * 1.5))}–${runs * 3} minutes. Tracks already in your library are skipped.</p>
      <div class="adm-modal-actions">
        <button type="button" class="adm-btn ghost" id="mrfCancel">Cancel</button>
        <button type="button" class="adm-btn primary" id="mrfGo">Start ${runs} runs</button>
      </div>`);
    const done = (v: boolean) => {
      closeModal();
      resolve(v);
    };
    $('mrfCancel').addEventListener('click', () => done(false));
    $('mrfGo').addEventListener('click', () => done(true));
    modalHost.addEventListener('click', (e) => { if (e.target === modalHost) done(false); }, { once: true });
    $('mrfGo').focus();
  });
}

const safeName = (s: string): string =>
  s.replace(/[\\/:*?"<>|\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();

/* ---------- rename / metadata edit ---------- */
function openRenameModal(path: string): void {
  const entry = buildLibEntries().find((e) => e.path === path);
  if (!entry) return;
  const thumb = entry.coverUrl
    ? `<img src="${escHtml(entry.coverUrl)}" alt="">`
    : '<span class="adm-lcard-note">♪</span>';
  const albumHint = entry.vid
    ? 'shows on the site'
    : 'needs a video ID — not available for this file';
  openModal(`
    <div class="adm-modal-head">
      <div class="adm-modal-thumb">${thumb}</div>
      <div>
        <h3 class="adm-modal-title">Edit track</h3>
        <p class="adm-modal-sub">Rename moves the audio + cover together; title/artist/album also sync to the site via manifest.json.</p>
      </div>
    </div>
    <label class="adm-label" for="mfnTitle">Title</label>
    <input class="adm-input" id="mfnTitle" type="text" spellcheck="false" maxlength="180">
    <label class="adm-label" for="mfnArtist">Artist</label>
    <input class="adm-input" id="mfnArtist" type="text" spellcheck="false" maxlength="180" placeholder="Unknown artist">
    <label class="adm-label" for="mfnAlbum">Album <span class="adm-modal-hint">${albumHint}</span></label>
    <input class="adm-input" id="mfnAlbum" type="text" spellcheck="false" maxlength="180" ${entry.vid ? '' : 'disabled'} placeholder="—">
    <div class="adm-modal-file">file: <code id="mfnPreview"></code></div>
    <div class="adm-status" id="mfnStatus"></div>
    <div class="adm-modal-actions">
      <button type="button" class="adm-btn ghost" id="mfnCancel">Cancel</button>
      <button type="button" class="adm-btn primary" id="mfnSave">Save</button>
    </div>`);

  const titleInput = $<HTMLInputElement>('mfnTitle');
  const artistInput = $<HTMLInputElement>('mfnArtist');
  const albumInput = $<HTMLInputElement>('mfnAlbum');
  const preview = $('mfnPreview');
  titleInput.value = entry.title;
  artistInput.value = entry.artist;
  albumInput.value = entry.album;

  const newStem = (): string => {
    const t = safeName(titleInput.value) || 'Untitled';
    const a = safeName(artistInput.value);
    return (a ? a + ' - ' : '') + t + (entry.vid ? ' [' + entry.vid + ']' : '');
  };
  const showPreview = () => { preview.textContent = newStem() + entry.ext; };
  titleInput.addEventListener('input', showPreview);
  artistInput.addEventListener('input', showPreview);
  showPreview();
  titleInput.focus();
  titleInput.select();

  $('mfnCancel').addEventListener('click', closeModal);
  $('mfnSave').addEventListener('click', async () => {
    const statusEl = $('mfnStatus');
    const title = safeName(titleInput.value) || 'Untitled';
    const artist = safeName(artistInput.value);
    const album = albumInput.disabled ? entry.album : safeName(albumInput.value);
    const to = newStem() + entry.ext;
    const btn = $('mfnSave') as HTMLButtonElement;
    btn.disabled = true;
    try {
      let renamed = false;
      if (to !== entry.path) {
        setStatus(statusEl, 'Renaming in the bucket…');
        await adminApi('bucketRename', { from: entry.path, to });
        renamed = true;
      }
      const metaChanged = title !== entry.title || artist !== entry.artist || album !== entry.album;
      let synced = false;
      if (entry.vid && metaChanged) {
        setStatus(statusEl, 'Syncing metadata to the site…');
        try {
          await adminApi('bucketManifestSet', { id: entry.vid, title, artist, album });
          synced = true;
        } catch (e) {
          if (!/not in manifest/i.test((e as Error).message)) throw e;
        }
      }
      closeModal();
      if (renamed) toast(synced ? 'Renamed — metadata sync queued' : 'Track renamed', 'ok');
      else if (synced) toast('Metadata sync queued — live in about a minute', 'ok');
      else { closeModal(); return; }
      await loadLibraryManager(true);
      await refreshLibrary(true);
    } catch (e) {
      setStatus(statusEl, '✗ ' + ((e as Error).message || 'save failed'), 'err');
      btn.disabled = false;
    }
  });
}

/* ---------- delete (single or bulk) ---------- */
function openDeleteModal(paths: string[]): void {
  if (!paths.length) return;
  const names = paths.map((p) => p.replace(/\.[^.]+$/, '').replace(VID_SUFFIX_RE, ''));
  const body = paths.length === 1
    ? `Delete <b>${escHtml(names[0])}</b> from the bucket?`
    : `Delete <b>${paths.length} tracks</b> from the bucket?`;
  const sub = paths.length === 1
    ? 'The audio file AND its cover art will be removed.'
    : 'Each track’s audio file and cover art will be removed.';
  openModal(`
    <h3 class="adm-modal-title danger">Delete from library</h3>
    <p class="adm-modal-sub">${body}</p>
    <p class="adm-modal-sub dim">${sub}</p>
    ${paths.length > 1 ? `<ul class="adm-modal-list">${names.slice(0, 8).map((n) => `<li>${escHtml(n)}</li>`).join('')}${names.length > 8 ? `<li>…and ${names.length - 8} more</li>` : ''}</ul>` : ''}
    <div class="adm-status" id="mfdStatus"></div>
    <div class="adm-modal-actions">
      <button type="button" class="adm-btn ghost" id="mfdCancel">Cancel</button>
      <button type="button" class="adm-btn danger" id="mfdConfirm">${paths.length === 1 ? 'Delete' : `Delete ${paths.length} tracks`}</button>
    </div>`);
  $('mfdCancel').addEventListener('click', closeModal);
  $('mfdConfirm').addEventListener('click', async () => {
    const statusEl = $('mfdStatus');
    const btn = $('mfdConfirm') as HTMLButtonElement;
    btn.disabled = true;
    let done = 0;
    try {
      for (const p of paths) {
        setStatus(statusEl, `Deleting ${done + 1}/${paths.length}…`);
        await adminApi('bucketDelete', { path: p });
        done++;
      }
      closeModal();
      toast(paths.length === 1 ? 'Deleted from the bucket' : `Deleted ${done} tracks`, 'ok');
      libSelected.clear();
      updateSelectUI();
      await loadLibraryManager(true);
      await refreshLibrary(true);
    } catch (e) {
      setStatus(statusEl, `✗ ${done}/${paths.length} deleted — ` + ((e as Error).message || 'failed'), 'err');
      btn.disabled = false;
      if (done) { await loadLibraryManager(true); await refreshLibrary(true); }
    }
  });
}

/* ---------- cover art ---------- */
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
      if (LINK_LIKE_RE.test(searchInput.value.trim())) { void runSearch(); return; }
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
    /* A whole-artist queue fans out into many GitHub runs — make that an
       explicit choice instead of one stray click firing dozens of them. */
    const runCount = Math.ceil(urls.length / MAX_PER_RUN);
    if (runCount > 3) {
      const ok = await confirmRuns(urls.length, runCount);
      if (!ok) {
        setStatus(downloadStatus, 'Dispatch cancelled — queue kept as-is.', '');
        return;
      }
    }
    btn.disabled = true;
    setStatus(downloadStatus, 'Starting GitHub Actions run…');
    try {
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
      /* One dispatch, whole queue: the run hands its leftovers to the next
         run when it finishes, so nothing depends on this tab staying open. */
      const res = await adminApi<{
        dispatched?: number; chained?: number; runs?: number; skipped?: number; skippedUploaded?: number;
      }>('dispatch', { urls, meta: pending.map(metaOf) });
      const totalDispatched = res.dispatched || 0;
      const totalSkipped = (res.skipped || 0) + (res.skippedUploaded || 0);
      queue = queue.filter((i) => !pending.some((p) => p.id === i.id));
      saveQueue();
      renderQueue();
      syncResultRows();
      void refreshLibrary(true);
      const runCount = res.runs || 1;
      const skipNote = totalSkipped ? ` · ${totalSkipped} already in library` : '';
      const chainNote =
        runCount > 1
          ? ` — chained across ${runCount} runs that queue themselves, so you can close this tab`
          : '';
      setStatus(
        downloadStatus,
        totalDispatched
          ? `✓ ${totalDispatched} track${totalDispatched === 1 ? '' : 's'} downloading${chainNote}${skipNote} — watch progress below.`
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

  /* tabs */
  $('admTabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.adm-tab');
    if (btn?.dataset.panel) switchTab(btn.dataset.panel);
  });

  /* library browser controls */
  $('libSearchInput').addEventListener('input', () => {
    libQuery = ($('libSearchInput') as HTMLInputElement).value.trim();
    renderLibGrid();
  });
  $('libSort').addEventListener('change', () => {
    libSortMode = ($('libSort') as HTMLSelectElement).value;
    renderLibGrid();
  });
  $('libFilters').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.libf');
    if (!chip) return;
    libFilter = chip.dataset.f || 'all';
    $('libFilters').querySelectorAll<HTMLElement>('.libf').forEach((c) => c.classList.toggle('active', c === chip));
    renderLibGrid();
  });
  $('libSelectBtn').addEventListener('click', () => {
    libSelectMode = !libSelectMode;
    libSelected.clear();
    updateSelectUI();
    renderLibGrid();
  });
  $('libBulkCancel').addEventListener('click', () => {
    libSelectMode = false;
    libSelected.clear();
    updateSelectUI();
    renderLibGrid();
  });
  $('libBulkDelete').addEventListener('click', () => openDeleteModal([...libSelected]));
  $('libGrid').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>('.adm-lcard');
    if (!card?.dataset.path) return;
    const path = card.dataset.path;
    if (libSelectMode) { toggleLibSelect(path); return; }
    const act = (t.closest<HTMLElement>('[data-a]'))?.dataset.a;
    if (act === 'ren') openRenameModal(path);
    else if (act === 'cov') pickLibCover(path);
    else if (act === 'del') openDeleteModal([path]);
  });

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
