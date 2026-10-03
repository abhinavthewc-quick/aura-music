import { $ } from './state';
/* ===== 2942-2954 ===== */
    export function fmt(sec){
      if(!sec || !isFinite(sec) || sec < 0) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    /* ---------- Adaptive player color (from cover art) ----------
       Samples the current track's cover image on a small canvas and washes
       the full-player background with that color, Spotify/Apple-Music
       style. Best-effort: if the image host doesn't allow canvas pixel
       reads (no CORS headers), it just quietly falls back to the app's
       normal background — nothing breaks either way. */
/* ===== 2995-3005 ===== */
    /* Toast Notifications */
    export function toast(msg, icon='circle-check'){
      const c = $('toastContainer');
      const t = document.createElement('div');
      t.className='toast';
      t.innerHTML=`<i class="fa-solid fa-${icon}"></i><span>${msg}</span>`;
      c.appendChild(t);
      requestAnimationFrame(()=>t.classList.add('show'));
      setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); },2500);
    }

/* ===== 3038-3056 ===== */
    /* Time-of-day greeting */

    /* ===== Shared helpers (consolidated) ===== */
    export function timeGreeting(){ const h=new Date().getHours(); return h<12?'Good morning':h<18?'Good afternoon':'Good evening'; }
    export function getSavedUserName(){ try{ return (localStorage.getItem('auraUserName')||'').trim(); }catch(e){ return ''; } }
    /* Normalized grouping key so "A. R. Rahman", "A.R. Rahman" and
       "a. r. rahman - Topic" all land in one artist bucket. */
    export function artistKey(name){
      return (name||'').replace(/\s*-\s*Topic$/i,'').replace(/＜[^＞]*＞/g,'').replace(/\.\s*/g,'.').toLowerCase().replace(/\s{2,}/g,' ').trim();
    }
    /* Same artist, different spelling — "Ravichander"/"Ravichandran",
       "Jackson 5"/"The Jacksons". Metadata comes from two places (manifest vs
       filename) and either can carry a typo or a missing article, which used to
       split one artist into two rows. Merges on: article-insensitive equality,
       or a small edit distance between long names sharing a prefix. */
    function editWithin(a,b,max){
      if(a===b) return 0;
      if(Math.abs(a.length-b.length)>max) return max+1;
      let prev=Array.from({length:b.length+1},(_,i)=>i);
      for(let i=1;i<=a.length;i++){
        const cur=[i];
        let best=i;
        for(let j=1;j<=b.length;j++){
          const v=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
          cur.push(v); if(v<best) best=v;
        }
        if(best>max) return max+1;
        prev=cur;
      }
      return prev[b.length];
    }
    export function artistMergeKey(existing,name){
      const key=artistKey(name);
      const bare=key.replace(/^the\s+/,'');
      for(const k of existing){
        if(k===key) return k;
        const other=k.replace(/^the\s+/,'');
        if(!other || !bare) continue;
        if(other===bare) return k;                                   // article only
        if(other.length<6 || bare.length<6) continue;
        if(other.slice(0,3)!==bare.slice(0,3)) continue;             // different artist
        if(editWithin(other,bare,3)<=3) return k;                    // typo-level difference
      }
      return key;
    }
    export async function fetchYouTubeMeta(videoId){
      let title='YouTube Track', artist='YouTube Music';
      try{
        const res=await fetch('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent('https://www.youtube.com/watch?v='+videoId));
        if(res.ok){ const d=await res.json(); title=d.title||title; artist=d.author_name||artist; }
      }catch(e){ /* keep defaults */ }
      return {title,artist};
    }
    export function copyToClipboard(text,okMsg){
      const ok=()=>toast(okMsg||'Copied','circle-check'), fail=()=>toast('Could not copy','triangle-exclamation');
      if(navigator.clipboard&&navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(ok).catch(fail);
      try{ const t=document.createElement('textarea'); t.value=text; document.body.appendChild(t); t.select(); const done=document.execCommand('copy'); t.remove(); done?ok():fail(); }catch(e){ fail(); }
      return Promise.resolve();
    }
/* ===== 3058-3072 ===== */
    export function showTrackSheet({img,title,artist,rowsHtml}){
      const im=$('trackSheetImg'); im.onerror=function(){ this.removeAttribute('src'); };
      if(img) im.src=img; else im.removeAttribute('src');
      $('trackSheetTitle').textContent=title||''; $('trackSheetArtist').textContent=artist||'';
      $('trackSheetRows').innerHTML=rowsHtml; $('trackSheetOverlay').classList.add('active');
    }
    /* One consistent design for every state: empty / loading / error / offline / slow / no results / denied / success */
    export function stateHTML(kind,title,sub?,btnLabel?,btnJs?){
      const icons={empty:'fa-music',loading:'fa-spinner fa-spin',error:'fa-triangle-exclamation',offline:'fa-wifi',slow:'fa-hourglass-half',noresults:'fa-magnifying-glass',denied:'fa-lock',success:'fa-circle-check'};
      const iconHtml = kind==='loading'
        ? '<div class="aura-state-orb"><canvas class="aura-orb-mini" aria-hidden="true"></canvas></div>'
        : `<div class="aura-state-icon"><i class="fa-solid ${icons[kind]||icons.empty}"></i></div>`;
      if(kind==='loading' && window.AuraOrb) requestAnimationFrame(()=>window.AuraOrb.mountAll());
      return `<div class="aura-state aura-state-${kind}" role="status">${iconHtml}<b>${title}</b>${sub?`<p>${sub}</p>`:''}${btnLabel?`<button type="button" class="aura-state-btn" onclick="${btnJs}">${btnLabel}</button>`:''}</div>`;
    }
