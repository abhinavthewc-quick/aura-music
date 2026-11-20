import { expect,test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequestPost as adminPost } from '../../functions/api/admin';
import { onRequestPost as workerPost } from '../../functions/api/versions';
import { publicVersions,type VersionDatabase } from '../../functions/lib/version-registry';

const email='abhinavthewc@gmail.com',owner='11111111-1111-4111-8111-111111111111';
const token='offline-test-worker-token-with-thirty-two-characters';
function harness() {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/002_audio_versions.sql','utf8'));
  db.exec(readFileSync('migrations/003_audio_processing_admin.sql','utf8'));
  const statement=(sql:string,values:any[]=[]):any=>({
    bind:(...args:any[])=>statement(sql,args),
    all:async()=>({results:db.prepare(sql).all(...values),meta:{changes:Number(db.prepare('SELECT changes() AS n').get().n)}}),
    first:async()=>db.prepare(sql).get(...values)||null,
    run:async()=>({meta:{changes:Number(db.prepare(sql).run(...values).changes)}}),
  });
  const adapter:VersionDatabase={prepare:statement,batch:async statements=>{
    db.exec('BEGIN');try{const result=[];for(const query of statements)result.push(await query.all());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }};
  const env={VERSION_DB:adapter,GH_TOKEN:'offline-github-signing-key',GOOGLE_CLIENT_ID:'',ADMIN_PASSWORD:'offline-password',VERSION_WORKER_TOKEN:token,BOT_SERVICE_TOKEN:'offline-bot-token'};
  let credential='';
  const call=(action:string,payload:any={},auth=credential)=>adminPost({env,request:new Request('https://aura.test/api/admin',{method:'POST',body:JSON.stringify({action,...payload,credential:auth})})});
  const login=async()=>{const response=await call('login',{email,password:env.ADMIN_PASSWORD});credential=(await response.json()).token;};
  const worker=(action:string,payload:any={})=>workerPost({env,request:new Request('https://aura.test/api/versions',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({action,...payload})})});
  const seed=(key:string,statuses=['pending','pending'],lease=0,active=1)=>{
    const ref=`video:${key}`,time=Math.floor(Date.now()/1000);
    db.prepare('INSERT INTO audio_tracks VALUES (?,?,?,?,?,?,?,?,?)').run(ref,`hf:Artist - ${key} [${key}].opus`,`originals/Artist - ${key} [${key}].opus`,'a'.repeat(64),key,active,lease?owner:null,lease,time);
    for(const [index,mode] of ['bass','bass-reverb'].entries())db.prepare(`INSERT INTO audio_renditions
      (track_ref,mode,status,path,duration,bytes,sha256,recipe,attempts,retry_after,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ref,mode,statuses[index],statuses[index]==='ready'?`versions/${key}/${mode}.mp3`:null,statuses[index]==='ready'?60:null,statuses[index]==='ready'?200:null,statuses[index]==='ready'?'b'.repeat(64):null,statuses[index]==='ready'?'recipe-v1':null,3,statuses[index]==='failed'?time+300:0,statuses[index]==='failed'?'Too many open files':null,time);
    return ref;
  };
  return {db,adapter,env,call,login,worker,seed,close:()=>db.close()};
}

test('processing administration uses real admin authentication and refuses bot/service credentials',async()=>{
  const h=harness();try{
    h.seed('abcdefghijk');
    expect((await h.call('audioOverview')).status).toBe(401);
    expect((await h.call('audioRetry',{all:true,service_token:h.env.BOT_SERVICE_TOKEN})).status).toBe(403);
    await h.login();const response=await h.call('audioOverview');
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
    const body=await response.json();expect(body.counts).toMatchObject({total:1,pending:1});
    expect(JSON.stringify(body)).not.toContain(token);expect(JSON.stringify(body)).not.toContain(owner);
    expect((await h.call('audioJob',{ref:'unknown'})).status).toBe(404);
  }finally{h.close();}
});

test('overview distinguishes complete, failed, pending, active, expired and unavailable songs',async()=>{
  const h=harness();try{
    const time=Math.floor(Date.now()/1000);
    h.seed('aaaaaaaaaaa',['ready','ready']);h.seed('bbbbbbbbbbb',['ready','failed']);
    h.seed('ccccccccccc');h.seed('ddddddddddd',['processing','processing'],time+300);
    h.seed('eeeeeeeeeee',['processing','processing'],time-1);h.seed('fffffffffff',['ready','ready'],0,0);
    await h.login();const body=await(await h.call('audioOverview')).json();
    expect(body.counts).toEqual({total:6,ready:1,failed:1,pending:1,processing:1,expired:1,inactive:1});
    expect(body.versions.ready).toBe(3);expect(body.versions.bytes).toBe(600);
  }finally{h.close();}
});

test('retry queues only unfinished versions, retains a ready partner and audits the admin',async()=>{
  const h=harness();try{
    const ref=h.seed('abcdefghijk',['ready','failed']);await h.login();
    expect((await h.call('audioRetry',{refs:[ref]})).status).toBe(200);
    expect(h.db.prepare('SELECT status,retry_after FROM audio_renditions WHERE mode=?').get('bass-reverb')).toMatchObject({status:'pending',retry_after:0});
    expect(h.db.prepare('SELECT status,path,bytes,recipe FROM audio_renditions WHERE mode=?').get('bass')).toMatchObject({status:'ready',bytes:200,recipe:'recipe-v1'});
    expect(h.db.prepare('SELECT actor,action FROM audio_processing_events').get()).toMatchObject({actor:email,action:'audioRetry'});
    expect((await h.call('audioRetry',{refs:[ref],mode:'invalid'})).status).toBe(200);
    expect((await h.call('audioRetry',{refs:[]})).status).toBe(400);
  }finally{h.close();}
});

test('active leases cannot be reset and bulk recovery affects only expired processing jobs',async()=>{
  const h=harness();try{
    const time=Math.floor(Date.now()/1000),active=h.seed('aaaaaaaaaaa',['processing','processing'],time+300);
    const expired=h.seed('bbbbbbbbbbb',['ready','processing'],time-1),failed=h.seed('ccccccccccc',['failed','failed']);
    await h.login();expect((await h.call('audioRetry',{refs:[active]})).status).toBe(409);
    const body=await(await h.call('audioRecover',{all:true})).json();expect(body.queued).toBe(1);
    expect(h.db.prepare('SELECT lease_until FROM audio_tracks WHERE ref=?').get(active).lease_until).toBe(time+300);
    expect(h.db.prepare('SELECT status FROM audio_renditions WHERE track_ref=? AND mode=?').get(expired,'bass')).toMatchObject({status:'ready'});
    expect(h.db.prepare('SELECT status FROM audio_renditions WHERE track_ref=? AND mode=?').get(failed,'bass')).toMatchObject({status:'failed'});
    const claim=await(await h.worker('claim',{owner,limit:4})).json();expect(claim.tracks.map(t=>t.ref)).toEqual([expired]);
  }finally{h.close();}
});

test('regeneration uses the inspected revision and removes only the chosen published version',async()=>{
  const h=harness();try{
    const ref=h.seed('abcdefghijk',['ready','ready']);await h.login();
    const time=Number(h.db.prepare('SELECT updated_at FROM audio_renditions WHERE mode=?').get('bass').updated_at);
    expect((await h.call('audioRegenerate',{refs:[ref],mode:'bass',expected_updated_at:time-1})).status).toBe(409);
    expect((await h.call('audioRegenerate',{refs:[ref],mode:'other',expected_updated_at:time})).status).toBe(400);
    expect((await h.call('audioRegenerate',{refs:[ref],mode:'bass',expected_updated_at:time})).status).toBe(200);
    expect((await publicVersions(h.adapter)).tracks[ref]).toEqual({'bass-reverb':{path:'versions/abcdefghijk/bass-reverb.mp3',duration:60,revision:expect.stringMatching(/^[a-f0-9]{64}-\d+$/)}});
    expect(h.db.prepare('SELECT original_path,active FROM audio_tracks').get()).toMatchObject({active:1,original_path:'originals/Artist - abcdefghijk [abcdefghijk].opus'});
  }finally{h.close();}
});

test('worker stages and run reports are lease checked and visible only through the admin view',async()=>{
  const h=harness();try{
    const ref=h.seed('abcdefghijk');await h.login();
    expect((await h.worker('runStarted',{owner,host:'Test Mac',parallelism:4,recipe:'test-recipe'})).status).toBe(200);
    await h.worker('claim',{owner,limit:1});
    expect((await h.worker('progress',{ref,owner,stage:'uploading'})).status).toBe(200);
    expect((await h.worker('progress',{ref,owner:'22222222-2222-4222-8222-222222222222',stage:'downloading'})).status).toBe(409);
    expect((await h.worker('progress',{ref,owner,stage:'anything'})).status).toBe(400);
    const body=await(await h.call('audioOverview')).json();expect(body.tracks[0].stage).toBe('uploading');expect(body.runs[0]).toMatchObject({host:'Test Mac',status:'running',parallelism:4});
    const before=h.db.prepare('SELECT COUNT(*) AS n FROM audio_processing_events').get().n;
    await h.worker('progress',{ref,owner,stage:'uploading'});expect(h.db.prepare('SELECT COUNT(*) AS n FROM audio_processing_events').get().n).toBe(before);
    await h.worker('fail',{ref,owner,error:'Upload unavailable'});
    await h.worker('runFinished',{owner,status:'failed',attempted:1,failed:1});
    const detail=await(await h.call('audioJob',{ref})).json();expect(detail.track.stage).toBe('failed');expect(detail.events.some(e=>e.message==='Upload unavailable')).toBe(true);
  }finally{h.close();}
});

test('archive checks change records only after a complete listing and retain present ready files',async()=>{
  const h=harness(),originalFetch=globalThis.fetch;try{
    const ref=h.seed('abcdefghijk',['ready','ready']);await h.login();
    globalThis.fetch=async()=>new Response(null,{status:503});
    expect((await h.call('audioReconcile')).status).toBe(502);
    expect((await publicVersions(h.adapter)).tracks[ref].bass.path).toBeTruthy();
    const originalPath='originals/Artist - abcdefghijk [abcdefghijk].opus';
    globalThis.fetch=async()=>Response.json([
      {type:'file',path:originalPath,size:100,xetHash:'a'.repeat(64)},
      {type:'file',path:'versions/abcdefghijk/bass.mp3',size:200,xetHash:'b'.repeat(64)},
    ]);
    expect((await h.call('audioReconcile')).status).toBe(200);
    expect((await publicVersions(h.adapter)).tracks[ref]).toEqual({bass:{path:'versions/abcdefghijk/bass.mp3',duration:60,revision:expect.stringMatching(/^[a-f0-9]{64}-\d+$/)}});
    expect(h.db.prepare('SELECT active FROM audio_tracks').get().active).toBe(1);
  }finally{globalThis.fetch=originalFetch;h.close();}
});
