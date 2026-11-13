import { copyToClipboard, showTrackSheet, toast } from '../core/dom';
import { $, state } from '../core/state';
import { resolveTrackId, stableTrackRef, trackAvailable } from '../core/track-identity';
import {
  advanceContext, applyPlaybackVisit, capturePlaybackVisit, createPlaybackContext, previewPlayback,
  reorderContextUpcoming, retainContextInterruptions, setContextShuffle, type PlaybackContext, type PlaybackReason, type PlaybackSource,
} from '../core/playback-context';
import {
  advanceArtistPlayback, captureArtistVisit, createArtistPlayback, previewArtistPlayback, reorderArtistUpcoming, setArtistShuffle,
  retainArtistInterruptions, type ArtistPlayback, type ArtistPlaybackOptions,
} from '../core/artistPlayback';
import { deleteTrack, openEditModal, restoreLocalFile, toggleFavorite } from './library';
import {
  auraYTVideoId, getActivePlaybackTime, openPlayerSheet, pauseMainPlayback, playSong, playYouTubeProResult, restartCurrentTrack,
} from './player';
import { currentRadioStation, escapeHtml } from './radio';
import { auraYTQueue, extractYouTubeId } from './search';
import { roomModeActive } from '../rooms/roomFlag';

// Keep this exported, mutable raw-ID array compatible with production callers.
// Stable references belong to transient contexts, never to the catalogue's IDs.
export const manualQueue: Array<string | number> = [];
export let trackSheetSongId: string | number | null = null;
let artistPlayback: ArtistPlayback | null = null;
const replaceManualQueue = (ids: Array<string | number>) => manualQueue.splice(0, manualQueue.length, ...ids);
export const findSongById = (id: string | number | null | undefined): any | null =>
  id == null ? null : resolveTrackId(id, state.songs);
const playable = (id: string) => trackAvailable(findSongById(id));
const reference = (id: string | number) => stableTrackRef(findSongById(id)) || (/^(?:id:|video:|legacy:)/.test(String(id)) ? String(id) : `id:${id}`);
const rawId = (id: string) => findSongById(id)?.id ?? (id.startsWith('id:') ? id.slice(3) : id);

export interface PlaybackSequenceOptions {
  source?: PlaybackSource;
  collectionId?: string;
  label?: string;
  startId?: string | number;
  shuffle?: boolean;
  random?: () => number;
  clearManualQueue?: boolean;
}

export function clearArtistPlayback(): void {
  if (artistPlayback) { syncArtistQueue(artistPlayback); retainArtistInterruptions(artistPlayback); retainArtistQueue(artistPlayback); }
  artistPlayback = null;
  if (state.playbackContext?.source === 'artist') state.playbackContext = null;
}

function mirrorArtistContext(context: ArtistPlayback): void {
  const visit = (entry: ArtistPlayback['history'][number]) => ({
    ...entry, id: reference(entry.id), anchorId: entry.anchorId ? reference(entry.anchorId) : undefined,
    cursor: context.playOrder.indexOf(entry.override ? entry.anchorId : entry.id),
  });
  state.playbackContext = {
    source: 'artist', collectionId: context.collectionId, label: context.label,
    order: context.order.map(reference), playOrder: context.playOrder.map(reference), currentId: reference(context.currentId),
    cursor: context.cursor, overrideActive: context.overrideActive, queue: context.queue.map(reference),
    history: context.history.map(visit), future: context.future.map(visit),
  };
}

export function getArtistPlayback(): ArtistPlayback | null {
  if (currentRadioStation || roomModeActive()) { clearArtistPlayback(); return null; }
  if (artistPlayback && String(state.songs[state.currentIndex]?.id) !== artistPlayback.currentId) clearArtistPlayback();
  return artistPlayback;
}

function syncArtistQueue(context: ArtistPlayback): void {
  context.queue = manualQueue.map(String);
  if (context.shuffle !== !!state.isShuffle) { setArtistShuffle(context, !!state.isShuffle); replaceManualQueue(context.queue.map(rawId)); }
  mirrorArtistContext(context);
}
function retainArtistQueue(context: ArtistPlayback): void {
  replaceManualQueue(context.queue.map(rawId));
  mirrorArtistContext(context);
}
function syncContextQueue(context: PlaybackContext): void { context.queue = manualQueue.map(reference); }
function retainContextQueue(context: PlaybackContext): void { replaceManualQueue(context.queue.map(rawId)); }
const scopedContext = () => state.playbackContext && state.playbackContext.source !== 'artist'
  && (state.playbackContext.source !== 'library' || !!state.playbackContext.collectionId)
  ? state.playbackContext : null;

/** Retire a projected schedule without losing pending raw-ID queue entries. */
export function retainPlaybackInterruptions(): void {
  if (artistPlayback) { syncArtistQueue(artistPlayback); retainArtistInterruptions(artistPlayback); retainArtistQueue(artistPlayback); }
  else if (state.playbackContext) { syncContextQueue(state.playbackContext); retainContextInterruptions(state.playbackContext); retainContextQueue(state.playbackContext); }
}

export function playTrackSequence(ids: Array<string | number>, options?: PlaybackSequenceOptions): boolean {
  const songs = ids.map(findSongById).filter(trackAvailable);
  if (!songs.length) { toast('There are no available tracks in this collection.', 'circle-info'); return false; }
  retainPlaybackInterruptions();
  if (options?.clearManualQueue === true) replaceManualQueue([]);
  if (options?.source === 'artist') {
    const artistOptions: ArtistPlaybackOptions = { ...options, collectionId: options.collectionId || 'artist', label: options.label || 'Artist',
      startId: options.startId === undefined ? undefined : findSongById(options.startId)?.id };
    artistPlayback = createArtistPlayback(songs.map(song => song.id), artistOptions);
    state.isShuffle = artistPlayback.shuffle;
    syncArtistQueue(artistPlayback);
    syncShuffleControls();
    const started = playSong(state.songs.indexOf(findSongById(artistPlayback.currentId)), false, true);
    renderUpNext();
    return started;
  }
  clearArtistPlayback();
  if (options) {
    if (options.shuffle !== undefined) state.isShuffle = options.shuffle;
    state.playbackContext = createPlaybackContext(songs.map(stableTrackRef), {
      ...options, startId: options.startId === undefined ? undefined : reference(options.startId), shuffle: state.isShuffle,
    });
    syncContextQueue(state.playbackContext);
    syncShuffleControls();
    const started = playSong(state.songs.indexOf(findSongById(state.playbackContext.currentId)), false, true);
    renderUpNext();
    return started;
  }
  // The original public sequence API queues its remainder, then resumes ordinary
  // library/search transport. Preserve separately queued, unheard interruptions.
  const remainder = songs.slice(1).map(song => song.id);
  const sequence = new Set(songs.map(song => String(song.id)));
  replaceManualQueue([...remainder, ...manualQueue.filter(id => !sequence.has(String(id)))]);
  const started = playSong(state.songs.indexOf(songs[0]));
  renderUpNext();
  return started;
}

function syncShuffleControls(): void {
  for (const id of ['shuffleBtn', 'miniShuffleBtn']) $(id)?.classList.toggle(id === 'shuffleBtn' ? 'mode-active' : 'active', state.isShuffle);
}
export function syncPlaybackShuffle(enabled: boolean): void {
  state.isShuffle = enabled;
  if (artistPlayback) { syncArtistQueue(artistPlayback); retainArtistQueue(artistPlayback); }
  else if (state.playbackContext) {
    syncContextQueue(state.playbackContext);
    state.playbackContext = setContextShuffle(state.playbackContext, enabled);
    retainContextQueue(state.playbackContext);
  }
  syncShuffleControls(); renderUpNext();
}

export function queueSong(id: string | number, next = false): void {
  const song = findSongById(id);
  if (!trackAvailable(song)) { toast('This track is unavailable. Relink its file before queuing it.', 'triangle-exclamation'); return; }
  if (String(state.songs[state.currentIndex]?.id) === String(song.id)) { toast('That song is already playing', 'circle-info'); return; }
  retainPlaybackInterruptions();
  const queue = manualQueue.filter(item => String(item) !== String(song.id));
  if (next) queue.unshift(song.id); else queue.push(song.id);
  replaceManualQueue(queue);
  if (artistPlayback) syncArtistQueue(artistPlayback);
  else if (state.playbackContext) syncContextQueue(state.playbackContext);
  renderUpNext();
  toast(next ? `“${song.title}” will play next` : `Added “${song.title}” to queue`, 'circle-check');
}

export function openTrackMenu(event: Event | null, id: string | number): void {
  event?.stopPropagation();
  const song = findSongById(id);
  if (!song) return;
  trackSheetSongId = song.id;
  const added = state.addedSongs.some(item => String(item.id) === String(song.id));
  const actions: Array<[string, string, string]> = [
    ['favorite', song.favorite ? 'fa-solid fa-heart' : 'fa-regular fa-heart', song.favorite ? 'Remove from Favorites' : 'Add to Favorites'],
    ['playNext', 'fa-solid fa-forward-step', 'Play next'], ['addQueue', 'fa-solid fa-list-ol', 'Add to queue'],
    ['playlist', 'fa-solid fa-list', 'Add to Playlist'],
  ];
  if (song.isLocal && song.missing) actions.push(['restoreLocal', 'fa-solid fa-file-audio', 'Restore local file']);
  if (added) actions.push(['edit', 'fa-solid fa-pen', 'Edit Track']);
  actions.push(['share', 'fa-solid fa-share-nodes', 'Share']);
  if (!song.isYouTube && song.url) actions.push(['download', 'fa-solid fa-download', 'Download audio']);
  if (added) actions.push(['delete', 'fa-solid fa-trash', 'Remove from Library']);
  const rows = actions.map(([action, icon, label]) => `<button type="button" class="track-sheet-row${action === 'delete' ? ' danger' : ''}" data-track-action="${action}"><i class="${icon}" aria-hidden="true"></i>${label}</button>`).join('');
  showTrackSheet({ img: song.img, title: song.title, artist: song.artist, rowsHtml: rows });
  $('trackSheetRows')?.querySelectorAll<HTMLElement>('[data-track-action]').forEach(button => {
    button.onclick = () => queueTrackAction(button.dataset.trackAction);
  });
}
export function closeTrackMenu(): void { $('trackSheetOverlay')?.classList.remove('active'); trackSheetSongId = null; }
$('trackSheetOverlay')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeTrackMenu(); });

function shareTrack(song: any): void {
  const shareUrl = song.isYouTube && song.videoId ? `https://youtu.be/${song.videoId}` : song.hfUrl || song.url || '';
  if (song.isLocal) { toast('Local files stay on this device. Download the audio to share the file.', 'circle-info'); return; }
  if (navigator.share) void navigator.share({ title: song.title, text: `${song.title} — ${song.artist}`, url: shareUrl || undefined }).catch(() => {});
  else if (shareUrl) copyToClipboard(shareUrl, 'Link copied to clipboard');
  else toast('Sharing is not supported on this device', 'triangle-exclamation');
}
export function shareCurrentTrack(): void { const song = state.songs[state.currentIndex]; if (song) shareTrack(song); }
export function queueTrackAction(action: string): void {
  const song = findSongById(trackSheetSongId); closeTrackMenu();
  if (!song) return;
  if (action === 'playNext' || action === 'addQueue') return queueSong(song.id, action === 'playNext');
  if (action === 'favorite') { toggleFavorite(null, String(song.id)); renderUpNext(); }
  else if (action === 'restoreLocal') restoreLocalFile(String(song.id));
  else if (action === 'edit') openEditModal(null, song.id);
  else if (action === 'playlist') (globalThis as any).openPlaylistPicker?.(song.id);
  else if (action === 'delete') void deleteTrack(null, song.id);
  else if (action === 'share') shareTrack(song);
  else if (action === 'download') {
    const link = document.createElement('a'); link.href = song.hfUrl || song.url; link.download = song.title || 'track'; link.rel = 'noopener'; link.click();
    toast('Audio download requested. This does not make the web app available offline.', 'circle-info');
  }
}

export const UP_NEXT_PHONE_LIMIT = 4, UP_NEXT_DESKTOP_LIMIT = 30;
export const upNextLimit = () => window.matchMedia?.('(min-width:900px)').matches ? UP_NEXT_DESKTOP_LIMIT : UP_NEXT_PHONE_LIMIT;
const UP_NEXT_REORDER_HELP = 'Drag a handle, or focus it and press Arrow Up or Arrow Down to reorder.';
const UP_NEXT_CONTROLS = ['.up-next-play', '.up-next-action.favorite', '.up-next-action.reorder', '.move-up', '.move-down', '.remove'];

export function getRollingUpNextItems(): any[] {
  const artist = getArtistPlayback();
  if (artist) {
    syncArtistQueue(artist);
    const seen = new Set([artist.currentId]);
    return previewArtistPlayback(artist, state.repeatMode, upNextLimit(), playable)
      .filter(id => { if (seen.has(id)) return false; seen.add(id); return true; }).map(findSongById);
  }
  const context = scopedContext();
  if (context) {
    syncContextQueue(context);
    const seen = new Set([context.currentId]);
    return previewPlayback(context, state.repeatMode, upNextLimit(), playable)
      .filter(item => { if (seen.has(item.visit.id)) return false; seen.add(item.visit.id); return true; }).map(item => findSongById(item.visit.id));
  }
  const result: any[] = [], seen = new Set<string>();
  const current = String(state.songs[state.currentIndex]?.id);
  const add = (song: any) => {
    if (!trackAvailable(song) || String(song.id) === current || seen.has(String(song.id)) || result.length >= upNextLimit()) return;
    seen.add(String(song.id)); result.push(song);
  };
  for (const id of manualQueue) add(findSongById(id));
  const start = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  for (let n = 0; n < state.songs.length && result.length < upNextLimit(); n++) add(state.songs[(start + n) % state.songs.length]);
  return result;
}
const rowId = (song: any) => scopedContext() ? stableTrackRef(song) : String(song.id);
const queued = (song: any) => manualQueue.some(id => String(id) === String(song.id));
function focusUpNextControl(id: string, selector = '.up-next-action.reorder'): HTMLElement | null {
  const row = [...($('upNextList')?.querySelectorAll<HTMLElement>('.up-next-row') || [])].find(item => item.dataset.upNextId === id);
  const control = row?.querySelector<HTMLElement>(selector); control?.focus({preventScroll:true}); return control || null;
}
function announceUpNextReorder(message: string): void { const status = $('upNextReorderStatus'); if (status) status.textContent = message; }

function selectUpcoming(song: any): void {
  const artist = getArtistPlayback();
  if (artist) {
    syncArtistQueue(artist);
    const copy: ArtistPlayback = {...artist, order:[...artist.order], playOrder:[...artist.playOrder], queue:[...artist.queue], history:[], future:artist.future.map(entry => ({...entry}))};
    const skipped: ArtistPlayback['future'] = [];
    for (let n = 0; n < upNextLimit(); n++) {
      const id = advanceArtistPlayback(copy, 1, state.repeatMode, playable);
      if (!id) return;
      if (id !== String(song.id)) { if (copy.overrideActive) skipped.push(captureArtistVisit(copy)); continue; }
      artist.history.push(captureArtistVisit(artist));
      artist.currentId = copy.currentId; artist.cursor = copy.cursor; artist.overrideActive = copy.overrideActive;
      const anchorId = copy.playOrder[copy.cursor], skippedIds = new Set(skipped.map(entry => entry.id));
      artist.future = [...skipped.map(entry => ({...entry, anchorId})), ...copy.future.filter(entry => entry.id !== id && !skippedIds.has(entry.id))];
      artist.queue = [...new Set([...skipped.map(entry => entry.id), ...artist.queue])].filter(entry => entry !== id);
      retainArtistQueue(artist); playSong(state.songs.indexOf(song), false, true); break;
    }
  } else if (scopedContext()) {
    const context = scopedContext(); syncContextQueue(context);
    const preview = previewPlayback(context, state.repeatMode, upNextLimit(), playable);
    const selected = preview.findIndex(entry => entry.visit.id === stableTrackRef(song)), item = preview[selected];
    if (!item) return;
    context.history.push(capturePlaybackVisit(context));
    const skipped = preview.slice(0, selected).filter(entry => entry.visit.override).map(entry => entry.visit);
    const skippedIds = new Set(skipped.map(entry => entry.id)), anchorId = item.after.playOrder[item.after.cursor];
    context.queue = [...new Set([...skippedIds, ...context.queue])].filter(id => id !== item.visit.id);
    context.future = [...skipped.map(entry => ({...entry, anchorId})), ...item.after.future.filter(entry => entry.id !== item.visit.id && !skippedIds.has(entry.id)).map(entry => ({...entry}))];
    applyPlaybackVisit(context, item.visit); retainContextQueue(context);
    playSong(state.songs.indexOf(song), false, true);
  } else {
    replaceManualQueue(manualQueue.filter(id => String(id) !== String(song.id)));
    playSong(state.songs.indexOf(song));
  }
  closeUpNext(); renderUpNext();
}

export function renderUpNext(): void {
  const list = $('upNextList'); if (!list) return;
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused && list.contains(focused) ? focused.closest<HTMLElement>('.up-next-row')?.dataset.upNextId : undefined;
  const focusControl = focusId !== undefined ? UP_NEXT_CONTROLS.find(selector => focused.matches(selector)) : undefined;
  const items = getRollingUpNextItems();
  const label = $('queueContextLabel'); if (label) label.textContent = state.playbackContext?.label ? `Up next from ${state.playbackContext.label}` : 'Up next';
  const clear = $('clearQueueBtn') as HTMLButtonElement | null; if (clear) clear.disabled = !manualQueue.length;
  if (!$('upNextReorderHelp')) list.insertAdjacentHTML('beforebegin', `<p id="upNextReorderHelp" class="up-next-reorder-help">${UP_NEXT_REORDER_HELP}</p>`);
  if (!$('upNextReorderStatus')) list.insertAdjacentHTML('beforebegin', '<p id="upNextReorderStatus" class="up-next-reorder-status" role="status" aria-live="polite" aria-atomic="true"></p>');
  $('upNextReorderHelp').hidden = !items.length; $('upNextReorderStatus').hidden = !items.length;
  if (!items.length) { announceUpNextReorder(''); list.innerHTML = '<p class="up-next-empty">Nothing queued. Choose another track or turn on Repeat all.</p>'; return; }
  list.innerHTML = items.map((song, index) => {
    const title = escapeHtml(song.title || 'Untitled'), artist = escapeHtml(song.artist || 'Unknown Artist');
    return `<div class="up-next-row" data-up-next-id="${escapeHtml(rowId(song))}" data-queue-kind="${queued(song) ? 'explicit' : 'context'}">
      <button class="up-next-play up-next-main" type="button" aria-label="Play ${title} by ${artist}">
        <img class="up-next-cover" src="${escapeHtml(song.img || '')}" alt="" loading="lazy" decoding="async">
        <span class="up-next-info"><span class="up-next-song-title">${title}</span><span class="up-next-song-artist">${artist}</span></span>
      </button><div class="up-next-actions">
        <button class="up-next-action favorite" type="button" aria-label="${song.favorite ? 'Remove from favorites' : 'Add to favorites'}: ${title}"><i class="fa-${song.favorite ? 'solid' : 'regular'} fa-heart" aria-hidden="true"></i></button>
        <button class="up-next-action move-up" type="button" aria-label="Move ${title} up in queue"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
        <button class="up-next-action move-down" type="button" aria-label="Move ${title} down in queue"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
        <button class="up-next-action reorder" type="button" aria-label="Reorder ${title}, position ${index + 1} of ${items.length}" aria-describedby="upNextReorderHelp" aria-keyshortcuts="ArrowUp ArrowDown"></button>
        ${queued(song) ? `<button class="up-next-action remove" type="button" aria-label="Remove ${title} from queue"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : ''}
      </div></div>`;
  }).join('');
  list.querySelectorAll<HTMLElement>('.up-next-row').forEach((row, index) => {
    const song = items[index];
    row.querySelector<HTMLElement>('.up-next-play').onclick = () => selectUpcoming(song);
    row.querySelector<HTMLElement>('.favorite').onclick = event => { event.stopPropagation(); toggleFavorite(null, String(song.id)); renderUpNext(); };
    for (const [selector, delta] of [['.move-up', -1], ['.move-down', 1]] as const) row.querySelector<HTMLElement>(selector).onclick = () => moveVisible(row.dataset.upNextId, delta);
    row.querySelector<HTMLElement>('.remove')?.addEventListener('click', () => {
      replaceManualQueue(manualQueue.filter(id => String(id) !== String(song.id)));
      if (artistPlayback) artistPlayback.future = artistPlayback.future.filter(entry => entry.id !== String(song.id));
      if (state.playbackContext) state.playbackContext.future = state.playbackContext.future.filter(entry => entry.id !== stableTrackRef(song));
      renderUpNext();
    });
    initUpNextReorder(row.querySelector<HTMLElement>('.reorder'));
  });
  if (focusControl) focusUpNextControl(focusId, focusControl);
}

export function promoteVisibleOrder(ids: string[]): void {
  const artist = getArtistPlayback();
  if (artist) { syncArtistQueue(artist); reorderArtistUpcoming(artist, ids.map(id => String(findSongById(id)?.id ?? id)), state.repeatMode); retainArtistQueue(artist); return; }
  const context = scopedContext();
  if (context) {
    syncContextQueue(context);
    const refs = [...new Set(ids.map(reference))];
    const explicit = new Set([...context.queue, ...context.future.filter(entry => entry.override).map(entry => entry.id)]);
    const pending = context.future.filter(entry => !refs.includes(entry.id));
    reorderContextUpcoming(context, refs.filter(id => !explicit.has(id)), state.repeatMode);
    let anchor = context.playOrder[context.cursor];
    context.future = [...refs.map(id => { const override = explicit.has(id); if (!override) anchor = id; return {id,override,anchorId:anchor,cursor:context.playOrder.indexOf(anchor)}; }), ...pending];
    context.queue = [...refs.filter(id => context.queue.includes(id)), ...context.queue.filter(id => !refs.includes(id))];
    retainContextQueue(context); return;
  }
  const visible = [...new Set(ids.map(id => findSongById(id)).filter(Boolean).map(song => song.id))];
  const seen = new Set(visible.map(String));
  replaceManualQueue([...visible, ...manualQueue.filter(id => !seen.has(String(id)))]);
}

export let upNextDrag: {row: HTMLElement; pointerId: number; moved: boolean; startY: number} | null = null;
function moveVisible(id: string, delta: number): void {
  const ids = [...$('upNextList').querySelectorAll<HTMLElement>('.up-next-row')].map(row => row.dataset.upNextId);
  const from = ids.indexOf(id), to = from + delta, title = findSongById(id)?.title || 'Untitled';
  if (from < 0) return;
  if (to < 0 || to >= ids.length) { announceUpNextReorder(`“${title}” is already ${to < 0 ? 'first' : 'last'} in Up Next, position ${from + 1} of ${ids.length}.`); return; }
  [ids[from], ids[to]] = [ids[to], ids[from]]; promoteVisibleOrder(ids); renderUpNext();
  focusUpNextControl(id)?.scrollIntoView({block:'nearest',inline:'nearest'});
  announceUpNextReorder(`Moved “${title}” to position ${to + 1} of ${ids.length}.`);
}
export function initUpNextReorder(handle: HTMLElement): void {
  handle.onclick = event => { event.stopPropagation(); if (event.detail === 0) announceUpNextReorder(UP_NEXT_REORDER_HELP); };
  handle.onkeydown = event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || upNextDrag) return;
    event.preventDefault(); event.stopPropagation(); moveVisible(handle.closest<HTMLElement>('.up-next-row').dataset.upNextId, event.key === 'ArrowUp' ? -1 : 1);
  };
  handle.onpointerdown = event => {
    event.preventDefault(); event.stopPropagation(); const row = handle.closest<HTMLElement>('.up-next-row'); if (!row) return;
    handle.focus({preventScroll:true}); handle.setPointerCapture?.(event.pointerId);
    upNextDrag = {row,pointerId:event.pointerId,moved:false,startY:event.clientY}; row.classList.add('dragging-row'); handle.style.touchAction = 'none';
  };
  handle.onpointermove = event => {
    if (!upNextDrag || upNextDrag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - upNextDrag.startY) > 4) upNextDrag.moved = true;
    const list = $('upNextList'), rows = [...list.querySelectorAll<HTMLElement>('.up-next-row:not(.dragging-row)')];
    const target = rows.find(row => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    if (target) list.insertBefore(upNextDrag.row, target); else list.appendChild(upNextDrag.row);
  };
  handle.onpointerup = finishUpNextReorder;
  handle.onpointercancel = () => { upNextDrag = null; renderUpNext(); };
}
export function finishUpNextReorder(event: PointerEvent): void {
  if (!upNextDrag || upNextDrag.pointerId !== event.pointerId) return;
  const ids = [...$('upNextList').querySelectorAll<HTMLElement>('.up-next-row')].map(row => row.dataset.upNextId);
  const id = upNextDrag.row.dataset.upNextId, moved = upNextDrag.moved;
  if (moved) promoteVisibleOrder(ids);
  upNextDrag.row.classList.remove('dragging-row'); upNextDrag = null; renderUpNext(); focusUpNextControl(id);
  if (moved) announceUpNextReorder(`Moved “${findSongById(id)?.title || 'Untitled'}” to position ${ids.indexOf(id) + 1} of ${ids.length}.`);
}

export function openUpNext(): void { renderUpNext(); openPlayerSheet('queue'); }
export function closeUpNext(): void {
  const sheet = $('upNextSheet'); sheet?.classList.remove('active', 'dragging'); sheet?.style.removeProperty('--up-next-drag-y'); sheet?.setAttribute('aria-hidden', 'true');
}
$('clearQueueBtn')?.addEventListener('click', () => {
  replaceManualQueue([]);
  if (artistPlayback) { artistPlayback.queue = []; artistPlayback.future = artistPlayback.future.filter(entry => !entry.override); }
  if (state.playbackContext) { state.playbackContext.queue = []; state.playbackContext.future = state.playbackContext.future.filter(entry => !entry.override); }
  renderUpNext();
});
$('upNextOpenBtn')?.addEventListener('click', event => { event.stopPropagation(); openUpNext(); });
$('upNextCloseBtn')?.addEventListener('click', closeUpNext);

function advanceScopedTransport(direction: 1 | -1, keepFull: boolean, reason: PlaybackReason): boolean | null {
  const artist = getArtistPlayback();
  if (artist) {
    syncArtistQueue(artist);
    const id = advanceArtistPlayback(artist, direction, state.repeatMode, playable); retainArtistQueue(artist);
    if (id) playSong(state.songs.indexOf(findSongById(id)), keepFull, true);
    else if (direction === 1) pauseMainPlayback();
    renderUpNext(); return !!id;
  }
  const context = scopedContext(); if (!context) return null;
  syncContextQueue(context);
  const step = advanceContext(context, direction, state.repeatMode, playable, reason); retainContextQueue(context);
  if (step.id) {
    if (reason === 'ended' && state.repeatMode === 'one') restartCurrentTrack();
    else playSong(state.songs.indexOf(findSongById(step.id)), keepFull, true);
  } else if (direction === 1) pauseMainPlayback();
  renderUpNext(); return !!step.id;
}

export async function playPrevious(keepFull = false): Promise<boolean> {
  if (currentRadioStation || roomModeActive()) return false;
  // Preserve the artist's production Previous history; scoped playlists also
  // offer the local transport's conventional restart after three seconds.
  if (scopedContext() && getActivePlaybackTime() > 3) { restartCurrentTrack(); return true; }
  const scoped = advanceScopedTransport(-1, keepFull, 'user'); if (scoped !== null) return scoped;
  if (auraYTVideoId && auraYTQueue.length) {
    const current = auraYTQueue.findIndex(meta => String(meta?.id) === auraYTVideoId || extractYouTubeId(meta) === auraYTVideoId);
    const index = current >= 0 ? current : Math.max(0, state.auraYTQueueIndex);
    state.auraYTQueueIndex = (index - 1 + auraYTQueue.length) % auraYTQueue.length;
    await playYouTubeProResult(auraYTQueue[state.auraYTQueueIndex]); return true;
  }
  if (!state.songs.length) return false;
  for (let n = 1; n <= state.songs.length; n++) {
    const index = (state.currentIndex - n + state.songs.length) % state.songs.length;
    if (trackAvailable(state.songs[index])) return playSong(index, keepFull);
  }
  return false;
}

export async function playNext(keepFull = false, reason: PlaybackReason = 'user'): Promise<boolean> {
  if (currentRadioStation || roomModeActive()) return false;
  const scoped = advanceScopedTransport(1, keepFull, reason); if (scoped !== null) return scoped;
  while (manualQueue.length) {
    const song = findSongById(manualQueue.shift());
    if (!trackAvailable(song)) continue;
    const started = playSong(state.songs.indexOf(song), keepFull); renderUpNext(); return started;
  }
  if (auraYTVideoId && auraYTQueue.length) {
    const current = auraYTQueue.findIndex(meta => String(meta?.id) === auraYTVideoId || extractYouTubeId(meta) === auraYTVideoId);
    const index = current >= 0 ? current : Math.max(0, state.auraYTQueueIndex);
    const candidates = auraYTQueue.map((_, i) => i).filter(i => i !== index);
    state.auraYTQueueIndex = state.isShuffle && candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : (index + 1) % auraYTQueue.length;
    await playYouTubeProResult(auraYTQueue[state.auraYTQueueIndex]); return true;
  }
  if (!state.songs.length) return false;
  const candidates = state.songs.map((song, index) => ({song,index})).filter(({song,index}) => trackAvailable(song) && index !== state.currentIndex);
  if (state.isShuffle && candidates.length) return playSong(candidates[Math.floor(Math.random() * candidates.length)].index, keepFull);
  for (let n = 1; n <= state.songs.length; n++) {
    const index = (state.currentIndex + n) % state.songs.length;
    if (trackAvailable(state.songs[index])) { const started = playSong(index, keepFull); renderUpNext(); return started; }
  }
  pauseMainPlayback(); renderUpNext(); return false;
}

function openCurrentTrackMenu(event: Event): void { const song = state.songs[state.currentIndex]; if (song) openTrackMenu(event, song.id); }
$('fullHeaderMenuBtn')?.addEventListener('click', openCurrentTrackMenu);
$('artInfoBtn')?.addEventListener('click', openCurrentTrackMenu);
$('artShareBtn')?.addEventListener('click', event => { event.stopPropagation(); shareCurrentTrack(); });
$('fullPrevBtn')?.addEventListener('click', event => { event.stopPropagation(); void playPrevious(true); });
$('fullNextBtn')?.addEventListener('click', event => { event.stopPropagation(); void playNext(true); });
$('nextBtn')?.addEventListener('click', event => { event.stopPropagation(); void playNext(); });

document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const menu = target?.closest?.<HTMLElement>('[data-song-menu]');
  if (menu) { event.preventDefault(); event.stopPropagation(); openTrackMenu(event, menu.dataset.songMenu); return; }
  const favorite = target?.closest?.<HTMLElement>('[data-like-song-id]');
  if (favorite) { event.preventDefault(); event.stopPropagation(); toggleFavorite(null, favorite.dataset.likeSongId); return; }
  const play = target?.closest?.<HTMLElement>('[data-play-song-id]');
  if (play && !target.closest('button:not([data-play-song-id]), a, input, [data-song-menu], [data-like-song-id]')) {
    const song = findSongById(play.dataset.playSongId); if (song) playSong(state.songs.indexOf(song));
  }
}, true);
