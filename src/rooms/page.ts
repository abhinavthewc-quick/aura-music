/* AURA listening rooms. The server owns the music; this page owns one room
 * lifetime, its local sound, and the join / listening / disconnected views. */
import { RoomClient, type RoomView } from './roomClient';
import { WebSocketTransport } from './wsTransport';
import { resolveTrack } from './appTarget';
import { SessionAudioTarget } from './sessionAudio';
import { setRoomActive } from './roomFlag';
import { ensureCatalog, refreshCatalog, onCatalogRefreshed } from './catalogReady';
import { state, trackKey, rebuildSongs } from '../core/state';
import { CHAT_HISTORY, CHAT_RATE_COUNT, CHAT_RATE_WINDOW_MS, type ChatMessage } from './protocol';
import { canManageRoom, formatTime, listenerInvite, listeningStatus, parseRoomInvite, type RoomInvite } from './presentation';

const NAME_KEY = 'auraRoomName_v1';
const ROOM_KEY = 'auraRecentRooms_v1';
const NAMES = ['Night owl', 'Daydreamer', 'Quiet one', 'Blue hour', 'Side B', 'Sunday listener'];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

interface Session {
  roomId: string;
  adminKey: string | null;
  name: string;
  abort: AbortController;
  audio: SessionAudioTarget | null;
  room: RoomClient | null;
  transport: WebSocketTransport | null;
  pending: boolean;
  stopped: boolean;
  cleanup: Set<() => void>;
  refresh: Promise<void> | null;
  audioError: string;
  chatTimes: number[];
}

interface LibraryTrack { key: string; title: string; artist: string; img: string }
interface AddRequest { room: RoomClient; title: string; first: boolean; timer: number }
interface Scrub { room: RoomClient; key: string; pointerId: number; ms: number }

let session: Session | null = null;
let deepInvite: RoomInvite | null = null;
let library: LibraryTrack[] = [];
let libraryVersion = 0;
let lastQueue = '';
let lastPeople = '';
let lastResults = '';
let lastArt = '';
let lastUnresolvedRefresh = 0;
let searchTimer = 0;
let copyTimer = 0;
let scrub: Scrub | null = null;
let unreadMessages = 0;
const pendingAdds = new Map<string, AddRequest>();
const chatIds = new Set<string>();
let chatEmpty: Node;

function text(id: string, value: string): void {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function rememberedName(): string {
  try { return (localStorage.getItem(NAME_KEY) || '').slice(0, 20); }
  catch { return ''; }
}

function rememberName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* A name still works without storage. */ }
}

function rememberRoom(id: string, key: string | null): void {
  if (!key) return;
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY) || '{}');
    const rooms = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    rooms[id] = key;
    localStorage.setItem(ROOM_KEY, JSON.stringify(rooms));
  } catch { /* The active session retains the key. */ }
}

function rememberedKey(id: string): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(ROOM_KEY) || '{}')?.[id];
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

function randomName(): string {
  return `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${Math.floor(Math.random() * 90 + 10)}`;
}

function currentRoom(): RoomClient | null {
  const s = session;
  const view = s?.room?.view();
  return s && !s.stopped && !s.pending && view?.you && !view.closed ? s.room : null;
}

/** Re-check both the role and the room identity when an old DOM handler runs. */
function manages(room: RoomClient | null): boolean {
  return Boolean(room && currentRoom() === room && canManageRoom(room.view()));
}

function showJoinError(message: string, field?: string): void {
  text('joinError', message);
  $('joinError').hidden = !message;
  for (const id of ['codeInput', 'nameInput']) input(id).removeAttribute('aria-invalid');
  if (field) {
    input(field).setAttribute('aria-invalid', 'true');
    input(field).focus();
  }
}

function banner(message: string, reconnect = false): void {
  text('bannerText', message);
  $('banner').hidden = !message;
  button('reconnectBtn').hidden = !reconnect;
}

function entryBusy(mode: 'join' | 'create' | null): void {
  for (const id of ['joinBtn', 'createBtn', 'shuffleName']) button(id).disabled = Boolean(mode);
  input('codeInput').disabled = Boolean(mode);
  input('nameInput').disabled = Boolean(mode);
  $('joinForm').setAttribute('aria-busy', String(Boolean(mode)));
  $('joinProgress').hidden = !mode;
  text('joinBtn', mode === 'join' ? 'Joining…' : 'Join room');
  text('createLabel', mode === 'create' ? 'Starting your room…' : 'Start a room');
  if (!mode) text('joinStatus', '');
}

function showJoin(focus = false): void {
  $('joinView').hidden = false;
  $('roomView').hidden = true;
  if (focus) input('codeInput').focus({ preventScroll: true });
}

/** Settle aborted and timed-out entry work, even if a socket/fetch never replies. */
function bounded<T>(s: Session, task: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      s.abort.signal.removeEventListener('abort', cancel);
      action();
    };
    const cancel = () => finish(() => reject(new DOMException('Entry cancelled', 'AbortError')));
    const timer = window.setTimeout(() => finish(() => reject(new Error(message))), milliseconds);
    s.abort.signal.addEventListener('abort', cancel, { once: true });
    task.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    if (s.abort.signal.aborted) cancel();
  });
}

async function roomRequest(s: Session, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await bounded(s, fetch('/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: s.abort.signal,
  }), 12000, 'The room server took too long to respond. Try again.');
  if (!response.ok) throw new Error('Rooms are unavailable right now. Try again in a moment.');
  return bounded(s, response.json(), 4000, 'The room server sent an incomplete reply. Try again.');
}

function welcome(s: Session, room: RoomClient): Promise<void> {
  const waiting = new Promise<void>((resolve, reject) => {
    let off = () => {};
    const check = (view: RoomView) => {
      if (view.closed) { off(); reject(new Error('This room closed before you could join. Check the code or start a room.')); }
      else if (view.you) { off(); resolve(); }
    };
    off = room.subscribe(check);
    s.cleanup.add(off);
    check(room.view());
  });
  return bounded(s, waiting, 12000, 'The room didn’t finish connecting. Check your connection and try again.');
}

async function enter(mode: 'join' | 'create', invite: RoomInvite | null, name: string): Promise<void> {
  if (session?.pending) return;
  if (session) stopSession(session);
  const s: Session = {
    roomId: invite?.roomId || '', adminKey: invite?.adminKey || null, name,
    abort: new AbortController(), audio: null, room: null, transport: null,
    pending: true, stopped: false, cleanup: new Set(), refresh: null, audioError: '', chatTimes: [],
  };
  session = s;
  resetRoomUI();
  showJoin();
  showJoinError('');
  entryBusy(mode);
  rememberName(name);
  input('nameInput').value = name;

  try {
    // This happens inside the join/create gesture, before any network await.
    // It preserves the browser's audio permission without starting any music.
    s.audio = new SessionAudioTarget({
      resolve: resolveTrack,
      onEnded: () => { if (manages(s.room)) s.room.trackEnded(); },
      onError: (message) => {
        if (session !== s || s.stopped) return;
        s.audioError = message;
        if (!s.pending) {
          banner(`This device couldn’t load the track: ${message}. Reconnect to try again.`, true);
          live(s);
        }
      },
      onTrackChanged: () => {
        if (session !== s || s.stopped) return;
        s.audioError = '';
        if (!s.pending) banner('');
      },
    });
    s.audio.setVolume(Number(input('volumeInput').value) / 100);
    void s.audio.unlock();

    if (mode === 'create') {
      text('joinStatus', 'Making a place for your people…');
      const created = await roomRequest(s, { action: 'create' });
      const code = typeof created.roomId === 'string' ? parseRoomInvite(created.roomId) : null;
      if (!code || typeof created.adminKey !== 'string') throw new Error('The room could not be created. Try again.');
      s.roomId = code.roomId;
      s.adminKey = created.adminKey;
      // If connecting fails, the created room is still available to retry.
      input('codeInput').value = s.roomId;
      rememberRoom(s.roomId, s.adminKey);
      deepInvite = { roomId: s.roomId, adminKey: s.adminKey };
    }

    text('joinStatus', 'Finding your room…');
    const info = await roomRequest(s, { action: 'exists', roomId: s.roomId });
    if (info.exists === false) throw new Error('That room has closed or doesn’t exist. Check the code, or start a room.');
    if (typeof info.wsBase !== 'string' || !/^wss?:\/\//.test(info.wsBase)) {
      throw new Error('Rooms are unavailable right now. Try again in a moment.');
    }

    // Idle gates and invalid invites don't request the catalogue.
    text('joinStatus', 'Getting the shared library ready…');
    rebuildSongs();
    await bounded(s, ensureCatalog(6000), 6500, 'The library took too long to load. Try joining again.');
    if (session !== s || s.stopped) return;
    rebuildLibrary();

    text('joinStatus', 'Connecting you to the room…');
    const clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    s.transport = new WebSocketTransport({ baseUrl: info.wsBase, roomId: s.roomId, clientId, name, ...(s.adminKey ? { adminKey: s.adminKey } : {}) });
    const room = s.room = new RoomClient({ roomId: s.roomId, ...(s.adminKey ? { ownerKey: s.adminKey } : {}) }, s.transport, clientId, s.audio);
    room.onChat = (message) => { if (session === s && !s.stopped) pushChat(message); };
    await bounded(s, s.transport.connect(), 12000, 'Couldn’t connect to the room. Check your connection and try again.');
    if (session !== s || s.stopped) return;
    const ready = welcome(s, room);
    room.join(name);
    await ready;
    if (session !== s || s.stopped) return;

    s.pending = false;
    entryBusy(null);
    rememberRoom(s.roomId, s.adminKey);
    // Keep the owner key out of the address bar and every listener invite.
    history.replaceState(null, '', `/rooms?r=${encodeURIComponent(s.roomId)}`);
    $('joinView').hidden = true;
    $('roomView').hidden = false;
    input('inviteLink').value = listenerInvite(location.origin, s.roomId);
    setRoomActive(true);
    s.cleanup.add(room.subscribe((view) => { if (session === s) render(s, view); }));
    if (s.stopped) return;
    startLive(s);
    watchCatalogue(s);
    $('nowTitle').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) {
    if (session !== s || s.stopped) return;
    stopSession(s);
    session = null;
    entryBusy(null);
    const message = error instanceof TypeError ? 'Couldn’t reach the room. Check your connection and try again.'
      : error instanceof SyntaxError ? 'The room server sent an incomplete reply. Try again.'
      : error instanceof Error ? error.message : 'Couldn’t join the room. Check your connection and try again.';
    showJoinError(message);
    button(mode === 'create' && !s.roomId ? 'createBtn' : 'joinBtn').focus({ preventScroll: true });
  }
}

function wireJoin(): void {
  input('nameInput').value = rememberedName();
  button('shuffleName').onclick = () => { input('nameInput').value = randomName(); showJoinError(''); input('nameInput').focus(); };
  for (const id of ['nameInput', 'codeInput']) input(id).addEventListener('input', () => showJoinError(''));

  $('joinForm').onsubmit = (event) => {
    event.preventDefault();
    if (session?.pending) return;
    const invite = parseRoomInvite(input('codeInput').value);
    if (!invite) { showJoinError('Enter the room code or paste the invite link a friend shared.', 'codeInput'); return; }
    const name = input('nameInput').value.trim().slice(0, 20);
    if (!name) { showJoinError('Choose a name so friends know it’s you.', 'nameInput'); return; }
    input('codeInput').value = invite.roomId;
    invite.adminKey ||= (deepInvite?.roomId === invite.roomId ? deepInvite.adminKey : null) || rememberedKey(invite.roomId);
    void enter('join', invite, name);
  };
  button('createBtn').onclick = () => {
    const name = input('nameInput').value.trim().slice(0, 20) || rememberedName() || randomName();
    void enter('create', null, name);
  };
  button('cancelJoinBtn').onclick = () => leave(false);
}

/* ---------------- lifetime ---------------- */

function stopSession(s: Session): void {
  if (s.stopped) return;
  s.stopped = true;
  s.pending = false;
  s.abort.abort();
  s.cleanup.forEach((off) => off());
  s.cleanup.clear();
  if (s.room) { s.room.onChat = null; s.room.leave(); }
  else s.transport?.close();
  s.audio?.dispose();
  for (const [key, request] of pendingAdds) {
    if (request.room === s.room) { window.clearTimeout(request.timer); pendingAdds.delete(key); }
  }
  if (session === s) {
    window.clearTimeout(searchTimer);
    window.clearTimeout(copyTimer);
    cancelScrub();
    setRoomActive(false);
  }
}

function resetRoomUI(): void {
  lastQueue = lastPeople = lastResults = lastArt = '';
  lastUnresolvedRefresh = 0;
  chatIds.clear();
  unreadMessages = 0;
  input('libSearch').value = '';
  input('chatInput').value = '';
  $('chatLog').replaceChildren(chatEmpty.cloneNode(true));
  $('newMessagesBtn').hidden = true;
  $('invitePanel').hidden = true;
  const art = $<HTMLImageElement>('artImg');
  art.hidden = true;
  art.removeAttribute('src');
  button('inviteBtn').setAttribute('aria-expanded', 'false');
  text('copyLabel', 'Copy link');
  text('inviteStatus', '');
  text('trackFeedback', '');
  text('chatStatus', 'Only people in this room can see your messages.');
  banner('');
}

function leave(clearCode = true): void {
  if (session) stopSession(session);
  session = null;
  entryBusy(null);
  resetRoomUI();
  showJoinError('');
  if (clearCode) { input('codeInput').value = ''; deepInvite = null; }
  try { history.replaceState(null, '', '/rooms'); } catch { /* Detached page. */ }
  showJoin(true);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function reconnect(): void {
  const s = session;
  if (!s || s.pending) return;
  input('codeInput').value = s.roomId;
  void enter('join', { roomId: s.roomId, adminKey: s.adminKey }, s.name);
}

/* ---------------- library and queue ---------------- */

function rebuildLibrary(): void {
  const seen = new Set<string>();
  library = [];
  for (const song of state.songs) {
    const key = trackKey(song);
    if (seen.has(key)) continue;
    const track = resolveTrack(key);
    if (!track) continue;
    seen.add(key);
    library.push({ key, title: track.title, artist: track.artist, img: track.img || '' });
  }
  libraryVersion++;
  text('libTotal', library.length ? `${library.length} tracks` : '');
}

function thumbnail(source: string): HTMLElement {
  const fallback = () => {
    const empty = element('span', 'track-art track-art-placeholder');
    empty.setAttribute('aria-hidden', 'true');
    empty.appendChild(icon('headphone'));
    return empty;
  };
  if (!source) return fallback();
  const img = element('img', 'track-art');
  img.width = img.height = 43;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => img.replaceWith(fallback());
  img.src = source;
  return img;
}

function trackCopy(title: string, artist: string): HTMLElement {
  const copy = element('span', 'track-copy');
  const name = element('span', 'track-name', title);
  name.title = title;
  copy.append(name, element('span', 'track-artist', artist));
  return copy;
}

function focusLibrary(): void {
  input('libSearch').focus({ preventScroll: true });
  $('librarySection').scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}

function updateAddButtons(): void {
  const room = currentRoom();
  const view = session?.room?.view();
  const first = !view?.playback.trackKey;
  const starting = [...pendingAdds.values()].some((request) => request.room === room && request.first);
  for (const btn of $('libResults').querySelectorAll<HTMLButtonElement>('button[data-track-key]')) {
    const key = btn.dataset.trackKey;
    const pending = pendingAdds.get(key);
    const title = btn.dataset.trackTitle;
    const queued = !first && view.queue.includes(key);
    btn.disabled = !manages(room) || Boolean(pending) || starting || queued;
    btn.textContent = pending ? (pending.first ? 'Starting…' : 'Adding…') : first ? 'Play first' : queued ? 'Queued' : 'Add';
    btn.setAttribute('aria-label', pending ? `Waiting for ${title}` : first ? `Play ${title} for everyone` : queued ? `${title} is already in the queue` : `Add ${title} to the queue`);
    btn.title = !manages(room) ? 'Admins choose the music. You can share a request in chat.' : '';
  }
}

function requestTrack(room: RoomClient, track: LibraryTrack): void {
  if (!manages(room) || pendingAdds.has(track.key)) return;
  if ([...pendingAdds.values()].some((request) => request.room === room && request.first)) return;
  const view = room.view();
  if (view.playback.trackKey && view.queue.includes(track.key)) {
    text('trackFeedback', `“${track.title}” is already in the queue.`);
    updateAddButtons();
    return;
  }
  const request: AddRequest = {
    room, title: track.title, first: !view.playback.trackKey,
    timer: window.setTimeout(() => {
      if (pendingAdds.get(track.key) !== request) return;
      pendingAdds.delete(track.key);
      if (currentRoom() === room) {
        text('trackFeedback', `The room hasn’t confirmed “${track.title}”. Try again.`);
        updateAddButtons();
      }
    }, 6000),
  };
  pendingAdds.set(track.key, request);
  text('trackFeedback', request.first ? `Starting “${track.title}” for everyone…` : `Adding “${track.title}” to the queue…`);
  updateAddButtons();
  room.queueAdd(track.key);
}

function confirmTrackRequests(view: RoomView): void {
  for (const [key, request] of pendingAdds) {
    if (request.room !== session?.room) continue;
    const confirmed = request.first ? view.playback.trackKey === key : view.queue.includes(key);
    if (!confirmed) continue;
    window.clearTimeout(request.timer);
    pendingAdds.delete(key);
    text('trackFeedback', request.first ? `“${request.title}” is the room’s next record.` : `“${request.title}” added to the queue.`);
  }
  updateAddButtons();
}

function renderResults(view: RoomView): void {
  const query = input('libSearch').value.trim();
  const signature = JSON.stringify([query, libraryVersion, view.role, Boolean(view.closed), Boolean(view.playback.trackKey)]);
  if (signature === lastResults) return;
  lastResults = signature;
  const room = session.room;
  const list = $('libResults');
  const focusedKey = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.trackKey : null;
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = query ? library.filter((track) => words.every((word) => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(word))) : library;
  const hits = matches.slice(0, query ? 30 : 6);
  const fragment = document.createDocumentFragment();
  text('libResultsStatus', !library.length ? '' : query ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}${matches.length > 30 ? ' · Showing 30' : ''}` : 'A few records to get you started');
  button('clearSearchBtn').hidden = !query;
  button('retryLibraryBtn').hidden = Boolean(library.length);
  if (!hits.length) {
    fragment.appendChild(element('li', 'lib-empty', library.length ? `No songs match “${query}”. Try a title or a different artist.` : 'The shared library hasn’t loaded. Reload it to find a record for the room.'));
  }
  for (const track of hits) {
    const li = element('li');
    li.append(thumbnail(track.img), trackCopy(track.title, track.artist));
    const add = element('button', 'add-btn');
    add.type = 'button';
    add.dataset.trackKey = track.key;
    add.dataset.trackTitle = track.title;
    add.onclick = () => requestTrack(room, track);
    li.appendChild(add);
    fragment.appendChild(li);
  }
  list.replaceChildren(fragment);
  updateAddButtons();
  if (focusedKey) {
    const restored = [...list.querySelectorAll<HTMLButtonElement>('button')].find((btn) => btn.dataset.trackKey === focusedKey && !btn.disabled);
    (restored || input('libSearch')).focus({ preventScroll: true });
  }
}

function renderQueue(view: RoomView): void {
  text('qCount', `${view.queue.length} ${view.queue.length === 1 ? 'track' : 'tracks'}`);
  text('queueNavCount', String(view.queue.length));
  const signature = JSON.stringify([view.role, view.closed, view.playback.trackKey, view.queue, libraryVersion]);
  if (signature === lastQueue) return;
  lastQueue = signature;
  const room = session.room;
  const admin = canManageRoom(view);
  const list = $('queueList');
  const hadFocus = document.activeElement !== list && list.contains(document.activeElement);
  const oldKey = hadFocus ? (document.activeElement as HTMLElement).dataset.trackKey : null;
  const fragment = document.createDocumentFragment();
  if (!view.queue.length) {
    const empty = element('li', 'empty-row');
    empty.append(element('strong', '', 'Leave room for another record.'), element('p', '', admin ? 'Pick the first track below, or line up what comes next.' : 'An admin can add the next track. Share a pick in chat.'));
    if (admin) {
      const find = element('button', 'linkish', 'Find a track');
      find.type = 'button';
      find.onclick = focusLibrary;
      empty.appendChild(find);
    }
    fragment.appendChild(empty);
  }
  view.queue.forEach((key, index) => {
    const track = resolveTrack(key);
    const li = element('li');
    li.append(element('span', 'idx', String(index + 1)), thumbnail(track?.img || ''), trackCopy(track?.title || 'Track unavailable', track?.artist || 'Try reloading the shared library.'));
    if (admin) {
      const remove = element('button', 'icon-btn remove-track');
      remove.type = 'button';
      remove.dataset.trackKey = key;
      remove.title = 'Remove from queue';
      remove.setAttribute('aria-label', `Remove ${track?.title || 'unavailable track'} from queue`);
      remove.appendChild(icon('x'));
      remove.onclick = () => { if (manages(room)) room.queueRemove(key); };
      li.appendChild(remove);
    }
    fragment.appendChild(li);
  });
  list.replaceChildren(fragment);
  if (hadFocus) {
    const restored = [...list.querySelectorAll<HTMLButtonElement>('button')].find((btn) => btn.dataset.trackKey === oldKey);
    (restored || $('queueSection')).focus({ preventScroll: true });
  }
}

/* ---------------- people and conversation ---------------- */

function renderPeople(view: RoomView): void {
  const count = view.participants.length;
  text('pCount', String(count));
  text('peopleNavCount', String(count));
  text('peopleSummary', view.closed ? 'The room is disconnected.' : count > 1 ? `${count} people sharing this moment.` : 'Just you for now. Invite someone to listen.');
  const signature = JSON.stringify([view.you?.id, view.role, view.closed, view.participants.map((person) => [person.id, person.name, person.role])]);
  if (signature === lastPeople) return;
  lastPeople = signature;
  const room = session.room;
  const list = $('peopleList');
  const hadFocus = document.activeElement !== list && list.contains(document.activeElement);
  const oldId = hadFocus ? (document.activeElement as HTMLElement).dataset.personId : null;
  const fragment = document.createDocumentFragment();
  for (const person of view.participants) {
    const li = element('li');
    const initials = person.name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] || '').join('').toLocaleUpperCase();
    const avatar = element('span', `avatar${person.role === 'admin' ? ' admin' : ''}`, initials);
    avatar.setAttribute('aria-hidden', 'true');
    const copy = element('div', 'person-copy');
    const name = element('div', 'person-name');
    name.appendChild(element('span', 'name', person.name));
    if (person.id === view.you?.id) name.appendChild(element('span', 'me-tag', 'you'));
    copy.append(name, element('div', 'person-role', person.role === 'admin' ? 'Admin' : 'Listener'));
    li.append(avatar, copy);
    if (canManageRoom(view) && person.id !== view.you?.id) {
      const action = element('button', 'promo', person.role === 'admin' ? 'Remove admin' : 'Make admin');
      action.type = 'button';
      action.dataset.personId = person.id;
      action.setAttribute('aria-label', person.role === 'admin' ? `Remove admin controls from ${person.name}` : `Make ${person.name} an admin`);
      action.onclick = () => {
        if (!manages(room)) return;
        const current = room.view().participants.find((participant) => participant.id === person.id);
        if (!current || current.role !== person.role) return;
        if (current.role === 'admin') room.demote(person.id); else room.promote(person.id);
      };
      li.appendChild(action);
    }
    fragment.appendChild(li);
  }
  list.replaceChildren(fragment);
  if (hadFocus) {
    const restored = [...list.querySelectorAll<HTMLButtonElement>('button')].find((btn) => btn.dataset.personId === oldId);
    (restored || $('peopleSection')).focus({ preventScroll: true });
  }
}

function chatAtBottom(): boolean {
  const log = $('chatLog');
  return log.scrollHeight - log.scrollTop - log.clientHeight < 45;
}

function scrollChat(): void {
  const log = $('chatLog');
  log.scrollTop = log.scrollHeight;
  unreadMessages = 0;
  $('newMessagesBtn').hidden = true;
}

function pushChat(message: ChatMessage): void {
  if (chatIds.has(message.id)) return;
  chatIds.add(message.id);
  const log = $('chatLog');
  const nearBottom = chatAtBottom();
  log.querySelector('.chat-empty')?.remove();
  const row = element('div', 'message');
  row.dataset.messageId = message.id;
  const meta = element('div', 'message-meta');
  meta.appendChild(element('b', '', message.name));
  const date = new Date(message.at);
  if (Number.isFinite(date.getTime())) {
    const time = element('time', '', date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    time.dateTime = date.toISOString();
    meta.appendChild(time);
  }
  row.append(meta, element('p', '', message.text));
  log.appendChild(row);
  while (log.children.length > CHAT_HISTORY) {
    const first = log.firstElementChild as HTMLElement;
    const height = first.offsetHeight;
    chatIds.delete(first.dataset.messageId);
    first.remove();
    if (!nearBottom) log.scrollTop = Math.max(0, log.scrollTop - height);
  }
  if (nearBottom) scrollChat();
  else {
    unreadMessages++;
    text('newMessagesBtn', `${unreadMessages} new ${unreadMessages === 1 ? 'message' : 'messages'}`);
    $('newMessagesBtn').hidden = false;
  }
}

function updateChatControls(): void {
  const connected = Boolean(currentRoom());
  input('chatInput').disabled = !connected;
  button('sendBtn').disabled = !connected || !input('chatInput').value.trim();
}

/* ---------------- live listening state ---------------- */

function render(s: Session, view: RoomView): void {
  const admin = canManageRoom(view);
  text('roomCode', view.roomId);
  text('rolePill', view.role === 'admin' ? 'Admin' : 'Listener');
  $('rolePill').classList.toggle('admin', admin);
  text('roleDescription', admin ? 'Choose music and share the controls.' : 'Listen, browse, and chat.');
  text('permissionHint', view.closed ? 'Reconnect to use the room controls.' : admin ? 'You control playback for everyone in the room.' : 'Admins control the music. Your volume is just for you.');
  text('libHint', view.closed ? 'Reconnect before adding tracks to the room.' : admin ? (view.playback.trackKey ? 'Add a record to the shared queue.' : 'Your first pick starts playing for everyone.') : 'Browse the records. Ask an admin to add your pick.');
  text('connectionLabel', view.closed ? 'Disconnected' : 'Connected');
  $('liveDot').classList.toggle('connected', !view.closed && Boolean(view.you));
  button('inviteBtn').disabled = Boolean(view.closed);
  button('copyBtn').disabled = Boolean(view.closed);

  const track = view.playback.trackKey ? resolveTrack(view.playback.trackKey) : null;
  text('nowTitle', track?.title || (view.playback.trackKey ? 'Finding this record…' : admin ? 'Choose the first record.' : 'Waiting for a record.'));
  text('nowArtist', track?.artist || (view.playback.trackKey ? 'Checking the shared library.' : admin ? 'Find a track to bring the room to life.' : 'An admin will choose what plays next.'));
  const image = $<HTMLImageElement>('artImg');
  const source = track?.img || '';
  if (source !== lastArt) {
    lastArt = source;
    image.hidden = !source;
    if (source) image.src = source; else image.removeAttribute('src');
  }
  button('chooseTrackBtn').hidden = !admin || Boolean(view.playback.trackKey);
  renderQueue(view);
  renderPeople(view);
  renderResults(view);
  confirmTrackRequests(view);
  updateChatControls();

  if (view.closed) {
    banner(`Disconnected: ${view.closed}. Reconnect to return, or leave this room.`, true);
    text('chatStatus', 'Reconnect to send messages.');
    stopSession(s);
    text('trackFeedback', '');
    updateAddButtons();
    $('invitePanel').hidden = true;
    button('inviteBtn').setAttribute('aria-expanded', 'false');
  } else if (s.audioError) {
    banner(`This device couldn’t load the track: ${s.audioError}. Reconnect to try again.`, true);
  }
  live(s, view);

  const unresolved = (view.playback.trackKey && !track) || view.queue.some((key) => !resolveTrack(key));
  if (!s.stopped && unresolved && Date.now() - lastUnresolvedRefresh > 20000) {
    lastUnresolvedRefresh = Date.now();
    void refreshLibrary(s);
  }
}

function live(s: Session, suppliedView?: RoomView): void {
  if (session !== s || (!suppliedView && s.stopped)) return;
  const view = suppliedView || s.room?.view();
  if (!view) return;
  const status = listeningStatus(view, s.audioError);
  text('syncLabel', status.label);
  text('syncDetail', status.detail);
  $('syncbar').dataset.state = status.state;
  $('art').dataset.state = status.state;
  text('stageCaption', view.closed ? 'The room is disconnected' : !view.playback.trackKey ? 'A record for everyone' : view.playback.playing ? 'On the record, together' : 'A moment between notes');
  const diagnostics = status.state === 'live' || status.state === 'correcting';
  text('driftLabel', diagnostics ? `${Math.abs(view.driftMs)} ms` : '');
  $('driftLabel').title = diagnostics ? `Difference from the room: ${view.driftMs} milliseconds${view.outputLatencyMs !== null ? `. Device output delay: ${view.outputLatencyMs} milliseconds` : ''}` : '';
  if (status.state === 'live' && !reducedMotion.matches && document.visibilityState !== 'hidden') {
    // Eight shared-clock positions, four updates a second. No idle RAF loop.
    $('recordMarker').style.setProperty('--sync-angle', `${Math.floor((view.serverNow % 2000) / 250) * 45}deg`);
  }
  const starting = !view.closed && view.startInMs !== null && status.state !== 'blocked' && status.state !== 'error';
  $('countdown').hidden = !starting;
  if (starting) text('countdownNum', String(Math.max(1, Math.ceil(view.startInMs / 1000))));
  $('listenHint').hidden = status.state !== 'blocked';
  $('loadHint').hidden = status.state !== 'loading';

  const admin = canManageRoom(view) && !s.stopped;
  const hasTrack = Boolean(view.playback.trackKey);
  const seekable = admin && hasTrack && view.durationMs > 0 && !view.loading && !s.audioError;
  button('playBtn').disabled = !admin || Boolean(s.audioError) || (!hasTrack && !view.queue.length);
  button('prevBtn').disabled = !seekable;
  button('nextBtn').disabled = !admin || !view.queue.length;
  button('playBtn').setAttribute('aria-label', view.playback.playing ? 'Pause for everyone' : 'Play for everyone');
  document.getElementById('playIcon').setAttribute('href', view.playback.playing ? '#i-pause' : '#i-play');
  $('seekBar').setAttribute('aria-disabled', String(!seekable));
  $('seekBar').tabIndex = seekable ? 0 : -1;
  if (scrub && (!seekable || scrub.room !== s.room || scrub.key !== view.playback.trackKey)) cancelScrub();
  const positionReady = hasTrack && !view.loading && !s.audioError;
  renderPosition(scrub?.ms ?? (positionReady ? view.positionMs : 0), positionReady ? view.durationMs : 0);
}

function renderPosition(position: number, duration: number): void {
  const pct = duration > 0 ? Math.max(0, Math.min(100, position / duration * 100)) : 0;
  $('fill').style.width = `${pct}%`;
  $('knob').style.left = `${pct}%`;
  text('tCur', formatTime(position));
  text('tDur', duration > 0 ? formatTime(duration) : '0:00');
  $('seekBar').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('seekBar').setAttribute('aria-valuetext', duration ? `${formatTime(position)} of ${formatTime(duration)}` : 'No track loaded');
}

function startLive(s: Session): void {
  const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') live(s); }, 250);
  s.cleanup.add(() => window.clearInterval(timer));
  // Listeners explicitly unlock their local sound. This listener exists only
  // for this session and never resumes a closed room on an unrelated gesture.
  const resume = () => {
    if (currentRoom() === s.room && s.room.view().blocked) s.room.resumeIfBlocked();
  };
  document.addEventListener('pointerdown', resume, { passive: true });
  document.addEventListener('keydown', resume);
  s.cleanup.add(() => {
    document.removeEventListener('pointerdown', resume);
    document.removeEventListener('keydown', resume);
  });
}

/* ---------------- seeking and controls ---------------- */

function cancelScrub(): void {
  const previous = scrub;
  scrub = null;
  $('seekBar').classList.remove('scrubbing');
  if (previous) try { $('seekBar').releasePointerCapture(previous.pointerId); } catch { /* Pointer already released. */ }
}

function seekPreview(event: PointerEvent): void {
  if (!scrub || !manages(scrub.room)) return;
  const view = scrub.room.view();
  const rect = $('seekBar').getBoundingClientRect();
  if (!view.durationMs || !rect.width) return;
  scrub.ms = Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * view.durationMs);
  renderPosition(scrub.ms, view.durationMs);
}

function wireSeek(): void {
  const bar = $('seekBar');
  bar.addEventListener('pointerdown', (event) => {
    const room = currentRoom();
    const view = room?.view();
    if (!manages(room) || !view.durationMs || view.loading || session.audioError || !view.playback.trackKey || event.button !== 0) return;
    scrub = { room, key: view.playback.trackKey, pointerId: event.pointerId, ms: view.positionMs };
    bar.classList.add('scrubbing');
    try { bar.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer or unavailable capture. */ }
    seekPreview(event);
  });
  bar.addEventListener('pointermove', (event) => { if (scrub?.pointerId === event.pointerId) seekPreview(event); });
  bar.addEventListener('pointerup', (event) => {
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    const previous = scrub;
    cancelScrub();
    if (manages(previous.room) && previous.room.view().playback.trackKey === previous.key) previous.room.seek(previous.ms);
  });
  bar.addEventListener('pointercancel', cancelScrub);
  bar.addEventListener('lostpointercapture', cancelScrub);
  bar.addEventListener('keydown', (event) => {
    const room = currentRoom();
    const view = room?.view();
    if (!manages(room) || !view.durationMs || view.loading || session.audioError || !view.playback.trackKey) return;
    const step = event.shiftKey ? 10000 : 5000;
    let position: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') position = view.positionMs + step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') position = view.positionMs - step;
    else if (event.key === 'Home') position = 0;
    else if (event.key === 'End') position = view.durationMs;
    else return;
    event.preventDefault();
    room.seek(Math.max(0, Math.min(view.durationMs, position)));
  });
}

function toggleInvite(open: boolean): void {
  if (!currentRoom()) return;
  $('invitePanel').hidden = !open;
  button('inviteBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    input('inviteLink').value = listenerInvite(location.origin, currentRoom().view().roomId);
    input('inviteLink').focus();
    input('inviteLink').select();
  } else button('inviteBtn').focus({ preventScroll: true });
}

function wireRoom(): void {
  button('playBtn').onclick = () => { const room = currentRoom(); if (manages(room) && !session.audioError) room.toggle(); };
  button('nextBtn').onclick = () => { const room = currentRoom(); if (manages(room) && room.view().queue.length) room.queueNext(); };
  button('prevBtn').onclick = () => { const room = currentRoom(); if (manages(room) && room.view().durationMs && !room.view().loading && !session.audioError) room.seek(0); };
  button('leaveBtn').onclick = () => leave();
  button('reconnectBtn').onclick = reconnect;
  button('chooseTrackBtn').onclick = focusLibrary;
  button('listenBtn').onclick = () => currentRoom()?.resumeIfBlocked();
  button('retryLibraryBtn').onclick = () => { if (session) void refreshLibrary(session); };
  button('inviteBtn').onclick = () => toggleInvite($('invitePanel').hidden);
  button('inviteCloseBtn').onclick = () => toggleInvite(false);
  $('invitePanel').addEventListener('keydown', (event) => { if (event.key === 'Escape') toggleInvite(false); });
  input('inviteLink').onclick = () => input('inviteLink').select();
  button('copyBtn').onclick = async () => {
    const room = currentRoom();
    if (!room) return;
    const url = listenerInvite(location.origin, room.view().roomId);
    try {
      await navigator.clipboard.writeText(url);
      if (currentRoom() !== room) return;
      text('copyLabel', 'Copied');
      text('inviteStatus', 'Link copied. Send it to a friend.');
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => { if (currentRoom() === room) text('copyLabel', 'Copy link'); }, 2500);
    } catch {
      if (currentRoom() !== room) return;
      input('inviteLink').value = url;
      input('inviteLink').focus();
      input('inviteLink').select();
      text('inviteStatus', 'Copy the selected link, then send it to a friend.');
    }
  };
  input('volumeInput').addEventListener('input', () => {
    const volume = Number(input('volumeInput').value);
    input('volumeInput').setAttribute('aria-valuetext', `${volume} percent`);
    session?.audio?.setVolume(volume / 100);
  });
  input('libSearch').addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    const room = currentRoom();
    searchTimer = window.setTimeout(() => { if (currentRoom() === room && room) renderResults(room.view()); }, 90);
  });
  button('clearSearchBtn').onclick = () => {
    input('libSearch').value = '';
    const room = currentRoom();
    if (room) renderResults(room.view());
    input('libSearch').focus();
  };
  input('chatInput').addEventListener('input', updateChatControls);
  $('chatForm').onsubmit = (event) => {
    event.preventDefault();
    const room = currentRoom();
    const message = input('chatInput').value.trim();
    if (!room || !message) return;
    const now = Date.now();
    session.chatTimes = session.chatTimes.filter((time) => now - time < CHAT_RATE_WINDOW_MS);
    if (session.chatTimes.length >= CHAT_RATE_COUNT) {
      text('chatStatus', 'Give the conversation a moment. Try again in a few seconds.');
      return;
    }
    session.chatTimes.push(now);
    room.say(message);
    input('chatInput').value = '';
    text('chatStatus', 'Only people in this room can see your messages.');
    updateChatControls();
    scrollChat();
  };
  button('newMessagesBtn').onclick = () => { scrollChat(); $('chatLog').focus({ preventScroll: true }); };
  $('chatLog').addEventListener('scroll', () => { if (chatAtBottom()) { unreadMessages = 0; $('newMessagesBtn').hidden = true; } });
  $<HTMLImageElement>('artImg').onerror = () => { $('artImg').hidden = true; };
}

/* ---------------- catalogue freshness ---------------- */

async function refreshLibrary(s: Session): Promise<void> {
  if (session !== s || s.stopped || s.pending) return;
  if (s.refresh) return s.refresh;
  button('retryLibraryBtn').disabled = true;
  text('retryLibraryBtn', 'Loading library…');
  s.refresh = (async () => {
    try {
      await refreshCatalog();
      if (session !== s || s.stopped) return;
      rebuildLibrary();
      render(s, s.room.view());
    } finally {
      s.refresh = null;
      if (session === s && !s.stopped) {
        button('retryLibraryBtn').disabled = false;
        text('retryLibraryBtn', 'Reload library');
      }
    }
  })();
  return s.refresh;
}

function watchCatalogue(s: Session): void {
  const refreshLocal = () => {
    if (session !== s || s.stopped) return;
    rebuildLibrary();
    render(s, s.room.view());
  };
  s.cleanup.add(onCatalogRefreshed(refreshLocal));
  // ensureCatalog's entry deadline can precede the underlying fetch. Pick up
  // that late result without waiting for the next 30-second refresh.
  if (!library.length) void ensureCatalog(30000).then(refreshLocal);
  try {
    const channel = new BroadcastChannel('aura-catalog');
    channel.onmessage = (event) => { if (event.data?.t === 'refresh') void refreshLibrary(s); };
    s.cleanup.add(() => channel.close());
  } catch { /* Focus and the periodic refresh cover unsupported browsers. */ }
  const visible = () => { if (document.visibilityState !== 'hidden') { live(s); void refreshLibrary(s); } };
  const focus = () => void refreshLibrary(s);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('focus', focus);
  s.cleanup.add(() => document.removeEventListener('visibilitychange', visible));
  s.cleanup.add(() => window.removeEventListener('focus', focus));
  let timer = 0;
  const tick = async () => {
    if (session !== s || s.stopped) return;
    if (document.visibilityState !== 'hidden') await refreshLibrary(s);
    if (session === s && !s.stopped) timer = window.setTimeout(tick, 30000);
  };
  timer = window.setTimeout(tick, 30000);
  s.cleanup.add(() => window.clearTimeout(timer));
}

/* ---------------- boot: no catalogue, socket, context, or animation ---------------- */

function boot(): void {
  chatEmpty = $('chatLog').firstElementChild.cloneNode(true);
  wireJoin();
  wireRoom();
  wireSeek();
  showJoin();
  deepInvite = parseRoomInvite(location.href);
  if (deepInvite) {
    input('codeInput').value = deepInvite.roomId;
    text('joinSub', 'Your invite is ready. Choose a name and join your people.');
  }
  window.addEventListener('pagehide', () => {
    if (session) stopSession(session);
    session = null;
    entryBusy(null);
    showJoin();
  });
}

boot();
