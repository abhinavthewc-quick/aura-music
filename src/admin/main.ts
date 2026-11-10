import './admin.css';
import { ADMIN_EMAILS, GOOGLE_CLIENT_ID } from '../core/config';
import { cleanArtist, cleanTitle, cacheArtistDirectory, fetchArtistDirectory, getCachedArtistDirectory, ArtistMeta, type ArtistDirectory } from '../core/catalog';
import { artistTrackId, normalizeArtistKey } from '../../lib/artistProfiles';
import { verifyGoogleCredential } from '../core/google-auth';
import { clearSession, exchangeGoogleToken, getSession, setSession } from '../core/session';

const SECRET_NAMES = ['HF_TOKEN', 'HF_BUCKET_ID', 'YOUTUBE_COOKIES'] as const;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('missing #' + id);
    return document.createElement('div') as unknown as T;
  }
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
      body: JSON.stringify({ ...payload, credential: session.token, action }),
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
  void loadArtistsManager(); // artist list + Artists tab badge
  void loadDiscordOverview(true); // Discord tab badge + gateway status
  switchTab('panelAdd');
}

function lock(msg?: string) {
  $('sessionBar').hidden = true;
  gatedSections.forEach((s) => { s.hidden = true; });
  ['panelAdd', 'panelLibrary', 'panelArtists', 'panelDiscord', 'panelSettings'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
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
  for (const id of ['panelAdd', 'panelLibrary', 'panelArtists', 'panelDiscord', 'panelSettings']) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== panelId;
  }
  if (panelId === 'panelLibrary') void loadLibraryManager();
  if (panelId === 'panelArtists') void loadArtistsManager();
  if (panelId === 'panelDiscord') void initDiscord();
  if (panelId === 'panelSettings') {
    const cfg = document.getElementById('configCard') as HTMLDetailsElement | null;
    if (cfg) cfg.open = true;
  }
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
      // Notify other tabs (like open rooms) that the catalogue has changed.
      new BroadcastChannel('aura-catalog').postMessage({ t: 'refresh', at: Date.now() });
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
interface LibMeta { t?: string; a?: string; al?: string; y?: string; d?: number; g?: string }
interface LibraryResponse {
  files?: LibFile[];
  videoIds?: string[];
  bucketId?: string;
  manifest?: Record<string, LibMeta>;
  artists?: Record<string, ArtistMeta>;
  trackArtists?: Record<string, string>;
  revision?: number;
}
interface LibEntry {
  path: string; stem: string; ext: string; vid: string;
  size: number; mtime: string;
  title: string; artist: string; album: string; year: string; duration: number; genre?: string;
  coverUrl: string;
}

let libFiles: LibFile[] = [];
let libCovers = new Map<string, string>(); // audio stem -> cover path
let libManifest: Record<string, LibMeta> = {};
let libArtists: Record<string, ArtistMeta> = {};
let libTrackArtists: Record<string, string> = {};
let libArtistRevision = -1;

function ingestArtistDirectory(data: Partial<ArtistDirectory>): void {
  if (!data.artists || !data.trackArtists || !Number.isInteger(data.revision)) return;
  const cached = getCachedArtistDirectory();
  const directory = data.revision < cached.revision ? cached : data as ArtistDirectory;
  if (directory.revision < libArtistRevision) return;
  libArtists = directory.artists;
  libTrackArtists = directory.trackArtists;
  libArtistRevision = directory.revision;
  libArtistsCache = null;
  libEntriesCache = null;
  cacheArtistDirectory(directory);
}

interface AdminArtist {
  name: string;
  normKey: string;
  trackCount: number;
  tracks: LibEntry[];
  albums: string[];
  img: string;
  hasCustomImg: boolean;
  bio: string;
  genres: string[];
  social: string;
}

let libArtistsCache: AdminArtist[] | null = null;
let artistFilter = 'all';
let artistSortMode = 'countDesc';
let artistQuery = '';
let artistSearchTimer: number | undefined;

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
  ingestArtistDirectory(data);
  const files = Array.isArray(data.files) ? data.files : [];
  libFiles = files.filter((f) => f && AUDIO_FILE_RE.test(f.path));
  libCovers = new Map();
  for (const f of files) {
    if (f && IMG_FILE_RE.test(f.path)) libCovers.set(f.path.replace(/\.[^.]+$/, ''), f.path);
  }
  /* bucket data changed — drop the derived lists so the next read rebuilds them */
  libEntriesCache = null;
  libArtistsCache = null;
}

/* Parsing a filename into title/artist/album/ID costs a regex per file, and
   renderLibGrid() used to do it TWICE on every keystroke (once for the counts,
   once inside libVisibleEntries). The result only changes when the bucket does,
   so build it once and hand out the same array until ingestLibraryData runs. */
let libEntriesCache: LibEntry[] | null = null;

function buildLibEntries(): LibEntry[] {
  if (libEntriesCache) return libEntriesCache;
  libEntriesCache = libFiles.map((f) => {
    const stem = f.path.replace(/\.[^.]+$/, '');
    const ext = f.path.slice(stem.length);
    const vidM = VID_SUFFIX_RE.exec(stem);
    const vid = vidM ? vidM[1] : '';
    const base = stem.replace(VID_SUFFIX_RE, '');
    const fm = /^(.+?)\s+-\s+(.+)$/.exec(base);
    let artist = fm ? fm[1].trim() : '';
    let title = fm ? fm[2].trim() : base;
    let album = '', year = '', duration = 0, genre = '';
    const m = vid ? libManifest[vid] : undefined;
    if (m) {
      if (m.t) title = m.t;
      if (m.a) artist = m.a;
      if (m.al) album = m.al;
      if (m.y) year = String(m.y);
      if (typeof m.d === 'number') duration = m.d;
      if (m.g) genre = m.g;
    }
    artist = libTrackArtists[artistTrackId(vid, f.path)] || artist;
    const coverPath = libCovers.get(stem);
    return {
      path: f.path, stem, ext, vid,
      size: Number(f.size) || 0, mtime: f.mtime || '',
      title, artist, album, year, duration, genre,
      coverUrl: coverPath ? hfLibUrl(coverPath) : '',
    };
  });
  return libEntriesCache;
}

function libVisibleEntries(): LibEntry[] {
  /* slice() so the filter/sort below can never reorder the shared cache */
  let list = buildLibEntries().slice();
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
        <button type="button" data-a="play" title="Play audio preview" aria-label="Play">▶</button>
        <button type="button" data-a="ren" title="Edit track &amp; metadata" aria-label="Edit">✎</button>
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

function openModal(html: string, wide = false): void {
  modalCard.classList.toggle('wide', wide);
  modalCard.innerHTML = html;
  modalHost.hidden = false;
}
function closeModal(): void {
  modalHost.hidden = true;
  modalCard.classList.remove('wide');
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

/* ---------- revamped track editor modal ---------- */
async function openEditTrackModal(path: string): Promise<void> {
  const entry = buildLibEntries().find((e) => e.path === path);
  if (!entry) return;

  const allArtists = Array.from(new Set(buildLibEntries().map((e) => e.artist).filter(Boolean))).sort();
  const datalistOptions = allArtists.map((a) => `<option value="${escHtml(a)}">`).join('');

  let pendingCoverData: string | null = null;
  const currentCover = entry.coverUrl || '';

  const modalHtml = `
    <div class="adm-modal-head">
      <div>
        <h3 class="adm-modal-title"><i class="fa-solid fa-sliders"></i> Edit Track</h3>
        <p class="adm-modal-sub">Rename audio and cover, auto-clean titles, adjust metadata, and sync changes to Aura Music.</p>
      </div>
    </div>

    <div class="adm-edit-track-grid">
      <div class="adm-track-cover-col">
        <div class="adm-track-cover-img" id="etmCoverBox">
          ${currentCover ? `<img id="etmCoverImg" src="${escHtml(currentCover)}" alt="">` : '<i class="fa-solid fa-music" style="font-size:36px;color:var(--dim)"></i>'}
        </div>
        <button type="button" class="adm-btn small ghost" id="etmPlayPreviewBtn"><i class="fa-solid fa-play"></i> Play preview</button>
        <button type="button" class="adm-btn small ghost" id="etmPickCoverBtn"><i class="fa-solid fa-image"></i> Replace cover</button>
        <input type="file" id="etmCoverFileInput" accept="image/jpeg,image/png,image/webp" style="display:none">
        <input type="text" class="adm-input" id="etmCoverUrlInput" placeholder="Or paste image URL" style="font-size:11.5px;padding:5px 8px;margin-top:4px;">
      </div>

      <div class="adm-fields-grid">
        <div class="adm-field-full">
          <label class="adm-label" for="etmTitle">Title</label>
          <div class="adm-field-with-btn">
            <input class="adm-input" id="etmTitle" type="text" spellcheck="false" maxlength="180" value="${escHtml(entry.title)}">
            <button type="button" class="adm-btn ghost small" id="etmCleanTitleBtn" title="Clean Title (strips official audio, video, etc.)">✨ Clean</button>
          </div>
        </div>

        <div class="adm-field-full">
          <label class="adm-label" for="etmArtist">Artist</label>
          <div class="adm-field-with-btn">
            <input class="adm-input" id="etmArtist" list="etmArtistList" type="text" spellcheck="false" maxlength="180" placeholder="Unknown artist" value="${escHtml(entry.artist)}">
            <datalist id="etmArtistList">${datalistOptions}</datalist>
            <button type="button" class="adm-btn ghost small" id="etmCleanArtistBtn" title="Clean Artist name">✨ Clean</button>
          </div>
        </div>

        <div>
          <label class="adm-label" for="etmAlbum">Album</label>
          <input class="adm-input" id="etmAlbum" type="text" spellcheck="false" maxlength="180" placeholder="Album name" value="${escHtml(entry.album)}">
        </div>

        <div>
          <label class="adm-label" for="etmYear">Year</label>
          <input class="adm-input" id="etmYear" type="text" maxlength="4" placeholder="e.g. 2024" value="${escHtml(entry.year)}">
        </div>

        <div>
          <label class="adm-label" for="etmDuration">Duration <small style="color:var(--dim)">(MM:SS or sec)</small></label>
          <input class="adm-input" id="etmDuration" type="text" placeholder="e.g. 3:45" value="${entry.duration ? fmtDur(entry.duration) : ''}">
        </div>

        <div>
          <label class="adm-label" for="etmGenre">Genre</label>
          <input class="adm-input" id="etmGenre" type="text" placeholder="e.g. Pop, Soundtrack" value="${escHtml(entry.genre || '')}">
        </div>

        <div class="adm-field-full">
          ${entry.vid ? `
            <div class="adm-modal-file" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
              <span>YouTube ID: <a href="https://www.youtube.com/watch?v=${escHtml(entry.vid)}" target="_blank" rel="noopener noreferrer" style="color:var(--text);text-decoration:underline;"><b>${escHtml(entry.vid)}</b> <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:10px"></i></a></span>
              <button type="button" class="adm-btn ghost small" id="etmFetchYtBtn" style="padding:2px 8px;font-size:11px;">Fetch YouTube Meta</button>
            </div>
          ` : `
            <div class="adm-modal-file dim"><i class="fa-solid fa-file-audio"></i> Local track (no YouTube ID)</div>
          `}
        </div>

        <div class="adm-field-full">
          <div class="adm-modal-file">Bucket filename: <code id="etmFilePreview"></code></div>
        </div>
      </div>
    </div>

    <div class="adm-status" id="etmStatus"></div>

    <div class="adm-modal-actions" style="justify-content:space-between;width:100%;">
      <button type="button" class="adm-btn danger ghost" id="etmDeleteBtn"><i class="fa-solid fa-trash"></i> Delete</button>
      <div style="display:flex;gap:8px;align-items:center;">
        <button type="button" class="adm-btn ghost" id="etmCancelBtn">Cancel</button>
        <button type="button" class="adm-btn ghost" id="etmSaveNextBtn"><i class="fa-solid fa-forward-step"></i> Save &amp; Next</button>
        <button type="button" class="adm-btn primary" id="etmSaveBtn"><i class="fa-solid fa-check"></i> Save Changes</button>
      </div>
    </div>
  `;

  openModal(modalHtml, true);

  const titleInput = $<HTMLInputElement>('etmTitle');
  const artistInput = $<HTMLInputElement>('etmArtist');
  const albumInput = $<HTMLInputElement>('etmAlbum');
  const yearInput = $<HTMLInputElement>('etmYear');
  const durInput = $<HTMLInputElement>('etmDuration');
  const genreInput = $<HTMLInputElement>('etmGenre');
  const filePreview = $('etmFilePreview');
  const coverBox = $('etmCoverBox');
  const coverFileInput = $<HTMLInputElement>('etmCoverFileInput');
  const coverUrlInput = $<HTMLInputElement>('etmCoverUrlInput');
  const statusEl = $('etmStatus');

  const newStem = (): string => {
    const t = safeName(titleInput.value) || 'Untitled';
    const a = safeName(artistInput.value);
    return (a ? a + ' - ' : '') + t + (entry.vid ? ' [' + entry.vid + ']' : '');
  };
  const showPreview = () => { filePreview.textContent = newStem() + entry.ext; };
  titleInput.addEventListener('input', showPreview);
  artistInput.addEventListener('input', showPreview);
  showPreview();

  $('etmCleanTitleBtn').addEventListener('click', () => {
    titleInput.value = cleanTitle(titleInput.value);
    showPreview();
  });

  $('etmCleanArtistBtn').addEventListener('click', () => {
    artistInput.value = cleanArtist(artistInput.value);
    showPreview();
  });

  $('etmPlayPreviewBtn').addEventListener('click', () => {
    playTrackPreview(entry);
  });

  $('etmPickCoverBtn').addEventListener('click', () => {
    coverFileInput.click();
  });

  coverFileInput.addEventListener('change', () => {
    const file = coverFileInput.files?.[0];
    if (!file) return;
    if (file.size > MAX_COVER_BYTES) {
      setStatus(statusEl, '✗ Cover image too large (max 1.5 MB)', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      pendingCoverData = dataUri;
      coverBox.innerHTML = `<img src="${escHtml(dataUri)}" alt="Cover preview">`;
    };
    reader.readAsDataURL(file);
  });

  coverUrlInput.addEventListener('change', () => {
    const url = coverUrlInput.value.trim();
    if (!url) return;
    pendingCoverData = url;
    coverBox.innerHTML = `<img src="${escHtml(url)}" alt="Cover preview">`;
  });

  if (entry.vid) {
    $('etmFetchYtBtn')?.addEventListener('click', async () => {
      setStatus(statusEl, 'Fetching YouTube info…');
      try {
        const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + entry.vid));
        if (!res.ok) throw new Error('Could not fetch oembed');
        const d = await res.json();
        if (d.title) titleInput.value = cleanTitle(d.title);
        if (d.author_name) artistInput.value = cleanArtist(d.author_name);
        showPreview();
        setStatus(statusEl, '✓ Filled from YouTube', 'ok');
      } catch {
        setStatus(statusEl, '✗ Could not fetch YouTube metadata', 'err');
      }
    });
  }

  $('etmDeleteBtn').addEventListener('click', () => {
    closeModal();
    openDeleteModal([entry.path]);
  });

  $('etmCancelBtn').addEventListener('click', closeModal);

  const performSave = async (andNext: boolean) => {
    const title = safeName(titleInput.value) || 'Untitled';
    const artist = safeName(artistInput.value);
    const album = safeName(albumInput.value);
    const year = yearInput.value.trim();
    const genre = genreInput.value.trim();

    // Parse duration
    let durSec = 0;
    const durStr = durInput.value.trim();
    if (durStr.includes(':')) {
      const [m, s] = durStr.split(':').map(Number);
      if (!isNaN(m) && !isNaN(s)) durSec = m * 60 + s;
    } else if (durStr) {
      const n = Number(durStr);
      if (!isNaN(n)) durSec = n;
    }

    const toPath = newStem() + entry.ext;
    const saveBtn = $<HTMLButtonElement>('etmSaveBtn');
    const saveNextBtn = $<HTMLButtonElement>('etmSaveNextBtn');
    saveBtn.disabled = true;
    saveNextBtn.disabled = true;

    try {
      let renamed = false;
      if (toPath !== entry.path) {
        setStatus(statusEl, 'Renaming in the bucket…');
        await adminApi('bucketRename', { from: entry.path, to: toPath });
        renamed = true;
      }

      if (pendingCoverData) {
        setStatus(statusEl, 'Uploading cover artwork…');
        await adminApi('bucketCover', { path: toPath, data: pendingCoverData });
      }

      const metaChanged =
        title !== entry.title ||
        artist !== entry.artist ||
        album !== entry.album ||
        year !== entry.year ||
        (durSec > 0 && durSec !== entry.duration) ||
        Boolean(genre);

      let synced = false;
      if (entry.vid && metaChanged) {
        setStatus(statusEl, 'Syncing metadata to manifest.json…');
        const payload: Record<string, unknown> = { id: entry.vid, title, artist, album };
        if (year) payload.year = year;
        if (durSec > 0) payload.duration = durSec;
        if (genre) payload.genre = genre;
        try {
          const saved = await adminApi<Partial<ArtistDirectory>>('bucketManifestSet', payload);
          ingestArtistDirectory(saved);
          synced = true;
        } catch (e) {
          if (!/not in manifest/i.test((e as Error).message)) throw e;
        }
      }

      toast(renamed || synced || pendingCoverData ? 'Track changes saved' : 'No changes to save', 'ok');

      // Update in-memory entry to prevent stale state before reload
      entry.path = toPath;
      entry.title = title;
      entry.artist = artist;
      entry.album = album;
      entry.year = year;
      if (durSec > 0) entry.duration = durSec;
      if (genre) entry.genre = genre;
      libEntriesCache = null;
      libArtistsCache = null;

      if (andNext) {
        const visible = libVisibleEntries();
        const curIdx = visible.findIndex((e) => e.path === toPath || e.path === entry.path);
        const next = curIdx >= 0 && curIdx + 1 < visible.length ? visible[curIdx + 1] : null;
        if (next) {
          void openEditTrackModal(next.path);
          return;
        }
      }

      closeModal();
      await loadLibraryManager(true);
      await refreshLibrary(true);
    } catch (e) {
      setStatus(statusEl, '✗ ' + ((e as Error).message || 'save failed'), 'err');
      saveBtn.disabled = false;
      saveNextBtn.disabled = false;
    }
  };

  $('etmSaveBtn').addEventListener('click', () => void performSave(false));
  $('etmSaveNextBtn').addEventListener('click', () => void performSave(true));
}

function openRenameModal(path: string): void {
  void openEditTrackModal(path);
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

/* ---------- audio preview player ---------- */
let currentPlayingPath = '';

function initAudioPlayer(): void {
  const audio = $<HTMLAudioElement>('admAudioElem');
  const bar = $<HTMLElement>('admAudioBar');
  const playBtn = $<HTMLButtonElement>('admAudioPlayBtn');
  const playIcon = $<HTMLElement>('admAudioPlayIcon');
  const curTime = $<HTMLElement>('admAudioCurTime');
  const totalTime = $<HTMLElement>('admAudioTotalTime');
  const seek = $<HTMLInputElement>('admAudioSeek');
  const muteBtn = $<HTMLButtonElement>('admAudioMuteBtn');
  const muteIcon = $<HTMLElement>('admAudioMuteIcon');
  const closeBtn = $<HTMLButtonElement>('admAudioCloseBtn');

  playBtn.addEventListener('click', () => {
    if (audio.paused) void audio.play();
    else audio.pause();
  });

  audio.addEventListener('play', () => {
    playIcon.className = 'fa-solid fa-pause';
  });

  audio.addEventListener('pause', () => {
    playIcon.className = 'fa-solid fa-play';
  });

  audio.addEventListener('ended', () => {
    playIcon.className = 'fa-solid fa-play';
    seek.value = '0';
    curTime.textContent = '0:00';
  });

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration || isNaN(audio.duration)) return;
    curTime.textContent = fmtDur(audio.currentTime);
    seek.value = String((audio.currentTime / audio.duration) * 100);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration && !isNaN(audio.duration)) {
      totalTime.textContent = fmtDur(audio.duration);
    }
  });

  seek.addEventListener('input', () => {
    if (audio.duration && !isNaN(audio.duration)) {
      audio.currentTime = (Number(seek.value) / 100) * audio.duration;
    }
  });

  muteBtn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    muteIcon.className = audio.muted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
  });

  closeBtn.addEventListener('click', () => {
    audio.pause();
    audio.src = '';
    bar.hidden = true;
    currentPlayingPath = '';
  });
}

function playTrackPreview(entry: { path: string; title: string; artist: string; coverUrl?: string; duration?: number }): void {
  const audio = $<HTMLAudioElement>('admAudioElem');
  const bar = $<HTMLElement>('admAudioBar');
  const img = $<HTMLImageElement>('admAudioImg');
  const title = $<HTMLElement>('admAudioTitle');
  const artist = $<HTMLElement>('admAudioArtist');
  const totalTime = $<HTMLElement>('admAudioTotalTime');

  currentPlayingPath = entry.path;
  img.src = entry.coverUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="%23222"/><text x="20" y="25" font-size="16" text-anchor="middle" fill="%23888">♪</text></svg>';
  title.textContent = entry.title || 'Unknown Title';
  artist.textContent = entry.artist || 'Unknown Artist';
  if (entry.duration) totalTime.textContent = fmtDur(entry.duration);

  bar.hidden = false;
  audio.src = hfLibUrl(entry.path);
  audio.currentTime = 0;
  audio.play().catch((e) => {
    console.warn('Audio playback error:', e);
  });
}

/* ---------- artist management ---------- */
function buildAdminArtists(): AdminArtist[] {
  if (libArtistsCache) return libArtistsCache;
  const entries = buildLibEntries();
  const map = new Map<string, { name: string; tracks: LibEntry[]; albums: Set<string> }>();

  for (const e of entries) {
    const rawArtist = (e.artist || '').trim() || 'Unknown Artist';
    const profile = libArtists[normalizeArtistKey(rawArtist)];
    const norm = profile?.key || normalizeArtistKey(rawArtist);
    let g = map.get(norm);
    if (!g) {
      g = { name: rawArtist, tracks: [], albums: new Set() };
      map.set(norm, g);
    }
    g.tracks.push(e);
    if (e.album) g.albums.add(e.album);
  }

  const result: AdminArtist[] = [];
  for (const [norm, g] of map.entries()) {
    const custom = libArtists[norm] || Object.values(libArtists).find((a) => normalizeArtistKey(a.name || '') === norm);
    const name = custom?.name || g.name;
    const sampleCover = g.tracks.find((t) => t.coverUrl)?.coverUrl || '';
    const img = custom?.img || sampleCover;
    const hasCustomImg = Boolean(custom?.img);
    const bio = custom?.bio || '';
    const genres = Array.isArray(custom?.genres) ? custom.genres : [];
    const social = custom?.social || '';

    result.push({
      name,
      normKey: norm,
      trackCount: g.tracks.length,
      tracks: g.tracks,
      albums: Array.from(g.albums),
      img,
      hasCustomImg,
      bio,
      genres,
      social,
    });
  }

  // Include saved profiles with 0 tracks once, not once for every old-name alias.
  const included = new Set(result.map(a => a.normKey));
  for (const [norm, meta] of Object.entries(libArtists)) {
    const k = meta?.key || normalizeArtistKey(norm);
    if (!included.has(k) && meta) {
      included.add(k);
      result.push({
        name: meta.name || norm,
        normKey: k,
        trackCount: 0,
        tracks: [],
        albums: [],
        img: meta.img || '',
        hasCustomImg: Boolean(meta.img),
        bio: meta.bio || '',
        genres: Array.isArray(meta.genres) ? meta.genres : [],
        social: meta.social || '',
      });
    }
  }

  libArtistsCache = result;
  return libArtistsCache;
}

function artistVisibleList(): AdminArtist[] {
  let list = buildAdminArtists().slice();

  if (artistFilter === 'hascustom') {
    list = list.filter((a) => a.hasCustomImg || a.bio || a.genres.length > 0);
  } else if (artistFilter === 'defaultpic') {
    list = list.filter((a) => !a.hasCustomImg);
  }

  const q = artistQuery.toLowerCase().trim();
  if (q) {
    list = list.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.genres.some((g) => g.toLowerCase().includes(q)) ||
      a.bio.toLowerCase().includes(q),
    );
  }

  const cmp: Record<string, (a: AdminArtist, b: AdminArtist) => number> = {
    countDesc: (a, b) => b.trackCount - a.trackCount || a.name.localeCompare(b.name),
    nameAsc: (a, b) => a.name.localeCompare(b.name),
    nameDesc: (a, b) => b.name.localeCompare(a.name),
    customFirst: (a, b) => (b.hasCustomImg ? 1 : 0) - (a.hasCustomImg ? 1 : 0) || b.trackCount - a.trackCount,
  };

  return list.sort(cmp[artistSortMode] || cmp.countDesc);
}

function renderArtistsGrid(): void {
  const grid = $('artistGrid');
  const all = buildAdminArtists();
  const shown = artistVisibleList();

  const customCount = all.filter((a) => a.hasCustomImg).length;
  const counts = {
    all: all.length,
    hascustom: customCount,
    defaultpic: all.length - customCount,
  };

  $('artistFilters').querySelectorAll<HTMLElement>('button').forEach((b) => {
    const el = b.querySelector('b');
    if (el) el.textContent = String(counts[(b.dataset.f || 'all') as keyof typeof counts] ?? 0);
  });

  $('artistStats').textContent = all.length
    ? `Showing ${shown.length === all.length ? all.length : shown.length + ' of ' + all.length} artists · ${customCount} with custom pictures`
    : '';
  $('artistsHeadSub').textContent = all.length ? `${all.length} artists` : '';
  const badge = $('artistsTabCount');
  badge.hidden = !all.length;
  badge.textContent = String(all.length);

  if (!all.length) {
    grid.innerHTML = '<span class="adm-chip dim">no artists found in library</span>';
    return;
  }
  if (!shown.length) {
    grid.innerHTML = '<span class="adm-chip dim">no artists match this search/filter</span>';
    return;
  }

  grid.innerHTML = shown.map((a) => {
    const avatar = a.img
      ? `<img src="${escHtml(a.img)}" alt="${escHtml(a.name)}" loading="lazy">`
      : '<i class="fa-solid fa-user" style="font-size:32px;color:var(--dim)"></i>';
    const customBadge = a.hasCustomImg
      ? '<span class="adm-acard-badge" title="Custom portrait set"><i class="fa-solid fa-star"></i> Custom</span>'
      : '';
    const genres = a.genres.length
      ? `<div class="adm-acard-genres">${a.genres.map((g) => `<span class="adm-acard-tag">${escHtml(g)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="adm-acard" data-artist="${escHtml(a.name)}">
        <div class="adm-acard-avatar">
          ${avatar}
          ${customBadge}
        </div>
        <div class="adm-acard-name" title="${escHtml(a.name)}">${escHtml(a.name)}</div>
        <div class="adm-acard-count">${a.trackCount} ${a.trackCount === 1 ? 'track' : 'tracks'}${a.albums.length ? ` · ${a.albums.length} ${a.albums.length === 1 ? 'album' : 'albums'}` : ''}</div>
        ${genres}
        <div class="adm-acard-acts">
          <button type="button" class="adm-btn small ghost" data-artist-view="${escHtml(a.name)}"><i class="fa-solid fa-music"></i> Tracks</button>
          <button type="button" class="adm-btn small primary" data-artist-edit="${escHtml(a.name)}"><i class="fa-solid fa-pen"></i> Edit</button>
        </div>
      </div>
    `;
  }).join('');
}

async function loadArtistsManager(force = false): Promise<void> {
  const statusEl = $('artistStatus');
  if (force) setStatus(statusEl, 'Loading artists…');
  void fetchArtistDirectory();
  try {
    if (!libFiles.length || force) {
      const data = await adminApi<LibraryResponse>('library');
      ingestLibraryData(data);
    }
    libArtistsCache = null;
    renderArtistsGrid();
    if (force) setStatus(statusEl, `Loaded ${buildAdminArtists().length} artists`, 'ok');
  } catch (e) {
    setStatus(statusEl, '✗ ' + ((e as Error).message || 'could not load artists'), 'err');
  }
}

function viewArtistSongs(artistName: string): void {
  switchTab('panelLibrary');
  libQuery = artistName;
  const input = $<HTMLInputElement>('libSearchInput');
  input.value = artistName;
  renderLibGrid();
}

function openEditArtistModal(artistName: string): void {
  const artists = buildAdminArtists();
  const artist = artists.find((a) => a.name.toLowerCase() === artistName.toLowerCase() || a.normKey === artistName.toLowerCase());
  if (!artist) {
    toast('Artist not found', 'err');
    return;
  }

  /* Capture the version when the editor opens, not when Save is clicked.
     Refreshes in another tab must never silently upgrade a stale draft. */
  const profile = libArtists[artist.normKey] || Object.values(libArtists).find((a) => normalizeArtistKey(a.name || '') === normalizeArtistKey(artist.name));
  const openedArtistKey = profile?.key || artist.normKey;
  const openedVersion = profile?.version || 0;

  let chosenImg = artist.hasCustomImg ? artist.img : '';
  const albumCovers = Array.from(new Set(artist.tracks.map((t) => t.coverUrl).filter(Boolean)));

  const carouselHtml = albumCovers.length ? `
    <label class="adm-label">Pick from song album covers</label>
    <div class="adm-artist-carousel" id="aemCarousel">
      ${albumCovers.map((c) => `
        <div class="adm-artist-thumb-opt${c === chosenImg ? ' active' : ''}" data-cover="${escHtml(c)}" title="Click to use this artwork">
          <img src="${escHtml(c)}" alt="" loading="lazy">
        </div>
      `).join('')}
    </div>
  ` : '';

  const songsHtml = artist.tracks.length ? `
    <label class="adm-label" style="margin-top:12px;">Tracks by this artist (${artist.tracks.length})</label>
    <div class="adm-artist-songs-list" id="aemSongsList">
      ${artist.tracks.map((t) => `
        <div class="adm-artist-song-item" data-path="${escHtml(t.path)}">
          <button type="button" class="adm-artist-song-play" data-song-play="${escHtml(t.path)}" title="Play track"><i class="fa-solid fa-play"></i></button>
          <div class="adm-artist-song-title" title="${escHtml(t.title)}">${escHtml(t.title)}</div>
          <div class="adm-artist-song-album">${escHtml(t.album || '—')}</div>
          <button type="button" class="adm-btn small ghost" data-song-edit="${escHtml(t.path)}" style="padding:2px 8px;font-size:11px;">Edit</button>
        </div>
      `).join('')}
    </div>
  ` : '';

  const modalHtml = `
    <div class="adm-modal-head">
      <div>
        <h3 class="adm-modal-title"><i class="fa-solid fa-user-pen"></i> Edit Artist: ${escHtml(artist.name)}</h3>
        <p class="adm-modal-sub">Changes are saved permanently to Cloudflare and appear immediately. Uploaded portraits stay with the profile; image URLs remain external.</p>
      </div>
    </div>

    <div class="adm-edit-track-grid">
      <div class="adm-track-cover-col">
        <div class="adm-acard-avatar" style="width:130px;height:130px;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,0.5);" id="aemAvatarBox">
          ${(chosenImg || artist.img) ? `<img id="aemAvatarImg" src="${escHtml(chosenImg || artist.img)}" alt="${escHtml(artist.name)}">` : '<i class="fa-solid fa-user" style="font-size:44px;color:var(--dim)"></i>'}
        </div>
        <button type="button" class="adm-btn small ghost" id="aemUploadBtn"><i class="fa-solid fa-upload"></i> Upload Picture</button>
        <input type="file" id="aemFileInput" accept="image/jpeg,image/png,image/webp" style="display:none">
        <button type="button" class="adm-btn small ghost" id="aemClearPicBtn" style="color:var(--red)"><i class="fa-solid fa-xmark"></i> Remove Picture</button>
      </div>

      <div class="adm-fields-grid">
        <div class="adm-field-full">
          <label class="adm-label" for="aemName">Artist Name</label>
          <input class="adm-input" id="aemName" type="text" maxlength="120" value="${escHtml(artist.name)}">
          <label class="adm-dcheck" style="margin-top:6px;">
            <input type="checkbox" id="aemRenameTracks" checked>
            <span>Also update artist name on all <b>${artist.trackCount}</b> tracks in library (batch rename)</span>
          </label>
        </div>

        <div class="adm-field-full">
          <label class="adm-label" for="aemImgUrl">Picture URL <small style="color:var(--dim)">(direct image link)</small></label>
          <input class="adm-input" id="aemImgUrl" type="url" placeholder="https://..." value="${artist.hasCustomImg && artist.img.startsWith('https://') ? escHtml(artist.img) : ''}">
        </div>

        <div class="adm-field-full">
          ${carouselHtml}
        </div>

        <div class="adm-field-full">
          <label class="adm-label" for="aemGenres">Genres <small style="color:var(--dim)">(comma separated)</small></label>
          <input class="adm-input" id="aemGenres" type="text" placeholder="e.g. Pop, Synthpop, Dance" value="${escHtml(artist.genres.join(', '))}">
        </div>

        <div class="adm-field-full">
          <label class="adm-label" for="aemBio">Bio / Description</label>
          <textarea class="adm-input" id="aemBio" rows="3" maxlength="2000" placeholder="Short biography of the artist...">${escHtml(artist.bio)}</textarea>
        </div>

        <div class="adm-field-full">
          <label class="adm-label" for="aemSocial">Social / Website Link</label>
          <input class="adm-input" id="aemSocial" type="url" placeholder="https://instagram.com/..." value="${escHtml(artist.social)}">
        </div>

        <div class="adm-field-full">
          ${songsHtml}
        </div>
      </div>
    </div>

    <div class="adm-status" id="aemStatus"></div>

    <div class="adm-modal-actions">
      <button type="button" class="adm-btn ghost" id="aemCancelBtn">Cancel</button>
      <button type="button" class="adm-btn primary" id="aemSaveBtn"><i class="fa-solid fa-floppy-disk"></i> Save Artist Profile</button>
    </div>
  `;

  openModal(modalHtml, true);

  const avatarBox = $('aemAvatarBox');
  const fileInput = $<HTMLInputElement>('aemFileInput');
  const imgUrlInput = $<HTMLInputElement>('aemImgUrl');
  const nameInput = $<HTMLInputElement>('aemName');
  const bioInput = $<HTMLTextAreaElement>('aemBio');
  const genresInput = $<HTMLInputElement>('aemGenres');
  const socialInput = $<HTMLInputElement>('aemSocial');
  const renameTracksCheck = $<HTMLInputElement>('aemRenameTracks');
  const statusEl = $('aemStatus');

  const updateAvatarPreview = (src: string) => {
    if (src) {
      avatarBox.innerHTML = `<img id="aemAvatarImg" src="${escHtml(src)}" alt="">`;
    } else {
      avatarBox.innerHTML = '<i class="fa-solid fa-user" style="font-size:44px;color:var(--dim)"></i>';
    }
  };

  $('aemUploadBtn').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setStatus(statusEl, 'Upload a JPEG, PNG or WebP portrait.', 'err');
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      setStatus(statusEl, '✗ Image file too large (max 1.5 MB)', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      chosenImg = dataUri;
      imgUrlInput.value = '';
      updateAvatarPreview(dataUri);
    };
    reader.readAsDataURL(file);
  });

  imgUrlInput.addEventListener('input', () => {
    const url = imgUrlInput.value.trim();
    chosenImg = url;
    updateAvatarPreview(url);
  });

  $('aemClearPicBtn').addEventListener('click', () => {
    chosenImg = '';
    imgUrlInput.value = '';
    updateAvatarPreview('');
  });

  const carousel = document.getElementById('aemCarousel');
  if (carousel) {
    carousel.addEventListener('click', (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLElement>('.adm-artist-thumb-opt');
      if (!opt?.dataset.cover) return;
      chosenImg = opt.dataset.cover;
      imgUrlInput.value = chosenImg;
      carousel.querySelectorAll('.adm-artist-thumb-opt').forEach((o) => {
        o.classList.toggle('active', o === opt);
      });
      updateAvatarPreview(chosenImg);
    });
  }

  const songsList = document.getElementById('aemSongsList');
  if (songsList) {
    songsList.addEventListener('click', (e) => {
      const playBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-song-play]');
      if (playBtn?.dataset.songPlay) {
        const t = artist.tracks.find((item) => item.path === playBtn.dataset.songPlay);
        if (t) playTrackPreview(t);
        return;
      }
      const editBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-song-edit]');
      if (editBtn?.dataset.songEdit) {
        closeModal();
        void openEditTrackModal(editBtn.dataset.songEdit);
        return;
      }
    });
  }

  $('aemCancelBtn').addEventListener('click', closeModal);

  $('aemSaveBtn').addEventListener('click', async () => {
    const newName = nameInput.value.trim() || artist.name;
    const bio = bioInput.value.trim();
    const genres = genresInput.value.split(',').map((g) => g.trim()).filter(Boolean);
    const social = socialInput.value.trim();
    const renameTracks = renameTracksCheck.checked;

    const saveBtn = $<HTMLButtonElement>('aemSaveBtn');
    saveBtn.disabled = true;
    setStatus(statusEl, 'Saving artist profile…');

    try {
      const res = await adminApi<ArtistDirectory & { ok: boolean; persisted: boolean; artist: ArtistMeta; renamedTrackCount?: number }>('artistSet', {
        artist: artist.name,
        artistKey: openedArtistKey,
        version: openedVersion,
        name: newName,
        img: chosenImg,
        bio,
        genres,
        social,
        renameTracks,
      });

      if (!res.persisted || !res.artist?.version) throw new Error('The server did not confirm a saved profile. Reload and try again.');
      ingestArtistDirectory(res);

      closeModal();
      toast(res.renamedTrackCount ? `Artist saved & renamed across ${res.renamedTrackCount} tracks` : 'Artist profile saved', 'ok');
      renderArtistsGrid();
      renderLibGrid();
    } catch (e) {
      setStatus(statusEl, '✗ ' + ((e as Error).message || 'could not save artist'), 'err');
      saveBtn.disabled = false;
    }
  });
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

/* ---------- Discord / Aura Farmer ---------- */
type DiscordSection = 'queue' | 'batches' | 'users' | 'settings' | 'audit';

const DISCORD_STATE_KEY = 'auraAdmin_discordSection';
let discordSection: DiscordSection = 'queue';
let discordPollTimer: number | undefined;
let discordQueueRows: any[] = [];
let discordUserRows: any[] = [];
let discordQueueSearchTimer: number | undefined;
let discordUserSearchTimer: number | undefined;
let discordAuditSearchTimer: number | undefined;

async function botApi<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const session = getSession();
  if (!session) {
    lock('Your session expired — sign in again.');
    throw new Error('Sign in first.');
  }
  let res: Response;
  try {
    res = await fetch('/api/bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, credential: session.token, action }),
    });
  } catch {
    throw new Error('network error — is the site reachable?');
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      if (session.token.startsWith('v1.') || session.token.startsWith('local:')) clearSession();
      lock(data?.error || 'Sign-in required.');
    }
    throw new Error(data?.error || 'HTTP ' + res.status);
  }
  return data as T;
}

function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function setDiscordBadge(el: HTMLElement, kind: string, label: string): void {
  el.className = 'adm-dbadge ' + kind;
  el.textContent = label;
}

function setDiscordLoading(host: HTMLElement, text = 'loading…'): void {
  host.innerHTML = '<span class="adm-chip dim">' + escHtml(text) + '</span>';
}

function setDiscordError(host: HTMLElement, text: string): void {
  host.innerHTML = '<span class="adm-chip missing">' + escHtml(text) + '</span>';
}

async function loadDiscordOverview(silent = false): Promise<void> {
  try {
    const data = await botApi<any>('overview');
    const counts = data.counts || {};
    const settings = data.settings || {};
    const bot = data.bot || {};
    const online = Boolean(bot.online);

    setDiscordBadge($('discordBotBadge'), online ? 'ok' : 'err', online ? 'online' : 'offline');
    const gateway = $('discordGatewayState');
    gateway.textContent = online
      ? (bot.botUser || 'connected') + ' · ' + (bot.latencyMs == null ? '—' : bot.latencyMs + ' ms')
      : bot.lastSeen ? 'last seen ' + fmtAgo(bot.lastSeen) : 'not connected yet';
    gateway.className = 'adm-dstat-value ' + (online ? 'ok' : 'err');

    const queued = Number(counts.queued || 0);
    $('discordQueueState').textContent = queued + ' / ' + (settings.threshold ?? '—');
    $('discordQueueState').className = 'adm-dstat-value accent';
    $('discordActiveBatch').textContent = data.activeBatch
      ? '#' + data.activeBatch.id + ' · ' + data.activeBatch.status + ' · ' + data.activeBatch.trackCount + ' tracks'
      : 'none';
    $('discordTotals').textContent = Number(counts.downloaded || 0) + ' / ' + Number(counts.failed || 0);

    const tabCount = $('discordTabCount');
    tabCount.hidden = queued === 0;
    tabCount.textContent = String(queued);

    if (!silent) {
      const bits: string[] = ['Worker v' + (data.worker?.version || '?')];
      if (bot.version) bits.push('gateway v' + bot.version);
      bits.push(Number(counts.users || 0) + ' users');
      bits.push(Number(counts.submissions || 0) + ' submissions');
      bits.push(Number(counts.today || 0) + ' today');
      setStatus($('discordOverviewStatus'), bits.join(' · '), '');
      if (!settings.channelIds) {
        setStatus($('discordOverviewStatus'), 'No submission channel configured yet — open Settings and add the channel ID.', 'err');
      }
    }
  } catch (e) {
    if (!silent) setStatus($('discordOverviewStatus'), '✗ ' + (e as Error).message, 'err');
  }
}

function discordStatusBadge(status: string): string {
  const safe = escHtml(status || 'unknown');
  return '<span class="adm-dbadge ' + safe + '">' + safe + '</span>';
}

async function loadDiscordQueue(): Promise<void> {
  const host = $('discordQueueList');
  setDiscordLoading(host);
  try {
    const status = ($('discordQueueFilter') as HTMLSelectElement).value;
    const q = ($('discordQueueSearch') as HTMLInputElement).value.trim();
    const data = await botApi<any>('queue', { status, q, limit: 100 });
    discordQueueRows = Array.isArray(data.items) ? data.items : [];
    $('discordQueueCount').textContent = data.total + ' total';
    if (!discordQueueRows.length) {
      setDiscordLoading(host, q ? 'no submissions match that search' : 'nothing here yet — paste a YouTube link in Discord');
      return;
    }
    host.innerHTML = discordQueueRows.map((row) => {
      const title = row.title || row.videoId || row.url;
      const meta: string[] = [];
      if (row.artist) meta.push(escHtml(row.artist));
      meta.push('@' + escHtml(row.username || 'unknown'));
      meta.push(fmtWhen(row.createdAt));
      if (row.batchId) meta.push('batch #' + row.batchId);
      if (row.error) meta.push('<span style="color:var(--red)">' + escHtml(String(row.error).slice(0, 120)) + '</span>');
      return (
        '<label class="adm-ditem">' +
          '<input type="checkbox" class="adm-drowcheck" data-id="' + Number(row.id) + '" aria-label="Select submission">' +
          '<div class="grow">' +
            '<div class="title"><a href="' + escHtml(row.url) + '" target="_blank" rel="noopener">' + escHtml(title) + '</a></div>' +
            '<div class="meta">' + meta.join(' · ') + '</div>' +
          '</div>' +
          discordStatusBadge(row.status) +
        '</label>'
      );
    }).join('');
    setStatus($('discordQueueStatus'), '', '');
  } catch (e) {
    setDiscordError(host, (e as Error).message);
  }
}

function selectedDiscordQueueIds(): number[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('#discordQueueList .adm-drowcheck:checked'))
    .map((el) => Number(el.dataset.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

async function removeDiscordQueue(): Promise<void> {
  const ids = selectedDiscordQueueIds();
  if (!ids.length) {
    setStatus($('discordQueueStatus'), 'Select one or more queued links first.', 'err');
    return;
  }
  if (!window.confirm('Remove ' + ids.length + ' submission(s) from the bot queue?')) return;
  try {
    const data = await botApi<any>('queueRemove', { ids });
    toast('Removed ' + data.removed + ' link(s)', 'ok');
    await Promise.all([loadDiscordQueue(), loadDiscordOverview(true)]);
  } catch (e) {
    setStatus($('discordQueueStatus'), '✗ ' + (e as Error).message, 'err');
  }
}

async function retryDiscordQueue(): Promise<void> {
  const ids = selectedDiscordQueueIds();
  if (!ids.length) {
    setStatus($('discordQueueStatus'), 'Select one or more failed links first.', 'err');
    return;
  }
  try {
    const data = await botApi<any>('queueRetry', { ids });
    setStatus($('discordQueueStatus'), '✓ ' + data.retried + ' link(s) returned to the queue.', 'ok');
    await Promise.all([loadDiscordQueue(), loadDiscordOverview(true)]);
  } catch (e) {
    setStatus($('discordQueueStatus'), '✗ ' + (e as Error).message, 'err');
  }
}

async function dispatchDiscordNow(): Promise<void> {
  if (!window.confirm('Send up to 25 queued tracks to GitHub Actions now?')) return;
  const btn = $<HTMLButtonElement>('discordDispatchBtn');
  btn.disabled = true;
  try {
    const data = await botApi<any>('dispatch', {});
    if (data.waiting) {
      setStatus($('discordQueueStatus'), 'Nothing dispatched: ' + (data.reason || data.error || 'dispatch is busy'), 'err');
    } else {
      setStatus(
        $('discordQueueStatus'),
        '✓ Batch #' + data.batchId + ' — ' + data.dispatched + ' track(s) sent to GitHub' + (data.runUrl ? ' · ' + data.runUrl : ''),
        'ok',
      );
      toast('Discord queue dispatched', 'ok');
    }
    await Promise.all([loadDiscordQueue(), loadDiscordOverview(true), loadDiscordBatches()]);
  } catch (e) {
    setStatus($('discordQueueStatus'), '✗ ' + (e as Error).message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function loadDiscordBatches(): Promise<void> {
  const host = $('discordBatchesList');
  setDiscordLoading(host);
  try {
    const data = await botApi<any>('batches', { limit: 40 });
    const items: any[] = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      setDiscordLoading(host, 'no batches yet — the first hand-off appears here');
      return;
    }
    host.innerHTML = items.map((batch) => {
      const meta: string[] = [];
      meta.push('requested by ' + escHtml(batch.requestedBy || 'auto'));
      meta.push('created ' + fmtWhen(batch.createdAt));
      if (batch.dispatchedAt) meta.push('dispatched ' + fmtWhen(batch.dispatchedAt));
      if (batch.error) meta.push('<span style="color:var(--red)">' + escHtml(String(batch.error).slice(0, 140)) + '</span>');
      const active = ['dispatching', 'dispatched', 'running'].includes(batch.status);
      return (
        '<div class="adm-ditem">' +
          discordStatusBadge(batch.status) +
          '<div class="grow">' +
            '<div class="title">Batch #' + Number(batch.id) + ' · ' + Number(batch.trackCount) + ' track(s)' +
              '<span class="adm-count"> · ' + Number(batch.doneCount || 0) + ' done / ' + Number(batch.failedCount || 0) + ' failed</span>' +
            '</div>' +
            '<div class="meta">' + meta.join(' · ') + '</div>' +
          '</div>' +
          (batch.runId
            ? '<a class="adm-btn ghost small" href="' + escHtml(batch.runUrl || '#') + '" target="_blank" rel="noopener">run #' + Number(batch.runId) + '</a>'
            : '') +
          (!active
            ? '<button type="button" class="adm-btn ghost small" data-batch-retry="' + Number(batch.id) + '">Retry</button>'
            : '') +
        '</div>'
      );
    }).join('');
  } catch (e) {
    setDiscordError(host, (e as Error).message);
  }
}

async function retryDiscordBatch(id: number): Promise<void> {
  try {
    const data = await botApi<any>('batchRetry', { id });
    toast('Returned ' + data.retried + ' failed track(s) to the queue', 'ok');
    await Promise.all([loadDiscordBatches(), loadDiscordQueue(), loadDiscordOverview(true)]);
  } catch (e) {
    setStatus($('discordBatchesStatus'), '✗ ' + (e as Error).message, 'err');
  }
}

async function loadDiscordUsers(): Promise<void> {
  const host = $('discordUsersList');
  setDiscordLoading(host);
  try {
    const q = ($('discordUserSearch') as HTMLInputElement).value.trim();
    const data = await botApi<any>('users', { q, limit: 100 });
    discordUserRows = Array.isArray(data.items) ? data.items : [];
    $('discordUserCount').textContent = data.total + ' total';
    if (!discordUserRows.length) {
      setDiscordLoading(host, q ? 'no users match that search' : 'no Discord users yet');
      return;
    }
    host.innerHTML = discordUserRows.map((user) => {
      const meta: string[] = ['@' + escHtml(user.username)];
      if (user.displayName && user.displayName !== user.username) meta.push(escHtml(user.displayName));
      meta.push('id ' + escHtml(user.discordId));
      meta.push(Number(user.accepted || 0) + ' accepted');
      meta.push(Number(user.duplicates || 0) + ' duplicate');
      meta.push(Number(user.downloaded || 0) + ' downloaded');
      meta.push('last seen ' + fmtAgo(user.lastSeen));
      return (
        '<div class="adm-ditem">' +
          '<div class="grow">' +
            '<div class="title">' + escHtml(user.displayName || user.username) + ' ' +
              (user.banned ? '<span class="adm-dbadge err">banned</span>' : '') + '</div>' +
            '<div class="meta">' + meta.join(' · ') + '</div>' +
            (user.banReason ? '<div class="meta" style="color:var(--red)">' + escHtml(user.banReason) + '</div>' : '') +
          '</div>' +
          '<div class="actions"><button type="button" class="adm-btn ' + (user.banned ? 'ghost' : 'danger') + ' small" data-ban="' + escHtml(user.discordId) + '" data-banned="' + (user.banned ? '1' : '0') + '">' +
            (user.banned ? 'Unban' : 'Ban') + '</button></div>' +
        '</div>'
      );
    }).join('');
  } catch (e) {
    setDiscordError(host, (e as Error).message);
  }
}

async function toggleDiscordUserBan(discordId: string, banned: boolean): Promise<void> {
  let reason = '';
  if (!banned) {
    reason = window.prompt('Reason for banning this user (shown in the audit log):', '') || '';
    if (!reason.trim()) return;
  }
  try {
    const data = await botApi<any>('userBan', { discordId, banned: !banned, reason, removeQueued: true });
    toast((banned ? 'Unbanned' : 'Banned') + ' user' + (data.removed ? ' · removed ' + data.removed + ' queued link(s)' : ''), 'ok');
    await Promise.all([loadDiscordUsers(), loadDiscordOverview(true)]);
  } catch (e) {
    setStatus($('discordUsersStatus'), '✗ ' + (e as Error).message, 'err');
  }
}

function fillDiscordSettings(settings: any): void {
  const val = (id: string, value: unknown) => { ($(id) as HTMLInputElement).value = value == null ? '' : String(value); };
  const check = (id: string, value: unknown) => { ($(id) as HTMLInputElement).checked = Boolean(value); };
  val('dsBotName', settings.botName);
  val('dsThreshold', settings.threshold);
  val('dsDispatchSize', settings.dispatchSize);
  val('dsCooldown', settings.cooldownSeconds);
  val('dsDailyLimit', settings.dailyLimit);
  val('dsGuildId', settings.guildId);
  val('dsChannelIds', settings.channelIds);
  val('dsLogChannelId', settings.logChannelId);
  val('dsMaintenanceMessage', settings.maintenanceMessage);
  check('dsEnabled', settings.enabled);
  check('dsMaintenance', settings.maintenance);
  check('dsAutoDispatch', settings.autoDispatch);
  check('dsSearchEnabled', settings.searchEnabled);
  check('dsPlaylistExpand', settings.playlistExpand);
  check('dsNotifyDispatch', settings.notifyOnDispatch);
  check('dsNotifyComplete', settings.notifyOnComplete);
  check('dsNotifyFailure', settings.notifyOnFailure);
}

async function loadDiscordSettings(): Promise<void> {
  try {
    const data = await botApi<any>('settings');
    fillDiscordSettings(data.settings || {});
    setStatus($('discordSettingsStatus'), '', '');
  } catch (e) {
    setStatus($('discordSettingsStatus'), '✗ ' + (e as Error).message, 'err');
  }
}

async function saveDiscordSettings(): Promise<void> {
  const btn = $<HTMLButtonElement>('discordSettingsSave');
  const number = (id: string) => Number(($(id) as HTMLInputElement).value);
  const text = (id: string) => ($(id) as HTMLInputElement).value.trim();
  const checked = (id: string) => ($(id) as HTMLInputElement).checked;
  const settings = {
    botName: text('dsBotName'),
    threshold: number('dsThreshold'),
    dispatchSize: number('dsDispatchSize'),
    cooldownSeconds: number('dsCooldown'),
    dailyLimit: number('dsDailyLimit'),
    guildId: text('dsGuildId'),
    channelIds: text('dsChannelIds'),
    logChannelId: text('dsLogChannelId'),
    maintenanceMessage: text('dsMaintenanceMessage'),
    enabled: checked('dsEnabled'),
    maintenance: checked('dsMaintenance'),
    autoDispatch: checked('dsAutoDispatch'),
    searchEnabled: checked('dsSearchEnabled'),
    playlistExpand: checked('dsPlaylistExpand'),
    notifyOnDispatch: checked('dsNotifyDispatch'),
    notifyOnComplete: checked('dsNotifyComplete'),
    notifyOnFailure: checked('dsNotifyFailure'),
  };
  if (settings.threshold < 1) {
    setStatus($('discordSettingsStatus'), 'Threshold must be at least 1.', 'err');
    return;
  }
  if (settings.dispatchSize < 1 || settings.dispatchSize > 25) {
    setStatus($('discordSettingsStatus'), 'Tracks per batch must be between 1 and 25.', 'err');
    return;
  }
  btn.disabled = true;
  try {
    const data = await botApi<any>('settingsUpdate', { settings });
    fillDiscordSettings(data.settings || settings);
    setStatus($('discordSettingsStatus'), '✓ Saved' + (data.changed?.length ? ' — ' + data.changed.join(', ') : ' — no changes'), 'ok');
    toast('Discord bot settings saved', 'ok');
    await loadDiscordOverview(true);
  } catch (e) {
    setStatus($('discordSettingsStatus'), '✗ ' + (e as Error).message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function auditSummary(entry: any): string {
  const d = entry.details || {};
  switch (entry.action) {
    case 'submission.queued': return 'Queued ' + (d.title || entry.targetId || 'a track');
    case 'submission.duplicate': return 'Duplicate skipped — ' + (d.title || entry.targetId || 'a track');
    case 'submission.rejected': return 'Submission rejected — ' + (d.error || 'invalid link');
    case 'submission.banned': return 'Blocked a banned user — ' + (d.reason || 'no reason given');
    case 'batch.dispatched': return 'Batch #' + (d.batchId || entry.targetId) + ' dispatched — ' + (d.dispatched ?? d.count ?? 0) + ' track(s)';
    case 'batch.completed': return 'Batch #' + (d.batchId || entry.targetId) + ' completed — ' + (d.downloaded ?? d.trackCount ?? 0) + ' downloaded';
    case 'batch.failed': return 'Batch #' + (d.batchId || entry.targetId) + ' failed — ' + (d.error || 'workflow error');
    case 'admin.settings_changed': return 'Changed settings — ' + (Array.isArray(d.changed) ? d.changed.join(', ') : 'bot');
    case 'admin.queue_removed': return 'Removed ' + (d.removed ?? 0) + ' queued link(s)';
    case 'admin.queue_retried': return 'Returned ' + (d.retried ?? 0) + ' link(s) to the queue';
    case 'admin.batch_retried': return 'Retried failed tracks in batch #' + (d.batchId || entry.targetId);
    case 'admin.user_banned': return 'Banned ' + (d.username || entry.targetId) + (d.reason ? ' — ' + d.reason : '');
    case 'admin.user_unbanned': return 'Unbanned ' + (d.username || entry.targetId);
    case 'admin.reconcile': return 'Reconciled batches — ' + (d.completed ?? 0) + ' completed, ' + (d.failed ?? 0) + ' failed';
    default: return entry.action + (entry.targetId ? ' · ' + entry.targetId : '');
  }
}

async function loadDiscordAudit(): Promise<void> {
  const host = $('discordAuditList');
  setDiscordLoading(host);
  try {
    const actor = ($('discordAuditSearch') as HTMLInputElement).value.trim();
    const actionFilter = ($('discordAuditAction') as HTMLSelectElement).value;
    const data = await botApi<any>('audit', { actor, actionFilter, limit: 100 });
    const items: any[] = Array.isArray(data.items) ? data.items : [];
    $('discordAuditCount').textContent = data.total + ' entries';
    if (!items.length) {
      setDiscordLoading(host, 'no activity matches those filters');
      return;
    }
    host.innerHTML = items.map((entry) => {
      const who = entry.actorName || entry.actorId || entry.actorType;
      return (
        '<div class="adm-ditem">' +
          '<div class="grow">' +
            '<div class="title">' + escHtml(auditSummary(entry)) + '</div>' +
            '<div class="meta"><span class="who">' + escHtml(String(who)) + '</span> · ' + escHtml(entry.actorType || 'system') + ' · ' + fmtWhen(entry.createdAt) + '</div>' +
          '</div>' +
          discordStatusBadge(String(entry.action || '').split('.')[0]) +
        '</div>'
      );
    }).join('');
  } catch (e) {
    setDiscordError(host, (e as Error).message);
  }
}

const DISCORD_SECTIONS: Array<{ id: DiscordSection; el: string; load: () => Promise<void> }> = [
  { id: 'queue', el: 'dsecQueue', load: loadDiscordQueue },
  { id: 'batches', el: 'dsecBatches', load: loadDiscordBatches },
  { id: 'users', el: 'dsecUsers', load: loadDiscordUsers },
  { id: 'settings', el: 'dsecSettings', load: loadDiscordSettings },
  { id: 'audit', el: 'dsecAudit', load: loadDiscordAudit },
];

function setDiscordSection(section: DiscordSection): void {
  discordSection = section;
  try { localStorage.setItem(DISCORD_STATE_KEY, section); } catch { /* ignore */ }
  document.querySelectorAll<HTMLElement>('#discordSubnav .adm-dsubnav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dsec === section);
  });
  for (const item of DISCORD_SECTIONS) $(item.el).hidden = item.id !== section;
  const active = DISCORD_SECTIONS.find((item) => item.id === section);
  if (active) void active.load();
}

function scheduleDiscordPoll(): void {
  window.clearInterval(discordPollTimer);
  discordPollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible' && getSession() && !$('panelDiscord').hidden) {
      void loadDiscordOverview(true);
    }
  }, 20000);
}

async function initDiscord(): Promise<void> {
  try {
    const stored = localStorage.getItem(DISCORD_STATE_KEY);
    if (stored && DISCORD_SECTIONS.some((item) => item.id === stored)) discordSection = stored as DiscordSection;
  } catch { /* ignore */ }
  await loadDiscordOverview();
  setDiscordSection(discordSection);
  scheduleDiscordPoll();
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

  /* library browser controls — the filter re-draws every card, so wait until
     typing pauses (same trick the top search box uses) instead of doing it on
     every single letter. */
  let libFilterTimer: number | undefined;
  $('libSearchInput').addEventListener('input', () => {
    libQuery = ($('libSearchInput') as HTMLInputElement).value.trim();
    window.clearTimeout(libFilterTimer);
    libFilterTimer = window.setTimeout(() => renderLibGrid(), 150);
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
    if (act === 'play') {
      const entry = buildLibEntries().find((item) => item.path === path);
      if (entry) playTrackPreview(entry);
    } else if (act === 'ren') {
      void openEditTrackModal(path);
    } else if (act === 'cov') {
      pickLibCover(path);
    } else if (act === 'del') {
      openDeleteModal([path]);
    }
  });

  /* Artist manager */
  $('artistsRefreshBtn').addEventListener('click', () => { void loadArtistsManager(true); });
  $('artistSort').addEventListener('change', (e) => {
    artistSortMode = (e.target as HTMLSelectElement).value;
    renderArtistsGrid();
  });
  $('artistSearchInput').addEventListener('input', (e) => {
    window.clearTimeout(artistSearchTimer);
    artistSearchTimer = window.setTimeout(() => {
      artistQuery = (e.target as HTMLInputElement).value;
      renderArtistsGrid();
    }, 200);
  });
  $('artistFilters').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.adm-chip.artistf');
    if (!btn?.dataset.f) return;
    artistFilter = btn.dataset.f;
    $('artistFilters').querySelectorAll('.adm-chip.artistf').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    renderArtistsGrid();
  });
  $('artistGrid').addEventListener('click', (e) => {
    const editBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-artist-edit]');
    if (editBtn?.dataset.artistEdit) {
      openEditArtistModal(editBtn.dataset.artistEdit);
      return;
    }
    const viewBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-artist-view]');
    if (viewBtn?.dataset.artistView) {
      viewArtistSongs(viewBtn.dataset.artistView);
      return;
    }
  });

  /* Audio Preview Bar */
  initAudioPlayer();

  /* Discord / Aura Farmer */
  $('discordRefreshBtn').addEventListener('click', () => { void initDiscord(); });
  $('discordSubnav').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-dsec]');
    if (btn?.dataset.dsec) setDiscordSection(btn.dataset.dsec as DiscordSection);
  });
  $('discordQueueRefresh').addEventListener('click', () => { void loadDiscordQueue(); });
  $('discordQueueFilter').addEventListener('change', () => { void loadDiscordQueue(); });
  $('discordQueueSearch').addEventListener('input', () => {
    window.clearTimeout(discordQueueSearchTimer);
    discordQueueSearchTimer = window.setTimeout(() => { void loadDiscordQueue(); }, 250);
  });
  $('discordQueueRemove').addEventListener('click', () => { void removeDiscordQueue(); });
  $('discordQueueRetry').addEventListener('click', () => { void retryDiscordQueue(); });
  $('discordDispatchBtn').addEventListener('click', () => { void dispatchDiscordNow(); });
  $('discordBatchesRefresh').addEventListener('click', () => { void loadDiscordBatches(); });
  $('discordBatchesList').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-batch-retry]');
    if (btn?.dataset.batchRetry) void retryDiscordBatch(Number(btn.dataset.batchRetry));
  });
  $('discordUsersRefresh').addEventListener('click', () => { void loadDiscordUsers(); });
  $('discordUserSearch').addEventListener('input', () => {
    window.clearTimeout(discordUserSearchTimer);
    discordUserSearchTimer = window.setTimeout(() => { void loadDiscordUsers(); }, 250);
  });
  $('discordUsersList').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-ban]');
    if (!btn?.dataset.ban) return;
    void toggleDiscordUserBan(btn.dataset.ban, btn.dataset.banned === '1');
  });
  $('discordSettingsReload').addEventListener('click', () => { void loadDiscordSettings(); });
  $('discordSettingsSave').addEventListener('click', () => { void saveDiscordSettings(); });
  $('discordAuditRefresh').addEventListener('click', () => { void loadDiscordAudit(); });
  $('discordAuditAction').addEventListener('change', () => { void loadDiscordAudit(); });
  $('discordAuditSearch').addEventListener('input', () => {
    window.clearTimeout(discordAuditSearchTimer);
    discordAuditSearchTimer = window.setTimeout(() => { void loadDiscordAudit(); }, 250);
  });

  scheduleRunsPoll(); // replaces a fixed interval: 3s while active/expanded, else 10s
}

/* ---------- boot ---------- */
try {
  localStorage.removeItem('auraAdmin_pat');
  localStorage.removeItem('auraAdmin_repo');
} catch { /* ignore */ }

bind();
/* Repaint directory changes, never an open editor. Its fields, portrait and
   captured version belong to the draft until it is closed and reopened. */
ingestArtistDirectory(getCachedArtistDirectory());
window.addEventListener('aura:artists-updated', () => {
  const directory = getCachedArtistDirectory();
  if (directory.revision <= libArtistRevision) return;
  ingestArtistDirectory(directory);
  renderArtistsGrid();
  renderLibGrid();
  if (currentPlayingPath) {
    const entry = buildLibEntries().find((item) => item.path === currentPlayingPath);
    if (entry) $('admAudioArtist').textContent = entry.artist;
  }
});
let lastArtistRefresh = 0;
const refreshArtists = () => {
  if (!getSession() || document.visibilityState === 'hidden' || Date.now() - lastArtistRefresh < 15000) return;
  lastArtistRefresh = Date.now();
  void fetchArtistDirectory();
};
window.addEventListener('focus', refreshArtists);
window.addEventListener('online', refreshArtists);
document.addEventListener('visibilitychange', refreshArtists);
setInterval(refreshArtists, 60000);
renderQueue();
if (getSession()) unlock();
else lock();
