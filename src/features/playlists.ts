import { state, $, trackKey } from '../core/state';
import { toast, getSavedUserName } from '../core/dom';
import { goTab, showPlaylistTab } from '../ui/nav';
import { playSong } from './player';
import { goToSearchCategory } from './search';

/* ============================================================
   Playlists — persisted in localStorage under 'auraPlaylists'.
   Each playlist: { id, title, description, privacy, year, createdAt, tracks[] }
   `tracks` stores trackKey() strings (stable across sources/refreshes).
   The sidebar list and the mobile drawer list read the same data.
   ============================================================ */

const PLAYLISTS_KEY = 'auraPlaylists';

type Pl = {
  id: string; title: string; description: string;
  privacy: 'Public' | 'Private' | 'Unlisted';
  year: number | string; createdAt: number; tracks: string[];
};

function loadPlaylists(): Pl[] {
  try { return JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || '[]'); }
  catch (e) { return []; }
}
function savePlaylists(list: Pl[]) {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
}
function getPlaylists(): Pl[] { return loadPlaylists(); }

let currentPlaylistId: string | null = null;
let editingPlaylistId: string | null = null;
let lastTab = 'tabHome';

/* ---------- helpers ---------- */

function esc(s: any) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function secondsOf(s: any): number {
  if (typeof s?.duration === 'number' && isFinite(s.duration) && s.duration > 0) return Math.round(s.duration);
  if (typeof s?.duration === 'string' && s.duration.includes(':')) {
    const p = s.duration.split(':').map((x: string) => parseInt(x, 10) || 0);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
  }
  return 0;
}

function durationLabel(totalSec: number): string {
  if (totalSec <= 0) return '0 seconds';
  if (totalSec < 60) return `${totalSec} second${totalSec !== 1 ? 's' : ''}`;
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return s ? `${m} min ${s} sec` : `${m} min`;
}

function resolveSong(key: string): number | null {
  const i = state.songs.findIndex((s: any) => trackKey(s) === key);
  return i === -1 ? null : i;
}

function ownerName(): string {
  const n = (getSavedUserName?.() || '').trim();
  if (n) return n;
  return ($('displayUserName')?.textContent || '').trim() || 'User';
}

function ownerAvatarHTML(cls: string): string {
  const photo = $('profilePhoto');
  if (photo instanceof HTMLImageElement && photo.src && !photo.hidden) {
    return `<img class="${cls}" src="${photo.src}" alt="">`;
  }
  return `<span class="${cls}">${esc((ownerName() || 'U').slice(0, 1).toUpperCase())}</span>`;
}

/* ---------- sidebar + drawer lists (same data, both stay in sync) ---------- */

export function renderSidebarPlaylists() {
  const pls = getPlaylists();
  const render = (containerId: string, drawer: boolean) => {
    const c = $(containerId);
    if (!c) return;
    /* drawer taps also close the drawer; sidebar taps don't need to */
    const tap = (kind: string, plId: string) => drawer
      ? `drawerPlaylistTap('${kind}','${plId}')`
      : (kind === 'favorites' || kind === 'recent' ? `goToSearchCategory('${kind}')` : `openPlaylistPage('${plId}')`);
    c.innerHTML = `
      <button class="pl-link" type="button" onclick="${tap('favorites','')}"><i class="fa-solid fa-heart"></i><span>Liked Music</span></button>
      <button class="pl-link" type="button" onclick="${tap('recent','')}"><i class="fa-solid fa-clock-rotate-left"></i><span>Recently Played</span></button>
      ${pls.map(p => `
        <button class="pl-link" type="button" onclick="${tap('playlist', p.id)}">
          <i class="fa-solid fa-bars-staggered"></i><span>${esc(p.title)}</span>
          <small class="pl-count">${p.tracks.length}</small>
        </button>`).join('')}
      <button class="pl-link pl-new" type="button" onclick="${tap('new','')}"><i class="fa-solid fa-plus"></i><span>New playlist</span></button>
    `;
  };
  render('sidebarPlaylists', false);
  render('drawerPlaylists', true);
}

/* unified drawer playlist tap: closes the drawer, then opens the target */
export function drawerPlaylistTap(kind: string, plId: string) {
  const sm = $('sideMenu');
  if (sm) sm.style.display = 'none';
  if (kind === 'favorites' || kind === 'recent') return goToSearchCategory(kind);
  if (kind === 'playlist') return openPlaylistPage(plId);
  openPlaylistModal();
}

/* ---------- New playlist / Edit popup ---------- */

export function openPlaylistModal(id?: string) {
  editingPlaylistId = id || null;
  const pl = id ? getPlaylists().find(p => p.id === id) : null;
  const modal = $('playlistModal');
  if (!modal) return;
  $('playlistModalTitle').textContent = pl ? 'Edit playlist' : 'New playlist';
  ($('playlistSubmitBtn') as HTMLButtonElement).textContent = pl ? 'Save changes' : 'Create';
  ($('playlistTitleInput') as HTMLInputElement).value = pl?.title || '';
  ($('playlistDescInput') as HTMLInputElement).value = pl?.description || '';
  ($('playlistPrivacySelect') as HTMLSelectElement).value = pl?.privacy || 'Public';
  $('playlistCreateError').hidden = true;
  updatePlaylistCta();
  modal.classList.add('active');
  setTimeout(() => ($('playlistTitleInput') as HTMLInputElement)?.focus(), 60);
}

export function closePlaylistModal() {
  $('playlistModal')?.classList.remove('active');
  editingPlaylistId = null;
}

export function updatePlaylistCta() {
  const title = ($('playlistTitleInput') as HTMLInputElement)?.value.trim();
  const btn = $('playlistSubmitBtn') as HTMLButtonElement;
  if (btn) btn.disabled = !title;
}

export function submitPlaylistModal() {
  const titleInput = $('playlistTitleInput') as HTMLInputElement;
  const title = titleInput.value.trim();
  if (!title) {
    $('playlistCreateError').hidden = false;
    titleInput.focus();
    return;
  }
  const description = ($('playlistDescInput') as HTMLInputElement).value.trim();
  const privacy = ($('playlistPrivacySelect') as HTMLSelectElement).value as Pl['privacy'];
  const wasEditing = !!editingPlaylistId;
  const pls = getPlaylists();

  let pageId: string;
  if (wasEditing) {
    const pl = pls.find(p => p.id === editingPlaylistId);
    if (!pl) return closePlaylistModal();
    pl.title = title; pl.description = description; pl.privacy = privacy;
    pageId = pl.id;
  } else {
    const pl: Pl = {
      id: `pl_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
      title, description, privacy,
      year: new Date().getFullYear(),
      createdAt: Date.now(),
      tracks: [],
    };
    pls.unshift(pl);
    pageId = pl.id;
  }
  savePlaylists(pls);
  renderSidebarPlaylists();
  closePlaylistModal();
  toast(wasEditing ? 'Playlist updated' : `Playlist "${title}" created`, 'circle-check');
  if (wasEditing && currentPlaylistId === pageId) renderPlaylistPage();
  else openPlaylistPage(pageId);
}

/* ---------- playlist page ---------- */

export function openPlaylistPage(id: string) {
  const pl = getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const active = document.querySelector('.tab-content.active');
  if (active && active.id !== 'tabPlaylist') lastTab = active.id;
  currentPlaylistId = id;
  renderPlaylistPage();
  showPlaylistTab('tabPlaylist');
  window.scrollTo({ top: 0 });
}

function renderPlaylistPage() {
  const pl = getPlaylists().find(p => p.id === currentPlaylistId);
  const host = $('tabPlaylist');
  if (!pl || !host) return;

  const indices = pl.tracks.map(resolveSong).filter((i): i is number => i !== null);
  const totalSec = indices.reduce((acc, i) => acc + secondsOf(state.songs[i]), 0);
  const listHTML = indices.length ? indices.map(i => {
    const s = state.songs[i];
    return `
      <div class="pl-track" onclick="playSong(${i})">
        <img src="${s.img || ''}" alt="">
        <div class="pl-track-meta">
          <b>${esc(s.title)}</b>
          <span>${esc(s.artist)}${s.duration ? ` • ${durationLabel(secondsOf(s))}` : ''}</span>
        </div>
        <i class="fa-solid fa-play pl-track-play"></i>
      </div>`;
  }).join('') : `<p class="pl-empty">No tracks in this playlist yet</p>`;

  /* Suggestions: library songs not in this playlist yet */
  const suggestions = state.songs
    .map((s: any, index: number) => ({ s, index }))
    .filter(x => !pl.tracks.includes(trackKey(x.s)))
    .slice(0, 12);

  const suggestionsHTML = suggestions.length ? suggestions.map(x => `
    <div class="pl-track pl-suggestion">
      <img src="${x.s.img || ''}" alt="">
      <div class="pl-track-meta"><b>${esc(x.s.title)}</b><span>${esc(x.s.artist)}</span></div>
      <button class="pl-add-btn" type="button" title="Add to playlist" aria-label="Add to playlist" onclick="event.stopPropagation();addTrackToPlaylist('${pl.id}',${x.index})"><i class="fa-solid fa-plus"></i></button>
    </div>`).join('') : '';

  host.innerHTML = `
    <button class="pl-back" type="button" aria-label="Back"><i class="fa-solid fa-arrow-left"></i> Back</button>
    <div class="pl-head">
      <div class="pl-cover"><i class="fa-solid fa-bars-staggered"></i></div>
      <div class="pl-head-info">
        <p class="pl-kicker">Playlist</p>
        <h2 class="pl-name">${esc(pl.title)}</h2>
        <div class="pl-owner">${ownerAvatarHTML('pl-owner-avatar')}&nbsp;<span>${esc(ownerName())}</span></div>
        <p class="pl-meta">Playlist • ${esc(pl.privacy)} • ${esc(String(pl.year))}<br>
        <b id="plCountLine">${indices.length} track${indices.length !== 1 ? 's' : ''} • ${durationLabel(totalSec)}</b></p>
        ${pl.description ? `<p class="pl-desc">${esc(pl.description)}</p>` : ''}
        <div class="pl-actions">
          <button type="button" onclick="openPlaylistModal('${pl.id}')"><i class="fa-solid fa-pen"></i><span>Edit</span></button>
          <button type="button" onclick="playlistPageShare()"><i class="fa-solid fa-share"></i><span>Share</span></button>
          <button type="button" onclick="playlistPageMore()"><i class="fa-solid fa-ellipsis"></i><span>More</span></button>
        </div>
      </div>
    </div>
    <div class="pl-track-list">${listHTML}</div>
    ${suggestionsHTML ? `
    <div class="pl-suggestions">
      <p class="pl-section">Suggestions</p>
      <div class="pl-track-list pl-suggest-list">${suggestionsHTML}</div>
    </div>` : ''}
  `;

  host.querySelector('.pl-back')?.addEventListener('click', () => goTab(lastTab));
}

/* add a song (library index) to a playlist instantly */
export function addTrackToPlaylist(plId: string, index: number) {
  const pls = getPlaylists();
  const pl = pls.find(p => p.id === plId);
  const song = state.songs[index];
  if (!pl || !song) return;
  const key = trackKey(song);
  if (pl.tracks.includes(key)) {
    toast('Already in this playlist', 'circle-info');
    return;
  }
  pl.tracks.push(key);
  savePlaylists(pls);
  renderSidebarPlaylists();
  if (currentPlaylistId === plId) renderPlaylistPage();
  toast(`Added to "${pl.title}"`, 'circle-check');
}

/* ---------- Share / More ---------- */

export function playlistPageShare() {
  const pl = getPlaylists().find(p => p.id === currentPlaylistId);
  if (!pl) return;
  const text = `${pl.title} — playlist on Aura Music${pl.description ? `\n${pl.description}` : ''}\n${pl.tracks.length} tracks`;
  if (navigator.share) {
    navigator.share({ title: pl.title, text }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(text).then(() => toast('Playlist details copied', 'circle-check'));
  }
}

export function playlistPageMore() {
  const pl = getPlaylists().find(p => p.id === currentPlaylistId);
  if (!pl) return;
  const indices = pl.tracks.map(resolveSong).filter((i): i is number => i !== null);
  const lines = indices.map(i => `• ${state.songs[i].title} — ${state.songs[i].artist}`).join('\n');
  navigator.clipboard?.writeText(`${pl.title}\n\n${lines || 'No tracks yet'}`).then(() => toast('Song list copied to clipboard', 'circle-check'));
}

/* ---------- popup shell events (Esc + backdrop) ---------- */

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('playlistModal')?.classList.contains('active')) closePlaylistModal();
});

$('playlistModal')?.addEventListener('click', e => {
  if (e.target === $('playlistModal')) closePlaylistModal();
});

renderSidebarPlaylists();
