# Architecture

Aura Music is deliberately small in infrastructure and slightly unusual in
structure: a static multi-page Vite app with a handful of companion services,
no application server for normal playback, and browser storage as the only
personal database. This document explains the moving parts and why they are
shaped that way.

## Design constraints

1. **Playback is client-side.** The site streams audio directly from public
   bucket URLs and YouTube's official embedded player. There is no media proxy.
2. **Personal data stays in the browser.** Likes, local uploads, queue state,
   playlists, preferences and profile names live in `localStorage`/IndexedDB.
   There is no user table anywhere.
3. **The library is a bucket, not a database.** Tracks are files in a Hugging
   Face bucket; `manifest.json` adds cleaned metadata keyed by YouTube video id.
   Admin-owned artist metadata lives separately in [D1](artist-storage.md).
4. **The admin panel is a remote control.** It never handles audio bytes; it
   dispatches GitHub Actions that do the downloading/uploading.
5. **Real-time rooms are a separate deployable.** Cloudflare does not allow a
   Durable Object inside a Pages project, so `rooms-worker/` is its own Worker.
6. **Public Search is library-only.** Ingestion starts with intentional Discord
   submissions through [AURA FARMER](https://github.com/angel2rider/AURA-FARMER),
   maintained in a separate repository.
7. **Black is the canvas.** The UI uses `#000`, neutral controls, artwork colour
   and locally bundled fonts/icons.

## Entry points

Vite builds three HTML documents, each with its own dependency graph:

```mermaid
flowchart LR
  A[index.html] --> A1[src/main.ts]
  A1 --> A2[session / login / bootstrap]
  A2 -->|valid session: lazy import| A3[src/runtime.ts]
  A3 --> A4[app / expose / features / mini-player / a11y]
  B[admin.html] --> B1[src/admin/main.ts]
  B1 --> B2[core/config, core/session, core/google-auth]
  C[rooms.html] --> C1[src/rooms/page.ts]
  C1 --> C2[roomClient, syncEngine, audioEngine, wsTransport]
```

| Entry | URL | Audience |
| --- | --- | --- |
| `index.html` | `/` | Listener app |
| `admin.html` | `/admin` (Pages pretty URL) | Owner-only library/download panel |
| `rooms.html` | `/rooms` | “Listen Together” join/room page |

Pages redirects `*.html` to the clean URL (e.g. `/rooms.html` → 308 →
`/rooms`). Links in the app use `/rooms` and `/admin` accordingly.

## Boot sequence (main app)

```text
index.html
  ├─ entry.css + local fonts
  ├─ saved-session paint hint + reload fallback
  └─ /src/main.ts
       ├─ core/session + ui/login
       └─ core/bootstrap.loadApplication() [valid session]
            └─ lazy /src/runtime.ts
                 ├─ main.css + icons.css
                 ├─ expose / loader / mini-player / a11y / presence-reporter
                 └─ app.ready: local hydration + initial render
```

The HTML hint recognizes a well-formed, unexpired `auraSession_v2` for first
paint; `main.ts` rechecks it through `getSession()`. Signed-out visits remain in
the lightweight entry UI. Returning listeners and successful sign-ins use the
same guarded `loadApplication()` promise. The music app stays hidden/inert until
its runtime is ready and the session is checked again.

Failed startup exposes a status message and **Reload Aura**. A 15-second
recovery path also covers a stalled entry/runtime download; malformed or expired
sessions return to sign-in. This is separate from catalogue retry after entry.

`app.ts` hydrates local tracks and paints cached data, then applies a received
playlist preview or `?play=` link. Catalogue refresh runs in the background and
reconciles the lists; failure exposes the library retry state. Playlist fragments
survive sign-in and take priority over a combined `?play=` parameter. The entry
stays independent of the music store; `runtime.ts` owns the full-app imports.

## Module map

### `src/core/`

| Module | Responsibility |
| --- | --- |
| `config.ts` | Site constants: Google client id and admin allow-list |
| `bootstrap.ts` | Guarded lazy runtime load and ready/session checks |
| `state.ts` | Single mutable `state` object, favourites, catalogue rebuild |
| `trackIdentity.ts` | Stable track keys and legacy-key matching, re-exported by state |
| `catalog.ts` | HF tree/manifest/cache, artist-directory refresh and attribution overrides |
| `artistIdentity.ts`, `artistAliases.ts`, `artistGroups.ts` | Shared read-side artist resolution, reviewed aliases and group construction |
| `playlist-sharing.ts` | Bounded snapshot codec, URL construction, omissions and recipient library matching |
| `session.ts` | Google session, 7-day token exchange, per-email usernames |
| `google-auth.ts` | Browser-side Google ID-token verification (RS256/JWKS) |
| `local-auth.ts` | Device-local PBKDF2 email/password accounts |
| `presence.ts` | Discord presence bridge: `#auraPresence`, `window.auraPresence`, `AuraPresence.getState` |
| `dom.ts` | Formatting, toast, empty/error state markup, image fallback, YouTube oEmbed metadata |

### `src/features/`

| Module | Responsibility |
| --- | --- |
| `player.ts` | HTML audio playback, YouTube IFrame player, seek/volume, dynamic colours, Media Session |
| `queue.ts` | Up-next queue, play next/previous, track sheet actions, queue persistence in memory |
| `library.ts` | Library/home song lists, legacy saved-track hydration, likes, stats, catalogue retry |
| `search.ts` | Aura catalogue filtering and search categories |
| `playlists.ts` | Browser-local playlist CRUD, inline sharing, received previews and explicit local imports |
| `radio.ts` | radio-browser search, station playback, custom streams, radio sheet |
| `home.ts` | Greeting, quick-access tiles, Aura Picks, artist spotlight |
| `ambience.ts` | Web Audio ambient layers, spatial/muffle effects, focus timer |
| `settings.ts` | Settings modal, help, profile popup, sidebar and preference storage |
| `deeplink.ts` | Playback query links and `#playlist=` previews, including later hash arrivals |
| `presence-reporter.ts` | Samples the player and publishes the presence contract once per second/event |

### `src/ui/`

| Module | Responsibility |
| --- | --- |
| `loader.ts` | Intro orb and full-screen loader lifecycle |
| `login.ts` | Google GIS, username picker, email/password fallback |
| `nav.ts` | Tabs, mobile indicator, `aria-current`, lazy radio loading |
| `mini-player.ts` | Desktop bottom bar, seek/volume, shuffle/repeat mirrors |
| `a11y.ts` | Global overlay Escape, Tab trapping, focus restore, Enter/Space activation |

### Backend and companions

| Path | Responsibility |
| --- | --- |
| `functions/api/admin.ts` | Authenticated admin API: search, bucket mutations, workflow dispatch, secrets |
| `functions/api/artists.ts`, `functions/api/artist-image.ts` | Public artist metadata/images and authenticated admin edits backed by D1 |
| `functions/api/rooms.ts` | Thin Pages proxy to the rooms Worker; adds share URLs |
| `rooms-worker/src/index.ts` | Worker routing, room id/admin key minting, CORS |
| `rooms-worker/src/room.ts` | Durable Object plumbing: sockets, persistence, alarms |
| `src/rooms/referee.ts` | Room rules, shared verbatim between DO and browser dev harness |
| `src/rooms/*` | Client transport, clock sync, sync engine, WebAudio target, page controller |
| `src/rooms/presentation.ts`, `src/rooms/sessionAudio.ts` | Invite/status presentation and session-owned audio lifecycle |
| `scripts/*.py` | Upload pipeline: tag repair and manifest generation |
| `premid/*` | PreMiD activity source + setup |

## Data flow

```mermaid
flowchart TD
  HF[(Hugging Face bucket\nAngelrider/sonora)] -->|tree + manifest.json| CAT[core/catalog.ts]
  CAT -->|tracks| ST[core/state.ts]
  ST -->|render| UI[home / library / search / player]
  UI -->|play| AUDIO[HTMLAudioElement]
  UI -->|YouTube track| YT[YouTube IFrame API]
  UI -->|radio station| RADIO[radioAudio]
  UI -->|song data| PRES[presence bridge]
  PRES -->|DOM + window| PMD[PreMiD activity]
  PMD -->|OAuth activities.write| DISC[Discord]

  ADMIN[admin.html] -->|POST /api/admin| FN[Pages Function]
  FN -->|dispatch| GHA[GitHub Actions]
  GHA -->|yt-dlp + ffmpeg| HF
  FN -->|batch copy/delete| HF
```

### Catalogue load

1. At import, `state.hfSongs` is hydrated from `localStorage` cache.
2. The UI paints cached/local tracks immediately.
3. `fetchHfCatalog()` lists bucket files (paged via `Link: rel="next"`, max 20
   pages), reads `manifest.json`, pairs covers by basename, dedupes by song and
   writes the cache.
4. `setHfTracks()` merges in manually added/local tracks, preserves the current
   song by id then by identity key, and re-renders.
5. Failure keeps the cached list (if any) and exposes a retry state when the
   list is empty.

### Artist identities

Home, Library, artist pages, portraits and counts share one grouping snapshot.
The resolver prefers admin-owned aliases and intentional attribution corrections,
then conservative formatting and reviewed equivalents. Ambiguous owners remain
separate; supported collaboration credits can reference one recording from
multiple artist groups. Display grouping does not replace persistent track keys
or restart audio. See [Artist storage](artist-storage.md#read-side-artist-identity).

### Playlist snapshots

Sharing serializes an allowlisted version-1 snapshot as base64url UTF-8 JSON in
`/#playlist=…`. Limits are 100 tracks including omission counts and 16 KiB decoded
JSON. The fragment carries title/description, track labels/stable keys and counts;
it excludes media/artwork URLs, local audio identifiers and account data. It is
readable by anyone with the link but is not sent as part of the HTTP request.

`deeplink.ts` validates the fragment and `playlists.ts` renders a read-only preview
in `#tabPlaylist`. Explicit Save writes a private copy to `auraPlaylists`,
deduplicating stable keys and retaining missing-track metadata for later library
resolution. Sharing feedback is inline in `#playlistSharePanel`. Preview/import
does not trigger playback, remote discovery, downloads or submissions. See
[Features](features.md#sharing-a-playlist) for the sender and recipient flow.

## Rendering model

There is no framework and no virtual DOM:

- Feature modules render HTML strings into stable containers.
- Inline `onclick`/`oninput` handlers are used in the markup. Every function they
  reference is assigned to `globalThis` in [`src/expose.ts`](../src/expose.ts).
- New dynamic text **must** be escaped with `escapeHtml()` (from `core/dom.ts`,
  re-exported by `features/radio.ts` for legacy imports) before it enters an
  HTML string. Attributes need the same treatment.
- Keyboard behaviour is centralized in [`src/ui/a11y.ts`](../src/ui/a11y.ts):
  overlays expose `[aria-modal="true"]`, rows/cards use
  `role="button" tabindex="0"`, and Escape closes only the top overlay.
- CSS is one cascade: [`src/styles/main.css`](../src/styles/main.css) imports
  every stylesheet in order; later files intentionally override earlier ones
  (`overrides-*.css`). Add new page styles near the end rather than relying on
  `!important` in a random file.
- Images get `alt`, `loading="lazy"` and `decoding="async"` unless they are
  above the fold. Failed covers fall back to the vinyl `DEFAULT_COVER` via one
  capture-phase error listener.

## Playback paths

| Source | Engine | Progress / seek | Notes |
| --- | --- | --- | --- |
| Bucket track | `HTMLAudioElement` (`#audioPlayer`) | native `currentTime` / `duration` | streams public bucket URLs |
| Local upload | `HTMLAudioElement` + IndexedDB blob | same | blob URL is session-only |
| Manual URL | `HTMLAudioElement` | same | must be `http(s)` |
| YouTube | official IFrame Player API | `getCurrentTime()` polled every 500 ms | audio is never extracted |
| Radio | separate `Audio` object | live; no duration | radio-browser.info or custom URL |
| Listen Together | Web Audio `AudioBufferSourceNode` | scheduled clock / explicit seek | separate page and bundle |

Media Session metadata is updated for the main player and radio, so OS media
keys and lock-screen controls work without any server involvement.

## Presence bridge

The player mirrors “what is playing” into three representations so a browser
extension does not have to scrape the UI:

1. hidden `#auraPresence[data-*]` attributes,
2. `window.auraPresence` (plain object),
3. `window.AuraPresence.getState()` (live position).

The PreMiD activity reads whichever layer is available. The contract is
documented in [presence.md](presence.md); the site-side implementation lives in
[`src/core/presence.ts`](../src/core/presence.ts) and
[`src/features/presence-reporter.ts`](../src/features/presence-reporter.ts).

## Backends

| Endpoint | Host | Purpose |
| --- | --- | --- |
| `/api/admin` | Pages Function | authenticated admin actions (no GET) |
| `/api/rooms` | Pages Function → Worker | create/join room, WebSocket upgrade, share URLs |
| `https://aura-rooms.<subdomain>.workers.dev` | Worker + Durable Object | room authority |
| `huggingface.co/api/buckets/.../tree` | HF | catalogue listing |
| `huggingface.co/buckets/.../resolve/...` | HF | audio/cover/manifest bytes |
| `de1.api.radio-browser.info` | public API | radio directory |

Google sign-in verifies ID tokens twice: once in the browser against Google's
JWKS ([`google-auth.ts`](../src/core/google-auth.ts)) and again in the Pages
Function before any GitHub call. The admin panel allow-list is duplicated in
`src/core/config.ts` and `functions/api/admin.ts`; update both.

## Build output

`npm run build` produces:

```text
dist/
├── index.html
├── admin.html
├── rooms.html
├── assets/main-*.js      # sign-in/session entry
├── assets/runtime-*.js   # lazy signed-in runtime
├── assets/admin-*.js
├── assets/rooms-*.js
├── assets/*.css          # entry/runtime/page styles
├── aura-logo.png         # copied from public/
└── aura-thumbnail.png
```

`public/` is copied verbatim (stable URLs for the PreMiD activity). The unused
`src/assets/hero-vinyl.png` is **not** in the bundle; Vite only emits imported
assets. Fonts and icons are bundled locally under `assets/`.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| Catalogue unreachable, no cache | Skeleton → error state with **Try again** → retry action |
| Catalogue unreachable, cache exists | Cached tracks remain; toast explains |
| Broken cover | Capture-phase error listener swaps in the vinyl placeholder |
| Audio error / autoplay block | UI resets, toast explains; `play()` rejections are caught |
| Public Search has no matches | Local empty state; search filters the loaded library only |
| Playlist link invalid / storage unavailable | Visible preview/import error; saving remains an explicit action |
| Native share / clipboard unavailable | Inline status with copy/manual-copy fallback; cancellation stays distinct |
| YouTube API blocked | Embedded player error is caught and shown as a toast |
| Rooms disconnect | Client reconnects with backoff; sync engine pauses and re-converges |
| Entry/runtime fails or stalls | Loading status exposes **Reload Aura**; an invalid session returns to sign-in |

## Key design decisions

| Decision | Reason |
| --- | --- |
| Vanilla TS + inline handlers | The app grew from a single HTML file; `expose.ts` keeps that model working without a framework refactor. |
| Static SPA, no app server | Playback and library reads are public; only admin mutations need a server. |
| Bucket + manifest instead of a DB | Cheap, simple, and the upload pipeline already produces files; metadata is keyed by video id. |
| GitHub Actions for ingestion | Downloading/tagging is batch work with ffmpeg/yt-dlp, not something a Pages Function can do. |
| Separate rooms Worker | Cloudflare does not allow a Durable Object in a Pages project. |
| Web Audio for rooms | `<audio>` updates in ~33 ms steps and hides output latency; `AudioContext` allows scheduled starts and rate nudges. |
| Presence bridge instead of DOM scraping | UI restyles cannot break the Discord status. |

## Related reading

- [Features](features.md) for the user-facing behaviour.
- [Data model](data-model.md) for track/bucket/storage shapes.
- [Artist storage](artist-storage.md) for identity resolution and metadata ownership.
- [Rooms](rooms.md) for the real-time subsystem.
- [Public resource discovery](discovery.md) for navigation documents and public read access.
- [Deployment](deployment.md) for the Pages/Worker topology.
