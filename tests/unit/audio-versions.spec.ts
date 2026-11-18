import { expect, test } from '@playwright/test';
import { isAudioVersion, normalizeAudioVersions, parseAudioVersionsIndex, readAudioVersionPreference, resolveAudioVersion } from '../../src/core/audio-versions';
import { fetchHfCatalog, readCatalogCache } from '../../src/core/catalog';
import { stableTrackRef } from '../../src/core/track-identity';

test('versions attach to canonical identities and never substitute local/YouTube playback', () => {
  const song = {id:'hf:Artist - Song [abcdefghijk].opus', videoId:'abcdefghijk', isHf:true,
    audioVersions:{bass:{path:'versions/bass/abcdefghijk.mp3'}}};
  const ref = stableTrackRef(song);
  expect(resolveAudioVersion(song, 'bass')).toBe('bass');
  expect(resolveAudioVersion(song, 'bass-reverb')).toBe('original');
  expect(resolveAudioVersion({...song, isLocal:true}, 'bass')).toBe('original');
  expect(resolveAudioVersion({...song, isYouTube:true}, 'bass')).toBe('original');
  expect(resolveAudioVersion({...song, isHf:false}, 'bass')).toBe('original');
  expect(stableTrackRef(song)).toBe(ref);
});

test('index validation rejects external URLs, traversal, wrong modes and unsupported schemas', () => {
  for (const path of ['https://evil.example/audio.mp3', '/versions/bass/a.mp3', 'versions/bass/../a.mp3',
    'versions/bass//a.mp3', 'versions/bass/a\\b.mp3', 'versions/bass/a.html', 'versions/bass-reverb/a.mp3']) {
    expect(normalizeAudioVersions({bass:{path}})).toEqual({});
  }
  expect(parseAudioVersionsIndex({v:2, tracks:{'video:abcdefghijk':{bass:{path:'versions/bass/a.mp3'}}}}).tracks).toEqual({});
  expect(parseAudioVersionsIndex({v:1, tracks:{bad:{bass:{path:'versions/bass/a.mp3'}}}}).tracks).toEqual({});
  expect(normalizeAudioVersions({bass:{path:'versions/bass/a.mp3', duration:Infinity}})).toEqual({bass:{path:'versions/bass/a.mp3'}});
});

test('catalogue joins database versions and excludes variant audio and cached duplicates', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string,string>();
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{
    getItem:(key:string) => saved.get(key) || null, setItem:(key:string,value:string) => saved.set(key,value),
  }});
  const path = 'Artist - Song [abcdefghijk].opus';
  const versionPath = 'versions/bass/abcdefghijk.mp3';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/tree?')) return Response.json([
      {type:'file',path,size:100}, {type:'file',path:versionPath,size:200},
      {type:'file',path:'versions/bass/unindexed.mp3',size:200},
    ]);
    if (url === '/api/versions') return Response.json({v:1,source:'database',tracks:{'video:abcdefghijk':{
      bass:{path:versionPath}, 'bass-reverb':{path:'versions/bass-reverb/missing.mp3'},
    }}});
    return Response.json({v:1,tracks:{abcdefghijk:{t:'Song',a:'Artist'}}});
  };
  try {
    const songs = await fetchHfCatalog();
    expect(songs).toHaveLength(1);
    expect(songs[0].id).toBe(`hf:${path}`);
    expect(songs[0].audioVersions).toEqual({bass:{path:versionPath}});
    expect(songs[0].url).toContain(encodeURIComponent(path));
    saved.set('auraHfCatalog_v1', JSON.stringify({tracks:[...songs, {id:`hf:${versionPath}`, title:'Duplicate'}]}));
    expect(readCatalogCache()).toHaveLength(1);
    saved.set('auraAudioVersion_v1', 'bass-reverb');
    expect(readAudioVersionPreference()).toBe('bass-reverb');
    saved.set('auraAudioVersion_v1', 'constructor');
    expect(readAudioVersionPreference()).toBe('original');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as any).localStorage;
  }
});

test('database versions are authoritative and organized paths keep canonical song identities', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:() => null,setItem:() => {}}});
  const calls: string[] = [];
  const path = 'originals/Artist - Song.mp3', bass = 'versions/track-0123456789abcdef0123/bass.mp3';
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url === '/api/versions') return Response.json({v:1,source:'database',tracks:{'id:hf:Artist - Song.mp3':{bass:{path:bass}}}});
    if (url.includes('/tree?')) return Response.json([
      {type:'file',path,size:100}, {type:'file',path:'covers/Artist - Song.webp'}, {type:'file',path:bass,size:200},
    ]);
    return Response.json({});
  };
  try {
    const [song] = await fetchHfCatalog();
    expect(song.id).toBe('hf:Artist - Song.mp3');
    expect(stableTrackRef(song)).toBe('id:hf:Artist - Song.mp3');
    expect(song.artist).toBe('Artist'); expect(song.title).toBe('Song');
    expect(song.img).toContain('/covers/Artist%20-%20Song.webp');
    expect(song.hfPath).toBe(path);
    expect(song.audioVersions).toEqual({bass:{path:bass}});
    expect(calls.some(url => url.endsWith('versions.json'))).toBe(false);
    globalThis.fetch = async input => String(input) === '/api/versions' ? Response.json({v:1,source:'database',tracks:{}})
      : String(input).includes('/tree?') ? Response.json([{type:'file',path,size:100},{type:'file',path:bass,size:200}]) : Response.json({});
    expect((await fetchHfCatalog())[0].audioVersions).toEqual({});
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis,'localStorage',originalStorage);
    else delete (globalThis as any).localStorage;
  }
});

test('registry outages and malformed responses keep originals playable without fetching a JSON fallback', async () => {
  const originalFetch = globalThis.fetch;
  const path = 'originals/Artist - Song [abcdefghijk].opus';
  try {
    for (const failure of ['offline','unavailable','malformed','wrong-source']) {
      const calls:string[] = [];
      globalThis.fetch = async input => {
        const url = String(input); calls.push(url);
        if (url === '/api/versions') {
          if (failure === 'offline') throw new Error('offline');
          if (failure === 'unavailable') return new Response('',{status:503});
          if (failure === 'malformed') return Response.json({v:1,source:'database',tracks:[]});
          return Response.json({v:1,source:'legacy',tracks:{}});
        }
        if (url.includes('/tree?')) return Response.json([{type:'file',path,size:100}]);
        return Response.json({});
      };
      const [song] = await fetchHfCatalog();
      expect(song.id).toBe('hf:Artist - Song [abcdefghijk].opus');
      expect(song.url).toContain(encodeURIComponent(path));
      expect(song.audioVersions).toEqual({});
      expect(calls.some(url => url.endsWith('versions.json'))).toBe(false);
    }
  } finally {globalThis.fetch=originalFetch;}
});
