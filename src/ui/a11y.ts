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
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function browserOwnsModalFocus(): boolean {
  try { return document.querySelector('dialog:modal') !== null; }
  catch { return false; }
}

function hasDockedPlayer(): boolean {
  return matchMedia('(min-width:900px)').matches &&
    Boolean(document.getElementById('fullPlayerOverlay')?.classList.contains('active'));
}

function isOverlayOpen(el: HTMLElement): boolean {
  if (el.id === 'helpOverlay') return el.classList.contains('open');
  if (el.id === 'sideMenu') return getComputedStyle(el).display !== 'none';
  return el.classList.contains('active');
}

/** The overlay a keyboard user is currently interacting with. */
function topOverlay(): HTMLElement | null {
  for (const selector of OVERLAY_PRIORITY) {
    // On desktop the companion panel and transport strip are part of one
    // player workspace, rather than a second modal on top of the artwork.
    if (selector === '#upNextSheet' && hasDockedPlayer()) continue;
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

function dialogRoots(modal: HTMLElement): HTMLElement[] {
  if (modal.id !== 'fullPlayerOverlay' || !hasDockedPlayer()) return [modal];
  return [modal, document.getElementById('upNextSheet'), document.getElementById('miniPlayer')]
    .filter((el): el is HTMLElement => Boolean(el));
}

function focusableItems(modal: HTMLElement): HTMLElement[] {
  return dialogRoots(modal).flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))).filter(isVisible);
}

function containsFocus(modal: HTMLElement, target: HTMLElement): boolean {
  return dialogRoots(modal).some(root => root.contains(target));
}

/** Background navigation must respect every root of the active workspace. */
export function activeDialogOwnsFocus(): boolean {
  if (browserOwnsModalFocus()) return true;
  const modal = topDialog();
  const target = document.activeElement;
  return Boolean(modal && target instanceof HTMLElement && containsFocus(modal, target));
}

function syncPlayerSemantics(includeClosed: boolean): void {
  const docked = hasDockedPlayer();
  const full = document.getElementById('fullPlayerOverlay');
  if (full) {
    if (docked) full.setAttribute('aria-owns', 'upNextSheet miniPlayer');
    else full.removeAttribute('aria-owns');
  }
  const sheet = document.getElementById('upNextSheet');
  if (sheet) {
    sheet.setAttribute('role', docked ? 'region' : 'dialog');
    if (docked) sheet.removeAttribute('aria-modal');
    else sheet.setAttribute('aria-modal', 'true');
  }
  for (const id of ['fullPlayerOverlay', 'radioFullPlayerOverlay', 'upNextSheet']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const open = isOverlayOpen(el) || (id === 'upNextSheet' && docked);
    if (!open && !includeClosed) continue;
    const hidden = String(!open);
    if (el.getAttribute('aria-hidden') !== hidden) el.setAttribute('aria-hidden', hidden);
  }
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
interface DialogFocus { modal: HTMLElement; opener: HTMLElement | null }
let dialogStack: DialogFocus[] = [];

function focusFirst(modal: HTMLElement): void {
  const items = focusableItems(modal);
  const target = items[0] || modal;
  if (target === modal && !modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
}

function syncDialog(): void {
  // Expose newly opened controls before selecting a focus target. Closed
  // surfaces are hidden only after focus has left them.
  syncPlayerSemantics(false);
  // Native dialogs own their focus trap and restore their opener. Moving focus
  // into an older custom overlay here would fight the browser's top layer.
  if (browserOwnsModalFocus()) { syncPlayerSemantics(true); return; }
  const modal = topDialog();
  if (modal !== (dialogStack[dialogStack.length - 1]?.modal || null)) {
    const resume = dialogStack.findIndex(frame => frame.modal === modal);
    let restore: HTMLElement | null = null;
    if (resume >= 0) {
      restore = dialogStack[resume + 1]?.opener || null;
      dialogStack.splice(resume + 1);
    } else if (modal) {
      const current = document.activeElement;
      let opener = current instanceof HTMLElement && current !== document.body ? current : null;
      const openDialogs = new Set(OVERLAY_PRIORITY.map(selector => {
        const overlay = document.querySelector<HTMLElement>(selector);
        if (!overlay || !isOverlayOpen(overlay)) return null;
        return overlay.matches('[aria-modal="true"]') ? overlay : overlay.querySelector<HTMLElement>('[aria-modal="true"]');
      }));
      // A picker can replace a track menu in the same turn. Carry the menu's
      // original opener forward instead of retaining a hidden menu action.
      for (const frame of [...dialogStack].reverse()) {
        if (!openDialogs.has(frame.modal) && (!opener || containsFocus(frame.modal, opener))) opener = frame.opener;
      }
      dialogStack = dialogStack.filter(frame => openDialogs.has(frame.modal));
      dialogStack.push({ modal, opener });
    } else {
      restore = dialogStack[0]?.opener || null;
      dialogStack = [];
    }
    if (restore?.isConnected && isVisible(restore) && (!modal || containsFocus(modal, restore))) {
      restore.focus({ preventScroll: true });
    } else if (modal) focusFirst(modal);
    else if (document.activeElement instanceof HTMLElement && !isVisible(document.activeElement)) document.activeElement.blur();
  }
  syncPlayerSemantics(true);
}

let dialogRaf = 0;
function scheduleDialogSync(): void {
  if (dialogRaf) return;
  dialogRaf = requestAnimationFrame(() => { dialogRaf = 0; syncDialog(); });
}

new MutationObserver(scheduleDialogSync).observe(document.body, {
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'aria-hidden', 'hidden', 'open'],
});
const sideMenu = document.getElementById('sideMenu');
if (sideMenu) new MutationObserver(scheduleDialogSync).observe(sideMenu, { attributes: true, attributeFilter: ['style'] });
matchMedia('(min-width:900px)').addEventListener('change', scheduleDialogSync);
scheduleDialogSync();

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (browserOwnsModalFocus()) {
    // Keep legacy Escape handlers from closing dialogs underneath the native
    // one; its default cancel action still runs because it is not prevented.
    if (e.key === 'Escape') e.stopPropagation();
    return;
  }
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
    const items = focusableItems(modal);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && containsFocus(modal, active);
    if (dialogRoots(modal).length > 1) {
      // These visually adjacent controls live in separate DOM branches. Follow
      // the same order as aria-owns instead of tabbing into the obscured app.
      const index = items.indexOf(active as HTMLElement);
      const next = index < 0 ? (e.shiftKey ? items.length - 1 : 0)
        : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      e.preventDefault();
      items[next].focus();
      return;
    }
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
  if (!button.hasAttribute('tabindex') || button.getAttribute('aria-disabled') === 'true') return;
  e.preventDefault();
  button.click();
}, true);
