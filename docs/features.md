# Features

Everything here is implemented in the current build unless marked **Known gap**.
Paths point at the owning module.

## Authentication & profile

| Flow | Behaviour |
| --- | --- |
| Google sign-in | Google Identity Services button/One Tap. The ID token is verified in the browser (RS256 against Google's JWKS) and again by `/api/admin` for admin actions. Any Google account can enter. |
| First entry | The user picks a username (3–20 characters, letters/numbers/space/`_`/`-`). It is stored per email in `auraProfiles_v1` and becomes the profile name on this device. |
| Email + password fallback | Device-local accounts only. PBKDF2-SHA256, 150k iterations, random 16-byte salt; only the hash is stored (`auraLocalAccounts_v1`). Works offline and when Google is unavailable. |
| Session | `auraSession_v2` stores email/name/picture, expiry and token. Google sessions are extended to 7 days via `/api/admin`’s exchange action; the raw ID token remains valid ~1 hour. |
| Profile popover | Shows name, avatar (or initial), first/last sign-in, track and favourite counts, theme toggle and “change name”. |
| Sign out | Clears the display name and session, disables Google auto-select, shows a 1.5 s logout animation, then reloads. |
| Admin gate | A separate allow-list (`ADMIN_EMAILS` in `src/core/config.ts`, mirrored in `functions/api/admin.ts`). Signing into the site does **not** grant admin API access unless the email is on that list. |

**Privacy:** no account data is sent to an Aura backend. Sessions and profiles
live in this browser only. The admin API sees Google tokens to verify them but
does not store them.

## Home

- Time-of-day greeting and the user's name.
- **Quick access**: Liked Songs, Shuffle All (or Jump Back In when something was
  played), Local Files, Recently Played.
- **Soundscape** card opens the ambience/effects panel.
- **Aura Picks**: eight seeded picks, refreshed when the catalogue grows or the
  user presses “Refresh mix”. Designed empty state when the library is empty.
- **More from**: an artist spotlight for every artist with at least two tracks,
  merged across spelling variants (`A. R. Rahman` / `A.R. Rahman` / `… - Topic`).
- All sections are rebuilt in a single animation frame per change
  (`updateLibCount` batches the home paint).

## Library

Three navigation destinations share the library data:

- **Tracks** — the full list (catalogue + added/local tracks), virtual one row
  per song, heart and “…” actions.
- **Artists** — grouped by normalised artist name; group headers can play the
  first track.
- **Albums** — grouped by album metadata from `manifest.json`.
- **Films** — extracts `(From "Film")` credits from titles/albums.

Other library features:

- **Likes** — persisted in `auraLikedSongs_v2` and merged into the catalogue by
  video id or title+artist when the source changes.
- **Recently played** — last 10, persisted in `recentlyPlayed`; used by home and
  the search “Recently Played” category.
- **Local files** — drag/drop or picker; ID3/MP4/FLAC tags are read with
  jsmediatags, audio blobs stored in IndexedDB (`auraMusicDB` / `audioFiles`),
  metadata in `addedTracks`.
- **Add by URL** — title + `http(s)` audio URL; invalid or non-http URLs are
  rejected.
- **Add YouTube link** — stores title/artist from public oEmbed metadata and a
  thumbnail; playback uses the official embedded player. Duplicate video ids
  are rejected and the button disables while the request is pending.
- **Edit/delete** — rename title/artist, replace cover from a URL or uploaded
  file, delete from the library (also deletes the IndexedDB blob for local files).
- **Stats** — total tracks, favourites, local files, distinct artists.
- **Search within the library** — the main search box filters title/artist/album
  locally as you type.

**Empty/loading/error:** skeleton rows while the remote catalogue loads; designed
empty-library state with a “Search music” CTA; retryable error state when the
catalogue is unreachable.

## Search

### Local search

The search tab filters the whole library by title, artist or album. Category
tiles (All, Favorites, Recently Played, Local Files) scope the results when the
query is empty. Before typing, the tab shows the selected category; typing
switches to whole-library results.

### Online search

Typing at least **two characters** starts a debounced (350 ms) fan-out to up to
nine providers. Results are interleaved round-robin and capped at 30.

| Provider | Key? | Result | Playback |
| --- | --- | --- | --- |
| YouTube Music | YouTube Data API key (optional) | 8 videos, 12 h local cache | official YouTube IFrame player |
| Pasted YouTube link | none | one video via oEmbed | official IFrame player |
| iTunes | none (JSONP) | 30 s previews | HTML audio |
| Deezer | none (JSONP) | 30 s previews | HTML audio |
| Audius | none | full tracks | HTML audio |
| Jamendo | free `client_id` (optional) | full Creative Commons tracks | HTML audio |
| Internet Archive | none | full public-domain/CC tracks | HTML audio (resolves item metadata) |
| Openverse | none | full CC audio | HTML audio |
| ccMixter | none | full CC tracks | HTML audio |

- YouTube results need a key in Settings or `AURA_YOUTUBE_API_KEY`; without one,
  pasting a link still works and the other providers continue to return results.
- Search is resilient: providers use `Promise.allSettled`; if every provider
  fails, an error state with **Try again** is shown; offline shows an offline
  state. A “Still searching…” state appears after 7 s.
- Spotify/SoundCloud links open their public oEmbed widgets; YouTube links play
  in the embedded player.
- The “Find on …” buttons open the official YouTube Music, Spotify or SoundCloud
  search pages for the current query.

**Known gap:** the settings toggle “Search history” and “Clear recent searches”
exist, but the current build does not persist or render a search-history list.

## Player

- **Mini player** (bottom dock on desktop / mobile dock) with title, artist,
  seek, previous/next, play/pause, like, shuffle and repeat.
- **Full player** opens from the mini player or a song; background gradients and
  control colours are derived from the cover art, contrast-checked against white
  text. Paused artwork uses a spring animation.
- **Queue / Up Next** — play next, add to queue, remove, reorder (drag), clear;
  opens as a sheet on mobile and a docked panel on desktop.
- **Seek** — range slider plus the mobile bottom-edge progress line; seeks work
  for HTML audio and YouTube.
- **Shuffle/repeat** — repeat-one and repeat-all, mirrored between full and mini
  players.
- **Volume** — persisted when “Remember volume” is enabled; muted state restores
  the previous level.
- **Media Session** — lock-screen/OS controls for play, pause, previous/next and
  metadata for local/HF audio and radio.
- **YouTube** — Aura never extracts or downloads YouTube audio; it plays the
  official iframe player in the full player. The iframe API is loaded on demand.
- **Autoplay policy** — rejected `play()` calls reset the UI instead of leaving a
  false “playing” state.

## Radio

- Search stations via `de1.api.radio-browser.info` (top stations, name search,
  HTTPS/hide-broken filters).
- Play a station, pause/resume, stop, custom stream URL.
- Station metadata: name, country, tags, favicon; opens a full radio player with
  a vinyl animation.
- Radio is independent of tab changes; it is not paused just because you leave
  Home.
- Media Session metadata/controls are updated.
- Streams must be browser-supported and served over HTTPS; an unsupported codec
  or HTTP stream shows a toast instead of silently failing.

## Ambience (Soundscape)

The effects panel mixes Web Audio layers under music/radio:

- 14 generated ambience beds (rain, thunder, ocean, forest, birds, campfire,
  coffee shop, tea, vinyl crackle, library, crickets, train, cabin, car roof).
- Individual volume sliders; layers can be toggled independently.
- Stereo/Spatial auto-pan (LFO on the ambience mix) and a low-pass “muffle”
  toggle.
- A focus timer with configurable focus/break minutes (defaults 25/5) and a live
  countdown.
- All timers/nodes are created lazily and stopped when the layer is disabled.

## Listen Together (rooms)

A room is a shared playback session: one admin controls the transport, everyone
hears the same track at the same moment, and listeners can chat and see the queue.
Rooms are a **separate page** (`/rooms`) with their own bundle and Web Audio
engine.

See [rooms.md](rooms.md) for the protocol, Durable Object, clock sync, drift
correction, grace period and local development harness. The short version:

- Create room → share link `/rooms?r=<id>`; the creator gets an admin key.
- Invitees join with the code/name.
- Admin can play/pause/seek/track, manage the queue, promote/demote listeners.
- Chat, participants, queue and room expiry are server-authoritative.
- Room survives an empty room for 3 minutes; listeners can reclaim control for
  30 seconds after the last admin leaves.

## Settings

Stored in `auraSettings_v1` unless noted:

| Setting | Default | Effect |
| --- | --- | --- |
| Autoplay next track | on | `ended` advances the queue |
| Remember volume | on | stores `auraVolume` |
| Search history | on | **Known gap:** no persistent list is rendered |
| YouTube Music results | on | hides the online YouTube section when off |
| Reduce motion | off | adds `.aura-reduce-motion` (also honours OS preference) |
| YouTube API key | empty | local override for `AURA_YOUTUBE_API_KEY` |
| Jamendo client id | empty | enables Jamendo results |
| Theme | dark | persisted in `auraTheme`, applied before first paint |
| Clear recent searches | — | removes `auraSearchHistory_v1` |
| Reset preferences | — | restores defaults after confirmation |

Other surfaces: Help & Support (mail/Discord), About, sidebar collapse
(`auraSidebarCollapsed`), Effects, and the profile popover.

## Discord presence & deep links

The site publishes a read-only “now playing” contract; the PreMiD activity turns
it into a Discord status with title, artist, cover, progress, live-radio state and
buttons. The primary button (**Listen in Aura Music**) uses a deep link:

- `/?play=<track id>` — bucket/local/added track
- `/?play=yt:<videoId>` — YouTube track played inside Aura

The site consumes the deep link on load, starts that exact track and removes the
query parameter. The activity, its settings and setup live in
[presence.md](presence.md) and [premid/README.md](../premid/README.md).

## Resilience & accessibility

- Network banner for offline/slow connections.
- Catalogue skeleton, empty and retry states.
- Cover fallback for broken images.
- Toast live region (`role="status" aria-live="polite"`).
- Global focus-visible ring, disabled/busy styles, reduced-motion support.
- Escape closes the top overlay only; Tab is trapped in dialogs; focus is
  restored on close; Enter/Space activates `role="button"` rows/cards.
- Active tabs expose `aria-current="page"`; icon-only controls have labels;
  cover images have alt text (empty for decorative art); form controls are
  labelled.
- Mobile touch targets are at least 40 px for row actions and 44 px for dock
  controls; 390 px layout has no horizontal overflow.
