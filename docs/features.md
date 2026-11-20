# Features

This documents the supported listener surfaces and their local-first boundaries.
It is not a claim that every third-party provider or live deployment was tested.
See [remediation](remediation.md) for the verification gate and infrastructure
work that cannot be completed by a source-only change.

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
- **Quick access**: liked music, resume/shuffle, recently played, and shortcuts
  into the available library views.
- **Soundscape** card opens the ambience/effects panel.
- **Aura Picks**: eight seeded picks, refreshed when the catalogue grows or the
  user presses “Refresh mix”. Designed empty state when the library is empty.
- **More from**: an artist spotlight for every artist with at least two tracks,
  merged across spelling variants (`A. R. Rahman` / `A.R. Rahman` / `… - Topic`).
- All sections are rebuilt in a single animation frame per change
  (`updateLibCount` batches the home paint).

## Library

Four views share the library data:

- **Tracks** — the full list (catalogue + added/local tracks), virtual one row
  per song, heart and “…” actions.
- **Artists** — grouped by normalised artist name; group play starts a scoped
  artist collection instead of falling through to unrelated library tracks.
- **Albums** — grouped by album metadata from `manifest.json`.
- **Films** — extracts `(From "Film")` credits from titles/albums.

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
- **Search within the library** — the search bar at the top of Home filters
  title/artist/album locally as you type, with results opening underneath it.

**Empty/loading/error:** skeleton rows while the remote catalogue loads; designed
empty-library state with a “Find music” CTA that opens the search field; retryable error state when the
catalogue is unreachable.

## Search

### Local search

There is no separate Search destination. One field sits at the top of Home and
its results open directly below it, so searching never leaves the page you were
on. It filters the whole library by title, artist, album, film, or genre in
30-row pages; the All, Favorites, Recently played, and Local files tiles scope
results when the field is empty. Category shortcuts do not masquerade as a
search for unsupported content, and the copy describes the Aura library rather
than podcasts.

Search is deliberately library-only. New music enters through the Discord
submission pipeline, is reviewed/downloaded, and then appears in the shared
Aura catalogue; search never injects previews from third-party catalogues.

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
  metadata edits do not become track identities.
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
- There are no backend Public/Unlisted/Private ACLs or permanent share links.
  Collections stay in this browser until you explicitly transfer an export.

## Player

- **Mini player** (bottom dock on desktop / mobile dock) with title, artist,
  seek, previous/next, play/pause, like, shuffle and repeat.
- **Full player** opens from the mini player or a song; background gradients and
  control colours are derived from the cover art, contrast-checked against white
  text. Paused artwork uses a spring animation.
- **Collection playback** — library, playlist, artist, and scoped search
  selections establish an ordered playback context with a cursor, queue
  interruptions, and listening history. Reaching a playlist boundary never
  falls through to the global catalogue.
- **Up Next / queue** — queued items interrupt without replacing the collection;
  Previous follows actual listening history, including those interruptions.
  Next after Previous replays future visits before pending queued items, and Up
  Next previews that same order. Visits carry stable track/override-anchor identity,
  so cursors rebase after shuffle or live reorder instead of trusting old indices.
  Reordering Up Next is temporary and does not rewrite a saved playlist.
- **Seek** — range slider plus the mobile bottom-edge progress line; seeks work
  for HTML audio and YouTube.
- **Shuffle/repeat** — shuffle remains within the active collection. Repeat
  cycles off → all → one, mirrored between full and mini players; manual Next
  remains a navigation action even when repeat-one is enabled.
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
  without changing the personal collection, queue or listening history.
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

A room is a shared playback session: one admin controls the transport, everyone
hears the same track at the same moment, and listeners can chat and see the queue.
Rooms are a **separate page** (`/rooms`) with their own bundle and Web Audio
engine.

See [rooms.md](rooms.md) for the protocol, Durable Object, clock sync, drift
correction, grace period and local development harness. The short version:

- Create room → share link `/rooms?r=<id>`; the creator gets an admin key.
- Invitees join with the code/name. Create/join service responses must be HTTP
  successes; `exists: false` stays on the join screen with a clear error.
- WebSocket bases must be credential-free `ws:`/`wss:` URLs before connection.
  Failed joins show the visible join banner rather than an error hidden inside
  the room view.
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
| Reduce motion | off | adds `.aura-reduce-motion` (also honours OS preference) |
| Theme | dark | persisted in `auraTheme`, applied before first paint |
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
- Primary controls use visible keyboard focus and icon-only accessible names;
  playlist track activation and move/recovery actions are real button controls.
- Verify responsive layouts and interactions at desktop and 390 px mobile;
  live codec, mobile autoplay, provider availability, and external extension
  behavior still require deployment/device-specific smoke testing.
