# Features

This guide describes the user flows in the source tree. Paths point at the
owning module.

## Authentication & profile

| Flow | Behaviour |
| --- | --- |
| Google sign-in | Google Identity Services button/One Tap. The ID token is verified in the browser (RS256 against Google's JWKS) and again by `/api/admin` for admin actions. Any Google account can enter. |
| First entry | The user picks a username (2–20 characters, starting with a Unicode letter/number; spaces, `_` and `-` are also allowed). It is stored per email in `auraProfiles_v1` and becomes the profile name on this device. |
| Email + password fallback | Device-local accounts only. PBKDF2-SHA256, 150k iterations, random 16-byte salt; only the hash is stored (`auraLocalAccounts_v1`). Works offline and when Google is unavailable. |
| Session | `auraSession_v2` stores email/name/picture, expiry and token. Google sessions are extended to 7 days via `/api/admin`’s exchange action; the raw ID token remains valid ~1 hour. |
| Returning entry | A valid stored session opens a restoring/loading screen while the music runtime loads. Failed or slow startup exposes **Reload Aura**; malformed or expired sessions return to sign-in. |
| Profile popover | Shows name, avatar (or initial), first/last sign-in, track and favourite counts, and “change name”. |
| Sign out | Clears the display name and session, disables Google auto-select, shows a 1.5 s logout animation, then reloads. |
| Admin gate | A separate allow-list (`ADMIN_EMAILS` in `src/core/config.ts`, mirrored in `functions/api/admin.ts`). Signing into the site does **not** grant admin API access unless the email is on that list. |

**Privacy:** no account data is sent to an Aura backend. Sessions and profiles
live in this browser only. The admin API sees Google tokens to verify them but
does not store them.

Signed-out entry loads the sign-in UI before the music runtime, catalogue or
audio initialization. A received playlist fragment waits through sign-in and
username entry, then opens its preview. See [startup recovery](troubleshooting.md#returning-session-startup-does-not-finish).

## Home

- Time-of-day greeting and the user's name.
- **Quick access**: Liked Songs, Shuffle All (or Jump Back In when something was
  played), Local Files, Recently Played.
- **Soundscape** card opens the ambience/effects panel.
- **Aura Picks**: eight seeded picks, refreshed when the catalogue grows or the
  user presses “Refresh mix”. Designed empty state when the library is empty.
- **More from**: an artist spotlight for every artist with at least two tracks,
  using the same artist identities and portraits as Library.
- All sections are rebuilt in a single animation frame per change
  (`updateLibCount` batches the home paint).

## Library

The library views share the same track data:

- **Tracks** — the full list (catalogue + added/local tracks), virtual one row
  per song, heart and “…” actions.
- **Artists** — grouped by centralized artist identities; open an artist to
  browse their credited tracks.
- **Albums** — grouped by album metadata from `manifest.json`.
- **Films** — extracts `(From "Film")` credits from titles/albums.

Home, Library, artist details and artist counts use one identity resolver.
Admin-owned aliases/corrections take precedence over reviewed spelling variants;
ambiguous names stay separate. Supported collaborations can appear under each
credited artist while retaining the recording’s original track keys. Details:
[Artist storage](artist-storage.md#read-side-artist-identity).

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

The search tab filters the whole library by title, artist, album, film, or genre.
Category tiles (All, Favorites, Recently Played) scope the results when the
query is empty. Before typing, the tab shows the selected category; typing
switches to whole-library results.

Search is deliberately library-only. New music enters through the Discord
submission pipeline, is reviewed/downloaded, and then appears in the shared
Aura catalogue. Requests are an intentional user action through
[AURA FARMER](https://github.com/angel2rider/AURA-FARMER), a separate repository;
an empty search never submits music or injects third-party previews.

## Playlists

- A dedicated Playlists tab is available on desktop and mobile.
- Create, rename, describe, play, and delete playlists.
- Add a track from any track action menu or from suggestions on a playlist page.
- Remove tracks without removing them from the Aura library.
- Playlist data stays in `localStorage` on the current device and updates across
  browser tabs through the `storage` event.

### Sharing a playlist

1. Open a playlist and choose **Share**. Aura builds a usable
   `/#playlist=<snapshot>` link and opens native sharing when supported.
2. The inline share panel shows the link, omission counts and sharing status.
   **Copy link** uses clipboard fallbacks; if copying is blocked, select and
   copy the displayed link manually. Native cancellation is reported without
   silently copying.
3. Recipients open a read-only preview after the existing sign-in flow. Choose
   **Save playlist** to create a private browser-local copy, or **Dismiss**.
   An unchanged snapshot already saved offers **Open saved playlist**.

The snapshot contains the title, description and ordered track labels/keys.
Anyone with the link can read it; subsequent sender edits do not update the
recipient’s copy. Local audio, artwork/media URLs and account data are excluded.
Local files and unresolvable legacy entries are omitted with counts. The limit
is **100 tracks including omissions** and **16 KiB of decoded JSON**; oversized
playlists fail visibly rather than silently dropping tracks.

Only matches already in the recipient’s library can play. Missing tracks keep
their names and places in the saved copy and resolve when the library updates.
Opening or saving a link does not start playback, fetch missing music or submit
downloads. Playlists remain local to each browser. Owners:
`src/features/playlists.ts`, `src/features/deeplink.ts`, and
`src/core/playlist-sharing.ts`.

## Player

- **Mini player** (bottom dock on desktop / mobile dock) with title, artist,
  seek, previous/next, play/pause, like, shuffle and repeat.
- **Full player** opens from the mini player or a song; background gradients and
  control colours are derived from the cover art, contrast-checked against white
  text. Paused artwork uses a spring animation.
- **Playlist sequencing** — starting a playlist queues its remaining tracks so
  next/autoplay follows the playlist order.
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

A room is a shared playback session: admins control the transport, listeners
hear synchronized playback, and everyone can chat and see the queue.
Rooms are a **separate page** (`/rooms`) with their own bundle and Web Audio
engine.

- Enter a room code or paste an invite link, choose a name, then **Join room**;
  **Start a room** makes you an admin. Entry shows progress, **Cancel** and
  actionable errors.
- The now-playing stage shows track, loading and sync status. **Turn on sound**
  handles browser audio blocking; **Your volume** affects only your device.
- Admins choose from the shared library, manage **Up next**, control playback,
  and share controls through **Here together**. Listeners can browse and chat.
- **Invite friends** opens an inline listener-link panel with copy/manual-copy
  feedback. Its `/rooms?r=<id>` link excludes the admin key.
- **Queue**, **People** and **Chat** shortcuts reach the room sections on small
  screens. **Reconnect** handles a disconnected session; **Leave room** exits it.

See [rooms.md](rooms.md) for authority, protocol, lifecycle, synchronization and
the development harness.

## Settings

Stored in `auraSettings_v1` unless noted:

| Setting | Default | Effect |
| --- | --- | --- |
| Autoplay next track | on | `ended` advances the queue |
| Remember volume | on | stores `auraVolume` |
| Reduce motion | off | adds `.aura-reduce-motion` (also honours OS preference) |
| Reset preferences | — | restores defaults after confirmation |

The interface uses a true-black (`#000`) canvas with neutral raised surfaces,
local fonts/icons and artwork colour. Legacy `auraTheme` values do not switch
the app to a light theme.

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
