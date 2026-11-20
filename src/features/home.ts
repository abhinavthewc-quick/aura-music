import { timeGreeting, toast } from '../core/dom';
import { artistMatchKey } from '../core/artist-names';
import { playSong } from './player';
import { escapeHtml } from './radio';
import { DEFAULT_COVER } from '../core/catalog';
import { $, state } from '../core/state';
import { getArtistGroups } from './library';
import { goTab } from '../ui/nav';
import { playArtistCollection, renderArtistPage, type ArtistPageEntry } from './artist-page';
/* ===== 3075-3096 ===== */
    export function setGreeting(){
      $('greetingLabel').textContent = timeGreeting();
    }

    /* Jump back in to the last played track */
    export function resumeLastPlayed(){
      if(!state.recentlyPlayed.length) return toast('Nothing played yet', 'circle-info');
      const idx = state.songs.findIndex(s=>s.id===state.recentlyPlayed[0].id);
      if(idx===-1) return toast('That track is no longer available', 'triangle-exclamation');
      playSong(idx);
      $('fullPlayerOverlay').classList.add('active');
    }

    /* Play a random track from the whole library */
    export function shuffleAll(){
      if(!state.songs.length) return toast('Your library is empty', 'circle-info');
      if(!state.isShuffle){ state.isShuffle=true; $('shuffleBtn').classList.add('mode-active'); }
      const idx = Math.floor(Math.random()*state.songs.length);
      playSong(idx);
      $('fullPlayerOverlay').classList.add('active');
    }

/* ===== 3105-3161 ===== */
    /* Home: quick-access tiles built from real library data */
    export function renderQuickAccess(){
      if(typeof updateDesktopHeroStats==='function') updateDesktopHeroStats();
      renderQuickPicks();
      renderFeaturedArtistsShelf();
      const favCount = state.songs.filter(s=>s.favorite).length;
      const last = state.recentlyPlayed[0] ? state.songs.find(s=>s.id===state.recentlyPlayed[0].id) : null;

      const tiles = [
        `<div class="quick-tile" role="button" tabindex="0" onclick="goToSearchCategory('favorites')">
          <div class="quick-tile-art cat-favorites"><i class="fa-solid fa-heart"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Liked songs</div><div class="qt-sub">${favCount} track${favCount!==1?'s':''}</div></div>
        </div>`,
        last ? `<div class="quick-tile" role="button" tabindex="0" onclick="resumeLastPlayed()">
          <div class="quick-tile-art"><img src="${escapeHtml(last.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"></div>
          <div class="quick-tile-text"><div class="qt-title">Jump back in</div><div class="qt-sub">${escapeHtml(last.title)}</div></div>
        </div>` : `<div class="quick-tile" role="button" tabindex="0" onclick="shuffleAll()">
          <div class="quick-tile-art cat-shuffle"><i class="fa-solid fa-shuffle"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Shuffle all</div><div class="qt-sub">Random pick</div></div>
        </div>`,
        `<div class="quick-tile" role="button" tabindex="0" onclick="goToSearchCategory('recent')">
          <div class="quick-tile-art cat-recent"><i class="fa-solid fa-clock-rotate-left"></i></div>
          <div class="quick-tile-text"><div class="qt-title"><span class="qt-long">Recently played</span><span class="qt-short">Recent</span></div><div class="qt-sub">${state.recentlyPlayed.length} track${state.recentlyPlayed.length!==1?'s':''}</div></div>
        </div>`
      ];
      $('quickGrid').innerHTML = tiles.join('');
    }

    /* Actual library collections, not speculative mood recommendations. */
    let currentMood = 'all';
    let currentQuickPage = 0;

    /* Every play calls updateLibCount(), which rebuilds the home rails on the
       next frame. Re-creating ~30 <img> nodes for identical content made the
       page flash and re-decode artwork, so each rail compares a cheap
       signature first and only writes the DOM when something actually changed. */
    let quickPicksKey = '';
    let artistsShelfKey = '';
    let spotlightKey = '';

    /* A heart tap changes one boolean. Rebuilding the picks, the artist shelf
       and 493 library rows for it is what made favouriting feel sticky, so the
       visible hearts are patched in place (library.ts) and only the tiles whose
       text/count depends on favourites are refreshed here. */
    export function refreshFavoriteChrome(){
      updateDesktopHeroStats();
      const sub = document.querySelector<HTMLElement>('#quickGrid .quick-tile:first-child .qt-sub');
      if (sub) {
        const count = state.songs.filter(s => s.favorite).length;
        sub.textContent = `${count} track${count !== 1 ? 's' : ''}`;
      }
      if (currentMood === 'favorites') renderQuickPicks();
    }

    export function renderQuickPicks(page?: number){
      const container = $('ytmQuickGrid');
      if(!container) return;
      if(!state.songs || !state.songs.length){
        /* A cold visit has no catalogue yet. Saying "no tracks" there read as a
           broken library for the seconds before the first response, so paint
           the shape of the rail instead and let the real cards replace it. */
        if(state.catalogLoading){
          if(quickPicksKey === 'loading') return;
          quickPicksKey = 'loading';
          /* index.html ships the same skeleton markup so the rail is already
             on screen when the splash dissolves; only fill an empty rail. */
          if(container.querySelector('.skeleton-block')) return;
          container.innerHTML = Array.from({length: 12}, () => `
            <div class="ytm-track-card" aria-hidden="true">
              <div class="ytm-track-art skeleton-block"></div>
              <div class="ytm-track-info">
                <div class="skeleton-block skeleton-line"></div>
                <div class="skeleton-block skeleton-line short"></div>
              </div>
            </div>`).join('');
          return;
        }
        if(quickPicksKey === 'empty') return;
        quickPicksKey = 'empty';
        container.innerHTML = '<p class="home-empty">No library tracks are available yet. Add local audio or check the catalogue connection.</p>';
        return;
      }

      let pool = state.songs.filter((song) => !song.missing);
      if (currentMood === 'favorites') pool = pool.filter((song) => song.favorite);
      if (currentMood === 'recent') pool = state.recentlyPlayed.map((recent) => pool.find((song) => String(song.id) === String(recent.id))).filter(Boolean);
      if (!pool.length) {
        if(quickPicksKey === 'none') return;
        quickPicksKey = 'none';
        container.innerHTML = '<p class="home-empty">No tracks in this collection yet. Choose All or add a favorite from your library.</p>'; return;
      }

      const pageSize = 12; // 3 columns x 4 rows
      const totalPages = Math.max(1, Math.ceil(pool.length / pageSize));
      if(typeof page === 'number') currentQuickPage = ((page % totalPages) + totalPages) % totalPages;
      if(currentQuickPage >= totalPages) currentQuickPage = 0;

      const start = currentQuickPage * pageSize;
      const slice = pool.slice(start, start + pageSize);
      const nextKey = currentMood + '|' + currentQuickPage + '|' + state.currentIndex + '|' + (state.isPlaying ? 1 : 0) + '|' + slice.map(s => s.id).join(',');
      if (nextKey === quickPicksKey) return;
      quickPicksKey = nextKey;

      const html = slice.map(s => {
        const globalIdx = state.songs.findIndex(x => x.id === s.id);
        const isPlaying = state.currentIndex === globalIdx && state.isPlaying;
        return `
          <div class="ytm-track-card ${isPlaying ? 'is-playing' : ''}" role="button" tabindex="0" data-play-song-id="${escapeHtml(s.id)}" title="${escapeHtml(s.title || '')}">
            <div class="ytm-track-art">
              <img src="${escapeHtml(s.img || DEFAULT_COVER)}" alt="" loading="lazy" decoding="async">
              <div class="ytm-play-hover">
                <i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}"></i>
              </div>
            </div>
            <div class="ytm-track-info">
              <div class="ytm-track-title">${escapeHtml(s.title || 'Untitled Track')}</div>
              <div class="ytm-track-artist">${escapeHtml(s.artist || 'Unknown Artist')}</div>
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = html;
    }

    export function setupMoodChips(){
      const chips = document.querySelectorAll('#ytmMoodChips .ytm-chip');
      chips.forEach(chip => {
        chip.addEventListener('click', (e) => {
          chips.forEach(c => c.classList.remove('active'));
          const target = e.currentTarget as HTMLElement;
          target.classList.add('active');
          currentMood = target.dataset.mood || 'all';
          currentQuickPage = 0;
          if (currentMood === 'artists') {
            showArtistsView();
          } else {
            showDefaultHomeView();
            renderQuickPicks();
          }
        });
      });

      $('quickPrevBtn')?.addEventListener('click', () => {
        renderQuickPicks(currentQuickPage - 1);
      });
      $('quickNextBtn')?.addEventListener('click', () => {
        renderQuickPicks(currentQuickPage + 1);
      });
    }

    export interface ArtistDirectoryEntry extends ArtistPageEntry {
      count: number;
    }

    export function getAllArtists(): ArtistDirectoryEntry[] {
      return getArtistGroups().map(group => ({
        key: group.key, name: group.name, img: group.cover || DEFAULT_COVER,
        bio: group.bio, count: group.songs.length, songs: group.songs,
      }));
    }

    function artistForName(artists: ArtistDirectoryEntry[], name: string): ArtistDirectoryEntry | undefined {
      const match = artistMatchKey(name);
      return artists.find(artist => artist.name.toLowerCase() === name.toLowerCase()) ||
        artists.find(artist => match && (artistMatchKey(artist.key) === match || artistMatchKey(artist.name) === match));
    }

    export function renderFeaturedArtistsShelf() {
      const shelf = $('homeFeaturedArtistsShelf');
      if (!shelf) return;
      const artists = getAllArtists();
      if (!artists.length) {
        /* Same reasoning as the quick-picks rail: show the shelf's silhouette
           rather than a text placeholder that jumps when the data lands. */
        const stateKey = state.catalogLoading ? 'loading' : 'empty';
        if (artistsShelfKey === stateKey) return;
        artistsShelfKey = stateKey;
        if (stateKey === 'loading') {
          /* Already painted by the document; leave it alone. */
          if (shelf.querySelector('.skeleton-block')) return;
          shelf.innerHTML = Array.from({length: 8}, () => `
            <div class="ytm-artist-card" aria-hidden="true">
              <div class="ytm-artist-art-wrap skeleton-block"></div>
              <div class="ytm-artist-name skeleton-block skeleton-line" style="width:72%;margin-top:8px"></div>
              <div class="ytm-artist-sub skeleton-block skeleton-line short" style="width:40%;margin-top:6px"></div>
            </div>`).join('');
          return;
        }
        shelf.innerHTML = '<div style="color:var(--text-sub);padding:10px 0;font-size:13px">No artists yet.</div>';
        return;
      }

      const topArtists = artists.slice(0, 16);
      const key = topArtists.map(a => a.key + '|' + a.name + '|' + a.img + '|' + a.count).join('~');
      if (key === artistsShelfKey) return;
      artistsShelfKey = key;
      shelf.innerHTML = topArtists.map(a => `
        <button type="button" class="ytm-artist-card" data-open-artist="${escapeHtml(a.key)}" title="${escapeHtml(a.name)}">
          <div class="ytm-artist-art-wrap">
            <img class="ytm-artist-avatar" src="${escapeHtml(a.img)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async">
            <div class="ytm-artist-play-overlay"><i class="fa-solid fa-play"></i></div>
          </div>
          <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
          <div class="ytm-artist-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
        </button>
      `).join('');
    }

    export function renderArtistsFullGrid() {
      const grid = $('homeArtistsFullGrid');
      if (!grid) return;
      const artists = getAllArtists();
      if (!artists.length) {
        grid.innerHTML = '<div style="color:var(--text-sub);padding:20px;font-size:14px">No artists found in library.</div>';
        return;
      }

      grid.innerHTML = artists.map(a => `
        <button type="button" class="ytm-artist-card grid-card" data-open-artist="${escapeHtml(a.key)}" title="${escapeHtml(a.name)}">
          <div class="ytm-artist-art-wrap">
            <img class="ytm-artist-avatar" src="${escapeHtml(a.img)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async">
            <div class="ytm-artist-play-overlay"><i class="fa-solid fa-play"></i></div>
          </div>
          <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
          <div class="ytm-artist-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
        </button>
      `).join('');
    }

    export function openHomeArtistsTab() {
      const chips = document.querySelectorAll('#ytmMoodChips .ytm-chip');
      chips.forEach(c => c.classList.remove('active'));
      const artistChip = $('homeArtistsChip');
      if (artistChip) artistChip.classList.add('active');
      showArtistsView();
    }

    export function showArtistsView() {
      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      $('tabHome')?.classList.remove('artist-detail-open');
      if (mainView) mainView.style.display = 'none';
      if (detailView) detailView.style.display = 'none';
      if (artistsView) {
        artistsView.style.display = 'block';
        renderArtistsFullGrid();
      }
    }

    export function showDefaultHomeView() {
      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      $('tabHome')?.classList.remove('artist-detail-open');
      if (artistsView) artistsView.style.display = 'none';
      if (detailView) detailView.style.display = 'none';
      if (mainView) mainView.style.display = 'block';
    }

    export function openArtistDetail(artistName: string) {
      const artists = getAllArtists();
      const artist = artistForName(artists, artistName) || {
        key: artistName.toLowerCase().trim(),
        name: artistName,
        img: DEFAULT_COVER,
        count: 0,
        songs: state.songs.filter(s => (s.artist || '').toLowerCase().includes(artistName.toLowerCase()))
      };

      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      $('tabHome')?.classList.add('artist-detail-open');
      if (mainView) mainView.style.display = 'none';
      if (artistsView) artistsView.style.display = 'none';
      if (detailView) detailView.style.display = 'block';

      if (detailView) renderArtistPage(detailView, artist, { prefix: 'artist', onBack: closeArtistDetail });
      goTab('tabHome');
      window.scrollTo({ top: 0, behavior: 'instant' });
      $('artistName')?.focus({ preventScroll: true });
    }

    export function closeArtistDetail() {
      openHomeArtistsTab();
      $('homeArtistsChip')?.focus({ preventScroll: true });
    }

    export function playArtistSongs(artistName: string, shuffle = false, startId?: string) {
      const artists = getAllArtists();
      const artist = artistForName(artists, artistName);
      if (!artist || !artist.songs.length) return;

      playArtistCollection(artist, shuffle, startId);
    }

    document.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLElement>('[data-open-artist]');
      if (!button) return;
      const artist = getAllArtists().find(entry => entry.key === button.dataset.openArtist);
      if (artist) openArtistDetail(artist.name);
    });

    window.addEventListener('aura:library-changed', () => {
      if (!$('tabHome')?.classList.contains('artist-detail-open')) return;
      const name = $('artistName')?.textContent;
      const artist = getAllArtists().find(entry => entry.name === name);
      if (artist) renderArtistPage($('homeArtistDetailView'), artist, { prefix: 'artist', onBack: closeArtistDetail });
    });

    if (typeof window !== 'undefined') {
      (window as any).openHomeArtistsTab = openHomeArtistsTab;
      (window as any).openArtistDetail = openArtistDetail;
      (window as any).closeArtistDetail = closeArtistDetail;
      (window as any).playArtistSongs = playArtistSongs;
    }

    /* Spotlights use the same artist names and collections as the directory. */
    export function renderArtistSpotlight(){
      const artists = getArtistGroups().filter(group => group.songs.length >= 2);
      const container = $('artistSpotlightContainer');

      if(!artists.length){
        if(spotlightKey === 'empty') return;
        spotlightKey = 'empty';
        container.innerHTML=''; return;
      }

      // Each block is a horizontal rail that only ever shows the first few
      // cards before the user scrolls it. Rendering every song of every artist
      // built 334 <img> tags on a real library, and `loading="lazy"` does not
      // defer inside a horizontal scroller, so a phone fetched hundreds of
      // covers to show a rail it could only display ~3 cards of at a time.
      const RAIL_LIMIT = 10;
      const BLOCK_LIMIT = 6;

      const indexById = new Map<string, number>();
      state.songs.forEach((song, i) => indexById.set(String(song.id), i));
      const visible = artists.slice(0, BLOCK_LIMIT);
      const key = visible.map(g => g.key + '|' + g.cover + '|' + g.name + '|' + g.songs.slice(0, RAIL_LIMIT).map(s => s.id).join(',')).join('~');
      if (key === spotlightKey) return;
      spotlightKey = key;
      container.innerHTML = visible.map((g:any)=>{
        const cards = g.songs.slice(0, RAIL_LIMIT).map(s=>{
          const idx = indexById.get(String(s.id)) ?? -1;
          if(idx < 0) return '';
          return `<div class="spotlight-card" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'')}${s.artist ? ' by ' + escapeHtml(s.artist) : ''}" data-play-song-id="${escapeHtml(s.id)}"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><p class="sc-title">${escapeHtml(s.title)}</p><p class="sc-sub">${escapeHtml(s.artist)}</p></div>`;
        }).join('');
        return `<div class="artist-spotlight-block" style="margin-bottom:24px">
          <div class="spotlight-header">
            <img class="spotlight-avatar" src="${escapeHtml(g.cover||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async">
            <div><p style="font-size:11px;color:var(--text-sub)">More from</p><p style="font-size:16px;font-weight:800">${escapeHtml(g.name)}</p></div>
          </div>
          <div class="recent-scroll">${cards}</div>
        </div>`;
      }).join('');
    }

/* ===== 4646-4660 ===== */
    export let auraPickIds=[];
    export function renderAuraPicks(force?){
      const c=$('auraPicksScroll'); if(!c||typeof state.songs==='undefined') return;
      if(!state.songs.length && state.catalogLoading){
        /* index.html ships skeleton cards here too. */
        if(!c.querySelector('.skeleton-block')){
          c.innerHTML = Array.from({length: 8}, () => '<div class="aura-pick" aria-hidden="true"><div class="aura-pick-ph skeleton-block"></div></div>').join('');
        }
        return;
      }
      if(!state.songs.length){
        c.innerHTML = `<div class="aura-empty">
          <i class="fa-solid fa-compact-disc" aria-hidden="true"></i>
          <div><b>No picks yet</b><span>Your Aura library will appear here when the catalogue finishes loading.</span></div>
          <button type="button" class="aura-empty-btn" onclick="openSearch()">Find music</button>
        </div>`;
        return;
      }
      const valid=auraPickIds.filter(id=>state.songs.some(s=>s.id===id));
      /* Re-roll when the library grew (the rail is first painted with the
         cached/local tracks, before the remote catalogue arrives) or shrank. */
      const target = Math.min(8, state.songs.length);
      if(force || !valid.length || valid.length!==auraPickIds.length || auraPickIds.length < target){
        const pool=[...state.songs].sort(()=>Math.random()-.5).slice(0,8);
        auraPickIds=pool.map(s=>s.id);
      }
      c.innerHTML=auraPickIds.map(id=>{
        const i=state.songs.findIndex(s=>s.id===id), s=state.songs[i]; if(!s) return '';
        return `<div class="aura-pick" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'')}${s.artist ? ' by ' + escapeHtml(s.artist) : ''}" data-play-song-id="${escapeHtml(s.id)}"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><span class="aura-pick-play"><i class="fa-solid fa-play"></i></span><div class="aura-pick-info"><b>${escapeHtml(s.title||'')}</b><span>${escapeHtml(s.artist||'')}</span></div></div>`;
      }).join('');
    }
    setTimeout(()=>renderAuraPicks(),0);

/* ===== 6288-6302 ===== */
    export function updateDesktopHeroStats(){
      const set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=String(val);};
      set('desktopHeroTrackCount', Array.isArray(state.songs)?state.songs.length:0);
      set('desktopHeroFavCount', Array.isArray(state.songs)?state.songs.filter(s=>s.favorite).length:0);
      set('desktopHeroRecentCount', Array.isArray(state.recentlyPlayed)?state.recentlyPlayed.length:0);
    }
