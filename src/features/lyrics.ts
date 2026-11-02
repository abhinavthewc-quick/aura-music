import { state, $ } from '../core/state';

export interface LyricLine {
  time: number;
  text: string;
  translit?: string;
  translation?: string;
}

export interface ParsedLyrics {
  isSynced: boolean;
  lines: LyricLine[];
}

let currentLyrics: ParsedLyrics | null = null;
let activeIndex = -1;
let showTranslation = true;
let showTranslit = true;
let syncOffset = 0; // seconds

/* Curated multi-tier fallback lyrics for key demo tracks */
const CURATED_LYRICS: Record<string, ParsedLyrics> = {
  'welcome to punjab': {
    isSynced: true,
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
    lines: [
      { time: 12.0, text: 'दीवाना दीवाना तेरे इश्क़ में', translit: 'deewaana deewaana tere ishq mein', translation: 'Crazy, madly in love with you' },
      { time: 24.5, text: 'यह दिल खो गया है तेरी राहों में', translit: 'yeh dil kho gaya hai teri raahon mein', translation: 'This heart has lost itself in your pathways' },
      { time: 38.0, text: 'साँसों की धड़कन बस तुम ही हो', translit: 'saanson ki dhadkan bas tum hi ho', translation: 'Every beat of my breath is you alone' },
      { time: 54.0, text: 'रातों की नींदें चुराई तूने', translit: 'raaton ki neendein churaayi tune', translation: 'You stole the sleep of my nights' },
      { time: 70.0, text: 'दीवाना दीवाना तेरे इश्क़ में', translit: 'deewaana deewaana tere ishq mein', translation: 'Madly, deeply in love with you' }
    ]
  },
  'aalaporaan thamizhan': {
    isSynced: true,
    lines: [
      { time: 16.0, text: 'ஆளப்போறான் தமிழன் உலகை எல்லாமே', translit: 'aalapoaraan thamizhan ulagai ellaame', translation: 'The Tamilian is going to conquer the entire world' },
      { time: 28.5, text: 'வெற்றி கொடி ஏற்றி வைப்பான் முன்னாலே', translit: 'vetri kodi yaetri vaippaan munnaale', translation: 'He will hoist the flag of victory right in front' },
      { time: 42.0, text: 'அன்பாலே இணைப்போம் பாரை', translit: 'anbaale inaippoam paarai', translation: 'With love we shall unite this land' },
      { time: 58.0, text: 'வீரத்தோட நடை போடு தமிழா', translit: 'veerathoda nadai poadu thamizhaa', translation: 'Walk with courageous pride, dear Tamilian' }
    ]
  }
};

export function parseLRC(lrcText: string): ParsedLyrics {
  const lines: LyricLine[] = [];
  const rawLines = lrcText.split('\n');
  const timeRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\]/g;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let match;
    const timestamps: number[] = [];
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      timestamps.push(minutes * 60 + seconds);
    }
    const text = trimmed.replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (text) {
      for (const t of timestamps) {
        lines.push({ time: t, text });
      }
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return {
    isSynced: lines.length > 0,
    lines: lines.length > 0 ? lines : rawLines.map(t => ({ time: 0, text: t.trim() })).filter(l => l.text)
  };
}

export async function fetchLyricsForTrack(title: string, artist: string, duration?: number): Promise<ParsedLyrics | null> {
  const normTitle = (title || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(CURATED_LYRICS)) {
    if (normTitle.includes(key)) {
      return val;
    }
  }

  try {
    const cleanTitle = title.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
    const cleanArtist = artist.replace(/\s*[-–,].*$/, '').trim();
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}${duration ? `&duration=${Math.round(duration)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.syncedLyrics) {
      return parseLRC(data.syncedLyrics);
    } else if (data.plainLyrics) {
      const plainLines = data.plainLyrics.split('\n').map((l: string) => ({ time: 0, text: l.trim() })).filter((l: any) => l.text);
      return { isSynced: false, lines: plainLines };
    }
  } catch (err) {
    console.warn('Lyrics fetch failed:', err);
  }
  return null;
}

export function renderLyrics(lyrics: ParsedLyrics | null, containerId = 'fullPlayerLyricsContainer') {
  const container = $(containerId);
  if (!container) return;
  currentLyrics = lyrics;
  activeIndex = -1;

  if (!lyrics || !lyrics.lines.length) {
    container.innerHTML = `
      <div class="bl-lyrics-empty">
        <i class="fa-solid fa-microphone-slash"></i>
        <div class="bl-empty-title">No lyrics found</div>
        <div class="bl-empty-sub">Enjoy the music</div>
      </div>
    `;
    return;
  }

  const html = lyrics.lines.map((line, idx) => `
    <div class="bl-lyric-line" data-idx="${idx}" data-time="${line.time}" onclick="seekToLyric(${line.time})">
      <div class="bl-lyric-main">${escapeHtml(line.text)}</div>
      ${line.translit && showTranslit ? `<div class="bl-lyric-translit">${escapeHtml(line.translit)}</div>` : ''}
      ${line.translation && showTranslation ? `<div class="bl-lyric-trans">${escapeHtml(line.translation)}</div>` : ''}
    </div>
  `).join('');

  container.innerHTML = `
    <div class="bl-lyrics-scroll" id="blLyricsScroll">
      ${html}
    </div>
  `;
}

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

  if (newIdx !== activeIndex) {
    activeIndex = newIdx;
    const container = $(containerId);
    if (!container) return;

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
}

export function toggleLyricsTranslation() {
  showTranslation = !showTranslation;
  if (currentLyrics) renderLyrics(currentLyrics);
}

export function toggleLyricsTranslit() {
  showTranslit = !showTranslit;
  if (currentLyrics) renderLyrics(currentLyrics);
}

export function setSyncOffset(delta: number) {
  syncOffset += delta;
  const offsetLabel = $('blSyncOffsetLabel');
  if (offsetLabel) {
    offsetLabel.textContent = (syncOffset >= 0 ? '+' : '') + syncOffset.toFixed(1) + 's';
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Expose global seek handler */
if (typeof window !== 'undefined') {
  (window as any).seekToLyric = function(time: number) {
    if (state.audio) {
      state.audio.currentTime = time;
      if (state.audio.paused) state.audio.play();
    }
  };
  (window as any).toggleLyricsTranslation = toggleLyricsTranslation;
  (window as any).toggleLyricsTranslit = toggleLyricsTranslit;
  (window as any).setSyncOffset = setSyncOffset;
}
