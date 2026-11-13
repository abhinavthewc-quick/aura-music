import { timeGreeting, toast } from '../core/dom';
import { resolveArtistSelection, selectArtist, type ArtistSelection } from '../core/artistGroups';
import { playSong } from './player';
import { escapeHtml } from './radio';
import { DEFAULT_COVER } from '../core/catalog';
import { DEFAULT_ARTIST_PORTRAIT, observeArtistMetadataCards, prioritizeArtistMetadata, setArtistPortraitSource } from '../core/artistMetadata';
import { $, state } from '../core/state';
import { getArtistGroups } from './library';
import { playArtistCollection, refreshArtistPageMetadata, renderArtistPage } from './artist-page';
import { goTab } from '../ui/nav';
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

    export function renderQuickPicks(page?: number){
      const container = $('ytmQuickGrid');
      if(!container) return;
      if(!state.songs || !state.songs.length){
        container.innerHTML = '<p class="home-empty">No library tracks are available yet. Add local audio or check the catalogue connection.</p>';
        return;
      }

      let pool = state.songs.filter((song) => !song.missing);
      if (currentMood === 'favorites') pool = pool.filter((song) => song.favorite);
      if (currentMood === 'recent') pool = state.recentlyPlayed.map((recent) => pool.find((song) => String(song.id) === String(recent.id))).filter(Boolean);
      if (!pool.length) { container.innerHTML = '<p class="home-empty">No tracks in this collection yet. Choose All or add a favorite from your library.</p>'; return; }

      const pageSize = 12; // 3 columns x 4 rows
      const totalPages = Math.max(1, Math.ceil(pool.length / pageSize));
      if(typeof page === 'number') currentQuickPage = ((page % totalPages) + totalPages) % totalPages;
      if(currentQuickPage >= totalPages) currentQuickPage = 0;

      const start = currentQuickPage * pageSize;
      const slice = pool.slice(start, start + pageSize);

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

    export interface ArtistDirectoryEntry {
      key: string;
      name: string;
      img: string;
      count: number;
      songs: any[];
      metadataName: string;
    }

    export function getAllArtists(): ArtistDirectoryEntry[] {
      return getArtistGroups().map(g => ({
        key: g.key, name: g.name, img: g.cover || DEFAULT_ARTIST_PORTRAIT,
        count: g.songs.length, songs: g.songs,
         metadataName: g.key.startsWith('unresolved:') ? '' : g.name,
       }));
    }

    export function renderFeaturedArtistsShelf() {
      const shelf = $('homeFeaturedArtistsShelf');
      if (!shelf) return;
      const artists = getAllArtists();
      if (!artists.length) {
        shelf.innerHTML = '<div style="color:var(--text-sub);padding:10px 0;font-size:13px">Loading artists…</div>';
        return;
      }

      const topArtists = artists.slice(0, 16);
      shelf.innerHTML = topArtists.map(a => `
        <div class="ytm-artist-card" role="button" tabindex="0" data-artist-open="${escapeHtml(a.key)}" data-artist-metadata-name="${escapeHtml(a.metadataName)}" title="${escapeHtml(a.name)}">
          <div class="ytm-artist-art-wrap">
            <img class="ytm-artist-avatar" data-artist-portrait src="${escapeHtml(a.img)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async">
            <div class="ytm-artist-play-overlay"><i class="fa-solid fa-play"></i></div>
          </div>
          <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
          <div class="ytm-artist-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
        </div>
      `).join('');
      observeArtistMetadataCards(shelf);
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
        <div class="ytm-artist-card grid-card" role="button" tabindex="0" data-artist-open="${escapeHtml(a.key)}" data-artist-metadata-name="${escapeHtml(a.metadataName)}" title="${escapeHtml(a.name)}">
          <div class="ytm-artist-art-wrap">
            <img class="ytm-artist-avatar" data-artist-portrait src="${escapeHtml(a.img)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async">
            <div class="ytm-artist-play-overlay"><i class="fa-solid fa-play"></i></div>
          </div>
          <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
          <div class="ytm-artist-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
        </div>
      `).join('');
      observeArtistMetadataCards(grid);
    }

    export function openHomeArtistsTab() {
      const chips = document.querySelectorAll('#ytmMoodChips .ytm-chip');
      chips.forEach(c => c.classList.remove('active'));
      const artistChip = $('homeArtistsChip');
      if (artistChip) artistChip.classList.add('active');
      showArtistsView();
    }

    export function showArtistsView() {
      $('tabHome')?.classList.remove('artist-detail-open');
      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      if (mainView) mainView.style.display = 'none';
      if (detailView) detailView.style.display = 'none';
      if (artistsView) {
        artistsView.style.display = 'block';
        renderArtistsFullGrid();
      }
    }

    export function showDefaultHomeView() {
      $('tabHome')?.classList.remove('artist-detail-open');
      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      if (artistsView) artistsView.style.display = 'none';
      if (detailView) detailView.style.display = 'none';
      if (mainView) mainView.style.display = 'block';
    }

    let openArtistSelection: ArtistSelection | null = null;
    export function openArtistDetail(artistName: string | ArtistSelection, scroll = true, interactive = true) {
      const group = resolveArtistSelection(getArtistGroups(), artistName);
      if(!group) {
        if(typeof artistName !== 'string') { closeArtistDetail(); return; }
        toast('That artist is no longer in your library.', 'circle-info');
        return;
      }
      openArtistSelection = selectArtist(group);
      if(interactive && !group.key.startsWith('unresolved:')) prioritizeArtistMetadata(group.name, 'open');

      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      $('tabHome')?.classList.add('artist-detail-open');
      if (mainView) mainView.style.display = 'none';
      if (artistsView) artistsView.style.display = 'none';
      if (detailView) detailView.style.display = 'block';
      if(detailView) renderArtistPage(detailView, group, { prefix: 'artist', onBack: () => {
        closeArtistDetail();
        openHomeArtistsTab();
        $('homeArtistsChip')?.focus({ preventScroll: true });
      } });
      if(scroll) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('aura-reduce-motion');
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
        detailView?.querySelector<HTMLElement>('.artist-hero-name')?.focus({ preventScroll: true });
      }
    }

    export function refreshArtistViews() {
      renderFeaturedArtistsShelf();
      renderArtistSpotlight();
      if($('homeArtistsView')?.style.display === 'block') renderArtistsFullGrid();
      if(openArtistSelection && $('homeArtistDetailView')?.style.display === 'block') openArtistDetail(openArtistSelection, false, false);
    }

    export function refreshAutomaticArtistViews() {
      const groups = getArtistGroups(), byKey = new Map(groups.map(group => [group.key, group]));
      document.querySelectorAll<HTMLElement>('[data-artist-open]').forEach(card => {
        const group = byKey.get(card.dataset.artistOpen || ''), image = card.querySelector<HTMLImageElement>('[data-artist-portrait]');
        if(group && image) setArtistPortraitSource(image, group.cover || DEFAULT_ARTIST_PORTRAIT);
      });
      $('artistSpotlightContainer')?.querySelectorAll<HTMLImageElement>('[data-artist-key][data-artist-portrait]').forEach(image => {
        const group = byKey.get(image.dataset.artistKey || '');
        if(group) setArtistPortraitSource(image, group.cover || DEFAULT_ARTIST_PORTRAIT);
      });
      if(!openArtistSelection || $('homeArtistDetailView')?.style.display !== 'block') return;
      const group = resolveArtistSelection(groups, openArtistSelection), page = $('homeArtistDetailView');
      if(group && page) refreshArtistPageMetadata(page, group);
      // Names, selection, song rows and playback callbacks remain mounted.
    }

    document.addEventListener('click', event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-artist-open]');
      if(card?.dataset.artistOpen) openArtistDetail(card.dataset.artistOpen);
    });

    export function closeArtistDetail() {
      openArtistSelection = null;
      const activeChip = document.querySelector('#ytmMoodChips .ytm-chip.active') as HTMLElement | null;
      const mood = activeChip?.dataset.mood || 'all';

      if (mood === 'artists') {
        showArtistsView();
      } else {
        showDefaultHomeView();
      }
    }

    export function playArtistSongs(artistName: string, shuffle = false, startId?: string) {
      const artist = resolveArtistSelection(getArtistGroups(), artistName);
      if (!artist || !artist.songs.length) return;
      if(playArtistCollection(artist, shuffle, startId)) toast(`Playing ${artist.name}`, 'play');
    }

    window.addEventListener('aura:library-changed', refreshArtistViews);

    if (typeof window !== 'undefined') {
      (window as any).openHomeArtistsTab = openHomeArtistsTab;
      (window as any).openArtistDetail = openArtistDetail;
      (window as any).closeArtistDetail = closeArtistDetail;
      (window as any).playArtistSongs = playArtistSongs;
    }

    export function setupHeaderSearch(){
      const input = $('headerSearchInput') as HTMLInputElement | null;
      if(!input) return;

      const triggerSearch = () => {
        const q = input.value;
        const tabInput = $('searchTabInput') as HTMLInputElement | null;
        if(tabInput && tabInput.value !== q){
          tabInput.value = q;
          tabInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      const ensureSearchTab = () => {
        const searchTab = $('tabSearch');
        if(searchTab && !searchTab.classList.contains('active')){
          goTab('tabSearch');
        }
      };

      // Only sync the query while typing without jumping tabs
      input.addEventListener('input', () => {
        triggerSearch();
      });

      // Pressing Enter confirms search and smoothly opens Search tab
      input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter'){
          const q = input.value.trim();
          if(q){
            ensureSearchTab();
            triggerSearch();
            const tabInput = $('searchTabInput') as HTMLInputElement | null;
            if(tabInput) tabInput.focus();
          }
        } else if(e.key === 'Escape'){
          input.value = '';
          triggerSearch();
          input.blur();
        }
      });

      // Clicking the search icon inside the top search bar confirms search
      const searchIcon = input.parentElement?.querySelector('i.fa-magnifying-glass');
      if(searchIcon){
        searchIcon.addEventListener('click', () => {
          if(input.value.trim()){
            ensureSearchTab();
            triggerSearch();
          } else {
            input.focus();
          }
        });
        (searchIcon as HTMLElement).style.cursor = 'pointer';
      }

      // Keep header search input in sync when user types directly in searchTabInput
      const tabInput = $('searchTabInput') as HTMLInputElement | null;
      if(tabInput){
        tabInput.addEventListener('input', () => {
          if(input.value !== tabInput.value){
            input.value = tabInput.value;
          }
        });
      }
    }

    /* Home and Library use the same identities, including collaborations and
       authoritative cloud profiles. A shared credit appears once per artist. */
    export function renderArtistSpotlight(){
      const artists = getArtistGroups().filter(g => g.songs.length >= 2);
      const container = $('artistSpotlightContainer');
      if(!container) return;

      if(!artists.length){ container.innerHTML=''; return; }

      const indexById = new Map<string, number>();
      state.songs.forEach((song, i) => indexById.set(String(song.id), i));
      container.innerHTML = artists.map((g:any)=>{
        const cards = g.songs.map(s=>{
          const idx = indexById.get(String(s.id)) ?? -1;
          if(idx < 0) return '';
          return `<div class="spotlight-card" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'')}" data-play-song-id="${escapeHtml(s.id)}"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><p class="sc-title">${escapeHtml(s.title)}</p><p class="sc-sub">${escapeHtml(s.artist)}</p></div>`;
        }).join('');
        return `<div class="artist-spotlight-block" style="margin-bottom:24px">
          <div class="spotlight-header">
            <img class="spotlight-avatar" data-artist-portrait data-artist-key="${escapeHtml(g.key)}" data-artist-metadata-name="${g.key.startsWith('unresolved:') ? '' : escapeHtml(g.name)}" src="${escapeHtml(g.cover || DEFAULT_ARTIST_PORTRAIT)}" alt="" loading="lazy" decoding="async">
            <div><p>More from</p><p>${escapeHtml(g.name)}</p></div>
          </div>
          <div class="recent-scroll">${cards}</div>
        </div>`;
      }).join('');
      observeArtistMetadataCards(container);
    }

/* ===== 4646-4660 ===== */
    export let auraPickIds=[];
    export function renderAuraPicks(force?){
      const c=$('auraPicksScroll'); if(!c||typeof state.songs==='undefined') return;
      if(!state.songs.length){
        c.innerHTML = `<div class="aura-empty">
          <i class="fa-solid fa-compact-disc" aria-hidden="true"></i>
          <div><b>No picks yet</b><span>Your Aura library will appear here when the catalogue finishes loading.</span></div>
          <button type="button" class="aura-empty-btn" onclick="goTab('tabSearch')">Find music</button>
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
        return `<div class="aura-pick" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'')}" data-play-song-id="${escapeHtml(s.id)}"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><span class="aura-pick-play"><i class="fa-solid fa-play"></i></span><div class="aura-pick-info"><b>${escapeHtml(s.title||'')}</b><span>${escapeHtml(s.artist||'')}</span></div></div>`;
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
