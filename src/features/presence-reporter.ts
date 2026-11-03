/* Publishes what the player is doing to the presence bridge (src/core/presence).
 *
 * Polling rather than hooks: the player already has a single source of truth
 * (state + the audio element + the YouTube iframe), and reading it once a
 * second catches every path — play, pause, seek, next, radio, YouTube — without
 * sprinkling calls through transport code. Discord presence ticks in whole
 * seconds anyway.
 */

import { installPresence, publishPresence } from '../core/presence';
import { cleanTitle } from '../core/catalog';
import { state } from '../core/state';
import { auraYTPlayer, auraYTPoster, auraYTTitle, auraYTVideoId, lastPlayRequestAt } from './player';
import { currentRadioStation, radioAudio } from './radio';

const TAB_NAMES: Record<string, string> = {
  tabHome: 'Home',
  tabSearch: 'Search',
  tabLibrary: 'Library',
  tabRadio: 'Radio',
  tabProfile: 'Add Music',
};

const isHttp = (url: string) => /^https?:\/\//i.test(url || '');

function currentTab(): string {
  const button = document.querySelector<HTMLElement>('.desktop-nav-btn.active[data-tab]');
  const tabId = button?.dataset.tab || '';
  return TAB_NAMES[tabId] || 'Home';
}

function seconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
}

function youtubeVideoUrl(videoId: string): string {
  return videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : '';
}

/* Deep link understood by src/features/deeplink.ts. The activity uses it for
   its "Listen in Aura Music" button and clickable song title. */
function appLink(song: any): string {
  const origin = location.origin;
  if (!song) return origin + '/';
  if (song.isYouTube && song.videoId) return `${origin}/?play=yt:${encodeURIComponent(String(song.videoId))}`;
  return `${origin}/?play=${encodeURIComponent(String(song.id))}`;
}

function reportRadio(): boolean {
  const station = currentRadioStation as any;
  if (!station) return false;

  const meta = [station.country, String(station.tags || '').split(',').filter(Boolean).slice(0, 2).join(' · ')]
    .filter(Boolean)
    .join(' · ');

  publishPresence({
    kind: 'radio',
    title: String(station.name || 'Live radio'),
    artist: meta,
    album: '',
    cover: isHttp(station.favicon) ? String(station.favicon) : '',
    url: location.origin + '/',
    link: location.origin + '/',
    videoId: '',
    duration: 0,
    position: 0,
    playing: !radioAudio.paused,
    live: true,
    tab: currentTab(),
  });
  return true;
}

function reportYouTube(): boolean {
  if (!auraYTVideoId) return false;

  const song = state.songs[state.currentIndex];
  let playing = state.isPlaying;
  let position = 0;
  let duration = 0;

  try {
    if (auraYTPlayer && typeof auraYTPlayer.getPlayerState === 'function') {
      // 1 = playing, 3 = buffering (still counts as playing to the viewer).
      const playerState = auraYTPlayer.getPlayerState();
      playing = playerState === 1 || playerState === 3;
      position = seconds(auraYTPlayer.getCurrentTime());
      duration = seconds(auraYTPlayer.getDuration());
    }
  } catch {
    /* The iframe can be mid-destroy while a track is being swapped. */
  }

  publishPresence({
    kind: 'track',
    title: cleanTitle(auraYTTitle || song?.title || 'YouTube'),
    artist: '',
    album: 'YouTube Music',
    cover: isHttp(auraYTPoster) ? auraYTPoster : `https://i.ytimg.com/vi/${auraYTVideoId}/mqdefault.jpg`,
    url: youtubeVideoUrl(auraYTVideoId),
    link: `${location.origin}/?play=yt:${encodeURIComponent(auraYTVideoId)}`,
    videoId: auraYTVideoId,
    duration,
    position,
    playing,
    live: false,
    tab: currentTab(),
  });
  return true;
}

function reportLocalTrack(): boolean {
  const song = state.songs[state.currentIndex];
  const src = state.audio?.getAttribute('src') || '';
  if (!song || !src) return false;

  /* loadSong(0) runs at boot so the player has art ready, but that is not a
     listening session — only claim the track once playback actually started. */
  const started = state.isPlaying || state.audio.currentTime > 0 || lastPlayRequestAt > 0;
  if (!started) return false;

  const duration = seconds(state.audio.duration);
  const position = Math.min(duration || Infinity, seconds(state.audio.currentTime));

  publishPresence({
    kind: 'track',
    title: String(song.title || ''),
    artist: String(song.artist || ''),
    album: String(song.album || ''),
    cover: isHttp(song.img) ? String(song.img) : '',
    url: location.origin + '/',
    link: appLink(song),
    videoId: String(song.videoId || ''),
    duration,
    position,
    playing: !state.audio.paused,
    live: false,
    tab: currentTab(),
  });
  return true;
}

function reportIdle(): void {
  publishPresence({
    kind: 'idle',
    title: '',
    artist: '',
    album: '',
    cover: '',
    url: location.origin + '/',
    link: location.origin + '/',
    videoId: '',
    duration: 0,
    position: 0,
    playing: false,
    live: false,
    tab: currentTab(),
  });
}

let lastPublishAt = 0;

function report(force = false): void {
  const now = Date.now();
  if (!force && now - lastPublishAt < 800) return;
  lastPublishAt = now;
  try {
    if (reportRadio() || reportYouTube() || reportLocalTrack()) return;
    reportIdle();
  } catch {
    /* Presence is a side channel — never let it break playback. */
  }
}

installPresence();
report(true);

/* Media events keep the snapshot fresh even when the tab is in the background
   and its timers are being throttled; the interval is the idle heartbeat. */
state.audio.addEventListener('timeupdate', () => report());
state.audio.addEventListener('play', () => report(true));
state.audio.addEventListener('pause', () => report(true));
state.audio.addEventListener('seeked', () => report(true));
document.addEventListener('visibilitychange', () => report(true));
setInterval(report, 1000);
