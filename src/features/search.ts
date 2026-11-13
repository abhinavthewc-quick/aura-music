import { stateHTML, toast } from '../core/dom';
import { songIndexById, songItemHTML } from './library';
import { goTab } from '../ui/nav';
import { $, state } from '../core/state';

// Compatibility for retained YouTube selections. Search itself stays library-only;
// this transient queue is never populated by a remote acquisition/search service.
export const auraYTQueue: any[] = [];
export function extractYouTubeId(meta: any): string | null {
  const id = meta?._auraYoutubeId || meta?.videoId || meta?.id;
  if (/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) return String(id);
  try {
    const url = new URL(String(meta?.url || meta?.webpage_url || ''));
    const candidate = url.hostname === 'youtu.be' ? url.pathname.slice(1)
      : /^(?:www\.|music\.)?youtube\.com$/.test(url.hostname) ? url.searchParams.get('v') || url.pathname.split('/')[2] : '';
    return /^[A-Za-z0-9_-]{11}$/.test(candidate || '') ? candidate : null;
  } catch { return null; }
}

/* Search is intentionally library-only. Music acquisition belongs to the
   Discord submission pipeline; Aura Music is the place where the finished
   library is browsed and played. */

export let searchCategory = 'all';

export const categoryLabels: Record<string, string> = {
  all: 'All tracks',
  favorites: 'Favorites',
  recent: 'Recently played',
  local: 'Local files',
};

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

export function renderSearchResults(list: any[]): void {
  const host = $('searchResultsList');
  if (!host) return;
  const indexById = songIndexById();
  host.innerHTML = list.length
    ? list.map((song: any) => songItemHTML(song, indexById.get(String(song.id)))).join('')
    : stateHTML(
        'noresults',
        'No matches in your library',
        'Try a title, artist, album, or film already available in Aura Music.',
      );
}

export function filterSearchTab(): void {
  const input = $('searchTabInput') as HTMLInputElement | null;
  const searchTab = $('tabSearch');
  const browse = $('browseGrid');
  if (!input || !searchTab) return;

  const localImport = $('importLocalAudioBtn');
  if (localImport) localImport.hidden = searchCategory !== 'local';
  const query = normalized(input.value);
  searchTab.classList.toggle('searching', Boolean(query));

  if (query && browse) {
    browse.querySelectorAll('.browse-tile').forEach((tile) => tile.classList.remove('active'));
    browse.querySelector('[data-filter="all"]')?.classList.add('active');
  }

  const base = query ? state.songs : songsForCategory();
  const filtered = query
    ? base.filter((song: any) =>
        [song.title, song.artist, song.album, song.film, song.genre]
          .some((value) => normalized(value).includes(query)),
      )
    : base;

  const label = $('searchResultsLabel');
  if (label) label.textContent = query ? `${filtered.length} result${filtered.length === 1 ? '' : 's'}` : categoryLabels[searchCategory];
  renderSearchResults(filtered);
}

export function goToSearchCategory(category: string): void {
  searchCategory = categoryLabels[category] ? category : 'all';
  for (const id of ['searchTabInput','headerSearchInput','mobileSearchInput']) {
    const input = $(id) as HTMLInputElement | null;
    if (input) input.value = '';
  }
  syncSearchChrome();
  goTab('tabSearch');
  $('browseGrid')?.querySelectorAll<HTMLElement>('.browse-tile').forEach((tile) => {
    tile.classList.toggle('active', tile.dataset.filter === searchCategory);
  });
  filterSearchTab();
}

/* Kept for old inline markup in cached clients. It now searches only Aura. */
export function runSearchChip(button: HTMLElement): void {
  const input = $('searchTabInput') as HTMLInputElement | null;
  if (!input) return;
  input.value = button.textContent?.trim() || '';
  input.focus();
  filterSearchTab();
}

const searchInput = $('searchTabInput') as HTMLInputElement | null;
const searchWrap = $('searchBarWrap');
const clearButton = $('searchClearBtn') as HTMLButtonElement | null;

function syncSearchChrome(): void {
  searchWrap?.classList.toggle('has-text', Boolean(searchInput?.value));
}

searchInput?.addEventListener('input', () => {
  syncSearchChrome();
  filterSearchTab();
});

if (clearButton) {
  clearButton.onclick = () => {
    if (!searchInput) return;
    searchInput.value = '';
    syncSearchChrome();
    filterSearchTab();
    searchInput.focus();
  };
}

syncSearchChrome();

(window as any).searchLikedSong = (id: string): void => {
  const song = state.songs.find((item: any) => String(item.id) === String(id));
  if (!song || !searchInput) return;
  goTab('tabSearch');
  searchInput.value = song.title || '';
  syncSearchChrome();
  filterSearchTab();
};

$('browseGrid')?.querySelectorAll<HTMLElement>('.browse-tile').forEach((tile) => {
  tile.onclick = () => goToSearchCategory(tile.dataset.filter || 'all');
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
    syncSearchChrome();
    filterSearchTab();
  };
  recognizer.onerror = () => toast('Voice search failed. Try typing instead.', 'triangle-exclamation');
  recognizer.onend = () => voiceButton.classList.remove('mode-active');
  voiceButton.onclick = () => {
    try { recognizer.start(); } catch { /* already listening */ }
  };
} else if (voiceButton) {
  voiceButton.onclick = () => toast('Voice search is not supported in this browser.', 'triangle-exclamation');
}
