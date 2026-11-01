/* functions/lib/ociS3.ts
 *
 * Lightweight, zero-dependency AWS Signature Version 4 (SigV4) client for
 * Oracle Cloud Infrastructure (OCI) S3-Compatible Object Storage.
 *
 * Uses native Web Crypto API (crypto.subtle) for Cloudflare Workers/Pages V8 isolates.
 */

const textEncoder = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === 'string' ? textEncoder.encode(data) : data;
  const hashBuf = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  const bytes = new Uint8Array(hashBuf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(message) as BufferSource);
  return new Uint8Array(sigBuf);
}

function hexFromBytes(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export interface OciS3Config {
  namespace: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export interface SignedRequestHeaders {
  host: string;
  'x-amz-date': string;
  'x-amz-content-sha256': string;
  Authorization: string;
  [key: string]: string;
}

/**
 * Sign an S3 request for OCI Object Storage using AWS SigV4.
 */
export async function signOciS3Request(
  method: string,
  objectPath: string,
  config: OciS3Config,
  extraHeaders: Record<string, string> = {},
  payloadHash?: string
): Promise<{ url: string; headers: SignedRequestHeaders }> {
  const { namespace, bucket, region, accessKey, secretKey } = config;
  const host = `${namespace}.compat.objectstorage.${region}.oraclecloud.com`;

  // Clean object key path
  const cleanPath = objectPath.replace(/^\/+/, '');
  const canonicalUri = cleanPath ? `/${bucket}/${encodeURI(cleanPath)}` : `/${bucket}/`;
  const url = `https://${host}${canonicalUri}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  // If no payload hash provided, default to empty SHA-256
  const pHash = payloadHash || (await sha256Hex(''));

  // Assemble and sort canonical headers
  const headerMap: Record<string, string> = {
    host,
    'x-amz-content-sha256': pHash,
    'x-amz-date': amzDate,
  };

  // Add lowercase extra headers (e.g. range, content-length, content-type)
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v) headerMap[k.toLowerCase()] = v.trim();
  }

  const sortedHeaderKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headerMap[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  // Canonical Request
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    '', // query string
    canonicalHeaders,
    signedHeaders,
    pHash,
  ].join('\n');

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);

  // String to Sign
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashedCanonicalRequest,
  ].join('\n');

  // Derive signing key
  const kSecret = textEncoder.encode(`AWS4${secretKey}`);
  const kDate = await hmac(kSecret, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');

  const signature = hexFromBytes(await hmac(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const finalHeaders: SignedRequestHeaders = {
    ...headerMap,
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': pHash,
    Authorization: authorization,
  };

  return { url, headers: finalHeaders };
}

export interface OciStoredObject {
  key: string;
  size: number;
  lastModified: string;
}

/**
 * Pure zero-dependency XML parser for S3 ListBucketResult in V8 workers.
 */
export function parseS3ListObjectsXml(xmlText: string): OciStoredObject[] {
  const objects: OciStoredObject[] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;

  while ((match = contentsRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const sizeMatch = /<Size>(\d+)<\/Size>/.exec(block);
    const dateMatch = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);

    if (keyMatch) {
      objects.push({
        key: decodeURIComponent(keyMatch[1].replace(/\+/g, ' ')),
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
        lastModified: dateMatch ? dateMatch[1] : '',
      });
    }
  }
  return objects;
}

/**
 * List all objects stored in the OCI bucket.
 */
export async function listOciObjects(config: OciS3Config): Promise<OciStoredObject[]> {
  const signed = await signOciS3Request('GET', '', config);
  const res = await fetch(signed.url, { headers: signed.headers });
  if (!res.ok) {
    throw new Error(`Failed to list OCI bucket: HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseS3ListObjectsXml(text);
}

/**
 * Delete an object from the OCI bucket.
 */
export async function deleteOciObject(key: string, config: OciS3Config): Promise<boolean> {
  const signed = await signOciS3Request('DELETE', key, config);
  const res = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
  return res.ok || res.status === 204 || res.status === 404;
}

/**
 * Safety Pruning: Enforce a strict max track cap on the OCI hot-cache bucket.
 * If the bucket is at or above capacity, evicts the oldest tracks (FIFO/LRU)
 * before adding any new ones.
 */
export async function pruneOciBucketToLimit(
  config: OciS3Config,
  maxAllowedTracks: number = 30
): Promise<{ prunedCount: number; remainingCount: number; totalBytes: number }> {
  try {
    const objects = await listOciObjects(config);
    let totalBytes = objects.reduce((sum, o) => sum + o.size, 0);

    if (objects.length < maxAllowedTracks) {
      return { prunedCount: 0, remainingCount: objects.length, totalBytes };
    }

    // Sort by LastModified ascending (oldest first)
    objects.sort((a, b) => {
      const da = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const db = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return da - db;
    });

    const excessCount = objects.length - maxAllowedTracks + 1; // Prune so there's room for 1 new track
    let pruned = 0;

    for (let i = 0; i < excessCount && i < objects.length; i++) {
      const toDelete = objects[i];
      const ok = await deleteOciObject(toDelete.key, config);
      if (ok) {
        pruned++;
        totalBytes -= toDelete.size;
      }
    }

    return { prunedCount: pruned, remainingCount: objects.length - pruned, totalBytes };
  } catch (err) {
    console.warn('[OCI-HotCache] Pruning check failed:', err);
    return { prunedCount: 0, remainingCount: 0, totalBytes: 0 };
  }
}
