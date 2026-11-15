import { encodeS3ObjectKey } from './ociS3';
import { RENDITION_REVISION_SQL, type VersionDatabase } from './version-registry';

export interface AudioCacheIdentity {path: string; revision: string; sha256?: string}

export async function cacheDigest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(bytes,byte => byte.toString(16).padStart(2,'0')).join('');
}

export async function audioCachePrefix(bucket: string): Promise<string> {
  return `aura-cache/v2/${(await cacheDigest(bucket)).slice(0,20)}/`;
}

export async function audioCachePath(bucket: string, identity: AudioCacheIdentity): Promise<string> {
  const fingerprint = await cacheDigest(JSON.stringify([bucket,identity.path,identity.revision]));
  return `${await audioCachePrefix(bucket)}${fingerprint}/${identity.path}`;
}

/** D1 changes the identity as soon as a new rendition is published. Legacy
 * URLs resolve to the current canonical source, sharing its cache entry. */
export async function registryAudioIdentity(db: VersionDatabase, path: string): Promise<AudioCacheIdentity | null> {
  const legacy = /^versions\/(bass|bass-reverb)\/([A-Za-z0-9_-]{11}|track-[a-f0-9]{20})\.mp3$/.exec(path);
  const canonical = legacy ? `versions/${legacy[2]}/${legacy[1]}.mp3` : path;
  const row = await db.prepare(`SELECT original_path AS path, original_hash AS revision, NULL AS sha256 FROM audio_tracks
    WHERE active = 1 AND (original_path = ? OR original_id = ?)
    UNION ALL SELECT r.path, ${RENDITION_REVISION_SQL} AS revision, r.sha256 FROM audio_renditions r
    JOIN audio_tracks t ON t.ref = r.track_ref WHERE t.active = 1 AND r.status = 'ready'
    AND r.path IN (?, ?) LIMIT 1`)
    .bind(path,`hf:${path.replace(/^originals\//,'')}`,path,canonical).first();
  if (!row?.path || !/^[A-Za-z0-9_-]{1,160}$/.test(row.revision || '')) return null;
  encodeS3ObjectKey(row.path);
  return {path:row.path,revision:String(row.revision),...(/^[a-f0-9]{64}$/.test(row.sha256 || '') ? {sha256:row.sha256} : {})};
}

/** Unregistered uploads can use a strong archive ETag. Without verifiable
 * metadata they still stream, but never reuse a potentially stale OCI copy. */
export async function archiveAudioIdentity(url: string, path: string): Promise<AudioCacheIdentity | null> {
  const response = await fetch(url,{method:'HEAD',headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(2500)});
  const tag = response.headers.get('x-linked-etag') || response.headers.get('etag');
  if (!response.ok || !tag || tag.startsWith('W/')) return null;
  return {path,revision:await cacheDigest(tag)};
}
