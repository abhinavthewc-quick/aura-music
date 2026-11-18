import { state, $ } from '../core/state';
import { toast, getSavedUserName } from '../core/dom';
import { goTab, showPlaylistTab } from '../ui/nav';
import { goToSearchCategory } from './search';
import { findSongById, playTrackSequence, renderUpNext } from './queue';
import { restoreLocalFile } from './library';
import { resolveTrackSnapshot, snapshotTrack, stableTrackRef, trackAvailable } from '../core/track-identity';
import {
  PLAYLISTS_KEY, MAX_PLAYLISTS, MAX_TRACKS_PER_PLAYLIST, MAX_IMPORT_BYTES,
  parsePlaylistStore, normalizePlaylist, decodePlaylistFile, encodePlaylistFile, PlaylistDataError,
  type Playlist, type PlaylistStore, type PlaylistTrackRef,
} from '../core/playlist-data';

type PlaylistEntry = {
  ref: PlaylistTrackRef;
  song: any | null;
  position: number;
};

let currentPlaylistId: string | null = null;
let editingPlaylistId: string | null = null;
let pendingTrackRef: PlaylistTrackRef | null = null;
let pendingRelink: { playlistId: string; ref: string } | null = null;
let lastTab = 'tabPlaylists';
let playlistChannel: BroadcastChannel | null = null;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string));
}

function playlistId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? `pl_${crypto.randomUUID()}`
    : `pl_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

export const stablePlaylistTrackRef = stableTrackRef;

function secondsOf(song: any): number {
  if (typeof song?.duration === 'number' && Number.isFinite(song.duration)) return Math.max(0, Math.round(song.duration));
  if (typeof song?.duration !== 'string' || !song.duration.includes(':')) return 0;
  return song.duration.split(':').reduce((total: number, part: string) => total * 60 + (Number(part) || 0), 0);
}

let storageError = '';
function loadStore(): PlaylistStore {
  try {
    const {store} = parsePlaylistStore(localStorage.getItem(PLAYLISTS_KEY),state.songs);
    storageError = '';
    return store;
  } catch (error) {
    storageError = error instanceof PlaylistDataError ? error.message : 'Browser storage is unavailable. Your saved playlists have not been changed.';
    return {version:2,revision:0,playlists:[]};
  }
}
function loadPlaylists(): Playlist[] { return loadStore().playlists; }

function saveStore(store: PlaylistStore): void {
  localStorage.setItem(PLAYLISTS_KEY,JSON.stringify(store));
  try { playlistChannel?.postMessage({type:'changed',revision:store.revision}); } catch { /* storage events remain the fallback */ }
}

/** Web Locks serialize the read/modify/write across tabs. Older browsers use an
 * IndexedDB readwrite transaction as a short coordination lock, not an unsafe
 * localStorage check-then-set spinlock. No network or persistent account is involved.
 */
async function withPlaylistLock<T>(work: () => T): Promise<T> {
  const locks = (navigator as any).locks;
  if (locks?.request) return locks.request('aura-playlists-write',work);
  if (!globalThis.indexedDB) throw new Error('This browser cannot safely save playlists across tabs.');
  return new Promise<T>((resolve,reject) => {
    const request = indexedDB.open('auraPlaylistCoordination',1);
    request.onupgradeneeded = () => request.result.createObjectStore('writes');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Playlist storage is blocked by another browser tab.'));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('writes','readwrite');
      const store = transaction.objectStore('writes');
      const read = store.get('lock');
      let value: T;
      let primaryCommitted = false;
      read.onsuccess = () => {
        try { value = work(); primaryCommitted = true; }
        catch (error) { transaction.abort(); reject(error); }
      };
      transaction.oncomplete = () => { db.close(); resolve(value); };
      transaction.onabort = transaction.onerror = () => {
        db.close();
        if (primaryCommitted) resolve(value);
        else reject(transaction.error || new Error('Playlist storage is unavailable.'));
      };
    };
  });
}

type MutationResult<T> = {ok:true;value:T} | {ok:false};
async function mutatePlaylists<T>(mutator: (playlists: Playlist[]) => T): Promise<MutationResult<T>> {
  try {
    const value = await withPlaylistLock(() => {
      const parsed = parsePlaylistStore(localStorage.getItem(PLAYLISTS_KEY),state.songs);
      const before = JSON.stringify(parsed.store.playlists);
      const result = mutator(parsed.store.playlists);
      parsed.store.playlists = parsed.store.playlists.map((item) => normalizePlaylist(item,state.songs,false,true));
      if (before !== JSON.stringify(parsed.store.playlists) || parsed.needsMigration) {
        parsed.store.revision += 1;
        saveStore(parsed.store);
      }
      return result;
    });
    renderAllPlaylistSurfaces();
    return {ok:true,value};
  } catch (error) {
    toast(error instanceof PlaylistDataError ? error.message : 'Aura could not save this change. Free browser storage or close conflicting tabs, then try again.', 'triangle-exclamation');
    return {ok:false};
  }
}

export async function preparePlaylistTrackEdit(): Promise<boolean> {
  const result = await mutatePlaylists(() => undefined);
  return result.ok;
}

async function migratePlaylistReferences(): Promise<void> {
  try {
    await withPlaylistLock(() => {
      const raw = localStorage.getItem(PLAYLISTS_KEY);
      const parsed = parsePlaylistStore(raw,state.songs);
      if (!parsed.needsMigration) return;
      // Keep the original legacy payload for recovery without touching it on a read.
      if (raw?.trim().startsWith('[') && !localStorage.getItem('auraPlaylists_backup_v1')) {
        try { localStorage.setItem('auraPlaylists_backup_v1',raw); } catch { /* the original still remains until the atomic replacement succeeds */ }
      }
      parsed.store.revision += 1;
      saveStore(parsed.store);
    });
    renderAllPlaylistSurfaces();
  } catch { renderAllPlaylistSurfaces(); /* the readonly notice explains malformed storage */ }
}

function playlistEntries(playlist: Playlist): PlaylistEntry[] {
  return playlist.tracks.map((ref,position) => {
    const song = resolveTrackSnapshot(ref,state.songs);
    return {ref,position,song:trackAvailable(song) ? song : null};
  });
}

function downloadRecoveryCopy(): void {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY) || localStorage.getItem('auraPlaylists_backup_v1') || '';
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([raw],{type:'application/json'}));
    link.href = url; link.download = 'aura-playlists-recovery.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url),1000);
  } catch { toast('Browser storage is unavailable. Check this browser’s site permissions.', 'triangle-exclamation'); }
}

function ownerName(): string {
  return (getSavedUserName?.() || '').trim() || ($('displayUserName')?.textContent || '').trim() || 'Aura listener';
}
function durationLabel(seconds: number): string {
  if (seconds <= 0) return 'Duration unavailable';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours} hr${minutes ? ` ${minutes} min` : ''}` : `${Math.max(1,minutes)} min`;
}
function playlistSummary(playlist: Playlist): string {
  const unavailable = playlistEntries(playlist).filter((entry) => !entry.song).length;
  return `${playlist.tracks.length} track${playlist.tracks.length === 1 ? '' : 's'} on this device${unavailable ? `. ${unavailable} unavailable` : ''}`;
}
function coversMarkup(playlist: Playlist, className: string): string {
  const covers = playlistEntries(playlist).map(({song,ref}) => song?.img || ref.img || '').filter(Boolean).slice(0,4);
  return `<div class="${className}" aria-hidden="true">${Array.from({length:4},(_,index) => covers[index]
    ? `<img src="${esc(covers[index])}" alt="" loading="lazy" decoding="async">`
    : '<span><i class="fa-solid fa-music"></i></span>').join('')}</div>`;
}
function ownerAvatarMarkup(): string {
  const photo = $('profilePhoto') as HTMLImageElement | null;
  return photo && photo.src && !photo.hidden ? `<img class="pl-owner-avatar" src="${esc(photo.src)}" alt="">`
    : `<span class="pl-owner-avatar">${esc(ownerName().slice(0,1).toUpperCase())}</span>`;
}

export function renderPlaylistsPage(): void {
  const host = $('tabPlaylists');
  if (!host) return;
  const playlists = loadPlaylists();
  host.innerHTML = `<div class="playlists-page-head">
    <div><h2>Playlists</h2><p>Your collections, in the order you choose.</p></div>
    <div class="playlists-page-actions">
      <button class="playlist-secondary-btn" type="button" data-import-playlist aria-label="Import a playlist file" ${storageError ? 'disabled' : ''}><i class="fa-solid fa-file-import"></i><span>Import</span></button>
      <button class="playlist-create-btn" type="button" data-create-playlist aria-label="Create a playlist" ${storageError ? 'disabled' : ''}><i class="fa-solid fa-plus"></i><span>New playlist</span></button>
    </div></div>
    ${storageError ? `<div class="playlists-empty" role="alert"><h3>Saved playlists need attention</h3><p>${esc(storageError)}</p><button class="playlist-secondary-btn" type="button" data-recovery-copy>Download recovery copy</button></div>`
    : playlists.length ? `<div class="playlists-grid">${playlists.map((playlist) => `<article class="playlist-card">
      <button class="playlist-card-open" type="button" data-playlist-id="${esc(playlist.id)}" aria-label="Open ${esc(playlist.title)}">
        ${coversMarkup(playlist,'playlist-card-cover')}<span class="playlist-card-copy"><strong>${esc(playlist.title)}</strong><small>${esc(playlistSummary(playlist))}</small></span>
      </button><button class="playlist-card-menu" type="button" data-edit-playlist="${esc(playlist.id)}" aria-label="Edit ${esc(playlist.title)}"><i class="fa-solid fa-ellipsis"></i></button>
    </article>`).join('')}</div>` : `<div class="playlists-empty"><div class="playlists-empty-mark"><i class="fa-solid fa-bars-staggered"></i></div>
      <h3>Build your first playlist</h3><p>Collect tracks in a deliberate order. Playlists stay in this browser until you export them.</p>
      <button class="playlist-create-btn" type="button" data-create-playlist aria-label="Create your first playlist"><i class="fa-solid fa-plus"></i><span>New playlist</span></button></div>`}`;
  host.querySelectorAll<HTMLElement>('[data-create-playlist]').forEach((button) => { button.onclick = () => openPlaylistModal(); });
  host.querySelector<HTMLElement>('[data-import-playlist]')?.addEventListener('click',importPlaylistFile);
  host.querySelector<HTMLElement>('[data-recovery-copy]')?.addEventListener('click',downloadRecoveryCopy);
  host.querySelectorAll<HTMLElement>('[data-playlist-id]').forEach((button) => { button.onclick = () => openPlaylistPage(button.dataset.playlistId); });
  host.querySelectorAll<HTMLElement>('[data-edit-playlist]').forEach((button) => { button.onclick = () => openPlaylistModal(button.dataset.editPlaylist); });
}

export function renderSidebarPlaylists(): void {
  const playlists = loadPlaylists();
  const sidebar = $('sidebarPlaylists');
  if (sidebar) {
    sidebar.innerHTML = playlists.map((playlist) => `<button class="ytm-playlist-item" type="button" data-sidebar-playlist="${esc(playlist.id)}">
      <span class="ytm-pl-row"><span class="ytm-pl-name">${esc(playlist.title)}</span><small class="pl-count">${playlist.tracks.length}</small></span>
      <span class="ytm-pl-sub">${esc(playlistSummary(playlist))}</span></button>`).join('');
    sidebar.querySelectorAll<HTMLElement>('[data-sidebar-playlist]').forEach((button) => { button.onclick = () => openPlaylistPage(button.dataset.sidebarPlaylist); });
  }
  const drawer = $('drawerPlaylists');
  if (drawer) {
    drawer.innerHTML = `<button class="pl-link" type="button" data-drawer-kind="overview"><i class="fa-solid fa-bars-staggered"></i><span>Playlists</span></button>
      <button class="pl-link" type="button" data-drawer-kind="favorites"><i class="fa-solid fa-heart"></i><span>Liked music</span></button>
      <button class="pl-link" type="button" data-drawer-kind="recent"><i class="fa-solid fa-clock-rotate-left"></i><span>Recently played</span></button>
      ${playlists.map((playlist) => `<button class="pl-link" type="button" data-drawer-kind="playlist" data-playlist-id="${esc(playlist.id)}"><i class="fa-solid fa-bars-staggered"></i><span>${esc(playlist.title)}</span><small class="pl-count">${playlist.tracks.length}</small></button>`).join('')}
      <button class="pl-link pl-new" type="button" data-drawer-kind="new" ${storageError ? 'disabled' : ''}><i class="fa-solid fa-plus"></i><span>New playlist</span></button>`;
    drawer.querySelectorAll<HTMLElement>('[data-drawer-kind]').forEach((button) => { button.onclick = () => drawerPlaylistTap(button.dataset.drawerKind,button.dataset.playlistId || ''); });
  }
  renderPlaylistsPage();
}

function reconcileActivePlaylist(): void {
  const context = state.playbackContext;
  if (!context || context.source !== 'playlist') return;
  const playlist = loadPlaylists().find((item) => item.id === context.collectionId);
  if (!playlist) {
    if (!storageError) { context.source = 'manual'; context.collectionId = undefined; context.label = 'Deleted playlist (playback copy)'; }
    return;
  }
  context.label = playlist.title;
  const ids = playlistEntries(playlist).filter((entry) => entry.song).map((entry) => stableTrackRef(entry.song));
  if (JSON.stringify(ids) === JSON.stringify(context.order)) return;
  let anchor = context.playOrder[context.cursor];
  if (!ids.includes(anchor)) {
    anchor = context.playOrder.slice(0,context.cursor).reverse().find((id) => ids.includes(id));
  }
  context.order = ids;
  context.playOrder = state.isShuffle
    ? [...context.playOrder.filter((id) => ids.includes(id)),...ids.filter((id) => !context.playOrder.includes(id))]
    : [...ids];
  context.cursor = context.playOrder.indexOf(anchor);
  context.future = [];
  renderUpNext();
}
function renderAllPlaylistSurfaces(): void {
  const focused = document.activeElement as HTMLElement | null;
  const focusData = focused?.closest('#tabPlaylist') ? {...focused.dataset} : null;
  renderSidebarPlaylists();
  if (currentPlaylistId && $('tabPlaylist')?.classList.contains('active')) renderPlaylistPage();
  const picker = $('playlistPicker');
  if (picker?.classList.contains('active')) renderPickerOptions(picker);
  reconcileActivePlaylist();
  if (focusData && Object.keys(focusData).length) {
    const replacement = [...$('tabPlaylist').querySelectorAll<HTMLElement>('button')].find((button) => Object.entries(focusData).every(([key,value]) => button.dataset[key] === value));
    replacement?.focus({preventScroll:true});
  }
}

export function drawerPlaylistTap(kind: string,id: string): void {
  if ($('sideMenu')) $('sideMenu').style.display = 'none';
  if (kind === 'overview') return goTab('tabPlaylists');
  if (kind === 'favorites' || kind === 'recent') return goToSearchCategory(kind);
  if (kind === 'playlist') return openPlaylistPage(id);
  openPlaylistModal();
}

let editingBaseline: {title:string;description:string} | null = null;
let submitting = false;
export function openPlaylistModal(id?: string): void {
  loadStore();
  if (storageError) { goTab('tabPlaylists'); return; }
  const playlist = id ? loadPlaylists().find((item) => item.id === id) : null;
  if (id && !playlist) { toast('That playlist was deleted in another tab.', 'circle-info'); return; }
  editingPlaylistId = id || null;
  editingBaseline = playlist ? {title:playlist.title,description:playlist.description} : null;
  const title = $('playlistTitleInput') as HTMLInputElement, description = $('playlistDescInput') as HTMLInputElement;
  const submit = $('playlistSubmitBtn') as HTMLButtonElement, modal = $('playlistModal');
  if (!modal || !title || !description || !submit) return;
  $('playlistModalTitle').textContent = playlist ? 'Edit playlist' : 'New playlist';
  submit.textContent = playlist ? 'Save changes' : 'Create playlist';
  title.value = playlist?.title || ''; description.value = playlist?.description || '';
  $('playlistCreateError').hidden = true;
  updatePlaylistCta();
  modal.classList.add('active'); modal.setAttribute('aria-hidden','false'); document.body.classList.add('modal-open');
}
export function closePlaylistModal(): void {
  $('playlistModal')?.classList.remove('active');
  $('playlistModal')?.setAttribute('aria-hidden','true');
  document.body.classList.remove('modal-open');
  editingPlaylistId = null; editingBaseline = null; pendingTrackRef = null;
}
export function updatePlaylistCta(): void {
  const title = ($('playlistTitleInput') as HTMLInputElement | null)?.value.trim();
  const submit = $('playlistSubmitBtn') as HTMLButtonElement | null;
  if (submit) submit.disabled = submitting || !title;
  if (title) $('playlistCreateError').hidden = true;
}
export async function submitPlaylistModal(): Promise<void> {
  if (submitting) return;
  const title = ($('playlistTitleInput') as HTMLInputElement).value.trim();
  const description = ($('playlistDescInput') as HTMLInputElement).value.trim();
  if (!title) { $('playlistCreateError').hidden = false; $('playlistTitleInput').focus(); return; }
  const editingId = editingPlaylistId, baseline = editingBaseline, ref = pendingTrackRef;
  submitting = true; updatePlaylistCta();
  const result = await mutatePlaylists((playlists) => {
    if (editingId) {
      const existing = playlists.find((item) => item.id === editingId);
      if (!existing) throw new PlaylistDataError('That playlist was deleted in another tab.');
      if (baseline && (existing.title !== baseline.title || existing.description !== baseline.description)) throw new PlaylistDataError('This playlist was edited in another tab. Reopen Edit to use the latest details.');
      existing.title = title; existing.description = description; existing.updatedAt = Math.max(Date.now(),existing.updatedAt + 1);
      return existing;
    }
    if (playlists.length >= MAX_PLAYLISTS) throw new PlaylistDataError(`You can keep at most ${MAX_PLAYLISTS} playlists. Export or delete one before creating another.`);
    const now = Date.now();
    const created: Playlist = {schemaVersion:2,id:playlistId(),title,description,createdAt:now,updatedAt:now,tracks:ref ? [ref] : []};
    playlists.unshift(created); return created;
  });
  submitting = false; updatePlaylistCta();
  if (!result.ok) return;
  closePlaylistModal();
  toast(editingId ? 'Playlist updated.' : `Playlist “${title}” created`, 'circle-check');
  openPlaylistPage(result.value.id);
}

export function openPlaylistPage(id: string): void {
  if (!loadPlaylists().some((playlist) => playlist.id === id)) {
    currentPlaylistId = null; goTab('tabPlaylists'); toast('That playlist is no longer available.', 'circle-info'); return;
  }
  currentPlaylistId = id;
  lastTab = 'tabPlaylists';
  renderPlaylistPage(); showPlaylistTab('tabPlaylist'); window.scrollTo({top:0,behavior:'auto'});
}
function renderPlaylistPage(): void {
  const playlist = loadPlaylists().find((item) => item.id === currentPlaylistId), host = $('tabPlaylist');
  if (!host) return;
  if (!playlist) { currentPlaylistId = null; goTab('tabPlaylists'); return; }
  const entries = playlistEntries(playlist), available = entries.filter((entry) => entry.song);
  const missing = entries.length - available.length;
  host.innerHTML = `<button class="pl-back" type="button" data-playlist-back><i class="fa-solid fa-arrow-left"></i><span>Back to playlists</span></button>
    <div class="pl-head">${coversMarkup(playlist,'pl-cover pl-cover-mosaic')}<div class="pl-head-info">
      <h2 class="pl-name">${esc(playlist.title)}</h2><div class="pl-owner">${ownerAvatarMarkup()}<span>${esc(ownerName())}</span></div>
      <p class="pl-meta">${entries.length} track${entries.length === 1 ? '' : 's'} on this device. ${durationLabel(available.reduce((sum,entry) => sum + secondsOf(entry.song),0))}${missing ? `. ${missing} unavailable.` : ''}</p>
      ${playlist.description ? `<p class="pl-desc">${esc(playlist.description)}</p>` : ''}
      <div class="pl-actions">
        <button type="button" data-play-playlist aria-label="Play ${esc(playlist.title)}" ${available.length ? '' : 'disabled'}><i class="fa-solid fa-play"></i><span>Play</span></button>
        <button type="button" data-edit-current aria-label="Edit ${esc(playlist.title)}"><i class="fa-solid fa-pen"></i><span>Edit</span></button>
        <button type="button" data-export-current aria-label="Export ${esc(playlist.title)}"><i class="fa-solid fa-file-export"></i><span>Export</span></button>
        <button type="button" data-share-current aria-label="Share ${esc(playlist.title)} as a file"><i class="fa-solid fa-share-nodes"></i><span>Share file</span></button>
        <button type="button" class="danger" data-delete-current aria-label="Delete ${esc(playlist.title)}"><i class="fa-solid fa-trash"></i><span>Delete</span></button>
      </div></div></div>
    <section class="pl-content-section"><div class="pl-section-head"><h3>Tracks</h3><span>${entries.length}</span></div><div class="pl-track-list">
      ${entries.length ? entries.map((entry) => renderTrackRow(playlist,entry,entries.length)).join('') : '<div class="pl-empty"><h3>This playlist is empty</h3><p>Add a track from your library below or from any track menu.</p></div>'}
    </div></section>${renderSuggestions(playlist)}`;
  host.querySelector<HTMLElement>('[data-playlist-back]').onclick = () => goTab('tabPlaylists');
  host.querySelector<HTMLElement>('[data-edit-current]').onclick = () => openPlaylistModal(playlist.id);
  host.querySelector<HTMLElement>('[data-export-current]').onclick = () => downloadPlaylistFile(playlist);
  host.querySelector<HTMLElement>('[data-share-current]').onclick = () => void playlistPageShare();
  host.querySelector<HTMLElement>('[data-delete-current]').onclick = () => void deletePlaylist(playlist.id);
  host.querySelector<HTMLElement>('[data-play-playlist]').onclick = () => playPlaylist(playlist.id);
  host.querySelectorAll<HTMLElement>('[data-play-ref]').forEach((button) => { button.onclick = () => playPlaylist(playlist.id,button.dataset.playRef); });
  host.querySelectorAll<HTMLElement>('[data-remove-ref]').forEach((button) => { button.onclick = () => void removeTrackFromPlaylist(playlist.id,button.dataset.removeRef); });
  host.querySelectorAll<HTMLElement>('[data-move-ref]').forEach((button) => { button.onclick = () => void movePlaylistTrack(playlist.id,button.dataset.moveRef,Number(button.dataset.moveDelta)); });
  host.querySelectorAll<HTMLElement>('[data-relink-ref]').forEach((button) => { button.onclick = () => openRelinkPicker(playlist.id,button.dataset.relinkRef); });
  host.querySelectorAll<HTMLElement>('[data-restore-ref]').forEach((button) => { button.onclick = () => {
    const ref = playlist.tracks.find((item) => item.ref === button.dataset.restoreRef);
    if (ref) restoreLocalFile(ref.ref.startsWith('id:') ? ref.ref.slice(3) : `local_${crypto.randomUUID()}`,ref);
  }; });
  host.querySelectorAll<HTMLElement>('[data-add-id]').forEach((button) => { button.onclick = () => void addTrackToPlaylist(playlist.id,button.dataset.addId); });
  wireTrackDragging(host,playlist.id);
}
function renderTrackRow(playlist: Playlist,entry: PlaylistEntry,length: number): string {
  const title = entry.song?.title || entry.ref.title, artist = entry.song?.artist || entry.ref.artist;
  const key = esc(entry.ref.ref), image = entry.song?.img || entry.ref.img;
  return `<div class="pl-track${entry.song ? '' : ' is-missing'}" draggable="true" data-track-ref="${key}">
    <span class="pl-track-number" aria-hidden="true">${entry.position + 1}</span>
    ${image ? `<img src="${esc(image)}" alt="" loading="lazy" decoding="async">` : '<span class="pl-track-placeholder" aria-hidden="true"><i class="fa-solid fa-music"></i></span>'}
    ${entry.song ? `<button class="pl-track-main" type="button" data-play-ref="${key}" aria-label="Play ${esc(title)} by ${esc(artist)}"><span class="pl-track-meta"><b>${esc(title)}</b><span>${esc(artist)}</span></span></button>`
      : `<div class="pl-track-main"><span class="pl-track-meta"><b>${esc(title)}</b><span>${esc(artist)} — unavailable</span></span>${entry.ref.source === 'local' ? `<button class="pl-relink-btn" type="button" data-restore-ref="${key}" aria-label="Restore the file for ${esc(title)}">Restore file</button>` : ''}<button class="pl-relink-btn" type="button" data-relink-ref="${key}" aria-label="Relink ${esc(title)}">Relink</button></div>`}
    <div class="pl-track-order">
      <button type="button" data-move-ref="${key}" data-move-delta="-1" aria-label="Move ${esc(title)} up" aria-disabled="${entry.position === 0}"><i class="fa-solid fa-chevron-up"></i></button>
      <button type="button" data-move-ref="${key}" data-move-delta="1" aria-label="Move ${esc(title)} down" aria-disabled="${entry.position === length - 1}"><i class="fa-solid fa-chevron-down"></i></button>
      <button class="pl-track-drag" type="button" data-drag-ref="${key}" aria-label="Drag ${esc(title)} to reorder"><i class="fa-solid fa-grip-lines"></i></button>
    </div><button class="pl-track-remove" type="button" data-remove-ref="${key}" aria-label="Remove ${esc(title)} from ${esc(playlist.title)}"><i class="fa-solid fa-xmark"></i></button>
  </div>`;
}
function renderSuggestions(playlist: Playlist): string {
  const refs = new Set(playlist.tracks.map((ref) => ref.ref));
  const suggestions = state.songs.filter((song) => trackAvailable(song) && !refs.has(stableTrackRef(song))).slice(0,10);
  return suggestions.length ? `<section class="pl-content-section pl-suggestions"><div class="pl-section-head"><h3>From your library</h3><span>Add tracks</span></div><div class="pl-track-list">
    ${suggestions.map((song) => `<div class="pl-track pl-suggestion"><img src="${esc(song.img || '')}" alt="" loading="lazy" decoding="async"><div class="pl-track-meta"><b>${esc(song.title)}</b><span>${esc(song.artist)}</span></div>
      <button class="pl-add-btn" type="button" data-add-id="${esc(song.id)}" aria-label="Add ${esc(song.title)} to ${esc(playlist.title)}"><i class="fa-solid fa-plus"></i><span>Add</span></button></div>`).join('')}</div></section>` : '';
}
function wireTrackDragging(host: HTMLElement,id: string): void {
  let source: string | null = null;
  host.querySelectorAll<HTMLElement>('[data-track-ref]').forEach((row) => {
    row.ondragstart = (event) => { source = row.dataset.trackRef; event.dataTransfer?.setData('text/plain',source); row.classList.add('is-dragging'); };
    row.ondragend = () => { source = null; row.classList.remove('is-dragging'); };
    row.ondragover = (event) => { if (source) event.preventDefault(); };
    row.ondrop = (event) => { event.preventDefault(); if (source && source !== row.dataset.trackRef) void reorderPlaylistTrack(id,source,row.dataset.trackRef); source = null; };
  });
  host.querySelectorAll<HTMLElement>('[data-drag-ref]').forEach((handle) => {
    let target: string | null = null, pointer = -1;
    handle.onpointerdown = (event) => { event.preventDefault(); pointer = event.pointerId; source = handle.dataset.dragRef; target = source; handle.setPointerCapture?.(pointer); };
    handle.onpointermove = (event) => {
      if (event.pointerId !== pointer) return;
      const row = document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-track-ref]');
      if (row && host.contains(row)) target = row.dataset.trackRef;
    };
    handle.onpointerup = (event) => { if (event.pointerId === pointer && source && target && source !== target) void reorderPlaylistTrack(id,source,target); pointer = -1; source = target = null; };
    handle.onpointercancel = () => { pointer = -1; source = target = null; };
  });
}

export function playPlaylist(id: string,requested: number | string = 0): void {
  const playlist = loadPlaylists().find((item) => item.id === id);
  if (!playlist) return;
  const entries = playlistEntries(playlist).filter((entry) => entry.song);
  if (!entries.length) { toast('No available tracks remain. Restore or relink a track before playing this playlist.', 'circle-info'); return; }
  const selected = typeof requested === 'string' ? entries.find((entry) => entry.ref.ref === requested) : entries.find((entry) => entry.position === requested) || entries[0];
  if (!selected) { toast('That track is no longer available.', 'circle-info'); return; }
  playTrackSequence(entries.map((entry) => entry.song.id), {source:'playlist',collectionId:id,label:playlist.title,startId:selected.song.id});
}
export async function addTrackToPlaylist(id: string,trackIdOrLegacyIndex: string | number): Promise<void> {
  const song = typeof trackIdOrLegacyIndex === 'number' ? state.songs[trackIdOrLegacyIndex] : findSongById(trackIdOrLegacyIndex);
  if (!trackAvailable(song)) return;
  const ref = snapshotTrack(song);
  const result = await mutatePlaylists((playlists) => {
    const playlist = playlists.find((item) => item.id === id);
    if (!playlist) throw new PlaylistDataError('That playlist was deleted in another tab.');
    if (playlist.tracks.some((track) => track.ref === ref.ref)) throw new PlaylistDataError('That track is already in this playlist.');
    if (playlist.tracks.length >= MAX_TRACKS_PER_PLAYLIST) throw new PlaylistDataError('This playlist has reached its track limit.');
    playlist.tracks.push(ref); playlist.updatedAt = Date.now(); return playlist.title;
  });
  if (result.ok) toast(`Added to “${result.value}”`, 'circle-check');
}
export async function removeTrackFromPlaylist(id: string,key: string | number): Promise<void> {
  const result = await mutatePlaylists((playlists) => {
    const playlist = playlists.find((item) => item.id === id);
    if (!playlist) throw new PlaylistDataError('That playlist was deleted in another tab.');
    const index = typeof key === 'number' ? key : playlist.tracks.findIndex((track) => track.ref === key || track.legacyKey === key);
    if (index < 0 || index >= playlist.tracks.length) throw new PlaylistDataError('That track was already removed in another tab.');
    playlist.tracks.splice(index,1); playlist.updatedAt = Date.now();
  });
  if (result.ok) toast('Removed from playlist.', 'circle-check');
}
async function reorderPlaylistTrack(id: string,fromKey: string,toKey: string): Promise<void> {
  await mutatePlaylists((playlists) => {
    const playlist = playlists.find((item) => item.id === id);
    if (!playlist) throw new PlaylistDataError('That playlist was deleted in another tab.');
    const from = playlist.tracks.findIndex((track) => track.ref === fromKey), to = playlist.tracks.findIndex((track) => track.ref === toKey);
    if (from < 0 || to < 0) throw new PlaylistDataError('The playlist changed in another tab. Try the move again.');
    const [track] = playlist.tracks.splice(from,1); playlist.tracks.splice(to,0,track); playlist.updatedAt = Date.now();
  });
}
async function movePlaylistTrack(id: string,key: string,delta: number): Promise<void> {
  await mutatePlaylists((playlists) => {
    const playlist = playlists.find((item) => item.id === id);
    if (!playlist) throw new PlaylistDataError('That playlist was deleted in another tab.');
    const from = playlist.tracks.findIndex((track) => track.ref === key), to = from + delta;
    if (from < 0) throw new PlaylistDataError('That track was removed in another tab.');
    if (to < 0 || to >= playlist.tracks.length) return;
    const [track] = playlist.tracks.splice(from,1); playlist.tracks.splice(to,0,track); playlist.updatedAt = Date.now();
  });
}
export async function deletePlaylist(id: string): Promise<void> {
  const playlist = loadPlaylists().find((item) => item.id === id);
  if (!playlist || !window.confirm(`Delete “${playlist.title}”? Your music will remain in Aura.`)) return;
  const result = await mutatePlaylists((playlists) => { const index = playlists.findIndex((item) => item.id === id); if (index >= 0) playlists.splice(index,1); });
  if (!result.ok) return;
  currentPlaylistId = null; goTab('tabPlaylists'); toast('Playlist deleted.', 'circle-check');
}

function ensurePlaylistPicker(): HTMLElement {
  let overlay = $('playlistPicker');
  if (overlay) return overlay;
  overlay = document.createElement('div'); overlay.id = 'playlistPicker'; overlay.className = 'playlist-picker';
  overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-labelledby','playlistPickerTitle'); overlay.setAttribute('aria-hidden','true');
  overlay.innerHTML = '<div class="playlist-picker-card"><div class="playlist-picker-head"><div><h3 id="playlistPickerTitle">Add to playlist</h3><p id="playlistPickerDescription">Choose a collection.</p></div><button type="button" data-close-picker aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><input class="playlist-picker-search" type="search" aria-label="Filter available tracks" placeholder="Find a replacement track" hidden><div class="playlist-picker-list" data-picker-list></div></div>';
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLElement>('[data-close-picker]').onclick = () => closePlaylistPicker();
  overlay.onclick = (event) => { if (event.target === overlay) closePlaylistPicker(); };
  overlay.querySelector<HTMLInputElement>('.playlist-picker-search').oninput = () => renderPickerOptions(overlay);
  return overlay;
}
function renderPickerOptions(overlay: HTMLElement): void {
  const list = overlay.querySelector<HTMLElement>('[data-picker-list]'), search = overlay.querySelector<HTMLInputElement>('.playlist-picker-search');
  search.hidden = !pendingRelink;
  if (pendingRelink) {
    const query = search.value.trim().toLowerCase();
    const songs = state.songs.filter((song) => trackAvailable(song) && `${song.title} ${song.artist}`.toLowerCase().includes(query)).slice(0,100);
    list.innerHTML = songs.length ? songs.map((song) => `<button type="button" class="playlist-picker-option" data-relink-id="${esc(song.id)}"><span class="playlist-picker-cover"><img src="${esc(song.img || '')}" alt="" loading="lazy"></span><span><b>${esc(song.title)}</b><small>${esc(song.artist)}</small></span><i class="fa-solid fa-link"></i></button>`).join('') : '<p>No available tracks match. Try another search or restore the local file.</p>';
    list.querySelectorAll<HTMLElement>('[data-relink-id]').forEach((button) => { button.onclick = () => void relinkTrack(button.dataset.relinkId); });
    return;
  }
  const playlists = loadPlaylists();
  list.innerHTML = playlists.map((playlist) => {
    const added = playlist.tracks.some((track) => track.ref === pendingTrackRef?.ref);
    return `<button type="button" class="playlist-picker-option" data-picker-id="${esc(playlist.id)}" ${added ? 'disabled' : ''}>${coversMarkup(playlist,'playlist-picker-cover')}<span><b>${esc(playlist.title)}</b><small>${added ? 'Already added' : playlistSummary(playlist)}</small></span><i class="fa-solid ${added ? 'fa-check' : 'fa-plus'}"></i></button>`;
  }).join('') + `<button type="button" class="playlist-picker-new" data-picker-new ${storageError ? 'disabled' : ''}><i class="fa-solid fa-plus"></i><span>Create a new playlist</span></button>`;
  list.querySelectorAll<HTMLElement>('[data-picker-id]').forEach((button) => { button.onclick = () => void addPendingTrack(button.dataset.pickerId); });
  list.querySelector<HTMLElement>('[data-picker-new]').onclick = () => { closePlaylistPicker(false); openPlaylistModal(); };
}
function showPicker(): void {
  const overlay = ensurePlaylistPicker(); renderPickerOptions(overlay); overlay.classList.add('active'); overlay.setAttribute('aria-hidden','false'); document.body.classList.add('modal-open');
}
export function openPlaylistPicker(id: string | number): void {
  const song = findSongById(id);
  if (!song) return;
  pendingRelink = null; pendingTrackRef = snapshotTrack(song); $('trackSheetOverlay')?.classList.remove('active');
  ensurePlaylistPicker(); $('playlistPickerTitle').textContent = 'Add to playlist'; $('playlistPickerDescription').textContent = 'Choose a collection.'; showPicker();
}
function openRelinkPicker(id: string,key: string): void {
  pendingTrackRef = null; pendingRelink = {playlistId:id,ref:key};
  ensurePlaylistPicker(); $('playlistPickerTitle').textContent = 'Relink unavailable track'; $('playlistPickerDescription').textContent = 'Choose its replacement from your library.';
  (ensurePlaylistPicker().querySelector('.playlist-picker-search') as HTMLInputElement).value = '';
  showPicker();
}
async function relinkTrack(id: string): Promise<void> {
  const song = findSongById(id), target = pendingRelink;
  if (!song || !target) return;
  const result = await mutatePlaylists((playlists) => {
    const playlist = playlists.find((item) => item.id === target.playlistId), ref = snapshotTrack(song);
    const position = playlist?.tracks.findIndex((track) => track.ref === target.ref) ?? -1;
    if (!playlist || position < 0) throw new PlaylistDataError('That track was removed in another tab.');
    if (playlist.tracks.some((track,index) => index !== position && track.ref === ref.ref)) throw new PlaylistDataError('That replacement is already in this playlist.');
    playlist.tracks[position] = ref; playlist.updatedAt = Date.now();
  });
  if (result.ok) { closePlaylistPicker(); toast('Track relinked.', 'circle-check'); }
}
async function addPendingTrack(id: string): Promise<void> {
  const ref = pendingTrackRef;
  if (!ref) return;
  const result = await mutatePlaylists((playlists) => {
    const playlist = playlists.find((item) => item.id === id);
    if (!playlist) throw new PlaylistDataError('That playlist was deleted in another tab.');
    if (playlist.tracks.some((track) => track.ref === ref.ref)) throw new PlaylistDataError('That track is already in this playlist.');
    if (playlist.tracks.length >= MAX_TRACKS_PER_PLAYLIST) throw new PlaylistDataError('This playlist has reached its track limit.');
    playlist.tracks.push(ref); playlist.updatedAt = Date.now(); return playlist.title;
  });
  if (result.ok) { closePlaylistPicker(); toast(`Added to “${result.value}”`, 'circle-check'); }
}
export function closePlaylistPicker(clear = true): void {
  $('playlistPicker')?.classList.remove('active'); $('playlistPicker')?.setAttribute('aria-hidden','true'); document.body.classList.remove('modal-open');
  if (clear) { pendingTrackRef = null; pendingRelink = null; }
}

function safeFilename(value: string): string {
  return `${value.normalize('NFKD').replace(/[^a-zA-Z0-9 _-]/g,'').trim().replace(/\s+/g,'-').toLowerCase() || 'aura-playlist'}.aura-playlist.json`;
}
function downloadPlaylistFile(playlist: Playlist): void {
  const url = URL.createObjectURL(new Blob([encodePlaylistFile(playlist,state.songs)],{type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = safeFilename(playlist.title); link.click();
  window.setTimeout(() => URL.revokeObjectURL(url),1000);
  toast('Playlist exported. Import this file in Aura on another device; local audio files are not included.', 'circle-check');
}
export async function playlistPageShare(): Promise<void> {
  const playlist = loadPlaylists().find((item) => item.id === currentPlaylistId);
  if (!playlist) return;
  const file = new File([encodePlaylistFile(playlist,state.songs)],safeFilename(playlist.title),{type:'application/json'});
  try {
    if (navigator.share && navigator.canShare?.({files:[file]})) { await navigator.share({title:playlist.title,text:`Import this file in Aura Music to restore “${playlist.title}”.`,files:[file]}); return; }
  } catch (error) { if ((error as Error)?.name === 'AbortError') return; }
  downloadPlaylistFile(playlist);
}
export function playlistPageMore(): void { void playlistPageShare(); }
export function importPlaylistFile(): void {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new PlaylistDataError('That playlist file is too large.');
      const imported = decodePlaylistFile(await file.text(),state.songs);
      const available = playlistEntries(imported).filter((entry) => entry.song).length;
      const missing = imported.tracks.length - available;
      if (!window.confirm(`Import “${imported.title}”?\n\n${imported.tracks.length} tracks; ${available} available${missing ? `; ${missing} will stay as unavailable until you restore or relink them` : ''}.\nAudio files are not included.`)) return;
      imported.id = playlistId(); imported.createdAt = imported.updatedAt = Date.now();
      const result = await mutatePlaylists((playlists) => {
        if (playlists.length >= MAX_PLAYLISTS) throw new PlaylistDataError('Export or delete a playlist before importing another.');
        playlists.unshift(imported); return imported.id;
      });
      if (result.ok) { toast(`Imported “${imported.title}”`, 'circle-check'); openPlaylistPage(result.value); }
    } catch (error) { toast(error instanceof PlaylistDataError ? error.message : 'This is not a valid Aura playlist file.', 'triangle-exclamation'); }
  };
  input.click();
}

$('playlistModal')?.addEventListener('click',(event) => { if (event.target === event.currentTarget) closePlaylistModal(); });
let refreshFrame = 0;
function schedulePlaylistRefresh(): void {
  if (refreshFrame) return;
  refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; renderAllPlaylistSurfaces(); });
}
window.addEventListener('storage',(event) => { if (event.key === PLAYLISTS_KEY || event.key === null) schedulePlaylistRefresh(); });
window.addEventListener('aura:library-changed',() => { schedulePlaylistRefresh(); void migratePlaylistReferences(); });
try { playlistChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('aura-playlists-v2') : null; if (playlistChannel) playlistChannel.onmessage = schedulePlaylistRefresh; } catch { playlistChannel = null; }
renderSidebarPlaylists();
void migratePlaylistReferences();
