import { copyToClipboard, escapeHtml, showTrackSheet, stateHTML, toast } from '../core/dom';
import { beginPlaybackIntent, getPlaybackIntent } from '../core/playbackIntent';
import {
  applyDynamicPlayerColor, cancelRadioForegroundResume, mediaSessionAction,
  setupMainMediaSession, stopPersonalPlaybackForRadio, updateMainMediaSession,
} from './player';
import { closeTrackMenu } from './queue';
import { $, state } from '../core/state';
import { roomModeActive } from '../rooms/roomFlag';

export interface RadioStation {
  name: string;
  country: string;
  tags: string;
  favicon: string;
  homepage: string;
  url: string;
  url_resolved: string;
}

// Live radio owns a separate transport; opening its tab never starts playback.
export const radioAudio = new Audio();
radioAudio.preload = 'none';
radioAudio.autoplay = false;
radioAudio.setAttribute('playsinline', '');
export const RADIO_STATE_KEY = 'auraRadioPlaybackState_v1';
export let currentRadioStation: RadioStation | null = null;
export let radioSearchToken = 0;
export let currentRadioQuery = 'top';
export { escapeHtml };
let radioRequest = 0, radioPlaybackIntent = 0;
let radioIntent = false, radioPlayPending = false;
let lastFailureRequest = -1;

function validRadioUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function stationFrom(value: unknown, streamOverride?: string): RadioStation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const stream = streamOverride ? validRadioUrl(streamOverride) : validRadioUrl(raw.url_resolved) || validRadioUrl(raw.url);
  if (!stream) return null;
  const text = (field: unknown, maximum: number) => typeof field === 'string' ? field.trim().slice(0, maximum) : '';
  return {
    name: text(raw.name, 200) || 'Live radio station', country: text(raw.country, 100), tags: text(raw.tags, 500),
    favicon: validRadioUrl(raw.favicon) || '', homepage: validRadioUrl(raw.homepage) || '', url: stream, url_resolved: stream,
  };
}
function ownsRadioResource(station = currentRadioStation): boolean {
  return !!station && station === currentRadioStation && !roomModeActive() &&
    radioPlaybackIntent === getPlaybackIntent() && (radioAudio.currentSrc || radioAudio.src) === station.url;
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
    const params = currentRadioQuery === 'top'
      ? { limit: '30', order: 'votes', reverse: 'true', hidebroken: 'true', is_https: 'true' }
      : { name: currentRadioQuery, limit: '30', order: 'votes', reverse: 'true', hidebroken: 'true', is_https: 'true' };
    const response = await fetch(radioApiUrl(params), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Radio directory unavailable');
    const body: unknown = await response.json();
    if (token !== radioSearchToken) return;
    if (!Array.isArray(body)) throw new Error('Invalid radio directory');
    const stations = body.map(raw => stationFrom(raw)).filter((station): station is RadioStation => !!station).slice(0, 30);
    if (!stations.length) {
      list.innerHTML = stateHTML('noresults', 'No stations found', 'Try another search or enter a direct HTTP(S) stream URL below.');
      return;
    }
    list.innerHTML = stations.map((station, index) => {
      const name = escapeHtml(station.name), country = escapeHtml(station.country);
      const tags = escapeHtml(station.tags.split(',').filter(Boolean).slice(0, 2).join(' • '));
      const logo = station.favicon ? `<img src="${escapeHtml(station.favicon)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : '<i class="fa-solid fa-radio" aria-hidden="true"></i>';
      return `<button class="radio-station" type="button" data-radio-index="${index}" data-radio-stream="${escapeHtml(station.url)}" aria-label="Play ${name}" aria-pressed="false">
        <span class="radio-station-art" aria-hidden="true">${logo}</span>
        <span class="radio-station-main"><span class="radio-station-name">${name}</span><span class="radio-station-meta">${country}${country && tags ? ' • ' : ''}${tags || 'Live station'}</span></span>
        <span class="radio-play-btn" aria-hidden="true"><i class="fa-solid fa-play"></i></span>
      </button>`;
    }).join('');
    list.querySelectorAll<HTMLElement>('[data-radio-index]').forEach((row, index) => { row.onclick = () => { playRadioStation(stations[index]); }; });
    updateRadioPlayerUI();
  } catch {
    if (token !== radioSearchToken) return;
    list.innerHTML = navigator.onLine
      ? stateHTML('error', 'Could not load stations', 'The radio directory did not respond. You can enter a direct stream URL below.', 'Try again', 'loadRadioStations(currentRadioQuery)')
      : stateHTML('offline', "You're offline", 'Connect to the internet to listen to live radio.', 'Try again', 'loadRadioStations(currentRadioQuery)');
  }
}

export function updateRadioPlayerUI(): void {
  const station = currentRadioStation;
  const playing = !!station && radioIntent && ownsRadioResource(station) && state.radioIsPlaying && !radioAudio.paused;
  state.radioIsPlaying = playing;
  const canPause = !!station && (radioPlayPending || playing);
  const setText = (id: string, text: string) => { const element = $(id); if (element) element.textContent = text; };
  setText('radioLiveText', station ? `${radioPlayPending ? 'Connecting' : 'Live'} · ${station.name}` : 'Live');
  $('radioMiniPlayer')?.classList.toggle('active', !!station);
  $('radioNowPlaying')?.classList.toggle('active', !!station);
  const tags = station?.tags.split(',').filter(Boolean) || [];
  setText('radioMiniName', station?.name || 'Live radio');
  setText('radioMiniMeta', station ? `${station.country || 'Live station'}${tags.length ? ` • ${tags.slice(0, 2).join(' • ')}` : ''}` : 'Live station');
  setText('radioNowName', station?.name || 'Live radio');
  setText('radioFullName', station?.name || 'Nothing playing');
  setText('radioFullMeta', station ? `${station.country || 'Live station'}${tags.length ? ` • ${tags.slice(0, 3).join(' • ')}` : ''}` : 'Live station');
  const logo = station?.favicon || '';
  if (station && !roomModeActive()) applyDynamicPlayerColor(logo);
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
  document.querySelectorAll<HTMLElement>('.radio-station').forEach(row => {
    const active = playing && row.dataset.radioStream === station?.url;
    row.setAttribute('aria-pressed', String(active));
    const button = row.querySelector('.radio-play-btn');
    button?.classList.toggle('active', active);
    if (button) button.innerHTML = `<i class="fa-solid fa-${active ? 'volume-high' : 'play'}" aria-hidden="true"></i>`;
  });
  updateRadioMediaSession();
}

function radioFailure(request: number, station: RadioStation, error?: unknown): void {
  if (request !== radioRequest || !ownsRadioResource(station)) return;
  radioIntent = radioPlayPending = false;
  state.radioIsPlaying = false;
  cancelRadioForegroundResume();
  radioAudio.pause(); saveRadioState(); updateRadioPlayerUI();
  if (lastFailureRequest === request) return;
  lastFailureRequest = request;
  const name = error && typeof error === 'object' ? (error as { name?: string }).name : '';
  if (name === 'AbortError') return;
  toast(name === 'NotAllowedError' ? 'Press Play radio to allow this stream in your browser.'
    : 'This station could not be played. Check the stream URL or choose another station.', 'triangle-exclamation');
}
function requestRadioPlay(): void {
  const station = currentRadioStation;
  if (!station || roomModeActive() || radioAudio.src !== station.url) return;
  const request = ++radioRequest;
  radioPlaybackIntent = beginPlaybackIntent();
  radioIntent = radioPlayPending = true;
  state.radioIsPlaying = false;
  setupRadioMediaSession(); updateRadioPlayerUI(); saveRadioState();
  try {
    void radioAudio.play().then(() => {
      if (request !== radioRequest || !radioIntent || !ownsRadioResource(station)) return;
      radioPlayPending = false;
      state.radioIsPlaying = !radioAudio.paused;
      saveRadioState(); updateRadioPlayerUI();
    }).catch(error => radioFailure(request, station, error));
  } catch (error) { radioFailure(request, station, error); }
}
export function pauseRadioPlayback(): void {
  if (!currentRadioStation || roomModeActive()) return;
  ++radioRequest;
  radioPlaybackIntent = beginPlaybackIntent();
  radioIntent = radioPlayPending = false;
  cancelRadioForegroundResume(); radioAudio.pause();
  state.radioIsPlaying = false;
  saveRadioState(); updateRadioPlayerUI();
}
export function resumeRadioAfterForeground(): void {
  if (radioIntent && ownsRadioResource() && radioAudio.paused) requestRadioPlay();
}
export function toggleRadioPlay(): void {
  if (!currentRadioStation || roomModeActive()) return;
  if (radioPlayPending || !radioAudio.paused) pauseRadioPlayback(); else requestRadioPlay();
}
export function playRadioStation(value: unknown): boolean {
  const station = stationFrom(value);
  if (!station) { toast('Enter a valid HTTP(S) radio stream URL.', 'triangle-exclamation'); return false; }
  if (roomModeActive()) { toast('Leave the listening room before starting radio.', 'circle-info'); return false; }
  ++radioRequest;
  radioIntent = radioPlayPending = false;
  cancelRadioForegroundResume(); stopPersonalPlaybackForRadio(); radioAudio.pause();
  currentRadioStation = station;
  radioAudio.src = station.url; radioAudio.load();
  $('miniPlayer')?.classList.remove('active'); $('fullPlayerOverlay')?.classList.remove('active');
  requestRadioPlay(); return true;
}
export function playCustomRadio(): boolean {
  return playRadioStation({ name: 'Custom radio station', country: 'Custom stream', url: ($('customRadioUrl') as HTMLInputElement | null)?.value || '' });
}
export function stopRadio(): void {
  const ownedRadio = !!currentRadioStation;
  if (!ownedRadio && !radioAudio.getAttribute('src')) return;
  ++radioRequest;
  radioPlaybackIntent = beginPlaybackIntent();
  radioIntent = radioPlayPending = false;
  cancelRadioForegroundResume(); currentRadioStation = null;
  radioAudio.pause(); radioAudio.removeAttribute('src'); radioAudio.load(); state.radioIsPlaying = false;
  try { localStorage.removeItem(RADIO_STATE_KEY); } catch { /* optional playback memory */ }
  closeRadioFullPlayer(); updateRadioPlayerUI();
  if (!roomModeActive()) {
    if (ownedRadio && (state.activeTrack || state.playbackContext)) $('miniPlayer')?.classList.add('active');
    if (ownedRadio) applyDynamicPlayerColor(state.activeTrack?.img || '');
    setupMainMediaSession(); updateMainMediaSession();
  }
}
export function saveRadioState(url?: string): void {
  const station = currentRadioStation;
  if (!station || validRadioUrl(url || station.url) !== station.url) return;
  try { localStorage.setItem(RADIO_STATE_KEY, JSON.stringify({ url: station.url, station, playing: state.radioIsPlaying && !radioAudio.paused, savedAt: Date.now() })); }
  catch { /* optional browser playback memory */ }
}
export function restoreRadioState(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(RADIO_STATE_KEY) || 'null');
    const stream = validRadioUrl(saved?.url), station = stream ? stationFrom(saved.station, stream) : null;
    if (!station || roomModeActive()) return;
    const request = ++radioRequest;
    radioIntent = radioPlayPending = false;
    currentRadioStation = station; state.radioIsPlaying = false; radioAudio.src = station.url;
    // Defer cyclic player/UI access. Restoring a saved station is read-only and paused.
    queueMicrotask(() => {
      if (request !== radioRequest || currentRadioStation !== station || roomModeActive()) return;
      radioPlaybackIntent = getPlaybackIntent();
      cancelRadioForegroundResume(); setupRadioMediaSession(); updateRadioPlayerUI();
    });
  } catch { /* Preserve an unreadable saved payload for recovery. */ }
}

export function setupRadioMediaSession(): void {
  const station = currentRadioStation;
  if (!('mediaSession' in navigator) || !station || roomModeActive()) return;
  const owned = (action: () => void) => () => { if (currentRadioStation === station && !roomModeActive()) action(); };
  mediaSessionAction('play', owned(requestRadioPlay));
  mediaSessionAction('pause', owned(pauseRadioPlayback));
  mediaSessionAction('stop', owned(stopRadio));
  for (const action of ['nexttrack', 'previoustrack', 'seekto', 'seekforward', 'seekbackward']) mediaSessionAction(action, null);
  try { navigator.mediaSession.setPositionState?.(); } catch { /* nonseekable source */ }
  updateRadioMediaSession();
}
export function updateRadioMediaSession(): void {
  const station = currentRadioStation;
  if (!('mediaSession' in navigator) || !station || roomModeActive()) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: station.name, artist: station.country || 'Aura Music Radio', album: 'Aura Music · Live radio', artwork: station.favicon ? [{ src: station.favicon }] : [] });
    navigator.mediaSession.playbackState = state.radioIsPlaying && !radioAudio.paused ? 'playing' : 'paused';
    navigator.mediaSession.setPositionState?.();
  } catch { /* unsupported Media Session metadata */ }
}
radioAudio.addEventListener('playing', () => {
  if (!ownsRadioResource()) return;
  if (!radioIntent) { radioAudio.pause(); state.radioIsPlaying = false; updateRadioPlayerUI(); return; }
  radioPlayPending = false; state.radioIsPlaying = true; saveRadioState(); updateRadioPlayerUI();
});
radioAudio.addEventListener('pause', () => {
  if (!ownsRadioResource() || !radioAudio.paused) return;
  radioPlayPending = false; state.radioIsPlaying = false; saveRadioState(); updateRadioPlayerUI();
});
radioAudio.addEventListener('ended', () => {
  if (!ownsRadioResource() || !radioAudio.ended) return;
  ++radioRequest; radioIntent = radioPlayPending = false; state.radioIsPlaying = false;
  cancelRadioForegroundResume(); saveRadioState(); updateRadioPlayerUI();
});
radioAudio.addEventListener('error', () => {
  const station = currentRadioStation;
  if (station && (radioIntent || radioPlayPending || state.radioIsPlaying) && radioAudio.error && ownsRadioResource(station)) radioFailure(radioRequest, station, radioAudio.error);
});

export function openRadioFullPlayer(): void {
  if (!currentRadioStation) { toast('Choose a radio station first.', 'circle-info'); return; }
  $('radioFullPlayerOverlay')?.classList.add('active'); $('radioFullPlayerOverlay')?.setAttribute('aria-hidden', 'false'); updateRadioPlayerUI();
}
export function closeRadioFullPlayer(): void {
  $('radioFullPlayerOverlay')?.classList.remove('active'); $('radioFullPlayerOverlay')?.setAttribute('aria-hidden', 'true');
}
export function closeRadioSheetThen(fn: () => void): void { closeTrackMenu(); fn?.(); }
export function openRadioMenu(event?: Event): void {
  event?.stopPropagation();
  const station = currentRadioStation;
  if (!station) return;
  const canPause = radioPlayPending || !radioAudio.paused;
  const actions: Array<[string, string, string, () => void]> = [
    ['toggle', `fa-solid fa-${canPause ? 'pause' : 'play'}`, canPause ? 'Pause radio' : 'Play radio', toggleRadioPlay],
    ['share', 'fa-solid fa-share-nodes', 'Share station', () => { void radioMenuShare(); }],
    ['copy', 'fa-solid fa-link', 'Copy stream link', radioMenuCopy],
  ];
  if (station.homepage) actions.push(['website', 'fa-solid fa-arrow-up-right-from-square', 'Open station website', radioMenuSite]);
  actions.push(['stop', 'fa-solid fa-stop', 'Stop radio', stopRadio]);
  const rows = actions.map(([key, icon, label]) => `<button type="button" class="track-sheet-row" data-radio-action="${key}"><i class="${icon}" aria-hidden="true"></i>${label}</button>`).join('');
  showTrackSheet({ img: station.favicon, title: station.name, artist: station.country || 'Live radio', rowsHtml: rows });
  for (const [key, , , action] of actions) $('trackSheetRows')?.querySelector<HTMLElement>(`[data-radio-action="${key}"]`)?.addEventListener('click', () => {
    closeTrackMenu(); if (currentRadioStation === station && !roomModeActive()) action();
  });
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
  const stream = validRadioUrl(station.url); if (stream) copyToClipboard(stream, 'Stream link copied');
}
export function radioMenuCopy(): void { const url = validRadioUrl(currentRadioStation?.url); if (url) copyToClipboard(url, 'Stream link copied'); }
export function radioMenuSite(): void { const url = validRadioUrl(currentRadioStation?.homepage); if (url) window.open(url, '_blank', 'noopener,noreferrer'); }

$('radioSearchBtn')?.addEventListener('click', () => { void loadRadioStations(($('radioSearchInput') as HTMLInputElement | null)?.value.trim() || currentRadioQuery); });
$('radioSearchInput')?.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') void loadRadioStations((event.target as HTMLInputElement).value.trim() || 'top'); });
document.querySelectorAll<HTMLElement>('.radio-chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('.radio-chip').forEach(other => other.classList.remove('active'));
  chip.classList.add('active'); ($('radioSearchInput') as HTMLInputElement).value = ''; void loadRadioStations(chip.dataset.radioQuery || 'top');
}));
$('radioStopBtn')?.addEventListener('click', stopRadio);
$('customRadioPlayBtn')?.addEventListener('click', playCustomRadio);
$('customRadioUrl')?.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') playCustomRadio(); });
$('radioMiniPlayer')?.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('button, input, a')) openRadioFullPlayer(); });
$('radioMiniPlayBtn')?.addEventListener('click', event => { event.stopPropagation(); toggleRadioPlay(); });
$('radioMiniStopBtn')?.addEventListener('click', event => { event.stopPropagation(); stopRadio(); });
$('radioFullPlayBtn')?.addEventListener('click', toggleRadioPlay);
$('radioFullStopBtn')?.addEventListener('click', stopRadio);
$('radioFullCloseBtn')?.addEventListener('click', closeRadioFullPlayer);
$('closeRadioFullPlayerBtn')?.addEventListener('click', closeRadioFullPlayer);
$('radioHeaderMenuBtn')?.addEventListener('click', openRadioMenu);
restoreRadioState();
