/* Boot hand-off. The intro splash in index.html is a fallback: it is revealed
   at parse time only on slow connections/devices, and otherwise waits for a
   budget that a fast boot never needs. `markAppReady()` is the other half — the
   first meaningful screen (home rails, or the welcome screen) is on screen, so
   the splash has nothing left to cover.

   The flag lives on <html> because the inline gate script reads it before any
   module has run, and `aura:ready` lets the loader leave without polling. */
export function markAppReady(reason: 'welcome' | 'cached' | 'catalog' | 'catalog-error'): void {
  const root = document.documentElement;
  if (root.dataset.auraReady === '1') return;
  root.dataset.auraReady = '1';
  root.dataset.auraReadyReason = reason;
  try { document.dispatchEvent(new Event('aura:ready')); } catch { /* old browsers */ }
}