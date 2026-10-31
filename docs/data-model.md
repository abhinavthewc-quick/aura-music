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
  url: string,                 // public HF resolve URL
  img: string,                 // paired cover URL or DEFAULT_COVER (data URI)
  favorite: boolean,           // rebuilt from likes
  isHf: true,
  size: number                 // bytes (tree metadata)
}
```

### Added, local and preview tracks

These live in `state.addedSongs` (or are pushed temporarily for previews) and
are merged after catalogue tracks by `rebuildSongs()`.

| Field | Applies to | Meaning |
| --- | --- | --- |
| `id` | all | Numeric timestamp id for added/local; `youtube-<videoId>` for YouTube playback; `<source>-<id>` for previews |
| `url` | manual/local | `http(s)` audio URL, or a `blob:` URL for local files |
| `img` | all | Cover URL, data URL (local tags), or `DEFAULT_COVER` |
| `isLocal` | local files | Audio blob is stored in IndexedDB |
| `isYouTube` | YouTube | Playback uses the official iframe player |
| `videoId` | YouTube/catalogue | 11-char YouTube id |
| `isOutsidePreview` | provider previews | Came from iTunes/Deezer/Audius/etc. |
| `missing` | local | Blob lookup failed at load; the row is kept but can’t play |

### Identity and dedupe

[`src/core/state.ts`](../src/core/state.ts):

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
| `auraSettings_v1` | settings | `{autoplayNext, rememberVolume, searchHistory, youtubeResults, reduceMotion}` |
| `auraTheme` | settings/bootstrap | `light` or `dark`; applied before first paint |
| `auraVolume` | mini-player | `0..1` string |
| `auraYoutubeApiKey` | settings | per-browser YouTube Data API key override |
| `auraJamendoClientId` | settings | per-browser Jamendo client id |
| `auraYtCache_v1` | search | `{ [query]: {t, items} }`, 12 h, max 40 entries |
| `auraSearchHistory_v1` | settings only | **Legacy/vestigial:** only removed, never written in the current build |
| `auraLikedSongs_v2` | state | `[{id,title,artist,img,videoId,url,isYouTube}]` |
| `recentlyPlayed` | library | last 10 `{id,title,artist,img}` |
| `addedTracks` | library | added/local track metadata (local `url` deliberately stripped) |
| `auraHfCatalog_v1` | catalog | `{tracks: [...], at: timestamp}` cache |
| `auraRadioPlaybackState_v1` | radio | `{url, station, playing, savedAt}` for resume |
| `auraRoomName_v1` | rooms | remembered listener name |
| `auraRecentRooms_v1` | rooms | `{ [roomId]: adminKey? }` for recent rooms |
| `auraSidebarCollapsed` | settings | `'1'`/`'0'` |
| `auraAmbientEffect_v1` | ambience | array of active effect keys, restored at boot |
| `auraAdmin_queue_v1` | admin | queued `{id, url, title, artist, ...}` |
| `auraAdmin_pat`, `auraAdmin_repo` | admin logout only | legacy keys, cleared but no longer written |

`auraJsonp_*` are temporary `window` callbacks for JSONP, not storage.
`auraGsiScript` is an element id used to avoid loading Google’s script twice.

### IndexedDB

| Database | Store | Contents |
| --- | --- | --- |
| `auraMusicDB` (v1) | `audioFiles` | `Blob` keyed by the local track id |

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
| `tab` | string | active home/search/library/radio/add tab |
| `updatedAt` | number | epoch **ms** of the last publish |

Published as `#auraPresence[data-*]`, `window.auraPresence`, and
`window.AuraPresence.getState()` (live position extrapolation). Full reader
contract: [presence.md](presence.md).

## Rooms data

Room state is not stored in the browser; it lives in the Durable Object and is
rebuilt on connect. Client-side room keys are only the name/recent-room map
above. The wire types are in
[`src/rooms/protocol.ts`](../src/rooms/protocol.ts) — see [rooms.md](rooms.md).

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
