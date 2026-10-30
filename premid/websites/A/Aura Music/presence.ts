import { ActivityType, Assets, StatusDisplayType, getTimestamps, supports } from 'premid'

/* ------------------------------------------------------------------------- *
 * Discord application ID
 *
 * Create one at https://discord.com/developers/applications ("New Application"),
 * name it "Aura Music" (that name is what Discord shows next to the status),
 * upload public/aura-logo.png as its icon, then paste the Application ID here.
 * ------------------------------------------------------------------------- */
const CLIENT_ID = '000000000000000000'

/* Where the site lives. Change these two lines if you deploy elsewhere, and
 * keep metadata.json's url/regExp/logo/thumbnail in sync. */
const SITE_URL = 'https://aura-music-01g.pages.dev'
const SITE_NAME = 'Aura Music'

enum ActivityAssets {
  Logo = `${SITE_URL}/aura-logo.png`,
}

const presence = new Presence({ clientId: CLIENT_ID })

/* Mirrors AuraPresenceState in src/core/presence.ts. */
interface AuraState {
  v: number
  site: string
  kind: 'idle' | 'track' | 'radio'
  title: string
  artist: string
  album: string
  cover: string
  url: string
  videoId: string
  duration: number
  position: number
  playing: boolean
  live: boolean
  tab: string
  updatedAt: number
}

interface Settings {
  privacy: boolean
  cover: boolean
  timestamps: boolean
  displayType: number
  buttons: boolean
  hidePaused: boolean
  browsing: boolean
}

/* ------------------------------------------------------------------------- *
 * Reading the page
 *
 * Three layers, strongest first:
 *   1. window.auraPresence  — plain snapshot object (PreMiD 2.5+)
 *   2. window.AuraPresence  — live object whose getState() has a fresh position
 *   3. #auraPresence[data-*] — text attributes, readable by any content script
 * ------------------------------------------------------------------------- */

function number(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function httpImage(url: unknown, fallback: string): string {
  const value = String(url || '').trim()
  if (/^https:\/\//i.test(value))
    return value
  if (/^http:\/\//i.test(value))
    return value.replace(/^http:/i, 'https:')
  return fallback
}

function readDomState(): AuraState | null {
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
    const age = Math.max(0, Date.now() - number(data.updatedAt)) / 1000
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
    videoId: data.videoId || '',
    duration,
    position,
    playing,
    live,
    tab: data.tab || '',
    updatedAt: number(data.updatedAt),
  }
}

async function readPageState(): Promise<AuraState | null> {
  if (supports(presence, 'getPageVariable')) {
    try {
      const state = await presence.getPageVariable<AuraState>('auraPresence')
      if (state && typeof state === 'object' && 'kind' in state)
        return state
    }
    catch {
      /* Older extension or the page has not published yet — fall through. */
    }
  }

  if (supports(presence, 'execInPage')) {
    try {
      const state = await presence.execInPage<AuraState>({ call: 'AuraPresence.getState' })
      if (state && typeof state === 'object' && 'kind' in state)
        return state
    }
    catch {
      /* ignore */
    }
  }

  return null
}

async function getSetting<T extends string | number | boolean>(id: string, fallback: T): Promise<T> {
  try {
    const value = await presence.getSetting<T>(id)
    return value === undefined || value === null ? fallback : value
  }
  catch {
    return fallback
  }
}

async function getSettings(): Promise<Settings> {
  const [privacy, cover, timestamps, displayType, buttons, hidePaused, browsing] = await Promise.all([
    getSetting('privacy', false),
    getSetting('cover', true),
    getSetting('timestamps', true),
    getSetting('displayType', 0),
    getSetting('buttons', true),
    getSetting('hidePaused', false),
    getSetting('browsing', true),
  ])

  return { privacy, cover, timestamps, displayType, buttons, hidePaused, browsing }
}

/* ------------------------------------------------------------------------- *
 * Building the activity
 * ------------------------------------------------------------------------- */

function clip(value: string, max = 128): string {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function youtubeUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}

/** When the user is not playing anything: "Browsing Aura Music — Library". */
function browsingPresence(state: AuraState | null, settings: Settings, since: number): PresenceData | null {
  if (!settings.browsing)
    return null

  const tab = clip(state?.tab || '', 64)
  const data: PresenceData = {
    type: ActivityType.Playing,
    largeImageKey: ActivityAssets.Logo,
    details: `Browsing ${SITE_NAME}`,
    startTimestamp: since,
  }

  if (tab)
    data.state = tab

  if (settings.buttons) {
    data.buttons = [{
      label: `Open ${SITE_NAME}`,
      url: SITE_URL,
    }]
  }

  return data
}

function trackPresence(state: AuraState, settings: Settings): PresenceData {
  const duration = Math.floor(Math.max(0, state.duration || 0))
  const position = Math.min(Math.max(0, state.position || 0), duration || Number.POSITIVE_INFINITY)
  const artist = clip(state.artist)
  const isRadio = state.kind === 'radio'

  const data: PresenceData = {
    type: ActivityType.Listening,
    largeImageKey: settings.cover ? httpImage(state.cover, ActivityAssets.Logo) : ActivityAssets.Logo,
    largeImageText: clip(state.album || artist || (isRadio ? 'Live radio' : SITE_NAME)),
    details: clip(state.title) || SITE_NAME,
    state: artist || undefined,
  }

  if (settings.buttons) {
    const buttons: [ButtonData, ButtonData?] = [{
      label: `Open ${SITE_NAME}`,
      url: SITE_URL,
    }]

    if (state.videoId) {
      buttons.unshift({
        label: 'Play on YouTube',
        url: youtubeUrl(state.videoId),
      })
    }

    data.buttons = buttons
  }

  if (settings.displayType === 1)
    data.statusDisplayType = StatusDisplayType.State
  else if (settings.displayType === 2)
    data.statusDisplayType = StatusDisplayType.Details

  if (isRadio) {
    data.smallImageKey = Assets.Live
    data.smallImageText = 'Live radio'
  }
  else if (!state.playing) {
    data.smallImageKey = Assets.Pause
    data.smallImageText = 'Paused'
  }
  else {
    data.smallImageKey = Assets.Play
    data.smallImageText = 'Playing'
  }

  /* A paused track has no meaningful "remaining" reading, and a live stream
   * has no duration at all — timestamps only make sense while playing one. */
  if (settings.timestamps && state.playing && !state.live && duration > 0) {
    const [startTimestamp, endTimestamp] = getTimestamps(Math.floor(position), duration)
    data.startTimestamp = startTimestamp
    data.endTimestamp = endTimestamp
  }

  return data
}

/* Time spent browsing, kept stable across the frequent UpdateData ticks. */
let browsingSince = 0

presence.on('UpdateData', async () => {
  const settings = await getSettings()
  const state = (await readPageState()) ?? readDomState()
  const kind = state?.kind || 'idle'

  if (kind === 'idle') {
    if (!browsingSince)
      browsingSince = Math.floor(Date.now() / 1000)

    const data = browsingPresence(state, settings, browsingSince)
    return data ? presence.setActivity(data) : presence.clearActivity()
  }

  browsingSince = 0

  if (settings.hidePaused && !state?.playing)
    return presence.clearActivity()

  if (settings.privacy) {
    return presence.setActivity({
      type: ActivityType.Listening,
      largeImageKey: ActivityAssets.Logo,
      details: `Listening to ${SITE_NAME}`,
    })
  }

  if (state)
    presence.setActivity(trackPresence(state, settings))
  else
    presence.clearActivity()
})
