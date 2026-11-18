import { copyToClipboard, showTrackSheet, toast } from '../core/dom';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
import { resolveTrackId, stableTrackRef, trackAvailable } from '../core/track-identity';
import {
  advanceContext, applyPlaybackVisit, capturePlaybackVisit, createPlaybackContext, enqueueContext, previewPlayback, reorderContextUpcoming,
  setContextShuffle, type PlaybackPreview, type PlaybackReason, type PlaybackSource,
} from '../core/playback-context';
import { deleteTrack, openEditModal, playArtistByKey, renderLibrary, restoreLocalFile, toggleFavorite } from './library';
import {
  filterSongs, openPlayerSheet, pausePlayback, playSong, restartCurrentTrack,
  refreshLyricsForOpenSheet, currentPlaybackTime,
} from './player';
import { currentRadioStation, escapeHtml } from './radio';
import { filterSearchTab } from './search';
import { roomModeActive } from '../rooms/roomFlag';

export let trackSheetSongId: string | number | null = null;
export const findSongById = (id: string | number | null | undefined): any | null =>
  id === null || id === undefined ? null : resolveTrackId(id, state.songs);

export interface PlaybackSequenceOptions {
  source?: PlaybackSource;
  collectionId?: string;
  label?: string;
  startId?: string | number;
  shuffle?: boolean;
  clearManualQueue?: boolean;
}

function playable(id: string): boolean { return trackAvailable(findSongById(id)); }

function ensurePlaybackContext(): boolean {
  if (state.playbackContext) return true;
  const current = state.songs[state.currentIndex];
  if (!current) return false;
  state.playbackContext = createPlaybackContext(state.songs.map(stableTrackRef), {
    source: 'library', label: 'Library', startId: stableTrackRef(current), shuffle: state.isShuffle,
  });
  return !!state.playbackContext;
}

function playContextId(id: string, keepFull = false): boolean {
  const song = findSongById(id);
  if (!trackAvailable(song)) return false;
  return playSong(state.songs.indexOf(song), keepFull, true);
}

export function playTrackSequence(ids: Array<string | number>, options: PlaybackSequenceOptions = {}): boolean {
  const sequence = ids.map(findSongById).filter(trackAvailable).map(stableTrackRef);
  if (!sequence.length) { toast('There are no available tracks in this collection.', 'circle-info'); return false; }
  const start = options.startId === undefined ? sequence[0] : stableTrackRef(findSongById(options.startId));
  const previousQueue = options.clearManualQueue === false ? [...(state.playbackContext?.queue || [])] : [];
  if (options.shuffle !== undefined) state.isShuffle = options.shuffle;
  state.playbackContext = createPlaybackContext(sequence, {
    source: options.source || 'library', collectionId: options.collectionId, label: options.label,
    startId: start, shuffle: state.isShuffle,
  });
  state.playbackContext.queue = previousQueue;
  const started = playContextId(state.playbackContext.currentId);
  renderUpNext();
  return started;
}

export function syncPlaybackShuffle(enabled: boolean): void {
  if (state.playbackContext) state.playbackContext = setContextShuffle(state.playbackContext, enabled);
  renderUpNext();
}

export function queueSong(id: string | number, next = false): void {
  const song = findSongById(id);
  if (!trackAvailable(song)) { toast('This track is unavailable. Relink its file before queuing it.', 'triangle-exclamation'); return; }
  if (!ensurePlaybackContext()) return;
  const ref = stableTrackRef(song);
  if (state.playbackContext.currentId === ref) { toast('That track is already selected.', 'circle-info'); return; }
  enqueueContext(state.playbackContext, ref, next);
  renderUpNext();
  toast(next ? `“${song.title}” will play next` : `Added “${song.title}” to queue`, 'circle-check');
}

export function openTrackMenu(event: Event | null, id: string | number): void {
  event?.stopPropagation();
  const song = findSongById(id);
  if (!song) return;
  trackSheetSongId = song.id;
  const added = state.addedSongs.some((item: any) => String(item.id) === String(song.id));
  const actions: Array<[string, string, string]> = [
    ['favorite', song.favorite ? 'fa-solid fa-heart' : 'fa-regular fa-heart', song.favorite ? 'Remove from favorites' : 'Add to favorites'],
    ['playNext', 'fa-solid fa-forward-step', 'Play next'],
    ['addQueue', 'fa-solid fa-list-ol', 'Add to queue'],
    ['playlist', 'fa-solid fa-list', 'Add to playlist'],
  ];
  if (song.isLocal && song.missing) actions.push(['restoreLocal', 'fa-solid fa-file-audio', 'Restore local file']);
  if (added) actions.push(['edit', 'fa-solid fa-pen', 'Edit track']);
  if (!song.isLocal) actions.push(['share', 'fa-solid fa-share-nodes', 'Share track link']);
  if (!song.isYouTube && song.url) actions.push(['download', 'fa-solid fa-download', 'Download audio']);
  if (added) actions.push(['delete', 'fa-solid fa-trash', 'Remove from library']);
  const rows = actions.map(([action, icon, label]) => `<button type="button" class="track-sheet-row${action === 'delete' ? ' danger' : ''}" data-track-action="${action}"><i class="${icon}" aria-hidden="true"></i>${label}</button>`).join('');
  showTrackSheet({ img: song.img, title: song.title, artist: song.artist, rowsHtml: rows });
  $('trackSheetRows')?.querySelectorAll<HTMLElement>('[data-track-action]').forEach((button) => {
    button.onclick = () => queueTrackAction(button.dataset.trackAction);
  });
}

export function closeTrackMenu(): void {
  $('trackSheetOverlay')?.classList.remove('active');
  trackSheetSongId = null;
}
$('trackSheetOverlay')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeTrackMenu();
});

export function shareCurrentTrack(): void {
  const song = state.songs[state.currentIndex];
  if (!song) return;
  trackSheetSongId = song.id;
  queueTrackAction('share');
}

export function queueTrackAction(action: string): void {
  const song = findSongById(trackSheetSongId);
  closeTrackMenu();
  if (!song) return;
  if (action === 'playNext' || action === 'addQueue') return queueSong(song.id, action === 'playNext');
  if (action === 'favorite') { toggleFavorite(null, String(song.id)); renderUpNext(); }
  else if (action === 'restoreLocal') restoreLocalFile(String(song.id));
  else if (action === 'edit') openEditModal(null, song.id);
  else if (action === 'playlist') (globalThis as any).openPlaylistPicker?.(song.id);
  else if (action === 'delete') void deleteTrack(null, song.id);
  else if (action === 'share') {
    if (song.isLocal) { toast('Local files stay on this device. Use Download audio to share the file.', 'circle-info'); return; }
    const url = new URL('/', location.href);
    url.searchParams.set('play', song.isYouTube && song.videoId ? `yt:${song.videoId}` : String(song.id));
    if (navigator.share) void navigator.share({ title: song.title, text: `${song.title} — ${song.artist}`, url: url.href }).catch((error) => {
      if (error?.name !== 'AbortError') toast('The track link could not be shared.', 'triangle-exclamation');
    });
    else copyToClipboard(url.href, 'Track link copied');
  } else if (action === 'download') {
    const link = document.createElement('a');
    link.href = song.hfUrl || song.url;
    link.download = song.title || 'track';
    link.rel = 'noopener';
    link.click();
    toast('Audio download requested. This does not make the web app available offline.', 'circle-info');
  }
}

export const UP_NEXT_PHONE_LIMIT = 12, UP_NEXT_DESKTOP_LIMIT = 50;
export const upNextLimit = (): number => window.matchMedia('(min-width:900px)').matches ? UP_NEXT_DESKTOP_LIMIT : UP_NEXT_PHONE_LIMIT;
interface QueueItem extends PlaybackPreview { id: string; song: any }

function upcomingItems(): QueueItem[] {
  const context = state.playbackContext;
  return context ? previewPlayback(context,state.repeatMode,upNextLimit(),playable)
    .map((preview) => ({...preview,id:preview.visit.id,song:findSongById(preview.visit.id)})) : [];
}

export function getRollingUpNextItems(): any[] { return upcomingItems().map((item) => item.song); }

export function renderUpNext(): void {
  const list = $('upNextList');
  if (!list) return;
  const context = state.playbackContext;
  const label = $('queueContextLabel');
  if (label) label.textContent = context?.label ? `Up next from ${context.label}` : 'Up next';
  const clear = $('clearQueueBtn') as HTMLButtonElement | null;
  if (clear) clear.disabled = !context?.queue.length;
  const items = upcomingItems();
  if (!items.length) {
    list.innerHTML = '<p class="up-next-empty">This collection has reached its end. Choose another track, or turn on Repeat all.</p>';
    return;
  }
  list.innerHTML = items.map((item) => {
    const { song, id, kind, position } = item;
    return `<div class="up-next-row" data-up-next-id="${escapeHtml(id)}" data-queue-kind="${kind}" data-queue-position="${position}">
      <button class="up-next-main" type="button" aria-label="Play ${escapeHtml(song.title)} next">
        <img class="up-next-cover" src="${escapeHtml(song.img || '')}" alt="" loading="lazy" decoding="async">
        <span class="up-next-info"><span class="up-next-song-title">${escapeHtml(song.title)}</span><span class="up-next-song-artist">${escapeHtml(song.artist)}${kind === 'explicit' ? ' (queued)' : ''}</span></span>
      </button>
      <div class="up-next-actions">
        <button class="up-next-action favorite" type="button" aria-label="${song.favorite ? 'Unlike' : 'Like'} ${escapeHtml(song.title)}"><i class="fa-${song.favorite ? 'solid' : 'regular'} fa-heart" aria-hidden="true"></i></button>
        <button class="up-next-action move-up" type="button" aria-label="Move ${escapeHtml(song.title)} up in queue"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
        <button class="up-next-action move-down" type="button" aria-label="Move ${escapeHtml(song.title)} down in queue"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
        <button class="up-next-action reorder" type="button" aria-label="Drag ${escapeHtml(song.title)} within ${kind === 'explicit' ? 'queued tracks' : 'this collection'}"><i class="fa-solid fa-grip-lines" aria-hidden="true"></i></button>
        ${kind === 'explicit' ? `<button class="up-next-action remove" type="button" aria-label="Remove ${escapeHtml(song.title)} from queue"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : ''}
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll<HTMLElement>('.up-next-row').forEach((row, index) => {
    const item = items[index];
    row.querySelector<HTMLElement>('.up-next-main').onclick = () => selectUpcoming(item);
    row.querySelector<HTMLElement>('.favorite').onclick = () => { toggleFavorite(null, String(item.song.id)); renderUpNext(); };
    row.querySelector<HTMLElement>('.move-up').onclick = () => moveUpcoming(item, -1);
    row.querySelector<HTMLElement>('.move-down').onclick = () => moveUpcoming(item, 1);
    row.querySelector<HTMLElement>('.remove')?.addEventListener('click', () => {
      context.queue.splice(item.position, 1); renderUpNext();
    });
    if (item.kind === 'history') row.querySelectorAll<HTMLButtonElement>('.move-up,.move-down,.reorder').forEach((button) => { button.disabled = true; });
    initUpNextReorder(row.querySelector<HTMLElement>('.reorder'));
  });
}

function selectUpcoming(item: QueueItem): void {
  const context = state.playbackContext;
  if (!context || !playable(item.id)) return;
  context.history.push(capturePlaybackVisit(context));
  context.queue = [...item.after.queue];
  context.future = item.after.future.map((visit) => ({...visit}));
  applyPlaybackVisit(context,item.visit);
  playContextId(item.id);
  renderUpNext();
}

function moveUpcoming(item: QueueItem, delta: number): void {
  const context = state.playbackContext;
  if (item.kind === 'history') return;
  const group = upcomingItems().filter((other) => other.kind === item.kind);
  const from = group.findIndex((other) => other.id === item.id);
  const to = from + delta;
  if (!context || to < 0 || to >= group.length) return;
  [group[from], group[to]] = [group[to], group[from]];
  if (item.kind === 'explicit') {
    const visible = group.map((other) => other.id);
    context.queue = [...visible, ...context.queue.filter((id) => !visible.includes(id))];
  } else reorderContextUpcoming(context, group.map((other) => other.id), state.repeatMode);
  renderUpNext();
}

export function promoteVisibleOrder(ids: string[]): void {
  if (state.playbackContext) reorderContextUpcoming(state.playbackContext, ids, state.repeatMode);
}

let upNextDrag: { pointerId: number; row: HTMLElement; moved: boolean; startY: number } | null = null;
export function initUpNextReorder(handle: HTMLElement): void {
  handle.onpointerdown = (event) => {
    event.preventDefault();
    const row = handle.closest<HTMLElement>('.up-next-row');
    if (!row) return;
    handle.setPointerCapture?.(event.pointerId);
    upNextDrag = { row, pointerId: event.pointerId, moved: false, startY: event.clientY };
    row.classList.add('dragging-row');
  };
  handle.onpointermove = (event) => {
    if (!upNextDrag || upNextDrag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - upNextDrag.startY) > 4) upNextDrag.moved = true;
    const list = $('upNextList');
    const rows = [...list.querySelectorAll<HTMLElement>(`.up-next-row[data-queue-kind="${upNextDrag.row.dataset.queueKind}"]:not(.dragging-row)`)];
    const target = rows.find((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    if (target) list.insertBefore(upNextDrag.row, target);
    else {
      const last = rows[rows.length - 1];
      if (last) last.after(upNextDrag.row);
    }
  };
  handle.onpointerup = finishUpNextReorder;
  handle.onpointercancel = () => { upNextDrag = null; renderUpNext(); };
}

export function finishUpNextReorder(event: PointerEvent): void {
  if (!upNextDrag || upNextDrag.pointerId !== event.pointerId) return;
  const context = state.playbackContext;
  if (context && upNextDrag.moved) {
    const rows = [...$('upNextList').querySelectorAll<HTMLElement>('.up-next-row')];
    const explicit = rows.filter((row) => row.dataset.queueKind === 'explicit').map((row) => row.dataset.upNextId);
    const traversal = rows.filter((row) => row.dataset.queueKind === 'context').map((row) => row.dataset.upNextId);
    context.queue = [...explicit, ...context.queue.filter((id) => !explicit.includes(id))];
    reorderContextUpcoming(context, traversal, state.repeatMode);
    toast('Queue order updated.', 'list-check');
  }
  upNextDrag = null;
  renderUpNext();
}

export function openUpNext(): void { renderUpNext(); openPlayerSheet('queue'); }
export function closeUpNext(): void {
  const sheet = $('upNextSheet');
  sheet?.classList.remove('active', 'dragging');
  sheet?.setAttribute('aria-hidden', 'true');
}
$('clearQueueBtn')?.addEventListener('click', () => {
  if (state.playbackContext) state.playbackContext.queue = [];
  renderUpNext();
});

export function playPrevious(keepFull = false): boolean {
  if (roomModeActive() || currentRadioStation || !ensurePlaybackContext()) return false;
  if (currentPlaybackTime() > 3) { restartCurrentTrack(); return true; }
  const next = advanceContext(state.playbackContext, -1, state.repeatMode, playable);
  if (!next.id) { restartCurrentTrack(); return false; }
  const result = playContextId(next.id, keepFull); renderUpNext(); return result;
}

export function playNext(keepFull = false, reason: PlaybackReason = 'user'): boolean {
  if (roomModeActive() || currentRadioStation || !ensurePlaybackContext()) return false;
  const next = advanceContext(state.playbackContext, 1, state.repeatMode, playable, reason);
  if (!next.id) { pausePlayback(); renderUpNext(); return false; }
  if (reason === 'ended' && state.repeatMode === 'one') { restartCurrentTrack(); return true; }
  const result = playContextId(next.id, keepFull); renderUpNext(); return result;
}

$('fullHeaderMenuBtn')?.addEventListener('click', (event) => {
  const song = state.songs[state.currentIndex];
  if (song) openTrackMenu(event, song.id);
});
$('fullPrevBtn')?.addEventListener('click', () => playPrevious(true));
$('fullNextBtn')?.addEventListener('click', () => playNext(true));
$('nextBtn')?.addEventListener('click', () => playNext());

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const menu = target.closest<HTMLElement>('[data-song-menu]');
  if (menu) { event.preventDefault(); event.stopPropagation(); openTrackMenu(event, menu.dataset.songMenu); return; }
  const favorite = target.closest<HTMLElement>('[data-like-song-id]');
  if (favorite) { event.preventDefault(); event.stopPropagation(); toggleFavorite(null,favorite.dataset.likeSongId); return; }
  const artistSong = target.closest<HTMLElement>('[data-play-artist-song-id]');
  if (artistSong && !target.closest('button')) {
    (globalThis as any).playArtistSongs?.(artistSong.dataset.artistName,false,artistSong.dataset.playArtistSongId);
    return;
  }
  const play = target.closest<HTMLElement>('[data-play-song-id]');
  if (play && !target.closest('button:not([data-play-song-id]), a, input, [data-song-menu], [data-like-song-id]')) {
    const song = findSongById(play.dataset.playSongId);
    if (song) {
      if (play.dataset.artistKey) playArtistByKey(play.dataset.artistKey,String(song.id));
      else playSong(state.songs.indexOf(song));
    }
  }
}, true);
