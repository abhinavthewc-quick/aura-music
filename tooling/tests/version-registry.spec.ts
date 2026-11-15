import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequestGet, onRequestPost } from '../../functions/api/versions';
import type { RegistryEnv, VersionDatabase } from '../../functions/lib/version-registry';

const token = 'test-worker-token-with-at-least-thirty-two-characters';
const sourcePath = 'originals/Artist - Song [abcdefghijk].opus';
const ref = 'video:abcdefghijk';
const track = {ref, original_id:'hf:Artist - Song [abcdefghijk].opus', original_path:sourcePath, storage_key:'abcdefghijk'};
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

function database(): {db: DatabaseSync; adapter: VersionDatabase} {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../migrations/002_audio_versions.sql',import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../migrations/003_audio_processing_admin.sql',import.meta.url), 'utf8'));
  const statement = (sql: string, values: any[] = []): any => ({
    bind: (...args: any[]) => statement(sql, args),
    all: async () => ({results:db.prepare(sql).all(...values), meta:{changes: Number(db.prepare('SELECT changes() AS n').get().n)}}),
    run: async () => ({meta:{changes:Number(db.prepare(sql).run(...values).changes)}}),
    first: async () => db.prepare(sql).get(...values) || null,
  });
  return {db, adapter:{prepare:statement, batch:async statements => {
    db.exec('BEGIN');
    try {
      const results = [];
      for (const query of statements) results.push(await query.all());
      db.exec('COMMIT');
      return results;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }}};
}

function harness(bucket: string) {
  const {db, adapter} = database();
  const env: RegistryEnv = {VERSION_DB:adapter, VERSION_WORKER_TOKEN:token, HF_BUCKET_ID:`test/${bucket}`};
  const originalFetch = globalThis.fetch;
  let sourceHash = 'a'.repeat(64);
  const files = new Map<string, any>([
    [sourcePath,{type:'file',path:sourcePath,size:100,xetHash:sourceHash}],
    ['versions/bass/abcdefghijk.mp3',{type:'file',path:'versions/bass/abcdefghijk.mp3',size:200,xetHash:'b'.repeat(64)}],
    ['versions/abcdefghijk/bass.mp3',{type:'file',path:'versions/abcdefghijk/bass.mp3',size:200,xetHash:'b'.repeat(64)}],
    ['versions/abcdefghijk/bass-reverb.mp3',{type:'file',path:'versions/abcdefghijk/bass-reverb.mp3',size:300,xetHash:'c'.repeat(64)}],
  ]);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/tree?')) return Response.json([...files.values()]);
    const path = url.split('/resolve/')[1];
    const file = files.get(path);
    return new Response(null,{status:file ? 200 : 404,headers:file ? {'content-length':String(file.size)} : {}});
  };
  const call = (action: string, fields: any = {}, credential = token) => onRequestPost({env, request:new Request('https://aura.test/api/versions', {
    method:'POST',headers:{authorization:`Bearer ${credential}`},body:JSON.stringify({action,...fields}),
  })});
  return {db,env,files,call, public:async () => (await onRequestGet({env,request:new Request('https://aura.test/api/versions')})).json(),
    close:() => {globalThis.fetch = originalFetch;db.close();}};
}

test('private mutations require the worker token and public reads reveal only ready files', async () => {
  const h = harness('auth');
  try {
    expect((await h.call('sync',{tracks:[track]},'wrong')).status).toBe(401);
    expect((await h.call('sync',{tracks:[track]})).status).toBe(200);
    expect((await h.public()).tracks).toEqual({});
    expect((await h.call('sync',{tracks:[{...track,versions:{bass:{path:'https://evil.test/file.mp3'}}}]})).status).toBe(200);
    expect((await h.public()).tracks).toEqual({});
    expect((await h.call('sync',{tracks:[{...track,original_path:'../song.opus'}]})).status).toBe(400);
    expect((await h.call('sync',{tracks:[{...track,ref:'video:XXXXXXXXXXX'}]})).status).toBe(400);
    const body = await (await h.call('status')).json();
    expect(body.tracks).toBe(1);
    expect(body.renditions).toEqual([{status:'pending',count:2}]);
  } finally {h.close();}
});

test('a lease prevents duplicate jobs, resumes after expiry, and rejects the old owner', async () => {
  const h = harness('leases');
  try {
    await h.call('sync',{tracks:[track]});
    const claim = await (await h.call('claim',{owner,limit:1})).json();
    expect(claim.tracks[0].missing).toEqual(['bass','bass-reverb']);
    expect((await (await h.call('claim',{owner:other,limit:1})).json()).tracks).toEqual([]);
    expect((await h.call('heartbeat',{ref,owner:other})).status).toBe(409);
    expect((await h.call('heartbeat',{ref,owner})).status).toBe(200);
    h.db.exec('UPDATE audio_tracks SET lease_until = 0');
    expect((await (await h.call('claim',{owner:other,limit:1})).json()).tracks).toHaveLength(1);
    expect((await h.call('fail',{ref,owner,error:'stale failure'})).status).toBe(409);
    expect((await h.call('fail',{ref,owner:other,error:'render failed'})).status).toBe(200);
    expect((await (await h.call('claim',{owner,limit:1})).json()).tracks).toHaveLength(0);
    expect(h.db.prepare('SELECT attempts, last_error FROM audio_renditions WHERE mode = ?').get('bass'))
      .toMatchObject({attempts:2,last_error:'render failed'});
  } finally {h.close();}
});

test('publication verifies uploaded bytes and preserves an already-ready partner', async () => {
  const h = harness('publish');
  try {
    await h.call('sync',{tracks:[{...track,versions:{bass:{path:'versions/bass/abcdefghijk.mp3',duration:60}}}]});
    const claim = await (await h.call('claim',{owner,limit:1})).json();
    expect(claim.tracks[0].missing).toEqual(['bass-reverb']);
    const file = {path:'versions/abcdefghijk/bass-reverb.mp3',bytes:301,duration:62,sha256:'d'.repeat(64),recipe:'test-aubatch'};
    expect((await h.call('complete',{ref,owner,versions:{'bass-reverb':file}})).status).toBe(409);
    expect((await h.public()).tracks[ref]).toEqual({bass:{path:'versions/bass/abcdefghijk.mp3',duration:60}});
    expect((await h.call('complete',{ref,owner,versions:{'bass-reverb':{...file,bytes:300}}})).status).toBe(200);
    expect((await h.public()).tracks[ref]['bass-reverb'].path).toBe(file.path);
    expect((await (await h.call('claim',{owner:other,limit:1})).json()).tracks).toEqual([]);
    expect((await h.call('complete',{ref,owner,versions:{'bass-reverb':{...file,bytes:300}}})).status).toBe(409);
  } finally {h.close();}
});

test('a changed original invalidates its versions and missing files are reconciled from the full archive', async () => {
  const h = harness('changes');
  try {
    await h.call('sync',{tracks:[{...track,versions:{bass:{path:'versions/bass/abcdefghijk.mp3'}}}]});
    h.files.set(sourcePath,{...h.files.get(sourcePath),xetHash:'e'.repeat(64)});
    await h.call('reconcile');
    await h.call('sync',{tracks:[track]});
    expect((await h.public()).tracks).toEqual({});
    h.files.delete(sourcePath);
    await h.call('reconcile');
    expect(h.db.prepare('SELECT active FROM audio_tracks').get().active).toBe(0);
    expect((await (await h.call('claim',{owner,limit:1})).json()).tracks).toEqual([]);
  } finally {h.close();}
});

test('relocation switches database paths only when the old and new files have identical content', async () => {
  const h = harness('relocation');
  try {
    await h.call('sync',{tracks:[{...track,versions:{bass:{path:'versions/bass/abcdefghijk.mp3'}}}]});
    const file = {ref,mode:'bass',path:'versions/abcdefghijk/bass.mp3'};
    h.files.set(file.path,{...h.files.get(file.path),xetHash:'f'.repeat(64)});
    expect((await h.call('relocate',{files:[file]})).status).toBe(409);
    h.files.set(file.path,{...h.files.get(file.path),xetHash:'b'.repeat(64)});
    expect((await h.call('relocate',{files:[file]})).status).toBe(200);
    expect((await h.public()).tracks[ref].bass.path).toBe(file.path);
    // An archive scan must never overwrite a published database path.
    await h.call('sync',{tracks:[{...track,versions:{bass:{path:'versions/bass/abcdefghijk.mp3'}}}]});
    expect((await h.public()).tracks[ref].bass.path).toBe(file.path);
  } finally {h.close();}
});

test('targeted imports never claim another pending song or a ready/leased song', async () => {
  const h = harness('targeted-import');
  try {
    const earlier = {...track,ref:'video:00000000000',original_id:'hf:Earlier [00000000000].opus',
      original_path:'originals/Earlier [00000000000].opus',storage_key:'00000000000'};
    h.files.set(earlier.original_path,{type:'file',path:earlier.original_path,size:100,xetHash:'a'.repeat(64)});
    await h.call('sync',{tracks:[earlier,track]});
    expect((await h.call('claimOne',{owner,limit:2,ref})).status).toBe(400);
    expect((await h.call('claimOne',{owner})).status).toBe(400);
    expect((await (await h.call('claimOne',{owner,ref:'video:XXXXXXXXXXX'})).json()).tracks).toEqual([]);
    const selected = await (await h.call('claimOne',{owner,ref})).json();
    expect(selected.tracks.map((item:any) => item.ref)).toEqual([ref]);
    expect((await (await h.call('claimOne',{owner:other,ref})).json()).tracks).toEqual([]);
    expect(h.db.prepare('SELECT lease_owner FROM audio_tracks WHERE ref=?').get(earlier.ref).lease_owner).toBeNull();
    const versions = Object.fromEntries(['bass','bass-reverb'].map(mode => [mode,{
      path:`versions/abcdefghijk/${mode}.mp3`,bytes:mode==='bass' ? 200 : 300,duration:60,sha256:'d'.repeat(64),recipe:'imported-preprocessed',
    }]));
    expect((await h.call('complete',{ref,owner,versions})).status).toBe(200);
    expect((await (await h.call('claimOne',{owner:other,ref})).json()).tracks).toEqual([]);
    expect((await (await h.call('claim',{owner:other})).json()).tracks[0].ref).toBe(earlier.ref);
  } finally {h.close();}
});
