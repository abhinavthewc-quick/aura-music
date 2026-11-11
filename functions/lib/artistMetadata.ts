import { normalizeArtistKey } from '../../lib/artistProfiles.js';
import type {
  ArtistMetadataCredit, ArtistMetadataResponse, AutomaticArtistMetadata,
} from '../../lib/artistMetadata.js';

/* Public, keyless Wikimedia reads only. Provider labels are informational:
   neither this adapter nor its caller changes artist names or track ownership. */
export const ARTIST_METADATA_POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
export const ARTIST_METADATA_NEGATIVE_TTL = 24 * 60 * 60 * 1000;
export const ARTIST_METADATA_PROVIDER_TIMEOUT = 17_000;
export const WIKIMEDIA_USER_AGENT = 'AuraMusicArtistMetadata/1.0 (+https://aura-music-01g.pages.dev; public artist metadata)';
export const MIN_PROVIDER_RETRY_SECONDS = 10;

const NAME_LIMIT = 120;
const BIO_LIMIT = 1200;
const INTRO_LIMIT = 950;
const URL_LIMIT = 2048;
const AUTHOR_LIMIT = 256;
const SEARCH_LIMIT = 50;
const ENTITY_LIMIT = 5;
const QID = /^Q[1-9][0-9]{0,18}$/;
const INVALID_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/;
const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const WIKIPEDIA_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/* These identities were verified, not inferred from popularity/search order.
   The two Rahman presentations are an explicit binding, not a general rule
   that removes punctuation from arbitrary artist names. Revalidate each QID. */
const BINDINGS = [
  { id: 'Q108560', names: ['A. R. Rahman', 'A.R. Rahman'] },
  { id: 'Q4765271', names: ['Anirudh Ravichander'] },
  { id: 'Q21808729', names: ['Alan Walker'] },
  { id: 'Q76364', names: ['Hans Zimmer'] },
  { id: 'Q110969361', names: ['Sorana'] },
];

/* A deliberately small, explicit ontology allowlist. A valid P434 can supply
   music evidence for a human, but never turns a company/place/ship into one. */
const MUSIC_GROUP_TYPES = new Set(['Q215380', 'Q2088357', 'Q5741069', 'Q42998', 'Q131186']);
const MUSIC_OCCUPATIONS = new Set([
  'Q639669', // musician
  'Q177220', // singer
  'Q36834', // composer
  'Q488205', // singer-songwriter
  'Q753110', // songwriter
  'Q183945', // record producer
  'Q130857', // DJ
  'Q2252262', // rapper
]);
const REJECTED_TYPES = new Set([
  'Q4167410', 'Q4167836', // disambiguation, Wikimedia category
  'Q532', 'Q515', 'Q486972', 'Q11446', // village, city, settlement, ship
  'Q783794', 'Q4830453', 'Q18127', // company, business, record label
  'Q482994', 'Q134556', 'Q7366', // album, single, song
]);

type JsonObject = Record<string, any>;
export interface ArtistMetadataProviderOptions {
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  /* Wikimedia permits user-waiting reads to omit maxlag. Idle enrichment
     retains maxlag=5; shared concurrency/budgets still apply in either mode. */
  interactive?: boolean;
}

export function validArtistMetadataName(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > NAME_LIMIT || INVALID_CHARACTERS.test(value)) return false;
  if (Array.from(value).some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)) return false;
  const key = normalizeArtistKey(value);
  return key.length <= NAME_LIMIT && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(key);
}

class ProviderRetry extends Error {
  constructor(readonly retryAfter = 60) { super('Wikimedia metadata is temporarily unavailable.'); }
}

export function providerRetryAfter(value: string | null, now: number): number {
  if (value === null || !value.trim()) return 60;
  const numeric = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - now) / 1000;
  if (!Number.isFinite(seconds)) return 60;
  /* Keep arithmetic safe without shortening any plausible Retry-After. */
  const maximum = Math.floor((Number.MAX_SAFE_INTEGER - Math.max(0, now)) / 1000);
  return Math.max(MIN_PROVIDER_RETRY_SECONDS, Math.min(maximum, Math.ceil(seconds)));
}

function boundedTimeout(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : maximum;
}

/* A non-cooperating injected fetch must not defeat the lookup deadline. The
   underlying promise always has rejection handlers, even after an abort. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new ProviderRetry()); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) { reject(new ProviderRetry()); return; }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function limitedJson(response: Response, limit: number, signal: AbortSignal): Promise<JsonObject> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw new ProviderRetry();
  }
  let text = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let complete = false;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) { complete = true; break; }
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw new ProviderRetry();
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    text = await abortable(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > limit) throw new ProviderRetry();
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ProviderRetry(); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ProviderRetry();
  return json as JsonObject;
}

class WikimediaClient {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private detach: () => void;
  private calls = 0;
  private fetcher: typeof fetch;
  readonly now: () => number;
  readonly interactive: boolean;
  constructor(private options: ArtistMetadataProviderOptions) {
    this.fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    this.now = options.now || Date.now;
    this.interactive = options.interactive === true;
    this.timer = setTimeout(() => this.controller.abort(), boundedTimeout(options.timeoutMs, ARTIST_METADATA_PROVIDER_TIMEOUT));
    const aborted = () => this.controller.abort();
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) aborted();
    this.detach = () => options.signal?.removeEventListener('abort', aborted);
  }
  close() { clearTimeout(this.timer); this.detach(); }
  async json(url: URL, limit: number, optionalMissing = false): Promise<JsonObject | null> {
    if (++this.calls > 4 || this.controller.signal.aborted) throw new ProviderRetry();
    const controller = new AbortController();
    const aborted = () => controller.abort();
    this.controller.signal.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(aborted, boundedTimeout(this.options.requestTimeoutMs, 6500));
    try {
      const response = await abortable(Promise.resolve().then(() => this.fetcher(url.href, {
        // workerd supports manual/follow, not redirect:error. Manual leaves
        // every 3xx to the non-OK check below, so no target URL is followed.
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': WIKIMEDIA_USER_AGENT },
      })), controller.signal);
      /* Fixed API origins only; never follow a provider-supplied target URL. */
      if (response.url && new URL(response.url).origin !== url.origin) throw new ProviderRetry();
      if (response.status === 404 && optionalMissing) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      const retryAfter = providerRetryAfter(response.headers.get('Retry-After'), this.now());
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ProviderRetry(retryAfter);
      }
      const json = await limitedJson(response, limit, controller.signal);
      if (json.error || (Array.isArray(json.errors) && json.errors.length) || (Number.isInteger(json.status) && json.status >= 400)) {
        const lag = Number(json.error?.lag);
        throw new ProviderRetry(Number.isFinite(lag) ? Math.max(retryAfter, Math.ceil(lag)) : retryAfter);
      }
      return json;
    } catch (error) {
      if (error instanceof ProviderRetry) throw error;
      throw new ProviderRetry();
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener('abort', aborted);
    }
  }
}

function actionUrl(host: 'www.wikidata.org' | 'commons.wikimedia.org', parameters: Record<string, string>, interactive = false): URL {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ format: 'json', ...(interactive ? {} : { maxlag: '5' }), ...parameters }).toString();
  return url;
}

function claimValues(entity: JsonObject, property: string): any[] {
  const claims = entity.claims?.[property];
  if (!Array.isArray(claims)) return [];
  return claims.filter((claim) => claim && claim.rank !== 'deprecated' && claim.mainsnak?.snaktype === 'value')
    .map((claim) => claim.mainsnak?.datavalue?.value).filter((value) => value !== undefined && value !== null);
}

function isMusicEntity(entity: JsonObject): boolean {
  const types = claimValues(entity, 'P31').map((value) => value?.id).filter((id) => typeof id === 'string');
  if (types.some((id) => REJECTED_TYPES.has(id))) return false;
  if (types.some((id) => MUSIC_GROUP_TYPES.has(id))) return true;
  if (!types.includes('Q5')) return false;
  return claimValues(entity, 'P106').some((value) => MUSIC_OCCUPATIONS.has(value?.id)) ||
    claimValues(entity, 'P434').some((value) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value));
}

function entityNames(entity: JsonObject): string[] {
  const names: string[] = [];
  for (const language of ['en', 'mul']) {
    const label = entity.labels?.[language]?.value;
    if (typeof label === 'string' && label.length <= 200 && !INVALID_CHARACTERS.test(label)) names.push(label);
  }
  for (const language of ['en', 'mul']) {
    const aliases = entity.aliases?.[language];
    if (Array.isArray(aliases)) {
      for (const alias of aliases.slice(0, 100)) {
        if (typeof alias?.value === 'string' && alias.value.length <= 200 && !INVALID_CHARACTERS.test(alias.value)) names.push(alias.value);
      }
    }
  }
  return names;
}

function exactEntityName(entity: JsonObject, names: string[]): boolean {
  const keys = new Set(names.map(normalizeArtistKey));
  return entityNames(entity).some((name) => keys.has(normalizeArtistKey(name)));
}

/* Search also returns albums, discographies and partial-name matches. Inspect
   a bounded result page, then fetch full entities only for exact search hints.
   Hints merely shortlist: the entity's own names and music claims decide. */
function exactSearchName(candidate: JsonObject, key: string): boolean {
  const names = [candidate?.label, candidate?.display?.label?.value, candidate?.match?.text,
    ...(Array.isArray(candidate?.aliases) ? candidate.aliases : [])];
  return names.some((name) => typeof name === 'string' && name.length <= 200 && normalizeArtistKey(name) === key);
}

async function entities(client: WikimediaClient, ids: string[]): Promise<Record<string, JsonObject>> {
  const result = await client.json(actionUrl('www.wikidata.org', {
    action: 'wbgetentities', ids: ids.join('|'),
    props: 'info|labels|descriptions|aliases|claims|sitelinks', languages: 'en|mul', sitefilter: 'enwiki',
  }, client.interactive), 1_500_000);
  if (!result?.entities || typeof result.entities !== 'object' || Array.isArray(result.entities)) throw new ProviderRetry();
  const found: Record<string, JsonObject> = Object.create(null);
  for (const id of ids) {
    const entity = result.entities[id];
    if (!entity || typeof entity !== 'object') throw new ProviderRetry();
    if (entity.missing !== undefined) continue;
    if (entity.id !== id || entity.type !== 'item') throw new ProviderRetry();
    found[id] = entity;
  }
  return found;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', copy: '©',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const decoded = value.slice(0, 20_000).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return HTML_ENTITIES[code.toLowerCase()] ?? whole;
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
  return decoded.replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function excerpt(value: string, maximum: number): { text: string; shortened: boolean } {
  if (value.length <= maximum) return { text: value, shortened: false };
  let text = value.slice(0, maximum - 1);
  const space = text.lastIndexOf(' ');
  if (space >= maximum - 100) text = text.slice(0, space);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return { text: text.trimEnd() + '…', shortened: true };
}

function safeUrl(value: unknown, hosts: string[]): URL | null {
  if (typeof value !== 'string' || value.length > URL_LIMIT || INVALID_CHARACTERS.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname) && !url.hash ? url : null;
  } catch { return null; }
}

function licensedCredit(metadata: JsonObject): Pick<ArtistMetadataCredit, 'license' | 'licenseUrl'> | null {
  const license = plainText(metadata.LicenseShortName?.value);
  const url = safeUrl(metadata.LicenseUrl?.value, ['creativecommons.org']);
  if (!url || url.search) return null;
  const match = /^CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0)$/i.exec(license);
  if (match) {
    const kind = match[1] ? 'by-sa' : 'by';
    const expected = `/licenses/${kind}/${match[2]}`;
    if (url.pathname.replace(/\/$/, '') !== expected) return null;
    return { license: `CC BY${match[1] ? '-SA' : ''} ${match[2]}`, licenseUrl: `https://creativecommons.org${expected}/` };
  }
  if (/^CC0(?: 1\.0)?$/i.test(license) && url.pathname.replace(/\/$/, '') === '/publicdomain/zero/1.0') {
    return { license: 'CC0 1.0', licenseUrl: CC0_URL };
  }
  if (/^Public domain$/i.test(license) && url.pathname.replace(/\/$/, '') === '/publicdomain/mark/1.0') {
    return { license: 'Public domain', licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/' };
  }
  return null;
}

function imageFilename(entity: JsonObject): string | null {
  const claims = entity.claims?.P18;
  if (!Array.isArray(claims)) return null;
  const candidates = claims.filter((claim) => claim?.rank !== 'deprecated' && claim?.mainsnak?.snaktype === 'value')
    .map((claim) => ({ rank: claim.rank === 'preferred' ? 0 : 1, file: claim.mainsnak?.datavalue?.value }))
    .filter((candidate) => typeof candidate.file === 'string' && candidate.file.length <= 512 && candidate.file.trim() &&
      !INVALID_CHARACTERS.test(candidate.file) && !/^File:/i.test(candidate.file) && /\.(?:jpe?g|png|webp)$/i.test(candidate.file));
  candidates.sort((a, b) => a.rank - b.rank || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return candidates[0]?.file || null;
}

function sameFile(a: string, b: string): boolean {
  return a.normalize('NFC').replace(/_/g, ' ') === b.normalize('NFC').replace(/_/g, ' ');
}

async function commonsImage(client: WikimediaClient, file: string): Promise<{ img: string; imageCredit: ArtistMetadataCredit } | null> {
  const result = await client.json(actionUrl('commons.wikimedia.org', {
    action: 'query', formatversion: '2', prop: 'imageinfo', titles: 'File:' + file,
    iiprop: 'url|size|mime|sha1|timestamp|extmetadata', iiurlwidth: '512', iiextmetadatalanguage: 'en',
    iiextmetadatafilter: 'Artist|Attribution|LicenseShortName|LicenseUrl|AttributionRequired|Restrictions',
  }, client.interactive), 100_000);
  if (!Array.isArray(result?.query?.pages)) throw new ProviderRetry();
  const page = result.query.pages.find((entry: JsonObject) => typeof entry?.title === 'string' && sameFile(entry.title, 'File:' + file));
  if (!page || page.missing !== undefined) return null;
  const info = page.imageinfo?.[0];
  if (!info || !['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)) return null;
  const img = safeUrl(info.thumburl || info.url, ['thumb.wikimedia.org', 'upload.wikimedia.org']);
  const source = safeUrl(info.descriptionurl, ['commons.wikimedia.org']);
  if (!img || !img.pathname.startsWith('/wikipedia/commons/') || !source || source.search) return null;
  try {
    if (!sameFile(decodeURIComponent(source.pathname), '/wiki/File:' + file)) return null;
  } catch { return null; }
  const metadata = info.extmetadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const license = licensedCredit(metadata);
  if (!license) return null;
  const author = plainText(metadata.Attribution?.value) || plainText(metadata.Artist?.value);
  const attributionRequired = license.license!.startsWith('CC BY') || /^true$/i.test(plainText(metadata.AttributionRequired?.value));
  if (author.length > AUTHOR_LIMIT || (attributionRequired && (!author || /^(?:unknown|own work|wikimedia commons)$/i.test(author)))) return null;
  const restrictions = plainText(metadata.Restrictions?.value).toLowerCase();
  if (restrictions && restrictions !== 'personality') return null;
  const title = excerpt(file, 220).text + (restrictions ? ' (personality rights may apply)' : '');
  return { img: img.href, imageCredit: { title, url: source.href, ...(author ? { author } : {}), ...license } };
}

async function wikipediaIntro(client: WikimediaClient, entity: JsonObject): Promise<{ bio: string; bioCredit: ArtistMetadataCredit } | null> {
  const title = entity.sitelinks?.enwiki?.title;
  if (typeof title !== 'string' || !title || title.length > 512 || INVALID_CHARACTERS.test(title)) return null;
  const encoded = encodeURIComponent(title.replace(/ /g, '_')).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  const summary = await client.json(new URL('https://en.wikipedia.org/api/rest_v1/page/summary/' + encoded), 100_000, true);
  if (!summary || summary.type !== 'standard' || summary.wikibase_item !== entity.id) return null;
  const text = plainText(summary.extract);
  if (!text) return null;
  const source = summary.content_urls?.desktop?.page === undefined
    ? new URL('https://en.wikipedia.org/wiki/' + encoded)
    : safeUrl(summary.content_urls.desktop.page, ['en.wikipedia.org']);
  if (!source || !source.pathname.startsWith('/wiki/') || source.search) return null;
  const intro = excerpt(text, INTRO_LIMIT);
  return { bio: intro.text, bioCredit: {
    title: `${excerpt(plainText(summary.title) || title, 200).text} — Wikipedia introduction${intro.shortened ? ' (excerpt)' : ''}`,
    url: source.href, author: 'Wikipedia contributors', license: 'CC BY-SA 4.0', licenseUrl: WIKIPEDIA_LICENSE_URL,
  } };
}

export async function fetchArtistMetadata(
  name: string, options: ArtistMetadataProviderOptions = {},
): Promise<ArtistMetadataResponse> {
  const key = normalizeArtistKey(name);
  if (!validArtistMetadataName(name)) return { key, status: 'not-found' };
  const client = new WikimediaClient(options);
  try {
    let entity: JsonObject;
    const binding = BINDINGS.find((entry) => entry.names.some((bound) => normalizeArtistKey(bound) === key));
    if (binding) {
      entity = (await entities(client, [binding.id]))[binding.id];
      if (!entity) return { key, status: 'not-found' };
      if (!isMusicEntity(entity) || !exactEntityName(entity, binding.names)) return { key, status: 'ambiguous' };
    } else {
      const search = await client.json(actionUrl('www.wikidata.org', {
        action: 'wbsearchentities', search: name.trim(), language: 'en', uselang: 'en', type: 'item', limit: String(SEARCH_LIMIT),
      }, client.interactive), 128_000);
      if (!Array.isArray(search?.search)) throw new ProviderRetry();
      const ids: string[] = [...new Set<string>(search.search.slice(0, SEARCH_LIMIT)
        .filter((candidate: JsonObject) => exactSearchName(candidate, key)).map((candidate: JsonObject) => candidate?.id)
        .filter((id: unknown) => typeof id === 'string' && QID.test(id)))];
      const truncated = search['search-continue'] !== undefined || search.search.length > SEARCH_LIMIT;
      if (ids.length > ENTITY_LIMIT || truncated) return { key, status: 'ambiguous' };
      if (!ids.length) return { key, status: 'not-found' };
      const found = await entities(client, ids);
      const candidates = ids.map((id) => found[id]).filter((candidate) => candidate && isMusicEntity(candidate) && exactEntityName(candidate, [name]));
      if (candidates.length > 1) return { key, status: 'ambiguous' };
      if (!candidates.length) return { key, status: 'not-found' };
      entity = candidates[0];
    }
    const description = excerpt(plainText(entity.descriptions?.en?.value), BIO_LIMIT).text;
    const profile: Partial<AutomaticArtistMetadata> = {
      name: entityNames(entity)[0] || name.trim(), entityId: entity.id,
      ...(description ? { bio: description, bioCredit: {
        title: 'Wikidata description', url: 'https://www.wikidata.org/wiki/' + entity.id,
        author: 'Wikidata contributors', license: 'CC0 1.0', licenseUrl: CC0_URL,
      } } : {}),
    };
    let retryAfter: number | undefined;
    try {
      const file = imageFilename(entity);
      if (file) Object.assign(profile, await commonsImage(client, file));
      Object.assign(profile, await wikipediaIntro(client, entity));
    } catch (error) {
      /* Stop outgoing work after a temporary provider failure. Initial partial
         successes are usable; the store retains an older complete snapshot on
         refresh failures and schedules a backoff rather than a false negative. */
      retryAfter = error instanceof ProviderRetry ? error.retryAfter : 60;
    }
    if (!profile.img && !profile.bio) return retryAfter ? { key, status: 'retry', retryAfter } : { key, status: 'not-found' };
    const fetchedAt = client.now();
    return { key, status: 'ready', metadata: {
      ...profile, fetchedAt, expiresAt: fetchedAt + ARTIST_METADATA_POSITIVE_TTL,
    } as AutomaticArtistMetadata, ...(retryAfter ? { retryAfter } : {}) };
  } catch (error) {
    return { key, status: 'retry', retryAfter: error instanceof ProviderRetry ? error.retryAfter : 60 };
  } finally { client.close(); }
}
