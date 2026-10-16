import { getSavedUserName, timeGreeting } from '../core/dom';
import { playSong } from './player';
import { escapeHtml } from './radio';
import { $, state } from '../core/state';
/* ===== 3571-4215 ===== */
    /* ---------- Beeboo — scripted in-app helper (no external AI/API) ----------
       This is intentionally a keyword-matched, canned-response helper rather
       than a real LLM-backed chatbot: a static HTML file has nowhere safe to
       keep an API key, and calling a real AI service needs a backend this
       app doesn't have. Beeboo answers questions about using AURA Music,
       can tell you the current time/date and (with location permission)
       the local weather, and can pull a quick mood-matched pick from your
       own library — but it explicitly declines anything about code/how
       the app is built. */
    export const beebooQA = [
      { keys:['how to use aura','how do i use aura','how do i use aura music','how to use aura music','use aura music','using aura music','what can i do here','what can i do on aura','how does aura work','aura tutorial','aura guide'],
        a:"Sure — AURA Music is built around four simple areas: Home for your library and quick actions, Search for finding music, Radio for stations, and Add Music for bringing in tracks. Tap a song to play it, use the heart to favorite it, and open the ••• menu for queue, edit, remove, and other actions. Beeboo can also guide you through any one of those areas step by step." },
      { keys:['home tab','home page','home screen','homepage'],
        a:"Home is your music dashboard. You'll see your greeting, Beeboo, quick actions such as Liked Songs, Shuffle, Local Files and Recently Played, plus your library. Tap any track to play it." },
      { keys:['player','music player','now playing','playback','pause','skip','next song','previous song'],
        a:"The player controls playback. Use play/pause to control the current track, the progress bar to jump through it, and the previous/next controls to move between songs. The ••• menu gives you extra actions such as queue options and track actions." },
      { keys:['three dots','3 dots','more menu','options menu','ellipsis'],
        a:"The ••• menu is the track's action menu. Depending on the track, it can give you Play Next, Add to Queue, Add to Favorites, Edit Track, Remove from Library, and offline options." },
      { keys:['add song','add track','add music','upload','local file','local files','import music'],
        a:"To add music, open Add Music (+). AURA supports the import options shown there, including local audio files and supported links. After adding a track, it appears in your library so you can play, favorite, edit, or queue it." },
      { keys:['youtube','yt link','youtube link'],
        a:"For a YouTube track, open Add Music and use the YouTube link option. Paste the link and follow the on-screen controls. YouTube playback stays tied to YouTube's player rather than becoming a downloaded file." },
      { keys:['like','favorite','favourite','heart','liked songs'],
        a:"To favorite a song, tap its heart or use the ••• menu and choose Add to Favorites. Your favorites are collected in Liked Songs." },
      { keys:['search','find song','find music','search music'],
        a:"Use Search to find music in your library. You can also use the available online search option when it is enabled in Settings." },
      { keys:['queue','play next','play after','up next'],
        a:"Open a track's ••• menu and choose Play Next or Add to Queue. The player will follow the queue order as you continue listening." },
      { keys:['delete','remove song','remove track','remove from library'],
        a:"Open the track's ••• menu and choose Remove from Library. This only removes an added track from your library; it does not delete a song from the original service." },
      { keys:['edit','rename','change name','change title','change cover','edit track'],
        a:"Use the ••• menu and choose Edit Track. From there you can update the track information supported by AURA, such as title, artist, or cover art." },
      { keys:['radio','stations','radio tab'],
        a:"Radio gives you stations you can browse and play. Open the Radio tab, choose a station, and use the normal player controls." },
      { keys:['offline','download','save offline'],
        a:"Offline saving depends on how the track was added. Direct audio files can use AURA's offline option when available; streamed YouTube content is not turned into a downloadable copy by AURA." },
      { keys:['theme','dark mode','light mode','appearance'],
        a:"Open the menu and choose Light Mode or Dark Mode. AURA remembers the selected theme for the next time you open the app." },
      { keys:['settings','setting'],
        a:"Settings contains playback and app preferences such as autoplay, remembered volume, search history, online results, and reduced-motion options. Open it from the menu." },
      { keys:['effects','audio effects','sound effects','equalizer'],
        a:"Effects is where AURA's available audio-visual or playback effects can be managed. Open the menu and choose Effects to see the controls available in your current build." },
      { keys:['reset app','reset','clear app','clear everything'],
        a:"Reset App clears AURA's stored app data and reloads the app. Because it can remove your saved library/settings, use it only when you really want a fresh start." },
      { keys:['profile','account','change my name','username','my name'],
        a:"Tap your profile button to manage your profile options. You can change the name AURA uses when greeting you." },
      { keys:['logout','log out','sign out'],
        a:"Use Log out from the menu when you're finished. AURA will run its logout animation and return to the login/welcome flow." },
      { keys:['mobile','phone','tablet','desktop','pc','computer','laptop','responsive'],
        a:"AURA is responsive. On phones and tablets it uses the compact navigation and touch-friendly layout; on larger screens it switches to the desktop sidebar and wider music layout." },
      { keys:['beeboo','ai','chatbot','chat bot','voice assistant','voice'],
        a:"I'm Beeboo, AURA Music's built-in helper. I can explain the app, guide you through features, answer common AURA questions, pick tracks from your library by mood, and listen to you through the microphone when voice input is supported." },
      { keys:['what are you','who are you'],
        a:"I'm Beeboo 🐾 — the AURA Music helper. Think of me as the guide inside the app: ask about a feature, a track action, settings, or how to use AURA." },
      { keys:['thank','thanks','thank you'],
        a:"You're welcome! 🐾 Enjoy your music." },
      { keys:['hello','hi','hey','good morning','good evening','good night'],
        a:"Hey! 🐾 What would you like to do in AURA Music? You can ask about the player, library, Search, Radio, Add Music, Settings, Effects, or anything else about the app." },
      { keys:['what is aura','what is aura music','about aura','what is this app','what is this website','tell me about aura'],
        a:"AURA Music is a personal music player and library app. You add your own tracks — local files or supported links — organize and play them, browse radio stations, and I'm here (Beeboo) to help along the way." },
      { keys:['who made this','who made aura','who created this','who created aura','who built this','who built aura','made you'],
        a:"AURA Music was custom-built for this user's own library and listening experience — it's a personal project rather than a public commercial product." },
      { keys:['is this free','is aura free','cost','price','subscription','pay for'],
        a:"There's no subscription here — AURA runs as a personal app for your own library, so there's no price or paywall built in." },
      { keys:['microphone','mic','speak to you','talk to you','language support','what languages','which languages'],
        a:"You can talk to me! Tap the microphone in this chat to speak instead of typing, and use the language picker to choose the language for voice input and my spoken replies." }
    ];
    export const beebooCodeKeys = ['source code','api key','backend','repo','github','script tag','function(','<script'];
    export const beebooBuildKeys = ['code','html','javascript','js ','css','how is this built','how is the website built','how is the app built','how was aura made','how did you make aura'];
    export const beebooSuggestions = ["How do I use AURA Music?", "How do I add a song?", "What can the player do?", "Show me how Liked Songs works"];

    // Mood keyword → a friendly label used when introducing the picks.
    export const beebooMoods = [
      { keys:['rain','rainy','raining','monsoon','storm'], label:'a rainy day', emoji:'🌧️' },
      { keys:['sad','down','heartbroken','emotional','crying','cry','depressed','low','upset','lonely'], label:'when you need something emotional', emoji:'💙' },
      { keys:['happy','joy','joyful','excited','good mood','cheerful'], label:'a feel-good mood', emoji:'😊' },
      { keys:['workout','gym','running','exercise','jog'], label:'a workout', emoji:'💪' },
      { keys:['sleep','sleepy','relax','calm','chill','study','focus','night'], label:'winding down', emoji:'🌙' },
      { keys:['party','dance','hype','celebration'], label:'a party', emoji:'🎉' },
      { keys:['romantic','love song','date night'], label:'something romantic', emoji:'❤️' },
      { keys:['morning','wake up'], label:'starting your morning', emoji:'☀️' }
    ];

    export function detectBeebooMood(q){
      return beebooMoods.find(m => m.keys.some(k => q.includes(k)));
    }

    export function beebooPickSongs(count){
      const pool = state.songs.filter(s => !s.missing);
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count);
    }

    // Simple WMO weather_code → short description (Open-Meteo's coding scheme).
    export function beebooWeatherText(code){
      const map = {
        0:'clear skies', 1:'mostly clear', 2:'partly cloudy', 3:'overcast',
        45:'foggy', 48:'foggy with frost', 51:'light drizzle', 53:'drizzle', 55:'heavy drizzle',
        61:'light rain', 63:'rain', 65:'heavy rain', 66:'freezing rain', 67:'heavy freezing rain',
        71:'light snow', 73:'snow', 75:'heavy snow', 77:'snow grains',
        80:'light rain showers', 81:'rain showers', 82:'heavy rain showers',
        85:'snow showers', 86:'heavy snow showers', 95:'thunderstorms', 96:'thunderstorms with hail', 99:'severe thunderstorms'
      };
      return map[code] || 'mixed conditions';
    }

    export async function beebooGetWeather(){
      if(!navigator.geolocation){
        return "I can't check live weather without location access on this device — but tell me if it's rainy, sunny, or cold and I'll match some songs to it!";
      }
      try{
        const pos = await new Promise<any>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {timeout:7000, maximumAge:600000})
        );
        const { latitude, longitude } = pos.coords;
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`);
        const data = await res.json();
        const c = data.current;
        if(!c) throw new Error('no data');
        const desc = beebooWeatherText(c.weather_code);
        let line = `Right now it's about ${Math.round(c.temperature_2m)}°C and ${desc}, humidity ${Math.round(c.relative_humidity_2m)}%, wind ${Math.round(c.wind_speed_10m)} km/h.`;
        if(c.weather_code >= 51 && c.weather_code <= 82){
          line += ' Rainy vibes — want me to pull a few rainy-day tracks from your library?';
        }
        return line;
      }catch(e){
        if(e && e.code===1) return "Location access is blocked. Allow it in your browser's site settings to get live weather — or just tell me the weather and I'll match songs to it!";
        return "I couldn't get a location fix for live weather — you may need to allow location access. Meanwhile, just tell me the weather (\"it's rainy\", \"it's sunny\") and I'll match some songs to it!";
      }
    }

    export function beebooTimeText(){
      const now = new Date();
      return `It's ${now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} right now.`;
    }
    export function beebooDateText(){
      const now = new Date();
      return `Today is ${now.toLocaleDateString([], {weekday:'long', year:'numeric', month:'long', day:'numeric'})}.`;
    }

    export function updateBeebooHeadContext(){
      const el = $('beebooHeadContext');
      if(!el) return;
      const now = new Date();
      el.textContent = `${now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · ${now.toLocaleDateString([], {month:'short', day:'numeric'})}`;
    }

    export async function beebooReply(text){
      const q = text.toLowerCase().replace(/\s+/g,' ').trim();
      { const _n=beebooUserName();
        if(/^(hi+|hello+|hey+|yo|hola|namaste|good (morning|afternoon|evening))\b/.test(q) && q.split(' ').length<=3) return { text: timeGreeting()+(_n?', '+_n:'')+'! 🐾 What are we listening to today?' };
        if(/\b(my name|who am i|do you know me|know my name)\b/.test(q)) return { text: _n ? `You're ${_n}! 🐾 Glad you're here.` : "I don't have your name yet — you can set it in your profile and I'll use it." }; }

      if(beebooBuildKeys.some(k => q.includes(k))){
        return { text: "I can explain the AURA Music experience and what each part of the website does, but I won't expose private source code, keys, or backend credentials. If you mean how to use a feature, tell me the feature and I'll walk you through it." };
      }
      if(beebooCodeKeys.some(k => q.includes(k))){
        return { text: "I can explain what AURA Music does and how its features work from the user's side, but I won't expose private keys or internal code. Ask me about the player, library, Search, Radio, Add Music, Settings, Effects, or Beeboo." };
      }

      if(/\b(time|clock)\b/.test(q)) return { text: beebooTimeText() };
      if(/\b(date|today'?s date|what day|day is it)\b/.test(q)) return { text: beebooDateText() };
      if(/\bweather\b|\bforecast\b|\btemperature\b|\bhow('?s| is) it outside\b/.test(q)){
        return { text: await beebooGetWeather() };
      }

      // "help" / "what can you do" gets a concise, scannable capability list
      // instead of forcing people to guess what to ask.
      if(/\b(help|what can you do|what do you do|commands|menu|options)\b/.test(q)){
        return { text: "Here's what I can help with:\n• Explaining any AURA Music feature — Home, Search, Radio, Add Music, Settings, Effects, and more\n• Track actions — play, queue, favorite, edit, remove\n• The current time, date, and local weather\n• Picking a few songs from your library to match a mood\n• Voice input/output in several languages (mic + language picker below)\n\nJust ask naturally, or tap a suggestion below!" };
      }

      // A short goodbye deserves a proper send-off rather than the generic
      // "I didn't catch that" fallback.
      const wordCount = q.split(' ').filter(Boolean).length;
      if(wordCount <= 5 && /\b(bye|goodbye|see you|see ya|gtg|got to go|talk later|catch you later)\b/.test(q)){
        return { text: "Bye for now! 🐾 Enjoy the music — I'll be right here if you need anything." };
      }

      // Natural conversation gets handled before AURA feature keywords.
      // This prevents greetings such as "sughamano" / "സുഖമാണോ" from
      // accidentally matching help/home/like keywords and returning a feature tutorial.
      const greetingPatterns = [
        /\b(sughamano|sukhamaano|sukhamano|sukham aano|sugham aano)\b/i,
        /സുഖമാണോ|സുഖം ആണോ|സുഖമാണോ\?/i,
        /\b(how are you|how r u|are you okay|are you fine)\b/i,
        /എങ്ങനെയുണ്ട്|എങ്ങനെ ഉണ്ട്|സുഖമാണോ/i,
        /\b(hello|hi|hey|hai|namaste|namaskaram|good morning|good evening|good night)\b/i,
        /ഹലോ|ഹായ്|ഹായ്‌|നമസ്കാരം/i
      ];
      if(greetingPatterns.some(rx => rx.test(q))){
        const lang = getBeebooLanguage().code;
        const greetings = {
          'ml-IN': 'എനിക്ക് സുഖമാണ്! 🐾 ചോദിച്ചതിന് നന്ദി. നിങ്ങൾക്ക് സുഖമാണോ? 😊',
          'ta-IN': 'நான் நன்றாக இருக்கிறேன்! 🐾 கேட்டதற்கு நன்றி. நீங்கள் எப்படி இருக்கிறீர்கள்? 😊',
          'te-IN': 'నేను బాగున్నాను! 🐾 అడిగినందుకు ధన్యవాదాలు. మీరు ఎలా ఉన్నారు? 😊',
          'kn-IN': 'ನಾನು ಚೆನ್ನಾಗಿದ್ದೇನೆ! 🐾 ಕೇಳಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನೀವು ಹೇಗಿದ್ದೀರಿ? 😊',
          'hi-IN': 'मैं बिल्कुल ठीक हूँ! 🐾 पूछने के लिए धन्यवाद। आप कैसे हैं? 😊',
          'bn-IN': 'আমি ভালো আছি! 🐾 জিজ্ঞেস করার জন্য ধন্যবাদ। আপনি কেমন আছেন? 😊',
          'mr-IN': 'मी छान आहे! 🐾 विचारल्याबद्दल धन्यवाद. तुम्ही कसे आहात? 😊',
          'gu-IN': 'હું મજામાં છું! 🐾 પૂછવા બદલ આભાર. તમે કેમ છો? 😊',
          'pa-IN': 'ਮੈਂ ਬਿਲਕੁਲ ਠੀਕ ਹਾਂ! 🐾 ਪੁੱਛਣ ਲਈ ਧੰਨਵਾਦ। ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ? 😊',
          'ur-IN': 'میں بالکل ٹھیک ہوں! 🐾 پوچھنے کا شکریہ۔ آپ کیسے ہیں؟ 😊',
          'en-IN': "I'm doing great! 🐾 Thanks for asking. How are you? 😊"
        };
        return { text: greetings[lang] || greetings['en-IN'], alreadyLocalized: true };
      }

      // Small-talk follow-ups to Beeboo's own "How are you?" (or a general
      // check-in) so a short reply like "fine" or "good" leads somewhere
      // instead of landing on the generic fallback message. Kept short
      // (<=5 words) so it doesn't hijack longer feature questions that
      // happen to contain a word like "good" (e.g. "is the sound good on
      // radio?").
      const smallTalkWordCount = q.split(' ').filter(Boolean).length;
      if(smallTalkWordCount <= 5){
        if(/\b(not\s+(good|great|fine|ok|okay)|bad|sad|terrible|awful|tired|rough day|not feeling well)\b/.test(q)){
          return { text: "Sorry to hear that. 💙 Maybe some music will help — want me to pick a few tracks for your mood, or ask me about a feature?" };
        }
        if(/\b(fine|good|great|okay|ok|alright|awesome|not bad|so so|so-so|meh|great thanks|doing well)\b/.test(q)){
          return { text: "Glad to hear it! 🐾 What would you like to do next — play something, add music, or ask me about a feature?" };
        }
      }

      // Direct feature questions get priority over generic mood matching.
      // Use phrase/alias matching so short requests such as "home",
      // "home tab", "ഹോം", or a voice-recognized variant don't fall
      // through to the generic "ask me about Home/Radio/..." message.
      const featureAliases = {
        home: ['home','home tab','home page','home screen','homepage','ഹോം','ഹോം ടാബ്','ഹോം പേജ്','ஹோம்','ஹோம் டேப்','హోమ్','హోమ్ ట్యాబ్','ಹೋಮ್','ಹೋಮ್ ಟ್ಯಾಬ್'],
        radio: ['radio','radio tab','radio page','റേഡിയോ','റേഡിയോ ടാബ്','ரேடியோ','ரேடியோ டேப்','రేడియో','ರೇಡಿಯೋ'],
        search: ['search','search tab','search page','സെർച്ച്','സേർച്ച്','തിരയൽ','சர்ச்','தேடல்','సెర్చ్','వెతుకు','ಸರ್ಚ್','ಹುಡುಕು'],
        likes: ['liked songs','likes','liked','favorites','favourites','favorite','favourite','heart','ലൈക്ക്ഡ് സോംഗ്സ്','ലൈക്ക്','പ്രിയപ്പെട്ടവ','லைக்','பிடித்த பாடல்கள்','లైక్','ఇష్టమైన పాటలు','ಲೈಕ್','ಮೆಚ್ಚಿನ ಹಾಡುಗಳು'],
        add: ['add music','add song','add track','upload','local files','local file','import music','add music tab','മ്യൂസിക് ചേർക്കുക','പാട്ട് ചേർക്കുക','ஆட் மியூசிக்','பாடல் சேர்க்க','మ్యూజిక్ యాడ్','పాట జోడించు','ಮ್ಯೂಸಿಕ್ ಆಡ್','ಹಾಡು ಸೇರಿಸಿ']
      };
      for(const entry of beebooQA){
        if(entry.keys.some(k => q.includes(k))) return { text: entry.a };
      }
      if(featureAliases.home.some(k => q === k || q.includes(k))) {
        const entry = beebooQA.find(e => e.keys.includes('home tab'));
        if(entry) return { text: entry.a };
      }
      if(featureAliases.radio.some(k => q === k || q.includes(k))) {
        const entry = beebooQA.find(e => e.keys.includes('radio'));
        if(entry) return { text: entry.a };
      }
      if(featureAliases.search.some(k => q === k || q.includes(k))) {
        const entry = beebooQA.find(e => e.keys.includes('search'));
        if(entry) return { text: entry.a };
      }
      if(featureAliases.likes.some(k => q === k || q.includes(k))) {
        const entry = beebooQA.find(e => e.keys.includes('liked songs'));
        if(entry) return { text: entry.a };
      }
      if(featureAliases.add.some(k => q === k || q.includes(k))) {
        const entry = beebooQA.find(e => e.keys.includes('add music'));
        if(entry) return { text: entry.a };
      }

      const mood = detectBeebooMood(q);
      if(mood){
        const picks = beebooPickSongs(4);
        if(picks.length){
          return { text: `${mood.emoji} I found a few tracks in your library that fit ${mood.label}. Tap one to start listening.`, songs: picks };
        }
        return { text: `I can do that once you have some music in your library. Add a few tracks, then tell me the mood again and I'll pick from them.` };
      }

      if(/\b(website|site|app|aura)\b/.test(q)){
        return { text: "I can help with the AURA Music app itself. Ask me what a button does, how to play or queue a song, how to add music, how Search or Radio works, how to manage favorites, or how Settings and Effects work." };
      }

      return { text: "Hmm, I'm not quite sure about that one yet! 🐾 Try asking about the player, Home, Search, Radio, Add Music, Liked Songs, the queue, Settings, Effects, your profile, or just say \"help\" for a quick list.", fallback:true };
    }

    export async function localizeBeebooReply(text){
      const lang = getBeebooLanguage().code;
      if(!text || lang === 'en-IN') return text;
      // Beeboo remains usable offline: if translation is unavailable, the original
      // answer is returned instead of blocking the chat.
      try{
        const target = lang.split('-')[0];
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(String(text).slice(0,480))}&langpair=en|${encodeURIComponent(target)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5500);
        const res = await fetch(url, {signal:controller.signal});
        clearTimeout(timer);
        if(!res.ok) return text;
        const data = await res.json();
        const translated = data && data.responseData && data.responseData.translatedText;
        return translated ? String(translated) : text;
      }catch(e){
        return text;
      }
    }

    export function appendBeebooMessage(text, sender){
      const body = $('beebooChatBody');
      const el = document.createElement('div');
      el.className = `beeboo-msg ${sender}`;
      el.textContent = text;
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
    }

    export function appendBeebooSongList(songList){
      const body = $('beebooChatBody');
      const wrap = document.createElement('div');
      wrap.className = 'beeboo-msg bot beeboo-song-list';
      songList.forEach(s => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'beeboo-song-row';
        row.innerHTML = `<img src="${escapeHtml(s.img||'')}" alt=""><span><b>${escapeHtml(s.title||'Untitled')}</b><small>${escapeHtml(s.artist||'')}</small></span><i class="fa-solid fa-play"></i>`;
        row.onclick = () => {
          const idx = state.songs.findIndex(x => String(x.id) === String(s.id));
          if(idx !== -1){ playSong(idx); closeBeebooChat(); }
        };
        wrap.appendChild(row);
      });
      body.appendChild(wrap);
      body.scrollTop = body.scrollHeight;
    }

    export function renderBeebooSuggestions(){
      $('beebooSuggestRow').innerHTML = beebooSuggestions.map(s =>
        `<button class="beeboo-suggest-chip" type="button" onclick="sendBeebooMessage(${JSON.stringify(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')})">${s}</button>`
      ).join('');
    }

    export async function sendBeebooMessage(presetText?){
      const input = $('beebooChatInput');
      const text = (typeof presetText === 'string' ? presetText : input.value).trim();
      if(!text) return;
      appendBeebooMessage(text, 'user');
      input.value = '';
      const thinking = document.createElement('div');
      thinking.className = 'beeboo-msg bot';
      thinking.textContent = '…';
      $('beebooChatBody').appendChild(thinking);
      $('beebooChatBody').scrollTop = $('beebooChatBody').scrollHeight;
      const reply = await beebooReply(text);
      thinking.remove();
      const localizedText = reply.alreadyLocalized ? reply.text : await localizeBeebooReply(reply.text);
      appendBeebooMessage(localizedText, 'bot');
      speakBeeboo(localizedText);
      if(reply.songs && reply.songs.length) appendBeebooSongList(reply.songs);
    }

    export function beebooGreetIntro(){
      appendBeebooMessage(beebooHello()+" I'm Beeboo 🐾 I can help you use AURA Music, manage your library, control playback, understand settings, or pick music from your library. You can also talk to me with the microphone.", 'bot');
      renderBeebooSuggestions();
    }

    export function openBeebooChat(){
      hideBeebooGreetingBubble();
      try{ localStorage.setItem(BEEBOO_BUBBLE_SEEN_KEY,'1'); }catch(e){}
      $('beebooChatOverlay').classList.add('active');
      updateBeebooHeadContext();
      if(!$('beebooChatBody').childElementCount){
        beebooGreetIntro();
      }
    }
    export function closeBeebooChat(){ $('beebooChatOverlay').classList.remove('active'); }

    // A visible way to start over with Beeboo without reloading the whole
    // app — useful once a conversation has scrolled on for a while.
    $('beebooClearBtn').onclick = () => {
      $('beebooChatBody').innerHTML = '';
      if('speechSynthesis' in window) window.speechSynthesis.cancel();
      beebooGreetIntro();
    };
    $('beebooOpenBtn').onclick = openBeebooChat;
    $('beebooCloseBtn').onclick = closeBeebooChat;
    $('beebooChatOverlay').onclick = (e) => { if(e.target === $('beebooChatOverlay')) closeBeebooChat(); };
    $('beebooSendBtn').onclick = () => sendBeebooMessage();
    $('beebooChatInput').addEventListener('keydown', e => { if(e.key === 'Enter') sendBeebooMessage(); });
    // Beeboo multilingual voice assistant.
    // Recognition support varies by browser/language; speech synthesis is more widely supported.
    export const BEEBOO_LANGUAGE_KEY = 'auraBeebooVoiceLanguage_v1';
    export const beebooLanguages = [
      {code:'en-IN', name:'English', native:'English'},
      {code:'hi-IN', name:'Hindi', native:'हिन्दी'},
      {code:'ml-IN', name:'Malayalam', native:'മലയാളം'},
      {code:'ta-IN', name:'Tamil', native:'தமிழ்'},
      {code:'te-IN', name:'Telugu', native:'తెలుగు'},
      {code:'kn-IN', name:'Kannada', native:'ಕನ್ನಡ'},
      {code:'bn-IN', name:'Bengali', native:'বাংলা'},
      {code:'mr-IN', name:'Marathi', native:'मराठी'},
      {code:'gu-IN', name:'Gujarati', native:'ગુજરાતી'},
      {code:'pa-IN', name:'Punjabi', native:'ਪੰਜਾਬੀ'},
      {code:'ur-IN', name:'Urdu', native:'اردو'},
      {code:'as-IN', name:'Assamese', native:'অসমীয়া'},
      {code:'or-IN', name:'Odia', native:'ଓଡ଼ିଆ'},
      {code:'sa-IN', name:'Sanskrit', native:'संस्कृतम्'},
      {code:'kok-IN', name:'Konkani', native:'कोंकणी'},
      {code:'ne-IN', name:'Nepali', native:'नेपाली'},
      {code:'ks-IN', name:'Kashmiri', native:'کٲشُر'},
      {code:'sd-IN', name:'Sindhi', native:'سنڌي'},
      {code:'mai-IN', name:'Maithili', native:'मैथिली'},
      {code:'mni-IN', name:'Manipuri', native:'মৈতৈলোন্'},
      {code:'brx-IN', name:'Bodo', native:'बड़ो'},
      {code:'doi-IN', name:'Dogri', native:'डोगरी'},
      {code:'sat-IN', name:'Santali', native:'ᱥᱟᱱᱛᱟᱲᱤ'}
    ];
    export let beebooVoiceReplies = true;
    export let beebooRecognition = null;
    export let beebooListening = false;
    export let beebooVoiceLanguage = 'en-IN';

    export function getBeebooLanguage(){
      return beebooLanguages.find(x => x.code === beebooVoiceLanguage) || beebooLanguages[0];
    }

    export function initBeebooLanguage(){
      const select = $('beebooLanguageSelect');
      if(!select) return;
      select.innerHTML = beebooLanguages.map(x => `<option value="${x.code}">${x.native} · ${x.name}</option>`).join('');
      let saved = '';
      try{ saved = localStorage.getItem(BEEBOO_LANGUAGE_KEY) || ''; }catch(e){}
      if(!beebooLanguages.some(x => x.code === saved)){
        const nav = (navigator.language || 'en-IN').toLowerCase();
        const exact = beebooLanguages.find(x => x.code.toLowerCase() === nav);
        const base = beebooLanguages.find(x => x.code.split('-')[0] === nav.split('-')[0]);
        saved = (exact || base || beebooLanguages[0]).code;
      }
      beebooVoiceLanguage = saved;
      select.value = saved;
      select.addEventListener('change', () => {
        beebooVoiceLanguage = select.value;
        try{ localStorage.setItem(BEEBOO_LANGUAGE_KEY, beebooVoiceLanguage); }catch(e){}
        // Rebuild recognition so the next microphone session uses the new locale.
        if(beebooRecognition){
          try{ beebooRecognition.abort(); }catch(e){}
          beebooRecognition = null;
          beebooListening = false;
        }
        setBeebooVoiceStatus(`${getBeebooLanguage().native} selected`);
        setTimeout(() => { if(!beebooListening) setBeebooVoiceStatus(''); }, 1600);
      });
    }

    export function setBeebooVoiceStatus(message){
      const el = $('beebooVoiceStatus');
      if(el) el.textContent = message || '';
    }

    export function pickBeebooVoice(lang){
      if(!('speechSynthesis' in window)) return null;
      const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
      const base = lang.toLowerCase().split('-')[0];
      return voices.find(v => (v.lang || '').toLowerCase() === lang.toLowerCase()) ||
             voices.find(v => (v.lang || '').toLowerCase().startsWith(base + '-')) ||
             voices.find(v => (v.lang || '').toLowerCase() === base) || null;
    }

    export function cleanBeebooSpeechText(text){
      // Keep emojis in the visible chat, but NEVER send them to the TTS engine.
      // Some Android/browser voices verbalize emoji names (for example 🐾 as
      // "dog paw"), which makes a natural reply sound like a translation.
      return String(text || '')
        .replace(/<[^>]*>/g,' ')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ')
        .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu,' ')
        .replace(/\s{2,}/g,' ')
        .trim()
        .slice(0,700);
    }

    export function speakBeeboo(text){
      if(!beebooVoiceReplies || !('speechSynthesis' in window)) return;
      try{
        window.speechSynthesis.cancel();
        const clean = cleanBeebooSpeechText(text);
        if(!clean) return;
        const utterance = new SpeechSynthesisUtterance(clean);
        const lang = getBeebooLanguage().code;
        const voice = pickBeebooVoice(lang);
        utterance.lang = lang;
        if(voice) utterance.voice = voice;
        utterance.rate = 0.96;
        utterance.pitch = 1.0;
        utterance.volume = 1;
        utterance.onstart = () => setBeebooVoiceStatus(`Beeboo is speaking · ${getBeebooLanguage().native}`);
        utterance.onend = () => { if(!beebooListening) setBeebooVoiceStatus(''); };
        window.speechSynthesis.speak(utterance);
      }catch(e){}
    }

    // ----- Beeboo listening screen (full-screen ring, shown while the mic is live) -----
    export let beebooGotFinal = false, beebooPrevInput = '', beebooListenTimer = null, beebooListenHold = false;
    export function openBeebooListen(){
      const el = $('beebooListen'); if(!el) return;
      clearTimeout(beebooListenTimer);
      beebooListenHold = false;
      el.classList.remove('hearing','error');
      el.classList.add('active');
      el.setAttribute('aria-hidden','false');
      $('beebooListenTitle').textContent = 'I’m listening…';
      const sub = $('beebooListenSub');
      sub.classList.remove('has-text');
      sub.textContent = getBeebooLanguage().native;
      try{ $('beebooListenOrb').focus({preventScroll:true}); }catch(e){}
    }
    export function closeBeebooListen(delay){
      const el = $('beebooListen'); if(!el) return;
      clearTimeout(beebooListenTimer);
      const go = () => { el.classList.remove('active','hearing','error'); el.setAttribute('aria-hidden','true'); };
      if(delay) beebooListenTimer = setTimeout(go, delay); else go();
    }
    export function showBeebooHeard(text){
      if(!text) return;
      const sub = $('beebooListenSub');
      sub.textContent = text;
      sub.classList.add('has-text');
    }
    export function showBeebooListenError(code){
      const el = $('beebooListen'); if(!el) return;
      const blocked = code === 'not-allowed' || code === 'service-not-allowed';
      const title = code === 'no-speech' ? 'I didn’t hear anything' : blocked ? 'Microphone is blocked' : 'Voice input isn’t available';
      const sub = code === 'no-speech' ? 'Tap the mic and try again.' : blocked ? 'Allow the microphone in your browser’s site settings, then try again.' : `${getBeebooLanguage().native} may not be supported in this browser.`;
      beebooListenHold = true;
      clearTimeout(beebooListenTimer);
      el.classList.remove('hearing');
      el.classList.add('active','error');
      el.setAttribute('aria-hidden','false');
      $('beebooListenTitle').textContent = title;
      const s = $('beebooListenSub');
      s.classList.remove('has-text');
      s.textContent = sub;
      closeBeebooListen(2400);
    }
    export function cancelBeebooListen(){
      try{ if(beebooRecognition) beebooRecognition.abort(); }catch(e){}
      beebooListening = false;
      if(!beebooGotFinal) $('beebooChatInput').value = beebooPrevInput;
      $('beebooMicBtn').classList.remove('is-listening');
      $('beebooMicBtn').innerHTML = '<i class="fa-solid fa-microphone"></i>';
      setBeebooVoiceStatus('');
      closeBeebooListen(0);
    }

    export function setupBeebooRecognition(){
      if(beebooRecognition) return beebooRecognition;
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if(!SpeechRecognition) return null;
      const r = new SpeechRecognition();
      r.continuous = false;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.lang = getBeebooLanguage().code;
      r.onstart = () => {
        beebooListening = true;
        beebooGotFinal = false;
        beebooPrevInput = $('beebooChatInput').value;
        openBeebooListen();
        $('beebooMicBtn').classList.add('is-listening');
        $('beebooMicBtn').innerHTML = '<i class="fa-solid fa-microphone-lines"></i>';
        setBeebooVoiceStatus(`Listening · ${getBeebooLanguage().native}…`);
      };
      r.onresult = (event) => {
        let transcript = '';
        for(let i=event.resultIndex;i<event.results.length;i++) transcript += event.results[i][0].transcript;
        $('beebooChatInput').value = transcript.trim();
        showBeebooHeard(transcript.trim());
        if(event.results[event.results.length-1].isFinal){
          beebooGotFinal = true;
          $('beebooListenTitle').textContent = 'Got it';
          setBeebooVoiceStatus('Got it — sending…');
          setTimeout(() => sendBeebooMessage(), 80);
        }
      };
      r.onerror = (event) => {
        beebooListening = false;
        if(event.error === 'aborted') closeBeebooListen(0); else showBeebooListenError(event.error);
        $('beebooMicBtn').classList.remove('is-listening');
        $('beebooMicBtn').innerHTML = '<i class="fa-solid fa-microphone"></i>';
        const msg = event.error === 'aborted' ? '' : (event.error === 'not-allowed' || event.error === 'service-not-allowed') ? 'Microphone access is blocked — allow it in your browser\'s site settings, then try again.' :
                    event.error === 'no-speech' ? 'I didn’t hear anything.' :
                    `Voice input for ${getBeebooLanguage().native} is unavailable in this browser.`;
        setBeebooVoiceStatus(msg);
        setTimeout(() => { if(!beebooListening) setBeebooVoiceStatus(''); }, 2600);
      };
      r.onend = () => {
        beebooListening = false;
        if(!beebooListenHold) closeBeebooListen(beebooGotFinal ? 550 : 0);
        $('beebooMicBtn').classList.remove('is-listening');
        $('beebooMicBtn').innerHTML = '<i class="fa-solid fa-microphone"></i>';
        if(!beebooListenHold && (!window.speechSynthesis || !window.speechSynthesis.speaking)) setBeebooVoiceStatus('');
      };
      r.onspeechstart = () => { const el = $('beebooListen'); if(el) el.classList.add('hearing'); };
      r.onspeechend = () => { const el = $('beebooListen'); if(el) el.classList.remove('hearing'); };
      beebooRecognition = r;
      return r;
    }

    export function toggleBeebooVoiceInput(){
      const r = setupBeebooRecognition();
      if(!r){
        setBeebooVoiceStatus('Voice input is not supported by this browser.');
        return;
      }
      try{
        if(beebooListening){ r.stop(); return; }
        if('speechSynthesis' in window) window.speechSynthesis.cancel();
        r.start();
      }catch(e){}
    }

    $('beebooMicBtn').onclick = toggleBeebooVoiceInput;
    $('beebooListenClose').onclick = cancelBeebooListen;
    $('beebooListenOrb').onclick = () => { try{ if(beebooRecognition && beebooListening) beebooRecognition.stop(); }catch(e){} };
    document.addEventListener('keydown', e => {
      const el = $('beebooListen');
      if(e.key === 'Escape' && el && el.classList.contains('active')) cancelBeebooListen();
    });
    $('beebooVoiceBtn').onclick = () => {
      beebooVoiceReplies = !beebooVoiceReplies;
      const btn = $('beebooVoiceBtn');
      btn.classList.toggle('is-muted', !beebooVoiceReplies);
      btn.setAttribute('aria-label', beebooVoiceReplies ? 'Turn voice replies off' : 'Turn voice replies on');
      btn.title = beebooVoiceReplies ? 'Voice replies on' : 'Voice replies off';
      btn.innerHTML = `<i class="fa-solid ${beebooVoiceReplies ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>`;
      if(!beebooVoiceReplies && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };

    initBeebooLanguage();
    if('speechSynthesis' in window){
      try{ window.speechSynthesis.onvoiceschanged = () => {}; window.speechSynthesis.getVoices(); }catch(e){}
    }

    // The welcome bubble is a first-time hint only. Once the user opens
    // Beeboo, it stays hidden so it does not keep announcing that this is a chatbot.
    export const BEEBOO_BUBBLE_SEEN_KEY = 'auraBeebooBubbleSeen_v1';
    export function hideBeebooGreetingBubble(){
      const el = $('beebooGreetBubble');
      if(el){
        el.classList.add('beeboo-bubble-dismissed');
        el.setAttribute('aria-hidden','true');
      }
    }
    try{
      if(localStorage.getItem(BEEBOO_BUBBLE_SEEN_KEY) === '1') hideBeebooGreetingBubble();
    }catch(e){}

/* ===== 4687-4694 ===== */
    /* Beeboo knows the user's name */
    export function beebooUserName(){
      let n=getSavedUserName();
      if(!n){ const el=$('displayUserName'); n=el?el.textContent.trim():''; }
      return (n && n.toLowerCase()!=='user') ? n.split(/\s+/)[0] : '';
    }
    export function beebooHello(){ const n=beebooUserName(); return n ? timeGreeting()+', '+n+'!' : 'Hey!'; }
    (function(){ const b=$('beebooGreetBubble'), n=beebooUserName(); if(b&&n) b.textContent='Hi '+n+'! 👋'; })();
