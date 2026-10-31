import type { AuraState } from './state.js'
import { ActivityType, Assets, getTimestamps, StatusDisplayType, supports } from 'premid'
import { clip, httpImage, readDomState, SITE_NAME, youtubeUrl } from './state.js'

/* ------------------------------------------------------------------------- *
 * Discord application — "Aura Music"
 *
 * https://discord.com/developers/applications/1566089897905758259
 * The app name is what Discord shows next to the status. Upload
 * public/aura-logo.png as the app icon so the fallback artwork looks right.
 * ------------------------------------------------------------------------- */
const CLIENT_ID = '1566089897905758259'

/* Where the site lives. Change this if you deploy elsewhere, and keep
 * metadata.json's url/regExp/logo/thumbnail in sync. */
const SITE_URL = 'https://aura-music-01g.pages.dev'

const LOGO_URL = `${SITE_URL}/aura-logo.png`

const presence = new Presence({ clientId: CLIENT_ID })

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
    return value ?? fallback
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

/** When the user is not playing anything: "Browsing Aura Music — Library". */
function browsingPresence(state: AuraState | null, settings: Settings, since: number): PresenceData | null {
  if (!settings.browsing)
    return null

  const tab = clip(state?.tab || '', 64)
  const data: PresenceData = {
    type: ActivityType.Playing,
    largeImageKey: LOGO_URL,
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
    largeImageKey: settings.cover ? httpImage(state.cover, LOGO_URL) : LOGO_URL,
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

  if (isRadio && state.playing) {
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
      largeImageKey: LOGO_URL,
      details: `Listening to ${SITE_NAME}`,
    })
  }

  if (state)
    presence.setActivity(trackPresence(state, settings))
  else
    presence.clearActivity()
})
