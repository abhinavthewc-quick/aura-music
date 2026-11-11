import { normalizeArtistKey } from '../../lib/artistProfiles.js';
import type { ArtistMetadataResponse, AutomaticArtistMetadata, ArtistMetadataCredit } from '../../lib/artistMetadata.js';
import type { ArtistDatabase, ArtistEnv } from './artistStore.js';
import {
  ARTIST_METADATA_NEGATIVE_TTL, ARTIST_METADATA_POSITIVE_TTL, ARTIST_METADATA_PROVIDER_TIMEOUT,
  fetchArtistMetadata, validArtistMetadataName, type ArtistMetadataProviderOptions,
} from './artistMetadata.js';

export const ARTIST_METADATA_LOOKUP_INTERVAL = 2000;
export const ARTIST_METADATA_MAX_ACTIVE = 2;
export const ARTIST_METADATA_DAILY_BUDGET = 500;
export const ARTIST_METADATA_LEASE_MS = 30_000;
export const ARTIST_METADATA_LOOKUP_TIMEOUT = 18_000;
export const ARTIST_METADATA_REQUEST_TIMEOUT = 20_000;
export const ARTIST_METADATA_STORAGE_TIMEOUT = 2000;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_BACKOFF = 60;

interface CacheRow {
  artist_key: string;
  status: ArtistMetadataResponse['status'];
  metadata_json: string | null;
  fetched_at: number;
  expires_at: number;
  retry_at: number;
  failures: number;
  lease_token: string | null;
  lease_until: number;
  updated_at: number;
}
interface BudgetRow {
  day_start: number;
  jobs_started: number;
  next_lookup_at: number;
  blocked_until: number;
  active_jobs: number;
  next_lease_until: number | null;
}

export interface ArtistMetadataStoreOptions extends ArtistMetadataProviderOptions {
  provider?: typeof fetchArtistMetadata;
  token?: () => string;
  lookupTimeoutMs?: number;
  storageTimeoutMs?: number;
  deadlineMs?: number;
}
export interface ArtistMetadataStoreResult {
  response: ArtistMetadataResponse;
  /* Internal HTTP cache boundary, not a field in the public JSON contract. */
  cacheUntil?: number;
  unavailable?: boolean;
}

function database(env: ArtistEnv): ArtistDatabase {
  if (!env.ARTIST_DB) throw new Error('Artist metadata storage is unavailable.');
  return env.ARTIST_DB.withSession?.('first-primary') || env.ARTIST_DB;
}

function https(value: unknown, hosts: string[], prefix: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      hosts.includes(url.hostname) && url.pathname.startsWith(prefix);
  } catch { return false; }
}

function credit(value: unknown, image: boolean): value is ArtistMetadataCredit {
  if (!value || typeof value !== 'object') return false;
  const entry = value as ArtistMetadataCredit;
  const by = /^CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0)$/.exec(entry.license || '');
  const licenseUrl = by ? `https://creativecommons.org/licenses/${by[1] ? 'by-sa' : 'by'}/${by[2]}/` :
    entry.license === 'CC0 1.0' ? 'https://creativecommons.org/publicdomain/zero/1.0/' :
      entry.license === 'Public domain' ? 'https://creativecommons.org/publicdomain/mark/1.0/' : undefined;
  return typeof entry.title === 'string' && !!entry.title.trim() && entry.title.length <= 256 &&
    (entry.author === undefined || (typeof entry.author === 'string' && entry.author.length <= 256)) &&
    !!licenseUrl && entry.licenseUrl === licenseUrl &&
    (!by || typeof entry.author === 'string' && !!entry.author.trim()) &&
    (image ? https(entry.url, ['commons.wikimedia.org'], '/wiki/File:') :
      entry.license === 'CC0 1.0' ? https(entry.url, ['www.wikidata.org'], '/wiki/Q') :
        entry.license === 'CC BY-SA 4.0' && https(entry.url, ['en.wikipedia.org'], '/wiki/'));
}

/* Cache rows are provider-only, but corrupt/old payloads still must not escape
   to the browser as arbitrary media URLs or unattributed text. */
function validMetadata(value: unknown): value is AutomaticArtistMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as AutomaticArtistMetadata;
  return typeof metadata.name === 'string' && !!metadata.name && metadata.name.length <= 200 &&
    typeof metadata.entityId === 'string' && /^Q[1-9][0-9]{0,18}$/.test(metadata.entityId) &&
    Number.isSafeInteger(metadata.fetchedAt) && metadata.fetchedAt >= 0 &&
    Number.isSafeInteger(metadata.expiresAt) && metadata.expiresAt === metadata.fetchedAt + ARTIST_METADATA_POSITIVE_TTL &&
    !!(metadata.img || metadata.bio) &&
    (metadata.imageCredit === undefined || metadata.img !== undefined) &&
    (metadata.bioCredit === undefined || metadata.bio !== undefined) &&
    (metadata.img === undefined || (https(metadata.img, ['thumb.wikimedia.org', 'upload.wikimedia.org'], '/wikipedia/commons/') && credit(metadata.imageCredit, true))) &&
    (metadata.bio === undefined || (typeof metadata.bio === 'string' && !!metadata.bio && metadata.bio.length <= 1200 && credit(metadata.bioCredit, false)));
}

function metadata(row: CacheRow | null): AutomaticArtistMetadata | undefined {
  if (!row?.metadata_json || !['ready', 'retry'].includes(row.status)) return undefined;
  let value: unknown;
  try { value = JSON.parse(row.metadata_json); } catch { return undefined; }
  return validMetadata(value) ? value : undefined;
}

function seconds(until: number, now: number): number {
  return Math.max(2, Math.ceil((until - now) / 1000));
}

function available(row: CacheRow | null, key: string, now: number): ArtistMetadataStoreResult | undefined {
  if (!row) return undefined;
  const good = metadata(row);
  if (!row.retry_at && row.expires_at > now) {
    if (row.status === 'ready' && good) return { response: { key, status: 'ready', metadata: good }, cacheUntil: Math.min(row.expires_at, good.expiresAt) };
    if (row.status === 'not-found' || row.status === 'ambiguous') return { response: { key, status: row.status }, cacheUntil: row.expires_at };
  }
  const until = Math.max(row.retry_at, row.lease_token ? row.lease_until : 0);
  if (until > now) return {
    response: { key, status: good ? 'ready' : 'retry', ...(good ? { metadata: good } : {}), retryAfter: seconds(until, now) },
  };
  return undefined;
}

function retry(row: CacheRow | null, key: string, retryAfter: number, unavailable = false): ArtistMetadataStoreResult {
  const good = metadata(row);
  return { response: { key, status: good ? 'ready' : 'retry', ...(good ? { metadata: good } : {}), retryAfter },
    ...(unavailable && !good ? { unavailable: true } : {}) };
}

async function readRow(db: ArtistDatabase, key: string): Promise<CacheRow | null> {
  return db.prepare('SELECT * FROM artist_metadata_cache WHERE artist_key = ?').bind(key).first<CacheRow>();
}

function timeout(value: number | undefined, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : maximum;
}

/* D1 promises are not cancellable. Bound how long this request waits, attach
   handlers to any late settlement, and never continue a timed-out claim into
   provider work. A late transaction is still protected by its lease/token. */
function boundedStage<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const expired = () => { cleanup(); reject(new Error('Artist metadata operation timed out.')); };
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', expired); };
    const timer = setTimeout(expired, timeoutMs);
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) { expired(); return; }
    signal.addEventListener('abort', expired, { once: true });
  });
}

function denialDelay(row: CacheRow | null, budget: BudgetRow | undefined, now: number): number {
  let until = now + ARTIST_METADATA_LOOKUP_INTERVAL;
  if (row) until = Math.max(until, row.retry_at, row.lease_token ? row.lease_until : 0);
  if (budget) {
    until = Math.max(until, budget.blocked_until, budget.next_lookup_at);
    if (budget.day_start === Math.floor(now / DAY) * DAY && budget.jobs_started >= ARTIST_METADATA_DAILY_BUDGET) {
      until = Math.max(until, budget.day_start + DAY);
    }
    if (budget.active_jobs >= ARTIST_METADATA_MAX_ACTIVE && budget.next_lease_until) until = Math.max(until, budget.next_lease_until);
  }
  return seconds(until, now);
}

async function claim(db: ArtistDatabase, key: string, token: string, now: number): Promise<{
  owned?: CacheRow; row: CacheRow | null; budget?: BudgetRow;
}> {
  const day = Math.floor(now / DAY) * DAY;
  /* D1 batches are transactions. The reservation and per-key lease commit
     together, gated by an unpredictable token; denied/spam names insert no
     cache rows. Never rely on per-isolate counters or a read-then-write lock. */
  const result = await db.batch([
    db.prepare(`UPDATE artist_metadata_budget SET
      jobs_started = CASE WHEN day_start = ? THEN jobs_started + 1 ELSE 1 END,
      day_start = ?, next_lookup_at = ?, claim_token = ?
      WHERE id = 1 AND next_lookup_at <= ? AND blocked_until <= ?
      AND (day_start <> ? OR jobs_started < ?)
      AND (SELECT count(*) FROM artist_metadata_cache WHERE lease_token IS NOT NULL AND lease_until > ?) < ?
      AND NOT EXISTS (SELECT 1 FROM artist_metadata_cache WHERE artist_key = ? AND (
        (lease_token IS NOT NULL AND lease_until > ?) OR retry_at > ? OR
        (status IN ('ready', 'not-found', 'ambiguous') AND expires_at > ? AND retry_at = 0)))
      RETURNING id`)
      .bind(day, day, now + ARTIST_METADATA_LOOKUP_INTERVAL, token, now, now, day, ARTIST_METADATA_DAILY_BUDGET,
        now, ARTIST_METADATA_MAX_ACTIVE, key, now, now, now),
    db.prepare(`INSERT INTO artist_metadata_cache (artist_key, status, lease_token, lease_until, updated_at)
      SELECT ?, 'retry', ?, ?, ? WHERE EXISTS (SELECT 1 FROM artist_metadata_budget WHERE id = 1 AND claim_token = ?)
      ON CONFLICT(artist_key) DO UPDATE SET lease_token = excluded.lease_token,
        lease_until = excluded.lease_until, updated_at = excluded.updated_at
      RETURNING *`).bind(key, token, now + ARTIST_METADATA_LEASE_MS, now, token),
    db.prepare('SELECT * FROM artist_metadata_cache WHERE artist_key = ?').bind(key),
    db.prepare(`SELECT day_start, jobs_started, next_lookup_at, blocked_until,
      (SELECT count(*) FROM artist_metadata_cache WHERE lease_token IS NOT NULL AND lease_until > ?) AS active_jobs,
      (SELECT min(lease_until) FROM artist_metadata_cache WHERE lease_token IS NOT NULL AND lease_until > ?) AS next_lease_until
      FROM artist_metadata_budget WHERE id = 1`).bind(now, now),
  ]);
  if (!result[3]?.results[0]) throw new Error('Artist metadata budget is unavailable.');
  return {
    ...(result[0].results.length && result[1].results.length ? { owned: result[1].results[0] as unknown as CacheRow } : {}),
    row: result[2].results[0] as unknown as CacheRow || null,
    budget: result[3].results[0] as unknown as BudgetRow,
  };
}

async function boundedLookup(name: string, options: ArtistMetadataStoreOptions, now: () => number): Promise<ArtistMetadataResponse> {
  const controller = new AbortController();
  const requested = options.lookupTimeoutMs;
  const timeoutMs = Number.isFinite(requested) ? Math.max(1, Math.min(ARTIST_METADATA_LOOKUP_TIMEOUT, requested!)) : ARTIST_METADATA_LOOKUP_TIMEOUT;
  const key = normalizeArtistKey(name);
  let timer: ReturnType<typeof setTimeout>;
  let detach = () => {};
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return await new Promise<ArtistMetadataResponse>((resolve) => {
      const aborted = () => resolve({ key, status: 'retry', retryAfter: DEFAULT_BACKOFF });
      controller.signal.addEventListener('abort', aborted, { once: true });
      detach = () => controller.signal.removeEventListener('abort', aborted);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      if (controller.signal.aborted) { aborted(); return; }
      Promise.resolve().then(() => (options.provider || fetchArtistMetadata)(name, {
        fetch: options.fetch, now, signal: controller.signal, requestTimeoutMs: options.requestTimeoutMs,
        interactive: options.interactive === true,
        timeoutMs: Math.min(options.timeoutMs || ARTIST_METADATA_PROVIDER_TIMEOUT, Math.max(1, timeoutMs - 250)),
      })).then(resolve, () => resolve({ key, status: 'retry', retryAfter: DEFAULT_BACKOFF }));
    });
  } finally {
    clearTimeout(timer!);
    detach();
    options.signal?.removeEventListener('abort', abort);
  }
}

function payload(value: AutomaticArtistMetadata | undefined): string | null {
  if (!value) return null;
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 16_384) throw new Error('Artist metadata payload exceeds its storage limit.');
  return json;
}

async function complete(db: ArtistDatabase, row: CacheRow, result: ArtistMetadataResponse, now: number): Promise<CacheRow | null> {
  const goodResult = result.status === 'ready' && validMetadata(result.metadata) ? result.metadata : undefined;
  const negative = result.status === 'not-found' || result.status === 'ambiguous';
  const transient = result.retryAfter !== undefined || (!goodResult && !negative);
  let status: ArtistMetadataResponse['status'];
  let good: AutomaticArtistMetadata | undefined;
  let retryAt = 0;
  let failures = 0;
  let fetchedAt = now;
  let expiresAt: number;
  if (transient) {
    const previous = metadata(row);
    /* Do not merge old fields into a falsely fresh snapshot. A newly verified
       different identity also must not inherit the previous artist's image. */
    good = previous && (!goodResult || previous.entityId === goodResult.entityId) ? previous : goodResult;
    status = good ? 'ready' : 'retry';
    const upstream = Number.isFinite(result.retryAfter) && result.retryAfter! >= 0 ? Math.ceil(result.retryAfter!) : DEFAULT_BACKOFF;
    const backoff = Math.max(10, upstream, Math.min(3600, 30 * 2 ** Math.min(row.failures, 7)));
    retryAt = Math.min(Number.MAX_SAFE_INTEGER, now + backoff * 1000);
    failures = Math.min(row.failures + 1, 20);
    fetchedAt = good?.fetchedAt || 0;
    expiresAt = good?.expiresAt || 0;
  } else if (goodResult) {
    good = goodResult; status = 'ready'; fetchedAt = good.fetchedAt; expiresAt = good.expiresAt;
  } else {
    status = result.status; expiresAt = now + ARTIST_METADATA_NEGATIVE_TTL;
  }
  const statements = [];
  if (transient) {
    /* Gate the shared cooldown BEFORE clearing the lease. A late worker can
       neither overwrite a winner nor extend global backoff after losing it. */
    statements.push(db.prepare(`UPDATE artist_metadata_budget SET blocked_until = max(blocked_until, ?)
      WHERE id = 1 AND EXISTS (SELECT 1 FROM artist_metadata_cache
        WHERE artist_key = ? AND lease_token = ? AND lease_until > ?)`)
      .bind(retryAt, row.artist_key, row.lease_token, now));
  }
  statements.push(db.prepare(`UPDATE artist_metadata_cache SET status = ?, metadata_json = ?,
    fetched_at = ?, expires_at = ?, retry_at = ?, failures = ?, lease_token = NULL, lease_until = 0, updated_at = ?
    WHERE artist_key = ? AND lease_token = ? AND lease_until > ? RETURNING *`)
    .bind(status!, payload(good), fetchedAt, expiresAt!, retryAt, failures, now, row.artist_key, row.lease_token, now));
  const completed = await db.batch(statements);
  return completed[completed.length - 1].results[0] as unknown as CacheRow || null;
}

export async function readArtistMetadata(
  env: ArtistEnv, name: string, options: ArtistMetadataStoreOptions = {},
): Promise<ArtistMetadataStoreResult> {
  const key = normalizeArtistKey(name);
  if (!validArtistMetadataName(name)) return { response: { key, status: 'not-found' } };
  const now = options.now || Date.now;
  const controller = new AbortController();
  const aborted = () => controller.abort();
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const timer = setTimeout(aborted, timeout(options.deadlineMs, ARTIST_METADATA_REQUEST_TIMEOUT));
  const storage = <T>(operation: Promise<T>) => boundedStage(operation, controller.signal, timeout(options.storageTimeoutMs, ARTIST_METADATA_STORAGE_TIMEOUT));
  let previous: CacheRow | null = null;
  try {
    const db = database(env);
    previous = await storage(readRow(db, key));
    /* Repair only malformed automatic cache data, with a compare-and-swap
       guard so this cannot erase an active or concurrently replaced result. */
    if (previous?.metadata_json && !metadata(previous)) {
      await storage(db.prepare(`UPDATE artist_metadata_cache SET status = 'retry', metadata_json = NULL,
        fetched_at = 0, expires_at = 0, retry_at = 0 WHERE artist_key = ? AND metadata_json = ? AND lease_until <= ?`)
        .bind(key, previous.metadata_json, now()).all());
      previous = await storage(readRow(db, key));
    }
    const cached = available(previous, key, now());
    if (cached) return cached;
    const reservation = await storage(claim(db, key, (options.token || (() => crypto.randomUUID()))(), now()));
    previous = reservation.row;
    if (!reservation.owned) return available(previous, key, now()) || retry(previous, key, denialDelay(previous, reservation.budget, now()));
    const result = await boundedStage(boundedLookup(name, { ...options, signal: controller.signal }, now), controller.signal, ARTIST_METADATA_LOOKUP_TIMEOUT);
    const finished = await storage(complete(db, reservation.owned, { ...result, key }, now()));
    if (finished) return available(finished, key, now()) || retry(finished, key, DEFAULT_BACKOFF);
    /* Completion is fenced even when no newer worker has finished yet. Never
       expose the losing worker's uncached payload as a successful response. */
    const latest = await storage(readRow(db, key));
    return available(latest, key, now()) || retry(latest, key, DEFAULT_BACKOFF);
  } catch {
    return retry(previous, key, DEFAULT_BACKOFF, true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', aborted);
    controller.abort();
  }
}
