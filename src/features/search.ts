import { stateHTML, toast } from '../core/dom';
import { songIndexById, songItemHTML } from './library';
import { goTab } from '../ui/nav';
import { $, state } from '../core/state';

/* Search is intentionally library-only. Music acquisition belongs to the
   Discord submission pipeline; Aura Music is the place where the finished
   library is browsed and played. */

export const auraYTQueue: any[] = [];
export let searchCategory = 'all';

export const categoryLabels: Record<string, string> = {
  all: 'All tracks',
  favorites: 'Favorites',
  recent: 'Recently played',
};

export function getYouTubeIdFromUrl(value: unknown): string | null {
  const url = String(value || '');
  let match = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (match) return match[1];
  match = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (match) return match[1];
  match = url.match(/youtube\.com\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
  return match ? match[1] : null;
}

export function extractYouTubeId(stream: any): string | null {
  if (!stream) return null;
  const source = stream.source || stream;
  const direct = source.ytId || source.yt_id || stream.ytId || stream.yt_id;
  if (direct) return String(direct).split(':').pop() || null;

  const candidates = [
    stream.url,
    stream.externalUrl,
    source.url,
    source.externalUrl,
    stream.content,
    source.content,
    stream.id,
    source.id,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const value = String(raw);
    const fromUrl = getYouTubeIdFromUrl(value);
    if (fromUrl) return fromUrl;
    const tagged = value.match(/(?:^|:)yt_id:([A-Za-z0-9_-]{6,})$/i);
    if (tagged) return tagged[1];
    if (/^yt_id[:_]/i.test(value)) return value.split(/[:_]/).pop() || null;
  }
  return null;
}

export function songsForCategory(): any[] {
  if (searchCategory === 'favorites') return state.songs.filter((song: any) => song.favorite);
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
  tile.onclick = () => {
    searchCategory = tile.dataset.filter || 'all';
    $('browseGrid')?.querySelectorAll('.browse-tile').forEach((item) => item.classList.remove('active'));
    tile.classList.add('active');
    filterSearchTab();
  };
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
