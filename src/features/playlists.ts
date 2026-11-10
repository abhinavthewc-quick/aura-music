import { state, $, trackKey, trackMatchesKey } from '../core/state';
import { toast, getSavedUserName } from '../core/dom';
import { goTab, showPlaylistTab } from '../ui/nav';
import { activeDialogOwnsFocus } from '../ui/a11y';
import { playSong } from './player';
import { goToSearchCategory } from './search';
import {
  createPlaylistShare, isPlaylistTrackAvailable, matchSharedPlaylist, PLAYLIST_SHARE_PREFIX,
  PlaylistShareError, playlistShareUrl, validateSharedPlaylist,
  type SharedPlaylist,
} from '../core/playlist-sharing';

const PLAYLISTS_KEY = 'auraPlaylists';

type Privacy = 'Public' | 'Private' | 'Unlisted';
type Playlist = {
  id: string;
  title: string;
  description: string;
  privacy: Privacy;
  year: number | string;
  createdAt: number;
  tracks: string[];
  shared?: SharedPlaylist;
};

let currentPlaylistId: string | null = null;
let editingPlaylistId: string | null = null;
let pendingTrackKey: string | null = null;
let lastTab = 'tabPlaylists';
let sharedPreview: { playlist: SharedPlaylist } | { error: string } | null = null;
type SharePanel = {
  playlistId: string;
  playlist: SharedPlaylist;
  url: string;
  status: string;
  tone: 'neutral' | 'success' | 'error';
  busy: boolean;
};
let sharePanel: SharePanel | null = null;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string));
}

function normalizePlaylist(raw: any): Playlist | null {
  if (!raw || typeof raw !== 'object' || !String(raw.id || '').trim()) return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const privacy: Privacy = ['Public', 'Private', 'Unlisted'].includes(raw.privacy)
    ? raw.privacy
    : 'Private';
  let shared: SharedPlaylist | undefined;
  if (raw.shared) {
    try { shared = validateSharedPlaylist(raw.shared); } catch { /* Ignore invalid saved preview metadata. */ }
  }
  return {
    id: String(raw.id),
    title: Array.from(title).slice(0, 60).join(''),
    description: Array.from(String(raw.description || '').trim()).slice(0, 140).join(''),
    privacy,
    year: raw.year || new Date(Number(raw.createdAt) || Date.now()).getFullYear(),
    createdAt: Number(raw.createdAt) || Date.now(),
    tracks: Array.from(new Set(Array.isArray(raw.tracks) ? raw.tracks.map(String) : [])),
    ...(shared ? { shared } : {}),
  };
}

function loadPlaylists(): Playlist[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePlaylist).filter((playlist): playlist is Playlist => Boolean(playlist));
  } catch {
    return [];
  }
}

function savePlaylists(playlists: Playlist[]): boolean {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
    return true;
  } catch {
    toast('This playlist could not be saved. Check browser storage and try again.', 'triangle-exclamation');
    return false;
  }
}

function resolveSong(key: string): { song: any; index: number } | null {
  const index = state.songs.findIndex((song: any) => trackMatchesKey(song, key));
  return index < 0 ? null : { song: state.songs[index], index };
}

function ownerName(): string {
  const saved = (getSavedUserName?.() || '').trim();
  return saved || ($('displayUserName')?.textContent || '').trim() || 'Aura listener';
}

function secondsOf(song: any): number {
  if (typeof song?.duration === 'number' && Number.isFinite(song.duration)) return Math.max(0, Math.round(song.duration));
  if (typeof song?.duration !== 'string' || !song.duration.includes(':')) return 0;
  const parts = song.duration.split(':').map((part: string) => Number.parseInt(part, 10) || 0);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + (parts[1] || 0);
}

function durationLabel(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0 min';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours) return `${hours} hr${hours === 1 ? '' : 's'} ${minutes ? `${minutes} min` : ''}`.trim();
  return `${Math.max(1, minutes)} min`;
}

function playlistTrackEntries(playlist: Playlist): Array<{ key: string; song: any; index: number; available: boolean }> {
  const seen = new Set<string>();
  return playlist.tracks.flatMap((key) => {
    const resolved = resolveSong(key);
    const identity = resolved ? trackKey(resolved.song) : key;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ key, song: resolved?.song || null, index: resolved?.index ?? -1, available: isPlaylistTrackAvailable(resolved?.song) }];
  });
}

function playlistSongs(playlist: Playlist): Array<{ key: string; song: any; index: number }> {
  return playlistTrackEntries(playlist).filter((entry) => entry.available);
}

function coversMarkup(playlist: Playlist, className: string): string {
  const covers = playlistSongs(playlist)
    .map(({ song }) => String(song.img || ''))
    .filter(Boolean)
    .slice(0, 4);
  const cells = Array.from({ length: 4 }, (_, index) => covers[index]
    ? `<img src="${esc(covers[index])}" alt="" loading="lazy" decoding="async">`
    : `<span><i class="fa-solid fa-music"></i></span>`).join('');
  return `<div class="${className}" aria-hidden="true">${cells}</div>`;
}

function ownerAvatarMarkup(): string {
  const profilePhoto = $('profilePhoto');
  if (profilePhoto instanceof HTMLImageElement && profilePhoto.src && !profilePhoto.hidden) {
    return `<img class="pl-owner-avatar" src="${esc(profilePhoto.src)}" alt="">`;
  }
  return `<span class="pl-owner-avatar">${esc(ownerName().slice(0, 1).toUpperCase())}</span>`;
}

export function renderPlaylistsPage(): void {
  const host = $('tabPlaylists');
  if (!host) return;
  const playlists = loadPlaylists();

  host.innerHTML = `
    <div class="playlists-page-head">
      <div>
        <h2>Playlists</h2>
        <p>Collections saved on this device.</p>
      </div>
      <button class="playlist-create-btn" type="button" data-create-playlist aria-label="New playlist">
        <i class="fa-solid fa-plus"></i><span>New playlist</span>
      </button>
    </div>
    ${playlists.length ? `
      <div class="playlists-grid">
        ${playlists.map((playlist) => {
          const entries = playlistTrackEntries(playlist);
          const available = entries.filter((entry) => entry.available).length;
          return `<article class="playlist-card" data-playlist-id="${esc(playlist.id)}">
            ${coversMarkup(playlist, 'playlist-card-cover')}
            <div class="playlist-card-copy">
              <h3><button class="playlist-card-open" type="button" data-open-playlist="${esc(playlist.id)}" aria-label="Open ${esc(playlist.title)}">${esc(playlist.title)}</button></h3>
              <p>${entries.length} track${entries.length === 1 ? '' : 's'} · ${available < entries.length ? `${available} available` : 'On this device'}</p>
            </div>
            <button class="playlist-card-menu" type="button" data-edit-playlist="${esc(playlist.id)}" aria-label="Edit ${esc(playlist.title)}">
              <i class="fa-solid fa-ellipsis"></i>
            </button>
          </article>`;
        }).join('')}
      </div>` : `
      <div class="playlists-empty">
        <div class="playlists-empty-mark"><i class="fa-solid fa-bars-staggered"></i></div>
        <h3>Build your first playlist</h3>
        <p>Group tracks from your Aura library and keep the collection on this device.</p>
        <button class="playlist-create-btn" type="button" data-create-playlist><i class="fa-solid fa-plus"></i>New playlist</button>
      </div>`}
  `;

  host.querySelectorAll<HTMLElement>('[data-create-playlist]').forEach((button) => {
    button.onclick = () => openPlaylistModal();
  });
  host.querySelectorAll<HTMLButtonElement>('[data-open-playlist]').forEach((button) => {
    button.onclick = () => openPlaylistPage(button.dataset.openPlaylist || '');
  });
  host.querySelectorAll<HTMLElement>('[data-edit-playlist]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      openPlaylistModal(button.dataset.editPlaylist);
    };
  });
}

export function renderSidebarPlaylists(): void {
  const playlists = loadPlaylists();
  const sidebar = $('sidebarPlaylists');
  if (sidebar) {
    sidebar.innerHTML = playlists.map((playlist) => `
      <div class="ytm-playlist-item" role="button" tabindex="0" data-sidebar-playlist="${esc(playlist.id)}">
        <div class="ytm-pl-row"><span class="ytm-pl-name">${esc(playlist.title)}</span><small class="pl-count">${playlist.tracks.length}</small></div>
        <span class="ytm-pl-sub">On this device · ${playlist.tracks.length ? `${playlist.tracks.length} track${playlist.tracks.length === 1 ? '' : 's'}` : 'Empty'}</span>
      </div>`).join('');
    sidebar.querySelectorAll<HTMLElement>('[data-sidebar-playlist]').forEach((item) => {
      const open = () => openPlaylistPage(item.dataset.sidebarPlaylist || '');
      item.onclick = open;
      item.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      };
    });
  }

  const drawer = $('drawerPlaylists');
  if (drawer) {
    drawer.innerHTML = `
      <button class="pl-link" type="button" data-drawer-kind="overview"><i class="fa-solid fa-bars-staggered"></i><span>Playlists</span></button>
      <button class="pl-link" type="button" data-drawer-kind="favorites"><i class="fa-solid fa-heart"></i><span>Liked Music</span></button>
      <button class="pl-link" type="button" data-drawer-kind="recent"><i class="fa-solid fa-clock-rotate-left"></i><span>Recently Played</span></button>
      ${playlists.map((playlist) => `<button class="pl-link" type="button" data-drawer-kind="playlist" data-playlist-id="${esc(playlist.id)}"><i class="fa-solid fa-bars-staggered"></i><span>${esc(playlist.title)}</span><small class="pl-count">${playlist.tracks.length}</small></button>`).join('')}
      <button class="pl-link pl-new" type="button" data-drawer-kind="new"><i class="fa-solid fa-plus"></i><span>New playlist</span></button>`;
    drawer.querySelectorAll<HTMLElement>('[data-drawer-kind]').forEach((button) => {
      button.onclick = () => drawerPlaylistTap(button.dataset.drawerKind || '', button.dataset.playlistId || '');
    });
  }

  renderPlaylistsPage();
}

export function drawerPlaylistTap(kind: string, playlistId: string): void {
  const sideMenu = $('sideMenu');
  if (sideMenu) sideMenu.style.display = 'none';
  if (kind === 'overview') return goTab('tabPlaylists');
  if (kind === 'favorites' || kind === 'recent') return goToSearchCategory(kind);
  if (kind === 'playlist') return openPlaylistPage(playlistId);
  openPlaylistModal();
}

export function openPlaylistModal(id?: string): void {
  editingPlaylistId = id || null;
  const playlist = id ? loadPlaylists().find((item) => item.id === id) : null;
  const modal = $('playlistModal');
  if (!modal) return;

  const titleInput = $('playlistTitleInput') as HTMLInputElement | null;
  const descriptionInput = $('playlistDescInput') as HTMLInputElement | null;
  const submitButton = $('playlistSubmitBtn') as HTMLButtonElement | null;
  if (!titleInput || !descriptionInput || !submitButton) return;

  $('playlistModalTitle')!.textContent = playlist ? 'Edit playlist' : 'New playlist';
  submitButton.textContent = playlist ? 'Save changes' : 'Create playlist';
  titleInput.value = playlist?.title || '';
  descriptionInput.value = playlist?.description || '';
  $('playlistCreateError')!.hidden = true;
  updatePlaylistCta();
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  // The shared dialog manager captures the opener before focusing this field.
  // A separate timer could run first on a busy frame and lose that opener.
}

export function closePlaylistModal(): void {
  const modal = $('playlistModal');
  if (modal?.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
  modal?.classList.remove('active');
  modal?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  editingPlaylistId = null;
  pendingTrackKey = null;
}

export function updatePlaylistCta(): void {
  const title = ($('playlistTitleInput') as HTMLInputElement | null)?.value.trim();
  const submitButton = $('playlistSubmitBtn') as HTMLButtonElement | null;
  if (submitButton) submitButton.disabled = !title;
  if (title && $('playlistCreateError')) $('playlistCreateError')!.hidden = true;
}

export function submitPlaylistModal(): void {
  const titleInput = $('playlistTitleInput') as HTMLInputElement | null;
  const descriptionInput = $('playlistDescInput') as HTMLInputElement | null;
  if (!titleInput || !descriptionInput) return;

  const title = titleInput.value.trim();
  if (!title) {
    $('playlistCreateError')!.hidden = false;
    titleInput.focus();
    return;
  }

  const playlists = loadPlaylists();
  const wasEditing = Boolean(editingPlaylistId);
  let playlist: Playlist | undefined;
  if (editingPlaylistId) {
    playlist = playlists.find((item) => item.id === editingPlaylistId);
    if (!playlist) return closePlaylistModal();
    playlist.title = title;
    playlist.description = descriptionInput.value.trim();
    playlist.privacy = 'Private';
  } else {
    playlist = {
      id: `pl_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      title,
      description: descriptionInput.value.trim(),
      privacy: 'Private',
      year: new Date().getFullYear(),
      createdAt: Date.now(),
      tracks: pendingTrackKey ? [pendingTrackKey] : [],
    };
    playlists.unshift(playlist);
  }

  if (!savePlaylists(playlists)) return;
  pendingTrackKey = null;
  renderSidebarPlaylists();
  closePlaylistModal();
  toast(wasEditing ? 'Playlist updated' : `Playlist “${title}” created`, 'circle-check');
  openPlaylistPage(playlist.id);
}

export function openPlaylistPage(id: string): void {
  const playlist = loadPlaylists().find((item) => item.id === id);
  if (!playlist) {
    toast('That playlist is no longer available.', 'triangle-exclamation');
    renderSidebarPlaylists();
    return;
  }
  const active = document.querySelector<HTMLElement>('.tab-content.active');
  if (active && active.id !== 'tabPlaylist') lastTab = active.id;
  if (sharedPreview) clearSharedPlaylistLink();
  sharedPreview = null;
  currentPlaylistId = id;
  renderPlaylistPage();
  showPlaylistTab('tabPlaylist');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPlaylistPage(): void {
  if (sharedPreview) return renderSharedPlaylistPreview();
  const playlist = loadPlaylists().find((item) => item.id === currentPlaylistId);
  const host = $('tabPlaylist');
  if (!playlist || !host) return;
  const entries = playlistSongs(playlist);
  const allEntries = playlistTrackEntries(playlist);
  const unavailable = allEntries.length - entries.length;
  const totalSeconds = entries.reduce((sum, { song }) => sum + secondsOf(song), 0);
  const linkField = $('playlistShareLink') as HTMLTextAreaElement | null;
  const linkSelection = linkField && document.activeElement === linkField ? [linkField.selectionStart, linkField.selectionEnd] : null;

  host.innerHTML = `
    <button class="pl-back" type="button" data-playlist-back><i class="fa-solid fa-arrow-left"></i>Back to playlists</button>
    <div class="pl-head">
      ${coversMarkup(playlist, 'pl-cover pl-cover-mosaic')}
      <div class="pl-head-info">
        <p class="pl-kicker">Playlist</p>
        <h2 class="pl-name">${esc(playlist.title)}</h2>
        <div class="pl-owner">${ownerAvatarMarkup()}<span>${esc(ownerName())}</span></div>
        <p class="pl-meta">On this device · ${esc(String(playlist.year))} · ${allEntries.length} track${allEntries.length === 1 ? '' : 's'} · ${durationLabel(totalSeconds)}</p>
        ${playlist.description ? `<p class="pl-desc">${esc(playlist.description)}</p>` : ''}
        <div class="pl-actions">
          <button type="button" data-play-playlist ${entries.length ? '' : 'disabled'}><i class="fa-solid fa-play"></i><span>Play</span></button>
          <button type="button" data-edit-current aria-label="Edit playlist"><i class="fa-solid fa-pen" aria-hidden="true"></i><span>Edit</span></button>
          <button type="button" data-share-current aria-label="Share playlist" aria-controls="playlistSharePanel" aria-expanded="${sharePanel?.playlistId === playlist.id}"><i class="fa-solid fa-share" aria-hidden="true"></i><span>Share</span></button>
          <button type="button" class="danger" data-delete-current aria-label="Delete playlist"><i class="fa-solid fa-trash" aria-hidden="true"></i><span>Delete</span></button>
        </div>
      </div>
    </div>
    <div id="playlistSharePanel" data-playlist-share-slot></div>
    <section class="pl-content-section">
      <div class="pl-section-head"><h3>Tracks</h3><span>${allEntries.length}</span></div>
      ${unavailable ? `<p class="pl-availability">${unavailable} track${unavailable === 1 ? ' is' : 's are'} unavailable in your library. Their places are kept.</p>` : ''}
      <div class="pl-track-list">
        ${allEntries.length ? allEntries.map(({ key, song, index, available }, position) => {
          const details = playlist.shared?.tracks.find((track) => track.key === key);
          const title = song?.title || details?.title || 'Unavailable track';
            const content = `
              <span class="pl-track-number">${position + 1}</span>
              ${available ? `<img src="${esc(song.img || '')}" alt="" loading="lazy" decoding="async">` : '<span class="pl-track-placeholder" aria-hidden="true"><i class="fa-solid fa-music"></i></span>'}
              <span class="pl-track-meta"><b>${esc(title)}</b><span>${esc(available ? song.artist : `${song?.artist || details?.artist || 'Unknown artist'} · ${song?.isLocal ? 'Local file missing on this device' : 'Not in your library'}`)}</span></span>`;
            return `<div class="pl-track ${available ? 'pl-track-playable' : 'pl-track-unavailable'}" ${available ? '' : 'data-unavailable-track'}>
              ${available ? `<button class="pl-track-play" type="button" data-play-index="${index}" aria-label="Play ${esc(title)} by ${esc(song.artist || 'Unknown artist')}">${content}</button>` : content}
              <button class="pl-track-remove" type="button" data-remove-key="${esc(encodeURIComponent(key))}" aria-label="Remove ${esc(title)} from playlist"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
          </div>`;
        }).join('') : `<div class="pl-empty"><i class="fa-solid fa-music"></i><h3>This playlist is empty</h3><p>Add a track from the suggestions below or from any track menu.</p></div>`}
      </div>
    </section>
    ${renderSuggestions(playlist)}
  `;

  host.querySelector<HTMLElement>('[data-playlist-back]')!.onclick = () => goTab(lastTab === 'tabPlaylist' ? 'tabPlaylists' : lastTab);
  host.querySelector<HTMLElement>('[data-edit-current]')!.onclick = () => openPlaylistModal(playlist.id);
  host.querySelector<HTMLElement>('[data-share-current]')!.onclick = playlistPageShare;
  host.querySelector<HTMLElement>('[data-delete-current]')!.onclick = () => deletePlaylist(playlist.id);
  const playButton = host.querySelector<HTMLButtonElement>('[data-play-playlist]');
  if (playButton) playButton.onclick = () => playPlaylist(playlist.id);
  host.querySelectorAll<HTMLButtonElement>('[data-play-index]').forEach((button) => {
    button.onclick = () => playSong(Number(button.dataset.playIndex));
  });
  host.querySelectorAll<HTMLElement>('[data-remove-key]').forEach((button) => {
    button.onclick = () => removeTrackFromPlaylist(playlist.id, decodeURIComponent(button.dataset.removeKey || ''));
  });
  host.querySelectorAll<HTMLElement>('[data-add-index]').forEach((button) => {
    button.onclick = () => addTrackToPlaylist(playlist.id, Number(button.dataset.addIndex));
  });
  renderSharePanel();
  if (linkSelection) {
    const field = $('playlistShareLink') as HTMLTextAreaElement | null;
    field?.focus({ preventScroll: true });
    field?.setSelectionRange(linkSelection[0], linkSelection[1]);
  }
}

/* Read-only repaint: cloud metadata must never normalize or rewrite storage. */
export function refreshPlaylistViews(): void {
  renderPlaylistsPage();
  if ($('tabPlaylist')?.classList.contains('active')) renderPlaylistPage();
}

function clearSharedPlaylistLink(): void {
  if (!location.hash.startsWith(PLAYLIST_SHARE_PREFIX) && location.hash !== '#playlist') return;
  history.replaceState(history.state, '', location.pathname + location.search);
}

function omittedTracksText(playlist: SharedPlaylist): string {
  const parts: string[] = [];
  if (playlist.omitted.local) parts.push(`${playlist.omitted.local} local file${playlist.omitted.local === 1 ? '' : 's'}`);
  if (playlist.omitted.unavailable) parts.push(`${playlist.omitted.unavailable} unavailable track${playlist.omitted.unavailable === 1 ? '' : 's'}`);
  return parts.length ? `Left out of this link: ${parts.join(' and ')}.` : '';
}

/** Called only after the existing app bootstrap (including local hydration).
    Opening a link is read-only; saving is a separate, explicit action. */
export function openSharedPlaylistPreview(playlist: SharedPlaylist | null, error = ''): void {
  const modalOwnsFocus = activeDialogOwnsFocus();
  sharedPreview = playlist ? { playlist } : { error };
  currentPlaylistId = null;
  renderSharedPlaylistPreview();
  showPlaylistTab('tabPlaylist');
  if (!$('musicApp')?.hidden && !modalOwnsFocus) $('sharedPlaylistHeading')?.focus({ preventScroll: true });
}

function dismissSharedPlaylist(): void {
  clearSharedPlaylistLink();
  sharedPreview = null;
  goTab('tabPlaylists');
}

function matchingSavedPlaylist(playlist: SharedPlaylist, keys: string[]): Playlist | undefined {
  return loadPlaylists().find((saved) => {
    if (saved.title !== playlist.title || saved.description !== playlist.description) return false;
    const savedKeys = playlistTrackEntries(saved).map(({ key, song }) => song ? trackKey(song) : key);
    return savedKeys.length === keys.length && savedKeys.every((key, index) => {
      if (key === keys[index]) return true;
      const resolved = resolveSong(keys[index]);
      return Boolean(resolved && trackMatchesKey(resolved.song, key));
    });
  });
}

function renderSharedPlaylistPreview(): void {
  const host = $('tabPlaylist');
  if (!host || !sharedPreview) return;
  if ('error' in sharedPreview) {
    host.innerHTML = `<div class="pl-empty pl-link-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h2 id="sharedPlaylistHeading" tabindex="-1">This playlist link can’t be opened</h2><p role="alert">${esc(sharedPreview.error)}</p><button class="playlist-btn" type="button" data-dismiss-shared>Back to playlists</button></div>`;
  } else {
    const playlist = sharedPreview.playlist;
    const matches = matchSharedPlaylist(playlist, state.songs);
    const available = matches.filter((match) => match.available).length;
    const existing = matchingSavedPlaylist(playlist, matches.map(({ track }) => track.key));
    host.innerHTML = `
      <button class="pl-back" type="button" data-dismiss-shared><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Back to playlists</button>
      <div class="pl-head">
        <div class="pl-cover pl-shared-cover" aria-hidden="true"><i class="fa-solid fa-bars-staggered"></i></div>
        <div class="pl-head-info">
          <p class="pl-meta">Shared playlist preview</p>
          <h2 class="pl-name" id="sharedPlaylistHeading" tabindex="-1">${esc(playlist.title)}</h2>
          ${playlist.description ? `<p class="pl-desc">${esc(playlist.description)}</p>` : ''}
          <p class="pl-meta">${matches.length} track${matches.length === 1 ? '' : 's'} · ${available} in your library</p>
          <div class="pl-preview-actions"><button class="playlist-btn primary" type="button" data-save-shared>${existing ? 'Open saved playlist' : matches.length ? 'Save playlist' : 'Save empty playlist'}</button><button class="playlist-btn" type="button" data-dismiss-shared>Dismiss</button></div>
          <p class="pl-share-status" id="playlistImportStatus" role="status" aria-live="polite"></p>
        </div>
      </div>
      <p class="pl-availability">Save a copy on this device. Only tracks already in your library can play. Missing tracks keep their places; availability updates with your library. Changes to the sender’s playlist won’t update this copy.</p>
      ${omittedTracksText(playlist) ? `<p class="pl-availability">${esc(omittedTracksText(playlist))} Local audio isn’t transferred.</p>` : ''}
      <section class="pl-content-section" aria-label="Shared tracks">
        <div class="pl-section-head"><h3>Tracks</h3><span>${matches.length}</span></div>
        <div class="pl-track-list">${matches.map(({ track, song, available: canPlay }, index) => `
          <div class="pl-shared-track" data-shared-track>
            <span class="pl-track-number">${index + 1}</span>
            <div class="pl-track-meta"><b>${esc(song?.title || track.title)}</b><span>${esc(song?.artist || track.artist || 'Unknown artist')}</span></div>
            <span class="pl-track-availability">${canPlay ? 'In your library' : song?.isLocal ? 'Local file missing' : 'Not in your library'}</span>
          </div>`).join('') || '<div class="pl-empty"><h3>No tracks included</h3><p>This link contains the playlist name and description only.</p></div>'}</div>
      </section>`;
    host.querySelector<HTMLButtonElement>('[data-save-shared]')!.onclick = importSharedPlaylist;
  }
  host.querySelectorAll<HTMLButtonElement>('[data-dismiss-shared]').forEach((button) => { button.onclick = dismissSharedPlaylist; });
}

function importSharedPlaylist(): void {
  if (!sharedPreview || !('playlist' in sharedPreview)) return;
  const snapshot = sharedPreview.playlist;
  const matches = matchSharedPlaylist(snapshot, state.songs);
  const keys = matches.map(({ track }) => track.key);
  const existing = matchingSavedPlaylist(snapshot, keys);
  if (existing) {
    openPlaylistPage(existing.id);
    toast('This playlist is already saved on this device.', 'circle-info');
    return;
  }
  const playlist: Playlist = {
    id: `pl_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
    title: snapshot.title, description: snapshot.description, privacy: 'Private',
    year: new Date().getFullYear(), createdAt: Date.now(), tracks: keys,
    shared: { ...snapshot, tracks: matches.map(({ track }) => track) },
  };
  if (!savePlaylists([playlist, ...loadPlaylists()])) {
    const status = $('playlistImportStatus');
    if (status) { status.textContent = 'Could not save on this device. Check browser storage and try again.'; status.dataset.tone = 'error'; }
    return;
  }
  renderSidebarPlaylists();
  openPlaylistPage(playlist.id);
  const missing = matches.filter((match) => !match.available).length;
  toast(`Playlist saved on this device.${missing ? ` ${missing} track${missing === 1 ? ' is' : 's are'} not in your library yet.` : ''}`, 'circle-check');
}

function playlistHasSong(playlist: Playlist, song: any): boolean {
  return playlist.tracks.some((key) => trackMatchesKey(song, key));
}

function renderSuggestions(playlist: Playlist): string {
  const suggestions = state.songs
    .map((song: any, index: number) => ({ song, index }))
    .filter(({ song }) => !playlistHasSong(playlist, song))
    .slice(0, 10);
  if (!suggestions.length) return '';
  return `<section class="pl-content-section pl-suggestions">
    <div class="pl-section-head"><h3>Suggestions</h3><span>From your library</span></div>
    <div class="pl-track-list">${suggestions.map(({ song, index }) => `
      <div class="pl-track pl-suggestion">
        <img src="${esc(song.img || '')}" alt="" loading="lazy" decoding="async">
        <div class="pl-track-meta"><b>${esc(song.title)}</b><span>${esc(song.artist)}</span></div>
        <button class="pl-add-btn" type="button" data-add-index="${index}" aria-label="Add ${esc(song.title)}"><i class="fa-solid fa-plus"></i><span>Add</span></button>
      </div>`).join('')}</div>
  </section>`;
}

export function playPlaylist(id: string): void {
  const playlist = loadPlaylists().find((item) => item.id === id);
  const entries = playlist ? playlistSongs(playlist) : [];
  if (!entries.length) return toast('Add a track before playing this playlist.', 'circle-info');
  const ids = entries.map(({ song }) => song.id);
  const playSequence = (globalThis as any).playTrackSequence;
  if (typeof playSequence === 'function') playSequence(ids);
  else playSong(entries[0].index);
}

export function addTrackToPlaylist(playlistId: string, index: number): void {
  const playlists = loadPlaylists();
  const playlist = playlists.find((item) => item.id === playlistId);
  const song = state.songs[index];
  if (!playlist || !song) return;
  const key = trackKey(song);
  if (playlistHasSong(playlist, song)) return toast('Already in this playlist.', 'circle-info');
  playlist.tracks.push(key);
  if (!savePlaylists(playlists)) return;
  renderSidebarPlaylists();
  if (currentPlaylistId === playlistId) renderPlaylistPage();
  toast(`Added to “${playlist.title}”`, 'circle-check');
}

export function removeTrackFromPlaylist(playlistId: string, key: string): void {
  const playlists = loadPlaylists();
  const playlist = playlists.find((item) => item.id === playlistId);
  if (!playlist) return;
  const removeButtons = [...($('tabPlaylist')?.querySelectorAll<HTMLButtonElement>('[data-remove-key]') || [])];
  const focusIndex = removeButtons.indexOf(document.activeElement as HTMLButtonElement);
  const removedSong = resolveSong(key)?.song;
  const keep = (track: string) => track !== key && !(removedSong && trackMatchesKey(removedSong, track));
  playlist.tracks = playlist.tracks.filter(keep);
  if (playlist.shared) playlist.shared.tracks = playlist.shared.tracks.filter((track) => keep(track.key));
  if (!savePlaylists(playlists)) return;
  renderSidebarPlaylists();
  if (currentPlaylistId === playlistId) renderPlaylistPage();
  if (focusIndex >= 0) {
    const buttons = [...($('tabPlaylist')?.querySelectorAll<HTMLButtonElement>('[data-remove-key]') || [])];
    const next = buttons[Math.min(focusIndex, buttons.length - 1)] || $('tabPlaylist')?.querySelector<HTMLButtonElement>('[data-edit-current]');
    next?.focus({ preventScroll: true });
  }
  toast('Removed from playlist.', 'circle-check');
}

export function deletePlaylist(id: string): void {
  const playlists = loadPlaylists();
  const playlist = playlists.find((item) => item.id === id);
  if (!playlist || !window.confirm(`Delete “${playlist.title}”? This does not remove any music from Aura.`)) return;
  if (!savePlaylists(playlists.filter((item) => item.id !== id))) return;
  if (currentPlaylistId === id) currentPlaylistId = null;
  renderSidebarPlaylists();
  goTab('tabPlaylists');
  toast('Playlist deleted.', 'circle-check');
}

function ensurePlaylistPicker(): HTMLElement {
  let overlay = $('playlistPicker');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'playlistPicker';
  overlay.className = 'playlist-picker';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'playlistPickerTitle');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `<div class="playlist-picker-card"><div class="playlist-picker-head"><div><h3 id="playlistPickerTitle">Add to playlist</h3><p>Choose where this track belongs.</p></div><button type="button" data-close-picker aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="playlist-picker-list" data-picker-list></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLElement>('[data-close-picker]')!.onclick = () => closePlaylistPicker();
  overlay.onclick = (event) => { if (event.target === overlay) closePlaylistPicker(); };
  return overlay;
}

export function openPlaylistPicker(songId: string | number): void {
  const song = state.songs.find((item: any) => String(item.id) === String(songId));
  if (!song) return;
  pendingTrackKey = trackKey(song);
  $('trackSheetOverlay')?.classList.remove('active');
  const overlay = ensurePlaylistPicker();
  const list = overlay.querySelector<HTMLElement>('[data-picker-list]')!;
  const playlists = loadPlaylists();
  list.innerHTML = `${playlists.map((playlist) => {
    const alreadyAdded = playlistHasSong(playlist, song);
    return `<button type="button" class="playlist-picker-option" data-picker-id="${esc(playlist.id)}" ${alreadyAdded ? 'disabled' : ''}>${coversMarkup(playlist, 'playlist-picker-cover')}<span><b>${esc(playlist.title)}</b><small>${alreadyAdded ? 'Already added' : `${playlist.tracks.length} track${playlist.tracks.length === 1 ? '' : 's'}`}</small></span><i class="fa-solid ${alreadyAdded ? 'fa-check' : 'fa-plus'}"></i></button>`;
  }).join('')}<button type="button" class="playlist-picker-new" data-picker-new><i class="fa-solid fa-plus"></i><span>Create a new playlist</span></button>`;
  list.querySelectorAll<HTMLElement>('[data-picker-id]').forEach((button) => {
    button.onclick = () => addPendingTrack(button.dataset.pickerId || '');
  });
  list.querySelector<HTMLElement>('[data-picker-new]')!.onclick = () => {
    closePlaylistPicker(false);
    openPlaylistModal();
  };
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function addPendingTrack(playlistId: string): void {
  if (!pendingTrackKey) return;
  const playlists = loadPlaylists();
  const playlist = playlists.find((item) => item.id === playlistId);
  const pending = resolveSong(pendingTrackKey);
  if (!playlist || !pending || playlistHasSong(playlist, pending.song)) return;
  playlist.tracks.push(pendingTrackKey);
  if (!savePlaylists(playlists)) return;
  const title = playlist.title;
  closePlaylistPicker();
  renderSidebarPlaylists();
  toast(`Added to “${title}”`, 'circle-check');
}

export function closePlaylistPicker(clearPending = true): void {
  const overlay = $('playlistPicker');
  if (overlay?.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
  overlay?.classList.remove('active');
  overlay?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  if (clearPending) pendingTrackKey = null;
}

function renderSharePanel(): void {
  const slot = $('tabPlaylist')?.querySelector<HTMLElement>('[data-playlist-share-slot]');
  const panel = sharePanel;
  if (!slot || !panel || panel.playlistId !== currentPlaylistId) return;
  slot.innerHTML = `<section class="pl-share-panel" aria-labelledby="playlistShareHeading">
    <div class="playlist-picker-head"><h3 id="playlistShareHeading">Share playlist</h3><button type="button" data-close-share aria-label="Close sharing"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
    <p>${panel.playlist.tracks.length} track${panel.playlist.tracks.length === 1 ? '' : 's'} in this link. Anyone with it can preview and save a copy. Edits won’t update this snapshot.</p>
    ${omittedTracksText(panel.playlist) ? `<p>${esc(omittedTracksText(panel.playlist))} Local audio isn’t transferred.</p>` : ''}
    <label class="playlist-field" for="playlistShareLink"><span>Playlist link</span><textarea id="playlistShareLink" rows="2" readonly spellcheck="false">${esc(panel.url)}</textarea></label>
    <div class="pl-preview-actions"><button class="playlist-btn" type="button" data-copy-share><i class="fa-solid fa-copy" aria-hidden="true"></i>Copy link</button>${typeof navigator.share === 'function' ? '<button class="playlist-btn" type="button" data-system-share><i class="fa-solid fa-share" aria-hidden="true"></i>Share via…</button>' : ''}</div>
    <p class="pl-share-status" id="playlistShareStatus" role="status" aria-live="polite"></p>
  </section>`;
  slot.querySelector<HTMLButtonElement>('[data-copy-share]')!.onclick = () => { if (!panel.busy) void copyShareLink(panel); };
  const systemShare = slot.querySelector<HTMLButtonElement>('[data-system-share]');
  if (systemShare) systemShare.onclick = () => { if (!panel.busy) void shareViaDevice(panel); };
  slot.querySelector<HTMLButtonElement>('[data-close-share]')!.onclick = () => {
    sharePanel = null;
    slot.replaceChildren();
    const button = $('tabPlaylist')?.querySelector<HTMLButtonElement>('[data-share-current]');
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.setAttribute('aria-expanded', 'false'); button.focus({ preventScroll: true }); }
  };
  updateShareStatus(panel, panel.status, panel.tone, panel.busy);
}

function updateShareStatus(panel: SharePanel, status: string, tone: SharePanel['tone'], busy = false): void {
  Object.assign(panel, { status, tone, busy });
  if (panel !== sharePanel || panel.playlistId !== currentPlaylistId) return;
  const message = $('playlistShareStatus');
  if (message) { message.textContent = status; message.dataset.tone = tone; }
  $('tabPlaylist')?.querySelectorAll<HTMLButtonElement>('[data-copy-share], [data-system-share], [data-share-current]').forEach((button) => {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  });
  $('tabPlaylist')?.querySelector('[data-share-current]')?.setAttribute('aria-expanded', 'true');
}

async function tryCopyShareLink(panel: SharePanel): Promise<boolean> {
  if (panel !== sharePanel || panel.playlistId !== currentPlaylistId) return false;
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(panel.url);
      return true;
    }
  } catch { /* Denied/insecure clipboard: try selection-based copying below. */ }
  if (panel !== sharePanel || panel.playlistId !== currentPlaylistId) return false;
  const field = $('playlistShareLink') as HTMLTextAreaElement | null;
  if (!field) return false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    return document.execCommand('copy');
  } catch { return false; }
}

async function copyShareLink(panel: SharePanel, shareFailed = false): Promise<void> {
  updateShareStatus(panel, 'Copying playlist link…', 'neutral', true);
  const copied = await tryCopyShareLink(panel);
  updateShareStatus(panel, copied
    ? shareFailed ? 'Sharing didn’t open. Playlist link copied instead.' : 'Playlist link copied. Send it to open this playlist on another device.'
    : `${shareFailed ? 'Sharing didn’t open. ' : ''}Could not copy automatically. Select and copy the link above.`, copied ? 'success' : 'error');
  if (panel === sharePanel && panel.playlistId === currentPlaylistId) {
    toast(copied ? 'Playlist link copied.' : 'Could not copy. Select and copy the playlist link.', copied ? 'circle-check' : 'triangle-exclamation');
  }
}

async function shareViaDevice(panel: SharePanel): Promise<void> {
  updateShareStatus(panel, 'Opening sharing…', 'neutral', true);
  const data = { title: panel.playlist.title, text: 'Open this playlist in Aura Music.', url: panel.url };
  try {
    if (typeof navigator.share !== 'function' || (navigator.canShare && !navigator.canShare(data))) {
      await copyShareLink(panel, true);
      return;
    }
    await navigator.share(data);
    updateShareStatus(panel, 'Playlist link shared.', 'success');
    if (panel === sharePanel && panel.playlistId === currentPlaylistId) toast('Playlist link shared.', 'circle-check');
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      updateShareStatus(panel, 'Sharing canceled. You can still copy the link.', 'neutral');
      if (panel === sharePanel && panel.playlistId === currentPlaylistId) toast('Sharing canceled.', 'circle-info');
    } else await copyShareLink(panel, true);
  }
}

export async function playlistPageShare(): Promise<void> {
  if (sharePanel?.busy) return;
  const playlist = loadPlaylists().find((item) => item.id === currentPlaylistId);
  if (!playlist) return;
  try {
    const snapshot = createPlaylistShare(playlist, state.songs);
    sharePanel = { playlistId: playlist.id, playlist: snapshot, url: playlistShareUrl(snapshot, location.href), status: 'Playlist link ready.', tone: 'neutral', busy: false };
    renderSharePanel();
    $('playlistSharePanel')?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  } catch (error) {
    sharePanel = null;
    const message = error instanceof PlaylistShareError ? error.message : 'Could not create a playlist link. Try again.';
    const slot = $('tabPlaylist')?.querySelector<HTMLElement>('[data-playlist-share-slot]');
    if (slot) slot.innerHTML = `<p class="pl-share-status" data-tone="error" role="alert">${esc(message)}</p>`;
    toast(message, 'triangle-exclamation');
    return;
  }
  if (typeof navigator.share === 'function') await shareViaDevice(sharePanel);
  else await copyShareLink(sharePanel);
}

export function playlistPageMore(): void {
  void playlistPageShare();
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('playlistPicker')?.classList.contains('active')) closePlaylistPicker();
  else if ($('playlistModal')?.classList.contains('active')) closePlaylistModal();
});

$('playlistModal')?.addEventListener('click', (event) => {
  if (event.target === $('playlistModal')) closePlaylistModal();
});

window.addEventListener('storage', (event) => {
  if (event.key === PLAYLISTS_KEY) renderSidebarPlaylists();
});

renderSidebarPlaylists();
