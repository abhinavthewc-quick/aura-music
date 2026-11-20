import { expect,test,type Page } from '@playwright/test';
import { seedAura } from './fixtures';

async function seedAdmin(page:Page) {
  const evidence=await seedAura(page);
  await page.evaluate(()=>localStorage.removeItem('auraSession_v2'));
  const time=Math.floor(Date.now()/1000),requests:any[]=[];
  const tracks=Array.from({length:46},(_,index)=>{
    const key=String(index).padStart(11,'0');
    const status=index===0?'ready':index===1?'failed':index===2?'processing':index===3?'expired':'pending';
    const version=(mode:string)=>({status:status==='expired'?'processing':status,path:status==='ready'?`versions/${key}/${mode}.mp3`:null,duration:status==='ready'?200:null,bytes:status==='ready'?8000000:null,sha256:status==='ready'?'a'.repeat(64):null,recipe:status==='ready'?'aubatch-test-recipe':null,attempts:index===1?3:1,retry_after:index===1?time+300:0,last_error:index===1?'OSError: Too many open files <unsafe>':null,updated_at:time});
    return {ref:`video:${key}`,original_id:`hf:Artist - Song ${index} [${key}].opus`,original_path:`originals/Artist - Song ${index} [${key}].opus`,original_hash:'b'.repeat(64),storage_key:key,active:true,lease_until:index===2?time+3600:index===3?time-1:0,updated_at:time,stage:index===2?'uploading':null,stage_updated_at:index===2?time:null,status,versions:{bass:version('bass'),'bass-reverb':version('bass-reverb')}};
  });
  let failure=0;
  const overview=()=>({tracks,at:time,last_sync:time,counts:{total:46,ready:tracks.filter(t=>t.status==='ready').length,pending:tracks.filter(t=>t.status==='pending').length,processing:tracks.filter(t=>t.status==='processing').length,failed:tracks.filter(t=>t.status==='failed').length,expired:tracks.filter(t=>t.status==='expired').length,inactive:0},versions:{ready:2,pending:84,processing:4,failed:2,bytes:16000000},runs:[{host:'Fixture Mac',status:'running',parallelism:4,heartbeat_at:time,started_at:time,recipe:'aubatch-test-recipe'}],events:[{id:1,actor:'Fixture admin',action:'retry',message:'Queued an interrupted song',created_at:time}]});
  await page.context().route('**/api/admin',async route=>{
    const body=route.request().postDataJSON();requests.push(body);
    if(body.action==='login')return route.fulfill({json:{email:'abhinavthewc@gmail.com',token:'v1.isolated-admin-fixture',exp:time+86400}});
    if(body.action==='audioOverview')return route.fulfill({status:failure || 200,json:failure?{error:failure===401?'Fixture session expired':'Processing database unavailable'}:overview()});
    if(body.action==='audioJob')return route.fulfill({json:{track:tracks.find(t=>t.ref===body.ref),at:time,events:[{id:2,actor:'Mac worker',action:'failed',message:'Previous upload error',created_at:time}]}});
    if(['audioRetry','audioRecover','audioRegenerate'].includes(body.action)){
      const targets=tracks.filter(t=>body.refs?.includes(t.ref)||body.all&&(body.action==='audioRecover'?t.status==='expired':t.status==='failed'));
      for(const target of targets){target.status='pending';for(const [mode,v] of Object.entries(target.versions))if(body.action==='audioRegenerate'?mode===body.mode:v.status!=='ready')v.status='pending';}
      return route.fulfill({json:{ok:true,queued:targets.length,skipped:0}});
    }
    if(body.action==='runs')return route.fulfill({json:{runs:[]}});
    if(body.action==='libraryIds')return route.fulfill({json:{ids:[]}});
    if(body.action==='library')return route.fulfill({json:{files:[],manifest:{v:1,tracks:{}},artists:{}}});
    return route.fulfill({json:{secrets:[],ok:true}});
  });
  await page.goto('/admin.html');
  await page.getByRole('textbox',{name:'Email address',exact:true}).fill('abhinavthewc@gmail.com');
  await page.getByLabel('Password',{exact:true}).fill('isolated-fixture-password');
  await page.locator('#admPasswordBtn').click();
  await expect(page.locator('#admTabs')).toBeVisible();
  await page.getByRole('button',{name:'Audio processing',exact:true}).click();
  await expect(page.locator('#audioStatus')).toContainText('46 songs registered');
  return {evidence,requests,tracks,fail:(status:number)=>{failure=status;}};
}

for(const width of [390,1440])test(`processing Admin has searchable version records and usable song details at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:950});
  const fixture=await seedAdmin(page);
  await expect(page.locator('body')).toHaveCSS('background-color','rgb(0, 0, 0)');
  await expect(page.locator('#audioWorkerInfo')).toContainText('Fixture Mac: reporting');
  await expect(page.locator('#audioCoverageText')).toContainText('2 / 92');
  await expect(page.locator('#audioJobs tbody tr')).toHaveCount(40);
  await page.screenshot({path:`/private/tmp/audio-admin-fixture-${width}.png`,fullPage:true});
  await page.locator('#audioNext').click();await expect(page.locator('#audioJobs tbody tr')).toHaveCount(6);
  await page.locator('#audioSearch').fill('Too many open files');
  await expect(page.locator('#audioJobs tbody tr')).toHaveCount(1);
  await expect(page.locator('#audioJobs')).toContainText('<unsafe>');
  expect(await page.locator('#audioJobs unsafe').count()).toBe(0);
  await page.getByRole('button',{name:'Inspect Song 1',exact:true}).click();
  await expect(page.locator('#audioInspector')).toBeVisible();
  await expect(page.locator('#audioInspector')).toContainText('Attempts');
  await expect(page.locator('#audioInspector')).toContainText('Too many open files');
  await expect(page.locator('#audioInspector')).toContainText('Previous upload error');
  expect(await page.locator('#audioInspector').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:`/private/tmp/audio-admin-inspector-${width}.png`});
  await page.keyboard.press('Escape');await expect(page.locator('#audioInspector')).not.toBeVisible();
  await page.locator('#audioSearch').fill('');await page.locator('#audioFilter').selectOption('processing');
  await expect(page.locator('#audioJobs')).toContainText('Uploading');
  await expect(page.locator('#audioJobs input[type=checkbox]')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(fixture.evidence.pageErrors).toEqual([]);
});

test('Admin queues failures, regenerates only a chosen version, exports CSV and closes protected views on sign-out',async({page})=>{
  const fixture=await seedAdmin(page);
  page.on('dialog',dialog=>dialog.accept());
  await page.locator('#audioRetryFailed').click();
  await expect.poll(()=>fixture.requests.some(r=>r.action==='audioRetry'&&r.all)).toBe(true);
  await expect(page.locator('#audioRetryFailed')).toBeDisabled();
  await page.locator('#audioFilter').selectOption('ready');
  await page.getByRole('button',{name:'Inspect Song 0',exact:true}).click();
  await expect(page.locator('#audioInspector')).toContainText('aubatch-test-recipe');
  await expect(page.locator('#audioInspector')).toContainText('Not queued');
  await page.getByRole('button',{name:'Regenerate Bass',exact:true}).click();
  await expect.poll(()=>fixture.requests.some(r=>r.action==='audioRegenerate'&&r.mode==='bass')).toBe(true);
  const mutation=fixture.requests.find(r=>r.action==='audioRegenerate');expect(mutation.refs).toEqual([fixture.tracks[0].ref]);
  expect(fixture.tracks[0].versions['bass-reverb'].status).toBe('ready');
  await page.getByRole('button',{name:'Close song details',exact:true}).click();
  await page.locator('#audioFilter').selectOption('all');
  const download=page.waitForEvent('download');await page.locator('#audioExport').click();
  expect((await download).suggestedFilename()).toMatch(/^aura-processing-.*\.csv$/);
  await page.getByRole('button',{name:'Inspect Song 0',exact:true}).click();
  await page.keyboard.press('Escape');await page.locator('#signOutBtn').click();
  await expect(page.locator('#panelProcessing')).toBeHidden();await expect(page.locator('#gateCard')).toBeVisible();
  await expect(page.locator('#audioInspector')).not.toBeVisible();
  expect(fixture.evidence.pageErrors).toEqual([]);
});

test('refresh failures retain the last snapshot and expired authentication hides all processing details',async({page})=>{
  const fixture=await seedAdmin(page);
  fixture.fail(503);await page.locator('#audioRefresh').click();
  await expect(page.locator('#audioStatus')).toContainText('Showing the last successful snapshot');
  await expect(page.locator('#audioJobs tbody tr')).toHaveCount(40);
  fixture.fail(401);await page.locator('#audioRefresh').click();
  await expect(page.locator('#gateCard')).toBeVisible();await expect(page.locator('#panelProcessing')).toBeHidden();
  await expect(page.locator('#audioJobs tbody tr')).toHaveCount(0);
  expect(fixture.evidence.pageErrors).toEqual([]);
});
