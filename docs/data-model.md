# Data model

This document is the contract for everything that is persisted or exchanged
between Aura Music’s components. Change these shapes carefully: users keep
browser data and bucket files indefinitely.

## Track object

### Catalogue (bucket) tracks

Created in [`src/core/catalog.ts`](../src/core/catalog.ts):

```ts
{
  id: 'hf:<bucket path>',      // e.g. "hf:A. R. Rahman - Song [dQw4w9WgXcQ].opus"
  title: string,               // manifest t > parsed filename > cleaned
  artist: string,              // manifest a > parsed filename > "Unknown Artist"
  album: string,               // manifest al, else ''
  year: string,                // manifest y, else ''
  duration: number,            // seconds from manifest d, else 0
  videoId: string,             // trailing [11-char id], else ''
  url: string,                 // /api/audio?path=<encoded key>
  hfUrl: string,               // direct public HF resolve fallback
  hfPath: string,              // decoded archive object key
  img: string,                 // paired cover URL or DEFAULT_COVER (data URI)
  favorite: boolean,           // rebuilt from likes
  isHf: true,
  size: number                 // bytes (tree metadata)
}
```

### Legacy added and local tracks

Older clients' URL/local metadata remains supported in `state.addedSongs`.
The listener can import audio from this device and restore a missing local blob;
filename-based metadata is stored with the blob. Shared catalogue acquisition
remains the Discord/admin pipeline, not a public URL/provider ingestion surface.

| Field | Applies to | Meaning |
| --- | --- | --- |
| `id` | all | Numeric timestamp id for added/local; `youtube-<videoId>` for YouTube playback; `<source>-<id>` for previews |
| `url` | manual/local | `http(s)` audio URL, or a `blob:` URL for local files |
| `img` | all | Cover URL, data URL (local tags), or `DEFAULT_COVER` |
| `isLocal` | local files | Audio blob is stored in IndexedDB |
| `isYouTube` | YouTube | Playback uses the official iframe player |
| `videoId` | YouTube/catalogue | 11-char YouTube id |
| `missing` | local | Blob lookup failed at load; the row is kept but can’t play |

### Catalogue dedupe versus durable references

The catalogue's cross-source dedupe still uses

```ts
trackKey(song) =
  song.videoId ? 'vid:' + videoId
               : 'lk:' + lowercase(title) + '|' + lowercase(artist)
```

- One song is one entry regardless of source (bucket, manual, YouTube, local).
- Bucket entries win collisions; an added duplicate’s `favorite` flag is copied
  onto the bucket entry.
- The catalogue itself also collapses an uploaded file without a video id onto
  the same-titled entry that has one.
- Likes match by numeric/string id first, then by `title|artist`
  (`likeKey`), so likes survive a move from the old hard-coded catalogue.
- `HIDDEN_TRACK_PATTERNS` in `catalog.ts` hides known duplicates by their
  bracketed video id; hidden entries are filtered from fresh and cached lists.

## Durable reference boundary

`trackKey()` is a **dedupe/migration heuristic**, not an immutable playlist
primary key. Version-2 playlists store `video:<videoId>` when available, otherwise
`id:<trackId>`, with display snapshots and optional legacy aliases. Metadata
edits therefore do not erase membership. Canonical `id:`/`video:` references
resolve only to direct stable/source identity; a changed or missing source ID
stays unavailable, even if a legacy alias or title/artist matches another song.
Only unresolved `legacy:` placeholders can use unique alias/metadata fallback.
Removing, relinking or restoring an entry is explicit. Do not persist a rendered
global array index as a track reference.

## Bucket layout

Bucket: `Angelrider/sonora` (public read).

```text
Angelrider/sonora/
├── Artist - Song [dQw4w9WgXcQ].opus        # audio (Opus preferred)
├── Artist - Song [dQw4w9WgXcQ].webp        # cover art (same basename)
├── Artist - Song [dQw4w9WgXcQ].jpg/png     # alternatives
├── Other Artist - Track.mp3                # hand upload, no video id
├── Other Artist - Track.webp
└── manifest.json                           # metadata keyed by video id
```

Conventions:

- The trailing ` [11-char-id]` is the **canonical identity** and is used by
  dedupe, manifest lookup and the site’s “already uploaded” checks.
- Covers pair by **basename**, case-insensitively, ignoring the extension.
- Filenames follow `Artist - Title [id].ext`; `Artist - Topic - Title` is
  normalised so the artist stays one segment.
- `downloads/` sidecars (`*.info.json`) are excluded by the upload workflow.
- Audio extensions recognised by the site: `.mp3 .opus .webm .m4a .flac .wav
  .aac .ogg`; covers: `.jpg .jpeg .png .webp .gif`.
- The bucket tree API returns 1000 files per page; clients follow the
  `Link: rel="next"` cursor (max 20 pages) instead of stopping at page one.

### `manifest.json`

Written by the upload workflow (`scripts/build_manifest.py`) and by admin
“edit metadata” (staged + `manage-music.yml`):

```json
{
  "v": 1,
  "tracks": {
    "dQw4w9WgXcQ": {
      "t": "Song Title",
      "a": "Artist Name",
      "al": "Album",
      "y": "1987",
      "d": 213.4
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `t` / `a` / `al` | cleaned title / artist / album |
| `y` | year (string) |
| `d` | duration in seconds (number) |

Priority when both sources exist: **manifest** → filename parse → defaults.
The manifest is cached for 30 s in the admin Function and in the browser’s
`auraHfCatalog_v1` cache; the tree itself is cached for 60 s server-side.

### Cleaning rules

- `cleanArtist`: strips YouTube’s auto-generated `- Topic` suffix.
- `cleanTitle`: removes `(Official Video)`, `[Lyrics]`, `(Official Audio)`,
  `【MV】`, resolution tags, trailing “- Lyrics”, and normalises full-width
  quotes/brackets. It keeps meaningful parts like years, `(From …)` credits and
  `(Remix)`.
- Default cover is a small inline SVG vinyl (`DEFAULT_COVER`), reused whenever
  artwork is missing or fails.

## Browser storage

### localStorage

| Key | Written by | Shape / purpose |
| --- | --- | --- |
| `auraSession_v2` | `session.ts`, login | `{email, name, picture, exp, token}`; token is a Google ID token or `v1.<exp>.<hmac>` admin session |
| `auraProfiles_v1` | `session.ts` | `{ [email]: username }` |
| `auraLocalAccounts_v1` | `local-auth.ts` | `{ [email]: { salt, hash, createdAt } }` (PBKDF2-SHA256, 150k) |
| `auraUserName` | login/settings | display name |
| `auraFirstLogin`, `auraLastLogin` | login/app | ISO timestamps for the profile popover |
| `auraSettings_v1` | settings | `{autoplayNext, rememberVolume, reduceMotion}` |
| `auraTheme` | settings/bootstrap | `light` or `dark`; applied before first paint |
| `auraVolume` | mini-player | `0..1` string |
| `auraLikedSongs_v2` | state | `[{id,title,artist,img,videoId,url,isYouTube}]` |
| `recentlyPlayed` | library | last 10 `{id,title,artist,img}` |
| `addedTracks` | library | added/local track metadata (local `url` deliberately stripped) |
| `auraPlaylists` | playlists | `{version:2,revision,playlists:[{schemaVersion:2,id,title,description,createdAt,updatedAt,tracks:[ref snapshot]}]}`; strict parsing/migration preserves unresolved entries |
| `auraPlaylists_backup_v1` | playlist migration | best-effort original legacy payload backup for recovery |
| `aura_play_counts_v1` | state/library | track-id/legacy-key play counts; ranking data, not playlist identity |
| `auraHfCatalog_v1` | catalog | `{tracks: [...], at: timestamp}` cache |
| `auraRadioPlaybackState_v1` | radio | `{url, station, playing, savedAt}`; remembers a validated selection, restored paused |
| `auraRoomName_v1` | rooms | remembered listener name |
| `auraRecentRooms_v1` | rooms | `{ [roomId]: adminKey? }` for recent rooms |
| `auraSidebarCollapsed` | settings | `'1'`/`'0'` |
| `auraAmbientEffect_v1` | ambience | array of active effect keys, restored at boot |
| `auraAdmin_queue_v1` | admin | queued `{id, url, title, artist, ...}` |
| `auraAdmin_pat`, `auraAdmin_repo` | admin logout only | legacy keys, cleared but no longer written |

`auraJsonp_*` are temporary `window` callbacks for JSONP, not storage.
`auraGsiScript` is an element id used to avoid loading Google’s script twice.

### Playlists and export files

The `auraPlaylists` key remains readable for existing users, but its value now
has an explicit store version and per-playlist schema version:

```ts
interface PlaylistStore {
  version: 2;
  revision: number;
  playlists: Array<{
    schemaVersion: 2;
    id: string;
    title: string;
    description: string;
    createdAt: number;
    updatedAt: number;
    tracks: Array<{
      ref: string;              // video:<videoId>, id:<trackId>, or unresolved legacy reference
      legacyKey?: string;       // old vid:/lk: migration alias
      source?: 'local' | 'catalog' | 'youtube' | 'added';
      title: string;
      artist: string;
      img: string;
      duration: number | string;
    }>;
  }>;
}
```

The ref is identity; title/artist/artwork/duration are snapshots for display and
recovery. Canonical `id:`/`video:` references resolve only by direct stable/source
identity, never by title/artist or `legacyKey`. Only unresolved `legacy:`
placeholders may use a unique legacy alias and then a unique non-local metadata
match. References marked `source: 'local'` stay direct-only. Unknown/removed
tracks and missing local blobs remain visible in their ordered position;
removing, relinking or restoring a file is explicit.

[The strict data module](../src/core/playlist-data.ts) validates version, types,
IDs, references, lengths and limits. Imports are capped at 16 MiB and 2,000 tracks
per playlist; duplicates and unsupported versions are rejected before mutation.
The store holds at most 200 playlists. A corrupt/unsupported saved payload freezes
writes and offers a raw recovery copy instead of being normalized into empty storage.

Legacy array stores with string keys migrate under the same safe write lock,
with a best-effort original-payload backup in `auraPlaylists_backup_v1`. Migration
is prepared before track metadata edits so old title/artist aliases resolve
before those values change. Do not erase unresolved entries or infer that a
`privacy` field enforced an ACL; no playlist ACL/backend exists. All data is
browser-profile-local, not a per-user cloud table.

Web Locks serialize read-modify-write operations; browsers without Web Locks
use a short IndexedDB readwrite transaction coordination lock. If neither safe
mechanism exists, saving fails rather than racing localStorage. `revision`
identifies the stored change, and storage events/BroadcastChannel refresh other
same-origin tabs. Active name/order changes reconcile without restarting audio;
a deleted playlist detaches as `Deleted playlist (playback copy)`. None of this
is cloud/cross-device synchronization. Export before clearing browser data.

The transfer file is:

```json
{
  "format": "aura-playlist",
  "version": 2,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "playlist": {
    "schemaVersion": 2,
    "id": "pl_example",
    "title": "Night listening",
    "description": "",
    "createdAt": 1767225600000,
    "updatedAt": 1767225600000,
    "tracks": [
      {
        "ref": "id:hf:Artist - Song.opus",
        "title": "Song",
        "artist": "Artist",
        "img": "",
        "duration": 213
      }
    ]
  }
}
```

It contains ordered track references/metadata, **not audio blobs, secret keys,
account credentials, or sharing permissions**. The export can be downloaded or
sent through browser-supported file sharing. Import previews available/missing
tracks and creates a new local playlist ID; unmatched tracks stay recoverable.
A file transfer is not a public/private link or automatic cross-device sync.

### Personal playback context (in memory)

The active context is separate from persisted playlist data:

```ts
{
  source: 'library' | 'playlist' | 'artist' | 'search' | 'manual',
  collectionId?: string,
  label?: string,
  order: TrackId[],           // canonical collection snapshot
  playOrder: TrackId[],       // effective shuffled/temporary traversal
  cursor: number,
  currentId: TrackId,
  queue: TrackId[],           // explicit interruptions, not the collection
  history: PlaybackVisit[],
  future: PlaybackVisit[],
  overrideActive: boolean
}
```

`state.repeatMode` is `off | all | one`; shuffle operates only within this
collection. A visit is:

```ts
interface PlaybackVisit {
  id: string;
  cursor: number;
  override: boolean;
  anchorId?: string;           // stable collection anchor for a queued interruption
}
```

Previous follows actual listening history, including queued interruptions.
When a visit is restored, its cursor is rebased against the current `playOrder`
by track identity, or by `anchorId` for an override; an old array index is not
trusted after shuffle or live playlist reorder. Natural end and manual navigation
share the same domain, but repeat-one applies only to natural end. YouTube/HTML
audio are playback backends, not different collection types; radio and rooms keep
separate live/server-authoritative transport.

### Radio playback memory and ownership

`auraRadioPlaybackState_v1` remembers `{url, station, playing, savedAt}`. Station
stream/homepage/favicon URLs are validated as absolute, credential-free HTTP(S)
URLs; invalid custom streams cannot change the active audio source. Restoring a
station restores its selection **paused**, not an autoplay permission.

Radio's request generation and explicit playback intent are in-memory state,
not saved playlist data. Stale station play promises/errors cannot change a newer
selection. Radio owns live play/pause/stop Media Session handlers and clears
next/previous/seeks and position state; Stop restores personal handlers/metadata.
Foreground recovery uses the guarded request path only for previously playing,
still-intended radio. Explicit Pause/Stop cancels recovery and queued play intent.

### IndexedDB

| Database | Store | Contents |
| --- | --- | --- |
| `auraMusicDB` (v1) | `audioFiles` | `Blob` keyed by the local track id |
| `auraPlaylistCoordination` (v1) | `writes` | short readwrite transaction coordination lock; no playlist data |

Local import validates supported audio types and a 250 MiB per-file limit,
stores the blob, and derives title/artist from `Artist - Title.ext` or the file
name. It does not fetch an external metadata/tagging provider. **Restore local
file** replaces a missing blob under the existing identity and snapshots.

`persistAddedSongs()` strips the session-only blob URL before writing
`addedTracks`; on boot `hydrateLocalTracks()` looks up blobs, recreates
`URL.createObjectURL(file)` URLs, and marks entries `missing` when the blob is
gone.

### Session and auth

- Google ID token: ~1 h lifetime; verified in the browser with Google’s JWKS and
  again server-side for admin calls.
- Site session `exp`: 7 days (`SESSION_TTL_SEC`); refreshed on a new sign-in.
- Admin fallback token: `v1.<unix-exp>.<base64url-HMAC>` keyed on `GH_TOKEN`,
  valid 7 days.
- Removing `auraSession_v2` (or logging out) clears the site session; admin
  sessions are invalidated by rotating `GH_TOKEN`.
- Local accounts are **per browser profile**; they do not sync anywhere.

## Presence contract

[`src/core/presence.ts`](../src/core/presence.ts) publishes:

| Field | Type | Notes |
| --- | --- | --- |
| `v` | number | schema version (1) |
| `site` | string | `"Aura Music"` |
| `kind` | `'idle' \| 'track' \| 'radio'` | |
| `title`, `artist`, `album` | string | display values |
| `cover` | string | absolute `http(s)` URL or `''` |
| `url` | string | canonical item URL (YouTube watch page for YT) |
| `link` | string | deep link that plays this exact item in Aura |
| `videoId` | string | 11-char id or `''` |
| `duration`, `position` | number | seconds; `0` for live radio |
| `playing` | boolean | |
| `live` | boolean | radio/live |
| `tab` | string | active listener destination (home/search/library/playlists/radio) |
| `updatedAt` | number | epoch **ms** of the last publish |

Published as `#auraPresence[data-*]`, `window.auraPresence`, and
`window.AuraPresence.getState()` (live position extrapolation). Full reader
contract: [presence.md](presence.md).

## Rooms data

Room state is not stored in the browser; it lives in the Durable Object and is
rebuilt on connect. Client-side room keys are only the name/recent-room map
above. The wire types are in
[`src/rooms/protocol.ts`](../src/rooms/protocol.ts) — see [rooms.md](rooms.md).
Create/join checks the HTTP response before consuming service data; `exists: false`
means no join. WebSocket bases must be credential-free `ws:`/`wss:` URLs before
transport creation. Failures appear in the visible `joinBanner` while joining,
or the room banner once the room view is visible. These client checks do not
verify a deployed Worker, authentication or multi-device clock/audio behavior.

## Admin queue

`auraAdmin_queue_v1` is an array of:

```ts
{
  id: string,          // YouTube video id
  url: string,         // watch URL
  title: string,
  artist: string,
  album?: string,
  addedAt: number
}
```

It persists across admin reloads; the server independently dedupes against the
bucket at dispatch time, so a stale queue cannot upload the same video twice.

## Backward-compatibility rules

1. **Never change a key’s meaning without a version bump** (`*_v2`, …) and a
   migration. Users may keep data for years.
2. Keep reading old shapes defensively; the code already tolerates missing
   fields (e.g. cached covers, old likes matched by title/artist).
3. Bucket files are the durable source of truth for the library; browser caches
   may be dropped at any time and rebuilt.
4. `manifest.json` additions must stay backward compatible: readers ignore
   unknown keys and fall back to filename parsing.
5. The presence schema can add fields; bump `v` only when an existing field
   changes meaning, and update the PreMiD activity in the same change.
