import { AURA_JAMENDO_CLIENT_ID, AURA_YOUTUBE_API_KEY } from '../core/config';
import { fetchYouTubeMeta, stateHTML, toast } from '../core/dom';
import { songItemHTML, updateLibCount } from './library';
import { navClick } from '../ui/nav';
import { playSong, playYouTubeInsideAura, playYouTubeProResult } from './player';
import { escapeHtml } from './radio';
import { auraSettings } from './settings';
import { $, state } from '../core/state';
/* ===== 3097-3104 ===== */
    /* Jump into the Search tab pre-filtered to a category */
    export function goToSearchCategory(cat){
      searchCategory = cat;
      navClick($('navSearchBtn'), 'tabSearch');
      $('browseGrid').querySelectorAll('.browse-tile').forEach(t=>t.classList.toggle('active', t.dataset.filter===cat));
      filterSearchTab();
    }

/* ===== 4661-4668 ===== */
    /* Premium search: trending chips + clear button */
    export function runSearchChip(btn){ const i=$('searchTabInput'); i.value=btn.textContent.trim(); i.focus(); i.dispatchEvent(new Event('input')); }
    (function(){
      const i=$('searchTabInput'), w=$('searchBarWrap'), c=$('searchClearBtn'); if(!i||!w||!c) return;
      const sync=()=>w.classList.toggle('has-text',!!i.value);
      i.addEventListener('input',sync); sync();
      c.onclick=()=>{ i.value=''; sync(); i.focus(); i.dispatchEvent(new Event('input')); };
    })();
/* ===== 4992-5362 ===== */
    export function renderSearchResults(list){
      const c=$('searchResultsList');
      c.innerHTML=list.length?list.map(songItemHTML).join('') : stateHTML('noresults','No matches found','Check the spelling, or search online below for more songs.');
    }

    export let searchCategory='all';
    export const categoryLabels={all:'All Tracks', favorites:'Favorites', recent:'Recently Played', local:'Local Files'};

    export function songsForCategory(){
      if(searchCategory==='favorites') return state.songs.filter(s=>s.favorite);
      if(searchCategory==='local') return state.songs.filter(s=>s.isLocal);
      if(searchCategory==='recent') return state.recentlyPlayed.map(r=>state.songs.find(s=>s.id===r.id)).filter(Boolean);
      return state.songs;
    }

    /* ================================================================
       AURA MUSIC — YouTube search
       Primary route: Jina Reader -> real YouTube search page.
       This avoids Google API keys, dead Stremio add-ons, and unstable
       public Piped instances. Results are real YouTube video IDs; playback
       continues through AURA's existing YouTube IFrame player.
       ================================================================ */
    /* Multi-source search: a static HTML page cannot call the YouTube/Spotify/
       SoundCloud SEARCH APIs without provider credentials or a backend, so
       those three still open their official search page via the buttons
       below. Two keyless, CORS-friendly-via-JSONP engines now power instant
       in-app playback with real search:
         1) Apple's iTunes Search API — global catalog, no region-blocking,
            official documented `callback=` JSONP param for exactly this
            "search field on your website" use case, returns a 30s preview
            per track.
         2) Deezer's public search API — also keyless/JSONP, kept as a
            second source for extra coverage, but Deezer's preview CDN is
            known to be geo-restricted in some countries (e.g. India), so it
            is fetched in parallel and simply contributes nothing if it
            fails — iTunes results still show either way.
       YouTube/Spotify/SoundCloud still have no keyless *search*, so pasting
       a track/video link plays it inline instead (YouTube via the existing
       embedded player, Spotify/SoundCloud via their public keyless oEmbed
       widgets). */
    export let youtubeSearchToken = 0;
    export let auraYTQueue = [];
    export let lastOutsideResults = [];
    export let jsonpCounter = 0;
    export const MUSIC_SOURCES=[
      {name:'YouTube Music',icon:'fa-brands fa-youtube',build:q=>'https://music.youtube.com/search?q='+encodeURIComponent(q)},
      {name:'Spotify',icon:'fa-brands fa-spotify',build:q=>'https://open.spotify.com/search/'+encodeURIComponent(q)},
      {name:'SoundCloud',icon:'fa-brands fa-soundcloud',build:q=>'https://soundcloud.com/search?q='+encodeURIComponent(q)}
    ];
    export function renderMultiSourceButtons(query){
      const wrap=$('multiSourceSearchButtons'); if(!wrap) return;
      wrap.innerHTML=MUSIC_SOURCES.map(src=>`<button class="multi-source-btn" type="button" data-source-search="${escapeHtml(src.name)}"><i class="${src.icon}"></i><span>Find on ${escapeHtml(src.name)}</span></button>`).join('');
      wrap.querySelectorAll('[data-source-search]').forEach(btn=>btn.onclick=()=>{
        const src=MUSIC_SOURCES.find(x=>x.name===btn.dataset.sourceSearch); const q=$('searchTabInput').value.trim();
        if(!src||!q){toast('Type a song first','magnifying-glass');return;}
        window.open(src.build(q),'_blank','noopener');
      });
    }

    export function jsonpRequest(url){
      return new Promise<any>((resolve,reject)=>{
        const cbName='auraJsonp_'+(jsonpCounter++)+'_'+Date.now();
        const script=document.createElement('script');
        let done=false;
        function cleanup(){ delete window[cbName]; script.remove(); }
        window[cbName]=(data)=>{ done=true; cleanup(); resolve(data); };
        script.onerror=()=>{ if(!done){ done=true; cleanup(); reject(new Error('request failed')); } };
        script.src=url+(url.includes('?')?'&':'?')+'callback='+cbName;
        document.head.appendChild(script);
        setTimeout(()=>{ if(!done){ done=true; cleanup(); reject(new Error('request timed out')); } },8000);
      });
    }

    export async function searchItunes(query){
      const data=await jsonpRequest('https://itunes.apple.com/search?media=music&entity=song&limit=10&term='+encodeURIComponent(query));
      return (data && data.results || []).map(r=>({
        source:'itunes', id:r.trackId, title:r.trackName, artist:r.artistName||'Unknown Artist',
        img:(r.artworkUrl100||'').replace('100x100','300x300'), preview:r.previewUrl
      })).filter(t=>t.preview);
    }

    export async function searchDeezer(query){
      const data=await jsonpRequest('https://api.deezer.com/search?q='+encodeURIComponent(query)+'&output=jsonp');
      return (data && data.data || []).map(r=>({
        source:'deezer', id:r.id, title:r.title, artist:(r.artist&&r.artist.name)||'Unknown Artist',
        img:(r.album&&(r.album.cover_medium||r.album.cover_small))||'', preview:r.preview
      })).filter(t=>t.preview);
    }

    /* Audius — a free, keyless REST API for an open, independent music
       catalog. Unlike iTunes/Deezer, this returns a FULL track stream, not
       just a 30s clip, because it's an open/creator-owned network rather
       than a licensed commercial storefront. */
    export async function searchAudius(query){
      const res=await fetch('https://api.audius.co/v1/tracks/search?query='+encodeURIComponent(query)+'&app_name=AURA_MUSIC');
      if(!res.ok) throw new Error('Audius search failed');
      const data=await res.json();
      return (data && data.data || []).map(r=>({
        source:'audius', id:r.id, title:r.title, artist:(r.user&&r.user.name)||'Unknown Artist',
        img:(r.artwork&&(r.artwork['150x150']||r.artwork['480x480']))||'',
        preview:'https://api.audius.co/v1/tracks/'+r.id+'/stream?app_name=AURA_MUSIC', full:true
      }));
    }

    /* Jamendo — a catalog of independent artists releasing full tracks under
       Creative Commons licenses (free to stream/use non-commercially), not
       a 30s clip. Jamendo has no CORS support for browser fetch(), so this
       reuses the site's existing JSONP helper, same trick as iTunes/Deezer
       above. Needs a free client_id (Settings → Jamendo), otherwise it
       simply contributes nothing, same as YouTube without a key. */
    export async function searchJamendo(query){
      const clientId = localStorage.getItem('auraJamendoClientId') || AURA_JAMENDO_CLIENT_ID;
      if(!clientId) return [];
      const data = await jsonpRequest('https://api.jamendo.com/v3.0/tracks/?client_id='+encodeURIComponent(clientId)+'&format=jsonp&limit=10&search='+encodeURIComponent(query)+'&audioformat=mp32');
      if(data && data.headers && data.headers.status==='failed') throw new Error('Jamendo search failed');
      return (data && data.results || []).map(r=>({
        source:'jamendo', id:r.id, title:r.name, artist:r.artist_name||'Unknown Artist',
        img:r.image||'', preview:r.audio, full:true
      })).filter(t=>t.preview);
    }

    /* Internet Archive — the largest keyless library of free, openly
       licensed and public-domain state.audio on the web (14M+ items), including
       the Live Music Archive's 250,000+ concert tapes recorded with the
       performing artists' explicit permission. No key required at all.
       Each "item" can bundle several files, so the actual playable file is
       resolved lazily the first time a result is tapped — see
       resolveArchiveOrgTrack below — rather than up front for every result. */
    export async function searchArchiveOrg(query){
      const url='https://archive.org/advancedsearch.php?q='+encodeURIComponent(query+' AND mediatype:(audio)')+'&fl[]=identifier&fl[]=title&fl[]=creator&rows=10&page=1&output=json';
      const res=await fetch(url);
      if(!res.ok) throw new Error('Internet Archive search failed');
      const data=await res.json();
      const docs=(data && data.response && data.response.docs) || [];
      return docs.filter(d=>d.identifier).map(d=>({
        source:'archive', id:d.identifier,
        title:d.title||d.identifier,
        artist:(Array.isArray(d.creator)?d.creator[0]:d.creator)||'Internet Archive',
        img:'https://archive.org/services/img/'+encodeURIComponent(d.identifier), full:true
      }));
    }

    export const auraArchiveResolveCache={};
    export async function resolveArchiveOrgTrack(t){
      if(t.preview) return t.preview;
      if(auraArchiveResolveCache[t.id]){ t.preview=auraArchiveResolveCache[t.id]; return t.preview; }
      const res=await fetch('https://archive.org/metadata/'+encodeURIComponent(t.id));
      if(!res.ok) throw new Error('Could not load Internet Archive item');
      const data=await res.json();
      const files=(data && data.files) || [];
      const audioFile = files.find(f=>/vbr mp3/i.test(f.format||''))
        || files.find(f=>/mp3/i.test(f.format||'') || /\.mp3$/i.test(f.name||''))
        || files.find(f=>/ogg/i.test(f.format||'') || /\.ogg$/i.test(f.name||''));
      if(!audioFile) throw new Error('No playable audio file in this item');
      const url='https://archive.org/download/'+encodeURIComponent(t.id)+'/'+encodeURIComponent(audioFile.name);
      auraArchiveResolveCache[t.id]=url;
      t.preview=url;
      return url;
    }

    /* YouTube Music — official search + official embedded playback.
       A YouTube Data API key is required for in-app search. The result is
       played through YouTube's official IFrame Player API; AURA does not
       extract, download, cache, or separate YouTube state.audio streams. */
    export let auraYoutubeKeyInvalid = false;
    export async function searchYouTubeMusic(query){
      const key = localStorage.getItem('auraYoutubeApiKey') || AURA_YOUTUBE_API_KEY;
      if(!auraSettings.youtubeResults) return [];
      if(!key) return [];
      // Quota saver: repeat searches within 12h come from a local cache instead of costing 100 units each.
      const cKey=query.trim().toLowerCase(); let cache={};
      try{ cache=JSON.parse(localStorage.getItem('auraYtCache_v1')||'{}'); }catch(e){}
      if(cache[cKey] && Date.now()-cache[cKey].t < 12*3600*1000) return cache[cKey].items;
      const url='https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=8&q='+encodeURIComponent(query)+'&key='+encodeURIComponent(key);
      const res=await fetch(url);
      if(!res.ok){
        if(res.status===400||res.status===403) auraYoutubeKeyInvalid=true;
        throw new Error('YouTube search failed');
      }
      auraYoutubeKeyInvalid=false;
      const data=await res.json();
      const items=(data && data.items || []).filter(r=>r.id && r.id.videoId).map(r=>({
        source:'youtube', id:r.id.videoId, videoId:r.id.videoId,
        title:r.snippet.title, artist:r.snippet.channelTitle||'YouTube Music',
        img:(r.snippet.thumbnails && (r.snippet.thumbnails.medium||r.snippet.thumbnails.default)||{}).url||'', full:true
      }));
      try{
        cache[cKey]={t:Date.now(),items};
        const keys=Object.keys(cache); if(keys.length>40){ keys.sort((a,b)=>cache[a].t-cache[b].t).slice(0,keys.length-40).forEach(k=>delete cache[k]); }
        localStorage.setItem('auraYtCache_v1',JSON.stringify(cache));
      }catch(e){}
      return items;
    }

    /* Pasted YouTube link — works with NO api key */
    export async function youtubeLinkResult(query){
      const id=getYouTubeIdFromUrl(query.trim()); if(!id) return [];
      const { title, artist } = await fetchYouTubeMeta(id), img='https://i.ytimg.com/vi/'+id+'/mqdefault.jpg';
      return [{source:'youtube',id,videoId:id,title,artist,img,full:true}];
    }

    /* Openverse — open-licensed (Creative Commons) state.audio from many sources, full-length, no key */
    export async function searchOpenverse(query){
      const res=await fetch('https://api.openverse.org/v1/audio/?category=music&page_size=10&q='+encodeURIComponent(query));
      if(!res.ok) throw new Error('Openverse search failed');
      const data=await res.json();
      return (data && data.results || []).filter(r=>r.url).map(r=>({
        source:'openverse', id:r.id, title:r.title||'Untitled', artist:r.creator||'Unknown Artist',
        img:r.thumbnail||'', preview:r.url.replace(/^http:\/\//,'https://'), full:true
      }));
    }

    /* ccMixter — Creative Commons remixes & state.songs, full-length, no key */
    export async function searchCcMixter(query){
      const res=await fetch('https://ccmixter.org/api/query?f=json&limit=10&sort=rank&search_type=all&search='+encodeURIComponent(query));
      if(!res.ok) throw new Error('ccMixter search failed');
      const data=await res.json();
      return (Array.isArray(data)?data:[]).map(r=>{
        const file=(r.files||[]).find(x=>/mp3/i.test(x.download_url||'')) || (r.files||[])[0];
        if(!file||!file.download_url) return null;
        return { source:'ccmixter', id:r.upload_id, title:r.upload_name||'Untitled', artist:r.user_name||'ccMixter artist', img:'', preview:file.download_url.replace(/^http:\/\//,'https://'), full:true };
      }).filter(Boolean);
    }

    export function outsideResultRowHTML(t,i){
      const badge = t.source==='itunes' ? 'iTunes · 30s' : t.source==='deezer' ? 'Deezer · 30s'
        : t.source==='audius' ? 'Audius · Full song' : t.source==='jamendo' ? 'Jamendo · Full song'
        : t.source==='archive' ? 'Internet Archive · Full track' : t.source==='openverse' ? 'Openverse · Full track'
        : t.source==='ccmixter' ? 'ccMixter · Full track' : 'YouTube · Official player';
      return `<div class="song-row youtube-result-row" onclick="playOutsideResult(${i})" style="cursor:pointer">
        <img src="${escapeHtml(t.img)}" alt="" class="srch-cover">
        <div style="flex:1;min-width:0">
          <div class="song-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.title)}</div>
          <div class="song-artist" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.artist)}</div>
          <span class="src-pill ${/30s/.test(badge)?'preview':'full'}">${badge}</span>
        </div>
        <button class="song-item-icon-btn" style="flex-shrink:0"><i class="fa-solid fa-play"></i></button>
      </div>`;
    }

    export async function playOutsideResult(i){
      const t=lastOutsideResults[i];
      if(!t) return;
      if(t.source==='youtube'){
        auraYTQueue = lastOutsideResults.filter(x=>x && x.source==='youtube').map(x=>({
          ...x, id:x.videoId || x.id, videoId:x.videoId || x.id
        }));
        state.auraYTQueueIndex = auraYTQueue.findIndex(x=>String(x.id)===String(t.videoId||t.id));
        await playYouTubeProResult(t);
        return;
      }
      if(t.source==='archive' && !t.preview){
        toast('Loading from Internet Archive…','spinner');
        try{ await resolveArchiveOrgTrack(t); }
        catch(e){ toast('Could not load that Internet Archive item','triangle-exclamation'); return; }
      }
      if(!t.preview){ toast('No preview available for this track','triangle-exclamation'); return; }
      const uid=`${t.source}-${t.id}`;
      let idx=state.songs.findIndex(x=>x.id===uid);
      if(idx===-1){
        state.songs.push({id:uid,title:t.title,artist:t.artist,img:t.img,url:t.preview,favorite:false,isLocal:false,missing:false,isOutsidePreview:true});
        idx=state.songs.length-1;
      }
      playSong(idx);
      updateLibCount();
    }

    export let lastOnlineQuery='';
    export function retryOnlineSearch(){ if(lastOnlineQuery) searchYouTubePro(lastOnlineQuery); }
    export async function searchYouTubePro(query){
      const section=$('youtubeSearchSection'), list=$('youtubeSearchResults'), note=$('multiSourceSearchNote');
      if(!query){section.style.display='none'; if(list)list.innerHTML=''; return []}
      section.style.display='block'; renderMultiSourceButtons(query);
      const localWarning = (location.protocol==='file:')
        ? 'You are opening AURA as a local .html file. YouTube playback/search is most reliable when this page is hosted on HTTPS (for example GitHub Pages).'
        : '';
      const token=++youtubeSearchToken; lastOnlineQuery=query;
      const slowTimer=setTimeout(()=>{ if(token===youtubeSearchToken && list && list.querySelector('.aura-state-loading')) list.innerHTML=stateHTML('slow','Still searching…','Your connection seems slow. Results will appear as soon as they load.'); },7000);
      if(list)list.innerHTML=stateHTML('loading','Searching…');
      const hasYoutubeKey = !!(localStorage.getItem('auraYoutubeApiKey') || AURA_YOUTUBE_API_KEY);
      const hasJamendoKey = !!(localStorage.getItem('auraJamendoClientId') || AURA_JAMENDO_CLIENT_ID);
      if(note)note.textContent = hasYoutubeKey
        ? "YouTube results use the official YouTube embedded player. Audius"+(hasJamendoKey?", Jamendo":"")+" and Internet Archive provide their own playable streams; iTunes/Deezer provide short previews."
        : "Showing full-length results from Audius, Openverse, ccMixter and Internet Archive"+(hasJamendoKey?", Jamendo":"")+", plus iTunes/Deezer previews. Tip: paste any YouTube link into the search box to play it.";
      if(localWarning && note) note.textContent += '  ' + localWarning;
      const [itunesRes, deezerRes, audiusRes, jamendoRes, archiveRes, youtubeRes, openverseRes, ccmixterRes, ytLinkRes] = await Promise.allSettled([searchItunes(query), searchDeezer(query), searchAudius(query), searchJamendo(query), searchArchiveOrg(query), searchYouTubeMusic(query), searchOpenverse(query), searchCcMixter(query), youtubeLinkResult(query)]);
      clearTimeout(slowTimer);
      if(token!==youtubeSearchToken) return [];
      // Round-robin so every source shows up instead of one source filling the list
      const groups=[ytLinkRes,youtubeRes,audiusRes,jamendoRes,openverseRes,ccmixterRes,archiveRes,itunesRes,deezerRes].map(r=>r.status==='fulfilled'?r.value:[]);
      const merged=[]; const seen=new Set();
      for(let n=0;merged.length<30 && n<12;n++){
        groups.forEach(g=>{ const t=g[n]; if(t && merged.length<30 && !seen.has(t.source+':'+t.id)){ seen.add(t.source+':'+t.id); merged.push(t); } });
      }
      lastOutsideResults=merged;
      auraYTQueue = merged.filter(x=>x && x.source==='youtube').map(x=>({ ...x, id:x.videoId || x.id, videoId:x.videoId || x.id }));
      state.auraYTQueueIndex = -1;
      if(merged.length){
        list.innerHTML=merged.map(outsideResultRowHTML).join('');
      } else if(!navigator.onLine){
        list.innerHTML=stateHTML('offline',"You're offline",'Check your internet connection and try again. Your own library still works.','Try again','retryOnlineSearch()');
      } else if(hasYoutubeKey && auraYoutubeKeyInvalid){
        list.innerHTML=stateHTML('error','YouTube search is unavailable','The key is invalid or today\'s quota is used up. Other sources still work.');
      } else if([itunesRes,deezerRes,audiusRes,jamendoRes,archiveRes,openverseRes,ccmixterRes].every(r=>r.status==='rejected')){
        list.innerHTML=stateHTML('error','Couldn\'t reach the music sources','Something went wrong while searching. Please try again.','Try again','retryOnlineSearch()');
      } else {
        list.innerHTML=stateHTML('noresults','No results found','Try different words, or use the source buttons below.');
      }
      return [];
    }

    export function getYouTubeIdFromUrl(u){
      let m=u.match(/[?&]v=([A-Za-z0-9_-]{6,})/); if(m) return m[1];
      m=u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/); if(m) return m[1];
      m=u.match(/youtube\.com\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/); if(m) return m[1];
      return null;
    }

    export async function playEmbeddableLink(url,kind){
      const endpoint = kind==='spotify'
        ? 'https://open.spotify.com/oembed?url='+encodeURIComponent(url)
        : 'https://soundcloud.com/oembed?format=json&url='+encodeURIComponent(url);
      const host=$('pasteLinkEmbedHost');
      host.innerHTML='<div style="padding:10px 0;font-size:12px;color:var(--text-sub)"><i class="fa-solid fa-spinner fa-spin"></i> Loading player…</div>';
      try{
        const res=await fetch(endpoint);
        if(!res.ok) throw new Error('oEmbed request failed');
        const data=await res.json();
        if(!data.html) throw new Error('No embeddable player returned');
        host.innerHTML=data.html;
        toast((kind==='spotify'?'Spotify':'SoundCloud')+' player loaded — press play below','circle-check');
      }catch(err){
        host.innerHTML='<div style="padding:10px 0;font-size:12px;color:var(--text-sub)">Could not load an inline player for that link. Some tracks or private links can\'t be embedded.</div>';
      }
    }

    export async function playPastedLink(url){
      if(!url) return toast('Paste a track link first','link');
      if(/youtu\.?be/i.test(url)){
        const id=getYouTubeIdFromUrl(url);
        if(!id) return toast('Could not read a video ID from that YouTube link','triangle-exclamation');
        $('pasteLinkEmbedHost').innerHTML='';
        await playYouTubeInsideAura(id,'YouTube Music','');
        return;
      }
      if(/open\.spotify\.com\//i.test(url)) return playEmbeddableLink(url,'spotify');
      if(/soundcloud\.com\//i.test(url)) return playEmbeddableLink(url,'soundcloud');
      toast('Paste a YouTube, Spotify or SoundCloud track link','triangle-exclamation');
    }
    $('pasteLinkBtn').onclick=()=>playPastedLink($('pasteLinkInput').value.trim());
    $('pasteLinkInput').addEventListener('keydown',e=>{ if(e.key==='Enter') playPastedLink(e.target.value.trim()); });

    export function extractYouTubeId(stream){
      if(!stream) return null;
      const source=stream.source||stream;
      const yt=source.ytId || source.yt_id || stream.ytId || stream.yt_id;
      if(yt) return String(yt).split(':').pop();
      const candidates=[stream.url,stream.externalUrl,source.url,source.externalUrl,stream.content,source.content,stream.id,source.id];
      for(const raw of candidates){
        if(!raw) continue;
        const u=String(raw);
        const yid=getYouTubeIdFromUrl(u); if(yid) return yid;
        let m=u.match(/(?:^|:)yt_id:([A-Za-z0-9_-]{6,})$/); if(m) return m[1];
        if(/^yt_id[:_]/i.test(u)) return u.split(/[:_]/).pop();
      }
      const id=stream.id || source.id;
      if(id){ const parts=String(id).split(':'); if(parts.length>=2 && /^yt_id$/i.test(parts[0])) return parts[parts.length-1]; }
      return null;
    }

/* ===== 5556-5622 ===== */
    export function filterSearchTab(){
      const q=$('searchTabInput').value.toLowerCase().trim();
      const searchTab=$('tabSearch');
      const browse=$('browseGrid');

      /* Phone-friendly search mode: while typing, hide the category cards so the
         matching results sit immediately below the search bar instead of being
         pushed far down by Recently Played / Liked Songs / Local Files. */
      if(q){
        searchTab.classList.add('searching');
        if(browse){
          browse.querySelectorAll('.browse-tile').forEach(t=>t.classList.remove('active'));
          const allTile=browse.querySelector('[data-filter="all"]');
          if(allTile) allTile.classList.add('active');
        }
      }else{
        searchTab.classList.remove('searching');
      }

      /* A typed search searches the whole library, not whichever category was
         selected previously. Clearing the bar restores the selected category. */
      const base=q ? state.songs : songsForCategory();
      $('searchResultsLabel').textContent = q ? 'Results' : categoryLabels[searchCategory];
      renderSearchResults(q ? base.filter(s=>s.title.toLowerCase().includes(q)||s.artist.toLowerCase().includes(q)) : base);
      clearTimeout(window.__auraYoutubeSearchTimer);
      window.__auraYoutubeSearchTimer=setTimeout(()=>searchYouTubePro(q), q ? 350 : 0);
    }
    $('searchTabInput').oninput=filterSearchTab;

    // When a saved YouTube song is opened from the Liked Songs area, the search
    // tab can also be used to find the same song again by its title.
    window.searchLikedSong = function(id){
      const song=state.songs.find(s=>String(s.id)===String(id));
      if(!song) return;
      navClick($('navSearchBtn'),'tabSearch');
      $('searchTabInput').value=song.title||'';
      filterSearchTab();
    };


    $('browseGrid').querySelectorAll('.browse-tile').forEach(tile=>{
      tile.onclick=()=>{
        searchCategory=tile.dataset.filter;
        $('browseGrid').querySelectorAll('.browse-tile').forEach(t=>t.classList.remove('active'));
        tile.classList.add('active');
        filterSearchTab();
      };
    });

    /* Voice Search */
    export const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(SpeechRec){
      const recognizer = new SpeechRec();
      recognizer.continuous=false; recognizer.interimResults=false;
      recognizer.onstart=()=>{ $('voiceSearchBtn').classList.add('mode-active'); toast('Listening...', 'microphone'); };
      recognizer.onresult=(e)=>{
        const transcript = e.results[0][0].transcript;
        $('searchTabInput').value = transcript;
        filterSearchTab();
      };
      recognizer.onerror=()=>toast('Voice search failed, please try again', 'triangle-exclamation');
      recognizer.onend=()=>$('voiceSearchBtn').classList.remove('mode-active');
      $('voiceSearchBtn').onclick=()=>{ try{ recognizer.start(); }catch(err){ /* already running */ } };
    } else {
      $('voiceSearchBtn').onclick=()=>toast('Voice search is not supported on this browser', 'triangle-exclamation');
    }

