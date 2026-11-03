import { timeGreeting, toast, artistMergeKey } from '../core/dom';
import { playSong } from './player';
import { escapeHtml } from './radio';
import { DEFAULT_COVER, getArtistMeta } from '../core/catalog';
import { $, state } from '../core/state';
import { getArtistGroups, artistTileHTML } from './library';
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
      const localCount = state.songs.filter(s=>s.isLocal).length;

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
        `<div class="quick-tile" role="button" tabindex="0" onclick="goToSearchCategory('local')">
          <div class="quick-tile-art cat-local"><i class="fa-solid fa-file-audio"></i></div>
          <div class="quick-tile-text"><div class="qt-title">Local files</div><div class="qt-sub">${localCount} added</div></div>
        </div>`,
        `<div class="quick-tile" role="button" tabindex="0" onclick="goToSearchCategory('recent')">
          <div class="quick-tile-art cat-recent"><i class="fa-solid fa-clock-rotate-left"></i></div>
          <div class="quick-tile-text"><div class="qt-title"><span class="qt-long">Recently played</span><span class="qt-short">Recent</span></div><div class="qt-sub">${state.recentlyPlayed.length} track${state.recentlyPlayed.length!==1?'s':''}</div></div>
        </div>`
      ];
      $('quickGrid').innerHTML = tiles.join('');
    }

    /* Better YouTube Music: 3-Column Quick Picks Grid */
    let currentMood = 'all';
    let currentQuickPage = 0;

    const MOOD_KEYWORDS: Record<string, string[]> = {
      'romance': ['love', 'romance', 'dil', 'ishq', 'heart', 'kadhal', 'prema', 'romantic', 'priye'],
      'feel good': ['feel', 'good', 'happy', 'smile', 'joy', 'vibe', 'celebrate', 'fun'],
      'relax': ['relax', 'chill', 'calm', 'peace', 'sleep', 'acoustic', 'lo-fi', 'lofi'],
      'energise': ['dance', 'beat', 'remix', 'fast', 'rock', 'energy', 'edm', 'fire'],
      'party': ['party', 'punjab', 'dj', 'bass', 'club', 'celebration', 'dheem'],
      'commute': ['journey', 'drive', 'travel', 'way', 'road'],
      'workout': ['power', 'gym', 'run', 'fire', 'strong', 'beast'],
      'focus': ['instrumental', 'piano', 'ambient', 'focus', 'study', 'violin']
    };

    export function renderQuickPicks(page?: number){
      const container = $('ytmQuickGrid');
      if(!container) return;
      if(!state.songs || !state.songs.length){
        container.innerHTML = '<div style="color:var(--text-sub);padding:14px;font-size:13px">Loading library tracks…</div>';
        return;
      }

      let pool = state.songs;
      if(currentMood !== 'all' && MOOD_KEYWORDS[currentMood]){
        const kw = MOOD_KEYWORDS[currentMood];
        const filtered = state.songs.filter(s => {
          const t = ((s.title || '') + ' ' + (s.artist || '')).toLowerCase();
          return kw.some(k => t.includes(k));
        });
        if(filtered.length >= 4) {
          pool = filtered;
        }
      }

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
          <div class="ytm-track-card ${isPlaying ? 'is-playing' : ''}" role="button" tabindex="0" onclick="playSong(${globalIdx >= 0 ? globalIdx : 0})" title="${escapeHtml(s.title || '')}">
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
      name: string;
      img: string;
      count: number;
      songs: any[];
    }

    export function getAllArtists(): ArtistDirectoryEntry[] {
      const groups: Record<string, { name: string; names: Record<string, number>; songs: any[] }> = {};
      const keys: string[] = [];

      state.songs.forEach(s => {
        const artist = (s.artist || '').trim();
        if (!artist || artist.toLowerCase() === 'unknown artist') return;
        const k = artistMergeKey(keys, artist);
        if (!groups[k]) {
          groups[k] = { name: artist, names: {}, songs: [] };
          keys.push(k);
        }
        groups[k].names[artist] = (groups[k].names[artist] || 0) + 1;
        groups[k].songs.push(s);
      });

      const result: ArtistDirectoryEntry[] = Object.values(groups).map(g => {
        const bestName = Object.entries(g.names).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
        const custom = getArtistMeta(bestName);
        const sample = g.songs.find(s => s.img && !s.img.includes('default') && !s.img.includes('data:image')) || g.songs[0];
        return {
          name: custom?.name || bestName,
          img: custom?.img || sample?.img || DEFAULT_COVER,
          count: g.songs.length,
          songs: g.songs
        };
      });

      return result.sort((a, b) => b.count - a.count);
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
        <div class="ytm-artist-card" role="button" tabindex="0" onclick="openArtistDetail('${escapeHtml(a.name)}')" title="${escapeHtml(a.name)}">
          <div class="ytm-artist-art-wrap">
            <img class="ytm-artist-avatar" src="${escapeHtml(a.img)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async">
            <div class="ytm-artist-play-overlay"><i class="fa-solid fa-play"></i></div>
          </div>
          <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
          <div class="ytm-artist-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
        </div>
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
        <div class="ytm-artist-card grid-card" role="button" tabindex="0" onclick="openArtistDetail('${escapeHtml(a.name)}')" title="${escapeHtml(a.name)}">
          <div class="ytm-artist-art-wrap">
            <img class="ytm-artist-avatar" src="${escapeHtml(a.img)}" alt="${escapeHtml(a.name)}" loading="lazy" decoding="async">
            <div class="ytm-artist-play-overlay"><i class="fa-solid fa-play"></i></div>
          </div>
          <div class="ytm-artist-name">${escapeHtml(a.name)}</div>
          <div class="ytm-artist-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
        </div>
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
      if (artistsView) artistsView.style.display = 'none';
      if (detailView) detailView.style.display = 'none';
      if (mainView) mainView.style.display = 'block';
    }

    export function openArtistDetail(artistName: string) {
      const artists = getAllArtists();
      const artist = artists.find(a => a.name.toLowerCase() === artistName.toLowerCase()) || {
        name: artistName,
        img: DEFAULT_COVER,
        count: 0,
        songs: state.songs.filter(s => (s.artist || '').toLowerCase().includes(artistName.toLowerCase()))
      };

      const mainView = $('homeMainView');
      const artistsView = $('homeArtistsView');
      const detailView = $('homeArtistDetailView');
      if (mainView) mainView.style.display = 'none';
      if (artistsView) artistsView.style.display = 'none';
      if (detailView) detailView.style.display = 'block';

      // Render hero card
      const heroCard = $('artistHeroCard');
      if (heroCard) {
        heroCard.innerHTML = `
          <div class="artist-hero-backdrop" style="background-image:url('${escapeHtml(artist.img)}')"></div>
          <div class="artist-hero-content">
            <img class="artist-hero-img" src="${escapeHtml(artist.img)}" alt="${escapeHtml(artist.name)}" loading="lazy">
            <div class="artist-hero-meta">
              <span class="artist-hero-badge"><i class="fa-solid fa-circle-check"></i> Featured Artist</span>
              <h1 class="artist-hero-name">${escapeHtml(artist.name)}</h1>
              <p class="artist-hero-count">${artist.songs.length} song${artist.songs.length !== 1 ? 's' : ''} in your music</p>
            </div>
          </div>
        `;
      }

      // Setup play all / shuffle buttons
      const playAllBtn = $('artistPlayAllBtn');
      if (playAllBtn) {
        playAllBtn.onclick = () => playArtistSongs(artist.name, false);
      }
      const shuffleBtn = $('artistShuffleBtn');
      if (shuffleBtn) {
        shuffleBtn.onclick = () => playArtistSongs(artist.name, true);
      }

      // Render song rows
      const songsList = $('artistSongsList');
      if (songsList) {
        if (!artist.songs.length) {
          songsList.innerHTML = '<div style="color:var(--text-sub);padding:24px;font-size:14px">No tracks found for this artist.</div>';
          return;
        }

        songsList.innerHTML = artist.songs.map((s, idx) => {
          const globalIdx = state.songs.findIndex(x => x.id === s.id);
          const isPlaying = state.currentIndex === globalIdx && state.isPlaying;
          return `
            <div class="artist-song-row ${isPlaying ? 'is-playing' : ''}" role="button" tabindex="0" onclick="playSong(${globalIdx >= 0 ? globalIdx : 0})">
              <span class="artist-song-num">${isPlaying ? '<i class="fa-solid fa-volume-high"></i>' : (idx + 1)}</span>
              <img class="artist-song-cover" src="${escapeHtml(s.img || DEFAULT_COVER)}" alt="" loading="lazy">
              <div class="artist-song-info">
                <div class="artist-song-title">${escapeHtml(s.title || 'Untitled')}</div>
                <div class="artist-song-sub">${escapeHtml(s.artist || '')}</div>
              </div>
              <button type="button" class="artist-song-play-btn" title="Play"><i class="fa-solid fa-play"></i></button>
            </div>
          `;
        }).join('');
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    export function closeArtistDetail() {
      const activeChip = document.querySelector('#ytmMoodChips .ytm-chip.active') as HTMLElement | null;
      const mood = activeChip?.dataset.mood || 'all';

      if (mood === 'artists') {
        showArtistsView();
      } else {
        showDefaultHomeView();
      }
    }

    export function playArtistSongs(artistName: string, shuffle = false) {
      const artists = getAllArtists();
      const artist = artists.find(a => a.name.toLowerCase() === artistName.toLowerCase());
      if (!artist || !artist.songs.length) return;

      const songsToPlay = [...artist.songs];
      if (shuffle) {
        songsToPlay.sort(() => Math.random() - 0.5);
      }

      const firstSong = songsToPlay[0];
      const idx = state.songs.findIndex(s => s.id === firstSong.id);
      if (idx >= 0) {
        playSong(idx);
        toast(`Playing ${artist.name}`, 'play');
      }
    }

    if (typeof window !== 'undefined') {
      (window as any).openHomeArtistsTab = openHomeArtistsTab;
      (window as any).openArtistDetail = openArtistDetail;
      (window as any).closeArtistDetail = closeArtistDetail;
      (window as any).playArtistSongs = playArtistSongs;
    }

    export function setupHeaderSearch(){
      const input = $('headerSearchInput') as HTMLInputElement | null;
      if(!input) return;
      input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter'){
          const q = input.value.trim();
          if(!q) return;
          const searchNav = document.querySelector('[data-tab="tabSearch"]') as HTMLElement | null;
          if(searchNav) searchNav.click();
          const tabInput = $('searchTabInput') as HTMLInputElement | null;
          if(tabInput){
            tabInput.value = q;
            tabInput.dispatchEvent(new Event('input', { bubbles: true }));
            tabInput.focus();
          }
        }
      });
    }

    /* Home: spotlight EVERY artist who has 2+ tracks in the library,
       most-tracks-first — variants ("A. R. Rahman" / "A.R. Rahman" /
       "… - Topic") merge into one bucket via artistKey. */
    export function renderArtistSpotlight(){
      const groups:any = {};
      const keys:string[] = [];
      state.songs.forEach(s=>{
        if(!s.artist || s.artist==='Unknown Artist') return;
        const k = artistMergeKey(keys, s.artist);
        if(!groups[k]){ groups[k] = {count:0, names:{}, songs:[]}; keys.push(k); }
        groups[k].count++;
        groups[k].names[s.artist]=(groups[k].names[s.artist]||0)+1;
        groups[k].songs.push(s);
      });
      /* show the spelling most of the library actually uses */
      Object.values(groups).forEach((g:any)=>{
        g.name = Object.entries(g.names).sort((a:any,b:any)=>b[1]-a[1] || b[0].length-a[0].length)[0][0];
      });
      const artists = Object.values(groups).filter((g:any)=>g.count>=2).sort((a:any,b:any)=>b.count-a.count);
      const container = $('artistSpotlightContainer');

      if(!artists.length){ container.innerHTML=''; return; }

      const indexById = new Map<string, number>();
      state.songs.forEach((song, i) => indexById.set(String(song.id), i));
      container.innerHTML = artists.map((g:any)=>{
        const cards = g.songs.map(s=>{
          const idx = indexById.get(String(s.id)) ?? -1;
          if(idx < 0) return '';
          return `<div class="spotlight-card" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'')}" onclick="playSong(${idx})"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><p class="sc-title">${escapeHtml(s.title)}</p><p class="sc-sub">${escapeHtml(s.artist)}</p></div>`;
        }).join('');
        return `<div class="artist-spotlight-block" style="margin-bottom:24px">
          <div class="spotlight-header">
            <img class="spotlight-avatar" src="${escapeHtml(g.songs[0].img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async">
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
      if(!state.songs.length){
        c.innerHTML = `<div class="aura-empty">
          <i class="fa-solid fa-compact-disc" aria-hidden="true"></i>
          <div><b>No picks yet</b><span>Add or search for music and this space fills itself.</span></div>
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
        return `<div class="aura-pick" role="button" tabindex="0" aria-label="Play ${escapeHtml(s.title||'')}" onclick="playSong(${i})"><img src="${escapeHtml(s.img||DEFAULT_COVER)}" alt="" loading="lazy" decoding="async"><span class="aura-pick-play"><i class="fa-solid fa-play"></i></span><div class="aura-pick-info"><b>${escapeHtml(s.title||'')}</b><span>${escapeHtml(s.artist||'')}</span></div></div>`;
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
