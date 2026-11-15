export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = any>(): Promise<{results: T[]; meta: {changes: number}}>;
  run(): Promise<{meta: {changes: number}}>;
  first<T = any>(): Promise<T | null>;
}
export interface VersionDatabase {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{results: any[]; meta: {changes: number}}[]>;
}
export interface RegistryEnv {
  VERSION_DB?: VersionDatabase;
  VERSION_WORKER_TOKEN?: string;
  HF_BUCKET_ID?: string;
}
export const MODES = ['bass', 'bass-reverb'] as const;
export const LEASE_SECONDS = 3600;
export function safePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(path) &&
    !path.includes('://') && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}
export function validKey(key: unknown): key is string {
  return typeof key === 'string' && /^(?:[A-Za-z0-9_-]{11}|track-[a-f0-9]{20})$/.test(key);
}
export function renditionPath(key: string, mode: string): string { return `versions/${key}/${mode}.mp3`; }
export function originalId(path: string): string { return `hf:${path.replace(/^originals\//, '')}`; }
export function trackRef(path: string): string {
  const match = /\[([A-Za-z0-9_-]{11})\]$/.exec(path.replace(/\.[^.]+$/, ''));
  return match ? `video:${match[1]}` : `id:${originalId(path)}`;
}
export async function authenticated(request: Request, expected?: string): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  const [a, b] = await Promise.all([given, expected].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  return av.reduce((difference, value, i) => difference | (value ^ bv[i]), 0) === 0;
}
let treeCache: {bucket: string; at: number; files: Map<string, any>} | undefined;
export async function archiveTree(bucket: string, force = false): Promise<Map<string, any>> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bucket)) throw new Error('Invalid bucket');
  if (!force && treeCache?.bucket === bucket && Date.now() - treeCache.at < 30_000) return treeCache.files;
  let url = `https://huggingface.co/api/buckets/${bucket}/tree?recursive=true`;
  const files = new Map<string, any>();
  for (let page = 0; page < 100; page++) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error('Archive listing unavailable');
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Invalid archive listing');
    for (const item of items) if (item.type === 'file' && safePath(item.path)) files.set(item.path, item);
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') || '');
    if (!next) { treeCache = {bucket, at: Date.now(), files}; return files; }
    if (new URL(next[1]).origin !== 'https://huggingface.co') throw new Error('Invalid archive cursor');
    url = next[1];
  }
  throw new Error('Archive listing incomplete');
}
export async function publicVersions(db: VersionDatabase): Promise<any> {
  const {results} = await db.prepare(`SELECT r.track_ref, r.mode, r.path, r.duration FROM audio_renditions r
    JOIN audio_tracks t ON t.ref = r.track_ref WHERE t.active = 1 AND r.status = 'ready'`).all();
  const tracks = Object.create(null);
  for (const row of results) {
    tracks[row.track_ref] ||= {};
    tracks[row.track_ref][row.mode] = {path: row.path, ...(row.duration > 0 ? {duration: row.duration} : {})};
  }
  return {v: 1, source: 'database', tracks};
}
