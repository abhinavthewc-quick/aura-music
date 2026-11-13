import type { DisplayArtistProfile } from '../../lib/artistMetadata';
import { artistMetadataCreditHTML } from './artistMetadata';
import { escapeHtml } from './dom';

/* Only composed, already-validated metadata reaches this reading block. Saved
   overrides, genres, websites and provider attribution retain their precedence. */
export function artistProfileDetailsHTML(profile?: DisplayArtistProfile, prefix = 'artist', expanded = false): string {
  if(!profile) return '';
  const biography = typeof profile.bio === 'string' ? profile.bio.trim().slice(0, 2000) : '';
  const bio = biography ? `<div class="artist-biography${expanded ? ' is-expanded' : ''}">
    <div class="artist-bio-body" id="${prefix}Biography"><p class="artist-bio artist-bio-text">${escapeHtml(biography)}</p>${artistMetadataCreditHTML(profile.bioCredit, 'bio')}</div>
    <button type="button" class="artist-bio-toggle" data-artist-bio-toggle aria-expanded="${expanded}" aria-controls="${prefix}Biography" hidden>${expanded ? 'Less' : 'More'}</button>
  </div>` : '';
  const photoCredit = profile.img ? artistMetadataCreditHTML(profile.imageCredit, 'image') : '';
  const genres = Array.isArray(profile.genres) && profile.genres.length
    ? `<div class="artist-genres">${profile.genres.slice(0, 20).map(genre => `<span>${escapeHtml(String(genre).slice(0, 120))}</span>`).join('')}</div>` : '';
  let social = '';
  try {
    const url = new URL(profile.social || '');
    if(url.protocol === 'https:' && !url.username && !url.password) {
      social = `<a class="artist-social-link" href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Artist website <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`;
    }
  } catch { /* no external link */ }
  return bio || photoCredit || genres || social ? `<div class="artist-profile-details">${bio}${photoCredit}${genres}${social}</div>` : '';
}

/** Enrichment replaces only the reading block, never the name, track controls
    or playback callbacks. Preserve expansion and equivalent link/toggle focus. */
export function updateArtistProfileDetails(container: HTMLElement, profile?: DisplayArtistProfile, prefix = 'artist', portrait?: HTMLImageElement): void {
  const previous = container.querySelector<HTMLElement>(':scope > .artist-profile-details');
  const expanded = !!previous?.querySelector('.artist-biography.is-expanded');
  const template = document.createElement('template');
  template.innerHTML = artistProfileDetailsHTML(profile, prefix, expanded);
  const next = template.content.firstElementChild as HTMLElement | null;
  if(portrait?.dataset.coverFallback) next?.querySelector<HTMLElement>('[data-artist-credit="image"]')?.setAttribute('hidden', '');
  if(previous?.isEqualNode(next) || !previous && !next) return;
  const focused = document.activeElement as HTMLElement | null;
  const sourceHref = previous?.contains(focused) && focused instanceof HTMLAnchorElement ? focused.href : '';
  const sourceField = sourceHref ? focused?.closest('[data-artist-credit]')?.getAttribute('data-artist-credit') : undefined;
  const toggleFocused = previous?.contains(focused) && focused?.matches('[data-artist-bio-toggle]');
  if(previous) { if(next) previous.replaceWith(next); else previous.remove(); }
  else if(next) container.append(next);
  if(sourceHref) {
    const equivalent = [...(next?.querySelectorAll<HTMLAnchorElement>('a') || [])].find(link =>
      link.href === sourceHref && link.closest('[data-artist-credit]')?.getAttribute('data-artist-credit') === sourceField);
    equivalent?.focus({ preventScroll: true });
  } else if(toggleFocused) {
    const toggle = next?.querySelector<HTMLButtonElement>('[data-artist-bio-toggle]');
    if(toggle) { toggle.hidden = false; toggle.focus({ preventScroll: true }); }
  }
}
