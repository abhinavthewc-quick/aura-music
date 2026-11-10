import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';

/* Run the real cyclic player/lyrics/queue modules in a fresh VM per test.
   Only browser surfaces and unrelated features are mocked. Timers, iframe
   events and pending promises are explicitly driven, with no network or audio. */
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = new Map<string, string>();

class Events {
  parent: Events | null = null;
  listeners = new Map<string, Array<(event: any) => void>>();
  [key: string]: any;
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== listener));
  }
  emit(type: string, values: Record<string, any> = {}) {
    const event = {
      target: this, type, bubbles: true, stopped: false, defaultPrevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; },
      ...values,
    };
    let current: Events | null = this;
    while (current) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(type) || []) listener(event);
      current['on' + type]?.(event);
      if (!event.bubbles || event.stopped) break;
      current = current.parent;
    }
    return event;
  }
}

class Style {
  [key: string]: any;
  setProperty(key: string, value: string) { this[key] = value; }
  removeProperty(key: string) { delete this[key]; }
}

/* A small tree/selector surface, not a layout engine. The browser companion
   covers actual DOM parsing, native media and the original inline controls. */
class Element extends Events {
  children: Element[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style = new Style();
  scrollTop = 0;
  private text = '';
  private html = '';
  constructor(public tagName = 'div') { super(); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value: string) { this.setAttribute('class', value); }
  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => tokens().includes(name),
      add: (...names: string[]) => { this.className = [...new Set([...tokens(), ...names])].join(' '); },
      remove: (...names: string[]) => { this.className = tokens().filter((name) => !names.includes(name)).join(' '); },
      toggle: (name: string, force = !tokens().includes(name)) => {
        if (force) this.classList.add(name); else this.classList.remove(name);
        return force;
      },
    };
  }
  setAttribute(name: string, value: any) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  appendChild(child: Element) {
    child.remove(); child.parent = this; this.children.push(child); return child;
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parent = null;
    this.children = []; this.text = ''; this.html = '';
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (this.parent instanceof Element) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  replaceWith(node: Element) {
    const parent = this.parent as Element;
    const index = parent.children.indexOf(this);
    node.remove(); node.parent = parent; parent.children[index] = node; this.parent = null;
  }
  contains(node: Element) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      let simple = part.trim();
      const not = /:not\(([^)]+)\)/.exec(simple);
      if (not) { if (this.matches(not[1])) return false; simple = simple.replace(not[0], ''); }
      for (const [, name, value] of simple.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
        if (value === undefined ? this.getAttribute(name) === null : this.getAttribute(name) !== value) return false;
      }
      simple = simple.replace(/\[[^\]]+\]/g, '');
      const id = /#([\w-]+)/.exec(simple);
      if (id && this.id !== id[1]) return false;
      for (const [, name] of simple.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      const tag = /^[\w-]+/.exec(simple);
      return !tag || tag[0].toLowerCase() === this.tagName;
    });
  }
  closest(selector: string): Element | null {
    if (this.matches(selector)) return this;
    return this.parent instanceof Element ? this.parent.closest(selector) : null;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = String(value); }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.replaceChildren(); this.html = value;
    const stack: Element[] = [this];
    for (const token of value.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack[stack.length - 1].text += token; continue; }
      const tag = /^<([\w-]+)/.exec(token)?.[1];
      if (!tag) continue;
      const child = new Element(tag.toLowerCase());
      for (const [, name, double, single, bare] of token.slice(tag.length + 1).matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        child.setAttribute(name, double ?? single ?? bare ?? '');
      }
      stack[stack.length - 1].appendChild(child);
      if (!['img', 'input', 'br', 'hr', 'meta', 'link'].includes(tag) && !token.endsWith('/>')) stack.push(child);
    }
  }
  getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 80 }; }
  scrollTo({ top }: { top: number }) { this.scrollTop = top; }
  click() { this.emit('click'); }
  focus() {}
}

class AudioElement extends Element {
  private time = 0;
  duration = 120;
  paused = true;
  ended = false;
  plays = 0;
  pauses = 0;
  loads = 0;
  playResults: Promise<void>[] = [];
  constructor() { super('audio'); }
  get src() { const raw = this.getAttribute('src'); return raw ? new URL(raw, 'https://fixture.invalid/').href : ''; }
  set src(value: string) { this.setAttribute('src', value || ''); this.currentTime = 0; this.paused = true; }
  get currentTime() { return this.time; }
  set currentTime(value: number) { this.time = value; this.ended = false; }
  load() { this.loads++; this.currentTime = 0; this.paused = true; }
  play() {
    this.plays++; this.paused = false;
    this.emit('play', { bubbles: false });
    return this.playResults.shift() || Promise.resolve();
  }
  pause() {
    this.pauses++;
    if (this.paused) return;
    this.paused = true; this.emit('pause', { bubbles: false });
  }
  end() { this.time = this.duration; this.ended = true; this.paused = true; this.emit('ended', { bubbles: false }); }
}

class Clock {
  now = 1000;
  next = 1;
  timers = new Map<number, { callback: () => void; at: number; delay: number }>();
  frames = new Map<number, (time: number) => void>();
  intervals = new Map<number, () => void>();
  setTimeout = (callback: () => void, delay = 0) => {
    const id = this.next++; this.timers.set(id, { callback, delay, at: this.now + delay }); return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  setInterval = (callback: () => void) => { const id = this.next++; this.intervals.set(id, callback); return id; };
  requestAnimationFrame = (callback: (time: number) => void) => { const id = this.next++; this.frames.set(id, callback); return id; };
  cancelAnimationFrame = (id: number) => { this.frames.delete(id); };
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.now = target;
  }
  frame() {
    this.now += 34;
    const frames = [...this.frames.values()]; this.frames.clear();
    for (const callback of frames) callback(this.now);
  }
  timer(delay: number) { return [...this.timers.values()].find((timer) => timer.delay === delay)?.callback; }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: any) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

export const AUDIO = { id: 'local-one', title: 'Library one', artist: 'Local artist', url: '/one.wav', img: '', isLocal: true };
export const AUDIO_TWO = { ...AUDIO, id: 'local-two', title: 'Library two', url: '/two.wav' };
export const VIDEO_A = { id: 'youtube-aaaaaaaaaaa', videoId: 'aaaaaaaaaaa', title: 'Retained A', artist: 'YouTube Music', url: '', img: '', isYouTube: true };
export const VIDEO_B = { ...VIDEO_A, id: 'youtube-bbbbbbbbbbb', videoId: 'bbbbbbbbbbb', title: 'Retained B' };
export const VIDEO_C = { ...VIDEO_A, id: 'youtube-ccccccccccc', videoId: 'ccccccccccc', title: 'Retained C' };
export const LYRICS = {
  isSynced: true, syncType: 'Line', provider: 'Fixture', lines: [
    { time: 5, text: 'First line' }, { time: 12, text: 'Second line' }, { time: 24, text: 'Third line' },
  ],
};

export function createPlaybackHarness({ delayedAPI = false } = {}) {
  const clock = new Clock();
  const mutationObservers: FixtureMutationObserver[] = [];
  class FixtureMutationObserver {
    targets = new Map<Element, { attributes?: boolean; attributeFilter?: string[] }>();
    constructor(public callback: (records: any[]) => void) { mutationObservers.push(this); }
    observe(target: Element, options: { attributes?: boolean; attributeFilter?: string[] }) { this.targets.set(target, options); }
    disconnect() { this.targets.clear(); }
  }
  // Deliver a queued attribute mutation only to observers registered for it.
  // Browser tests cover real microtask delivery and computed visibility.
  function notifyAttributeMutation(target: Element, attributeName: string) {
    for (const observer of mutationObservers) {
      const options = observer.targets.get(target);
      if (options?.attributes && (!options.attributeFilter || options.attributeFilter.includes(attributeName))) {
        observer.callback([{ type: 'attributes', target, attributeName }]);
      }
    }
  }
  const window = new Events();
  const document = new Element('document');
  document.parent = window;
  document.hidden = false; document.readyState = 'loading';
  document.head = document.appendChild(new Element('head'));
  document.body = document.appendChild(new Element('body'));
  document.createElement = (tag: string) => new Element(tag);
  document.getElementById = (id: string) => document.querySelector('#' + id);
  const $ = document.getElementById;
  const mount = (id: string, parent = document.body, tag = 'div') => {
    const node = new Element(tag); node.id = id; parent.appendChild(node); return node;
  };
  for (const id of [
    'currentImg', 'currentTitle', 'currentArtist', 'fullTitle', 'fullArtist', 'fullHeaderTitle',
    'fullLikeBtn', 'progressFill', 'fullSeekSlider', 'fullCurrentTime', 'fullDurationTime',
    'miniPlayer', 'playIcon', 'fullPlayIcon', 'playPauseBtn', 'fullPlayBtn', 'youtubeModeBadge',
    'closeFullPlayerBtn', 'tabLibrary', 'tabSearch', 'fullHeaderMenuBtn', 'fullPrevBtn', 'fullNextBtn',
    'nextBtn', 'trackSheetOverlay', 'upNextOpenBtn', 'upNextCloseBtn', 'ytmTabLyricsBtn',
    'ytmTabRelatedBtn', 'playerTabLyricsBtn', 'playerTabRelatedBtn', 'ytmRelatedPanel', 'ytmRelatedList',
    'blStatusText', 'blLyricsBackdrop', 'blAutoScrollBtn', 'blSyncOffsetLabel',
  ]) mount(id);
  const overlay = mount('fullPlayerOverlay');
  const art = mount('fullPlayerArt', overlay);
  art.innerHTML = '<img id="fullImg" alt=""><div class="ytm-art-overlay-tools"><button id="artInfoBtn" type="button"><i></i></button><button id="artLikeBtn" type="button"><i></i></button><button id="artShareBtn" type="button"><i></i></button></div>';
  const sheet = mount('upNextSheet');
  mount('upNextList', sheet);
  mount('upNextReorderHelp', sheet); mount('upNextReorderStatus', sheet);
  const lyricsPanel = mount('ytmLyricsPanel', sheet);
  mount('fullPlayerLyricsContainer', lyricsPanel);
  const audio = new AudioElement();
  const state = {
    audio, songs: [AUDIO, VIDEO_A, VIDEO_B, VIDEO_C, AUDIO_TWO].map((song) => ({ ...song })),
    currentIndex: 0, isPlaying: false, repeatMode: 'off', isShuffle: false,
    auraYTQueueIndex: -1, addedSongs: [], recentlyPlayed: [], radioIsPlaying: false,
  };
  const storage = new Map<string, string>();
  const mediaActions = new Map<string, () => void>();
  const toasts: string[] = [], trackSheets: any[] = [], shares: any[] = [];
  const escapeHtml = (value: any) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const radio = {
    currentRadioStation: null as any, radioAudio: new AudioElement(), escapeHtml,
    stopRadio() { radio.currentRadioStation = null; radio.radioAudio.pause(); state.radioIsPlaying = false; },
    updateRadioPlayerUI() {}, toggleRadioPlay() {},
  };
  const settings = { autoplayNext: true };
  const search = { auraYTQueue: [], extractYouTubeId: (meta: any) => meta.videoId || null, filterSearchTab() {} };
  const stubs: Record<string, any> = {
    'src/core/state.ts': { $, state, savedLikeMap: {}, persistLikedHistory() {} },
    'src/core/dom.ts': { escapeHtml, fmt: (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`, toast: (message: string) => toasts.push(message), showTrackSheet: (data: any) => trackSheets.push(data), copyToClipboard() {} },
    'src/features/ambience.ts': { auraMasterCtx: null, effectCtx: null },
    'src/features/library.ts': { addToRecent() {}, renderSongs() {}, updateLibCount() {}, updateLibNowPlaying() {}, renderLibrary() {} },
    'src/features/radio.ts': radio,
    'src/features/search.ts': search,
    'src/features/settings.ts': { auraSettings: settings },
  };
  const fetches: Array<{ url: string; resolve: (response: any) => void }> = [];
  const sandbox: Record<string, any> = {
    window, document, location: new URL('https://fixture.invalid/'), URL,
    navigator: { mediaSession: { setActionHandler: (name: string, handler: () => void) => mediaActions.set(name, handler) }, share: async (data: any) => { shares.push(data); } },
    MediaMetadata: class { constructor(data: any) { Object.assign(this, data); } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: any) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key) },
    Image: class {}, MutationObserver: FixtureMutationObserver,
    Date: class extends Date { static now() { return clock.now; } },
    performance: { now: () => clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: (id: number) => clock.intervals.delete(id),
    requestAnimationFrame: clock.requestAnimationFrame, cancelAnimationFrame: clock.cancelAnimationFrame,
    AbortSignal: { timeout: () => undefined },
    fetch: (url: string) => new Promise((resolve) => fetches.push({ url, resolve })),
    console: { warn() {}, error: console.error },
  };
  window.setTimeout = clock.setTimeout;
  window.matchMedia = () => ({ matches: false });
  const context = createContext(sandbox);
  const modules = new Map<string, any>();
  function load(file: string): any {
    const path = resolve(root, file);
    if (modules.has(path)) return modules.get(path).exports;
    const stub = stubs[path.slice(root.length)];
    if (stub) return stub;
    const module = { exports: {} };
    modules.set(path, module);
    if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(path, 'utf8'), {
      fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText);
    const run = new Script(`(function(require, module, exports) {\n${compiled.get(path)}\n})`, { filename: path }).runInContext(context);
    run((specifier: string) => {
      if (!specifier.startsWith('.')) throw new Error('Unexpected dependency: ' + specifier);
      return load(resolve(dirname(path), specifier.replace(/\.js$/, '') + '.ts'));
    }, module, module.exports);
    return module.exports;
  }
  const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const instances: FakeYouTubePlayer[] = [];
  class FakeYouTubePlayer {
    state = PlayerState.UNSTARTED;
    time = 0;
    duration = 120;
    plays = 0;
    pauses = 0;
    stops = 0;
    destroyed = false;
    seekThrows = false;
    stopEmitsEnded = false;
    seeks: number[] = [];
    iframe: Element;
    constructor(public host: Element, public options: any) {
      if (!(host instanceof Element)) throw new Error('Expected this selection’s actual host element');
      this.iframe = new Element('iframe'); this.iframe.id = host.id;
      host.replaceWith(this.iframe); instances.push(this);
    }
    ready() { this.options.events.onReady({ target: this }); }
    transition(state: number) { this.state = state; this.options.events.onStateChange({ target: this, data: state }); }
    error() { this.options.events.onError({ target: this, data: 100 }); }
    blocked() { this.options.events.onAutoplayBlocked({ target: this }); }
    getPlayerState() { return this.state; }
    getCurrentTime() { return this.time; }
    getDuration() { return this.duration; }
    playVideo() { this.plays++; }
    pauseVideo() { this.pauses++; }
    seekTo(time: number) { if (this.seekThrows) throw new Error('Iframe unavailable'); this.seeks.push(time); this.time = time; }
    stopVideo() { this.stops++; if (this.stopEmitsEnded) this.transition(PlayerState.ENDED); }
    destroy() { this.destroyed = true; this.iframe.remove(); }
  }
  function installYouTube() { sandbox.YT = window.YT = { Player: FakeYouTubePlayer, PlayerState }; }
  if (!delayedAPI) installYouTube();
  const player = load('src/features/player.ts');
  const lyrics = load('src/features/lyrics.ts');
  const queue = load('src/features/queue.ts');
  const intent = load('src/core/playbackIntent.ts');
  const room = load('src/rooms/roomFlag.ts');
  for (const song of state.songs) lyrics.lyricsCache.set(lyrics.getTrackKey(song.title, song.artist), structuredClone(LYRICS));
  return { player, lyrics, queue, intent, room, radio, settings, search, state, audio, $, window, document, clock, storage, mediaActions, toasts, trackSheets, shares, fetches, instances, PlayerState, installYouTube, notifyAttributeMutation };
}
