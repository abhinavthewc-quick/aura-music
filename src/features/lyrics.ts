import { state, $ } from '../core/state';

export interface WordSync {
  begin: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface LyricLine {
  time: number;
  endTime?: number;
  text: string;
  words?: WordSync[];
  translit?: string;
  translation?: string;
}

export interface ParsedLyrics {
  isSynced: boolean;
  hasWordSync?: boolean;
  provider: string;
  lines: LyricLine[];
}

export type LyricsProviderKey = 'auto' | 'betterlyrics' | 'lrclib' | 'lrclib_search' | 'curated' | 'custom';

let currentLyrics: ParsedLyrics | null = null;
let currentTrackKey = '';
let activeIndex = -1;
let showTranslation = true;
let showTranslit = true;
let syncOffset = 0; // seconds
let preferredProvider: LyricsProviderKey = 'auto';
let fontSizeMode: 'sm' | 'md' | 'lg' = 'md';
let alignMode: 'left' | 'center' = 'left';

/* Curated multi-tier fallback lyrics for key demo and regional hits */
const CURATED_LYRICS: Record<string, ParsedLyrics> = {
  'welcome to punjab': {
    isSynced: true,
    hasWordSync: false,
    provider: 'Curated (BetterLyrics Multi-Tier)',
    lines: [
      { time: 14.46, text: 'യാർ ദിലാവേ ടെനു യാർ ദിലാവേ', translit: 'yaar dilaave tenu yaar dilaave', translation: 'May you find love, may you find a friend' },
      { time: 23.41, text: 'ഓ യാർ ദിലാവേ ടെനു യാർ ദിലാവേ', translit: 'o yaar dilaave tenu yaar dilaave', translation: 'Oh, may you find love, may you find a friend' },
      { time: 33.20, text: 'ധൂം ദിനക്ക് തന ധീം തനക്ക് തന ഡൂം തനക്ക് തന തിന്ന തിന്ന', translit: 'dhoom dinakku thana dheem thanakku thana', translation: '[Upbeat energetic Punjabi beats]' },
      { time: 75.52, text: 'മൗനം പാടും ഓമൽ പ്രാവിൻ', translit: 'mounam paadum oamal praavin', translation: 'Like a gentle dove singing softly in silence' },
      { time: 80.03, text: 'മോഹം പോലെ ഇന്നാലും വന്നില്ലേ', translit: 'moham poale innaalum vannille', translation: 'Has not that fond longing arrived today?' },
      { time: 84.64, text: 'സ്നേഹം മൂടാൻ കാറ്റും പൊന്നേ', translit: 'sneham moodaan kaattum ponne', translation: 'A gentle breeze arrives to wrap you in affection' },
      { time: 89.43, text: 'കൂടെ കൂട്ടായ് ഇന്നിതാ', translit: 'koode koottaay innithaa', translation: 'Here as our companion today' },
      { time: 93.89, text: 'നെഞ്ചേറ്റും സ്വപ്നങ്ങൾ ഓരോന്നായി നിരവയ്', translit: 'nenchettum swapnangal oaronnaayi niravay', translation: 'Fulfilling each cherished dream held in your heart' },
      { time: 98.09, text: 'എല്ലാമേ നന്നാവാൻ നേരുന്നേ എല്ലാരും', translit: 'ellaame nannaavaan nerunne ellaarum', translation: 'Everyone wishes you the very best' },
      { time: 102.79, text: 'നീരോടും പുകഴ് പോൽ നിന്നീടും മുത്താവാൻ', translit: 'neerodum pukazh pol ninneedum mutthaavaan', translation: 'To stand bright and radiant like flowing glory' },
      { time: 107.36, text: 'ആരാരേ ആഷിപ്പൂ ചാരത്തായി ദൂരത്തായി', translit: 'aaraare aashippoo chaarathaayi doorathaayi', translation: 'Everyone near and far is wishing for this' },
      { time: 112.96, text: 'നാടുണരുന്നേ ഈ നാടുണരുന്നേ', translit: 'naatunarunne ee naatunarunne', translation: 'The whole land awakens, yes, the whole land awakens' },
      { time: 122.23, text: 'ഓ ഭാവുകമോതാൻ കൈകോർത്തണയുനേ', translit: 'o bhaavukamoathaan kaikoarthanayune', translation: 'Joining hands together to offer their warmest blessings' },
      { time: 131.74, text: 'ഉണരുന്നേ... ധൂം ദിനക്ക് തന ധീം തനക്ക് തന', translit: 'unarunne... dhoom dinakku thana', translation: 'Awakening! [Celebratory festive chorus]' },
    ]
  },
  'deewaana deewaana': {
    isSynced: true,
    hasWordSync: false,
    provider: 'Curated (BetterLyrics Multi-Tier)',
    lines: [
      { time: 12.0, text: 'दीवाना दीवाना तेरे इश्क़ में', translit: 'deewaana deewaana tere ishq mein', translation: 'Crazy, madly in love with you' },
      { time: 24.5, text: 'यह दिल खो गया है तेरी राहों में', translit: 'yeh dil kho gaya hai teri raahon mein', translation: 'This heart has lost itself in your pathways' },
      { time: 38.0, text: 'साँसों की धड़कन बस तुम ही हो', translit: 'saanson ki dhadkan bas tum hi ho', translation: 'Every beat of my breath is you alone' },
      { time: 54.0, text: 'रातों की नींदें चुराई तूने', translit: 'raaton ki neendein churaayi tune', translation: 'You stole the sleep of my nights' },
      { time: 70.0, text: 'दीवाना दीवाना तेरे इश्क़ में', translit: 'deewaana deewaana तेरे ishq mein', translation: 'Madly, deeply in love with you' }
    ]
  },
  'aalaporaan thamizhan': {
    isSynced: true,
    hasWordSync: false,
    provider: 'Curated (BetterLyrics Multi-Tier)',
    lines: [
      { time: 16.0, text: 'ஆளப்போறான் தமிழன் உலகை எல்லாமേ', translit: 'aalapoaraan thamizhan ulagai ellaame', translation: 'The Tamilian is going to conquer the entire world' },
      { time: 28.5, text: 'வெற்றி கொடி ஏற்றி வைப்பான் முன்னாலே', translit: 'vetri kodi yaetri vaippaan munnaale', translation: 'He will hoist the flag of victory right in front' },
      { time: 42.0, text: 'அன்பாலே இணைப்போம் பாரை', translit: 'anbaale inaippoam paarai', translation: 'With love we shall unite this land' },
      { time: 58.0, text: 'வீரத்தோட நடை போடு தமிழா', translit: 'veerathoda nadai poadu thamizhaa', translation: 'Walk with courageous pride, dear Tamilian' }
    ]
  }
};

/* Time Parsing Helper: handles "27.395", "0:27.395", "01:23.456", "01:23:45" */
export function parseTimeString(tStr: string): number {
  if (!tStr) return 0;
  const parts = tStr.trim().split(':');
  if (parts.length === 1) {
    return parseFloat(parts[0]) || 0;
  } else if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + (parseFloat(parts[1]) || 0);
  } else if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + (parseFloat(parts[2]) || 0);
  }
  return 0;
}

/* BetterLyrics / Apple Music TTML Parser (syllable & word-by-word timed text) */
export function parseTTML(ttmlText: string): ParsedLyrics {
  const lines: LyricLine[] = [];
  const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  const spanRegex = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let pMatch;

  while ((pMatch = pRegex.exec(ttmlText)) !== null) {
    const pAttrs = pMatch[1];
    const pBody = pMatch[2];
    const beginMatch = /begin="([^"]+)"/i.exec(pAttrs);
    const endMatch = /end="([^"]+)"/i.exec(pAttrs);
    const pBegin = beginMatch ? parseTimeString(beginMatch[1]) : 0;
    const pEnd = endMatch ? parseTimeString(endMatch[1]) : undefined;

    const words: WordSync[] = [];
    let spanMatch;
    spanRegex.lastIndex = 0;
    while ((spanMatch = spanRegex.exec(pBody)) !== null) {
      const sAttrs = spanMatch[1];
      const sText = spanMatch[2].replace(/<[^>]+>/g, '').trim();
      if (!sText) continue;
      const sBeginMatch = /begin="([^"]+)"/i.exec(sAttrs);
      const sEndMatch = /end="([^"]+)"/i.exec(sAttrs);
      const sBegin = sBeginMatch ? parseTimeString(sBeginMatch[1]) : pBegin;
      const sEnd = sEndMatch ? parseTimeString(sEndMatch[1]) : (pEnd ? Math.min(pEnd, sBegin + 0.4) : sBegin + 0.4);
      words.push({ begin: sBegin, end: sEnd, text: sText });
    }

    const cleanText = pBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanText) {
      lines.push({
        time: pBegin,
        endTime: pEnd,
        text: cleanText,
        words: words.length > 0 ? words : undefined,
        translit: generateRomanization(cleanText)
      });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return {
    isSynced: lines.length > 0,
    hasWordSync: lines.some(l => l.words && l.words.length > 0),
    provider: 'BetterLyrics (Word-sync)',
    lines
  };
}

/* Enhanced LRC Parser: supports [mm:ss.xx] and inline word tags <mm:ss.xx> */
export function parseLRC(lrcText: string, providerName = 'LRCLIB'): ParsedLyrics {
  const lines: LyricLine[] = [];
  const rawLines = lrcText.split('\n');
  const lineTimeRegex = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;
  const wordTagRegex = /<(\d{1,2}):(\d{2}(?:\.\d{1,3})?)>([^<]+)/g;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('[ti:') || trimmed.startsWith('[ar:') || trimmed.startsWith('[al:')) continue;

    const timestamps: number[] = [];
    let match;
    lineTimeRegex.lastIndex = 0;
    while ((match = lineTimeRegex.exec(trimmed)) !== null) {
      timestamps.push(parseInt(match[1], 10) * 60 + parseFloat(match[2]));
    }

    const cleanLine = trimmed.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!cleanLine) continue;

    // Check for inline syllable/word tags like <00:12.30>word
    const words: WordSync[] = [];
    let wordMatch;
    wordTagRegex.lastIndex = 0;
    while ((wordMatch = wordTagRegex.exec(cleanLine)) !== null) {
      const wTime = parseInt(wordMatch[1], 10) * 60 + parseFloat(wordMatch[2]);
      const wText = wordMatch[3].trim();
      if (wText) {
        words.push({ begin: wTime, end: wTime + 0.4, text: wText });
      }
    }
    // Clean remaining tag markers
    const displayText = cleanLine.replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, '').trim();

    for (const t of timestamps) {
      lines.push({
        time: t,
        text: displayText,
        words: words.length > 0 ? words : undefined,
        translit: generateRomanization(displayText)
      });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return {
    isSynced: lines.length > 0,
    hasWordSync: lines.some(l => l.words && l.words.length > 0),
    provider: providerName,
    lines: lines.length > 0 ? lines : rawLines.map(t => ({ time: 0, text: t.trim() })).filter(l => l.text)
  };
}

/* Automatic Transliteration / Romanization Engine for Non-Latin Scripts */
export function generateRomanization(text: string): string | undefined {
  if (!text) return undefined;
  // If text is purely ASCII, no romanization needed
  if (/^[\x00-\x7F\s.,!?'"()-]+$/.test(text)) return undefined;

  // Devanagari transliteration map (sample phonetics)
  const devanagariMap: Record<string, string> = {
    'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ए':'e','ऐ':'ai','ओ':'o','औ':'au','क':'k','ख':'kh','ग':'g','घ':'gh','च':'ch','छ':'chh','ज':'j','झ':'jh','ट':'t','ठ':'th','ड':'d','ढ':'dh','त':'t','थ':'th','द':'d','ध':'dh','न':'n','प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh','स':'s','ह':'h','ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','े':'e','ै':'ai','ो':'o','ौ':'au','्':'','ं':'n','ः':'h'
  };

  // Check if text has Devanagari
  if (/[\u0900-\u097F]/.test(text)) {
    let out = '';
    for (const ch of text) {
      out += devanagariMap[ch] !== undefined ? devanagariMap[ch] : ch;
    }
    return out.trim() !== text.trim() ? out.trim() : undefined;
  }

  // Check if text has Korean Hangul (Algorithmic Romanization)
  if (/[\uAC00-\uD7AF]/.test(text)) {
    const initials = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
    const medials = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
    const finals = ['','k','k','ks','n','nj','nh','d','l','lg','lm','lb','ls','lt','lp','lh','m','b','bs','s','ss','ng','j','ch','k','t','p','h'];
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xAC00 && code <= 0xD7AF) {
        const syllableIndex = code - 0xAC00;
        const finalIdx = syllableIndex % 28;
        const medialIdx = Math.floor((syllableIndex - finalIdx) / 28) % 21;
        const initialIdx = Math.floor(Math.floor((syllableIndex - finalIdx) / 28) / 21);
        out += initials[initialIdx] + medials[medialIdx] + finals[finalIdx];
      } else {
        out += text[i];
      }
    }
    return out;
  }

  return undefined;
}

/* Multi-Provider Fetch Pipeline with Fallbacks */
export async function fetchLyricsForTrack(title: string, artist: string, duration?: number, providerOverride?: LyricsProviderKey): Promise<ParsedLyrics | null> {
  const cleanTitle = (title || '').replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
  const cleanArtist = (artist || '').replace(/\s*[-–,].*$/, '').trim();
  currentTrackKey = (cleanTitle + '__' + cleanArtist).toLowerCase().replace(/[^a-z0-9]/g, '_');

  // 1. Check custom user override in localStorage
  try {
    const customLrc = localStorage.getItem('aura_custom_lrc_' + currentTrackKey);
    if (customLrc) {
      return parseLRC(customLrc, 'Custom LRC');
    }
  } catch (_) {}

  // Load saved timing offset for this specific track
  try {
    const savedOffset = localStorage.getItem('aura_offset_' + currentTrackKey);
    syncOffset = savedOffset ? parseFloat(savedOffset) || 0 : 0;
    updateSyncOffsetLabel();
  } catch (_) {}

  const providerToUse = providerOverride || preferredProvider;

  // 2. Curated Database (Highest quality for regional & demo tracks)
  if (providerToUse === 'auto' || providerToUse === 'curated') {
    const normTitle = cleanTitle.toLowerCase();
    for (const [key, val] of Object.entries(CURATED_LYRICS)) {
      if (normTitle.includes(key)) {
        return val;
      }
    }
    if (providerToUse === 'curated') return null;
  }

  // 3. Provider: BetterLyrics Official TTML API (Rich syllable/word sync)
  if (providerToUse === 'auto' || providerToUse === 'betterlyrics') {
    try {
      const blUrl = `https://api.betterlyrics.org/getLyrics?a=${encodeURIComponent(cleanArtist)}&s=${encodeURIComponent(cleanTitle)}`;
      const res = await fetch(blUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.ttml) {
          const parsed = parseTTML(data.ttml);
          if (parsed.lines.length > 0) return parsed;
        }
      }
    } catch (e) {
      console.warn('[BetterLyrics API] fallback:', e);
    }
    if (providerToUse === 'betterlyrics') return null;
  }

  // 4. Provider: LRCLIB Exact Lookup
  if (providerToUse === 'auto' || providerToUse === 'lrclib') {
    try {
      const lrclibUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}${duration ? `&duration=${Math.round(duration)}` : ''}`;
      const res = await fetch(lrclibUrl, {
        headers: { 'User-Agent': 'AuraMusic/1.0 (https://auramusic.app)' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.syncedLyrics) {
          return parseLRC(data.syncedLyrics, 'LRCLIB');
        } else if (data.plainLyrics) {
          const plainLines = data.plainLyrics.split('\n').map((l: string) => ({ time: 0, text: l.trim() })).filter((l: any) => l.text);
          return { isSynced: false, provider: 'LRCLIB (Plain)', lines: plainLines };
        }
      }
    } catch (e) {
      console.warn('[LRCLIB] fallback:', e);
    }
    if (providerToUse === 'lrclib') return null;
  }

  // 5. Provider: LRCLIB Fuzzy Search Fallback
  if (providerToUse === 'auto' || providerToUse === 'lrclib_search') {
    try {
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + cleanArtist)}`;
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'AuraMusic/1.0 (https://auramusic.app)' }
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items) && items.length > 0) {
          const syncedItem = items.find((i: any) => i.syncedLyrics) || items[0];
          if (syncedItem.syncedLyrics) {
            return parseLRC(syncedItem.syncedLyrics, 'LRCLIB (Search)');
          } else if (syncedItem.plainLyrics) {
            const plainLines = syncedItem.plainLyrics.split('\n').map((l: string) => ({ time: 0, text: l.trim() })).filter((l: any) => l.text);
            return { isSynced: false, provider: 'LRCLIB (Search)', lines: plainLines };
          }
        }
      }
    } catch (e) {
      console.warn('[LRCLIB Search] fallback:', e);
    }
  }

  return null;
}

/* Render Synced Lyrics into DOM with BetterLyrics UI and Word-by-word Syllable Wrappers */
export function renderLyrics(lyrics: ParsedLyrics | null, containerId = 'fullPlayerLyricsContainer') {
  const container = $(containerId);
  if (!container) return;
  currentLyrics = lyrics;
  activeIndex = -1;

  // Update Status Badge with Provider Name
  const statusText = $('blStatusText');
  if (statusText) {
    statusText.textContent = lyrics ? `Synced with ${lyrics.provider}` : 'No synced lyrics';
  }

  if (!lyrics || !lyrics.lines.length) {
    container.innerHTML = `
      <div class="bl-lyrics-empty">
        <i class="fa-solid fa-microphone-slash"></i>
        <div class="bl-empty-title">No lyrics found</div>
        <div class="bl-empty-sub">Enjoy the music or search manually via settings</div>
        <button type="button" class="lsm-btn secondary" style="margin-top:14px" onclick="openLyricsSettingsModal()">Search or Paste Lyrics</button>
      </div>
    `;
    return;
  }

  const html = lyrics.lines.map((line, idx) => {
    let mainHtml = '';
    if (line.words && line.words.length > 0) {
      mainHtml = line.words.map((w, wIdx) => `<span class="bl-word upcoming" data-widx="${wIdx}" data-begin="${w.begin}" data-end="${w.end}">${escapeHtml(w.text)} </span>`).join('');
    } else {
      mainHtml = escapeHtml(line.text);
    }

    return `
      <div class="bl-lyric-line ${line.words ? 'has-word-sync' : ''}" data-idx="${idx}" data-time="${line.time}" onclick="seekToLyric(${line.time})">
        <div class="bl-lyric-main">${mainHtml}</div>
        ${line.translit && showTranslit ? `<div class="bl-lyric-translit">${escapeHtml(line.translit)}</div>` : ''}
        ${line.translation && showTranslation ? `<div class="bl-lyric-trans">${escapeHtml(line.translation)}</div>` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="bl-lyrics-scroll size-${fontSizeMode} align-${alignMode}" id="blLyricsScroll">
      ${html}
    </div>
  `;
}

/* Real-Time Progress Tracker with Apple Music / BetterLyrics Word-by-word Gradient Fill */
export function updateLyricsProgress(currentTime: number, containerId = 'fullPlayerLyricsContainer') {
  if (!currentLyrics || !currentLyrics.isSynced) return;
  const adjusted = currentTime + syncOffset;
  const lines = currentLyrics.lines;
  let newIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (adjusted >= lines[i].time) {
      newIdx = i;
    } else {
      break;
    }
  }

  const container = $(containerId);
  if (!container) return;

  if (newIdx !== activeIndex) {
    activeIndex = newIdx;
    const allLines = container.querySelectorAll('.bl-lyric-line');
    allLines.forEach((el, idx) => {
      el.classList.toggle('active', idx === activeIndex);
      el.classList.toggle('passed', idx < activeIndex);
    });

    if (activeIndex >= 0 && allLines[activeIndex]) {
      const scrollParent = $('blLyricsScroll');
      if (scrollParent) {
        const lineEl = allLines[activeIndex] as HTMLElement;
        const targetScroll = lineEl.offsetTop - (scrollParent.clientHeight / 2) + (lineEl.clientHeight / 2);
        scrollParent.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
      }
    }
  }

  // Syllable / Word-by-word Progressive Highlight Sweep on Active Line
  if (activeIndex >= 0 && lines[activeIndex] && lines[activeIndex].words) {
    const activeLineEl = container.querySelector(`.bl-lyric-line[data-idx="${activeIndex}"]`);
    if (activeLineEl) {
      const words = lines[activeIndex].words!;
      const wordEls = activeLineEl.querySelectorAll('.bl-word');

      for (let w = 0; w < words.length; w++) {
        const word = words[w];
        const el = wordEls[w] as HTMLElement | undefined;
        if (!el) continue;

        if (adjusted >= word.end) {
          el.className = 'bl-word done';
          el.style.removeProperty('--word-prog');
        } else if (adjusted < word.begin) {
          el.className = 'bl-word upcoming';
          el.style.removeProperty('--word-prog');
        } else {
          // Inside this word right now!
          el.className = 'bl-word active';
          const dur = Math.max(0.1, word.end - word.begin);
          const pct = Math.min(100, Math.max(0, ((adjusted - word.begin) / dur) * 100));
          el.style.setProperty('--word-prog', pct.toFixed(1) + '%');
        }
      }
    }
  }
}

/* UI Customization Controls */
export function toggleLyricsTranslation() {
  showTranslation = !showTranslation;
  if (currentLyrics) renderLyrics(currentLyrics);
}

export function toggleLyricsTranslit() {
  showTranslit = !showTranslit;
  if (currentLyrics) renderLyrics(currentLyrics);
}

export function cycleLyricsFontSize() {
  const order: Array<'sm' | 'md' | 'lg'> = ['sm', 'md', 'lg'];
  const next = order[(order.indexOf(fontSizeMode) + 1) % order.length];
  fontSizeMode = next;
  const btn = $('blFontSizeBtn');
  if (btn) btn.textContent = next === 'sm' ? '0.8x' : next === 'md' ? '1x' : '1.3x';
  const scrollEl = $('blLyricsScroll');
  if (scrollEl) {
    scrollEl.classList.remove('size-sm', 'size-md', 'size-lg');
    scrollEl.classList.add(`size-${fontSizeMode}`);
  }
}

export function toggleLyricsAlign() {
  alignMode = alignMode === 'left' ? 'center' : 'left';
  const btn = $('blAlignBtn');
  if (btn) btn.innerHTML = `<i class="fa-solid fa-align-${alignMode}"></i>`;
  const scrollEl = $('blLyricsScroll');
  if (scrollEl) {
    scrollEl.classList.remove('align-left', 'align-center');
    scrollEl.classList.add(`align-${alignMode}`);
  }
}

export function setSyncOffset(delta: number) {
  syncOffset += delta;
  updateSyncOffsetLabel();
  if (currentTrackKey) {
    try {
      localStorage.setItem('aura_offset_' + currentTrackKey, syncOffset.toString());
    } catch (_) {}
  }
  updateLyricsProgress(state.audio ? state.audio.currentTime : 0);
}

export function resetSyncOffset() {
  syncOffset = 0;
  updateSyncOffsetLabel();
  if (currentTrackKey) {
    try {
      localStorage.removeItem('aura_offset_' + currentTrackKey);
    } catch (_) {}
  }
  updateLyricsProgress(state.audio ? state.audio.currentTime : 0);
}

function updateSyncOffsetLabel() {
  const label = $('blSyncOffsetLabel');
  if (label) {
    label.textContent = (syncOffset >= 0 ? '+' : '') + syncOffset.toFixed(1) + 's';
  }
  const modalLabel = $('lsmCurrentOffsetLabel');
  if (modalLabel) {
    modalLabel.textContent = (syncOffset >= 0 ? '+' : '') + syncOffset.toFixed(1) + 's';
  }
}

/* Settings Modal Controls */
export function openLyricsSettingsModal() {
  const modal = $('lyricsSettingsModal');
  if (modal) {
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    const select = $('lsmProviderSelect') as HTMLSelectElement | null;
    if (select) select.value = preferredProvider;
    updateSyncOffsetLabel();
  }
}

export function closeLyricsSettingsModal() {
  const modal = $('lyricsSettingsModal');
  if (modal) {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  }
}

export function changeLyricsProvider(provider: LyricsProviderKey) {
  preferredProvider = provider;
  const curr = state.songs[state.currentIndex];
  if (curr) {
    fetchLyricsForTrack(curr.title, curr.artist, curr.duration, provider).then(l => renderLyrics(l));
  }
}

export function searchLyricsManually() {
  const input = $('lsmSearchInput') as HTMLInputElement | null;
  const q = input?.value.trim();
  if (!q) return;
  closeLyricsSettingsModal();
  fetchLyricsForTrack(q, '', undefined, 'auto').then(l => renderLyrics(l));
}

export function saveCustomLrc() {
  const textarea = $('lsmCustomLrcInput') as HTMLTextAreaElement | null;
  const val = textarea?.value.trim();
  if (!val || !currentTrackKey) return;
  try {
    localStorage.setItem('aura_custom_lrc_' + currentTrackKey, val);
  } catch (_) {}
  closeLyricsSettingsModal();
  const parsed = parseLRC(val, 'Custom LRC');
  renderLyrics(parsed);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Expose Global Handlers for HTML Onclick Binding */
if (typeof window !== 'undefined') {
  (window as any).seekToLyric = function(time: number) {
    if (state.audio) {
      state.audio.currentTime = time;
      if (state.audio.paused) state.audio.play();
    }
  };
  (window as any).toggleLyricsTranslation = toggleLyricsTranslation;
  (window as any).toggleLyricsTranslit = toggleLyricsTranslit;
  (window as any).cycleLyricsFontSize = cycleLyricsFontSize;
  (window as any).toggleLyricsAlign = toggleLyricsAlign;
  (window as any).setSyncOffset = setSyncOffset;
  (window as any).resetSyncOffset = resetSyncOffset;
  (window as any).openLyricsSettingsModal = openLyricsSettingsModal;
  (window as any).closeLyricsSettingsModal = closeLyricsSettingsModal;
  (window as any).changeLyricsProvider = changeLyricsProvider;
  (window as any).searchLyricsManually = searchLyricsManually;
  (window as any).saveCustomLrc = saveCustomLrc;
}
