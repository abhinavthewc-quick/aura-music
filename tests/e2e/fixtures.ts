import { expect, type Page } from '@playwright/test';

export function silentAudio(seconds = 60): Buffer {
  const data = Buffer.alloc(44 + seconds * 8000 * 2);
  data.write('RIFF',0); data.writeUInt32LE(data.length - 8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(8000,24); data.writeUInt32LE(16000,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34);
  data.write('data',36); data.writeUInt32LE(data.length - 44,40);
  return data;
}
export const tracks: any[] = [
  {id:1,title:'Alpha',artist:'Aura Test',album:'Midnight',duration:60,url:'/__test__/audio/1.wav',img:'/aura-logo.png',isHf:false},
  {id:2,title:'Beta',artist:'Aura Test',album:'Midnight',duration:60,url:'/__test__/audio/2.wav',img:'/aura-thumbnail.png',isHf:false},
  {id:3,title:'Gamma',artist:'Second Artist',album:'After Hours',duration:60,url:'/__test__/audio/3.wav',img:'/aura-vinyl-logo.png',isHf:false},
  {id:4,title:'Delta',artist:'Second Artist',album:'After Hours',duration:60,img:'/aura-logo.png',isHf:false,isLocal:true},
];
export const legacyPlaylists = [
  {id:'p1',title:'Night test',description:'Primary fixture',privacy:'Private',year:2026,createdAt:1,tracks:['lk:gamma|second artist','lk:alpha|aura test']},
  {id:'p2',title:'Second queue',description:'Context fixture',privacy:'Private',year:2026,createdAt:2,tracks:['lk:beta|aura test','lk:delta|second artist']},
  {id:'p3',title:'Recovery',description:'Missing track fixture',privacy:'Private',year:2026,createdAt:3,tracks:['lk:lost song|unknown artist']},
];

export async function seedAura(page: Page, options: {missingLocal?:boolean; fallbackLock?:boolean} = {}) {
  const audio = silentAudio();
  const lyricsRequests: string[] = [], pageErrors: string[] = [];
  page.on('pageerror',(error) => pageErrors.push(error.message));
  await page.context().route('**/*',async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__test__/seed') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Isolated test fixture</body></html>'});
    if (url.pathname.startsWith('/__test__/audio/')) {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]),audio.length - 1) : audio.length - 1;
        return route.fulfill({status:206,contentType:'audio/wav',headers:{'content-range':`bytes ${start}-${end}/${audio.length}`,'accept-ranges':'bytes'},body:audio.subarray(start,end + 1)});
      }
      return route.fulfill({contentType:'audio/wav',headers:{'accept-ranges':'bytes'},body:audio});
    }
    if (url.hostname === 'huggingface.co') return route.fulfill({contentType:'application/json',body:url.pathname.includes('manifest.json') ? '{}' : '[]'});
    if (/betterlyrics|binilyrics|musixmatch|lrclib|subtitles-for-youtube/.test(url.hostname)) {
      lyricsRequests.push(url.href);
      if (url.hostname === 'lrclib.net' && url.pathname.endsWith('/get')) {
        const title = url.searchParams.get('track_name') || 'Track';
        return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({syncedLyrics:`[00:00.00]${title} first line\n[00:05.00]${title} second line\n[00:10.00]${title} final line`,plainLyrics:`${title} first line`})});
      }
      return route.fulfill({status:404,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'{}'});
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.fulfill({status:404,body:''});
    if (url.pathname.startsWith('/api/')) return route.fulfill({status:503,contentType:'application/json',body:'{"error":"offline fixture; service not configured"}'});
    return route.continue();
  });
  await page.context().addInitScript(({fallbackLock}) => {
    const actions: Record<string,any> = {};
    Object.defineProperty(navigator,'mediaSession',{configurable:true,value:{metadata:null,playbackState:'none',setActionHandler:(name:string,callback:any) => { actions[name] = callback; }}});
    (window as any).__mediaActions = actions;
    if (fallbackLock) Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
  },{fallbackLock:options.fallbackLock});
  await page.goto('/__test__/seed');
  await page.evaluate(async ({songs,playlists,audioBase64,missingLocal}) => {
    localStorage.clear();
    localStorage.setItem('auraSession_v2',JSON.stringify({email:'audit@example.com',name:'Audit Listener',picture:'',exp:Math.floor(Date.now()/1000)+86400,token:'local:audit'}));
    localStorage.setItem('auraUserName','Audit Listener');
    if (missingLocal) {
      songs.push({id:'local-missing',title:'Missing file',artist:'My device',duration:60,isLocal:true,img:'/aura-logo.png'});
      playlists.push({id:'p4',title:'Local recovery',description:'',privacy:'Private',year:2026,createdAt:4,tracks:['lk:missing file|my device']});
    }
    localStorage.setItem('addedTracks',JSON.stringify(songs));
    localStorage.setItem('auraHfCatalog_v1',JSON.stringify({tracks:[],at:Date.now()}));
    localStorage.setItem('auraPlaylists',JSON.stringify(playlists));
    localStorage.setItem('auraTheme','dark');
    const bytes = Uint8Array.from(atob(audioBase64),(character) => character.charCodeAt(0));
    await new Promise<void>((resolve,reject) => {
      const request = indexedDB.open('auraMusicDB',1);
      request.onupgradeneeded = () => request.result.createObjectStore('audioFiles');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('audioFiles','readwrite');
        transaction.objectStore('audioFiles').put(new Blob([bytes],{type:'audio/wav'}),4);
        transaction.oncomplete = () => {db.close();resolve();}; transaction.onerror = () => reject(transaction.error);
      };
    });
  },{songs:tracks.map((track) => ({...track})),playlists:legacyPlaylists.map((playlist) => ({...playlist,tracks:[...playlist.tracks]})),audioBase64:audio.toString('base64'),missingLocal:options.missingLocal});
  await page.goto('/');
  await expect(page.locator('#welcomeScreen')).toHaveClass(/hidden/);
  await page.waitForFunction(() => !!(globalThis as any).openPlaylistPage && !!(globalThis as any).state?.songs?.length);
  // The intro removes itself; dismiss it only if it is still mounted.
  await page.evaluate(() => document.getElementById('auraLoader')?.click());
  await expect(page.locator('#auraLoader')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('auraPlaylists') || '{}').version)).toBe(2);
  return {lyricsRequests,pageErrors};
}

export const currentTitle = (page: Page): Promise<string> => page.evaluate(() => (globalThis as any).state.activeTrack?.title || '');
export const store = (page: Page): Promise<any> => page.evaluate(() => JSON.parse(localStorage.getItem('auraPlaylists') || '{}'));
export async function openPlaylist(page: Page,id = 'p1') { await page.evaluate((id) => (globalThis as any).openPlaylistPage(id),id); }
export async function resetPosition(page: Page) { await page.evaluate(() => {(globalThis as any).state.audio.currentTime=0;}); }

export async function mockYouTube(page: Page) {
  await page.evaluate(() => {
    const players: any[] = [];
    const states = {PLAYING:1,PAUSED:2,ENDED:0};
    (window as any).__youtubePlayers = players;
    (window as any).YT = {PlayerState:states,Player:class {
      options:any; time=0; state=2;
      constructor(_host:string,options:any) { this.options=options;players.push(this);queueMicrotask(() => options.events.onReady({target:this})); }
      getPlayerState(){return this.state;}
      getCurrentTime(){return this.time;}
      getDuration(){return 60;}
      seekTo(time:number){this.time=time;}
      playVideo(){this.state=1;this.options.events.onStateChange({data:1});}
      pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}
      stopVideo(){this.state=2;}
      destroy(){}
      setVolume(){}
    }};
  });
}
