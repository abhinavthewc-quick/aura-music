import { expect, test } from '@playwright/test';
import { createHash, createHmac } from 'node:crypto';
import { onRequestGet, onRequestHead, onRequestOptions, readBoundedAudio, type AudioEnv } from '../../functions/api/audio';
import { listOciObjects, parseS3ListObjectsXml, pruneOciBucketToLimit, signOciS3Request, type OciS3Config } from '../../functions/lib/ociS3';
import { audioCachePath, audioCachePrefix } from '../../functions/lib/audio-cache';

// Deliberately fake credentials for an entirely mocked network. Never read the
// shell's environment or perform requests against the owner's actual bucket.
const fakeConfig: OciS3Config = {
  namespace: 'unitnamespace', bucket: 'unit-cache', region: 'unit-region-1',
  accessKey: 'TEST-ONLY-ACCESS', secretKey: 'TEST-ONLY-SECRET',
};
const completeEnv: AudioEnv = {
  OCI_NAMESPACE: fakeConfig.namespace, OCI_BUCKET_NAME: fakeConfig.bucket, OCI_REGION: fakeConfig.region,
  OCI_ACCESS_KEY: fakeConfig.accessKey, OCI_SECRET_KEY: fakeConfig.secretKey,
  AUDIO_ADMIN_TOKEN: 'test-only-admin-token', HF_BUCKET_ID: 'unit/archive',
  VERSION_DB: {prepare:() => ({bind:(path:string) => ({first:async () => ({path,revision:'a'.repeat(64)})})} as any),batch:async () => []},
};
const nativeFetch = globalThis.fetch;
const nativeWarn = console.warn;
let calls: Array<{ url: string; method: string; headers: Headers }> = [];
let warnings: string[] = [];
let responder: (call: typeof calls[number]) => Response | Promise<Response>;

function audioRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://aura.example/api/audio?path=${encodeURIComponent(path)}`, { headers });
}

function xmlListing(keys: string[] = [], extra = ''): string {
  return `<ListBucketResult><EncodingType>url</EncodingType>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key><Size>4</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`).join('')}${extra}</ListBucketResult>`;
}

function mockedFetch(responseForCall: (call: typeof calls[number]) => Response | Promise<Response>): void {
  responder = responseForCall;
}

test.beforeEach(() => {
  calls = [];
  warnings = [];
  responder = () => { throw new Error('Unexpected outbound fetch in security unit test'); };
  globalThis.fetch = async (input, init) => {
    const call = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method || 'GET', headers: new Headers(init?.headers),
    };
    calls.push(call);
    return responder(call);
  };
  console.warn = (...values) => { warnings.push(values.map(String).join(' ')); };
});

test.afterEach(() => {
  globalThis.fetch = nativeFetch;
  console.warn = nativeWarn;
});

test.describe('audio cache security', () => {
  test('legacy originals and rendition paths resolve the verified new layout with byte ranges intact', async () => {
    for (const [legacy, migrated] of [
      ['Artist - Song [abcdefghijk].opus','originals/Artist - Song [abcdefghijk].opus'],
      ['versions/bass/abcdefghijk.mp3','versions/abcdefghijk/bass.mp3'],
      ['versions/bass-reverb/track-0123456789abcdef0123.mp3','versions/track-0123456789abcdef0123/bass-reverb.mp3'],
    ]) {
      mockedFetch(call => {
        const path = decodeURIComponent(new URL(call.url).pathname.split('/resolve/')[1]);
        expect(call.headers.get('range')).toBe('bytes=0-2');
        if (path === legacy) return new Response(null,{status:404});
        expect(path).toBe(migrated);
        return new Response('abc',{status:206,headers:{'Content-Range':'bytes 0-2/100','Content-Length':'3'}});
      });
      const response = await onRequestGet({request:audioRequest(legacy,{Range:'bytes=0-2'}),env:{}});
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('abc');
      expect(response.headers.get('content-range')).toBe('bytes 0-2/100');
    }
  });

  test('missing, partial, blank and malformed OCI env make zero OCI calls or cache jobs', async () => {
    mockedFetch((call) => {
      expect(new URL(call.url).hostname).toBe('huggingface.co');
      expect(call.headers.has('authorization')).toBe(false);
      return new Response('test audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    const fields = ['OCI_NAMESPACE', 'OCI_BUCKET_NAME', 'OCI_REGION', 'OCI_ACCESS_KEY', 'OCI_SECRET_KEY'] as const;
    const environments: AudioEnv[] = [{}, { HF_BUCKET_ID: 'unit/archive' }];
    for (const field of fields) environments.push({ ...completeEnv, [field]: undefined });
    environments.push({ ...completeEnv, OCI_SECRET_KEY: ' ' }, { ...completeEnv, OCI_REGION: 'bad/region' });
    for (let i = 0; i < environments.length; i++) {
      const jobs: Promise<unknown>[] = [];
      const response = await onRequestGet({ request: audioRequest(`offline-${i}.mp3`), env: environments[i], waitUntil: (job) => jobs.push(job) });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-aura-cache')).toBe('MISS-HF-STREAMING');
      expect(await response.text()).toBe('test audio');
      expect(jobs).toHaveLength(0);
    }
    expect(calls).toHaveLength(environments.length);
    expect(warnings).toHaveLength(0);
  });

  test('status requires a header token and exposes nothing publicly', async () => {
    for (const [env, authorization] of [[{}, ''], [completeEnv, ''], [completeEnv, 'Bearer wrong-token']] as const) {
      const request = new Request('https://aura.example/api/audio?action=status&token=test-only-admin-token', { headers: authorization ? { authorization } : {} });
      const response = await onRequestGet({ request, env });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Authorization');
      expect(await response.text()).toBe('Not found');
    }
    expect(calls).toHaveLength(0);
    const unavailable = await onRequestGet({
      request: new Request('https://aura.example/api/audio?action=status', { headers: { authorization: `Bearer ${completeEnv.AUDIO_ADMIN_TOKEN}` } }),
      env: { AUDIO_ADMIN_TOKEN: completeEnv.AUDIO_ADMIN_TOKEN },
    });
    expect(unavailable.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test('authenticated status is private aggregates, with sanitized failures', async () => {
    const prefix = await audioCachePrefix('unit/archive');
    mockedFetch(() => new Response(xmlListing([prefix+'Test?# + track.mp3', prefix+'README.txt','unrelated.mp3']), { headers: { 'Content-Type': 'application/xml' } }));
    const request = new Request('https://aura.example/api/audio?action=status', { headers: { authorization: `Bearer ${completeEnv.AUDIO_ADMIN_TOKEN}` } });
    const response = await onRequestGet({ request, env: completeEnv });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ status: 'healthy', cachedTracksCount: 1, maxCapTracks: 30, totalUsedBytes: 8 });
    mockedFetch(() => { throw new Error('DO-NOT-EXPOSE signed-url secret-header'); });
    const failed = await onRequestGet({ request, env: completeEnv });
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe('Hot-cache status unavailable');
    expect(warnings.join(' ')).not.toContain('DO-NOT-EXPOSE');
  });

  test('unsafe keys, malformed route escapes, and invalid or multiple ranges fail before fetch', async () => {
    const invalidPaths = ['../test.mp3', 'folder/../test.mp3', 'folder/./test.mp3', 'folder//test.mp3', 'test\\track.mp3', 'test\u0000.mp3', 'https://bad.test/a.mp3', 'test.html'];
    for (const path of invalidPaths) {
      const response = await onRequestGet({ request: audioRequest(path), env: completeEnv });
      expect(response.status).toBe(400);
    }
    const malformed = await onRequestGet({ request: new Request('https://aura.example/api/audio/%E0%A4%A.mp3'), env: completeEnv });
    expect(malformed.status).toBe(400);
    for (const range of ['bytes=4-2', 'bytes=0-1,4-5', 'bytes=-0', 'items=0-1', 'bytes=-', 'bytes=99999999999999999999-']) {
      const response = await onRequestGet({ request: audioRequest('range-invalid.mp3', { Range: range }), env: completeEnv });
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test('archive keys retain URI punctuation, Unicode, and literal percent escapes', async () => {
    const path = 'Album/பாட்டு + 10% ?#& [live] (%2E%2E).opus';
    mockedFetch((call) => {
      const url = new URL(call.url);
      expect(url.hostname).toBe('huggingface.co');
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(decodeURIComponent(url.pathname)).toBe(`/buckets/unit/archive/resolve/${path}`);
      expect(call.headers.get('range')).toBe('bytes=1-3');
      return new Response('abc', { status: 206, headers: { 'Content-Type': 'audio/ogg', 'Content-Length': '3', 'Content-Range': 'bytes 1-3/20' } });
    });
    const response = await onRequestGet({ request: audioRequest(path, { Range: 'bytes=1-3' }), env: { HF_BUCKET_ID: 'unit/archive' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-3/20');
    expect(response.headers.get('content-length')).toBe('3');
    expect(await response.text()).toBe('abc');
  });

  test('OCI cache hit forwards ranges and does not contact the archive', async () => {
    mockedFetch((call) => {
      expect(new URL(call.url).hostname).toContain('.oraclecloud.com');
      if (call.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '10' } });
      expect(call.headers.get('range')).toBe('bytes=2-4');
      return new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3', 'Content-Type': 'audio/mpeg' } });
    });
    const response = await onRequestGet({ request: audioRequest('hit-range.mp3', { Range: 'bytes=2-4' }), env: completeEnv });
    expect(response.status).toBe(206);
    expect(response.headers.get('x-aura-cache')).toBe('HIT-OCI');
    expect(response.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(response.headers.get('cache-control')).toContain('must-revalidate');
    expect(await response.text()).toBe('abc');
    expect(calls.map((call) => call.method)).toEqual(['HEAD', 'GET']);
  });

  test('OCI errors fall back safely and never log exception payloads', async () => {
    mockedFetch((call) => {
      if (call.url.includes('oraclecloud.com')) throw new Error('DO-NOT-EXPOSE Authorization signed-url');
      return new Response('archive audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    const response = await onRequestGet({ request: audioRequest('outage.mp3'), env: completeEnv });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('archive audio');
    expect(warnings).toHaveLength(1);
    expect(warnings.join(' ')).not.toContain('DO-NOT-EXPOSE');
    expect(calls).toHaveLength(2);
  });

  test('existence metadata is scoped to the configured bucket, not just the track path', async () => {
    mockedFetch((call) => call.method === 'HEAD' ? new Response(null) : new Response('audio'));
    await onRequestGet({ request: audioRequest('same-name.mp3'), env: completeEnv });
    await onRequestGet({ request: audioRequest('same-name.mp3'), env: { ...completeEnv, OCI_BUCKET_NAME: 'other-unit-cache' } });
    expect(calls.filter((call) => call.method === 'HEAD')).toHaveLength(2);
    expect(calls.every((call) => call.url.includes('oraclecloud.com'))).toBe(true);
  });

  test('HEAD returns correct metadata without a body or background upload', async () => {
    mockedFetch((call) => {
      expect(call.method).toBe('HEAD');
      return new Response(null, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '50' } });
    });
    const jobs: Promise<unknown>[] = [];
    const response = await onRequestHead({ request: audioRequest('head-only.mp3'), env: {}, waitUntil: (job) => jobs.push(job) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('50');
    expect(await response.text()).toBe('');
    expect(jobs).toHaveLength(0);
  });

  test('archive failures are sanitized while 404 and 416 remain meaningful', async () => {
    mockedFetch(() => new Response('DO-NOT-EXPOSE upstream body', { status: 403 }));
    const failure = await onRequestGet({ request: audioRequest('forbidden.mp3'), env: {} });
    expect(failure.status).toBe(502);
    expect(await failure.text()).toBe('Remote catalog storage failed');
    mockedFetch(() => new Response('missing upstream bucket path', { status: 404 }));
    const missing = await onRequestGet({ request: audioRequest('missing.mp3'), env: {} });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Track not found');
    mockedFetch(() => new Response('upstream XML', { status: 416, headers: { 'Content-Range': 'bytes */9' } }));
    const range = await onRequestGet({ request: audioRequest('unsatisfiable.mp3', { Range: 'bytes=20-' }), env: {} });
    expect(range.status).toBe(416);
    expect(range.headers.get('content-range')).toBe('bytes */9');
    expect(await range.text()).toBe('Byte range is not satisfiable');
  });

  test('failed pruning suppresses uploads without breaking archive streaming', async () => {
    mockedFetch((call) => {
      if (call.method === 'HEAD') return new Response(null, { status: 404 });
      if (call.url.includes('huggingface.co')) return new Response('audio bytes', { headers: { 'Content-Length': '11' } });
      if (call.url.includes('oraclecloud.com') && call.method === 'GET') throw new Error('DO-NOT-EXPOSE cache list credentials');
      throw new Error('PUT must not occur after a failed capacity check');
    });
    const jobs: Promise<unknown>[] = [];
    const response = await onRequestGet({ request: audioRequest('failed-prune.mp3'), env: completeEnv, waitUntil: (job) => jobs.push(job) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('audio bytes');
    await Promise.all(jobs);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(warnings.join(' ')).not.toContain('DO-NOT-EXPOSE');
  });

  test('mislabelled upstream content cannot become executable same-origin HTML', async () => {
    mockedFetch(() => new Response('<script>untrusted upstream</script>', {
      headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': '9000' },
    }));
    const response = await onRequestGet({ request: audioRequest('mislabelled.mp3'), env: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
  });

  test('OPTIONS permits range requests without disclosing state', async () => {
    const response = await onRequestOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('Range');
    expect(await response.text()).toBe('');
    expect(calls).toHaveLength(0);
  });
});

test('cache identities change on regeneration and never reuse a bare legacy object key', async () => {
  const path = 'versions/abcdefghijk/bass.mp3';
  let revision = 'a'.repeat(64);
  const env:AudioEnv = {...completeEnv,VERSION_DB:{prepare:() => ({bind:() => ({first:async () => ({path,revision})})} as any),batch:async () => []}};
  const keys:string[] = [];
  mockedFetch(call => {
    const key = decodeURIComponent(new URL(call.url).pathname).replace('/unit-cache/','');
    keys.push(key);
    return call.method === 'HEAD' ? new Response(null) : new Response('audio');
  });
  const first = await onRequestGet({request:audioRequest(path),env});
  expect(first.headers.get('x-aura-revision')).toBe(revision);
  expect(keys[0]).toBe(await audioCachePath('unit/archive',{path,revision}));
  revision = 'b'.repeat(64);
  const next = await onRequestGet({request:audioRequest(path),env});
  expect(next.headers.get('x-aura-revision')).toBe(revision);
  expect(keys[2]).toBe(await audioCachePath('unit/archive',{path,revision}));
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys.every(key => key.startsWith('aura-cache/v2/'))).toBe(true);
});

test('a source revision change during download prevents stale cache publication', async () => {
  const path = 'versions/abcdefghijk/bass-reverb.mp3';
  let revision = 'a'.repeat(64);
  const env:AudioEnv = {...completeEnv,VERSION_DB:{prepare:() => ({bind:() => ({first:async () => ({path,revision})})} as any),batch:async () => []}};
  mockedFetch(call => {
    if (call.method === 'HEAD') return new Response(null,{status:404});
    if (call.url.includes('huggingface.co')) {
      revision = 'b'.repeat(64);
      return new Response('audio',{headers:{'content-length':'5'}});
    }
    throw new Error('OCI must not receive an outdated upload');
  });
  const jobs:Promise<unknown>[] = [];
  expect((await onRequestGet({request:audioRequest(path),env,waitUntil:job => jobs.push(job)})).status).toBe(200);
  await Promise.all(jobs);
  expect(calls.some(call => call.method === 'PUT')).toBe(false);
});

test('unregistered sources stream without using OCI when their archive metadata cannot prove an identity', async () => {
  mockedFetch(call => {
    expect(call.url).toContain('huggingface.co');
    return call.method==='HEAD' ? new Response(null) : new Response('audio');
  });
  const jobs:Promise<unknown>[] = [];
  const result=await onRequestGet({request:audioRequest('unregistered.opus'),env:{...completeEnv,VERSION_DB:undefined},waitUntil:job => jobs.push(job)});
  expect(await result.text()).toBe('audio');
  expect(jobs).toEqual([]);
  expect(result.headers.get('x-aura-cache')).toBe('MISS-HF-STREAMING');
});

test('pruning stays inside the managed cache prefix and preserves unrelated audio', async () => {
  const prefix = await audioCachePrefix('unit/archive');
  mockedFetch(call => call.method === 'DELETE' ? new Response(null,{status:204})
    : new Response(xmlListing([prefix+'old.mp3','originals/valuable.mp3','README.txt'])));
  const result=await pruneOciBucketToLimit(fakeConfig,1,prefix);
  expect(result.hasCapacity).toBe(true);
  const removed=calls.filter(call => call.method === 'DELETE');
  expect(removed).toHaveLength(1);
  expect(decodeURIComponent(new URL(removed[0].url).pathname)).toContain(prefix+'old.mp3');
});

test('a downloaded rendition with the wrong checksum cannot evict or populate cache objects', async () => {
  const path='versions/abcdefghijk/bass.mp3';
  const env:AudioEnv={...completeEnv,VERSION_DB:{prepare:() => ({bind:() => ({first:async () => ({path,revision:'a'.repeat(64),sha256:'b'.repeat(64)})})} as any),batch:async () => []}};
  mockedFetch(call => {
    if(call.method==='HEAD') return new Response(null,{status:404});
    if(call.url.includes('huggingface.co')) return new Response('audio',{headers:{'content-length':'5'}});
    throw new Error('Invalid content must not trigger OCI writes or eviction');
  });
  const jobs:Promise<unknown>[]=[];
  await onRequestGet({request:audioRequest(path),env,waitUntil:job => jobs.push(job)});
  await Promise.all(jobs);
  expect(calls.some(call => call.method==='PUT'||call.method==='DELETE')).toBe(false);
});

test('unregistered audio uses a strong archive ETag to identify an OCI copy', async () => {
  mockedFetch(call => {
    if (call.url.includes('huggingface.co')) {
      expect(call.method).toBe('HEAD');
      return new Response(null,{headers:{etag:'"content-one"'}});
    }
    return call.method==='HEAD' ? new Response(null) : new Response('cached audio');
  });
  const result=await onRequestGet({request:audioRequest('new-upload.mp3'),env:{...completeEnv,VERSION_DB:undefined}});
  expect(result.headers.get('x-aura-cache')).toBe('HIT-OCI');
  expect(result.headers.get('x-aura-revision')).toMatch(/^[a-f0-9]{64}$/);
  expect(await result.text()).toBe('cached audio');
  expect(calls[0].method).toBe('HEAD');
});

test('client revision hints affect HTTP caching while server metadata selects the object key', async () => {
  const path='hinted.mp3';
  const revision='a'.repeat(64);
  const urls:string[]=[];
  mockedFetch(call => {
    urls.push(call.url);
    return call.method==='HEAD' ? new Response(null) : new Response('audio');
  });
  const hinted=await onRequestGet({request:new Request(`https://aura.example/api/audio?path=${path}&v=untrusted`),env:completeEnv});
  expect(hinted.headers.get('cache-control')).toContain('must-revalidate');
  const matching=await onRequestGet({request:new Request(`https://aura.example/api/audio?path=${path}&v=${revision}`),env:completeEnv});
  expect(matching.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(new Set(urls).size).toBe(1);
});

test('warming returns the initial range immediately and bounds pending downloads per isolate', async () => {
  let release!:()=>void;
  const gate=new Promise<void>(resolve => {release=resolve;});
  mockedFetch(async call => {
    if(call.url.includes('huggingface.co')) {
      if(call.headers.has('range')) return new Response('a',{status:206,headers:{'content-range':'bytes 0-0/5','content-length':'1'}});
      await gate;
      return new Response('audio',{headers:{'content-length':'5'}});
    }
    if(call.method==='HEAD') return new Response(null,{status:404});
    if(call.method==='PUT') return new Response(null,{status:201});
    return new Response(xmlListing());
  });
  const jobs:Promise<unknown>[]=[];
  try {
    for(let i=0;i<5;i++) {
      const result=await onRequestGet({request:audioRequest(`bounded-warm-${i}.mp3`,{Range:'bytes=0-0'}),env:completeEnv,waitUntil:job => jobs.push(job)});
      expect(await result.text()).toBe('a');
    }
    expect(jobs).toHaveLength(4);
  } finally {
    release();
    await Promise.all(jobs);
  }
  expect(calls.filter(call => call.method==='PUT')).toHaveLength(4);
  expect(calls.filter(call => call.method==='PUT').every(call => decodeURIComponent(new URL(call.url).pathname).includes('aura-cache/v2/'))).toBe(true);
});

test.describe('bounded audio buffers and OCI signing', () => {
  test('unknown-length oversized streams are canceled at the memory limit', async () => {
    let canceled = false;
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        if (chunks <= 30) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    expect(await readBoundedAudio(new Response(stream))).toBeNull();
    expect(canceled).toBe(true);
    expect(chunks).toBe(26);
  });

  test('declared oversized or truncated audio is not cached', async () => {
    expect(await readBoundedAudio(new Response('tiny', { headers: { 'Content-Length': String(26 * 1024 * 1024) } }))).toBeNull();
    expect(await readBoundedAudio(new Response('truncated', { headers: { 'Content-Length': '100' } }))).toBeNull();
    const valid = await readBoundedAudio(new Response('abc', { headers: { 'Content-Length': '3' } }));
    expect(new TextDecoder().decode(valid!)).toBe('abc');
  });

  test('SigV4 signs the encoded path/query deterministically, preserving literal URI characters', async () => {
    const path = 'Album/A+B ?#& [%2E] (live)!.opus';
    const signed = await signOciS3Request('GET', path, fakeConfig, { range: 'bytes=0-3' }, undefined, {
      now: new Date('2026-01-02T03:04:05Z'), query: { marker: 'A+B ?#', 'encoding-type': 'url' },
    });
    const expectedPath = '/unit-cache/Album/A%2BB%20%3F%23%26%20%5B%252E%5D%20%28live%29%21.opus';
    const expectedQuery = 'encoding-type=url&marker=A%2BB%20%3F%23';
    const url = new URL(signed.url);
    expect(url.pathname).toBe(expectedPath);
    expect(url.search).toBe(`?${expectedQuery}`);
    expect(url.hash).toBe('');
    const emptyHash = createHash('sha256').update('').digest('hex');
    const amzDate = '20260102T030405Z';
    const host = 'unitnamespace.compat.objectstorage.unit-region-1.oraclecloud.com';
    const signedHeaders = 'host;range;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = `host:${host}\nrange:bytes=0-3\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${amzDate}\n`;
    const canonicalRequest = `GET\n${expectedPath}\n${expectedQuery}\n${canonicalHeaders}\n${signedHeaders}\n${emptyHash}`;
    const scope = '20260102/unit-region-1/s3/aws4_request';
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
    const kDate = createHmac('sha256', `AWS4${fakeConfig.secretKey}`).update('20260102').digest();
    const kRegion = createHmac('sha256', kDate).update(fakeConfig.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    expect(signed.headers.Authorization).toBe(`AWS4-HMAC-SHA256 Credential=${fakeConfig.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
    await expect(signOciS3Request('GET', '../outside.mp3', fakeConfig)).rejects.toThrow('Invalid object key');
  });

  test('XML decoding preserves plus and percent keys and handles explicitly URL-encoded listings', () => {
    const raw = '<ListBucketResult><Contents><Key>A+B 10% &amp; &#35;.opus</Key><Size>4</Size></Contents></ListBucketResult>';
    expect(parseS3ListObjectsXml(raw)[0].key).toBe('A+B 10% & #.opus');
    const encoded = xmlListing(['A+B 10% ?#&.opus']);
    expect(parseS3ListObjectsXml(encoded)[0].key).toBe('A+B 10% ?#&.opus');
  });

  test('listing follows signed pagination markers without leaking keys into a query', async () => {
    mockedFetch((call) => {
      const url = new URL(call.url);
      if (!url.searchParams.has('marker')) return new Response(xmlListing(['first +?#.mp3'], '<IsTruncated>true</IsTruncated>'));
      expect(url.searchParams.get('marker')).toBe('first +?#.mp3');
      return new Response(xmlListing(['second.opus'], '<IsTruncated>false</IsTruncated>'));
    });
    const objects = await listOciObjects(fakeConfig);
    expect(objects.map((object) => object.key)).toEqual(['first +?#.mp3', 'second.opus']);
    expect(calls).toHaveLength(2);
  });

  test('capacity failure never removes non-audio objects or permits another write', async () => {
    mockedFetch((call) => {
      if (call.method === 'DELETE') {
        expect(decodeURIComponent(new URL(call.url).pathname)).toContain('owned-audio.mp3');
        return new Response('denied', { status: 403 });
      }
      return new Response(xmlListing(['private-notes.txt', 'owned-audio.mp3']));
    });
    const result = await pruneOciBucketToLimit(fakeConfig, 1);
    expect(result.hasCapacity).toBe(false);
    expect(result.remainingCount).toBe(1);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });
});
