export interface ArtistBiography {
  text: string;
  title?: string;
}

const CACHE_KEY = 'auraArtistBiographies_v1';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const requests = new Map<string, Promise<ArtistBiography | null>>();
type CachedBiography = ArtistBiography & { at: number };

const nameKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const pageTitles = (name: string): string[] => [
  name, `${name} (composer)`, `${name} (singer)`, `${name} (musician)`,
  `${name} (rapper)`, `${name} (music director)`,
];

/* A same-named person or a disambiguation page is not an artist biography. */
export function biographyFromWikipedia(data: any, artistName: string): ArtistBiography | null {
  const titles = pageTitles(artistName);
  const keys = titles.map(nameKey);
  for (const redirect of data?.query?.redirects || []) {
    if (typeof redirect?.from === 'string' && typeof redirect?.to === 'string' && keys.includes(nameKey(redirect.from))) {
      keys.push(nameKey(redirect.to));
    }
  }
  const pages = Object.values(data?.query?.pages || {}) as any[];
  const candidates = pages.filter((page) => {
    if (!page || 'missing' in page || 'disambiguation' in (page.pageprops || {})) return false;
    if (typeof page.title !== 'string' || typeof page.extract !== 'string' || !page.extract.trim()) return false;
    if (!keys.includes(nameKey(page.title))) return false;
    const description = `${page.pageprops?.['wikibase-shortdesc'] || ''} ${page.extract.slice(0, 500)}`;
    return /\b(?:musician|composer|singer|songwriter|rapper|record producer|music producer|music director|disc jockey|DJ)\b/i.test(description);
  });
  candidates.sort((a, b) => keys.indexOf(nameKey(a.title)) - keys.indexOf(nameKey(b.title)));
  const page = candidates[0];
  return page ? { text: page.extract.trim().slice(0, 12_000), title: page.title } : null;
}

function readCache(): Record<string, CachedBiography> {
  const cache: Record<string, CachedBiography> = Object.create(null);
  try {
    const data = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return cache;
    for (const [key, entry] of Object.entries(data) as [string, any][]) {
      if (entry && typeof entry.text === 'string' && entry.text.length <= 12_000 &&
          typeof entry.title === 'string' && entry.title.length <= 300 && Number.isFinite(entry.at)) cache[key] = entry;
    }
    return cache;
  } catch { return cache; }
}

function saveBiography(key: string, biography: ArtistBiography): void {
  const cache = readCache();
  cache[key] = { ...biography, at: Date.now() };
  const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 32);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries))); }
  catch { /* Biographies still work when browser storage is full. */ }
}

/* Saved artist profiles take priority at the call site. Only introductions are
 * requested here; Wikipedia HTML and third-party links are never rendered. */
export function getArtistBiography(artistName: string): Promise<ArtistBiography | null> {
  const name = artistName.replace(/\s*-\s*Topic$/i, '').trim().slice(0, 200);
  if (!name) return Promise.resolve(null);
  const key = nameKey(name);
  if (!key) return Promise.resolve(null);
  const cached = readCache()[key];
  if (cached && Date.now() - cached.at < CACHE_TTL) return Promise.resolve(cached);
  if (requests.has(key)) return requests.get(key);

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    try {
      const url = new URL('https://en.wikipedia.org/w/api.php');
      url.search = new URLSearchParams({
        action: 'query', format: 'json', origin: '*', prop: 'extracts|pageprops',
        exintro: '1', explaintext: '1', redirects: '1', titles: pageTitles(name).join('|'),
      }).toString();
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) return cached || null;
      const biography = biographyFromWikipedia(await response.json(), name);
      if (biography) saveBiography(key, biography);
      return biography || cached || null;
    } catch { return cached || null; }
    finally { clearTimeout(timeout); }
  })().finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}
