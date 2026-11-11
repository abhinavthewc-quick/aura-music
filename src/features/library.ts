import { escapeHtml, stateHTML, toast } from '../core/dom';
import { buildArtistGroups, resolveArtistSelection, selectArtist, type ArtistGroup, type ArtistSelection } from '../core/artistGroups';
import { DEFAULT_COVER, fetchHfCatalog, getCachedArtistDirectory, readArtistsCache, type ArtistMeta } from '../core/catalog';
import {
  artistMetadataCreditHTML, getArtistMetadataRevision, getAutomaticArtistMetadata,
  observeArtistMetadataCards, prioritizeArtistMetadata, setArtistMetadataCatalog, setArtistPortraitSource,
} from '../core/artistMetadata';
import type { DisplayArtistProfile } from '../../lib/artistMetadata';
import { beginPlaybackIntent } from '../core/playbackIntent';
import { refreshArtistViews, renderAuraPicks, renderQuickAccess, renderQuickPicks } from './home';
import { filterSongs, loadSong, playSong, resetFullPlayerArtToImage, stopAuraYouTube, updateMainMediaSession, updatePlayState } from './player';
import { filterSearchTab } from './search';
import { applyPlayDeepLink } from './deeplink';
import { refreshPlaylistViews } from './playlists';
import { renderUpNext } from './queue';
import { currentRadioStation } from './radio';
import { goTab } from '../ui/nav';
import { $, getPlayCount, persistLikedHistory, rebuildSongs, recordPlayCount, savedLikeMap, setHfTracks, state, trackKey } from '../core/state';
/* ===== 3006-3012 ===== */
    /* Library Count */
    /* Home sections rebuild a lot of markup; coalesce the many callers
       (add/remove/favourite/catalog refresh) into one paint per frame. */
    let homeSectionsRaf = 0;
    function scheduleHomeSections(){
      if(homeSectionsRaf) return;
      homeSectionsRaf = requestAnimationFrame(() => {
        homeSectionsRaf = 0;
        try{ renderQuickAccess(); refreshArtistViews(); }catch(e){}
      });
    }
    export function updateLibCount(){
      const _lc = $('libCount'); if(_lc) _lc.textContent = `${state.songs.length} track${state.songs.length!==1?'s':''} in your library`;
      setArtistMetadataCatalog(getArtistGroups().filter(g => !g.key.startsWith('unresolved:')).map(g => g.name));
      scheduleHomeSections();
    }

/* ===== 3016-3037 ===== */
    export function addToRecent(song){
      if(song){
        recordPlayCount(song.id, trackKey(song));
      }
      state.recentlyPlayed = state.recentlyPlayed.filter(s => s.id !== song.id);
      state.recentlyPlayed.unshift({id:song.id,title:song.title,artist:song.artist,img:song.img});
      state.recentlyPlayed = state.recentlyPlayed.slice(0,10);
      try{ localStorage.setItem('recentlyPlayed', JSON.stringify(state.recentlyPlayed)); }catch(e){}
      schedulePlaybackHomeRefresh();
    }

    /* Starting a track used to rebuild every Home rail (recent cards, quick
       picks, featured artists, aura picks) synchronously on the play tap, which
       froze mid-range phones for a beat each time. Coalesce those paints into
       one frame, and only spend them when Home is actually the visible tab —
       otherwise remember the change and paint it on the next Home visit. */
    let playbackHomeRaf = 0;
    let playbackHomePending = false;

    function paintPlaybackHomeSections(){
      try{ renderRecent(); }catch(e){}
    }

    export function schedulePlaybackHomeRefresh(){
      playbackHomePending = true;
      if(playbackHomeRaf) return;
      playbackHomeRaf = requestAnimationFrame(()=>{
        playbackHomeRaf = 0;
        if(!playbackHomePending) return;
        if(!$('tabHome')?.classList.contains('active')) return;
        playbackHomePending = false;
        paintPlaybackHomeSections();
      });
    }

    export function flushPlaybackHomeRefresh(){
      if(!playbackHomePending) return;
      if(!$('tabHome')?.classList.contains('active')) return;
      if(playbackHomeRaf){ cancelAnimationFrame(playbackHomeRaf); playbackHomeRaf = 0; }
      playbackHomePending = false;
      paintPlaybackHomeSections();
    }

    export function renderRecent(){
      try{renderAuraPicks();}catch(e){}
      const sec = $('recentSection'), c = $('recentScroll');
      if(!state.recentlyPlayed.length){ sec.style.display='none'; return; }
      sec.style.display='block';
      const cards:string[] = [];
      state.recentlyPlayed.forEach(s=>{
        let idx = state.songs.findIndex(item=>item.id===s.id);
        if(idx===-1 && s.title) idx = state.songs.findIndex(item=>item.title===s.title && item.artist===s.artist);
        if(idx===-1) return;
        cards.push(`<div class="recent-card" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'track')}" onclick="playSong(${idx})"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><p>${escapeHtml(s.title)}</p></div>`);
      });
      c.innerHTML=cards.join('');
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
      scheduleHomeSections();
      toast('Track updated', 'circle-check');
      closeEditModal();
    }

    /* Delete track */
    export async function deleteTrack(e, id){
      if(e) e.stopPropagation();
      const song = state.addedSongs.find(s => String(s.id) === String(id));
      if(!song) return;
      if(!confirm(`Remove "${song.title}" from your library?`)) return;

      if(song.isLocal && hasIndexedDB){
        try{ await deleteLocalBlob(song.id); }catch(err){ /* best effort */ }
      }

      // IndexedDB can finish after another track has been selected. Reconcile
      // against the live identity, never the index captured before the await.
      const removedCurrent = String(state.songs[state.currentIndex]?.id) === String(song.id);
      const removedMainPlayback = removedCurrent && !currentRadioStation;
      if(removedCurrent){
        if(removedMainPlayback) beginPlaybackIntent();
        state.audio.pause();
        state.audio.onerror = null;
        state.audio.removeAttribute('src');
        state.audio.load();
        state.isPlaying = false;
        state.currentIndex = -1;
        if(removedMainPlayback) stopAuraYouTube();
      }
      state.addedSongs = state.addedSongs.filter(s => String(s.id) !== String(song.id));
      rebuildSongs();
      state.recentlyPlayed = state.recentlyPlayed.filter(s => String(s.id) !== String(song.id));
      localStorage.setItem('recentlyPlayed', JSON.stringify(state.recentlyPlayed));
      persistAddedSongs();
      if(song.isLocal && song.url?.startsWith('blob:')) URL.revokeObjectURL(song.url);

      if(removedCurrent){
        resetFullPlayerArtToImage('');
        $('currentImg').src=''; $('currentTitle').textContent='Select Track'; $('currentArtist').textContent='--';
        $('fullPlayerOverlay').classList.remove('active');
        $('upNextSheet').classList.remove('active');
        $('miniPlayer').classList.remove('active');
        if(removedMainPlayback && 'mediaSession' in navigator){ navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
        updatePlayState();
      }

      filterSongs();
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      if($('tabSearch').classList.contains('active')) filterSearchTab();
      updateLibCount();
      renderRecent();
      renderUpNext();
      refreshPlaylistViews();
      toast('Track removed from your library', 'circle-check');
    }

/* ===== 4925-4991 ===== */
    export function toggleFavorite(e, id) {
      if(e) e.stopPropagation();
      const song = typeof id === 'number' ? state.songs[id] : state.songs.find(s => String(s.id) === String(id));
      if(!song) return;
      const focused = document.activeElement as HTMLElement | null;
      const focusList = focused?.matches('.song-item-like')
        ? focused.closest<HTMLElement>('#songList, #librarySongList, #searchResultsList') : null;
      const focusIndex = focusList ? [...focusList.querySelectorAll('.song-item-like')].indexOf(focused) : -1;
      song.favorite = !song.favorite;
      if(song.favorite) savedLikeMap[String(song.id)]=true; else delete savedLikeMap[String(song.id)];
      persistLikedHistory();
      // Keep the full-player heart in sync immediately.
      if(state.currentIndex >= 0 && state.songs[state.currentIndex] && String(state.songs[state.currentIndex].id)===String(song.id)){
        $('fullLikeBtn').className=`like-btn ${song.favorite?'active':''}`;
        $('fullLikeBtn').setAttribute('aria-pressed', song.favorite ? 'true' : 'false');
        $('fullLikeBtn').innerHTML=`<i class="fa-${song.favorite?'solid':'regular'} fa-heart"></i>`;
      }
      toast(song.favorite ? 'Saved to Liked Songs' : 'Removed from Liked Songs', song.favorite ? 'heart' : 'heart-crack');
      filterSongs();
      renderQuickAccess();
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      if($('tabSearch').classList.contains('active')) filterSearchTab();
      if(focusList){
        const rows = [...focusList.querySelectorAll<HTMLElement>('.song-item')];
        const sameTrack = rows.find(row => row.dataset.songId === String(song.id));
        const next = (sameTrack || rows[Math.min(focusIndex, rows.length - 1)])?.querySelector<HTMLElement>('.song-item-like');
        if(next) next.focus({preventScroll:true});
        else { focusList.tabIndex = -1; focusList.focus({preventScroll:true}); }
      }
    }

    export function songIndexById(){
      const map = new Map<string, number>();
      state.songs.forEach((s, i) => map.set(String(s.id), i));
      return map;
    }
    function skeletonRows(count = 6){
      return Array.from({length: count}, () =>
        `<div class="song-skeleton" aria-hidden="true">
          <div class="skeleton-block skeleton-cover"></div>
          <div class="skeleton-lines"><div class="skeleton-block skeleton-line"></div><div class="skeleton-block skeleton-line short"></div></div>
        </div>`).join('');
    }

    export function songItemHTML(s, songIdx?){
      let index = -1;
      if(typeof songIdx === 'number' && songIdx >= 0 && songIdx < state.songs.length){
        const candidate = state.songs[songIdx];
        if(candidate && (candidate.id === s.id || String(candidate.id) === String(s.id))){
          index = songIdx;
        }
      }
      if(index === -1){
        index = state.songs.findIndex(item => item.id === s.id || String(item.id) === String(s.id));
      }
      if(index === -1 && s.title){
        index = state.songs.findIndex(item => item.title === s.title && item.artist === s.artist);
      }
      const title = escapeHtml(s.title || 'Untitled');
      const artist = escapeHtml(s.artist || 'Unknown Artist');
      const cover = escapeHtml(s.img || DEFAULT_COVER);
      const favTarget = index >= 0 ? index : escapeHtml(JSON.stringify(String(s.id)));
      return `<div class="song-item ${index >= 0 && index===state.currentIndex?'active':''}" data-song-id="${escapeHtml(String(s.id))}">
          <button type="button" class="song-item-play" aria-label="Play ${title} by ${artist}" onclick="playSong(${index})" ${index < 0 ? 'disabled' : ''}>
            <span class="song-info"><img src="${cover}" alt="" loading="lazy" decoding="async"><span class="song-meta"><span class="song-title">${title}</span><span class="song-artist">${artist}</span></span></span>
          </button>
          <div class="song-item-actions">
            <button type="button" class="song-item-like ${s.favorite?'active':''}" aria-label="${s.favorite?'Unlike':'Like'} ${title}" aria-pressed="${s.favorite?'true':'false'}" onclick="toggleFavorite(event, ${favTarget})"><i class="fa-${s.favorite?'solid':'regular'} fa-heart" aria-hidden="true"></i></button>
            <button type="button" class="song-item-menu-btn" data-song-menu="${escapeHtml(String(s.id))}" aria-label="More options for ${title}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>
          </div>
        </div>`;
    }

    export function renderSongs(list){
      const c=$('songList'); if(!c) return;
      if(!list.length){
        if(state.catalogLoading){ c.innerHTML = skeletonRows(6); return; }
        if(state.catalogError){
          c.innerHTML = stateHTML('error','Couldn\'t load your library','The remote catalogue is unreachable. Check your connection and try again.','Try again','retryCatalog()');
          return;
        }
        if(!state.songs.length){
          c.innerHTML = stateHTML('empty','Your library is empty','Your saved music will appear here after the catalogue refreshes.','Refresh library','retryCatalog()');
          return;
        }
        c.innerHTML = stateHTML('noresults','No tracks found','Try a different spelling or another filter.');
        return;
      }
      // Sort most played songs at the top, rest downwards
      const sorted = [...list].sort((a, b) => {
        const diff = getPlayCount(b) - getPlayCount(a);
        return diff !== 0 ? diff : 0;
      });
      const indexById = songIndexById();
      c.innerHTML = sorted.map(s => songItemHTML(s, indexById.get(String(s.id)))).join('');
    }

/* ===== Library tab view switcher: Tracks / Artists / Albums / Films ===== */
    let libView = 'tracks';
    const libGroupIndex = new Map<string, number[]>();

    export function setLibView(v){
      libView = v === 'artists' || v === 'albums' || v === 'films' ? v : 'tracks';
      currentArtist = null;   // any explicit view switch leaves artist pages
      document.querySelectorAll('#libViewSeg .lib-seg-btn').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.view === libView);
      });
      renderLibrary();
    }

    export function playLibGroup(key){
      const idxs = libGroupIndex.get(key);
      if(idxs && idxs.length) playSong(idxs[0]);
    }

    /* ---------- Artists: library-wide grouping, circle tiles, detail page ----------
       One source of truth for Home (scrolling row) and Library (grid tab):
       verified aliases, conservative credit parsing and cloud ownership all
       resolve before grouping. The catalogue's attribution stays untouched. */
    let artistGroupingSnapshot: {
      profiles: Record<string, ArtistMeta>;
      directory: ReturnType<typeof getCachedArtistDirectory>;
      metadataRevision: number;
      inputs: { song: any; id: any; artist: any; img: any }[];
      groups: ArtistGroup[];
    } | undefined;
    export function getArtistGroups(){
      const profiles = readArtistsCache(), directory = getCachedArtistDirectory(), metadataRevision = getArtistMetadataRevision();
      const previous = artistGroupingSnapshot;
      // Home's shelf, grid, spotlight, stats and both detail views often paint
      // together. Reuse their snapshot; also notice in-place local metadata edits.
      if(previous && previous.profiles === profiles && previous.directory === directory && previous.metadataRevision === metadataRevision &&
        previous.inputs.length === state.songs.length && state.songs.every((song, i) => {
          const before = previous.inputs[i];
          return before.song === song && before.id === song?.id && before.artist === song?.artist && before.img === song?.img;
        })) return previous.groups;
      const groups = buildArtistGroups(state.songs, profiles, {
        authoritativeProfiles: directory.artists, authoritativeNames: Object.values(directory.trackArtists),
        automaticMetadata: getAutomaticArtistMetadata,
      });
      artistGroupingSnapshot = { profiles, directory, metadataRevision, groups,
        inputs: state.songs.map(song => ({ song, id: song?.id, artist: song?.artist, img: song?.img })) };
      return groups;
    }

    function artistInitial(name){ return String(name || '').trim().charAt(0) || '#'; }
    function artistAvatarHTML(g, cls){
      if(g.cover) return `<img class="artist-avatar ${cls || ''}" data-artist-portrait src="${escapeHtml(g.cover)}" alt="">`;
      return `<span class="artist-avatar artist-avatar-fallback ${cls || ''}">${escapeHtml(artistInitial(g.name))}</span>`;
    }

    export function artistProfileDetailsHTML(profile?: DisplayArtistProfile): string {
      if(!profile) return '';
      const bio = typeof profile.bio === 'string' && profile.bio.trim() ? `<p class="artist-bio">${escapeHtml(profile.bio.slice(0, 2000))}</p>` : '';
      const genres = Array.isArray(profile.genres) && profile.genres.length
        ? `<div class="artist-genres">${profile.genres.slice(0, 20).map(g => `<span>${escapeHtml(String(g).slice(0, 120))}</span>`).join('')}</div>` : '';
      const credits = (profile.img ? artistMetadataCreditHTML(profile.imageCredit, 'image') : '') +
        (bio ? artistMetadataCreditHTML(profile.bioCredit, 'bio') : '');
      let social = '';
      try{
        const url = new URL(profile.social || '');
        if(url.protocol === 'https:' && !url.username && !url.password){
          social = `<a class="artist-social-link" href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Artist website <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`;
        }
      }catch{ /* no external link */ }
      return bio || genres || social || credits ? `<div class="artist-profile-details">${bio}${credits}${genres}${social}</div>` : '';
    }

    /** Automatic arrivals cannot replace track/artist buttons. Only this
        reading block changes; keep an equivalent source link focused too. */
    export function updateArtistProfileDetails(container: HTMLElement, profile?: DisplayArtistProfile, before?: Element, portrait?: HTMLImageElement) {
      const previous = [...container.children].find(element => element.classList.contains('artist-profile-details')) as HTMLElement | undefined;
      const template = document.createElement('template');
      template.innerHTML = artistProfileDetailsHTML(profile);
      const next = template.content.firstElementChild as HTMLElement | null;
      if(portrait?.dataset.coverFallback) next?.querySelector<HTMLElement>('[data-artist-credit="image"]')?.setAttribute('hidden', '');
      if(previous?.isEqualNode(next) || !previous && !next) return;
      const focused = document.activeElement as HTMLElement | null;
      const sourceHref = previous?.contains(focused) && focused instanceof HTMLAnchorElement ? focused.href : '';
      const sourceField = sourceHref ? focused?.closest('[data-artist-credit]')?.getAttribute('data-artist-credit') : undefined;
      if(previous) { if(next) previous.replaceWith(next); else previous.remove(); }
      else if(next) container.insertBefore(next, before || null);
      if(sourceHref) {
        const equivalent = [...(next?.querySelectorAll<HTMLAnchorElement>('a') || [])].find(link =>
          link.href === sourceHref && link.closest('[data-artist-credit]')?.getAttribute('data-artist-credit') === sourceField);
        if(equivalent) equivalent.focus({ preventScroll: true });
      }
    }

    export function artistTileHTML(g, i){
      return `<button type="button" class="artist-tile" data-artist-key="${escapeHtml(g.key)}" data-artist-metadata-name="${g.key.startsWith('unresolved:') ? '' : escapeHtml(g.name)}" onclick="openArtist(${i})">${artistAvatarHTML(g, '')}<span class="artist-name">${escapeHtml(g.name)}</span></button>`;
    }

    let currentArtist: ArtistSelection | null = null;
    let artistGroupsCache: ArtistGroup[] = [];

    function renderLibraryArtists(){
      const c = $('librarySongList');
      const heading = $('allTracksSection');
      artistGroupsCache = getArtistGroups();
      if(!artistGroupsCache.length){
        if(heading) heading.style.display = 'none';   // no artists -> no empty heading
        c.innerHTML = '';
        return;
      }
      if(heading){ heading.style.display = ''; heading.textContent = 'Artists'; }
      if(currentArtist != null){
        const g = resolveArtistSelection(artistGroupsCache, currentArtist);
        const gi = g ? artistGroupsCache.indexOf(g) : -1;
        if(g){
          currentArtist = selectArtist(g);
          const n = g.songs.length;
          c.innerHTML = `<div class="artist-page">
            <button type="button" class="artist-page-back" onclick="setLibView('artists')"><i class="fa-solid fa-arrow-left"></i> Artists</button>
            <div class="artist-page-head">
              ${artistAvatarHTML(g, 'artist-page-avatar')}
              <div class="artist-page-meta"><div class="artist-page-name">${escapeHtml(g.name)}</div><div class="lib-group-sub">${n} song${n !== 1 ? 's' : ''}</div></div>
              <div class="artist-page-actions">
                <button type="button" onclick="playArtist(${gi})"><i class="fa-solid fa-play"></i> Play</button>
                <button type="button" onclick="shuffleArtist(${gi})"><i class="fa-solid fa-shuffle"></i> Shuffle</button>
              </div>
            </div>
            ${artistProfileDetailsHTML(g.profile)}
            <div class="song-list">${g.songs.map(songItemHTML).join('')}</div>
          </div>`;
          return;
        }
        currentArtist = null;
      }
      c.innerHTML = `<div class="artist-tiles">${artistGroupsCache.map((g, i) => artistTileHTML(g, i)).join('')}</div>`;
      observeArtistMetadataCards(c);
    }

    export function refreshAutomaticLibraryArtists(){
      if(libView !== 'artists') return;
      const groups = getArtistGroups();
      artistGroupsCache = groups;
      const updateAvatar = (avatar: Element | null, group: ArtistGroup, cls = '') => {
        if(!avatar) return;
        if(avatar instanceof HTMLImageElement && group.cover) setArtistPortraitSource(avatar, group.cover);
        else {
          const template = document.createElement('template');
          template.innerHTML = artistAvatarHTML(group, cls);
          const next = template.content.firstElementChild;
          if(next && !avatar.isEqualNode(next)) avatar.replaceWith(next);
        }
      };
      const container = $('librarySongList');
      if(currentArtist) {
        const group = resolveArtistSelection(groups, currentArtist), page = container.querySelector<HTMLElement>('.artist-page');
        if(!group || !page) return;
        updateAvatar(page.querySelector('.artist-page-avatar'), group, 'artist-page-avatar');
        updateArtistProfileDetails(page, group.profile, page.querySelector('.song-list'), page.querySelector<HTMLImageElement>('.artist-page-avatar'));
      } else {
        const byKey = new Map(groups.map(group => [group.key, group]));
        container.querySelectorAll<HTMLElement>('.artist-tile').forEach(tile => {
          const group = byKey.get(tile.dataset.artistKey || '');
          if(group) updateAvatar(tile.querySelector('.artist-avatar'), group);
        });
      }
    }

    export function openArtist(i){
      const groups = artistGroupsCache.length ? artistGroupsCache : getArtistGroups();
      artistGroupsCache = groups;
      currentArtist = groups[i] ? selectArtist(groups[i]) : null;
      if(groups[i] && !groups[i].key.startsWith('unresolved:')) prioritizeArtistMetadata(groups[i].name, 'open');
      libView = 'artists';
      document.querySelectorAll('#libViewSeg .lib-seg-btn').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.view === 'artists');
      });
      goTab('tabLibrary');
      renderLibrary();
    }

    export function playArtist(i, shuffle){
      const groups = artistGroupsCache.length ? artistGroupsCache : getArtistGroups();
      artistGroupsCache = groups;
      const g = groups[i];
      if(!g || !g.songs.length) return;
      const idxs = g.songs.map(s => state.songs.findIndex(x => x.id === s.id)).filter(x => x >= 0);
      if(!idxs.length) return;
      if(shuffle){
        if(!state.isShuffle){ state.isShuffle = true; const sb = $('shuffleBtn'); if(sb) sb.classList.add('mode-active'); }
      }
      const pick = shuffle ? idxs[Math.floor(Math.random() * idxs.length)] : idxs[0];
      playSong(pick);
      $('fullPlayerOverlay').classList.add('active');
    }
    export function shuffleArtist(i){ playArtist(i, true); }

    /* Soundtrack credit lives in the album/title as (From "Film Name" …) */
    const FILM_RE = /\(\s*From\s+[“"「＂]([^”"」＂]+)[”"」＂]/i;
    function filmOf(s){
      const m = ((s.album||'') + ' ' + (s.title||'')).match(FILM_RE);
      return m ? m[1].trim() : '';
    }

    function groupsFor(view){
      const groups = new Map<string, {name: string, songs: any[]}>();
      const push = (key, name, s) => {
        let g = groups.get(key);
        if(!g){ g = {name, songs: []}; groups.set(key, g); }
        g.songs.push(s);
      };
      if(view === 'albums'){
        state.songs.forEach(s => {
          const al = (s.album||'').trim();
          push(al ? 'album:'+al : 'album:', al || 'Singles & extras', s);
        });
      }else{
        state.songs.forEach(s => {
          const f = filmOf(s);
          if(f) push('film:'+f, f, s);
        });
      }
      /* busiest group first; ties alphabetical */
      return [...groups.entries()].sort((a,b) => b[1].songs.length - a[1].songs.length || a[1].name.localeCompare(b[1].name));
    }

    function renderGroups(view){
      const c = $('librarySongList');
      const groups = groupsFor(view);
      libGroupIndex.clear();
      if(!groups.length){
        c.innerHTML = view === 'films'
          ? stateHTML('noresults','No film songs yet','Soundtrack tracks group here once album metadata (manifest.json) reaches the site.')
          : stateHTML('empty','No album metadata yet','Album data arrives with manifest.json after the next managed workflow run.');
        return;
      }
      let gi = 0;
      const indexById = songIndexById();
      c.innerHTML = groups.map(([ , g]) => {
        const gkey = 'g' + (gi++);
        const groupName = escapeHtml(g.name);
        libGroupIndex.set(gkey, g.songs.map(s => indexById.get(String(s.id)) ?? -1).filter(i => i >= 0));
        const n = g.songs.length;
        return `<div class="lib-group">
          <div class="lib-group-head">
            <img class="lib-group-art" src="${escapeHtml(g.songs[0]?.img || DEFAULT_COVER)}" alt="" loading="lazy" decoding="async">
            <div class="lib-group-meta"><div class="lib-group-name">${groupName}</div><div class="lib-group-sub">${n} track${n!==1?'s':''}</div></div>
            <button type="button" class="lib-group-play" data-gplay="${gkey}" title="Play ${groupName}" aria-label="Play ${groupName}"><i class="fa-solid fa-play" aria-hidden="true"></i></button>
          </div>
          <div class="song-list lib-group-list">${g.songs.map(s => songItemHTML(s, indexById.get(String(s.id)))).join('')}</div>
        </div>`;
      }).join('');
      c.querySelectorAll('[data-gplay]').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); playLibGroup((btn as HTMLElement).dataset.gplay); });
      });
    }

    export function renderLibrary(){
      const c=$('librarySongList');
      const heading=$('allTracksSection');
      if(heading) heading.textContent = libView==='artists'?'Artists':libView==='albums'?'Albums':libView==='films'?'Films':'All tracks';
      if(!state.songs.length){
        if(state.catalogLoading) c.innerHTML = skeletonRows(8);
        else if(state.catalogError) c.innerHTML = stateHTML('error','Couldn\'t load your library','The remote catalogue is unreachable. Check your connection and try again.','Try again','retryCatalog()');
        else c.innerHTML=stateHTML('empty','Your library is empty','Your saved music will appear here after the catalogue refreshes.','Refresh library','retryCatalog()');
      }else if(libView==='tracks'){
        // Sort most played songs at the top, rest downwards
        const sorted = [...state.songs].sort((a, b) => {
          const diff = getPlayCount(b) - getPlayCount(a);
          return diff !== 0 ? diff : 0;
        });
        const indexById = songIndexById();
        c.innerHTML=sorted.map(s => songItemHTML(s, indexById.get(String(s.id)))).join('');
      }else if(libView==='artists'){
        renderLibraryArtists();
      }else{
        renderGroups(libView);
      }
      updateLibNowPlaying();
      if($('statsPanel').style.display!=='none') renderStatsPanel();
    }

    export function updateLibNowPlaying(){
      const el=$('libNowPlayingSub');
      if(!el) return;
      const song = state.songs[state.currentIndex];
      el.textContent = song ? `${song.title} — ${song.artist}` : 'Nothing playing';
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
      const albumCount = new Set(state.songs.map(s=>String(s.album||'').trim()).filter(Boolean)).size;
      const artistCount = getArtistGroups().length;
      $('statsPanel').innerHTML = `
        <div class="stats-cell"><div class="stat-num">${state.songs.length}</div><div class="stat-label">Total Tracks</div></div>
        <div class="stats-cell"><div class="stat-num">${favCount}</div><div class="stat-label">Favorites</div></div>
        <div class="stats-cell"><div class="stat-num">${albumCount}</div><div class="stat-label">Albums</div></div>
        <div class="stats-cell"><div class="stat-num">${artistCount}</div><div class="stat-label">Artists</div></div>`;
    }

    /* First load and an explicit retry must finish through the same path, so
       artist/playlist views and still-pending track links all recover together. */
    export function reconcileCatalog(tracks: any[]){
      state.catalogLoading = false;
      state.catalogError = false;
      const hadSongs = state.songs.length > 0;
      setHfTracks(tracks);
      renderSongs(state.songs);
      renderRecent();
      renderQuickPicks();
      refreshArtistViews();
      refreshPlaylistViews();
      updateLibCount();
      const song = state.songs[state.currentIndex];
      if(song){
        for(const id of ['currentArtist', 'fullArtist']) if($(id)) $(id).textContent = song.artist;
        updateMainMediaSession();
      }
      if(!hadSongs && state.songs.length) loadSong(state.currentIndex);
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      if($('tabSearch').classList.contains('active')) filterSearchTab();
      if($('fullPlayerOverlay').classList.contains('active') || $('upNextSheet').classList.contains('active')) renderUpNext();
      applyPlayDeepLink();
    }

    /* Retry the remote catalogue from the error state's button. */
    export async function retryCatalog(){
      if(state.catalogLoading) return;
      state.catalogLoading = true;
      state.catalogError = false;
      renderSongs(state.songs);
      if($('tabLibrary').classList.contains('active')) renderLibrary();
      try{
        reconcileCatalog(await fetchHfCatalog());
      }catch(e){
        state.catalogLoading = false;
        state.catalogError = true;
        toast('Could not refresh the Aura catalogue. Showing the last saved library.','triangle-exclamation');
        renderSongs(state.songs);
        if($('tabLibrary').classList.contains('active')) renderLibrary();
      }
    }
