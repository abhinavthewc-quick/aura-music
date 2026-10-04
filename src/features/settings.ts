import { getSavedUserName, toast } from '../core/dom';
import {
  clearSession, getSession, getProfileUsername, isValidUsername, normalizeUsername,
  setProfileUsername, setSession,
} from '../core/session';
import { searchYouTubePro } from './search';
import { $, state } from '../core/state';
/* ===== 4216-4287 ===== */
    export function resetApp() {
        if(confirm("Delete all added tracks and reset?")) {
            localStorage.clear();
            location.reload();
        }
    }

    export function logoutUser(){
      $('sideMenu').style.display = 'none';
      const overlay = $('logoutOverlay');
      overlay.classList.add('active');
      overlay.setAttribute('aria-hidden', 'false');
      setTimeout(() => {
        localStorage.removeItem('auraUserName');
        clearSession();
        try{ (window as any).google?.accounts?.id?.disableAutoSelect?.(); }catch(e){}
        location.reload();
      }, 1500);
    }

    /* Theme Toggle */
    $('themeToggleBtn').onclick = () => {
      document.body.classList.toggle('light-theme');
      const isLight = document.body.classList.contains('light-theme');
      $('themeIcon').className = isLight ? "fa-solid fa-moon" : "fa-solid fa-sun";
      $('themeLabel').textContent = isLight ? "Dark Mode" : "Light Mode";
      const dIcon = $('desktopThemeIcon'); const dLabel = $('desktopThemeLabel');
      if(dIcon) dIcon.className = isLight ? "fa-solid fa-moon" : "fa-solid fa-sun";
      if(dLabel) dLabel.textContent = isLight ? "Dark Mode" : "Light Mode";
    };


    /* Interactive Settings */
    export const AURA_SETTINGS_KEY='auraSettings_v1';
    export const defaultAuraSettings={autoplayNext:true,rememberVolume:true,searchHistory:true,youtubeResults:true,reduceMotion:false};
    export let auraSettings={...defaultAuraSettings};
    try{ auraSettings={...defaultAuraSettings,...JSON.parse(localStorage.getItem(AURA_SETTINGS_KEY)||'{}')}; }catch(e){}
    export function saveAuraSettings(){ localStorage.setItem(AURA_SETTINGS_KEY,JSON.stringify(auraSettings)); }
    export function applyAuraSettings(){
      $('settingAutoplayNext').checked=!!auraSettings.autoplayNext;
      $('settingRememberVolume').checked=!!auraSettings.rememberVolume;
      $('settingSearchHistory').checked=!!auraSettings.searchHistory;
      $('settingYouTubeResults').checked=!!auraSettings.youtubeResults;
      $('settingReduceMotion').checked=!!auraSettings.reduceMotion;
      document.body.classList.toggle('aura-reduce-motion',!!auraSettings.reduceMotion);
      if(!auraSettings.searchHistory){ localStorage.removeItem('auraSearchHistory_v1'); }
      const y=$('youtubeSearchSection'); if(y && !auraSettings.youtubeResults) y.style.display='none';
      $('youtubeApiKeyInput').value = localStorage.getItem('auraYoutubeApiKey') || '';
      $('jamendoClientIdInput').value = localStorage.getItem('auraJamendoClientId') || '';
    }
    export function openSettings(){ $('sideMenu').style.display='none'; $('settingsModal').classList.add('active'); $('settingsModal').setAttribute('aria-hidden','false'); applyAuraSettings(); }
    export function closeSettings(){ $('settingsModal').classList.remove('active'); $('settingsModal').setAttribute('aria-hidden','true'); }
    $('openSettingsBtn').onclick=openSettings;
    $('settingsCloseBtn').onclick=closeSettings;
    $('settingsModal').onclick=e=>{if(e.target===$('settingsModal'))closeSettings();};
    [['settingAutoplayNext','autoplayNext'],['settingRememberVolume','rememberVolume'],['settingSearchHistory','searchHistory'],['settingYouTubeResults','youtubeResults'],['settingReduceMotion','reduceMotion']].forEach(([id,key])=>{ $(id).onchange=e=>{auraSettings[key]=e.target.checked;saveAuraSettings();applyAuraSettings();toast(e.target.checked?'Setting enabled':'Setting disabled','circle-check');}; });
    $('saveYoutubeApiKeyBtn').onclick=()=>{
      const key=$('youtubeApiKeyInput').value.trim();
      if(key){ localStorage.setItem('auraYoutubeApiKey',key); toast('YouTube Music search enabled','circle-check'); }
      else { localStorage.removeItem('auraYoutubeApiKey'); toast('YouTube Music key removed','circle-check'); }
      const q=$('searchTabInput') && $('searchTabInput').value.trim();
      if(q) searchYouTubePro(q);
    };
    $('saveJamendoClientIdBtn').onclick=()=>{
      const key=$('jamendoClientIdInput').value.trim();
      if(key){ localStorage.setItem('auraJamendoClientId',key); toast('Jamendo full-song search enabled','circle-check'); }
      else { localStorage.removeItem('auraJamendoClientId'); toast('Jamendo client_id removed','circle-check'); }
      const q=$('searchTabInput') && $('searchTabInput').value.trim();
      if(q) searchYouTubePro(q);
    };
    $('clearSearchHistoryBtn').onclick=()=>{localStorage.removeItem('auraSearchHistory_v1');if(typeof (window as any).renderSearchHistory==='function')(window as any).renderSearchHistory();toast('Recent searches cleared','trash-can');};
    $('resetPreferencesBtn').onclick=()=>{if(confirm('Reset Aura Music preferences?')){auraSettings={...defaultAuraSettings};saveAuraSettings();applyAuraSettings();toast('Preferences restored','circle-check');}};
    applyAuraSettings();

/* ===== 4695-4705 ===== */

    /* Sidebar collapse + Help */
    (function(){
      const K='auraSidebarCollapsed';
      try{ if(localStorage.getItem(K)!=='0') document.body.classList.add('sb-collapsed'); }catch(e){}
      const t=document.getElementById('sidebarToggle');
      if(t) t.addEventListener('click',()=>{ const c=document.body.classList.toggle('sb-collapsed'); try{localStorage.setItem(K,c?'1':'0');}catch(e){} });
      document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeHelp(); });
    })();
    export function openHelp(){ document.getElementById('helpOverlay').classList.add('open'); }
    export function closeHelp(){ const h=document.getElementById('helpOverlay'); if(h) h.classList.remove('open'); }
/* ===== 4748-4812 ===== */
    export function formatLoginDate(value){
      if(!value) return 'Not available';
      const d=new Date(value);
      if(isNaN(d.getTime())) return 'Not available';
      return d.toLocaleString([], {dateStyle:'medium', timeStyle:'short'});
    }

    /* Show the signed-in Google account picture instead of the letter avatar.
       The URL comes from the ID token; if it is missing or fails to load we
       quietly fall back to the initial so the button is never blank. */
    export function applyProfilePhoto(){
      const pic = (getSession()?.picture || '').trim();
      [['profilePhoto','profileInitial'],['popupPhoto','popupInitial']].forEach(([imgId, initialId]) => {
        const img = $(imgId);
        const letter = $(initialId);
        if (!img) return;
        if (!pic) { img.hidden = true; img.removeAttribute('src'); if (letter) letter.hidden = false; return; }
        img.hidden = false;
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => { img.hidden = true; if (letter) letter.hidden = false; };
        if (img.getAttribute('src') !== pic) img.setAttribute('src', pic);
        if (letter) letter.hidden = true;
      });
    }

    export function updateProfilePopup(){
      const name = getSavedUserName() || $('profileName').textContent || 'User';
      const firstLogin = localStorage.getItem('auraFirstLogin');
      const lastLogin = localStorage.getItem('auraLastLogin');
      $('popupProfileName').textContent = name;
      const initial = (Array.from(name.trim())[0] || 'U').toLocaleUpperCase();
      ['profileInitial','popupInitial'].forEach(id => { const el = $(id); if(el) el.textContent = initial; });
      applyProfilePhoto();
      $('profileFirstLogin').textContent = formatLoginDate(firstLogin);
      $('profileLastLogin').textContent = formatLoginDate(lastLogin);
      $('profileTrackCount').textContent = `${state.songs.length} ${state.songs.length===1?'track':'tracks'}`;
      const favs = state.songs.filter(s=>s.favorite).length;
      $('profileFavoriteCount').textContent = `${favs} ${favs===1?'song':'songs'}`;
    }

    export function openNameModal(){
      const currentName = getSavedUserName() || $('profileName').textContent || '';
      $('nameModalInput').value = currentName;
      $('nameModal').classList.add('active');
      $('nameModal').setAttribute('aria-hidden','false');
      setTimeout(()=>{ $('nameModalInput').focus(); $('nameModalInput').select(); }, 60);
    }

    export function closeNameModal(){
      $('nameModal').classList.remove('active');
      $('nameModal').setAttribute('aria-hidden','true');
    }

    export function changeProfileName(){
      // Open the custom Aura Music modal instead of the browser prompt.
      $('profilePopover').classList.remove('active');
      $('profileBtn').setAttribute('aria-expanded', 'false');
      openNameModal();
    }

    $('nameModalCancel').onclick = closeNameModal;
    $('nameModal').onclick = (e) => { if(e.target === $('nameModal')) closeNameModal(); };
    $('nameModalInput').addEventListener('keydown', (e) => {
      if(e.key === 'Enter') $('nameModalSave').click();
      if(e.key === 'Escape') closeNameModal();
    });
    $('nameModalSave').onclick = () => {
      const n = normalizeUsername($('nameModalInput').value);
      if(!isValidUsername(n)){
        $('nameModalInput').focus();
        toast('3–20 characters — letters, numbers, spaces, _ or -, starting with a letter or number.', 'circle-exclamation');
        return;
      }

      // Change the profile name and re-tie it to the signed-in Google account.
      localStorage.setItem('auraUserName', n);
      const s = getSession();
      if(s){
        s.name = n;
        setSession(s);
        setProfileUsername(s.email, n);
      }
      $('displayUserName').textContent = n;
      $('profileName').textContent = n;
      $('popupProfileName').textContent = n;
      updateProfilePopup();
      closeNameModal();
      toast('Username updated', 'circle-check');
    };

