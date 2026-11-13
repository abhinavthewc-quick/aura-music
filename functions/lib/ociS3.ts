/* Lightweight OCI S3-compatible SigV4 client for Cloudflare's Web Crypto runtime.
 * No credentials or endpoints are embedded here. Callers supply server-only env.
 */
const textEncoder = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(message) as BufferSource));
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface OciS3Config {
  namespace: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export function isValidOciS3Config(config: OciS3Config): boolean {
  return /^[a-z0-9]{1,63}$/i.test(config.namespace)
    && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(config.region)
    && /^[a-z0-9][a-z0-9_.-]{0,255}$/i.test(config.bucket)
    && config.bucket !== '.' && config.bucket !== '..'
    && Boolean(config.accessKey.trim()) && Boolean(config.secretKey.trim());
}

/** RFC 3986, not encodeURI: ?, #, +, %, & and brackets are part of object names. */
export function encodeS3Component(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeS3ObjectKey(key: string): string {
  if (/[\u0000-\u001f\u007f]/.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid object key');
  }
  // Deliberately keep path boundaries without ever interpreting escapes in a key.
  return key.split('/').map(encodeS3Component).join('/');
}

export interface SignedRequestHeaders {
  host: string;
  'x-amz-date': string;
  'x-amz-content-sha256': string;
  Authorization: string;
  [key: string]: string;
}

interface SigningOptions {
  query?: Record<string, string>;
  now?: Date;
}

export async function signOciS3Request(
  method: string,
  objectPath: string,
  config: OciS3Config,
  extraHeaders: Record<string, string> = {},
  payloadHash?: string,
  options: SigningOptions = {},
): Promise<{ url: string; headers: SignedRequestHeaders }> {
  if (!isValidOciS3Config(config)) throw new Error('Invalid OCI configuration');
  const verb = method.toUpperCase();
  if (!['GET', 'HEAD', 'PUT', 'DELETE'].includes(verb)) throw new Error('Unsupported object-storage method');
  const { namespace, bucket, region, accessKey, secretKey } = config;
  const host = `${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
  const canonicalUri = `/${encodeS3Component(bucket)}/${encodeS3ObjectKey(objectPath)}`;
  const canonicalQuery = Object.entries(options.query || {})
    .map(([key, value]) => [encodeS3Component(key), encodeS3Component(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
  const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const now = options.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const pHash = payloadHash || await sha256Hex('');
  if (!/^[0-9a-f]{64}$/i.test(pHash)) throw new Error('Invalid payload hash');

  const headerMap: Record<string, string> = { host, 'x-amz-content-sha256': pHash, 'x-amz-date': amzDate };
  for (const [key, rawValue] of Object.entries(extraHeaders)) {
    const name = key.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)
      || ['host', 'authorization', 'x-amz-date', 'x-amz-content-sha256'].includes(name)
      || /[\r\n]/.test(rawValue)) throw new Error('Invalid signed header');
    if (rawValue) headerMap[name] = rawValue.trim().replace(/[\t ]+/g, ' ');
  }
  const sortedKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedKeys.map((key) => `${key}:${headerMap[key]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [verb, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, pHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(textEncoder.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hexFromBytes(await hmac(kSigning, stringToSign));
  return {
    url,
    headers: {
      ...headerMap,
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': pHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export interface OciStoredObject {
  key: string;
  size: number;
  lastModified: string;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const hex = /^&#x/i.test(entity);
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function xmlValue(xml: string, tag: string): string {
  return decodeXml(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1] || '');
}

/** S3 only URI-encodes keys if EncodingType=url was explicitly requested. */
export function parseS3ListObjectsXml(xmlText: string): OciStoredObject[] {
  const encoded = xmlValue(xmlText, 'EncodingType') === 'url';
  const objects: OciStoredObject[] = [];
  for (const match of xmlText.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    let key = xmlValue(block, 'Key');
    if (!key) continue;
    if (encoded) {
      try { key = decodeURIComponent(key); } catch { throw new Error('Invalid object-storage listing'); }
    }
    const size = Number(xmlValue(block, 'Size'));
    objects.push({ key, size: Number.isFinite(size) && size >= 0 ? size : 0, lastModified: xmlValue(block, 'LastModified') });
  }
  return objects;
}

export async function listOciObjects(config: OciS3Config): Promise<OciStoredObject[]> {
  const objects: OciStoredObject[] = [];
  const markers = new Set<string>();
  let marker = '';
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { 'encoding-type': 'url', 'max-keys': '1000' };
    if (marker) query.marker = marker;
    const signed = await signOciS3Request('GET', '', config, {}, undefined, { query });
    const response = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Object-storage listing unavailable');
    const xml = await response.text();
    if (!/<ListBucketResult(?:\s|>)/.test(xml)) throw new Error('Invalid object-storage listing');
    const batch = parseS3ListObjectsXml(xml);
    objects.push(...batch);
    if (xmlValue(xml, 'IsTruncated') !== 'true') return objects;
    const nextMarker = xmlValue(xml, 'NextMarker');
    if (nextMarker) {
      try { marker = xmlValue(xml, 'EncodingType') === 'url' ? decodeURIComponent(nextMarker) : nextMarker; }
      catch { throw new Error('Invalid object-storage listing'); }
    } else marker = batch[batch.length - 1]?.key || '';
    if (!marker || markers.has(marker)) throw new Error('Incomplete object-storage listing');
    markers.add(marker);
  }
  throw new Error('Object-storage listing exceeds safety limit');
}

export async function deleteOciObject(key: string, config: OciS3Config): Promise<boolean> {
  const signed = await signOciS3Request('DELETE', key, config);
  const response = await fetch(signed.url, { method: 'DELETE', headers: signed.headers, signal: AbortSignal.timeout(5000) });
  return response.ok || response.status === 404;
}

/** Reserve room for one new audio object. Never evict non-audio data or write
 * when a listing/deletion failed. The caller serializes writers per isolate;
 * this is a best-effort cap, not a distributed lock across Cloudflare isolates.
 */
export async function pruneOciBucketToLimit(
  config: OciS3Config,
  maxAllowedTracks = 30,
): Promise<{ prunedCount: number; remainingCount: number; totalBytes: number; hasCapacity: boolean }> {
  if (!Number.isInteger(maxAllowedTracks) || maxAllowedTracks < 1) throw new Error('Invalid hot-cache limit');
  const objects = (await listOciObjects(config)).filter((object) => /\.(mp3|opus|webm|m4a|aac|ogg|flac|wav)$/i.test(object.key));
  let totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
  objects.sort((a, b) => (Date.parse(a.lastModified) || 0) - (Date.parse(b.lastModified) || 0));
  const excess = Math.max(0, objects.length - maxAllowedTracks + 1);
  let prunedCount = 0;
  for (let i = 0; i < excess; i++) {
    if (await deleteOciObject(objects[i].key, config)) {
      prunedCount++;
      totalBytes -= objects[i].size;
    }
  }
  const remainingCount = objects.length - prunedCount;
  return { prunedCount, remainingCount, totalBytes, hasCapacity: remainingCount < maxAllowedTracks };
}
