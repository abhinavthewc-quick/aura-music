<<<<<<< HEAD
import type { ArtistGroup } from '../core/artistGroups';
import { DEFAULT_COVER } from '../core/catalog';
import { DEFAULT_ARTIST_PORTRAIT, setArtistPortraitSource } from '../core/artistMetadata';
import { artistProfileDetailsHTML, updateArtistProfileDetails } from '../core/artistPresentation';
import { escapeHtml } from '../core/dom';
import { isPlaylistTrackAvailable } from '../core/playlist-sharing';
import { state } from '../core/state';
import { isMainPlaybackPlaying, togglePlay } from './player';
import { getArtistPlayback, playTrackSequence } from './queue';
=======
import { DEFAULT_COVER } from '../core/catalog';
import { getArtistBiography, type ArtistBiography } from '../core/artist-biography';
import { escapeHtml } from '../core/dom';
import { state } from '../core/state';
import { stableTrackRef, trackAvailable } from '../core/track-identity';
import { togglePlay } from './player';
import { playTrackSequence } from './queue';

export interface ArtistPageEntry {
  key: string;
  name: string;
  img: string;
  bio?: string;
  songs: any[];
}
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))

interface ArtistPageOptions {
  prefix: string;
  onBack: () => void;
<<<<<<< HEAD
  onFavorite?: (event: Event, id: string) => void;
}
interface MountedPage {
  artist: ArtistGroup;
  options: ArtistPageOptions;
  tracks: { song: any; id: any; title: any; artist: any; img: any; url: any; missing: any }[];
}
const mountedPages = new WeakMap<HTMLElement, MountedPage>();
=======
  trackActions?: boolean;
}
interface MountedPage { artist: ArtistPageEntry; options: ArtistPageOptions }
const mountedPages = new WeakMap<HTMLElement, MountedPage>();

>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/></svg>';
const playingIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const shuffleIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h3c5 0 7 12 13 12h2M3 18h3c2 0 3.5-2 5-4M14 8c1.5-1.3 3-2 5-2h2M18 3l3 3-3 3M18 15l3 3-3 3"/></svg>';

<<<<<<< HEAD
export function playArtistCollection(artist: ArtistGroup, shuffle = false, startId?: string): boolean {
  // Use the same public playback boundary as production playlist controls.
  const play = (globalThis as any).playTrackSequence || playTrackSequence;
  return play(artist.songs.filter(isPlaylistTrackAvailable).map(song => song.id), {
    source: 'artist', collectionId: artist.key, label: artist.name, startId, shuffle,
  });
}
function songRows(artist: ArtistGroup, trackActions: boolean): string {
  return artist.songs.map((song, index) => {
    const title = escapeHtml(song.title || 'Untitled'), name = escapeHtml(song.artist || artist.name), id = escapeHtml(song.id);
    return `<li class="artist-song-item" data-artist-song-id="${id}">
      <button type="button" class="artist-song-row" data-artist-track-id="${id}" data-track-number="${index + 1}" data-track-label="${title} by ${name}" aria-label="Play ${title} by ${name}" ${isPlaylistTrackAvailable(song) ? '' : 'disabled'}>
=======
export function playArtistCollection(artist: ArtistPageEntry, shuffle = false, startId?: string): boolean {
  const songs = artist.songs.filter(trackAvailable);
  if (!songs.length) return playTrackSequence([], { source: 'artist' });
  const first = shuffle ? songs[Math.floor(Math.random() * songs.length)] : songs[0];
  return playTrackSequence(songs.map((song) => song.id), {
    source: 'artist', collectionId: artist.key, label: artist.name,
    startId: startId ?? first.id, shuffle,
  });
}

function songRows(artist: ArtistPageEntry, trackActions: boolean): string {
  return artist.songs.map((song, index) => {
    const title = escapeHtml(song.title || 'Untitled');
    const name = escapeHtml(song.artist || artist.name);
    const id = escapeHtml(song.id);
    return `<li class="artist-song-item">
      <button type="button" class="artist-song-row" data-artist-track-id="${id}" data-track-ref="${escapeHtml(stableTrackRef(song))}" data-track-number="${index + 1}" data-track-label="${title} by ${name}" aria-label="Play ${title} by ${name}" ${trackAvailable(song) ? '' : 'disabled'}>
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
        <span class="artist-song-num" aria-hidden="true">${index + 1}</span>
        <img class="artist-song-cover" src="${escapeHtml(song.img || DEFAULT_COVER)}" alt="" width="44" height="44" loading="lazy" decoding="async">
        <span class="artist-song-info"><span class="artist-song-title">${title}</span><span class="artist-song-sub">${name}${song.missing ? ' (file unavailable)' : ''}</span></span>
        <span class="artist-song-play-btn" aria-hidden="true">${playIcon}</span>
      </button>
      ${trackActions ? `<div class="artist-song-actions">
<<<<<<< HEAD
        <button type="button" class="artist-song-action song-item-like${song.favorite ? ' active' : ''}" data-like-song-id="${id}" aria-label="${song.favorite ? 'Unlike' : 'Like'} ${title}" aria-pressed="${!!song.favorite}"><i class="fa-${song.favorite ? 'solid' : 'regular'} fa-heart" aria-hidden="true"></i></button>
=======
        <button type="button" class="artist-song-action${song.favorite ? ' active' : ''}" data-like-song-id="${id}" aria-label="${song.favorite ? 'Unlike' : 'Like'} ${title}" aria-pressed="${!!song.favorite}"><i class="fa-${song.favorite ? 'solid' : 'regular'} fa-heart" aria-hidden="true"></i></button>
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
        <button type="button" class="artist-song-action" data-song-menu="${id}" aria-label="More options for ${title}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>
      </div>` : ''}
    </li>`;
  }).join('');
}

<<<<<<< HEAD
/** Home and Library mount identical artwork, reading and transport markup.
    A favorite/playback/metadata refresh retains existing track buttons. */
export function renderArtistPage(root: HTMLElement, artist: ArtistGroup, options: ArtistPageOptions): void {
  const previous = mountedPages.get(root);
  const unchanged = previous && previous.artist.key === artist.key && previous.artist.name === artist.name &&
    previous.tracks.length === artist.songs.length && previous.tracks.every((before, i) => {
      const song = artist.songs[i];
      return before.song === song && ['id', 'title', 'artist', 'img', 'url', 'missing'].every(field => before[field] === song[field]);
    }) && !!previous.options.onFavorite === !!options.onFavorite && root.querySelector('[data-artist-track-id]');
  const mount: MountedPage = { artist, options, tracks: artist.songs.map(song => ({ song,
    id: song.id, title: song.title, artist: song.artist, img: song.img, url: song.url, missing: song.missing })) };
  mountedPages.set(root, mount);
  if(unchanged) {
    refreshArtistPageMetadata(root, artist);
    refreshArtistPagePlayback(root);
    refreshArtistPageFavorites(root);
    return;
  }
  root.classList.add('artist-detail-page');
  root.setAttribute('aria-label', `${artist.name}, artist`);
  const prefix = options.prefix, disabled = artist.songs.some(isPlaylistTrackAvailable) ? '' : 'disabled';
=======
export function renderArtistPage(root: HTMLElement, artist: ArtistPageEntry, options: ArtistPageOptions): void {
  const mount = { artist, options };
  mountedPages.set(root, mount);
  root.classList.add('artist-detail-page');
  root.setAttribute('aria-label', `${artist.name}, artist`);
  const prefix = options.prefix;
  const disabled = artist.songs.some(trackAvailable) ? '' : 'disabled';
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
  root.innerHTML = `
    <button type="button" class="artist-detail-back-btn" data-artist-back>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 5l-7 7 7 7"/></svg><span>Back to Artists</span>
    </button>
    <div class="artist-detail-layout">
      <section class="artist-hero-card" id="${prefix}HeroCard" aria-labelledby="${prefix}Name">
<<<<<<< HEAD
        <div class="artist-hero-backdrop" aria-hidden="true"><img class="artist-hero-image" data-artist-portrait src="${escapeHtml(artist.cover || DEFAULT_ARTIST_PORTRAIT)}" alt="" loading="eager" decoding="async" fetchpriority="high"></div>
        <div class="artist-hero-content">
          <h1 class="artist-hero-name" id="${prefix}Name" tabindex="-1">${escapeHtml(artist.name)}</h1>
          <p class="artist-hero-count">${artist.songs.length} song${artist.songs.length === 1 ? '' : 's'} in your music</p>
          ${artistProfileDetailsHTML(artist.profile, prefix)}
=======
        <div class="artist-hero-backdrop" aria-hidden="true"><img class="artist-hero-image" src="${escapeHtml(artist.img || DEFAULT_COVER)}" alt="" loading="eager" decoding="async" fetchpriority="high"></div>
        <div class="artist-hero-content">
          <h1 class="artist-hero-name" id="${prefix}Name" tabindex="-1">${escapeHtml(artist.name)}</h1>
          <p class="artist-hero-count">${artist.songs.length} song${artist.songs.length === 1 ? '' : 's'} in your music</p>
          <div class="artist-bio" hidden>
            <div class="artist-bio-body" id="${prefix}Biography"><p class="artist-bio-text"></p><small class="artist-bio-credit" hidden></small></div>
            <button type="button" class="artist-bio-toggle" id="${prefix}BiographyToggle" data-artist-bio-toggle aria-expanded="false" aria-controls="${prefix}Biography" hidden>More</button>
          </div>
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
        </div>
      </section>
      <section class="artist-songs-section" aria-labelledby="${prefix}SongsTitle">
        <div class="artist-songs-header">
          <h2 class="artist-songs-title" id="${prefix}SongsTitle">Songs</h2>
          <div class="artist-songs-actions">
            <button type="button" class="artist-action-pill play-pill" id="${prefix}PlayAllBtn" data-artist-play-all ${disabled}>${playIcon}<span>Play all</span></button>
            <button type="button" class="artist-action-pill shuffle-pill" id="${prefix}ShuffleBtn" data-artist-shuffle ${disabled}>${shuffleIcon}<span>Shuffle</span></button>
          </div>
        </div>
<<<<<<< HEAD
        <ol class="artist-songs-list" id="${prefix}SongsList">${songRows(artist, !!options.onFavorite)}</ol>
        ${artist.songs.length ? '' : '<p class="artist-songs-empty">No songs by this artist are available in your library yet. Go back to Artists to choose another.</p>'}
      </section>
    </div>`;
  root.onclick = event => {
    const currentMount = mountedPages.get(root);
    if(!currentMount) return;
    const { artist: currentArtist, options: currentOptions } = currentMount;
    const target = event.target as Element;
    if(target.closest('[data-artist-back]')) return currentOptions.onBack();
    if(target.closest('[data-artist-bio-toggle]')) {
      const biography = root.querySelector<HTMLElement>('.artist-biography');
      const expanded = biography.classList.toggle('is-expanded');
      const toggle = biography.querySelector<HTMLButtonElement>('[data-artist-bio-toggle]');
=======
        <ol class="artist-songs-list" id="${prefix}SongsList">${songRows(artist, !!options.trackActions)}</ol>
        ${artist.songs.length ? '' : '<p class="artist-songs-empty">No songs by this artist are available in your library yet. Go back to Artists to choose another.</p>'}
      </section>
    </div>`;

  root.onclick = (event) => {
    const target = event.target as Element;
    if (target.closest('[data-artist-back]')) return options.onBack();
    if (target.closest('[data-artist-bio-toggle]')) {
      const biography = root.querySelector<HTMLElement>('.artist-bio');
      const expanded = biography.classList.toggle('is-expanded');
      const toggle = root.querySelector<HTMLButtonElement>('.artist-bio-toggle');
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
      toggle.textContent = expanded ? 'Less' : 'More';
      toggle.setAttribute('aria-expanded', String(expanded));
      scheduleArtworkUpdate();
      return;
    }
<<<<<<< HEAD
    const favorite = target.closest<HTMLElement>('[data-like-song-id]');
    if(favorite) return currentOptions.onFavorite?.(event, favorite.dataset.likeSongId);
    if(target.closest('[data-artist-play-all]:not(:disabled)')) { playArtistCollection(currentArtist); return; }
    if(target.closest('[data-artist-shuffle]:not(:disabled)')) { playArtistCollection(currentArtist, true); return; }
    const row = target.closest<HTMLButtonElement>('[data-artist-track-id]:not(:disabled)');
    if(!row) return;
    const context = getArtistPlayback(), current = state.songs[state.currentIndex];
    if(context?.collectionId === currentArtist.key && String(current?.id) === row.dataset.artistTrackId) togglePlay();
    else playArtistCollection(currentArtist, false, row.dataset.artistTrackId);
  };
  // Home's persistent mount changes display in place. Library mounts are
  // replaced when leaving Artists; their parent tab already owns visibility.
  if(root.id === 'homeArtistDetailView') visibilityObserver.observe(root, { attributes: true, attributeFilter: ['style'] });
  refreshArtistPagePlayback(root);
  requestAnimationFrame(() => updateBiographyToggle(root));
  scheduleArtworkUpdate();
}

export function refreshArtistPageMetadata(root: HTMLElement, artist: ArtistGroup): void {
  const mount = mountedPages.get(root);
  if(!mount || mount.artist.key !== artist.key) return;
  mount.artist = artist;
  const portrait = root.querySelector<HTMLImageElement>('.artist-hero-image');
  if(portrait) setArtistPortraitSource(portrait, artist.cover || DEFAULT_ARTIST_PORTRAIT);
  const content = root.querySelector<HTMLElement>('.artist-hero-content');
  if(content) updateArtistProfileDetails(content, artist.profile, mount.options.prefix, portrait);
  requestAnimationFrame(() => updateBiographyToggle(root));
  scheduleArtworkUpdate();
}
function updateBiographyToggle(root: HTMLElement): void {
  const wrapper = root.querySelector<HTMLElement>('.artist-biography'), text = wrapper?.querySelector<HTMLElement>('.artist-bio-text');
  const toggle = wrapper?.querySelector<HTMLButtonElement>('[data-artist-bio-toggle]');
  if(!wrapper || !text || !toggle || !root.getClientRects().length) return;
  toggle.hidden = !wrapper.classList.contains('is-expanded') && text.scrollHeight <= text.clientHeight + 1;
}
export function refreshArtistPagePlayback(root: HTMLElement): void {
  const mount = mountedPages.get(root);
  if(!mount) return;
  const current = state.songs[state.currentIndex], context = getArtistPlayback();
  const ownContext = context?.collectionId === mount.artist.key;
  root.querySelectorAll<HTMLButtonElement>('[data-artist-track-id]').forEach(row => {
    const selected = String(current?.id) === row.dataset.artistTrackId;
    const playing = selected && isMainPlaybackPlaying();
    row.classList.toggle('is-playing', playing);
    if(selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
=======
    if (target.closest('[data-artist-play-all]:not(:disabled)')) { playArtistCollection(artist); return; }
    if (target.closest('[data-artist-shuffle]:not(:disabled)')) { playArtistCollection(artist, true); return; }
    const row = target.closest<HTMLButtonElement>('[data-artist-track-id]:not(:disabled)');
    if (!row) return;
    const current = state.activeTrack;
    if (current && stableTrackRef(current) === row.dataset.trackRef &&
        state.playbackContext?.source === 'artist' && state.playbackContext.collectionId === artist.key) togglePlay();
    else playArtistCollection(artist, false, row.dataset.artistTrackId);
  };

  if (artist.bio?.trim()) setBiography(root, { text: artist.bio.trim() });
  else void getArtistBiography(artist.name).then((biography) => {
    if (biography && mountedPages.get(root) === mount && root.isConnected) setBiography(root, biography);
  });
  refreshArtistPagePlayback(root);
  scheduleArtworkUpdate();
}

function setBiography(root: HTMLElement, biography: ArtistBiography): void {
  const wrapper = root.querySelector<HTMLElement>('.artist-bio');
  const text = root.querySelector<HTMLElement>('.artist-bio-text');
  const credit = root.querySelector<HTMLElement>('.artist-bio-credit');
  wrapper.hidden = false;
  text.textContent = biography.text;
  if (biography.title) {
    const source = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(biography.title.replace(/ /g, '_'));
    credit.hidden = false;
    credit.innerHTML = `Biography excerpt:<br><a href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(biography.title)} — Wikipedia introduction</a> by Wikipedia contributors (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>)`;
  }
  requestAnimationFrame(() => { updateBiographyToggle(root); scheduleArtworkUpdate(); });
}

function updateBiographyToggle(root: HTMLElement): void {
  const wrapper = root.querySelector<HTMLElement>('.artist-bio');
  const text = root.querySelector<HTMLElement>('.artist-bio-text');
  const toggle = root.querySelector<HTMLButtonElement>('.artist-bio-toggle');
  if (!wrapper || wrapper.hidden || !text || !toggle || !root.getClientRects().length) return;
  const credit = root.querySelector<HTMLElement>('.artist-bio-credit');
  toggle.hidden = !wrapper.classList.contains('is-expanded') && text.scrollHeight <= text.clientHeight + 1 && !!credit.hidden;
}

export function refreshArtistPagePlayback(root: HTMLElement): void {
  const mount = mountedPages.get(root);
  if (!mount) return;
  const current = state.activeTrack;
  const currentRef = current ? stableTrackRef(current) : '';
  const ownContext = state.playbackContext?.source === 'artist' && state.playbackContext.collectionId === mount.artist.key;
  root.querySelectorAll<HTMLButtonElement>('[data-artist-track-id]').forEach((row) => {
    const selected = row.dataset.trackRef === currentRef;
    const playing = selected && state.isPlaying;
    row.classList.toggle('is-playing', playing);
    if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
    row.setAttribute('aria-label', `${playing && ownContext ? 'Pause' : 'Play'} ${row.dataset.trackLabel}`);
    row.querySelector('.artist-song-num').innerHTML = playing ? playingIcon : row.dataset.trackNumber;
    row.querySelector('.artist-song-play-btn').innerHTML = playing && ownContext ? pauseIcon : playIcon;
  });
}
<<<<<<< HEAD
export function refreshArtistPageFavorites(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-like-song-id]').forEach(button => {
    const song = state.songs.find(song => String(song.id) === button.dataset.likeSongId);
    if(!song) return;
=======

export function refreshArtistPageFavorites(root: HTMLElement): void {
  const mount = mountedPages.get(root);
  if (!mount) return;
  const songs = new Map(mount.artist.songs.map((song) => [String(song.id), song]));
  root.querySelectorAll<HTMLButtonElement>('[data-like-song-id]').forEach((button) => {
    const song = songs.get(button.dataset.likeSongId);
    if (!song) return;
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
    button.classList.toggle('active', !!song.favorite);
    button.setAttribute('aria-pressed', String(!!song.favorite));
    button.setAttribute('aria-label', `${song.favorite ? 'Unlike' : 'Like'} ${song.title || 'Untitled'}`);
    button.querySelector('i').className = `fa-${song.favorite ? 'solid' : 'regular'} fa-heart`;
  });
}

let artworkRaf = 0;
function scheduleArtworkUpdate(): void {
<<<<<<< HEAD
  if(artworkRaf) return;
  artworkRaf = requestAnimationFrame(() => {
    artworkRaf = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('aura-reduce-motion');
    document.querySelectorAll<HTMLElement>('.artist-detail-page .artist-hero-card').forEach(card => {
      if(!card.getClientRects().length) return;
      const image = card.querySelector<HTMLElement>('.artist-hero-image'), bounds = card.getBoundingClientRect();
=======
  if (artworkRaf) return;
  artworkRaf = requestAnimationFrame(() => {
    artworkRaf = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('aura-reduce-motion');
    document.querySelectorAll<HTMLElement>('.artist-detail-page .artist-hero-card').forEach((card) => {
      if (!card.getClientRects().length) return;
      const image = card.querySelector<HTMLElement>('.artist-hero-image');
      const bounds = card.getBoundingClientRect();
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
      const progress = reduced ? 0 : Math.min(Math.max(-bounds.top / (bounds.height * .5), 0), 1);
      image.style.setProperty('--artist-image-blur', `${(progress * 22).toFixed(2)}px`);
      image.style.setProperty('--artist-image-brightness', String(1 - progress * .35));
      image.style.setProperty('--artist-image-scale', String(1 + progress * .12));
    });
  });
}
<<<<<<< HEAD
=======

>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
window.addEventListener('scroll', scheduleArtworkUpdate, { passive: true });
window.addEventListener('resize', () => {
  document.querySelectorAll<HTMLElement>('.artist-detail-page').forEach(updateBiographyToggle);
  scheduleArtworkUpdate();
});
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', scheduleArtworkUpdate);
window.addEventListener('aura:playback-changed', () => {
  document.querySelectorAll<HTMLElement>('.artist-detail-page').forEach(refreshArtistPagePlayback);
});
<<<<<<< HEAD
const visibilityObserver = new MutationObserver(() => {
  document.querySelectorAll<HTMLElement>('.artist-detail-page').forEach(updateBiographyToggle);
  scheduleArtworkUpdate();
});
visibilityObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
document.querySelectorAll('.tab-content').forEach(tab => visibilityObserver.observe(tab, { attributes: true, attributeFilter: ['class'] }));
=======
const visibilityObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.target instanceof HTMLElement && mutation.target.classList.contains('tab-content')) {
      mutation.target.querySelectorAll<HTMLElement>('.artist-detail-page').forEach(updateBiographyToggle);
    }
  }
  scheduleArtworkUpdate();
});
visibilityObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
document.querySelectorAll('.tab-content').forEach((tab) => visibilityObserver.observe(tab, { attributes: true, attributeFilter: ['class'] }));
>>>>>>> 62cde5b (Private recovery snapshot before local/production reconciliation (not for deployment))
