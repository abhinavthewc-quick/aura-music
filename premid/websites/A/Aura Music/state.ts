/* Reads the presence contract the Aura Music site publishes.
 *
 * Kept free of Discord/presence imports so it can be unit-tested in plain
 * Node: give it a `document` and it returns what the activity needs.
 *
 * Contract (see src/core/presence.ts in the Aura Music repo):
 *   #auraPresence[data-kind|data-title|data-artist|data-album|data-cover|
 *                  data-url|data-link|data-video-id|data-duration|data-position|
 *                  data-playing|data-live|data-tab|data-updated-at]
 *   window.auraPresence / window.AuraPresence.getState()
 */

export const SITE_NAME = 'Aura Music'

export interface AuraState {
  v: number
  site: string
  kind: 'idle' | 'track' | 'radio'
  title: string
  artist: string
  album: string
  cover: string
  url: string
  /** Deep link that plays this exact item in Aura ('' when unavailable). */
  link: string
  videoId: string
  duration: number
  position: number
  playing: boolean
  live: boolean
  tab: string
  updatedAt: number
}

export function number(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Discord only accepts http(s) artwork; prefer https, fall back to the logo. */
export function httpImage(url: unknown, fallback: string): string {
  const value = String(url || '').trim()
  if (/^https:\/\//i.test(value))
    return value
  if (/^http:\/\//i.test(value))
    return value.replace(/^http:/i, 'https:')
  return fallback
}

/** Clickable targets must keep their scheme: localhost dev is http, not https. */
export function httpLink(url: unknown, fallback: string): string {
  const value = String(url || '').trim()
  return /^https?:\/\//i.test(value) ? value : fallback
}

export function clip(value: string, max = 128): string {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function youtubeUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}

export function readDomState(now = Date.now()): AuraState | null {
  const el = document.getElementById('auraPresence')
  if (!el)
    return null

  const data = el.dataset
  const live = data.live === '1'
  const playing = data.playing === '1'
  const duration = number(data.duration)
  let position = number(data.position)

  /* Attributes are refreshed once a second, so bridge the gap while a track
   * plays. When paused this is skipped: the stored position is the truth. */
  if (playing && !live && duration > 0) {
    const age = Math.max(0, now - number(data.updatedAt)) / 1000
    position = Math.min(duration, position + Math.min(age, 5))
  }

  const kind = data.kind === 'track' || data.kind === 'radio' ? data.kind : 'idle'

  return {
    v: number(data.v),
    site: data.site || SITE_NAME,
    kind,
    title: data.title || '',
    artist: data.artist || '',
    album: data.album || '',
    cover: data.cover || '',
    url: data.url || '',
    link: data.link || '',
    videoId: data.videoId || '',
    duration,
    position,
    playing,
    live,
    tab: data.tab || '',
    updatedAt: number(data.updatedAt),
  }
}
