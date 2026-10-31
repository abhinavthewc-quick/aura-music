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
  const canonicalUri = `/${bucket}/${encodeURI(cleanPath)}`;
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
