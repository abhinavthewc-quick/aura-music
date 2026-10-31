/* Discord presence bridge.
 *
 * Aura is a static SPA: there is no server an activity could ask "what is
 * playing". So the player mirrors its state into three shapes a browser
 * extension can read, in increasing order of capability:
 *
 *   1. #auraPresence — a hidden element whose data-* attributes are plain
 *      text. Any content script that shares the DOM can read it.
 *   2. window.auraPresence — the same snapshot as a plain object, for
 *      PreMiD's getPageVariable() (extension 2.5+).
 *   3. window.AuraPresence.getState() — a read API that extrapolates the
 *      current playback position, for PreMiD's execInPage() (2.14+).
 *
 * The reader lives in premid/websites/A/Aura Music/presence.ts. Nothing here
 * knows about Discord: it only publishes what the player is doing.
 */

export const PRESENCE_SCHEMA = 1;
export const PRESENCE_SITE = 'Aura Music';
export const PRESENCE_ELEMENT_ID = 'auraPresence';

export type PresenceKind = 'idle' | 'track' | 'radio';

export interface AuraPresenceState {
  /** Schema version — bump only when a field changes meaning. */
  v: number;
  site: string;
  kind: PresenceKind;
  title: string;
  artist: string;
  album: string;
  /** Absolute http(s) cover URL, or '' when the art is a data: placeholder. */
  cover: string;
  /** Canonical link to open for this item (site or YouTube watch page). */
  url: string;
  /** Deep link that opens and plays this exact item in Aura ('' if none). */
  link: string;
  videoId: string;
  /** Seconds; 0 when unknown or live (radio). */
  duration: number;
  /** Seconds at `updatedAt`. */
  position: number;
  playing: boolean;
  /** Live stream: no meaningful duration or progress. */
  live: boolean;
  /** Active app section, shown when nothing is playing. */
  tab: string;
  /** Epoch milliseconds of the last publish. */
  updatedAt: number;
}

function idleState(): AuraPresenceState {
  return {
    v: PRESENCE_SCHEMA,
    site: PRESENCE_SITE,
    kind: 'idle',
    title: '',
    artist: '',
    album: '',
    cover: '',
    url: '',
    link: '',
    videoId: '',
    duration: 0,
    position: 0,
    playing: false,
    live: false,
    tab: '',
    updatedAt: Date.now(),
  };
}

let current: AuraPresenceState = idleState();

/* Attribute names are written explicitly rather than through a key map so
   anyone inspecting the page (or writing another integration) can see exactly
   what is exposed without opening this file. */
function writeElement(el: HTMLElement, s: AuraPresenceState): void {
  el.setAttribute('data-v', String(s.v));
  el.setAttribute('data-site', s.site);
  el.setAttribute('data-kind', s.kind);
  el.setAttribute('data-title', s.title);
  el.setAttribute('data-artist', s.artist);
  el.setAttribute('data-album', s.album);
  el.setAttribute('data-cover', s.cover);
  el.setAttribute('data-url', s.url);
  el.setAttribute('data-link', s.link);
  el.setAttribute('data-video-id', s.videoId);
  el.setAttribute('data-duration', String(s.duration));
  el.setAttribute('data-position', String(s.position));
  el.setAttribute('data-playing', s.playing ? '1' : '0');
  el.setAttribute('data-live', s.live ? '1' : '0');
  el.setAttribute('data-tab', s.tab);
  el.setAttribute('data-updated-at', String(s.updatedAt));
}

function presenceElement(): HTMLElement {
  let el = document.getElementById(PRESENCE_ELEMENT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = PRESENCE_ELEMENT_ID;
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Position right now, derived from the last published sample. */
export function livePresenceState(): AuraPresenceState {
  const next = { ...current };
  if (next.playing && !next.live && next.duration > 0) {
    const elapsed = Math.max(0, (Date.now() - next.updatedAt) / 1000);
    next.position = Math.min(next.duration, next.position + elapsed);
  }
  next.position = round(Math.max(0, next.position));
  return next;
}

/** Publish a new snapshot. Called at most once a second by the reporter. */
export function publishPresence(patch: Partial<AuraPresenceState> = {}): void {
  current = {
    ...current,
    ...patch,
    v: PRESENCE_SCHEMA,
    site: PRESENCE_SITE,
    updatedAt: Date.now(),
  };
  current.duration = round(Math.max(0, Number(current.duration) || 0));
  current.position = round(Math.max(0, Number(current.position) || 0));

  writeElement(presenceElement(), current);

  /* The live object is replaced, not mutated, so a reader that grabbed the
     previous snapshot keeps a coherent view. */
  const api = (window as any).AuraPresence;
  if (api) api.version = PRESENCE_SCHEMA;
  (window as any).auraPresence = { ...current };
}

/** Create the DOM node + globals. Safe to call more than once. */
export function installPresence(): void {
  presenceElement();
  (window as any).AuraPresence = {
    version: PRESENCE_SCHEMA,
    site: PRESENCE_SITE,
    getState: livePresenceState,
  };
  (window as any).auraPresence = livePresenceState();
}
