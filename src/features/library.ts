import { fetchYouTubeMeta, stateHTML, toast } from '../core/dom';
import { renderArtistSpotlight, renderAuraPicks, renderQuickAccess } from './home';
import { filterSongs, loadSong, resetFullPlayerArtToImage, stopAuraYouTube, updatePlayState } from './player';
import { filterSearchTab, getYouTubeIdFromUrl } from './search';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
/* ===== 3006-3012 ===== */
    /* Library Count */
    export function updateLibCount(){
      const _lc = $('libCount'); if(_lc) _lc.textContent = `${state.songs.length} track${state.songs.length!==1?'s':''} in your library`;
      renderArtistSpotlight();
      renderQuickAccess();
    }

/* ===== 3016-3037 ===== */
    export function addToRecent(song){
      state.recentlyPlayed = state.recentlyPlayed.filter(s => s.id !== song.id);
      state.recentlyPlayed.unshift({id:song.id,title:song.title,artist:song.artist,img:song.img});
      state.recentlyPlayed = state.recentlyPlayed.slice(0,10);
      localStorage.setItem('recentlyPlayed', JSON.stringify(state.recentlyPlayed));
      renderRecent();
    }

    export function renderRecent(){
      try{renderAuraPicks();}catch(e){}
      const sec = $('recentSection'), c = $('recentScroll');
      if(!state.recentlyPlayed.length){ sec.style.display='none'; return; }
      sec.style.display='block';
      c.innerHTML='';
      state.recentlyPlayed.forEach(s=>{
        let idx = state.songs.findIndex(item=>item.id===s.id);
        if(idx===-1 && s.title) idx = state.songs.findIndex(item=>item.title===s.title && item.artist===s.artist);
        if(idx===-1) return;
        c.innerHTML+=`<div class="recent-card" onclick="playSong(${idx})"><img src="${s.img}"><p>${s.title}</p></div>`;
      });
      renderQuickAccess();
    }

/* ===== 3162-3473 ===== */
    /* Persist added tracks. Local file blobs live in IndexedDB, so we
       strip the (session-only) blob URL before saving to localStorage. */
    export function persistAddedSongs(){
      const serializable = state.addedSongs.map(s => {
        if(s.isLocal){ const {url, missing, ...rest} = s; return rest; }
        return s;
      });
      localStorage.setItem('addedTracks', JSON.stringify(serializable));
    }

    /* IndexedDB storage for locally-uploaded state.audio files */
    export const hasIndexedDB = 'indexedDB' in window;
    export const LOCAL_DB_NAME = 'auraMusicDB', LOCAL_DB_STORE = 'audioFiles';
    export function openLocalDB(){
      return new Promise<any>((resolve, reject) => {
        const req = indexedDB.open(LOCAL_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(LOCAL_DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    export async function saveLocalBlob(id, blob){
      const db = await openLocalDB();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(LOCAL_DB_STORE, 'readwrite');
        tx.objectStore(LOCAL_DB_STORE).put(blob, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    export async function getLocalBlob(id){
      const db = await openLocalDB();
      return new Promise<any>((resolve, reject) => {
        const tx = db.transaction(LOCAL_DB_STORE, 'readonly');
        const req = tx.objectStore(LOCAL_DB_STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    export async function deleteLocalBlob(id){
      const db = await openLocalDB();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(LOCAL_DB_STORE, 'readwrite');
        tx.objectStore(LOCAL_DB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    /* Read ID3/MP4/FLAC tags where the format supports it (best-effort;
       formats like WMA fall back to the filename automatically). */
    export function readAudioTags(file){
      return new Promise<any>(resolve => {
        if(typeof jsmediatags === 'undefined') return resolve(null);
        jsmediatags.read(file, {
          onSuccess: tag => resolve(tag.tags),
          onError: () => resolve(null)
        });
      });
    }
    export function pictureToDataURL(picture){
      if(!picture || !picture.data) return null;
      try{
        let binary = '';
        const bytes = new Uint8Array(picture.data);
        for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
        return `data:${picture.format};base64,${btoa(binary)}`;
      }catch(e){ return null; }
    }

    /* Handle local file selection + drag & drop */
    export async function handleLocalFiles(fileList){
      const files = Array.from<any>(fileList || []).filter(f => f && (f.type.startsWith('audio/') || /\.(mp3|wma|flac|aac|m4a|alac)$/i.test(f.name)));
      if(!files.length) return toast('Please choose audio files', 'triangle-exclamation');
      const listEl = $('uploadFileList');
      listEl.innerHTML = '';
      let addedCount = 0;

      for(const file of files){
        const row = document.createElement('div');
        row.className = 'upload-file-row';
        row.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>${file.name}</span>`;
        listEl.appendChild(row);

        let title = file.name.replace(/\.[^/.]+$/, '');
        let artist = 'Unknown Artist';
        let img = 'https://picsum.photos/200';

        try{
          const tags = await readAudioTags(file);
          if(tags){
            if(tags.title) title = tags.title;
            if(tags.artist) artist = tags.artist;
            const pic = pictureToDataURL(tags.picture);
            if(pic) img = pic;
          }
        }catch(err){ /* metadata unavailable for this format — filename is used instead */ }

        const id = Date.now() + Math.floor(Math.random()*10000);
        const newTrack = { id, title, artist, url: URL.createObjectURL(file), img, favorite:false, isLocal:true };

        if(hasIndexedDB){
          try{
            await saveLocalBlob(id, file);
          }catch(err){
            row.className = 'upload-file-row failed';
            row.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${file.name} — couldn't be saved</span>`;
            continue;
          }
        }

        state.addedSongs.push(newTrack);
        state.songs = [...state.hfSongs, ...state.addedSongs];
        addedCount++;

        row.className = 'upload-file-row done';
        row.innerHTML = `<i class="fa-solid fa-circle-check"></i><span>${title}</span>`;
      }

      persistAddedSongs();
      renderSongs(state.songs);
      updateLibCount();
      const input = $('localFileInput');
      if(input) input.value = '';
      if(addedCount) toast(`${addedCount} file${addedCount!==1?'s':''} added to your library!`, 'circle-check');
      if(!hasIndexedDB) toast('Your browser can\'t persist files — they\'ll stay for this session only', 'triangle-exclamation');
    }

    $('localFileInput').onchange = (e) => handleLocalFiles(e.target.files);
    export const uploadDropzone = $('uploadDropzone');
    if(uploadDropzone){
      uploadDropzone.addEventListener('click', () => $('localFileInput').click());
      uploadDropzone.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); $('localFileInput').click(); }});
      ['dragenter','dragover'].forEach(type => uploadDropzone.addEventListener(type, e => { e.preventDefault(); e.stopPropagation(); uploadDropzone.classList.add('drag-over'); }));
      ['dragleave','dragend','drop'].forEach(type => uploadDropzone.addEventListener(type, e => { e.preventDefault(); e.stopPropagation(); uploadDropzone.classList.remove('drag-over'); }));
      uploadDropzone.addEventListener('drop', e => handleLocalFiles(e.dataTransfer.files));
    }

    /* Restore local file blobs from IndexedDB on load */
    export async function hydrateLocalTracks(){
      if(!hasIndexedDB) return;
      for(const s of state.addedSongs){
        if(s.isLocal){
          try{
            const blob = await getLocalBlob(s.id);
            if(blob) s.url = URL.createObjectURL(blob);
            else s.missing = true;
          }catch(err){ s.missing = true; }
        }
      }
    }

    /* Edit track (title / artist / cover) */
    export let editingId = null, editPendingImg = null;

    export function openEditModal(e, id){
      if(e) e.stopPropagation();
      const song = state.addedSongs.find(s => s.id === id);
      if(!song) return;
      editingId = id;
      editPendingImg = song.img;
      $('editTitleInput').value = song.title;
      $('editArtistInput').value = song.artist;
      $('editImgUrlInput').value = song.img.startsWith('data:') ? '' : song.img;
      $('editCoverPreview').src = song.img;
      $('editTrackModal').classList.add('active');
    }

    export function closeEditModal(){
      $('editTrackModal').classList.remove('active');
      $('editCoverFileInput').value = '';
      editingId = null; editPendingImg = null;
    }

    $('editImgUrlInput').oninput = () => {
      const val = $('editImgUrlInput').value.trim();
      if(val){ editPendingImg = val; $('editCoverPreview').src = val; }
    };

    $('editCoverFileInput').onchange = (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        editPendingImg = reader.result;
        $('editCoverPreview').src = reader.result;
        $('editImgUrlInput').value = '';
      };
      reader.readAsDataURL(file);
    };

    export function saveEditedTrack(){
      const song = state.addedSongs.find(s => s.id === editingId);
      if(!song) return closeEditModal();
      const newTitle = $('editTitleInput').value.trim();
      const newArtist = $('editArtistInput').value.trim();
      song.title = newTitle || song.title;
      song.artist = newArtist || song.artist;
      song.img = editPendingImg || song.img;

      persistAddedSongs();
      filterSongs();
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      if($('tabSearch').classList.contains('active')) filterSearchTab();
      if(state.songs[state.currentIndex] && state.songs[state.currentIndex].id === song.id) loadSong(state.currentIndex);
      renderRecent();
      toast('Track updated', 'circle-check');
      closeEditModal();
    }

    /* Delete track */
    export async function deleteTrack(e, id){
      if(e) e.stopPropagation();
      const song = state.addedSongs.find(s => s.id === id);
      if(!song) return;
      if(!confirm(`Remove "${song.title}" from your library?`)) return;

      const currentSongId = state.songs[state.currentIndex] ? state.songs[state.currentIndex].id : null;
      const wasPlaying = currentSongId === id;

      if(song.isLocal && hasIndexedDB){
        try{ await deleteLocalBlob(id); }catch(err){ /* best effort */ }
      }

      state.addedSongs = state.addedSongs.filter(s => s.id !== id);
      state.songs = [...state.hfSongs, ...state.addedSongs];
      state.recentlyPlayed = state.recentlyPlayed.filter(s => s.id !== id);
      localStorage.setItem('recentlyPlayed', JSON.stringify(state.recentlyPlayed));
      persistAddedSongs();

      if(wasPlaying){
        state.audio.pause(); state.audio.src=''; state.isPlaying=false; state.currentIndex=0;
        stopAuraYouTube(); resetFullPlayerArtToImage('');
        $('currentImg').src=''; $('currentTitle').textContent='Select Track'; $('currentArtist').textContent='--';
        $('fullPlayerOverlay').classList.remove('active');
        updatePlayState();
      } else if(currentSongId !== null){
        const newIdx = state.songs.findIndex(s => s.id === currentSongId);
        if(newIdx !== -1) state.currentIndex = newIdx;
      }

      filterSongs();
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      if($('tabSearch').classList.contains('active')) filterSearchTab();
      updateLibCount();
      renderRecent();
      toast('Track removed from your library', 'circle-check');
    }

    export function addNewTrack() {
        const title = $('newTitle').value.trim();
        const artist = $('newArtist').value.trim();
        const url = $('newUrl').value.trim();
        const img = $('newImg').value.trim();

        if(!title || !url) return toast("Title and Link are required!", "triangle-exclamation");

        const newTrack = {
            id: Date.now(), // Unique ID
            title: title,
            artist: artist || "Unknown Artist",
            url: url,
            img: img || "https://picsum.photos/200",
            favorite: false
        };

        state.addedSongs.push(newTrack);
        persistAddedSongs();
        state.songs = [...state.hfSongs, ...state.addedSongs];
        
        // Reset inputs
        $('newTitle').value = ''; $('newArtist').value = ''; $('newUrl').value = ''; $('newImg').value = '';
        
        renderSongs(state.songs);
        updateLibCount();
        toast("Track added to library!", "circle-check");
    }

    /* Add a track from a YouTube link — plays through YouTube's own official
       embedded player (same pipeline as the search results). Nothing is
       downloaded, extracted, or converted; we only fetch public oEmbed
       metadata (title/author/thumbnail) so the track looks right in the
       library. */
    export async function addYouTubeTrack(){
      const raw = $('ytAddInput').value.trim();
      if(!raw) return toast('Paste a YouTube link first', 'link');
      const videoId = getYouTubeIdFromUrl(raw);
      if(!videoId) return toast('Could not read a video ID from that link', 'triangle-exclamation');
      if(state.addedSongs.some(s => s.videoId === videoId)) return toast('That video is already in your library', 'circle-info');

      const { title, artist } = await fetchYouTubeMeta(videoId);

      const newTrack = {
        id: Date.now(),
        title: title,
        artist: artist,
        url: '',
        img: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        favorite: false,
        isYouTube: true,
        videoId: videoId
      };

      state.addedSongs.push(newTrack);
      persistAddedSongs();
      state.songs = [...state.hfSongs, ...state.addedSongs];
      $('ytAddInput').value = '';
      renderSongs(state.songs);
      updateLibCount();
      toast('YouTube track added to library!', 'circle-check');
    }

/* ===== 4925-4991 ===== */
    export function toggleFavorite(e, id) {
      if(e) e.stopPropagation();
      const song = typeof id === 'number' ? state.songs[id] : state.songs.find(s => String(s.id) === String(id));
      if(!song) return;
      song.favorite = !song.favorite;
      if(song.favorite) savedLikeMap[String(song.id)]=true; else delete savedLikeMap[String(song.id)];
      persistLikedHistory();
      // Keep the full-player heart in sync immediately.
      if(state.currentIndex >= 0 && state.songs[state.currentIndex] && String(state.songs[state.currentIndex].id)===String(song.id)){
        $('fullLikeBtn').className=`like-btn ${song.favorite?'active':''}`;
        $('fullLikeBtn').innerHTML=`<i class="fa-${song.favorite?'solid':'regular'} fa-heart"></i>`;
      }
      toast(song.favorite ? 'Saved to Liked Songs' : 'Removed from Liked Songs', song.favorite ? 'heart' : 'heart-crack');
      filterSongs();
      renderQuickAccess();
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      if($('tabSearch').classList.contains('active')) filterSearchTab();
    }

    export function songItemHTML(s){
      const songIdx = state.songs.findIndex(item => item.id === s.id);
      return `<div class="song-item ${songIdx===state.currentIndex?'active':''}" onclick="playSong(${songIdx})">
          <div class="song-info"><img src="${s.img}"><div><div class="song-title">${s.title}</div><div class="song-artist">${s.artist}</div></div></div>
          <div class="song-item-actions">
            <button class="song-item-like ${s.favorite?'active':''}" onclick="toggleFavorite(event, ${songIdx})"><i class="fa-${s.favorite?'solid':'regular'} fa-heart"></i></button>
            <button class="song-item-menu-btn" onclick="openTrackMenu(event, ${s.id})"><i class="fa-solid fa-ellipsis"></i></button>
          </div>
        </div>`;
    }

    export function renderSongs(list){
      const c=$('songList');
      c.innerHTML=list.length?list.map(songItemHTML).join('') : stateHTML('noresults','No tracks found','Try a different spelling or another filter.');
    }

    export function renderLibrary(){
      const c=$('librarySongList');
      c.innerHTML=state.songs.length?state.songs.map(songItemHTML).join('') : stateHTML('empty','Your library is empty','Add your own songs or search online to get started.','Search music',"goTab('tabSearch')");
      updateLibNowPlaying();
      if($('statsPanel').style.display!=='none') renderStatsPanel();
    }

    export function updateLibNowPlaying(){
      const el=$('libNowPlayingSub');
      if(!el) return;
      el.textContent = state.songs.length ? `${state.songs[state.currentIndex].title} — ${state.songs[state.currentIndex].artist}` : 'Nothing playing';
    }

    export function toggleStatsPanel(){
      const panel=$('statsPanel'), chevron=$('statsChevron');
      const show = panel.style.display==='none';
      panel.style.display = show ? 'grid' : 'none';
      chevron.style.transform = show ? 'rotate(90deg)' : 'rotate(0)';
      if(show) renderStatsPanel();
    }

    export function renderStatsPanel(){
      const favCount = state.songs.filter(s=>s.favorite).length;
      const localCount = state.songs.filter(s=>s.isLocal).length;
      const artistCount = new Set(state.songs.map(s=>s.artist).filter(a=>a && a!=='Unknown Artist')).size;
      $('statsPanel').innerHTML = `
        <div class="stats-cell"><div class="stat-num">${state.songs.length}</div><div class="stat-label">Total Tracks</div></div>
        <div class="stats-cell"><div class="stat-num">${favCount}</div><div class="stat-label">Favorites</div></div>
        <div class="stats-cell"><div class="stat-num">${localCount}</div><div class="stat-label">Local Files</div></div>
        <div class="stats-cell"><div class="stat-num">${artistCount}</div><div class="stat-label">Artists</div></div>`;
    }

