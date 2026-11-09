import { state, $, trackKey } from '../core/state';
import { toast, getSavedUserName } from '../core/dom';
import { goTab, showPlaylistTab } from '../ui/nav';
import { playSong } from './player';
import { goToSearchCategory } from './search';

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
};

let currentPlaylistId: string | null = null;
let editingPlaylistId: string | null = null;
let pendingTrackKey: string | null = null;
let lastTab = 'tabPlaylists';

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
  return {
    id: String(raw.id),
    title: title.slice(0, 60),
    description: String(raw.description || '').trim().slice(0, 140),
    privacy,
    year: raw.year || new Date(Number(raw.createdAt) || Date.now()).getFullYear(),
    createdAt: Number(raw.createdAt) || Date.now(),
    tracks: Array.from(new Set(Array.isArray(raw.tracks) ? raw.tracks.map(String) : [])),
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
  const index = state.songs.findIndex((song: any) => trackKey(song) === key);
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

function playlistSongs(playlist: Playlist): Array<{ key: string; song: any; index: number }> {
  return playlist.tracks
    .map((key) => {
      const resolved = resolveSong(key);
      return resolved ? { key, ...resolved } : null;
    })
    .filter((entry): entry is { key: string; song: any; index: number } => Boolean(entry));
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
      <button class="playlist-create-btn" type="button" data-create-playlist>
        <i class="fa-solid fa-plus"></i><span>New playlist</span>
      </button>
    </div>
    ${playlists.length ? `
      <div class="playlists-grid">
        ${playlists.map((playlist) => {
          const available = playlistSongs(playlist).length;
          return `<article class="playlist-card" role="button" tabindex="0" data-playlist-id="${esc(playlist.id)}" aria-label="Open ${esc(playlist.title)}">
            ${coversMarkup(playlist, 'playlist-card-cover')}
            <div class="playlist-card-copy">
              <h3>${esc(playlist.title)}</h3>
              <p>${available} track${available === 1 ? '' : 's'} · On this device</p>
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
  host.querySelectorAll<HTMLElement>('[data-playlist-id]').forEach((card) => {
    const open = () => openPlaylistPage(card.dataset.playlistId || '');
    card.onclick = (event) => {
      if ((event.target as HTMLElement).closest('[data-edit-playlist]')) return;
      open();
    };
    card.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    };
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
  window.setTimeout(() => titleInput.focus(), 70);
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
  currentPlaylistId = id;
  renderPlaylistPage();
  showPlaylistTab('tabPlaylist');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPlaylistPage(): void {
  const playlist = loadPlaylists().find((item) => item.id === currentPlaylistId);
  const host = $('tabPlaylist');
  if (!playlist || !host) return;
  const entries = playlistSongs(playlist);
  const totalSeconds = entries.reduce((sum, { song }) => sum + secondsOf(song), 0);

  host.innerHTML = `
    <button class="pl-back" type="button" data-playlist-back><i class="fa-solid fa-arrow-left"></i>Back to playlists</button>
    <div class="pl-head">
      ${coversMarkup(playlist, 'pl-cover pl-cover-mosaic')}
      <div class="pl-head-info">
        <p class="pl-kicker">Playlist</p>
        <h2 class="pl-name">${esc(playlist.title)}</h2>
        <div class="pl-owner">${ownerAvatarMarkup()}<span>${esc(ownerName())}</span></div>
        <p class="pl-meta">On this device · ${esc(String(playlist.year))} · ${entries.length} track${entries.length === 1 ? '' : 's'} · ${durationLabel(totalSeconds)}</p>
        ${playlist.description ? `<p class="pl-desc">${esc(playlist.description)}</p>` : ''}
        <div class="pl-actions">
          <button type="button" data-play-playlist ${entries.length ? '' : 'disabled'}><i class="fa-solid fa-play"></i><span>Play</span></button>
          <button type="button" data-edit-current><i class="fa-solid fa-pen"></i><span>Edit</span></button>
          <button type="button" data-share-current><i class="fa-solid fa-share"></i><span>Share</span></button>
          <button type="button" class="danger" data-delete-current><i class="fa-solid fa-trash"></i><span>Delete</span></button>
        </div>
      </div>
    </div>
    <section class="pl-content-section">
      <div class="pl-section-head"><h3>Tracks</h3><span>${entries.length}</span></div>
      <div class="pl-track-list">
        ${entries.length ? entries.map(({ key, song, index }, position) => `
          <div class="pl-track" data-play-index="${index}">
            <span class="pl-track-number">${position + 1}</span>
            <img src="${esc(song.img || '')}" alt="" loading="lazy" decoding="async">
            <div class="pl-track-meta"><b>${esc(song.title)}</b><span>${esc(song.artist)}</span></div>
            <button class="pl-track-remove" type="button" data-remove-key="${encodeURIComponent(key)}" aria-label="Remove ${esc(song.title)} from playlist"><i class="fa-solid fa-xmark"></i></button>
          </div>`).join('') : `<div class="pl-empty"><i class="fa-solid fa-music"></i><h3>This playlist is empty</h3><p>Add a track from the suggestions below or from any track menu.</p></div>`}
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
  host.querySelectorAll<HTMLElement>('[data-play-index]').forEach((row) => {
    row.onclick = (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      playSong(Number(row.dataset.playIndex));
    };
  });
  host.querySelectorAll<HTMLElement>('[data-remove-key]').forEach((button) => {
    button.onclick = () => removeTrackFromPlaylist(playlist.id, decodeURIComponent(button.dataset.removeKey || ''));
  });
  host.querySelectorAll<HTMLElement>('[data-add-index]').forEach((button) => {
    button.onclick = () => addTrackToPlaylist(playlist.id, Number(button.dataset.addIndex));
  });
}

function renderSuggestions(playlist: Playlist): string {
  const suggestions = state.songs
    .map((song: any, index: number) => ({ song, index }))
    .filter(({ song }) => !playlist.tracks.includes(trackKey(song)))
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
  if (playlist.tracks.includes(key)) return toast('Already in this playlist.', 'circle-info');
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
  playlist.tracks = playlist.tracks.filter((track) => track !== key);
  if (!savePlaylists(playlists)) return;
  renderSidebarPlaylists();
  if (currentPlaylistId === playlistId) renderPlaylistPage();
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
    const alreadyAdded = playlist.tracks.includes(pendingTrackKey!);
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
  if (!playlist || playlist.tracks.includes(pendingTrackKey)) return;
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

export function playlistPageShare(): void {
  const playlist = loadPlaylists().find((item) => item.id === currentPlaylistId);
  if (!playlist) return;
  const text = `${playlist.title} — Aura Music\n${playlist.description ? `${playlist.description}\n` : ''}${playlist.tracks.length} tracks`;
  if (navigator.share) navigator.share({ title: playlist.title, text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Playlist details copied.', 'circle-check'));
}

export function playlistPageMore(): void {
  playlistPageShare();
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
