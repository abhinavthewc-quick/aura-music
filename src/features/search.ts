import { stateHTML, toast } from '../core/dom';
import { songItemHTML } from './library';
import { goTab } from '../ui/nav';
import { $, state } from '../core/state';

/* Search is intentionally library-only. Music acquisition belongs to the
   Discord submission pipeline; Aura Music is the place where the finished
   library is browsed and played.

   There is no Search tab any more: the field sits at the top of Home and the
   results open directly underneath it. One entry point on every screen size,
   and nothing is rendered until somebody actually asks to search — the home
   feed is never rebuilt to serve a query. */

export let searchCategory = 'all';

export const categoryLabels: Record<string, string> = {
  all: 'All tracks',
  favorites: 'Favorites',
  recent: 'Recently played',
  local: 'Local files',
};

/* Rows are revealed a page at a time. The old list rendered the entire
   library (493 rows, 493 artwork requests) the moment it opened; 30 rows fill
   a phone screen twice over for a fraction of the layout and decode work. */
const PAGE_SIZE = 30;

let currentResults: any[] = [];
let visibleCount = 0;
let renderedCount = 0;
/* A favourite toggle refreshes the panel without changing the query; keeping
   the page depth means the list does not jump back to 30 rows underneath the
   pointer. */
let lastQueryKey = '';

export function songsForCategory(): any[] {
  if (searchCategory === 'favorites') return state.songs.filter((song: any) => song.favorite);
  if (searchCategory === 'local') return state.songs.filter((song: any) => song.isLocal);
  if (searchCategory === 'recent') {
    return state.recentlyPlayed
      .map((recent: any) => state.songs.find((song: any) => String(song.id) === String(recent.id)))
      .filter(Boolean);
  }
  return state.songs;
}

function normalized(value: unknown): string {
  return String(value || '').toLocaleLowerCase().trim();
}

/* Filtering used to rebuild five lowercased strings per song on every
   keystroke. Each song's searchable text is cached and only rebuilt when one
   of its fields actually changes, so later keystrokes are a substring test
   per track with no allocation. */
const hayCache = new WeakMap<object, { fields: unknown[]; text: string }>();
function haystack(song: any): string {
  const fields = [song.title, song.artist, song.album, song.film, song.genre];
  const cached = hayCache.get(song);
  if (cached && cached.fields.every((value, index) => value === fields[index])) return cached.text;
  const text = fields.map(normalized).join('\u0000');
  hayCache.set(song, { fields, text });
  return text;
}

export function isSearchOpen(): boolean {
  return !!$('tabHome')?.classList.contains('search-open');
}

function syncSearchChrome(): void {
  const input = $('searchTabInput') as HTMLInputElement | null;
  const hasText = Boolean(input?.value);
  $('searchBarWrap')?.classList.toggle('has-text', hasText);
  const clear = $('searchClearBtn');
  if (clear) clear.setAttribute('aria-label', hasText ? 'Clear search' : 'Close search');
}

function syncCategoryChrome(): void {
  const query = normalized(($('searchTabInput') as HTMLInputElement | null)?.value);
  $('homeSearchResults')?.classList.toggle('searching', Boolean(query));
  $('browseGrid')?.querySelectorAll<HTMLElement>('.browse-tile').forEach((tile) => {
    tile.classList.toggle('active', !query && tile.dataset.filter === searchCategory);
  });
  const importButton = $('importLocalAudioBtn');
  if (importButton) importButton.hidden = Boolean(query) || searchCategory !== 'local';
}

function updateMoreButton(): void {
  const more = $('searchMoreBtn') as HTMLButtonElement | null;
  if (!more) return;
  const remaining = currentResults.length - renderedCount;
  more.hidden = remaining <= 0;
  if (remaining > 0) more.textContent = `Show ${Math.min(PAGE_SIZE, remaining)} more (${remaining} left)`;
}

function renderResults(): void {
  const host = $('searchResultsList');
  if (!host) return;
  if (!currentResults.length) {
    host.innerHTML = state.catalogLoading
      ? stateHTML('noresults', 'Still loading your library…', 'Results appear as soon as the catalogue finishes loading.')
      : stateHTML(
        'noresults',
        'No matches in your library',
        'Try a title, artist, album, or film already available in Aura Music.',
      );
    renderedCount = 0;
    updateMoreButton();
    return;
  }
  const next = currentResults.slice(renderedCount, visibleCount);
  if (next.length) {
    const html = next.map((song: any) => songItemHTML(song)).join('');
    if (renderedCount === 0) host.innerHTML = html;
    else host.insertAdjacentHTML('beforeend', html);
    renderedCount += next.length;
  }
  updateMoreButton();
}

/* Renders the current query/category into the panel under the search bar. */
export function applySearch(): void {
  if (!isSearchOpen()) return;
  const input = $('searchTabInput') as HTMLInputElement | null;
  if (!input) return;

  const query = normalized(input.value);
  const source = query ? state.songs : songsForCategory();
  currentResults = query ? source.filter((song: any) => haystack(song).includes(query)) : source;
  const queryKey = `${searchCategory}\u0000${query}`;
  const keepCount = queryKey === lastQueryKey ? Math.min(visibleCount, currentResults.length) : 0;
  lastQueryKey = queryKey;
  visibleCount = Math.max(Math.min(PAGE_SIZE, currentResults.length), keepCount);
  renderedCount = 0;

  const label = $('searchResultsLabel');
  if (label) {
    label.textContent = query
      ? `${currentResults.length} result${currentResults.length === 1 ? '' : 's'}`
      : categoryLabels[searchCategory];
  }

  syncSearchChrome();
  syncCategoryChrome();
  renderResults();
}

/* Kept under its old name: other modules call it after a change that can
   affect the visible results (favourite toggled, local files imported). */
export function filterSearchTab(): void {
  applySearch();
}

export function refreshSearchIfOpen(): void {
  if (isSearchOpen()) applySearch();
}

function setSearchOpen(open: boolean): void {
  $('tabHome')?.classList.toggle('search-open', open);
  const panel = $('homeSearchResults');
  if (panel) panel.hidden = !open;
  syncSearchChrome();
}

/* Opens the Home search panel. `focus` is false for category landings, where
   popping the phone keyboard over the list would be unhelpful. */
export function openSearch(focus = true): void {
  const home = $('tabHome');
  if (!home) return;
  if (!home.classList.contains('active')) goTab('tabHome', true);
  setSearchOpen(true);
  const input = $('searchTabInput') as HTMLInputElement | null;
  if (input && focus) {
    input.focus({ preventScroll: true });
    input.select();
  }
  applySearch();
  if (focus) input?.scrollIntoView({ block: 'nearest' });
}

export function closeSearch(clear = true): void {
  setSearchOpen(false);
  if (clear) {
    const input = $('searchTabInput') as HTMLInputElement | null;
    if (input) input.value = '';
    searchCategory = 'all';
    currentResults = [];
    visibleCount = 0;
    renderedCount = 0;
    $('searchResultsList')?.replaceChildren();
    syncCategoryChrome();
  }
  syncSearchChrome();
}

export function goToSearchCategory(category: string): void {
  searchCategory = categoryLabels[category] ? category : 'all';
  const input = $('searchTabInput') as HTMLInputElement | null;
  if (input) input.value = '';
  openSearch(false);
}

/* Kept for old inline markup in cached clients. It now searches only Aura. */
export function runSearchChip(button: HTMLElement): void {
  const input = $('searchTabInput') as HTMLInputElement | null;
  if (!input) return;
  input.value = button.textContent?.trim() || '';
  searchCategory = 'all';
  openSearch();
}

const searchInput = $('searchTabInput') as HTMLInputElement | null;
const clearButton = $('searchClearBtn') as HTMLButtonElement | null;

/* Coalesce keystrokes so a fast typist pays for the last one only. Enter,
   the clear button and category picks still apply immediately. */
let searchTypingTimer = 0;
function applySoon(): void {
  window.clearTimeout(searchTypingTimer);
  searchTypingTimer = window.setTimeout(applySearch, 70);
}

searchInput?.addEventListener('focus', () => {
  if (isSearchOpen()) return;
  setSearchOpen(true);
  applySearch();
});

searchInput?.addEventListener('input', () => {
  if (!isSearchOpen()) setSearchOpen(true);
  syncSearchChrome();
  syncCategoryChrome();
  applySoon();
});

searchInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    window.clearTimeout(searchTypingTimer);
    applySearch();
  } else if (event.key === 'Escape') {
    window.clearTimeout(searchTypingTimer);
    closeSearch(true);
    searchInput?.blur();
  }
});

if (clearButton) {
  clearButton.onclick = () => {
    if (!searchInput) return;
    window.clearTimeout(searchTypingTimer);
    /* An empty field means the X closes the panel and restores the feed. */
    if (!searchInput.value && searchCategory === 'all') {
      closeSearch(true);
      searchInput.blur();
      return;
    }
    searchInput.value = '';
    searchCategory = 'all';
    applySearch();
    searchInput.focus({ preventScroll: true });
  };
}

$('searchMoreBtn')?.addEventListener('click', () => {
  visibleCount = Math.min(currentResults.length, visibleCount + PAGE_SIZE);
  renderResults();
});

$('browseGrid')?.querySelectorAll<HTMLElement>('.browse-tile').forEach((tile) => {
  tile.onclick = () => {
    const filter = tile.dataset.filter || 'all';
    searchCategory = categoryLabels[filter] ? filter : 'all';
    if (searchInput) searchInput.value = '';
    if (!isSearchOpen()) setSearchOpen(true);
    applySearch();
  };
});

syncSearchChrome();

(window as any).searchLikedSong = (id: string): void => {
  const song = state.songs.find((item: any) => String(item.id) === String(id));
  if (!song || !searchInput) return;
  searchCategory = 'all';
  searchInput.value = song.title || '';
  openSearch(false);
};

/* "/" focuses search from anywhere except while typing into a field. */
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  event.preventDefault();
  openSearch();
});

const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const voiceButton = $('voiceSearchBtn') as HTMLButtonElement | null;
if (voiceButton && SpeechRecognitionCtor) {
  const recognizer = new SpeechRecognitionCtor();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.onstart = () => {
    voiceButton.classList.add('mode-active');
    toast('Listening…', 'microphone');
  };
  recognizer.onresult = (event: any) => {
    if (!searchInput) return;
    searchInput.value = event.results[0][0].transcript;
    searchCategory = 'all';
    openSearch(false);
  };
  recognizer.onerror = () => toast('Voice search failed. Try typing instead.', 'triangle-exclamation');
  recognizer.onend = () => voiceButton.classList.remove('mode-active');
  voiceButton.onclick = () => {
    try { recognizer.start(); } catch { /* already listening */ }
  };
} else if (voiceButton) {
  voiceButton.onclick = () => toast('Voice search is not supported in this browser.', 'triangle-exclamation');
}