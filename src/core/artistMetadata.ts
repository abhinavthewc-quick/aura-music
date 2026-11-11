/* Automatic metadata is a display cache, never an artist directory. Nothing
   here starts a request on import; the listening/admin gate starts the queue. */
import { normalizeArtistKey, type ArtistProfile } from '../../lib/artistProfiles';
import {
  composeArtistMetadata, type ArtistMetadataCredit, type ArtistMetadataResponse,
  type AutomaticArtistMetadata, type DisplayArtistProfile,
} from '../../lib/artistMetadata';
import { getSession, SESSION_KEY, type AuraSession } from './session';

export const ARTIST_METADATA_CACHE_KEY = 'auraAutomaticArtistMetadata_v1';
export const ARTIST_METADATA_UPDATED_EVENT = 'aura:artist-metadata-updated';
export const DEFAULT_ARTIST_PORTRAIT = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#121212"/><circle cx="100" cy="73" r="29" fill="#454545"/><path d="M43 165v-13a57 47 0 0 1 114 0v13" fill="#454545"/></svg>'
);

const MAX_NAME = 200;
const MAX_BIO = 2000;
const MAX_URL = 2048;
const MAX_ENTRIES = 320;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024;
const MAX_PENDING = 32;
const MAX_CATALOG = 384;
const CONCURRENCY = 2;
const IDLE_BATCH = 4;
const BATCH_GAP = 1500;
const NEGATIVE_TTL = 24 * 3600 * 1000;
const RETRY_BASE = 30 * 1000;
const RETRY_COOLDOWN = 3600 * 1000;
const MAX_FAILURES = 3;
const MAX_RETRY_SECONDS = 30 * 24 * 3600;
const REQUEST_TIMEOUT = 25000; // The API's overall deadline is 20 seconds.
const encoder = new TextEncoder();

const withinByteLimit = (value: string, limit: number) =>
  value.length <= limit && encoder.encode(value).byteLength <= limit;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, multiline = false): value is string {
  return typeof value === 'string' && value.length <= max &&
    !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value);
}
function canonicalName(value: unknown): string {
  if (!text(value, MAX_NAME)) return '';
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return name.length <= MAX_NAME && normalizeArtistKey(name) !== 'unknown artist' ? name : '';
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Attribution is always HTTPS. Portraits may also use our own image route;
 *  arbitrary relative URLs, credentials, redirects and active schemes are not
 *  accepted from either localStorage or the public lookup response. */
export function safeArtistMetadataUrl(value: unknown, image = false): string | undefined {
  if (!text(value, MAX_URL) || !value || /\s|[\\<>"]/.test(value)) return undefined;
  if (image && /^\/api\/artist-image\?[^#]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href;
  } catch { /* optional source data */ }
  return undefined;
}

function validateCredit(value: unknown): ArtistMetadataCredit | undefined {
  if (!record(value) || !text(value.title, 256) || !value.title.trim()) return undefined;
  const url = safeArtistMetadataUrl(value.url);
  if (!url || value.author !== undefined && !text(value.author, 256) ||
    value.license !== undefined && !text(value.license, 160)) return undefined;
  const licenseUrl = value.licenseUrl === undefined ? undefined : safeArtistMetadataUrl(value.licenseUrl);
  if (value.licenseUrl !== undefined && !licenseUrl) return undefined;
  return { title: value.title.trim(), url,
    ...(typeof value.author === 'string' && value.author.trim() ? { author: value.author.trim() } : {}),
    ...(typeof value.license === 'string' && value.license.trim() ? { license: value.license.trim() } : {}),
    ...(licenseUrl ? { licenseUrl } : {}) };
}

export function validateAutomaticArtistMetadata(value: unknown, now = Date.now()): AutomaticArtistMetadata | undefined {
  if (!record(value) || !canonicalName(value.name) || !text(value.entityId, 128) ||
    !/^[A-Za-z0-9._:-]+$/.test(value.entityId) || !timestamp(value.fetchedAt) || !timestamp(value.expiresAt) ||
    value.fetchedAt > now + 300000 || value.expiresAt < value.fetchedAt) return undefined;
  if (value.img !== undefined && (!text(value.img, MAX_URL) || value.img && !safeArtistMetadataUrl(value.img, true)) ||
    value.bio !== undefined && !text(value.bio, MAX_BIO, true)) return undefined;
  const imageCredit = value.imageCredit === undefined ? undefined : validateCredit(value.imageCredit);
  const bioCredit = value.bioCredit === undefined ? undefined : validateCredit(value.bioCredit);
  if (value.imageCredit !== undefined && !imageCredit || value.bioCredit !== undefined && !bioCredit) return undefined;
  return { name: canonicalName(value.name), entityId: value.entityId,
    ...(value.img ? { img: safeArtistMetadataUrl(value.img, true) } : {}),
    ...(typeof value.bio === 'string' && value.bio.trim() ? { bio: value.bio.trim() } : {}),
    ...(imageCredit ? { imageCredit } : {}), ...(bioCredit ? { bioCredit } : {}),
    fetchedAt: value.fetchedAt, expiresAt: value.expiresAt };
}

export function validateArtistMetadataResponse(value: unknown, expectedKey: string, now = Date.now()): ArtistMetadataResponse | undefined {
  if (!record(value) || !canonicalName(expectedKey) || value.key !== expectedKey || normalizeArtistKey(expectedKey) !== expectedKey ||
    typeof value.status !== 'string' || !['ready', 'not-found', 'ambiguous', 'retry'].includes(value.status)) return undefined;
  if (value.retryAfter !== undefined && (typeof value.retryAfter !== 'number' || !Number.isFinite(value.retryAfter) ||
    value.retryAfter < 0 || value.retryAfter > MAX_RETRY_SECONDS)) return undefined;
  const metadata = value.metadata === undefined ? undefined : validateAutomaticArtistMetadata(value.metadata, now);
  if (value.status === 'ready' ? !metadata : value.metadata !== undefined) return undefined;
  return { key: expectedKey, status: value.status as ArtistMetadataResponse['status'],
    ...(metadata ? { metadata } : {}), ...(typeof value.retryAfter === 'number' ? { retryAfter: value.retryAfter } : {}) };
}

interface CacheEntry {
  key: string;
  name: string;
  status: ArtistMetadataResponse['status'];
  /* An unavailable refresh retains a previously verified result. A definitive
     negative/ambiguous match must return to a neutral display. */
  metadata?: AutomaticArtistMetadata;
  checkedAt: number;
  nextRequestAt: number;
  usedAt: number;
  failures: number;
}
type Work = { key: string; name: string; priority: number; order: number };
type ActiveWork = { controller: AbortController; work: Work };
type SessionHint = Pick<AuraSession, 'email' | 'token'>;
export interface ArtistMetadataClientOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  fetch?: typeof fetch;
  session?: () => SessionHint | null;
  visible?: () => boolean;
  online?: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  idle?: (callback: () => void) => unknown;
  cancelIdle?: (handle: unknown) => void;
  emit?: (keys: string[], displayChanged: boolean) => void;
}

/** Dependency injection keeps queue/cache regressions deterministic and avoids
 *  importing the music store into the admin page or the identity resolver. */
export function createArtistMetadataClient(options: ArtistMetadataClientOptions = {}) {
  let storage = options.storage;
  if (!storage) { try { storage = localStorage; } catch { /* private mode */ } }
  const now = options.now || Date.now;
  const session = options.session || getSession;
  const visible = options.visible || (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const online = options.online || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Work>();
  const inFlight = new Map<string, ActiveWork>();
  let loaded = false, enabled = false, generation = 0, revision = 0, order = 0;
  let canRequest = () => true;
  let catalog: { key: string; name: string }[] = [], cursor = 0, backgroundAt = 0;
  let timer: unknown, timerAt = Infinity, idle: unknown;

  function loadCache(): Map<string, CacheEntry> {
    const result = new Map<string, CacheEntry>();
    try {
      const raw = storage?.getItem(ARTIST_METADATA_CACHE_KEY);
      if (!raw || !withinByteLimit(raw, MAX_CACHE_BYTES)) return result;
      const saved: unknown = JSON.parse(raw);
      if (!record(saved) || saved.v !== 1 || !Array.isArray(saved.entries)) return result;
      for (const entry of saved.entries.slice(0, MAX_ENTRIES)) {
        if (!record(entry)) continue;
        const name = canonicalName(entry.name), key = normalizeArtistKey(name);
        if (!name || entry.key !== key || !timestamp(entry.checkedAt) || entry.checkedAt > now() + 300000 ||
          !timestamp(entry.nextRequestAt) || entry.nextRequestAt > now() + MAX_RETRY_SECONDS * 1000 ||
          !timestamp(entry.usedAt) || entry.usedAt > now() + 300000 || typeof entry.failures !== 'number' || !Number.isInteger(entry.failures) ||
          Number(entry.failures) < 0 || Number(entry.failures) > MAX_FAILURES ||
          typeof entry.status !== 'string' || !['ready', 'not-found', 'ambiguous', 'retry'].includes(entry.status)) continue;
        const metadata = entry.metadata === undefined ? undefined : validateAutomaticArtistMetadata(entry.metadata, now());
        if (entry.metadata !== undefined && !metadata || entry.status === 'ready' && !metadata) continue;
        const current = result.get(key);
        if (!current || entry.checkedAt > current.checkedAt) result.set(key, {
          key, name, status: entry.status as CacheEntry['status'],
          metadata: entry.status === 'ready' || entry.status === 'retry' ? metadata : undefined,
          checkedAt: entry.checkedAt, nextRequestAt: entry.nextRequestAt, usedAt: entry.usedAt,
          failures: Number(entry.failures),
        });
      }
    } catch { /* malformed/unavailable storage never prevents the library paint */ }
    return result;
  }
  function ensureCache() {
    if (loaded) return;
    loaded = true;
    for (const [key, entry] of loadCache()) entries.set(key, entry);
    if ([...entries.values()].some(entry => entry.metadata?.img || entry.metadata?.bio)) revision++;
  }
  function boundCache() {
    const sorted = [...entries.values()].sort((a, b) => b.usedAt - a.usedAt || b.checkedAt - a.checkedAt).slice(0, MAX_ENTRIES);
    let raw = JSON.stringify({ v: 1, entries: sorted });
    while (!withinByteLimit(raw, MAX_CACHE_BYTES) && sorted.length) {
      sorted.pop();
      raw = JSON.stringify({ v: 1, entries: sorted });
    }
    const keep = new Set(sorted.map(entry => entry.key));
    for (const key of entries.keys()) if (!keep.has(key)) entries.delete(key);
    return raw;
  }
  function persistCache() {
    const raw = boundCache();
    try { storage?.setItem(ARTIST_METADATA_CACHE_KEY, raw); } catch { /* bounded in-memory cache still works */ }
  }
  const displaySnapshot = () => new Map([...entries].map(([key, entry]) => [key, entry.metadata]));
  const displaySignature = (metadata?: AutomaticArtistMetadata) => JSON.stringify({
    img: metadata?.img, bio: metadata?.bio,
    imageCredit: metadata?.img ? metadata.imageCredit : undefined,
    bioCredit: metadata?.bio ? metadata.bioCredit : undefined,
  });
  function reportChanges(before: ReturnType<typeof displaySnapshot>, touched: string[]) {
    const keys = [...new Set([...before.keys(), ...entries.keys()])].filter(key =>
      displaySignature(before.get(key)) !== displaySignature(entries.get(key)?.metadata));
    if (keys.length) { revision++; options.emit?.(keys, true); }
    const statusOnly = touched.filter(key => !keys.includes(key));
    if (statusOnly.length) options.emit?.(statusOnly, false);
  }
  function allowed(): SessionHint | null {
    if (!enabled || !visible() || !online() || !canRequest()) return null;
    return session();
  }
  function clearScheduled() {
    if (timer !== undefined) cancel(timer);
    if (idle !== undefined) options.cancelIdle?.(idle);
    timer = idle = undefined;
    timerAt = Infinity;
  }
  function wake(delay = 0) {
    if (!allowed()) { clearScheduled(); return; }
    const at = now() + Math.max(0, delay);
    if (timer !== undefined && timerAt <= at) return;
    clearScheduled();
    timerAt = at;
    const scheduledGeneration = generation;
    timer = schedule(() => {
      timer = undefined; timerAt = Infinity;
      if (scheduledGeneration !== generation || !allowed()) return;
      const foreground = [...pending.values()].some(work => work.priority < 2 && (entries.get(work.key)?.nextRequestAt || 0) <= now());
      if (!foreground && options.idle) {
        idle = options.idle(() => { idle = undefined; if (scheduledGeneration === generation) pump(); });
      } else pump();
    }, Math.max(0, at - now()));
  }
  function enqueue(nameValue: string, priority: number) {
    const name = canonicalName(nameValue);
    if (!name) return;
    ensureCache();
    const key = normalizeArtistKey(name), entry = entries.get(key);
    const active = inFlight.get(key);
    if (active) { active.work.priority = Math.min(priority, active.work.priority); return; }
    if (entry && entry.status !== 'retry' && entry.nextRequestAt > now()) return;
    const previous = pending.get(key);
    if (previous) { previous.priority = Math.min(priority, previous.priority); return; }
    if (pending.size >= MAX_PENDING) {
      const last = [...pending.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)[0];
      if (!last || last.priority <= priority) return;
      pending.delete(last.key);
    }
    pending.set(key, { key, name, priority, order: order++ });
  }
  function nextWake() {
    if (inFlight.size >= CONCURRENCY) return;
    let next = Infinity;
    for (const work of pending.values()) {
      const due = entries.get(work.key)?.nextRequestAt || 0;
      next = Math.min(next, Math.max(due, work.priority === 2 ? backgroundAt : 0));
    }
    if (cursor < catalog.length && pending.size < IDLE_BATCH) next = Math.min(next, backgroundAt);
    if (next < Infinity) wake(Math.max(0, next - now()));
  }
  function retrySeconds(response: Response): number {
    const raw = response.headers.get('Retry-After');
    if (!raw) return 0;
    const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - now()) / 1000;
    return Number.isFinite(seconds) ? Math.min(MAX_RETRY_SECONDS, Math.max(0, Math.ceil(seconds))) : 0;
  }
  async function run(work: Work, owner: SessionHint) {
    const controller = new AbortController(), requestGeneration = generation, startedAt = now();
    const openedCacheEntry = entries.get(work.key);
    inFlight.set(work.key, { controller, work });
    const timeout = schedule(() => controller.abort(), REQUEST_TIMEOUT);
    let response: ArtistMetadataResponse = { key: work.key, status: 'retry' };
    let retry = false;
    try {
      // Public, same-origin GET. Session credentials are deliberately not sent
      // to the metadata provider, and redirects cannot become provider calls.
      const fetched = await (options.fetch || fetch)('/api/artist-metadata?name=' + encodeURIComponent(work.name), {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal: controller.signal,
        ...(work.priority === 0 ? { headers: { 'X-Aura-Artist-Intent': 'view' } } : {}),
      });
      const retryAfter = retrySeconds(fetched);
      if (retryAfter) response.retryAfter = retryAfter;
      if (fetched.ok) {
        const raw = await fetched.text();
        const validated = withinByteLimit(raw, MAX_RESPONSE_BYTES)
          ? validateArtistMetadataResponse(JSON.parse(raw), work.key, now()) : undefined;
        if (validated) response = validated;
      }
      if (retryAfter) response.retryAfter = Math.max(response.retryAfter || 0, retryAfter);
    } catch { /* network, malformed data and provider limits all back off */ }
    finally { cancel(timeout); }
    try {
      const currentSession = session();
      if (requestGeneration !== generation || !enabled || !canRequest() ||
        !currentSession || currentSession.email !== owner.email || currentSession.token !== owner.token) {
        retry = requestGeneration === generation && enabled;
        return;
      }
      if (controller.signal.aborted) response = { key: work.key, status: 'retry' };
      const previous = entries.get(work.key), checkedAt = now();
      // A newer cross-tab result wins over a response that started earlier.
      if ((previous !== openedCacheEntry && previous?.checkedAt >= startedAt) || (response.metadata && previous?.metadata &&
        response.metadata.fetchedAt < previous.metadata.fetchedAt)) return;
      // The API can return a stale success with Retry-After while its provider
      // is unavailable. Keep displaying it, but use the same bounded retry cycle.
      const retrying = response.status === 'retry' || response.status === 'ready' &&
        ((response.retryAfter || 0) > 0 || response.metadata!.expiresAt <= checkedAt);
      const status = retrying ? 'retry' : response.status;
      const failures = retrying ? Math.min(MAX_FAILURES, (previous?.failures || 0) + 1) : 0;
      const wait = retrying
        ? Math.max((response.retryAfter || 0) * 1000, RETRY_BASE * 2 ** (failures - 1), failures >= MAX_FAILURES ? RETRY_COOLDOWN : 0)
        : response.status === 'ready' ? Math.max(BATCH_GAP, Math.min(MAX_RETRY_SECONDS * 1000, response.metadata!.expiresAt - checkedAt))
          : Math.max(NEGATIVE_TTL, (response.retryAfter || 0) * 1000);
      const metadata = response.metadata || (retrying ? previous?.metadata : undefined);
      const before = displaySnapshot();
      entries.set(work.key, { key: work.key, name: work.name, status, metadata,
        checkedAt, nextRequestAt: checkedAt + wait, usedAt: checkedAt, failures });
      persistCache();
      reportChanges(before, [work.key]);
      retry = retrying && failures < MAX_FAILURES;
    } finally {
      if (inFlight.get(work.key)?.controller === controller) inFlight.delete(work.key);
      if (retry) enqueue(work.name, work.priority);
      nextWake();
    }
  }
  function pump() {
    // Check the live session before EACH scheduled request, including retries.
    if (!allowed()) return;
    if (backgroundAt <= now() && pending.size < IDLE_BATCH) {
      for (let count = 0; count < IDLE_BATCH && cursor < catalog.length; count++) enqueue(catalog[cursor++].name, 2);
    }
    const candidates = [...pending.values()].sort((a, b) => a.priority - b.priority || a.order - b.order);
    let backgroundStarted = false;
    for (const work of candidates) {
      if (inFlight.size >= CONCURRENCY) break;
      if ((entries.get(work.key)?.nextRequestAt || 0) > now() || work.priority === 2 && backgroundAt > now()) continue;
      const owner = allowed();
      if (!owner) break;
      // The cooldown after a bounded retry cycle permits a later new cycle.
      const entry = entries.get(work.key);
      if (entry?.failures === MAX_FAILURES) entry.failures = 0;
      pending.delete(work.key);
      if (work.priority === 2) backgroundStarted = true;
      void run(work, owner);
    }
    if (backgroundStarted) backgroundAt = now() + BATCH_GAP;
    nextWake();
  }

  return {
    start(gate: () => boolean = () => true) { ensureCache(); canRequest = gate; enabled = true; wake(); },
    stop() {
      enabled = false; generation++; clearScheduled();
      const paused = [...inFlight.values()];
      for (const { controller } of paused) controller.abort();
      inFlight.clear();
      for (const { work } of paused) enqueue(work.name, work.priority);
    },
    wake,
    prioritize(names: Iterable<string> | string, priority: 'open' | 'visible' = 'visible') {
      let count = 0;
      for (const name of typeof names === 'string' ? [names] : names) {
        enqueue(name, priority === 'open' ? 0 : 1);
        if (++count >= MAX_PENDING) break;
      }
      wake();
    },
    setCatalog(names: Iterable<string>) {
      const unique = new Map<string, string>();
      for (const value of names) {
        const name = canonicalName(value);
        if (name) unique.set(normalizeArtistKey(name), name);
        if (unique.size >= MAX_CATALOG) break;
      }
      const next = [...unique].map(([key, name]) => ({ key, name }));
      if (JSON.stringify(next) === JSON.stringify(catalog)) return;
      catalog = next; cursor = 0; wake(BATCH_GAP);
    },
    getMetadata(name: string) {
      ensureCache();
      const entry = entries.get(normalizeArtistKey(canonicalName(name)));
      if (entry) entry.usedAt = now();
      return entry?.metadata;
    },
    getResponse(name: string): ArtistMetadataResponse | undefined {
      ensureCache();
      const entry = entries.get(normalizeArtistKey(canonicalName(name)));
      return entry ? { key: entry.key, status: entry.status, metadata: entry.metadata,
        ...(entry.status === 'retry' ? { retryAfter: Math.max(0, Math.ceil((entry.nextRequestAt - now()) / 1000)) } : {}) } : undefined;
    },
    getRevision() { ensureCache(); return revision; },
    reloadCache() {
      ensureCache();
      const before = displaySnapshot(), touched: string[] = [];
      for (const [key, entry] of loadCache()) {
        const previous = entries.get(key);
        if (previous && previous.checkedAt >= entry.checkedAt) continue;
        if (previous?.metadata && (entry.status === 'retry' && !entry.metadata ||
          entry.metadata && entry.metadata.fetchedAt < previous.metadata.fetchedAt)) {
          entry.metadata = previous.metadata;
          if (entry.status === 'ready') entry.nextRequestAt = Math.max(entry.nextRequestAt,
            Math.min(now() + MAX_RETRY_SECONDS * 1000, previous.metadata.expiresAt));
        }
        entries.set(key, entry);
        touched.push(key);
      }
      // Cross-tab merging is bounded too, but does not write back and cause a
      // storage-event feedback loop between tabs with different visible artists.
      boundCache();
      reportChanges(before, touched);
      wake();
    },
  };
}

type Client = ReturnType<typeof createArtistMetadataClient>;
let client: Client | undefined;
function automaticClient(): Client {
  return client || (client = createArtistMetadataClient({
    idle: typeof window !== 'undefined' && window.requestIdleCallback ? callback => window.requestIdleCallback(callback, { timeout: 2000 }) : undefined,
    cancelIdle: typeof window !== 'undefined' && window.cancelIdleCallback ? handle => window.cancelIdleCallback(handle as number) : undefined,
    emit: (keys, displayChanged) => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ARTIST_METADATA_UPDATED_EVENT,
        { detail: { keys, revision: client?.getRevision() || 0, displayChanged } }));
    },
  }));
}
export const getAutomaticArtistMetadata = (name: string) => automaticClient().getMetadata(name);
export const getArtistMetadataResponse = (name: string) => automaticClient().getResponse(name);
export const getArtistMetadataRevision = () => automaticClient().getRevision();
export function getDisplayArtistProfile(name: string, profile?: ArtistProfile): DisplayArtistProfile | undefined {
  return composeArtistMetadata(profile, getAutomaticArtistMetadata(name)) || undefined;
}
export function prioritizeArtistMetadata(names: Iterable<string> | string, priority: 'open' | 'visible' = 'visible') {
  automaticClient().prioritize(names, priority);
}
export function setArtistMetadataCatalog(names: Iterable<string>) { automaticClient().setCatalog(names); }

let listening = false;
let cardsObserver: IntersectionObserver | undefined;
const observedCards = new Set<Element>();
/** Observe a whole rendered rail/grid at once; card HTML never fetches. */
export function observeArtistMetadataCards(container: ParentNode) {
  if (!listening || typeof IntersectionObserver === 'undefined') return;
  if (!cardsObserver) cardsObserver = new IntersectionObserver(entries => {
    const names = entries.filter(entry => entry.isIntersecting)
      .map(entry => (entry.target as HTMLElement).dataset.artistMetadataName || '').filter(Boolean);
    if (names.length) prioritizeArtistMetadata(names.slice(0, 8));
  });
  for (const element of observedCards) if (!element.isConnected) { cardsObserver.unobserve(element); observedCards.delete(element); }
  for (const element of container.querySelectorAll('[data-artist-metadata-name]')) {
    if (!observedCards.has(element)) { observedCards.add(element); cardsObserver.observe(element); }
  }
}
export function startArtistMetadata(options: { canRequest?: () => boolean; catalog?: Iterable<string> } = {}) {
  if (!getSession() || options.canRequest && !options.canRequest()) return;
  const current = automaticClient();
  current.start(options.canRequest);
  if (options.catalog) current.setCatalog(options.catalog);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    const resume = () => current.wake();
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', resume);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('storage', event => {
      if (event.key === ARTIST_METADATA_CACHE_KEY) current.reloadCache();
      if (event.key === SESSION_KEY || event.key === null) {
        if (!getSession()) current.stop(); else current.wake();
      }
    });
    observeArtistMetadataCards(document);
  }
}
export function stopArtistMetadata() { client?.stop(); }

/** Update only the portrait, retaining its surrounding button and focus. A
 * failed URL is not retried on every unrelated metadata repaint. */
export function setArtistPortraitSource(image: HTMLImageElement, source = DEFAULT_ARTIST_PORTRAIT) {
  if (image.dataset.artistPortraitSource === source) return;
  image.dataset.artistPortraitSource = source;
  if (image.getAttribute('src') === source) return;
  delete image.dataset.coverFallback;
  image.src = source;
}

let portraitFallbackInstalled = false;
export function installArtistPortraitFallback() {
  if (portraitFallbackInstalled || typeof document === 'undefined') return;
  portraitFallbackInstalled = true;
  document.addEventListener('error', event => {
    const image = event.target as HTMLImageElement;
    if (image?.tagName !== 'IMG' || !image.hasAttribute('data-artist-portrait')) return;
    image.dataset.artistPortraitSource ||= image.getAttribute('src') || DEFAULT_ARTIST_PORTRAIT;
    image.dataset.coverFallback = '1';
    if (image.getAttribute('src') !== DEFAULT_ARTIST_PORTRAIT) image.src = DEFAULT_ARTIST_PORTRAIT;
    const page = image.closest('.artist-page, #artistHeroCard, .adm-automatic-preview');
    page?.querySelector<HTMLElement>('[data-artist-credit="image"]')?.setAttribute('hidden', '');
  }, true);
}

const escapeCredit = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function artistMetadataCreditHTML(value: ArtistMetadataCredit | undefined, field: 'image' | 'bio'): string {
  const credit = validateCredit(value);
  if (!credit) return '';
  const link = (url: string, label: string) => `<a href="${escapeCredit(url)}" target="_blank" rel="noopener noreferrer">${escapeCredit(label)}</a>`;
  const label = field === 'image' ? 'Photo' : new URL(credit.url).hostname.endsWith('.wikipedia.org') ? 'Biography excerpt' : 'Biography';
  const license = credit.license ? ` (${credit.licenseUrl ? link(credit.licenseUrl, credit.license) : escapeCredit(credit.license)})` : '';
  return `<p class="artist-metadata-credit" data-artist-credit="${field}">${label}: ${link(credit.url, credit.title)}${credit.author ? ` by ${escapeCredit(credit.author)}` : ''}${license}${field === 'image' ? ' <span>Cropped to fit.</span>' : ''}</p>`;
}

export type ArtistMetadataDraft = { img: string; bio: string; imgOverride: boolean; bioOverride: boolean };
export function createArtistMetadataDraft(profile?: ArtistProfile): ArtistMetadataDraft {
  // Old managed snapshots without flags remain conservative until the fresh
  // directory supplies explicit intent. HF fallback text is not an override.
  const managed = typeof profile?.version === 'number' && Number.isInteger(profile.version) && profile.version > 0;
  return { img: typeof profile?.img === 'string' ? profile.img : '', bio: typeof profile?.bio === 'string' ? profile.bio : '',
    imgOverride: typeof profile?.imgOverride === 'boolean' ? profile.imgOverride : managed,
    bioOverride: typeof profile?.bioOverride === 'boolean' ? profile.bioOverride : managed };
}
export function editArtistMetadataDraft(draft: ArtistMetadataDraft, field: 'img' | 'bio', value: string) {
  draft[field] = value;
  draft[field === 'img' ? 'imgOverride' : 'bioOverride'] = true;
}
export function useAutomaticArtistMetadataDraft(draft: ArtistMetadataDraft, field: 'img' | 'bio') {
  draft[field === 'img' ? 'imgOverride' : 'bioOverride'] = false;
}
