import { copyToClipboard, escapeHtml, showTrackSheet, stateHTML, toast } from '../core/dom';
import {
  applyDynamicPlayerColor, cancelRadioForegroundResume, mediaSessionAction,
  setupMainMediaSession, stopPersonalPlaybackForRadio, updateMainMediaSession,
} from './player';
import { closeTrackMenu } from './queue';
import { $, state } from '../core/state';

export interface RadioStation {
  name: string;
  country: string;
  tags: string;
  favicon: string;
  homepage: string;
  url: string;
  url_resolved: string;
}

/* Radio is a separate live source. It never edits the personal collection,
 * cursor, queue or history, and never resumes merely because its tab opens. */
export const radioAudio = new Audio();
radioAudio.preload = 'none';
radioAudio.autoplay = false;
radioAudio.setAttribute('playsinline', '');
export const RADIO_STATE_KEY = 'auraRadioPlaybackState_v1';
export let currentRadioStation: RadioStation | null = null;
export let radioSearchToken = 0;
export let currentRadioQuery = 'top';
export { escapeHtml };

let radioRequest = 0;
let radioIntent = false;
let radioPlayPending = false;
let lastFailureRequest = -1;

/** Streams and websites must be explicit, credential-free HTTP(S) URLs. Validate
 * before changing any source so invalid input cannot stop currently playing music. */
function validRadioUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function stationFrom(value: unknown, streamOverride?: string): RadioStation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const stream = streamOverride ? validRadioUrl(streamOverride) : validRadioUrl(raw.url_resolved) || validRadioUrl(raw.url);
  if (!stream) return null;
  const text = (field: unknown, maximum: number): string => typeof field === 'string' ? field.trim().slice(0, maximum) : '';
  return {
    name: text(raw.name, 200) || 'Live radio station',
    country: text(raw.country, 100),
    tags: text(raw.tags, 500),
    favicon: validRadioUrl(raw.favicon) || '',
    homepage: validRadioUrl(raw.homepage) || '',
    url: stream,
    url_resolved: stream,
  };
}

function ownsRadioResource(station = currentRadioStation): boolean {
  if (!station || station !== currentRadioStation) return false;
  return (radioAudio.currentSrc || radioAudio.src) === station.url;
}

export function radioApiUrl(params: Record<string, string>): string {
  return `https://de1.api.radio-browser.info/json/stations/search?${new URLSearchParams(params)}`;
}

export async function loadRadioStations(query = 'top'): Promise<void> {
  currentRadioQuery = query || 'top';
  const token = ++radioSearchToken, list = $('radioStationList');
  if (!list) return;
  list.removeAttribute('role');
  list.innerHTML = stateHTML('loading', 'Finding stations…');
  try {
    const params: Record<string, string> = currentRadioQuery === 'top'
      ? { limit: '30', order: 'votes', reverse: 'true', hidebroken: 'true', is_https: 'true' }
      : { name: currentRadioQuery, limit: '30', order: 'votes', reverse: 'true', hidebroken: 'true', is_https: 'true' };
    const response = await fetch(radioApiUrl(params), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Radio directory unavailable');
    const body: unknown = await response.json();
    if (token !== radioSearchToken) return;
    if (!Array.isArray(body)) throw new Error('Invalid radio directory');
    const stations = body.map((raw) => stationFrom(raw)).filter((station): station is RadioStation => !!station).slice(0, 30);
    if (!stations.length) {
      list.innerHTML = stateHTML('noresults', 'No stations found', 'Try another search or enter a direct HTTP(S) stream URL below.');
      return;
    }
    list.setAttribute('role', 'list');
    list.innerHTML = stations.map((station, index) => {
      const name = escapeHtml(station.name), country = escapeHtml(station.country);
      const tags = escapeHtml(station.tags.split(',').filter(Boolean).slice(0, 2).join(' • '));
      const logo = station.favicon
        ? `<img src="${escapeHtml(station.favicon)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
        : '<i class="fa-solid fa-radio" aria-hidden="true"></i>';
      // The native Play button is the keyboard action. The wrapper is not a
      // custom button, so nested keyboard events cannot double-activate it.
      return `<div class="radio-station" role="listitem" data-radio-index="${index}">
        <div class="radio-station-art">${logo}</div>
        <div class="radio-station-main"><div class="radio-station-name">${name}</div><div class="radio-station-meta">${country}${country && tags ? ' • ' : ''}${tags || 'Live station'}</div></div>
        <button class="radio-play-btn" type="button" data-radio-stream="${escapeHtml(station.url)}" aria-label="Play ${name}" aria-pressed="false"><i class="fa-solid fa-play" aria-hidden="true"></i></button>
      </div>`;
    }).join('');
    list.querySelectorAll<HTMLElement>('[data-radio-index]').forEach((row, index) => {
      row.addEventListener('click', () => playRadioStation(stations[index]));
    });
    updateRadioPlayerUI();
  } catch {
    if (token !== radioSearchToken) return;
    list.removeAttribute('role');
    list.innerHTML = navigator.onLine
      ? stateHTML('error', 'Could not load stations', 'The radio directory did not respond. You can enter a direct stream URL below.', 'Try again', 'loadRadioStations(currentRadioQuery)')
      : stateHTML('offline', "You're offline", 'Connect to the internet to listen to live radio.', 'Try again', 'loadRadioStations(currentRadioQuery)');
  }
}

export function updateRadioPlayerUI(): void {
  const station = currentRadioStation;
  const playing = !!station && radioIntent && state.radioIsPlaying && !radioAudio.paused;
  // A caller outside this module cannot resurrect a canceled radio request by
  // writing an old promise's playing flag and asking the UI to refresh.
  state.radioIsPlaying = playing;
  const canPause = !!station && (radioPlayPending || playing);
  const live = $('radioLiveText');
  if (live) live.textContent = station ? `${radioPlayPending ? 'Connecting' : 'Live'} · ${station.name}` : 'Live';
  $('radioMiniPlayer')?.classList.toggle('active', !!station);
  $('radioNowPlaying')?.classList.toggle('active', !!station);
  const setText = (id: string, text: string) => { const element = $(id); if (element) element.textContent = text; };
  const tags = station?.tags.split(',').filter(Boolean) || [];
  setText('radioMiniName', station?.name || 'Live radio');
  setText('radioMiniMeta', station ? `${station.country || 'Live station'}${tags.length ? ` • ${tags.slice(0, 2).join(' • ')}` : ''}` : 'Live station');
  setText('radioNowName', station?.name || 'Live radio');
  setText('radioFullName', station?.name || 'Nothing playing');
  setText('radioFullMeta', station ? `${station.country || 'Live station'}${tags.length ? ` • ${tags.slice(0, 3).join(' • ')}` : ''}` : 'Live station');
  const logo = station?.favicon || '';
  if (station) applyDynamicPlayerColor(logo);
  for (const id of ['radioMiniArt', 'radioNowArt']) {
    const element = $(id);
    if (element) element.innerHTML = logo ? `<img src="${escapeHtml(logo)}" alt="" onerror="this.style.display='none'">` : '<i class="fa-solid fa-radio" aria-hidden="true"></i>';
  }
  const cover = $('radioVinylCover') as HTMLImageElement | null;
  if (cover) cover.src = logo;
  const miniButton = $('radioMiniPlayBtn');
  if (miniButton) miniButton.innerHTML = `<i class="fa-solid fa-${canPause ? 'pause' : 'play'}" aria-hidden="true"></i>`;
  const fullIcon = $('radioFullPlayIcon');
  if (fullIcon) fullIcon.className = `fa-solid fa-${canPause ? 'pause' : 'play'}`;
  for (const id of ['radioMiniPlayBtn', 'radioFullPlayBtn']) {
    $(id)?.setAttribute('aria-label', canPause ? 'Pause radio' : 'Play radio');
    $(id)?.setAttribute('aria-busy', String(radioPlayPending));
  }
  $('radioVinylRecord')?.classList.toggle('spinning', playing);
  document.querySelectorAll<HTMLElement>('.radio-play-btn').forEach((button) => {
    const active = playing && button.dataset.radioStream === station?.url;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.innerHTML = `<i class="fa-solid fa-${active ? 'volume-high' : 'play'}" aria-hidden="true"></i>`;
  });
  updateRadioMediaSession();
}

function radioFailure(request: number, station: RadioStation, error?: unknown): void {
  if (request !== radioRequest || station !== currentRadioStation || !ownsRadioResource(station)) return;
  radioIntent = false;
  radioPlayPending = false;
  state.radioIsPlaying = false;
  cancelRadioForegroundResume();
  radioAudio.pause();
  saveRadioState();
  updateRadioPlayerUI();
  if (lastFailureRequest === request) return;
  lastFailureRequest = request;
  const name = error && typeof error === 'object' ? (error as { name?: string }).name : '';
  if (name === 'AbortError') return;
  toast(name === 'NotAllowedError'
    ? 'Press Play radio to allow this stream in your browser.'
    : 'This station could not be played. Check the stream URL or choose another station.', 'triangle-exclamation');
}

function requestRadioPlay(): void {
  const station = currentRadioStation;
  if (!station || radioAudio.src !== station.url) return;
  const request = ++radioRequest;
  radioIntent = true;
  radioPlayPending = true;
  state.radioIsPlaying = false;
  setupRadioMediaSession();
  updateRadioPlayerUI();
  saveRadioState();
  try {
    void radioAudio.play().then(() => {
      if (request !== radioRequest || station !== currentRadioStation || !radioIntent || !ownsRadioResource(station)) return;
      radioPlayPending = false;
      state.radioIsPlaying = !radioAudio.paused;
      saveRadioState();
      updateRadioPlayerUI();
    }).catch((error) => radioFailure(request, station, error));
  } catch (error) { radioFailure(request, station, error); }
}

export function pauseRadioPlayback(): void {
  ++radioRequest;
  radioIntent = false;
  radioPlayPending = false;
  cancelRadioForegroundResume();
  radioAudio.pause();
  state.radioIsPlaying = false;
  saveRadioState();
  updateRadioPlayerUI();
}

/** Foreground recovery uses the same station/request guard. Explicit Pause or
 * Stop clears intent, so even an already-scheduled recovery cannot resume it. */
export function resumeRadioAfterForeground(): void {
  if (radioIntent && currentRadioStation && radioAudio.paused) requestRadioPlay();
}

export function toggleRadioPlay(): void {
  if (!currentRadioStation) return;
  if (radioPlayPending || !radioAudio.paused) pauseRadioPlayback();
  else requestRadioPlay();
}

export function playRadioStation(value: unknown): boolean {
  const station = stationFrom(value);
  if (!station) { toast('Enter a valid HTTP(S) radio stream URL.', 'triangle-exclamation'); return false; }
  ++radioRequest;
  radioIntent = false;
  radioPlayPending = false;
  cancelRadioForegroundResume();
  stopPersonalPlaybackForRadio();
  radioAudio.pause();
  currentRadioStation = station;
  radioAudio.src = station.url;
  radioAudio.load();
  $('miniPlayer')?.classList.remove('active');
  $('fullPlayerOverlay')?.classList.remove('active');
  requestRadioPlay();
  return true;
}

export function playCustomRadio(): boolean {
  const input = $('customRadioUrl') as HTMLInputElement | null;
  return playRadioStation({ name: 'Custom radio station', country: 'Custom stream', tags: '', favicon: '', homepage: '', url: input?.value || '' });
}

export function stopRadio(): void {
  const ownedRadio = !!currentRadioStation;
  ++radioRequest;
  radioIntent = false;
  radioPlayPending = false;
  cancelRadioForegroundResume();
  currentRadioStation = null;
  radioAudio.pause();
  radioAudio.removeAttribute('src');
  radioAudio.load();
  state.radioIsPlaying = false;
  try { localStorage.removeItem(RADIO_STATE_KEY); } catch { /* optional playback memory */ }
  closeRadioFullPlayer();
  updateRadioPlayerUI();
  if (ownedRadio) {
    if (state.activeTrack || state.playbackContext) $('miniPlayer')?.classList.add('active');
    applyDynamicPlayerColor(state.activeTrack?.img || '');
  }
  setupMainMediaSession();
  updateMainMediaSession();
}

export function saveRadioState(url?: string): void {
  const station = currentRadioStation;
  if (!station) return;
  const stream = validRadioUrl(url || station.url);
  if (!stream || stream !== station.url) return;
  try {
    localStorage.setItem(RADIO_STATE_KEY, JSON.stringify({
      url: stream, station, playing: state.radioIsPlaying && !radioAudio.paused, savedAt: Date.now(),
    }));
  } catch { /* browser playback memory is optional; never claim it was saved */ }
}

export function restoreRadioState(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(RADIO_STATE_KEY) || 'null');
    if (!saved) return;
    const stream = validRadioUrl(saved.url), station = stream ? stationFrom(saved.station, stream) : null;
    if (!station) { localStorage.removeItem(RADIO_STATE_KEY); return; }
    const request = ++radioRequest;
    radioIntent = false;
    radioPlayPending = false;
    currentRadioStation = station;
    state.radioIsPlaying = false;
    radioAudio.src = station.url;
    // During initial circular-module evaluation, the player's color and intent
    // variables are not initialized yet. Defer UI work, never autoplay a reload.
    queueMicrotask(() => {
      if (request !== radioRequest || currentRadioStation !== station) return;
      cancelRadioForegroundResume();
      setupRadioMediaSession();
      updateRadioPlayerUI();
    });
  } catch {
    try { localStorage.removeItem(RADIO_STATE_KEY); } catch { /* storage unavailable */ }
  }
}

export function setupRadioMediaSession(): void {
  if (!('mediaSession' in navigator) || !currentRadioStation) return;
  mediaSessionAction('play', requestRadioPlay);
  mediaSessionAction('pause', pauseRadioPlayback);
  mediaSessionAction('stop', stopRadio);
  for (const action of ['nexttrack', 'previoustrack', 'seekto', 'seekforward', 'seekbackward']) mediaSessionAction(action, null);
  try { navigator.mediaSession.setPositionState?.(); } catch { /* nonseekable live source */ }
  updateRadioMediaSession();
}

export function updateRadioMediaSession(): void {
  if (!('mediaSession' in navigator) || !currentRadioStation) return;
  const station = currentRadioStation;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: station.name, artist: station.country || 'Aura Music Radio', album: 'Aura Music · Live radio',
      artwork: station.favicon ? [{ src: station.favicon }] : [],
    });
    navigator.mediaSession.playbackState = state.radioIsPlaying && !radioAudio.paused ? 'playing' : 'paused';
    navigator.mediaSession.setPositionState?.();
  } catch { /* unsupported Media Session metadata */ }
}

radioAudio.addEventListener('playing', () => {
  if (!ownsRadioResource()) return;
  if (!radioIntent) { radioAudio.pause(); state.radioIsPlaying = false; updateRadioPlayerUI(); return; }
  radioPlayPending = false;
  state.radioIsPlaying = true;
  saveRadioState();
  updateRadioPlayerUI();
});
radioAudio.addEventListener('pause', () => {
  if (!currentRadioStation || !radioAudio.paused) return;
  radioPlayPending = false;
  state.radioIsPlaying = false;
  saveRadioState();
  updateRadioPlayerUI();
});
radioAudio.addEventListener('ended', () => {
  if (!ownsRadioResource() || !radioAudio.ended) return;
  ++radioRequest;
  radioIntent = false;
  radioPlayPending = false;
  state.radioIsPlaying = false;
  cancelRadioForegroundResume();
  saveRadioState();
  updateRadioPlayerUI();
});
radioAudio.addEventListener('error', () => {
  const station = currentRadioStation;
  // load() resets error; a queued event from the old resource must not cancel a
  // newly selected station just because the shared Audio instance dispatched it.
  if (station && (radioIntent || radioPlayPending || state.radioIsPlaying) && radioAudio.error && ownsRadioResource(station)) radioFailure(radioRequest, station, radioAudio.error);
});

export function openRadioFullPlayer(): void {
  if (!currentRadioStation) { toast('Choose a radio station first.', 'circle-info'); return; }
  const overlay = $('radioFullPlayerOverlay');
  overlay?.classList.add('active');
  overlay?.setAttribute('aria-hidden', 'false');
  updateRadioPlayerUI();
}
export function closeRadioFullPlayer(): void {
  const overlay = $('radioFullPlayerOverlay');
  overlay?.classList.remove('active');
  overlay?.setAttribute('aria-hidden', 'true');
}
export function closeRadioSheetThen(fn: () => void): void { closeTrackMenu(); fn?.(); }

export function openRadioMenu(): void {
  const station = currentRadioStation;
  if (!station) return;
  const actions: Array<[string, string, string, () => void]> = [
    ['toggle', radioAudio.paused && !radioPlayPending ? 'fa-solid fa-play' : 'fa-solid fa-pause', radioAudio.paused && !radioPlayPending ? 'Play radio' : 'Pause radio', toggleRadioPlay],
    ['share', 'fa-solid fa-share-nodes', 'Share station', () => { void radioMenuShare(); }],
    ['copy', 'fa-solid fa-link', 'Copy stream link', radioMenuCopy],
  ];
  if (station.homepage) actions.push(['website', 'fa-solid fa-arrow-up-right-from-square', 'Open station website', radioMenuSite]);
  actions.push(['stop', 'fa-solid fa-stop', 'Stop radio', stopRadio]);
  const rows = actions.map(([key, icon, label]) => `<button type="button" class="track-sheet-row" data-radio-action="${key}"><i class="${icon}" aria-hidden="true"></i>${label}</button>`).join('');
  showTrackSheet({ img: station.favicon, title: station.name, artist: station.country || 'Live radio', rowsHtml: rows });
  for (const [key, , , action] of actions) {
    $('trackSheetRows')?.querySelector<HTMLElement>(`[data-radio-action="${key}"]`)?.addEventListener('click', () => {
      closeTrackMenu();
      if (currentRadioStation === station) action();
    });
  }
}

export async function radioMenuShare(): Promise<void> {
  const station = currentRadioStation;
  if (!station) return;
  const url = validRadioUrl(station.homepage) || validRadioUrl(station.url);
  if (!url) return;
  if (navigator.share) {
    try { await navigator.share({ title: station.name, text: `Listening to ${station.name} on Aura Music`, url }); return; }
    catch (error) { if ((error as Error)?.name === 'AbortError') return; }
  }
  const stream = validRadioUrl(station.url);
  if (stream) copyToClipboard(stream, 'Stream link copied');
}
export function radioMenuCopy(): void {
  const url = validRadioUrl(currentRadioStation?.url);
  if (url) copyToClipboard(url, 'Stream link copied');
}
export function radioMenuSite(): void {
  const url = validRadioUrl(currentRadioStation?.homepage);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

$('radioSearchBtn')?.addEventListener('click', () => {
  const query = ($('radioSearchInput') as HTMLInputElement | null)?.value.trim();
  void loadRadioStations(query || currentRadioQuery);
});
$('radioSearchInput')?.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void loadRadioStations((event.target as HTMLInputElement).value.trim() || 'top');
});
document.querySelectorAll<HTMLElement>('.radio-chip').forEach((chip) => chip.addEventListener('click', () => {
  document.querySelectorAll('.radio-chip').forEach((other) => other.classList.remove('active'));
  chip.classList.add('active');
  ($('radioSearchInput') as HTMLInputElement).value = '';
  void loadRadioStations(chip.dataset.radioQuery || 'top');
}));
$('radioStopBtn')?.addEventListener('click', stopRadio);
$('customRadioPlayBtn')?.addEventListener('click', playCustomRadio);
$('customRadioUrl')?.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') playCustomRadio(); });
$('radioMiniPlayer')?.addEventListener('click', (event) => { if (!(event.target as HTMLElement).closest('button, input, a')) openRadioFullPlayer(); });
$('radioMiniPlayBtn')?.addEventListener('click', (event) => { event.stopPropagation(); toggleRadioPlay(); });
$('radioMiniStopBtn')?.addEventListener('click', (event) => { event.stopPropagation(); stopRadio(); });
$('radioFullPlayBtn')?.addEventListener('click', toggleRadioPlay);
$('radioFullStopBtn')?.addEventListener('click', stopRadio);
$('radioFullCloseBtn')?.addEventListener('click', closeRadioFullPlayer);
$('closeRadioFullPlayerBtn')?.addEventListener('click', closeRadioFullPlayer);
$('radioHeaderMenuBtn')?.addEventListener('click', openRadioMenu);
restoreRadioState();
