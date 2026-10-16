/* Listening rooms — the user-facing side.
 *
 * Responsibilities are deliberately narrow: join a room, show what the room is
 * doing, and let admins drive it. All authority is enforced by the server; this
 * only hides controls the viewer cannot use.
 *
 * The room borrows the normal player (state.audio via the sync target), so the
 * track, artwork and seek bar on the main page stay truthful.
 */

import { escapeHtml } from './radio';
import { $, state, trackKey } from '../core/state';
import { RoomClient, type RoomView } from '../rooms/roomClient';
import { WebSocketTransport } from '../rooms/wsTransport';
import { createAppTarget, resolveTrack, roomModeActive, setRoomActive } from '../rooms/appTarget';
import { ensureCatalog } from '../rooms/catalogReady';

const RECENT_KEY = 'auraRecentRooms_v1';
const NAME_KEY = 'auraRoomName_v1';

let client: RoomClient | null = null;
let unsubscribe: (() => void) | null = null;
let transport: WebSocketTransport | null = null;
let pollTimer: number | null = null;

const $id = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- helpers ---------- */

function rememberedName(): string {
  return localStorage.getItem(NAME_KEY) || '';
}

function rememberRoom(roomId: string, adminKey?: string) {
  let map: Record<string, string> = {};
  try { map = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}'); } catch { /* fresh */ }
  if (adminKey) map[roomId] = adminKey;
  localStorage.setItem(RECENT_KEY, JSON.stringify(map));
  // Keep only the most recent handful.
  const keys = Object.keys(map);
  if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete map[k];
  localStorage.setItem(RECENT_KEY, JSON.stringify(map));
}

function rememberedKey(roomId: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
    return map[roomId] || null;
  } catch {
    return null;
  }
}

export async function createRoom(): Promise<void> {
  setStatus('creating a room…');
  let created: { roomId: string; adminKey: string };
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create' }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `server said ${res.status}`);
    created = await res.json();
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, true);
    return;
  }
  rememberRoom(created.roomId, created.adminKey);
  await joinRoom(created.roomId, created.adminKey, true);
}

export async function joinRoom(roomId: string, adminKey: string | null, isHost = false): Promise<void> {
  if (client) leaveRoom(false);
  openPanel();

  // Show a name prompt before connecting: the click also satisfies the
  // browser's autoplay policy, which matters a moment later.
  const name = await askName();
  if (!name) { closePanel(); return; }

  setStatus('connecting…');

  // The catalogue may not have landed yet; waiting avoids "track unavailable"
  // the moment a room starts playing.
  await ensureCatalog(4000);

  const clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let wsBase = (window as unknown as { AURA_ROOMS_WS?: string }).AURA_ROOMS_WS || '';

  if (!wsBase) {
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'exists', roomId }),
      });
      const info = await res.json();
      if (info?.wsBase) wsBase = info.wsBase;
    } catch { /* fall through to the error below */ }
  }

  if (!wsBase) {
    setStatus('✗ rooms are not available right now', true);
    return;
  }

  transport = new WebSocketTransport({
    baseUrl: wsBase,
    roomId,
    clientId,
    name,
    ...(adminKey ? { adminKey } : {}),
  });

  client = new RoomClient({ roomId, ...(adminKey ? { ownerKey: adminKey } : {}) }, transport, clientId, createAppTarget());
  client.onChat = (m) => appendChat(m.name, m.text);

  try {
    await transport.connect();
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, true);
    client = null;
    transport = null;
    return;
  }

  client.join(name);
  unsubscribe = client.subscribe(render);
  setRoomActive(true);
  if (isHost) history.replaceState(null, '', `#/room/${roomId}?k=${adminKey}`);
  else history.replaceState(null, '', `#/room/${roomId}`);

  // While in a room the engine owns playback; this surfaces drift honestly.
  startPolling();
  render(client.view());
  setStatus('');
}

export function leaveRoom(notify = true): void {
  if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
  unsubscribe?.(); unsubscribe = null;
  client?.leave();
  client = null;
  transport = null;
  setRoomActive(false);
  // Hand playback back to the personal player.
  state.audio.pause();
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  if (notify) { closePanel(); toast('Left the room'); }
}

function startPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (client) render(client.view());
  }, 700);
}

function toast(text: string) {
  const el = document.getElementById('roomStatus');
  if (el) { el.textContent = text; el.className = 'room-note'; }
}

/* ---------- rendering ---------- */

function openPanel() { $id('roomPanel').classList.add('open'); $id('roomFab').classList.add('show'); }
function closePanel() { $id('roomPanel').classList.remove('open'); $id('roomFab').classList.remove('show'); }
export function togglePanel() { $id('roomPanel').classList.toggle('open'); }

function setStatus(text: string, isError = false) {
  const el = $id('roomStatus');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'room-note v warn' : 'room-note';
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function appendChat(name: string, text: string) {
  const log = $id('roomChatLog');
  if (!log) return;
  if (log.querySelector('.empty')) log.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'm';
  const b = document.createElement('b');
  b.textContent = name;
  const span = document.createElement('span');
  span.textContent = text;
  div.appendChild(b);
  div.appendChild(span);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function render(v: RoomView) {
  if (!client) return;

  $id('roomCode').textContent = v.roomId;
  $id('roomRole').textContent = v.role;
  $id('roomRole').className = v.role === 'admin' ? 'v ok' : 'v';

  // People
  const people = $id('roomPeople');
  people.innerHTML = '';
  for (const p of v.participants) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.name + (v.you && p.id === v.you.id ? ' (you)' : '');
    if (v.you && p.id === v.you.id) name.className = 'me';
    if (p.role === 'admin') {
      const star = document.createElement('span');
      star.className = 'star';
      star.textContent = '★';
      star.title = 'admin';
      li.appendChild(star);
    }
    li.appendChild(name);
    if (v.role === 'admin' && v.you && p.id !== v.you.id) {
      const btn = document.createElement('button');
      btn.textContent = p.role === 'admin' ? 'demote' : 'make admin';
      btn.onclick = () => (p.role === 'admin' ? client!.demote(p.id) : client!.promote(p.id));
      li.appendChild(btn);
    }
    people.appendChild(li);
  }

  // Queue (read-only for listeners, per the design)
  const queue = $id('roomQueue');
  queue.innerHTML = '';
  if (!v.queue.length) {
    const li = document.createElement('li');
    li.textContent = v.role === 'admin' ? 'nothing queued — add tracks from your library' : 'nothing queued';
    li.style.color = '#6f6152';
    queue.appendChild(li);
  }
  v.queue.forEach((key, i) => {
    const track = resolveTrack(key);
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1) + '.';
    const t = document.createElement('span');
    t.textContent = track ? `${track.title} — ${track.artist}` : 'a track not in your library';
    li.appendChild(n);
    li.appendChild(t);
    if (v.role === 'admin') {
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.title = 'remove from queue';
      rm.onclick = () => client!.queueRemove(key);
      li.appendChild(rm);
    }
    queue.appendChild(li);
  });

  // Status lines
  const track = v.playback.trackKey ? resolveTrack(v.playback.trackKey) : null;
  $id('roomNow').textContent = track ? `${track.title} — ${track.artist}` : '—';
  $id('roomState').textContent = v.playback.playing ? 'playing' : 'paused';
  $id('roomPos').textContent = fmt(state.audio.currentTime * 1000);
  $id('roomDrift').textContent = `${v.driftMs} ms`;
  $id('roomDrift').className = v.inSync ? 'v ok' : 'v warn';

  // Controls
  const isAdmin = v.role === 'admin';
  ($id('roomPlay') as HTMLButtonElement).disabled = !isAdmin;
  ($id('roomSkip') as HTMLButtonElement).disabled = !isAdmin;
  ($id('roomClearQueue') as HTMLButtonElement).disabled = !isAdmin;
  $id('roomListenerNote').style.display = isAdmin ? 'none' : '';
  $id('roomAdminNote').style.display = isAdmin ? '' : 'none';
  $id('roomPlay').textContent = v.playback.playing ? 'Pause' : 'Play';

  if (v.closed) {
    setStatus(`room closed: ${v.closed}`, true);
    $id('roomBody').innerHTML = '';
  }
}

/* ---------- name prompt ---------- */

function askName(): Promise<string | null> {
  const body = $id('roomBody');
  const saved = rememberedName();

  return new Promise((resolve) => {
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'room-locked';
    const label = document.createElement('b');
    label.textContent = 'What should everyone call you?';
    const box = document.createElement('input');
    box.placeholder = saved || 'your name';
    box.maxLength = 20;
    const go = document.createElement('button');
    go.textContent = 'Join';
    go.onclick = () => {
      const name = box.value.trim();
      if (!name) { box.focus(); return; }
      localStorage.setItem(NAME_KEY, name);
      body.innerHTML = '';
      resolve(name);
    };
    box.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    wrap.appendChild(label);
    wrap.appendChild(box);
    wrap.appendChild(go);
    body.appendChild(wrap);
    setTimeout(() => box.focus(), 30);
  });
}

/* ---------- wiring ---------- */

export function bindRooms() {
  const fab = $id('roomFab');
  fab.onclick = togglePanel;
  $id('roomClose').onclick = closePanel;

  $id('roomCreate').onclick = () => void createRoom();
  $id('roomJoin').onclick = () => {
    const code = $id<HTMLInputElement>('roomCodeInput').value.trim().toLowerCase();
    if (!code) return;
    void joinRoom(code, rememberedKey(code));
  };
  $id<HTMLInputElement>('roomCodeInput').onkeydown = (e) => {
    if (e.key === 'Enter') $id('roomJoin').click();
  };

  $id('roomPlay').onclick = () => client?.toggle();
  $id('roomSkip').onclick = () => client?.queueNext();
  $id('roomClearQueue').onclick = () => client?.queueClear();
  $id('roomLeave').onclick = () => leaveRoom(true);

  $id<HTMLFormElement>('roomChatForm').onsubmit = (e) => {
    e.preventDefault();
    const input = $id<HTMLInputElement>('roomChatInput');
    const text = input.value.trim();
    if (!text || !client) return;
    client.say(text);
    input.value = '';
  };

  // Queue the current track from wherever the player is.
  $id('roomQueueCurrent').onclick = () => {
    const song = state.songs[state.currentIndex];
    if (!song) return;
    const key = trackKey(song);
    if (!resolveTrack(key)) { setStatus('that track is not in the shared library', true); return; }
    client?.queueAdd(key);
  };

  // Join via #/room/<id>?k=<key>
  const m = location.hash.match(/^#\/room\/([a-z0-9]+)/i);
  if (m) {
    const key = new URLSearchParams(location.hash.split('?')[1] || '').get('k') || rememberedKey(m[1]);
    openPanel();
    void joinRoom(m[1], key, !!key);
  }
}

export function roomsActive(): boolean {
  return roomModeActive();
}