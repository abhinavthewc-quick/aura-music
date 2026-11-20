/* Global keyboard and focus behaviour.
 *
 * The app is a single page with several overlays that historically each
 * handled Escape (or did not handle it at all). This module centralises the
 * cross-cutting parts so every modal behaves the same:
 *
 *   - Escape closes the top-most visible overlay and nothing else;
 *   - Tab is trapped inside the visible dialog;
 *   - focus returns to whatever opened the dialog when it closes;
 *   - Enter/Space activates anything exposed with role="button" + tabindex.
 *
 * It deliberately works with the existing markup/classes instead of replacing
 * the open/close functions, so no feature logic changes.
 */

/* Highest layer first. The full player is hidden with a translate (not
   display/visibility), so geometry cannot be used to decide what is open —
   class/aria state is the source of truth. */
const OVERLAY_PRIORITY = [
  '#playlistPicker',
  '#playlistModal',
  '#trackSheetOverlay',
  '#nameModal',
  '#editTrackModal',
  '#effectsModal',
  '#settingsModal',
  '#helpOverlay',
  '#aboutModal',
  '#sideMenu',
  '#upNextSheet',
  '#fullPlayerOverlay',
  '#radioFullPlayerOverlay',
];

const CLOSE_BUTTONS: Record<string, string> = {
  '#playlistPicker': '[data-close-picker]',
  '#playlistModal': '#playlistCancelBtn',
  '#fullPlayerOverlay': '#closeFullPlayerBtn',
  '#radioFullPlayerOverlay': '#closeRadioFullPlayerBtn',
  '#upNextSheet': '#upNextCloseBtn',
  '#settingsModal': '#settingsCloseBtn',
  '#helpOverlay': '.help-close',
  '#aboutModal': '#aboutCloseBtn',
  '#effectsModal': '#effectsCloseBtn',
  '#nameModal': '#nameModalCancel',
};

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function isOverlayOpen(el: HTMLElement): boolean {
  if (el.id === 'helpOverlay') return el.classList.contains('open');
  if (el.id === 'sideMenu') return getComputedStyle(el).display !== 'none';
  return el.classList.contains('active');
}

/** The overlay a keyboard user is currently interacting with. */
function topOverlay(): HTMLElement | null {
  for (const selector of OVERLAY_PRIORITY) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && isOverlayOpen(el)) return el;
  }
  return null;
}

/** Dialog inside the top-most overlay (some overlays wrap a role=dialog). */
function topDialog(): HTMLElement | null {
  const overlay = topOverlay();
  if (!overlay) return null;
  if (overlay.matches('[aria-modal="true"]')) return overlay;
  return overlay.querySelector<HTMLElement>('[aria-modal="true"]');
}

function closeOverlay(el: HTMLElement): void {
  const selector = '#' + el.id;
  const closeSelector = CLOSE_BUTTONS[selector];
  if (closeSelector) {
    const btn = el.querySelector<HTMLElement>(closeSelector);
    if (btn) { btn.click(); return; }
  }
  if (selector === '#trackSheetOverlay' || selector === '#sideMenu') {
    // Both close through their backdrop click handler.
    el.click();
    return;
  }
  if (selector === '#editTrackModal') {
    const close = (window as any).closeEditModal;
    if (typeof close === 'function') { close(); return; }
  }
  el.classList.remove('active', 'open');
  el.setAttribute('aria-hidden', 'true');
}

/* ---------- focus restoration + initial focus ---------- */
let activeDialog: HTMLElement | null = null;
const dialogOrigins = new WeakMap<HTMLElement,HTMLElement | null>();
let latestLauncher: HTMLElement | null = null;
document.addEventListener('pointerdown',(event) => {
  latestLauncher = (event.target as Element | null)?.closest<HTMLElement>(FOCUSABLE) || null;
},true);
document.addEventListener('keydown',(event) => {
  if (event.key === 'Enter' || event.key === ' ') latestLauncher = (event.target as HTMLElement)?.closest<HTMLElement>(FOCUSABLE) || null;
},true);

function reachable(target: HTMLElement | null): boolean {
  if (!target?.isConnected || !isVisible(target) || target.closest('[hidden]')) return false;
  return OVERLAY_PRIORITY.every((selector) => {
    const overlay = document.querySelector<HTMLElement>(selector);
    return !overlay?.contains(target) || isOverlayOpen(overlay);
  });
}
function restoredTarget(origin: HTMLElement | null): HTMLElement | null {
  if (reachable(origin)) return origin;
  if (origin?.id) {
    const target = document.getElementById(origin.id);
    if (reachable(target)) return target;
  }
  if (origin && Object.keys(origin.dataset).length) {
    const target = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).find((element) =>
      Object.entries(origin.dataset).every(([key,value]) => element.dataset[key] === value) && reachable(element));
    if (target) return target;
  }
  const heading = document.querySelector<HTMLElement>('.tab-content.active h2,.tab-content.active h3');
  if (heading) { heading.tabIndex = -1; return heading; }
  return null;
}

function focusFirst(modal: HTMLElement): void {
  const items = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
  const target = items[0] || modal;
  if (target === modal && !modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
}

function syncDialog(): void {
  const modal = topDialog();
  if (modal !== activeDialog) {
    const previous = activeDialog, previousOrigin = previous ? dialogOrigins.get(previous) || null : null;
    activeDialog = modal;
    if (modal) {
      const returning = reachable(previousOrigin) && modal.contains(previousOrigin);
      if (!returning) {
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        let origin = focused && focused !== document.body && !modal.contains(focused) ? focused : latestLauncher;
        // Replacing a closed menu with a picker inherits the menu's real launcher,
        // not the now-hidden option button in that menu.
        if (previous && origin && previous.contains(origin) && !reachable(origin)) origin = previousOrigin;
        dialogOrigins.set(modal,origin);
      }
      requestAnimationFrame(() => {
        if (activeDialog !== modal) return;
        if (returning) previousOrigin.focus({preventScroll:true});
        else if (!modal.contains(document.activeElement)) focusFirst(modal);
      });
    } else {
      restoredTarget(previousOrigin)?.focus({preventScroll:true});
    }
  }

  for (const selector of OVERLAY_PRIORITY) {
    const overlay = document.querySelector<HTMLElement>(selector);
    if (overlay) overlay.inert = !isOverlayOpen(overlay);
  }

  /* Always run — this is independent of whether the active dialog changed.
     Done after focus restoration: hiding a subtree that still owns focus makes
     browsers refuse the aria-hidden update (and log a warning). */
  for (const selector of ['#fullPlayerOverlay', '#radioFullPlayerOverlay']) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const hidden = isOverlayOpen(el) ? 'false' : 'true';
    if (el.getAttribute('aria-hidden') !== hidden) el.setAttribute('aria-hidden', hidden);
  }
}

let dialogRaf = 0;
function scheduleDialogSync(): void {
  if (dialogRaf) return;
  dialogRaf = requestAnimationFrame(() => { dialogRaf = 0; syncDialog(); });
}

/* Watching every attribute change under <body> made this the app's busiest
   observer: playing a track flips classes and aria-hidden on dozens of nodes,
   and each batch queued a full pass over all 13 overlays (getComputedStyle per
   node, plus inert writes). Only a handful of elements decide what the top
   dialog is, so observe those directly — capped at one pass per frame, with a
   cheap early-out when the outlined set of open overlays has not changed. */
const OBSERVED_OVERLAYS = [...OVERLAY_PRIORITY, '#fullPlayerOverlay', '#radioFullPlayerOverlay']
  .filter((selector, index, all) => all.indexOf(selector) === index);
const observedNodes: HTMLElement[] = OBSERVED_OVERLAYS
  .map((selector) => document.querySelector<HTMLElement>(selector))
  .filter((el): el is HTMLElement => !!el);
let openSignature = '';
function overlaySignature(): string {
  let signature = '';
  const sideVisible = observedNodes.some((el) => el.id === 'sideMenu' && getComputedStyle(el).display !== 'none');
  for (const el of observedNodes) {
    const open = el.id === 'sideMenu'
      ? sideVisible
      : el.id === 'helpOverlay' ? el.classList.contains('open') : el.classList.contains('active');
    if (open) signature += el.id + ',';
  }
  return signature;
}
new MutationObserver(() => {
  const signature = overlaySignature();
  if (signature === openSignature) return;
  openSignature = signature;
  scheduleDialogSync();
}).observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'aria-hidden', 'hidden'],
});
syncDialog();
openSignature = overlaySignature();

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const overlay = topOverlay();
    if (!overlay) return;
    e.preventDefault();
    e.stopPropagation();
    closeOverlay(overlay);
    return;
  }

  if (e.key === 'Tab') {
    const modal = topDialog();
    if (!modal) return;
    const items = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && modal.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
    return;
  }

  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target as HTMLElement | null;
  if (!target || target.matches('button, a, input, select, textarea, summary')) return;
  const button = target.closest<HTMLElement>('[role="button"][tabindex], [role="button"][role]');
  if (!button || button !== target && target.closest('button, a')) return;
  if (!button.hasAttribute('tabindex')) return;
  e.preventDefault();
  button.click();
}, true);
