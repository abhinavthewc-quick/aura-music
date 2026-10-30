/* AURA — listen together: page controller.
 *
 * Owns the two screens (join, then room) and the room's lifetime. Playback is
 * driven entirely by the room: this device downloads the track straight from
 * the shared catalogue and converges on the server's clock, exactly like every
 * other listener's.
 */

import { RoomClient } from './roomClient';
import { WebSocketTransport } from './wsTransport';
import { resolveTrack } from './appTarget';
import { WebAudioTarget } from './audioEngine';
import { setRoomActive } from './roomFlag';
import { ensureCatalog, refreshCatalog, onCatalogRefreshed } from './catalogReady';
import { state, trackKey, rebuildSongs } from '../core/state';
import { DEFAULT_COVER } from '../core/catalog';
import type { RoomView } from './roomClient';
import { DRIFT_HARD_MS, DRIFT_SOFT_MS, type ChatMessage } from './protocol';

const NAME_KEY = 'auraRoomName_v1';
const ROOM_KEY = 'auraRecentRooms_v1';
const PILL_COUNT = 8;
const SWEEP_MS = 2000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const NAMES = ['listener', 'guest', 'sunny', 'quiet one', 'night owl', 'roadtrip'];

let client: RoomClient | null = null;
let transport: WebSocketTransport | null = null;
let audio: WebAudioTarget | null = null;
let unsub: (() => void) | null = null;
let liveTimer: number | null = null;
let catalogTimer: number | null = null;
let sweepRaf = 0;
let pills: HTMLElement[] = [];

/* Render diffing: the room view re-paints on every server message, and
   messages used to arrive constantly (pings, queue broadcasts). Rebuild only
   the sub-views whose inputs actually changed. */
let lastQueueSig = '';
let lastPeopleSig = '';
let lastRenderRole = '';
let lastLibQuery = '';
let lastUnresolvedRefresh = 0;
let scrubbing = false;
let scrubPreviewMs = 0;

/* This device's output band and trim, persisted per room so the choice
   survives a reconnect. The server is authoritative; this is the local echo. */
let myPart: 'full' | 'bass' | 'highs' = 'full';
let myTrim = 0;

/* ---------------- small helpers ---------------- */

function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function rememberedName(): string {
  return localStorage.getItem(NAME_KEY) || '';
}

function rememberRoom(id: string, key?: string) {
  try {
    const map = JSON.parse(localStorage.getItem(ROOM_KEY) || '{}');
    if (key) map[id] = key;
    localStorage.setItem(ROOM_KEY, JSON.stringify(map));
  } catch { /* storage unavailable */ }
}

function rememberedKey(id: string): string | null {
  try { return (JSON.parse(localStorage.getItem(ROOM_KEY) || '{}'))[id] || null; }
  catch { return null; }
}

function setPlayIcon(playing: boolean) {
  const icon = document.getElementById('playIcon');
  if (icon) icon.setAttribute('href', playing ? '#i-pause' : '#i-play');
}

function banner(text: string) {
  const el = $('banner');
  el.textContent = text;
  el.hidden = !text;
}

function buildPills() {
  const wrap = $('pills');
  wrap.innerHTML = '';
  pills = [];
  for (let i = 0; i < PILL_COUNT; i++) {
    const el = document.createElement('i');
    wrap.appendChild(el);
    pills.push(el);
  }
}


/* ---------------- library explorer ----------------
 * Search runs entirely on this device against the catalogue already in memory,
 * so results are instant and cost nothing. Filtering happens through
 * resolveTrack(), so anything listed here is guaranteed to be playable by
 * every listener — no "not in your library" dead ends. */

const MAX_RESULTS = 60;
let libIndex: { key: string; title: string; artist: string; img: string }[] = [];

function rebuildLibIndex(): void {
  libIndex = [];
  const seen = new Set<string>();
  for (const song of state.songs) {
    const key = trackKey(song);
    if (seen.has(key)) continue;
    if (!resolveTrack(key)) continue;   // must be shareable
    seen.add(key);
    libIndex.push({
      key,
      title: String(song.title || 'Unknown'),
      artist: String(song.artist || 'Unknown artist'),
      img: String(song.img || ''),
    });
  }
  const el = $('libTotal');
  if (el) el.textContent = libIndex.length ? String(libIndex.length) : '';
}

/** Split on the query so we can highlight the matched part without innerHTML. */
function matches(title: string, artist: string, q: string): boolean {
  return title.toLowerCase().includes(q) || artist.toLowerCase().includes(q);
}

function renderResults(q: string): void {
  const ul = $('libResults');
  ul.innerHTML = '';
  const query = q.trim().toLowerCase();

  if (!query) {
    const li = document.createElement('li');
    li.className = 'lib-empty';
    li.textContent = 'Type to search. Results update as you type.';
    ul.appendChild(li);
    return;
  }

  const hits = libIndex.filter((t) => matches(t.title, t.artist, query)).slice(0, MAX_RESULTS);

  if (!hits.length) {
    const li = document.createElement('li');
    li.className = 'lib-empty';
    li.textContent = `Nothing in the library matches “${q.trim()}”.`;
    ul.appendChild(li);
    return;
  }

  const isAdmin = client?.isAdmin ?? false;

  for (const t of hits) {
    const li = document.createElement('li');

    if (t.img) {
      const img = document.createElement('img');
      img.className = 'art-sm';
      img.src = t.img;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      li.appendChild(img);
    }

    const txt = document.createElement('span');
    txt.className = 'txt';
    const t1 = document.createElement('span');
    t1.className = 't';
    t1.textContent = t.title;
    const t2 = document.createElement('span');
    t2.className = 'a';
    t2.textContent = t.artist;
    txt.appendChild(t1);
    txt.appendChild(t2);
    li.appendChild(txt);

    const btn = document.createElement('button');
    btn.className = 'add-btn';
    btn.textContent = 'Add';
    // Listeners can browse but not change the queue.
    if (!isAdmin) {
      btn.disabled = true;
      btn.title = 'Only admins can change the queue';
    } else {
      btn.onclick = () => {
        client?.queueAdd(t.key);
        btn.textContent = 'Added';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = 'Add'; btn.disabled = false; }, 1100);
      };
    }
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

/* ---------------- join screen ---------------- */

function showJoin() {
  $('joinView').hidden = false;
  $('roomView').hidden = true;
  $('codeInput').value = '';
}

function randomName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)] + Math.floor(Math.random() * 90 + 10);
}

function wireJoin() {
  $('nameInput').value = rememberedName();
  $('shuffleName').onclick = () => { $('nameInput').value = randomName(); $('nameInput').focus(); };

  $('codeInput').addEventListener('input', () => {
    $('codeInput').value = $('codeInput').value.toLowerCase().replace(/[^a-z0-9]/g, '');
  });
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

  $('joinBtn').onclick = () => {
    const code = $('codeInput').value.trim();
    const name = $('nameInput').value.trim();
    if (!code) { $('codeInput').focus(); return; }
    if (!name) { $('nameInput').focus(); return; }
    localStorage.setItem(NAME_KEY, name);
    void join(code, rememberedKey(code), false);
  };

  $('createBtn').onclick = () => {
    const name = $('nameInput').value.trim() || rememberedName() || randomName();
    localStorage.setItem(NAME_KEY, name);
    void create(name);
  };
}

async function create(name: string) {
  banner('');
  $('createBtn').disabled = true;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create' }),
    });
    if (!res.ok) throw new Error(`could not create a room (${res.status})`);
    const info = await res.json();
    rememberRoom(info.roomId, info.adminKey);
    await join(info.roomId, info.adminKey, true);
  } catch (err) {
    banner((err as Error).message);
  } finally {
    $('createBtn').disabled = false;
  }
}

/* ---------------- joining ---------------- */

async function join(roomId: string, adminKey: string | null, isHost: boolean) {
  banner('');
  const name = $('nameInput').value.trim() || rememberedName() || randomName();

  // The catalogue may still be in flight; waiting avoids "not available"
  // on the very first track a room plays.
  await ensureCatalog(6000);

  let wsBase = '';
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'exists', roomId }),
    });
    wsBase = (await res.json()).wsBase || '';
  } catch { /* reported below */ }

  if (!wsBase) { banner('Rooms are unavailable right now. Try again in a moment.'); return; }

  const clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  transport = new WebSocketTransport({
    baseUrl: wsBase, roomId, clientId, name,
    ...(adminKey ? { adminKey } : {}),
  });

  // Room playback runs on Web Audio rather than an <audio> element, so that
  // the playhead is computed from a high-resolution clock and corrected for
  // this device's own output latency. Everything the app needs is read back
  // through the client's view, so nothing else has to touch the engine.
  audio = new WebAudioTarget({
    resolve: resolveTrack,
    onEnded: () => client?.trackEnded(),
    onError: (message) => banner(message),
  });

  client = new RoomClient(
    { roomId, ...(adminKey ? { ownerKey: adminKey } : {}) },
    transport, clientId, audio,
  );
  client.onChat = pushChat;

  try {
    await transport.connect();
  } catch (err) {
    banner((err as Error).message);
    client = null; transport = null;
    return;
  }

  client.join(name);
  unsub = client.subscribe(render);
  setRoomActive(true);
  wirePartPicker(roomId);
  // Expose for debugging (like dev harness)
  (window as any).__room = () => client;
  console.log('[page] wirePartPicker done, __room set');
  history.replaceState(null, '', `/rooms?r=${roomId}${adminKey ? '&k=' + adminKey : ''}`);

  $('joinView').hidden = true;
  $('roomView').hidden = false;
  $('roomCode').textContent = roomId;
  buildPills();
  startLiveLoop();
  render(client.view());

  // Autoplay policy: the join click is the gesture. If it is ever missed we
  // pick audio up on the next interaction rather than sitting silent.
  armAutoplay();
}

function armAutoplay() {
  // The context stays suspended until the browser sees a real gesture. If the
  // join click did not count (or the user came back later), pick audio up on
  // the next interaction rather than sitting silent.
  const resume = () => client?.resumeIfBlocked();
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(ev, resume, { passive: true });
  }
}

/* ---------------- leaving ---------------- */

let catalogUnsub: (() => void) | null = null;
const catalogKeepers = new Array<() => void>();

function leave() {
  cancelAnimationFrame(sweepRaf);
  if (liveTimer !== null) { clearInterval(liveTimer); liveTimer = null; }
  if (catalogTimer !== null) { clearTimeout(catalogTimer); catalogTimer = null; }
  catalogUnsub?.(); catalogUnsub = null;
  catalogKeepers.forEach((off) => off());
  catalogKeepers.length = 0;
  unsub?.(); unsub = null;
  client?.leave(); client = null; transport = null;
  audio?.dispose(); audio = null;
  setRoomActive(false);
  try { history.replaceState(null, '', '/rooms'); } catch { /* ignore */ }
  showJoin();
}

/* ---------------- live readouts ---------------- */

function startLiveLoop() {
  if (liveTimer !== null) clearInterval(liveTimer);
  liveTimer = window.setInterval(live, 500);
  live();
  cancelAnimationFrame(sweepRaf);
  const sweep = () => {
    stepSweep();
    sweepRaf = requestAnimationFrame(sweep);
  };
  sweepRaf = requestAnimationFrame(sweep);
}

/**
 * The sweep is driven by SERVER time, not local time. That is the whole point:
 * every device lights the same pill at the same instant, so the bar is a shared
 * "we are together" signal rather than a local animation.
 */
function stepSweep() {
  const v = client?.view();
  if (!v || !v.inSync || !v.clockReady) return;
  const phase = v.serverNow % SWEEP_MS;
  const idx = Math.floor((phase / SWEEP_MS) * PILL_COUNT);
  for (let i = 0; i < pills.length; i++) pills[i].classList.toggle('on', i === idx);
}

function live() {
  const v = client?.view();
  if (!v) return;

  const pos = v.positionMs;
  const dur = v.durationMs;
  if (!scrubbing) {
    $('tCur').textContent = fmt(pos);
    const pct = dur ? Math.max(0, Math.min(100, (pos / dur) * 100)) : 0;
    ($('fill') as HTMLElement).style.width = pct + '%';
    ($('knob') as HTMLElement).style.left = pct + '%';
  }
  $('tDur').textContent = dur ? fmt(dur) : '–:––';
  const seekBar = $('seekBar');
  const pct = dur ? Math.max(0, Math.min(100, (pos / dur) * 100)) : 0;
  seekBar.setAttribute('aria-valuenow', String(Math.round(pct)));
  seekBar.setAttribute('aria-valuetext', fmt(pos));

  // A device whose audio is blocked by autoplay policy is the one case where
  // nothing we do server-side can help, so ask for a gesture instead.
  const blocked = v.playback.playing && v.blocked;
  $('listenHint').hidden = !blocked;
  $('loadHint').hidden = !v.loading;

  // Countdown to the one moment everyone agreed to begin.
  const starting = v.startInMs != null;
  $('countdown').hidden = !starting;
  if (starting) {
    // Round up so it reads 4,3,2,1 and hits GO exactly on the agreed instant
    // rather than a frame early.
    $('countdownNum').textContent = String(Math.max(1, Math.ceil((v.startInMs ?? 0) / 1000)));
  }

  const bar = $('syncbar');
  bar.hidden = !v.clockReady || starting;
  const meta = $('driftLabel').parentElement!;
  if (starting) {
    $('syncLabel').textContent = 'waiting for everyone';
    $('driftLabel').textContent = v.loading ? 'loading' : 'ready';
    meta.className = 'syncmeta ok';
  } else if (blocked) {
    $('syncLabel').textContent = 'waiting for you';
    $('driftLabel').textContent = '';
    meta.className = 'syncmeta warn';
  } else {
    $('syncLabel').textContent = v.nudging ? 'gently correcting' : 'in sync';
    $('driftLabel').textContent =
      `${v.driftMs} ms${v.outputLatencyMs != null ? ` · ${v.outputLatencyMs} ms out` : ''}`;
    meta.className = v.inSync ? 'syncmeta ok' : 'syncmeta warn';
  }
}

/* ---------------- rendering ---------------- */

function peopleSig(v: RoomView): string {
  return v.participants.map((p) => `${p.id}:${p.role}:${p.part}`).join('¬');
}

function queueSig(v: RoomView): string {
  return `${v.playback.trackKey ?? ''}¬${v.queue.join('¬')}`;
}

/** Refresh the search results only when the query or the role/lib changed. */
function maybeRenderResults(): void {
  const input = $('libSearch') as HTMLInputElement;
  const query = input.value;
  if (vRoleDirty || query !== lastLibQuery) {
    vRoleDirty = false;
    lastLibQuery = query;
    renderResults(query);
  }
}

let vRoleDirty = false;

/* Apply this device's output band to the audio graph and to the engine's
   correction bands. Only ever called with the server's answer: the referee
   may refuse a band (one bass anchor per room), so a click is echoed back
   before anything changes audibly. */
function applyPart(part: 'full' | 'bass' | 'highs'): void {
  myPart = part;
  audio?.setPart(part);
  audio?.setTrim(part, myTrim);
  // Split playback puts two devices into one physical space, where their
  // errors sum instead of averaging out — so hold them to a tighter drift
  // budget than a room of independent listeners gets.
  client?.setBands(
    part === 'full' ? DRIFT_SOFT_MS : 8,
    part === 'full' ? DRIFT_HARD_MS : 80,
  );
}

function render(v: RoomView) {
  const isAdmin = v.role === 'admin';

  // The server is authoritative for this device's part; correct the local echo
  // if it disagreed (e.g. the bass anchor was already taken).
  const yourPart = v.you?.part ?? 'full';
  if (yourPart !== myPart) {
    myPart = yourPart;
    const wrap = $('partPick');
    if (wrap) {
      for (const b of wrap.querySelectorAll('.part-btn')) {
        b.classList.toggle('active', b.dataset.part === myPart);
      }
    }
    applyPart(myPart);
  }

  const anchor = v.participants.find((p) => p.part === 'bass' && p.id !== v.you?.id);
  const hint = $('partHint') as HTMLElement | null;
  if (hint) {
    if (myPart === 'bass') hint.textContent = 'You are the bass anchor.';
    else if (anchor) hint.textContent = `Bass anchor is ${anchor.name}.`;
    else hint.textContent = '';
  }

  const trimWrap = $('trimWrap') as HTMLElement | null;
  if (trimWrap) trimWrap.hidden = myPart === 'full';

  $('roomCode').textContent = v.roomId;
  const pill = $('rolePill');
  if (v.role !== lastRenderRole) {
    lastRenderRole = v.role;
    pill.textContent = v.role;
    pill.className = 'role-pill' + (isAdmin ? ' admin' : '');
    vRoleDirty = true; // Add buttons depend on role
  }

  $('liveDot').classList.toggle('pulse', !v.closed);
  setPlayIcon(v.playback.playing);

  // Controls: admins drive. Listeners still see them so the screen does not
  // change shape between people, but they are inert.
  for (const id of ['playBtn', 'nextBtn', 'prevBtn', 'seekBar']) {
    ($(id) as HTMLButtonElement).disabled = !isAdmin;
  }

  const track = v.playback.trackKey ? resolveTrack(v.playback.trackKey) : null;
  if (track) {
    $('nowTitle').textContent = track.title;
    $('nowArtist').textContent = track.artist;
  } else {
    $('nowTitle').textContent = 'Nothing playing';
    $('nowArtist').textContent = isAdmin ? 'Queue a track to start' : 'Waiting for the host';
  }
  const art = $('artImg') as HTMLImageElement;
  art.src = track?.img || DEFAULT_COVER;

  // Queue: rebuild only when it actually changed.
  if (queueSig(v) !== lastQueueSig) {
    lastQueueSig = queueSig(v);
    const q = $('queueList');
    q.innerHTML = '';
    $('qCount').textContent = String(v.queue.length);
    if (!v.queue.length) {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = isAdmin ? 'Nothing queued — add what you are playing' : 'Nothing queued yet';
      q.appendChild(li);
    }
    v.queue.forEach((key, i) => {
      const t = resolveTrack(key);
      const li = document.createElement('li');
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = t ? `${t.title} — ${t.artist}` : 'not in your library';
      li.appendChild(idx); li.appendChild(nm);
      if (isAdmin) {
        const rm = document.createElement('button');
        rm.className = 'promo';
        rm.textContent = '✕';
        rm.title = 'Remove from queue';
        rm.onclick = () => client?.queueRemove(key);
        li.appendChild(rm);
      }
      q.appendChild(li);
    });

    // A just-uploaded track can resolve late: if anything in the room still
    // shows "not in your library", pick up the fresh catalogue.
    const unresolved = v.queue.some((key) => !resolveTrack(key));
    if (unresolved && Date.now() - lastUnresolvedRefresh > 20_000) {
      lastUnresolvedRefresh = Date.now();
      void refreshLibrary();
    }
  } else {
    $('qCount').textContent = String(v.queue.length);
  }

  // People: rebuild only when the roster changed.
  if (peopleSig(v) !== lastPeopleSig) {
    lastPeopleSig = peopleSig(v);
    const pl = $('peopleList');
    pl.innerHTML = '';
    $('pCount').textContent = String(v.participants.length);
    for (const p of v.participants) {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      if (p.role === 'admin') {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('class', 'star');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#i-star');
        s.appendChild(use);
        who.appendChild(s);
      }
      const nm = document.createElement('span');
      nm.textContent = p.name;
      who.appendChild(nm);
      if (p.part !== 'full') {
        const badge = document.createElement('span');
        badge.className = 'part-badge';
        badge.textContent = p.part === 'bass' ? 'SUB' : 'HIGHS';
        who.appendChild(badge);
      }
      if (v.you && p.id === v.you.id) {
        const me = document.createElement('span');
        me.className = 'me-tag';
        me.textContent = 'you';
        who.appendChild(me);
      }
      li.appendChild(who);
      if (isAdmin && v.you && p.id !== v.you.id) {
        const b = document.createElement('button');
        b.className = 'promo';
        b.textContent = p.role === 'admin' ? 'remove admin' : 'make admin';
        b.onclick = () => (p.role === 'admin' ? client?.demote(p.id) : client?.promote(p.id));
        li.appendChild(b);
      }
      pl.appendChild(li);
    }
  } else {
    $('pCount').textContent = String(v.participants.length);
  }

  maybeRenderResults();

  if (v.closed) banner(`This room has closed — ${v.closed}`);

  // A track the room is playing that nobody can resolve yet: the catalogue
  // may have been updated since this device joined.
  if (v.playback.trackKey && !track && Date.now() - lastUnresolvedRefresh > 20_000) {
    lastUnresolvedRefresh = Date.now();
    void refreshLibrary();
  }

  live();
}

function pushChat(m: ChatMessage) {
  const log = $('chatLog');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'm';
  const b = document.createElement('b');
  b.textContent = m.name;
  const span = document.createElement('span');
  span.textContent = m.text;
  div.appendChild(b);
  div.appendChild(span);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}


/* ---------------- seeking ---------------- */

function renderScrub(ms: number): void {
  const dur = client?.view().durationMs ?? 0;
  if (!dur) return;
  const pct = Math.max(0, Math.min(100, (ms / dur) * 100));
  ($('fill') as HTMLElement).style.width = pct + '%';
  ($('knob') as HTMLElement).style.left = pct + '%';
  $('tCur').textContent = fmt(ms);
}

function seekFromEvent(e: PointerEvent | MouseEvent): void {
  const bar = $('seekBar');
  const dur = client?.view().durationMs ?? 0;
  if (!dur || !client?.isAdmin) return;
  const r = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  scrubPreviewMs = Math.round(ratio * dur);
  renderScrub(scrubPreviewMs);
}

function wireSeek(): void {
  const bar = $('seekBar');

  bar.addEventListener('pointerdown', (e) => {
    if (!client?.isAdmin) return;
    scrubbing = true;
    bar.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  bar.addEventListener('pointermove', (e) => { if (scrubbing) seekFromEvent(e); });
  bar.addEventListener('pointerup', (e) => {
    scrubbing = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (client?.isAdmin) client.seek(scrubPreviewMs);
  });
  bar.addEventListener('pointercancel', () => { scrubbing = false; });

  bar.addEventListener('keydown', (e) => {
    if (!client?.isAdmin) return;
    const v = client.view();
    if (!v.durationMs) return;
    const step = e.shiftKey ? 10_000 : 5_000;
    if (e.key === 'ArrowRight') { e.preventDefault(); client.seek(Math.min(v.durationMs, v.positionMs + step)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); client.seek(Math.max(0, v.positionMs - step)); }
  });
}

/* ---------------- controls ---------------- */

let wirePartPickerDone = false;

function wirePartPicker(roomId: string): void {
  if (wirePartPickerDone) {
    console.log('[page] wirePartPicker already done, skipping');
    return;
  }
  console.log('[page] wirePartPicker called for room:', roomId);
  const wrap = $('partPick');
  const trimWrap = $('trimWrap') as HTMLElement | null;
  const slider = $('trimSlider') as HTMLInputElement | null;
  const trimVal = $('trimVal') as HTMLElement | null;
  if (!wrap || !slider || !trimVal) {
    console.warn('[page] wirePartPicker: missing elements', { wrap: !!wrap, slider: !!slider, trimVal: !!trimVal });
    return;
  }
  // ... rest of function

  const btns = wrap.querySelectorAll('.part-btn');
  const select = (part: string) => {
    btns.forEach((b) => b.classList.toggle('active', b.dataset.part === part));
  };
  select(myPart);
  if (trimWrap) trimWrap.hidden = myPart === 'full';

  // Add click handlers FIRST, before any localStorage access that might throw
  btns.forEach((b) => {
    b.addEventListener('click', () => {
      const part = b.dataset.part as 'full' | 'bass' | 'highs';
      console.log('[page] part button clicked:', part);
      client?.setPart(part);
    });
  });

  // Then load trim (localStorage access wrapped in try-catch)
  try {
    const saved = localStorage.getItem(`auraRoomTrim_${roomId}`);
    myTrim = saved ? Number(saved) : 0;
    if (!Number.isFinite(myTrim)) myTrim = 0;
    slider.value = String(myTrim);
    trimVal.textContent = String(myTrim);
    audio?.setTrim(myPart, myTrim);
  } catch (err) {
    console.warn('[page] wirePartPicker: localStorage error', err);
    myTrim = 0;
    slider.value = '0';
    trimVal.textContent = '0';
  }

  if (trimWrap) trimWrap.hidden = myPart === 'full';

  slider.addEventListener('input', () => {
    myTrim = Number(slider.value);
    trimVal.textContent = String(myTrim);
    try {
      localStorage.setItem(`auraRoomTrim_${roomId}`, String(myTrim));
    } catch (err) {
      console.warn('[page] wirePartPicker: localStorage setItem error', err);
    }
    audio?.setTrim(myPart, myTrim);
  });
}

function wireRoom() {
  $('playBtn').onclick = () => client?.toggle();
  $('nextBtn').onclick = () => client?.queueNext();
  $('prevBtn').onclick = () => {
    // Restart the current track — the simplest thing that is never wrong.
    if (client) client.seek(0);
  };
  $('leaveBtn').onclick = leave;

  $('copyBtn').onclick = async () => {
    const url = `${location.origin}/rooms?r=${client?.view().roomId ?? ''}`;
    try {
      await navigator.clipboard.writeText(url);
      const b = $('copyBtn');
      b.classList.add('done');
      setTimeout(() => b.classList.remove('done'), 1400);
    } catch { banner('Could not copy — the link is in the address bar.'); }
  };

  const libSearch = $('libSearch') as HTMLInputElement;
  let libTimer: number | undefined;
  libSearch.addEventListener('input', () => {
    window.clearTimeout(libTimer);
    // Cheap enough to feel live, but coalesce fast typing so a 576-track
    // scan does not run once per keystroke.
    libTimer = window.setTimeout(() => renderResults(libSearch.value), 90);
  });

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const input = $('chatInput') as HTMLInputElement;
    const text = input.value.trim();
    if (!text || !client) return;
    client.say(text);
    input.value = '';
  };
}

async function refreshLibrary() {
  await refreshCatalog();
  rebuildLibIndex();
  maybeRenderResults();
  if (client) render(client.view());
}

function startCatalogKeepAlive() {
  if (catalogTimer !== null) return;
  const tick = async () => {
    if (document.visibilityState === 'visible') await refreshLibrary();
    catalogTimer = window.setTimeout(tick, 30_000);
  };
  catalogTimer = window.setTimeout(tick, 30_000);
}

function wireCatalogRefresh(): void {
  // Pick up newly uploaded tracks without reloading: when the tab comes back
  // into view, on focus, on a timer while the room is open, and whenever any
  // other tab (the admin uploader, say) refreshes the catalogue.
  catalogUnsub = onCatalogRefreshed(() => { void refreshLibrary(); });
  const onVisible = () => { if (document.visibilityState === 'visible') void refreshLibrary(); };
  const onFocus = () => void refreshLibrary();
  window.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onFocus);
  catalogKeepers.push(
    () => window.removeEventListener('visibilitychange', onVisible),
    () => window.removeEventListener('focus', onFocus),
  );
  startCatalogKeepAlive();
}

/* ---------------- boot ---------------- */

async function boot() {
  wireJoin();
  wireRoom();
  wireSeek();
  buildPills();
  showJoin();

  // The shared catalogue: paint from cache immediately, refresh from the
  // bucket, and keep refreshing so newly uploaded tracks show up live.
  rebuildSongs();
  await ensureCatalog(6000);
  rebuildLibIndex();
  renderResults('');

  wireCatalogRefresh();

  // Deep link: /rooms?r=CODE&k=KEY
  const q = new URLSearchParams(location.search);
  const roomId = (q.get('r') || (location.hash.match(/^#\/room\/([a-z0-9]+)/i)?.[1] ?? '')).toLowerCase();
  if (roomId) {
    $('codeInput').value = roomId;
    const key = q.get('k') || rememberedKey(roomId);
    if (key) {
      const name = rememberedName();
      if (name) $('nameInput').value = name;
      void join(roomId, key, true);
    }
  }
}

void boot();
// UNIQUE_STRING_1793388547
