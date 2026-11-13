# Features

This guide describes the source tree's listener flows and local-first boundaries.
Paths point at the owning module.
It is not a claim that every third-party provider or live deployment was tested.
See [remediation](remediation.md) for the verification gate and infrastructure
work that cannot be completed by a source-only change.

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
- **Quick access**: liked music, resume/shuffle, recently played, and shortcuts
  into the available library views.
- **Soundscape** card opens the ambience/effects panel.
- **Aura Picks**: eight seeded picks, refreshed when the catalogue grows or the
  user presses “Refresh mix”. Designed empty state when the library is empty.
- **More from**: an artist spotlight for every artist with at least two tracks,
  using the same artist identities and portraits as Library.
- All sections are rebuilt in a single animation frame per change
  (`updateLibCount` batches the home paint).

## Library

Four library views share the same track data:

- **Tracks** — the full list (catalogue + added/local tracks), virtual one row
  per song, heart and “…” actions.
- **Artists** — grouped by centralized artist identities; open an artist to
  browse their credited tracks. Artist playback is opt-in and stays within that
  collection instead of falling through to unrelated library tracks.
- **Albums** — grouped by album metadata from `manifest.json`.
- **Films** — extracts `(From "Film")` credits from titles/albums.

Home, Library, artist details and artist counts use one identity resolver.
Admin-owned aliases/corrections take precedence over reviewed spelling variants;
ambiguous names stay separate. Supported collaborations can appear under each
credited artist while retaining the recording’s original track keys. Details:
[Artist storage](artist-storage.md#read-side-artist-identity).

Artist profiles automatically fill missing portraits and descriptions from
Wikimedia sources after sign-in. Saved field overrides, including explicit
clears, take precedence. Source credits accompany automatic content; unavailable
portraits use a neutral placeholder. See [Automatic artist profiles](artist-metadata.md).

Other library features:

- **Likes** — persisted in `auraLikedSongs_v2` and merged into the catalogue by
  video id or title+artist when the source changes.
- **Recently played** — last 10, persisted in `recentlyPlayed`; used by home and
  the search “Recently Played” category.
- **Local audio** — import device files into IndexedDB (`auraMusicDB` /
  `audioFiles`), with metadata in `addedTracks`. Title/artist are derived from
  the filename (for example, `Artist - Title.mp3`); this does not promise ID3 tag
  extraction or a jsmediatags dependency. Existing local blobs still hydrate.
  The Local files filter shows them truthfully; missing blobs stay unavailable
  with **Restore local file**, retaining their playlist reference.
- **Existing added URLs / YouTube tracks** — legacy entries and supported deep
  links remain playable; YouTube uses the official embedded player. Shared
  catalogue acquisition remains the Discord/admin pipeline, not a public URL/
  preview acquisition form.
- **Edit/delete** — rename title/artist, replace cover from a URL or uploaded
  file, delete from the library (also deletes the IndexedDB blob for local files).
- **Stats** — total tracks, favourites, local files, distinct artists.
- **Search within the library** — the main search box filters title/artist/album
  locally as you type.

**Empty/loading/error:** skeleton rows while the remote catalogue loads; designed
empty-library state with an “Add local audio” CTA; retryable error state when the
catalogue is unreachable.

## Search

### Local search

The search tab filters the whole library by title, artist, album, film, or genre.
Search categories and shortcuts (All, Favorites, Recently played, Local files)
scope library results; category shortcuts do not masquerade as a search for unsupported
content. Search copy describes the Aura library rather than podcasts.

Search is deliberately library-only. New music enters through the Discord
submission pipeline, is reviewed/downloaded, and then appears in the shared
Aura catalogue. Requests are an intentional user action through
[AURA FARMER](https://github.com/angel2rider/AURA-FARMER), a separate repository;
an empty search never submits music or injects third-party previews.

## Playlists

- A dedicated Playlists destination is available on desktop and mobile, with
  create/rename/describe/delete, ordered tracks, an add-to-playlist picker, and
  suggestions from the existing library.
- Playback is a scoped collection: selecting a row establishes that playlist
  and position; Next, Previous, shuffle, repeat, natural end, media keys, and Up
  Next use the same personal playback domain.
- The version-2 store keeps `video:<videoId>` or `id:<trackId>` references plus
  title/artist/artwork snapshots. Canonical references resolve only by direct
  stable/source identity, never by a matching legacy alias or title/artist.
  Only unresolved `legacy:` placeholders get unique alias/metadata fallback.
   Old string-key playlists migrate without discarding unresolved entries;
   metadata edits do not become track identities. Migration happens only during
   an explicit mutation after the required verbatim backup; startup, previews,
   refreshes and library deletion never rewrite playlist bytes.
- Missing tracks are visible placeholders with remove/relink recovery. Export
  and import preserve their place in the order even if the receiving library
  does not yet contain the audio.
- Reorder with pointer interaction or keyboard-accessible move controls;
  removal affects the playlist only, never the source library.
- **Export** produces a versioned `.aura-playlist.json` file. Where the browser
  supports file sharing, the OS share sheet can send that same importable file;
  otherwise it downloads. Import previews the available/missing counts before
  creating a new local collection. The file contains references/metadata, not
  audio blobs or access credentials.
- Strict [playlist data parsing](../src/core/playlist-data.ts) rejects malformed,
  oversized, duplicate, or unsupported imports before mutation. Limits are
  16 MiB per import, 2,000 tracks per playlist and 200 collections. Corrupt or
  unsupported saved stores freeze writes and offer a raw recovery download;
  they are never replaced with an empty collection.
- Writes use Web Locks, or a short IndexedDB transaction coordination lock when
  Web Locks are unavailable. If neither safe mechanism is available, saving
  fails instead of performing an unsafe localStorage race. Storage events and
  BroadcastChannel refresh the overview, sidebar, open detail, and picker.
- Cross-tab playlist rename/order changes update the active collection without
  restarting the current audio. Deleting the playlist detaches playback as a
  labeled snapshot instead of preserving a stale collection ID.
- This is **same-origin browser synchronization**, not cloud or cross-device sync.
- There are no backend Public/Unlisted/Private ACLs or synchronized cloud
  collections. Existing privacy/year/shared metadata remains intact; explicit
  snapshot links and file exports transfer a copy.

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
- **Collection playback** — playlist, artist, and explicit ordered-collection
  selections establish an ordered playback context with a cursor, queue
  interruptions, and listening history. Reaching a playlist boundary never
  falls through to the global catalogue. Ordinary library/search selection
  keeps the existing fallback behaviour and retires artist playback.
- **Up Next / queue** — queued items interrupt without replacing the collection;
  Previous follows actual listening history, including those interruptions.
  Next after Previous replays future visits before pending queued items, and Up
  Next previews that same order. Visits carry stable track/override-anchor identity,
  so cursors rebase after shuffle or live reorder instead of trusting old indices.
   Reordering Up Next is temporary and does not rewrite a saved playlist.
   Handoffs, row selection, retirement and shuffle keep unheard interruptions,
   including those held in forward history. The preview limit is 4 phone / 30 desktop.
- **Seek** — range slider plus the mobile bottom-edge progress line; seeks work
  for the active, ready HTML audio or YouTube source. Pending YouTube reports
  time zero, rejects seeking and never resumes the previous HTML audio.
- **Shuffle/repeat** — shuffle remains within the active collection. Repeat
  cycles off → all → one, mirrored between full and mini players; manual Next
  remains a navigation action even when repeat-one is enabled. Initial repeat mode is all.
- **Volume** — persisted when “Remember volume” is enabled; muted state restores
  the previous level.
- **Media Session** — personal play/pause/previous/next/seek and metadata for HTML
  audio and YouTube. Live radio instead owns play/pause/stop and clears
  next/previous/seeks until personal playback regains ownership.
- **YouTube** — Aura never extracts or downloads YouTube audio; it plays the
  official iframe player in the full player. The iframe API is loaded on demand.
- **Autoplay policy** — rejected `play()` calls reset the UI instead of leaving a
  false “playing” state. HTML audio and YouTube natural end share collection
  traversal; room mode and live radio deliberately own their transport separately.
- **Archive streaming** — catalogue audio normally starts through `/api/audio`,
  which streams Hugging Face and optionally uses a server-configured OCI cache.
  Missing/partial cache configuration never prevents public archive playback.

## Experimental code, not shipped scope

Telepathy scoring/telemetry/API prototypes live under
[`experiments/telepathy/`](../experiments/telepathy/README.md). They are neither
imported by the listener app nor deployed as Pages Functions. Their Python suite
has an isolated offline runner; passing those research tests does not make the
recommendation feature integrated. Unused React wrapper/dependencies were
removed; the existing licensed vanilla canvas loader renderer remains.

## Radio

- Search stations via `de1.api.radio-browser.info` (top stations, name search,
  HTTPS/hide-broken filters), with native labeled Play buttons.
- Station and custom streams must have valid absolute, credential-free HTTP(S)
  URLs. Invalid input is rejected before disturbing playing audio; unsafe
  directory streams and optional homepage/favicon URLs are discarded.
- Selecting radio pauses personal audio and stops active/pending YouTube playback
  without consuming the personal queue or changing saved playlists. Artist
  transport retires with unheard interruptions retained; scoped playlist
  traversal and its listening history stay intact.
- Pause/resume/stop use request-generation and explicit-intent guards, so stale
  station promises/errors cannot overwrite a newer selection or revive a pause.
- Station metadata includes name, country, tags and artwork; a full radio player
  provides the vinyl animation and native labeled menu actions.
- Radio remains independent of tab changes. Foreground recovery uses the guarded
  request path only for previously playing, still-intended radio; explicit
  Pause/Stop cancels recovery. A restored station starts paused, never autoplaying
  a browser reload.
- Radio owns live Media Session play/pause/stop, clears next/previous/all seeks and
  position state, and restores personal handlers/metadata on Stop.
- Streams still need a supported codec/provider and compatible browser policy.
  HTTPS is preferred on secure pages; mixed-content/autoplay/codec failures show
  a retryable error rather than a false playing state. Real-device behavior needs
  the owner's smoke testing.

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

Create/join responses must be HTTP successes; `exists: false` stays on the join
screen with a clear error. WebSocket bases must be credential-free `ws:`/`wss:`
URLs before connection. Failed joins use the visible join banner.

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
- At 900 px and above, the full player is nonmodal and its docked Up Next
  companion is a region without `aria-modal`; Tab is untrapped. Phone overlays
  retain modal focus behavior.
- Active tabs expose `aria-current="page"`; icon-only controls have labels;
  cover images have alt text (empty for decorative art); form controls are
  labelled.
- Primary controls use visible keyboard focus and icon-only accessible names;
  playlist track activation and move/recovery actions are real button controls.
- Verify responsive layouts and interactions at desktop and 390 px mobile;
  live codec, mobile autoplay, provider availability, and external extension
  behavior still require deployment/device-specific smoke testing.
