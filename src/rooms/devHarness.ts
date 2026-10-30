/* Development harness for the room sync engine.
 *
 * Purpose: prove the sync protocol works between two genuinely separate
 * browsers before any server exists. It renders a deliberately plain UI and
 * plays synthesised audio, so what you are testing is the sync engine and
 * nothing else — no library loading, no catalogue fetching.
 *
 * This page is a test tool, not part of the shipped site. The engine it
 * exercises (protocol/clock/syncEngine/referee) is production code and is
 * shared with the real rooms UI.
 */

import { createAudioTarget, type ResolvedTrack } from '../rooms/audioTarget';
import { RoomClient } from '../rooms/roomClient';
import { hostRoom, isRoomHosted, LocalTransport, newId, newKey, newRoomId } from '../rooms/local';
import { WebSocketTransport } from '../rooms/wsTransport';
import type { Part } from '../rooms/protocol';

const TRACKS: ResolvedTrack[] = [
  { key: 'tone-a', videoId: 'aaa', url: makeTone(220, 180), title: 'Tone A', artist: 'synth' },
  { key: 'tone-b', videoId: 'bbb', url: makeTone(277, 180), title: 'Tone B', artist: 'synth' },
  { key: 'tone-c', videoId: 'ccc', url: makeTone(330, 180), title: 'Tone C', artist: 'synth' },
];

/* A short looping WAV, generated locally — no network, no licensing. */
function makeTone(freq: number, seconds: number): string {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // gentle fade at the seam so looping does not click
    const t = i / n;
    const env = Math.min(1, t * 20, (1 - t) * 20);
    view.setInt16(44 + i * 2, Math.sin((i / rate) * freq * 2 * Math.PI) * 12000 * env, true);
  }
  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* Part picker state for the dev harness. */
let myPart: Part = 'full';
let myTrim = 0;

/* ---------------- wiring ---------------- */

const audio = $<HTMLAudioElement>('audio');
const clientId = newId();
let client: RoomClient | null = null;
let stopHosting: (() => void) | null = null;
let hostOwnerKey: string | null = null;

const target = createAudioTarget({
  element: audio,
  resolve: (key) => TRACKS.find((t) => t.key === key) ?? null,
  onTrackChanged: (t) => { $('nowTrack').textContent = `${t.title} — ${t.artist}`; },
  onError: (m) => { $('note').textContent = m; },
});

function setStatus(text: string, kind: 'ok' | 'warn' | 'err' | '' = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

/** Wire the output band picker (full / bass / highs) and trim slider. */
function wirePartPicker(roomId: string): void {
  const wrap = $('partPick');
  const trimWrap = $('trimWrap') as HTMLElement | null;
  const slider = $('trimSlider') as HTMLInputElement | null;
  const trimVal = $('trimVal') as HTMLElement | null;
  if (!wrap || !slider || !trimVal) return;

  const btns = wrap.querySelectorAll('.part-btn');
  const select = (part: string) => {
    btns.forEach((b) => b.classList.toggle('active', b.dataset.part === part));
  };
  select(myPart);
  if (trimWrap) trimWrap.hidden = myPart === 'full';

  const loadTrim = () => {
    const saved = localStorage.getItem(`auraRoomTrim_${roomId}`);
    myTrim = saved ? Number(saved) : 0;
    if (!Number.isFinite(myTrim)) myTrim = 0;
    slider.value = String(myTrim);
    trimVal.textContent = String(myTrim);
    client?.setTrim?.(myPart, myTrim);
  };
  loadTrim();

  btns.forEach((b) => {
    b.addEventListener('click', () => {
      const part = b.dataset.part as Part;
      client?.setPart(part);
    });
  });

  slider.addEventListener('input', () => {
    myTrim = Number(slider.value);
    trimVal.textContent = String(myTrim);
    localStorage.setItem(`auraRoomTrim_${roomId}`, String(myTrim));
    client?.setTrim?.(myPart, myTrim);
  });
}

/** Update the part picker UI from the server's view. */
function updatePartPickerUI(v: any): void {
  const yourPart = v.you?.part ?? 'full';
  if (yourPart !== myPart) {
    myPart = yourPart;
    const wrap = $('partPick');
    if (wrap) {
      for (const b of wrap.querySelectorAll('.part-btn')) {
        b.classList.toggle('active', b.dataset.part === myPart);
      }
    }
    client?.setTrim?.(myPart, myTrim);
  }

  const anchor = v.participants.find((p: any) => p.part === 'bass' && p.id !== v.you?.id);
  const hint = $('partHint') as HTMLElement | null;
  if (hint) {
    if (myPart === 'bass') hint.textContent = 'You are the bass anchor.';
    else if (anchor) hint.textContent = `Bass anchor is ${anchor.name}.`;
    else hint.textContent = '';
  }

  const trimWrap = $('trimWrap') as HTMLElement | null;
  if (trimWrap) trimWrap.hidden = myPart === 'full';
}

async function start(name: string, requestedRoom: string | null, keyFromUrl: string | null) {
  if (client) { client.leave(); client = null; }
  if (stopHosting) { stopHosting(); stopHosting = null; }

  // ?server=ws://host:port switches from the in-tab referee to the real
  // Durable Object, so the same UI can be exercised against both.
  const serverBase = new URLSearchParams(location.search).get('server');

  if (serverBase) {
    await startRemote(name, requestedRoom, keyFromUrl, serverBase);
    return;
  }

  const roomId = requestedRoom || newRoomId();
  const alreadyHosted = requestedRoom ? await isRoomHosted(requestedRoom) : false;

  let ownerKey: string | undefined;
  let isHost = false;

  if (!alreadyHosted) {
    // This tab becomes the referee. Whoever creates the room holds the key.
    ownerKey = keyFromUrl || newKey();
    isHost = true;
    const handle = hostRoom(roomId, ownerKey, clientId, (reason) => {
      setStatus(`room ended: ${reason}`, 'warn');
      render();
    });
    stopHosting = handle.stop;
    client = new RoomClient({ roomId, ownerKey, isHost }, handle.transport, clientId, target);
    hostOwnerKey = ownerKey;
  } else {
    if (keyFromUrl) ownerKey = keyFromUrl;
    client = new RoomClient({ roomId, ownerKey }, new LocalTransport(roomId, clientId), clientId, target);
  }

  client.onChat = (m) => appendChat(m.name, m.text);
  client.subscribe(render);
  client.join(name);

  wirePartPicker(roomId);
  setStatus(isHost ? 'you created the room — you are the admin' : 'joined', 'ok');
  render();
}

async function startRemote(name: string, requestedRoom: string | null, keyFromUrl: string | null, base: string) {
  let roomId = requestedRoom;
  let ownerKey = keyFromUrl;

  if (!roomId) {
    // The worker registers whichever key we hand it; it never sees or returns
    // it, so the key stays ours to keep.
    const myKey = newKey();
    const res = await fetch(`${base.replace(/^ws/, 'http')}/?room=tmp${Date.now() % 100000}&action=create&k=${myKey}`);
    if (!res.ok) { setStatus('could not create a room', 'err'); return; }
    const created = await res.json();
    roomId = created.roomId;
    ownerKey = myKey;
  }

  const transport = new WebSocketTransport({
    baseUrl: base, roomId, clientId, name, ...(ownerKey ? { adminKey: ownerKey } : {}),
  });

  client = new RoomClient({ roomId, ...(ownerKey ? { ownerKey } : {}) }, transport, clientId, target);
  client.onChat = (m) => appendChat(m.name, m.text);
  client.subscribe(render);

  try {
    await transport.connect();
    client.join(name);
    wirePartPicker(roomId);
    setStatus(ownerKey && !requestedRoom ? 'connected to the room server — you are the admin' : 'connected to the room server', 'ok');
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, 'err');
  }
  render();
}

function appendChat(name: string, text: string) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = `<b></b><span></span>`;
  el.querySelector('b')!.textContent = name;
  el.querySelector('span')!.textContent = text;
  $('chat').appendChild(el);
  $('chat').scrollTop = $('chat').scrollHeight;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  const c = client;
  if (!c) return;
  const v = c.view();

  updatePartPickerUI(v);
  $('roomId').textContent = v.roomId;
  $('role').textContent = v.role;
  $('role').className = v.role === 'admin' ? 'admin' : 'listener';

  $('people').innerHTML = '';
  for (const p of v.participants) {
    const li = document.createElement('li');
    li.textContent = p.name + (p.role === 'admin' ? ' ★' : '');
    if (c.isAdmin && p.id !== clientId) {
      const b = document.createElement('button');
      b.textContent = p.role === 'admin' ? 'demote' : 'make admin';
      b.onclick = () => (p.role === 'admin' ? c.demote(p.id) : c.promote(p.id));
      li.appendChild(b);
    }
    $('people').appendChild(li);
  }

  const can = c.isAdmin;
  for (const id of ['btnPlay', 'btnNext', 'btnAdd1', 'btnAdd2']) {
    ($(id) as HTMLButtonElement).disabled = !can;
  }
  $('seek').disabled = !can;

  $('pos').textContent = fmt(audio.currentTime * 1000);
  $('dur').textContent = isFinite(audio.duration) ? fmt(audio.duration * 1000) : '–:––';
  $('drift').textContent = `${v.driftMs} ms`;
  $('offset').textContent = `${v.clockOffsetMs} ms`;
  $('sync').textContent = v.inSync ? 'in sync' : 'correcting…';
  $('sync').className = v.inSync ? 'ok' : 'warn';
  $('playState').textContent = v.playback.playing ? '▶ playing' : '❚❚ paused';

  $('adminLink').textContent = c.link;
  $('shareLink').textContent = c.shareLink;
  $('adminOnly').style.display = can ? '' : 'none';
  $('listenerNote').style.display = can ? 'none' : '';
}

/* ---------------- events ---------------- */

function readHash(): { room: string | null; key: string | null } {
  const m = location.hash.match(/^#\/room\/([a-z0-9]+)/i);
  if (!m) return { room: null, key: null };
  const key = new URLSearchParams(location.search).get('k') || new URLSearchParams(location.hash.split('?')[1] || '').get('k');
  return { room: m[1], key };
}

const { room: initialRoom, key: initialKey } = readHash();

$<HTMLButtonElement>('createBtn').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim() || 'listener';
  location.hash = '';
  await start(name, null, null);
};

$<HTMLButtonElement>('joinBtn').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim() || 'listener';
  const code = $<HTMLInputElement>('roomCode').value.trim().toLowerCase();
  await start(name, code || null, initialKey);
};

$('btnPlay').onclick = () => client?.toggle();
$('btnNext').onclick = () => client?.queueNext();
$('btnAdd1').onclick = () => client?.playTrack(TRACKS[0].key, TRACKS[0].videoId);
$('btnAdd2').onclick = () => client?.playTrack(TRACKS[1].key, TRACKS[1].videoId);
$('seek').oninput = (e) => client?.seek(Number((e.target as HTMLInputElement).value));

$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('chatInput');
  const text = input.value.trim();
  if (text && client) { client.say(text); input.value = ''; }
};

audio.addEventListener('waiting', () => client?.setBuffering(true));
audio.addEventListener('playing', () => client?.setBuffering(false));
audio.addEventListener('timeupdate', () => render());

// prime autoplay on first interaction, as a real user gesture
document.addEventListener('click', () => { void audio.play().catch(() => {}); }, { once: true });

if (initialRoom) {
  $<HTMLInputElement>('roomCode').value = initialRoom;
  setStatus('press Join to enter', '');
} else {
  setStatus('create a room, then open the share link in a second window', '');
}

(window as unknown as { __room: () => RoomClient | null }).__room = () => client;
(window as unknown as { __hostKey: () => string | null }).__hostKey = () => hostOwnerKey;