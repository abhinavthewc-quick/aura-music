import { copyToClipboard, showTrackSheet, toast } from '../core/dom';
import { deleteTrack, openEditModal, renderLibrary } from './library';
import { auraYTVideoId, filterSongs, playSong, playYouTubeProResult } from './player';
import { escapeHtml } from './radio';
import { auraYTQueue, extractYouTubeId, filterSearchTab } from './search';
import { $, persistLikedHistory, savedLikeMap, state } from '../core/state';
/* ===== 3474-3570 ===== */
    /* ---------- Track action bottom sheet (the "..." menu) ---------- */
    export let manualQueue = [];      // ids queued via "Play Next" / "Add to Queue"
    export let trackSheetSongId = null;

    export function findSongById(id){
      return state.songs.find(s => String(s.id) === String(id));
    }

    export function openTrackMenu(e, id){
      if(e) e.stopPropagation();
      const song = findSongById(id);
      if(!song) return;
      trackSheetSongId = song.id;
      const isAdded = state.addedSongs.some(a => String(a.id) === String(song.id));
      const canSaveOffline = !song.isYouTube && !!song.url;

      const rows = [];
      rows.push(`<div class="track-sheet-row" onclick="queueTrackAction('playNext')"><i class="fa-solid fa-list-ol"></i>Play Next</div>`);
      rows.push(`<div class="track-sheet-row" onclick="queueTrackAction('addQueue')"><i class="fa-solid fa-layer-group"></i>Add to Queue</div>`);
      rows.push(`<div class="track-sheet-row${song.favorite?' active-row':''}" onclick="queueTrackAction('favorite')"><i class="fa-${song.favorite?'solid':'regular'} fa-heart"></i>${song.favorite?'Remove from Favorites':'Add to Favorites'}</div>`);
      if(isAdded){
        rows.push(`<div class="track-sheet-row" onclick="queueTrackAction('edit')"><i class="fa-solid fa-pen"></i>Edit Track</div>`);
      }
      rows.push(`<div class="track-sheet-row" onclick="queueTrackAction('share')"><i class="fa-solid fa-share-nodes"></i>Share</div>`);
      if(canSaveOffline){
        rows.push(`<div class="track-sheet-row" onclick="queueTrackAction('download')"><i class="fa-solid fa-download"></i>Save Offline</div>`);
      }
      if(isAdded){
        rows.push(`<div class="track-sheet-row danger" onclick="queueTrackAction('delete')"><i class="fa-solid fa-trash"></i>Remove from Library</div>`);
      }
      showTrackSheet({img:song.img, title:song.title, artist:song.artist, rowsHtml:rows.join('')});
    }

    export function closeTrackMenu(){
      $('trackSheetOverlay').classList.remove('active');
      trackSheetSongId = null;
    }
    $('trackSheetOverlay').onclick = (e) => { if(e.target === $('trackSheetOverlay')) closeTrackMenu(); };

    export function queueTrackAction(action){
      const id = trackSheetSongId;
      const song = findSongById(id);
      closeTrackMenu();
      if(!song) return;

      if(action === 'playNext'){
        if(state.currentIndex>=0 && state.songs[state.currentIndex] && String(state.songs[state.currentIndex].id)===String(id)) return toast('That song is already playing','circle-info');
        manualQueue = manualQueue.filter(qid => String(qid) !== String(id));
        manualQueue.unshift(id);
        renderUpNext();
        toast(`"${song.title}" will play next`, 'circle-check');
      } else if(action === 'addQueue'){
        if(state.currentIndex>=0 && state.songs[state.currentIndex] && String(state.songs[state.currentIndex].id)===String(id)) return toast('That song is already playing','circle-info');
        manualQueue=manualQueue.filter(qid=>String(qid)!==String(id));
        manualQueue.push(id);
        renderUpNext();
        toast(`Added "${song.title}" to queue`, 'circle-check');
      } else if(action === 'favorite'){
        song.favorite = !song.favorite;
        if(song.favorite) savedLikeMap[String(song.id)]=true; else delete savedLikeMap[String(song.id)];
        persistLikedHistory();
        if(state.currentIndex >= 0 && state.songs[state.currentIndex] && String(state.songs[state.currentIndex].id)===String(song.id)){
          $('fullLikeBtn').className=`like-btn ${song.favorite?'active':''}`;
          $('fullLikeBtn').innerHTML=`<i class="fa-${song.favorite?'solid':'regular'} fa-heart"></i>`;
        }
        filterSongs();
        if($('tabLibrary').classList.contains('active')) renderLibrary();
        if($('tabSearch').classList.contains('active')) filterSearchTab();
        toast(song.favorite ? 'Added to Favorites' : 'Removed from Favorites', 'circle-check');
      } else if(action === 'edit'){
        openEditModal(null, song.id);
      } else if(action === 'delete'){
        deleteTrack(null, song.id);
      } else if(action === 'share'){
        const shareUrl = song.isYouTube && song.videoId ? `https://youtu.be/${song.videoId}` : (song.url || '');
        if(navigator.share){
          navigator.share({ title: song.title, text: `${song.title} — ${song.artist}`, url: shareUrl || undefined }).catch(()=>{});
        } else if(shareUrl){
          copyToClipboard(shareUrl,'Link copied to clipboard');
        } else {
          toast('Sharing is not supported on this device', 'triangle-exclamation');
        }
      } else if(action === 'download'){
        try{
          const a = document.createElement('a');
          a.href = song.url;
          a.download = song.title || 'track';
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast('Download started', 'circle-check');
        }catch(err){
          toast('Could not save this track offline', 'triangle-exclamation');
        }
      }
    }

/* ===== 5986-6184 ===== */
    /* ---------- Up Next: rolling 4-song queue + touch drag reorder ---------- */
    export const UP_NEXT_PHONE_LIMIT = 4, UP_NEXT_DESKTOP_LIMIT = 30;
    export const upNextLimit = () => (window.matchMedia && window.matchMedia('(min-width:900px)').matches) ? UP_NEXT_DESKTOP_LIMIT : UP_NEXT_PHONE_LIMIT;
    export let upNextDrag = null;

    export function getRollingUpNextItems(){
      const UP_NEXT_LIMIT = upNextLimit();
      const result=[];
      const seen=new Set();
      const currentId = state.currentIndex>=0 && state.songs[state.currentIndex] ? String(state.songs[state.currentIndex].id) : null;
      const add=(song)=>{
        if(!song) return;
        const id=String(song.id);
        if(id===currentId || seen.has(id)) return;
        seen.add(id);
        if(result.length<UP_NEXT_LIMIT) result.push(song);
      };
      // Explicit Play Next / Add to Queue items always take priority.
      for(const id of manualQueue) add(findSongById(id));
      // Fill the visible window from the library only until four upcoming state.songs exist.
      if(result.length<UP_NEXT_LIMIT && state.songs.length){
        const start=state.currentIndex>=0 ? state.currentIndex+1 : 0;
        for(let n=0;n<state.songs.length && result.length<UP_NEXT_LIMIT;n++) add(state.songs[(start+n)%state.songs.length]);
      }
      return result;
    }

    export function renderUpNext(){
      const list=$('upNextList');
      if(!list) return;
      const items=getRollingUpNextItems();
      if(!items.length){
        list.innerHTML="<div class='up-next-empty'>Nothing queued yet. Add a song with Play Next or Add to Queue.</div>";
        return;
      }
      list.innerHTML=items.map(song=>{
        const liked=!!song.favorite;
        return `<div class="up-next-row" data-up-next-id="${escapeHtml(song.id)}">
          <img class="up-next-cover" src="${escapeHtml(song.img||'')}" alt="" loading="lazy" decoding="async">
          <div class="up-next-info"><div class="up-next-song-title">${escapeHtml(song.title||'Untitled')}</div><div class="up-next-song-artist">${escapeHtml(song.artist||'Unknown Artist')}</div></div>
          <div class="up-next-actions">
            <button class="up-next-action favorite" type="button" aria-label="${liked?'Remove from favorites':'Add to favorites'}"><i class="fa-${liked?'solid':'regular'} fa-heart"></i></button>
            <button class="up-next-action reorder" type="button" aria-label="Hold and drag to reorder"></button>
          </div>
        </div>`;
      }).join('');

      list.querySelectorAll('.up-next-row').forEach(row=>{
        row.addEventListener('click',e=>{
          if(e.target.closest('.up-next-action')) return;
          const id=row.dataset.upNextId;
          const idx=state.songs.findIndex(x=>String(x.id)===String(id));
          if(idx!==-1){
            manualQueue=manualQueue.filter(q=>String(q)!==String(id));
            closeUpNext();
            playSong(idx);
          }
        });
      });
      list.querySelectorAll('.up-next-action.favorite').forEach(btn=>{
        btn.addEventListener('click',e=>{
          e.stopPropagation();
          const row=btn.closest('.up-next-row');
          const idx=state.songs.findIndex(x=>String(x.id)===String(row.dataset.upNextId));
          if(idx===-1) return;
          state.songs[idx].favorite=!state.songs[idx].favorite;
          if(state.songs[idx].favorite) savedLikeMap[String(state.songs[idx].id)]=true; else delete savedLikeMap[String(state.songs[idx].id)];
          persistLikedHistory();
          renderUpNext();
          filterSongs();
          if($('tabLibrary').classList.contains('active')) renderLibrary();
        });
      });
      list.querySelectorAll('.up-next-action.reorder').forEach(handle=>initUpNextReorder(handle));
    }

    export function promoteVisibleOrder(ids){
      const unique=[]; const seen=new Set();
      ids.forEach(id=>{ const s=findSongById(id); if(s && !seen.has(String(id))){seen.add(String(id));unique.push(s.id);} });
      const visibleIds=new Set(unique.map(id=>String(id)));
      const remaining=manualQueue.filter(id=>!visibleIds.has(String(id)) && findSongById(id));
      manualQueue=[...unique,...remaining];
    }

    export function initUpNextReorder(handle){
      handle.onpointerdown=(e)=>{
        e.preventDefault();
        e.stopPropagation();
        const row=handle.closest('.up-next-row');
        if(!row) return;
        handle.setPointerCapture?.(e.pointerId);
        upNextDrag={row,pointerId:e.pointerId,moved:false};
        row.classList.add('dragging-row');
        handle.style.touchAction='none';
      };
      handle.onpointermove=(e)=>{
        if(!upNextDrag || upNextDrag.pointerId!==e.pointerId) return;
        if(Math.abs(e.movementY)>2) upNextDrag.moved=true;
        const rows=[...$('upNextList').querySelectorAll('.up-next-row:not(.dragging-row)')];
        const target=rows.find(r=>{const b=r.getBoundingClientRect();return e.clientY < b.top+b.height/2;});
        if(target) $('upNextList').insertBefore(upNextDrag.row,target); else $('upNextList').appendChild(upNextDrag.row);
      };
      handle.onpointerup=(e)=>finishUpNextReorder(e);
      handle.onpointercancel=(e)=>finishUpNextReorder(e);
    }

    export function finishUpNextReorder(e){
      if(!upNextDrag || upNextDrag.pointerId!==e.pointerId) return;
      const list=$('upNextList');
      const ids=[...list.querySelectorAll('.up-next-row')].map(r=>r.dataset.upNextId);
      if(upNextDrag.moved) promoteVisibleOrder(ids);
      upNextDrag.row.classList.remove('dragging-row');
      upNextDrag=null;
      renderUpNext();
      toast('Up Next order updated','list-check');
    }

    export function openUpNext(){
      renderUpNext();
      const sheet=$('upNextSheet');
      sheet.style.removeProperty('--up-next-drag-y');
      sheet.classList.remove('dragging');
      sheet.classList.add('active');
      sheet.setAttribute('aria-hidden','false');
    }
    export function closeUpNext(){
      const sheet=$('upNextSheet');
      sheet.classList.remove('dragging');
      sheet.style.removeProperty('--up-next-drag-y');
      sheet.classList.remove('active');
      sheet.setAttribute('aria-hidden','true');
    }

    $('upNextOpenBtn').onclick=e=>{e.stopPropagation();openUpNext();};
    $('upNextCloseBtn').onclick=closeUpNext;
    $('upNextSheet').onclick=e=>{if(e.target===$('upNextSheet')) closeUpNext();};
    document.addEventListener('keydown',e=>{if(e.key==='Escape') closeUpNext();});


    export async function playPrevious(){
      // Always resolve the current position from the actual YouTube result ID.
      // This prevents a stale queue index from making AURA think we're at an end.
      if(auraYTVideoId && auraYTQueue.length){
        let idx=auraYTQueue.findIndex(m=>{
          const mid=String(m?.id||'');
          const vid=extractYouTubeId(m)||String(m?.videoId||'');
          return mid===String(auraYTVideoId) || vid===String(auraYTVideoId);
        });
        if(idx<0) idx=state.auraYTQueueIndex;
        if(idx<0) idx=0;
        state.auraYTQueueIndex=idx;
        const prevIndex=(idx-1+auraYTQueue.length)%auraYTQueue.length;
        state.auraYTQueueIndex=prevIndex;
        await playYouTubeProResult(auraYTQueue[prevIndex]);
        return;
      }
      if(!state.songs.length) return;
      let i=state.currentIndex-1;
      if(i<0) i=state.songs.length-1;
      playSong(i);
    }

    export async function playNext(){
      if(manualQueue.length){
        const nextId = manualQueue.shift();
        const idx = state.songs.findIndex(s => String(s.id) === String(nextId));
        if(idx !== -1){ playSong(idx); renderUpNext(); return; }
      }
      if(auraYTVideoId && auraYTQueue.length){
        let idx=auraYTQueue.findIndex(m=>{
          const mid=String(m?.id||'');
          const vid=extractYouTubeId(m)||String(m?.videoId||'');
          return mid===String(auraYTVideoId) || vid===String(auraYTVideoId);
        });
        if(idx<0) idx=state.auraYTQueueIndex;
        if(idx<0) idx=0;
        state.auraYTQueueIndex=idx;
        let nextIndex=(idx+1)%auraYTQueue.length;
        if(state.isShuffle && auraYTQueue.length>1){ do{ nextIndex=Math.floor(Math.random()*auraYTQueue.length); }while(nextIndex===idx); }
        state.auraYTQueueIndex=nextIndex;
        await playYouTubeProResult(auraYTQueue[nextIndex]);
        return;
      }
      if(!state.songs.length) return;
      let i=state.currentIndex+1;
      if(state.isShuffle && state.songs.length>1){ do{ i=Math.floor(Math.random()*state.songs.length); }while(i===state.currentIndex); }
      if(i>=state.songs.length) i=0;
      playSong(i);
      renderUpNext();
    }

    $('fullHeaderMenuBtn').onclick=e=>{
      e.stopPropagation();
      if(state.songs[state.currentIndex]) openTrackMenu(e, state.songs[state.currentIndex].id);
    };
    $('fullPrevBtn').onclick=e=>{e.stopPropagation();playPrevious();};
    $('fullNextBtn').onclick=e=>{e.stopPropagation();playNext();};
    $('nextBtn').onclick=e=>{e.stopPropagation();playNext();};

