/* Marquee titles: mini player + large player + large player top bar.
   - One line always; animates only when the text overflows.
   - translateX animation with distance/duration set via CSS variables.
   - Back-and-forth loop (~40px/s, pauses at each end), soft 16px edge fades.
   - Re-checks on song change, resize, font load and player open/close.
   - Respects prefers-reduced-motion (static text with ellipsis instead). */
(function(){
  const TITLE_IDS = ['currentTitle', 'fullTitle', 'fullHeaderTitle'];
  const SPEED = 40;   // px/s
  const GAP = 40;     // px between repeat
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const builtKey = new Map<string, string>();
  let raf = 0;
  let isInternalUpdate = false;

  function cleanTitleText(t: string | null | undefined): string {
    let s = String(t || '').replace(/\s+/g, ' ');
    /* fix stray spaces inside quoted sections: From  " Raayan " -> From "Raayan" */
    s = s.replace(/(["“”])([^"“”]+)\1/g, (m, q, inner) => q + inner.trim() + q);
    return s.trim();
  }

  function getRawTitle(el: HTMLElement): string {
    // If marquee already inserted multiple copies, get only the canonical single copy
    const copy = el.querySelector('.mq-copy');
    if (copy && copy.textContent) {
      return cleanTitleText(copy.textContent);
    }
    return cleanTitleText(el.textContent);
  }

  function refresh(titleId: string){
    const el = document.getElementById(titleId);
    if(!el) return;

    const text = getRawTitle(el);
    el.dataset.rawTitle = text;

    const visible = el.getClientRects().length > 0;
    const clientW = el.clientWidth;
    const key = `${titleId}|${text}|${visible ? Math.round(clientW) : 'hidden'}|${reduced.matches ? 'R' : 'M'}`;
    if(builtKey.get(titleId) === key) return;
    builtKey.set(titleId, key);

    el.classList.remove('mq-on');
    el.style.removeProperty('--mq-shift');
    el.style.removeProperty('--mq-dur');

    /* hidden element: leave as-is, re-evaluated when it becomes visible */
    if(!visible){ return; }

    if(!text){
      isInternalUpdate = true;
      try { el.textContent = ''; } finally { isInternalUpdate = false; }
      return;
    }

    if(reduced.matches){
      isInternalUpdate = true;
      try { el.textContent = text; } finally { isInternalUpdate = false; }
      return;
    }

    /* build the track, measure, then decide marquee vs static */
    const track = document.createElement('span');
    track.className = 'mq-track';
    const c0 = document.createElement('span');
    c0.className = 'mq-copy';
    c0.textContent = text;
    track.appendChild(c0);

    isInternalUpdate = true;
    try {
      el.replaceChildren(track);
    } finally {
      isInternalUpdate = false;
    }

    const vw = el.clientWidth;
    const cw = c0.getBoundingClientRect().width;
    if(cw <= vw + 1){
      isInternalUpdate = true;
      try {
        el.replaceChildren(document.createTextNode(text));
      } finally {
        isInternalUpdate = false;
      }
      return;
    }

    track.appendChild(c0.cloneNode(true));
    el.classList.add('mq-on');
    const dist = cw + GAP;
    el.style.setProperty('--mq-shift', `${-dist}px`);
    el.style.setProperty('--mq-dur', `${(dist / SPEED) + 3}s`);
  }

  function refreshAll(force = false){
    TITLE_IDS.forEach(id => {
      const el = document.getElementById(id);
      if(force && el) builtKey.delete(id);
      refresh(id);
    });
  }

  function schedule(){
    if(raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => refreshAll());
  }

  const mo = new MutationObserver(() => {
    if (isInternalUpdate) return;
    schedule();
  });

  TITLE_IDS.forEach(id => {
    const el = document.getElementById(id);
    if(el) mo.observe(el, { childList:true, characterData:true, subtree:true });
  });

  /* re-evaluate when the players open/close (widths go 0 <-> real) */
  ['miniPlayer', 'fullPlayerOverlay'].forEach(id => {
    const p = document.getElementById(id);
    if(p) mo.observe(p, { attributes:true, attributeFilter:['class'] });
  });

  window.addEventListener('resize', () => schedule());
  if(document.fonts && (document.fonts as any).ready){
    (document.fonts as any).ready.then(() => refreshAll(true)).catch(() => {});
  }
  refreshAll();
})();
