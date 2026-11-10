import { copyToClipboard, showTrackSheet, toast } from '../core/dom';
import { deleteTrack, openEditModal, renderLibrary } from './library';
import { auraYTVideoId, filterSongs, playSong, playYouTubeProResult, refreshLyricsForOpenSheet } from './player';
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

    export function playTrackSequence(ids: Array<string | number>){
      const sequence = ids
        .map(id => findSongById(id))
        .filter(Boolean)
        .map(song => song.id);
      if(!sequence.length) return;
      const firstId = sequence.shift();
      manualQueue = sequence;
      renderUpNext();
      const index = state.songs.findIndex(song => String(song.id) === String(firstId));
      if(index !== -1) playSong(index);
    }

    export function openTrackMenu(e, id){
      if(e) e.stopPropagation();
      const song = findSongById(id);
      if(!song) return;
      trackSheetSongId = song.id;
      const isAdded = state.addedSongs.some(a => String(a.id) === String(song.id));
      const canSaveOffline = !song.isYouTube && !!song.url;

      const rows = [];
      rows.push(`<div role="button" tabindex="0" class="track-sheet-row${song.favorite?' active-row':''}" onclick="queueTrackAction('favorite')"><i class="fa-${song.favorite?'solid':'regular'} fa-heart"></i>${song.favorite?'Remove from Favorites':'Add to Favorites'}</div>`);
      rows.push(`<div role="button" tabindex="0" class="track-sheet-row" onclick="queueTrackAction('playlist')"><i class="fa-solid fa-list"></i>Add to Playlist</div>`);
      if(isAdded){
        rows.push(`<div role="button" tabindex="0" class="track-sheet-row" onclick="queueTrackAction('edit')"><i class="fa-solid fa-pen"></i>Edit Track</div>`);
      }
      rows.push(`<div role="button" tabindex="0" class="track-sheet-row" onclick="queueTrackAction('share')"><i class="fa-solid fa-share-nodes"></i>Share</div>`);
      if(canSaveOffline){
        rows.push(`<div role="button" tabindex="0" class="track-sheet-row" onclick="queueTrackAction('download')"><i class="fa-solid fa-download"></i>Save Offline</div>`);
      }
      if(isAdded){
        rows.push(`<div role="button" tabindex="0" class="track-sheet-row danger" onclick="queueTrackAction('delete')"><i class="fa-solid fa-trash"></i>Remove from Library</div>`);
      }
      showTrackSheet({img:song.img, title:song.title, artist:song.artist, rowsHtml:rows.join('')});
    }

    export function closeTrackMenu(){
      $('trackSheetOverlay').classList.remove('active');
      trackSheetSongId = null;
    }
    $('trackSheetOverlay').onclick = (e) => { if(e.target === $('trackSheetOverlay')) closeTrackMenu(); };

    function shareTrack(song){
      const shareUrl = song.isYouTube && song.videoId ? `https://youtu.be/${song.videoId}` : (song.url || '');
      if(navigator.share){
        navigator.share({ title: song.title, text: `${song.title} — ${song.artist}`, url: shareUrl || undefined }).catch(()=>{});
      } else if(shareUrl){
        copyToClipboard(shareUrl,'Link copied to clipboard');
      } else {
        toast('Sharing is not supported on this device', 'triangle-exclamation');
      }
    }

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
      } else if(action === 'playlist'){
        (globalThis as any).openPlaylistPicker?.(song.id);
      } else if(action === 'delete'){
        deleteTrack(null, song.id);
      } else if(action === 'share'){
        shareTrack(song);
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
    /* ---------- Up Next: rolling queue + pointer and keyboard reorder ---------- */
    export const UP_NEXT_PHONE_LIMIT = 4, UP_NEXT_DESKTOP_LIMIT = 30;
    export const upNextLimit = () => (window.matchMedia && window.matchMedia('(min-width:900px)').matches) ? UP_NEXT_DESKTOP_LIMIT : UP_NEXT_PHONE_LIMIT;
    export let upNextDrag = null;
    const UP_NEXT_REORDER_HELP = 'Drag a handle, or focus it and press Arrow Up or Arrow Down to reorder.';
    const UP_NEXT_CONTROLS = ['.up-next-play', '.up-next-action.favorite', '.up-next-action.reorder'];

    function focusUpNextControl(id: string, selector = '.up-next-action.reorder'){
      const row=[...($('upNextList')?.querySelectorAll<HTMLElement>('.up-next-row') || [])]
        .find(row=>row.dataset.upNextId===id);
      const control=row?.querySelector<HTMLButtonElement>(selector);
      control?.focus({preventScroll:true});
      return control;
    }

    function announceUpNextReorder(message: string){
      const status=$('upNextReorderStatus');
      if(status) status.textContent=message;
    }

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
      const focused=document.activeElement as HTMLElement | null;
      const focusId=focused && list.contains(focused) ? focused.closest<HTMLElement>('.up-next-row')?.dataset.upNextId : undefined;
      const focusControl=focusId !== undefined ? UP_NEXT_CONTROLS.find(selector=>focused.matches(selector)) : undefined;
      const items=getRollingUpNextItems();
      // Keep the instructions and live region mounted while row controls refresh.
      if(!$('upNextReorderHelp')) list.insertAdjacentHTML('beforebegin', `<p id="upNextReorderHelp" class="up-next-reorder-help">${UP_NEXT_REORDER_HELP}</p>`);
      if(!$('upNextReorderStatus')) list.insertAdjacentHTML('beforebegin', '<p id="upNextReorderStatus" class="up-next-reorder-status" role="status" aria-live="polite" aria-atomic="true"></p>');
      $('upNextReorderHelp').hidden=!items.length;
      $('upNextReorderStatus').hidden=!items.length;
      if(!items.length){
        announceUpNextReorder('');
        list.innerHTML="<div class='up-next-empty'>Nothing queued yet. Add a song with Play Next or Add to Queue.</div>";
        return;
      }
      list.innerHTML=items.map((song, index)=>{
        const liked=!!song.favorite;
        const title=escapeHtml(song.title||'Untitled'), artist=escapeHtml(song.artist||'Unknown Artist');
        return `<div class="up-next-row" data-up-next-id="${escapeHtml(song.id)}">
          <button class="up-next-play" type="button" aria-label="Play ${title} by ${artist}">
            <img class="up-next-cover" src="${escapeHtml(song.img||'')}" alt="" loading="lazy" decoding="async">
            <span class="up-next-info"><span class="up-next-song-title">${title}</span><span class="up-next-song-artist">${artist}</span></span>
          </button>
          <div class="up-next-actions">
            <button class="up-next-action favorite" type="button" aria-label="${liked?'Remove from favorites':'Add to favorites'}: ${title}"><i class="fa-${liked?'solid':'regular'} fa-heart" aria-hidden="true"></i></button>
            <button class="up-next-action reorder" type="button" aria-label="Reorder ${title}, position ${index+1} of ${items.length}" aria-describedby="upNextReorderHelp" aria-keyshortcuts="ArrowUp ArrowDown"></button>
          </div>
        </div>`;
      }).join('');

      list.querySelectorAll('.up-next-play').forEach(btn=>{
        btn.addEventListener('click',()=>{
          const row=btn.closest('.up-next-row');
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
      if(focusControl) focusUpNextControl(focusId, focusControl);
    }

    export function promoteVisibleOrder(ids){
      const unique=[]; const seen=new Set();
      ids.forEach(id=>{ const s=findSongById(id); if(s && !seen.has(String(id))){seen.add(String(id));unique.push(s.id);} });
      const visibleIds=new Set(unique.map(id=>String(id)));
      const remaining=manualQueue.filter(id=>!visibleIds.has(String(id)) && findSongById(id));
      manualQueue=[...unique,...remaining];
    }

    export function initUpNextReorder(handle){
      handle.onclick=(e)=>{
        e.stopPropagation();
        if(e.detail===0) announceUpNextReorder(UP_NEXT_REORDER_HELP);
      };
      handle.onkeydown=(e)=>{
        if((e.key!=='ArrowUp' && e.key!=='ArrowDown') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || upNextDrag) return;
        e.preventDefault();
        e.stopPropagation();
        const row=handle.closest('.up-next-row');
        if(!row) return;
        const id=row.dataset.upNextId;
        const ids=[...$('upNextList').querySelectorAll<HTMLElement>('.up-next-row')].map(row=>row.dataset.upNextId);
        const from=ids.indexOf(id), to=from+(e.key==='ArrowUp' ? -1 : 1);
        if(from===-1) return;
        const title=findSongById(id)?.title || 'Untitled';
        if(to<0 || to>=ids.length){
          announceUpNextReorder(`"${title}" is already ${to<0 ? 'first' : 'last'} in Up Next, position ${from+1} of ${ids.length}.`);
          return;
        }
        [ids[from],ids[to]]=[ids[to],ids[from]];
        promoteVisibleOrder(ids);
        renderUpNext();
        focusUpNextControl(id)?.scrollIntoView({block:'nearest',inline:'nearest'});
        announceUpNextReorder(`Moved "${title}" to position ${to+1} of ${ids.length}.`);
      };
      handle.onpointerdown=(e)=>{
        e.preventDefault();
        e.stopPropagation();
        const row=handle.closest('.up-next-row');
        if(!row) return;
        handle.focus({preventScroll:true});
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
      const id=upNextDrag.row.dataset.upNextId, moved=upNextDrag.moved;
      if(moved) promoteVisibleOrder(ids);
      upNextDrag.row.classList.remove('dragging-row');
      upNextDrag=null;
      renderUpNext();
      focusUpNextControl(id);
      if(moved) announceUpNextReorder(`Moved "${findSongById(id)?.title || 'Untitled'}" to position ${ids.indexOf(id)+1} of ${ids.length}.`);
      toast('Up Next order updated','list-check');
    }

    export function openUpNext(){
      renderUpNext();
      const sheet=$('upNextSheet');
      sheet.style.removeProperty('--up-next-drag-y');
      sheet.classList.remove('dragging');
      sheet.classList.add('active');
      sheet.setAttribute('aria-hidden','false');
      refreshLyricsForOpenSheet();
    }
    export function closeUpNext(){
      const sheet=$('upNextSheet');
      sheet.classList.remove('dragging');
      sheet.style.removeProperty('--up-next-drag-y');
      sheet.classList.remove('active');
      sheet.setAttribute('aria-hidden','true');
    }

    const openBtn = $('upNextOpenBtn');
    if (openBtn) openBtn.onclick=e=>{e.stopPropagation();openUpNext();};
    const closeBtn = $('upNextCloseBtn');
    if (closeBtn) closeBtn.onclick=closeUpNext;
    const sheetEl = $('upNextSheet');
    if (sheetEl) sheetEl.onclick=e=>{if(e.target===sheetEl) closeUpNext();};
    document.addEventListener('keydown',e=>{if(e.key==='Escape') closeUpNext();});


    export async function playPrevious(keepFull=false){
      if(keepFull && !window.matchMedia('(min-width:900px)').matches){
        $('fullPlayerOverlay').classList.add('active');
      }
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
        if(keepFull && !window.matchMedia('(min-width:900px)').matches){
          $('fullPlayerOverlay').classList.add('active');
        }
        return;
      }
      if(!state.songs.length) return;
      let i=state.currentIndex-1;
      if(i<0) i=state.songs.length-1;
      playSong(i, keepFull);
      if(keepFull && !window.matchMedia('(min-width:900px)').matches){
        $('fullPlayerOverlay').classList.add('active');
      }
    }

    export async function playNext(keepFull=false){
      // Deleted tracks and unavailable local files cannot make later queued
      // tracks lose their turn to the library/YouTube fallback.
      while(manualQueue.length){
        const nextId = manualQueue.shift();
        const idx = state.songs.findIndex(s => String(s.id) === String(nextId));
        const song = state.songs[idx];
        if(!song || song.missing || (song.isLocal && !song.url)) continue;
        playSong(idx);
        renderUpNext();
        return;
      }
      if(keepFull && !window.matchMedia('(min-width:900px)').matches){
        $('fullPlayerOverlay').classList.add('active');
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
        if(keepFull && !window.matchMedia('(min-width:900px)').matches){
          $('fullPlayerOverlay').classList.add('active');
        }
        return;
      }
      if(!state.songs.length) return;
      let i=state.currentIndex+1;
      if(state.isShuffle && state.songs.length>1){ do{ i=Math.floor(Math.random()*state.songs.length); }while(i===state.currentIndex); }
      if(i>=state.songs.length) i=0;
      playSong(i, keepFull);
      if(keepFull && !window.matchMedia('(min-width:900px)').matches){
        $('fullPlayerOverlay').classList.add('active');
      }
      renderUpNext();
    }

    function openCurrentTrackMenu(e){
      e.stopPropagation();
      if(state.songs[state.currentIndex]) openTrackMenu(e, state.songs[state.currentIndex].id);
    }
    $('fullHeaderMenuBtn').onclick=openCurrentTrackMenu;
    const artInfoBtn=$('artInfoBtn');
    if(artInfoBtn) artInfoBtn.onclick=openCurrentTrackMenu;
    const artShareBtn=$('artShareBtn');
    if(artShareBtn) artShareBtn.onclick=e=>{
      e.stopPropagation();
      const song=state.songs[state.currentIndex];
      if(song) shareTrack(song);
    };
    $('fullPrevBtn').onclick=e=>{e.stopPropagation();playPrevious(true);};
    $('fullNextBtn').onclick=e=>{e.stopPropagation();playNext(true);};
    $('nextBtn').onclick=e=>{e.stopPropagation();playNext(false);};


/* Song-row menus live in library markup and carry their id in a data
   attribute. Delegating here means ids like "hf:<bucket path>" never have to be
   embedded inside an inline onclick as JavaScript source. */
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target?.closest?.('[data-song-menu]') as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openTrackMenu(e, btn.dataset.songMenu || '');
}, true);
