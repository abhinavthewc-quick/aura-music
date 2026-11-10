# Troubleshooting

Start with the browser console and the Network tab; most failures are visible
there. This guide is ordered by symptom.

## Fast triage

| Symptom | First check |
| --- | --- |
| Startup does not finish | **Reload Aura**, Console errors and failed entry/runtime requests |
| Library empty | `state.catalogError`, Network request to `huggingface.co/api/buckets/.../tree` |
| A track won't play | Network request to the HF resolve URL; format; CORS; autoplay gesture |
| Search returns nothing | Confirm the track is in the loaded library; check query/category and catalogue loading |
| Shared playlist cannot open/save | Complete `#playlist=` fragment, size limits and browser storage |
| Admin returns 401/500 | Pages env `GH_TOKEN`/`GOOGLE_CLIENT_ID`; allow-list; session expiry |
| Rooms 503 | `ROOMS_WORKER_URL` in Pages env; worker deploy |
| Discord presence missing | PreMiD dev mode/account; CLI connection; site tab; presence attributes |

## App & loader

### Returning-session startup does not finish

1. A valid saved session shows **Restoring your session…** / **Getting your music
   ready…** while the signed-in runtime loads. A failure or a 15-second wait
   exposes **Reload Aura**, including when the entry module never downloads.
2. Use **Reload Aura** when the connection is available. Reloading retains
   browser-local playlists; clearing site data removes them.
3. Inspect Console and Network for a failed entry/runtime chunk or an import
   error. Verify `/src/main.ts` (dev) or the hashed entry and runtime assets
   (build); `npm run build` locally can identify broken imports.
4. Malformed, expired or unavailable `auraSession_v2` data returns to sign-in.
   The runtime rechecks the session before revealing the music app. Catalogue
   loading errors after entry use the library’s **Try again** action instead.
5. Hard-reload (Cmd/Ctrl+Shift+R) after a deploy; Pages serves HTML with
   `must-revalidate`, but an old service worker or cached asset can survive in a
   browser profile.

### An old light-theme preference has no effect

- Aura’s canvas is intentionally true black (`#000`), with neutral raised
  surfaces and artwork colour. Legacy `auraTheme` values and the OS light
  preference do not select another theme. If styling is missing, check the
  entry/runtime CSS and bundled font requests.

### “Something went wrong” toasts

- Most are recoverable: broken image (fallback), catalogue fetch failure
  (retry), autoplay rejection (press play), audio error (source blocked/removed).
- If a toast repeats in a loop, capture the console stack; the app’s per-module
  listeners are initialized once, so a loop usually means a retry timer.

## Authentication

### Google sign-in does nothing / shows a popup error

1. Check `GOOGLE_CLIENT_ID` in `src/core/config.ts` **and** the Pages env.
2. In Google Cloud Console, confirm the exact origin (`https://aura-music-01g.pages.dev`,
   `http://localhost:5173`, custom domain) is listed under **Authorized
   JavaScript origins**.
3. Third-party cookies / popup blockers can block Google One Tap; use the
   fallback “Google not working? Continue with email & password”.
4. If the browser console shows `session expired — sign in again`, the ID token
   is older than ~1 h and the 7-day exchange failed; sign in again.

### “This email is not allowed” (admin)

- The admin allow-list is duplicated:
  - `ADMIN_EMAILS` in `src/core/config.ts` (client hint)
  - `ALLOWED_EMAILS` in `functions/api/admin.ts` (server truth)
- Update **both**, redeploy the site and the Function.
- A normal Google account can still use the site; only admin endpoints are
  restricted.

### Email fallback account not found

- Local accounts are per browser profile. Clearing site data deletes them.
- Create an account first (“New here? Create an account”), then sign in.
- Registration hashes with PBKDF2; it does not need the network.

## Catalogue & library

### Library is empty, or shows “Couldn’t load your library”

1. In the console:
   ```js
   state.catalogLoading
   state.catalogError
   state.hfSongs.length
   state.songs.length
   ```
2. Network tab: the request to
   `https://huggingface.co/api/buckets/Angelrider/sonora/tree?recursive=true`
   must be 200. If it is blocked, the empty state appears with **Try again**;
   the retry re-runs the fetch.
3. If the tree works but files are missing, check the bucket id. It is
   hard-coded in `src/core/catalog.ts` and mirrored in
   `functions/api/admin.ts`/`HF_BUCKET_ID`.
4. The tree API is paginated at 1000 entries; the client follows
   `Link: rel="next"` up to 20 pages. A proxy that strips the `Link` header can
   truncate the library.
5. `manifest.json` failures do not break the library; filenames still parse.
6. Force a fresh cache:
   ```js
   localStorage.removeItem('auraHfCatalog_v1')
   location.reload()
   ```

### A track appears twice

- Track keys use `videoId` first, then title plus the original catalogue artist
  (`catalogArtist` when present). A display-artist correction preserves that key.
  Compare recording IDs/keys before treating appearances under multiple credited
  artists as duplicate uploads; the shared rules live in `src/core/trackIdentity.ts`.

### Artist grouping or portraits disagree

- Home, Library, artist details and counts share the central identity resolver.
  Check the public `/api/artists` response and the loaded catalogue, then refresh
  the page or return focus to it to pick up metadata changes.
- Admin-owned aliases/corrections outrank fallback spellings. Similar but
  ambiguous names stay separate; a collaboration may appear under multiple
  credited artists without duplicating the stored recording. See
  [Artist storage](artist-storage.md#read-side-artist-identity).

### Cover art is missing

- Covers pair by **basename** (ignoring extension). `Song [id].opus` expects
  `Song [id].webp` (or jpg/png).
- A failed cover is replaced by the vinyl `DEFAULT_COVER`.
- If the image is still loading, the card shows a warm placeholder; that is not
  an error.

## Playback

### Audio doesn’t start

- Click once inside the page: browsers require a user gesture for unmuted audio.
  The app catches `play()` rejections and resets the play icon.
- Network: the HF resolve URL must return audio (`content-type` audio/ogg or
  similar). A `403`/`404` means the file was moved/deleted.
- Cross-origin audio is fine for playback; the full-player colour sampler may
  silently fall back if canvas pixels are not readable.
- Local files: if IndexedDB was cleared, the entry is marked `missing`; re-add
  the file.

### Seeking does nothing / progress is wrong

- For local/HF audio, `duration` must be finite. Some streams report `Infinity`
  until metadata loads; the player forces a duration resolution.
- For YouTube, progress comes from the official iframe player; if the iframe is
  blocked by an extension/network, seeking cannot work.
- Radio is live; it has no seek bar by design.

### YouTube track won’t play

- YouTube playback uses the official IFrame API; it is loaded on demand. Check
  the Network request to `youtube.com/iframe_api` and whether an ad blocker
  blocks the iframe.
- Age-restricted/region-blocked videos cannot be played by the embedded player.
- Aura never extracts or downloads YouTube audio, so a blocked embed cannot fall
  back to a local file.

## Search

### A track does not appear in search

Public Search filters the current library, including added/local tracks. Check
the title, artist, album, or film spelling and the active category. To request
new catalogue music, intentionally submit it through the configured
[AURA FARMER](https://github.com/angel2rider/AURA-FARMER) Discord channel and wait
for review/download. Farmer is maintained in a separate repository; an empty
search does not submit anything.

## Playlists & sharing

### A playlist is missing

Playlists are stored on the current browser/device in `auraPlaylists`; they do
not sync between devices. Confirm the same browser profile is in use and that
site storage was not cleared or blocked.

### Share did not open or copy

- Open the playlist’s **Share** action and check its inline panel. Native
  cancellation is reported separately and does not silently copy the link.
- Use **Copy link**; if browser copying is blocked, select and copy the entire
  displayed URL manually, including `#playlist=…`.

### A received link is invalid or too large

- Ask for a complete, freshly generated link. The reader accepts a version-1
  snapshot with at most 100 tracks including omissions and 16 KiB decoded JSON.
  Truncated, malformed or unsupported payloads show an error.
- Share a smaller playlist if it exceeds the limits. Fresh recipients finish
  sign-in/username entry before the preview opens; opening it never auto-saves.

### A saved snapshot has missing tracks, or Save fails

- **Save playlist** creates a private copy in this browser. **Open saved
  playlist** means that unchanged snapshot is already saved here.
- Local files stay on the sender’s device; omitted local/unresolvable entries
  are counted in the panel. Included tracks absent from your library retain
  their labels and positions, becoming playable when the library can resolve
  them. A link transfers metadata, not audio or download requests.
- If saving reports a storage error, check site-storage permissions/capacity and
  retry. The preview stays open. Sender edits do not update an imported copy;
  ask for a new snapshot when needed. See [sharing](features.md#sharing-a-playlist).

## Radio

- Stations come from `de1.api.radio-browser.info`; if the directory is down, the
  search state shows an error/retry.
- Browser support: some streams use codecs the browser cannot decode; the toast
  reports “This station could not be played by your browser”.
- HTTP streams on an HTTPS site may be blocked as mixed content; use HTTPS
  streams.
- Custom stream URLs are played directly; a `403`/`404` is a server-side issue,
  not Aura.

## Local files

- Local blobs are stored in IndexedDB (`auraMusicDB` → `audioFiles`). Clearing
  site data deletes them.
- If a file is missing, the row remains but is marked `missing`; re-add it.
- Very large files can fail to save; the upload row shows “couldn’t be saved”.

## Admin panel / API

### `/api/admin` returns 500

- The Function returns
  `server not configured — set GH_TOKEN (and GOOGLE_CLIENT_ID / ADMIN_PASSWORD)`
  when `GH_TOKEN` is missing. Set the Pages env vars and redeploy.

### 401 / 403

- 401: invalid/expired credential, or wrong password. Sign in again.
- 403: valid Google account but not in `ALLOWED_EMAILS`.
- Rotating `GH_TOKEN` invalidates all `v1.` password sessions.

### 409 on dispatch

- A download run is already `in_progress`/`queued`. GitHub keeps only one
  pending run per concurrency group, so the API refuses rather than silently
  cancelling it. Wait for the run to finish; the response includes its run id.

### Upload run started but no music appeared

1. GitHub Actions → run logs. Check the download step and the `hf buckets sync`
   step.
2. Age-restricted/members-only videos need valid `YOUTUBE_COOKIES`.
3. The site cache (`auraHfCatalog_v1`) can be stale for up to a page reload;
   the catalogue fetch runs on load.
4. `manifest.json` metadata may lag if the workflow failed before building it;
   filenames still produce titles.
5. If the bucket tree lists 1000+ files, ensure pagination is working (the admin
   `library` action also follows `Link` cursors).

### Cover/manifest edits don’t appear

- `bucketCover`/`bucketManifestSet` stage a file and dispatch
  `manage-music.yml`; the change takes ~1 min after the workflow finishes.
- If the workflow fails, the staged file may be cleaned up; check Actions. The
  admin action returns `{dispatched:true}` before the workflow completes.
- The site may still show cached catalogue data until it refreshes.

## Rooms

### Joining or inviting someone

- At `/rooms`, paste a room code or full invite link, choose a name and press
  **Join room**, or use **Start a room**. Progress has a **Cancel** action;
  invalid/closed rooms and failed connections show an inline error.
- **Invite friends** offers a listener-only link. If copying is blocked, copy
  the selected link manually. Admins share controls through the people section.
- **Reconnect** retries a disconnected session; **Leave room** returns to entry.
  See [Rooms](rooms.md) for detailed roles and lifecycle rules.

### `/api/rooms` returns 503

- `ROOMS_WORKER_URL` is not set in the Pages env. Set it and redeploy.
- Locally, the Vite proxy targets `http://localhost:8799`; start
  `cd rooms-worker && npx wrangler dev --port 8799`.

### “Rooms are unavailable right now”

- The page calls `/api/rooms` with `action:'exists'`; a failed/reported error
  means the Worker is unreachable. Check the Worker deployment and
  `ROOMS_WORKER_URL`.
- WebSocket upgrades must reach the Worker: check the browser Network tab for a
  101 response. A proxy that strips `Upgrade` will break rooms.

### Room joins but nobody hears audio

- Autoplay policy: use **Turn on sound** when shown, then check **Your volume**.
  These controls affect your device; admins control shared playback.
- The track must be in the shared catalogue (bucket). A room can only play
  tracks both listeners can resolve.
- The Web Audio engine decodes the whole track; a slow phone/network can take
  seconds. The UI shows loading/blocked states.
- Drift diagnostics: if `clockOffsetMs` is huge or `inSync` stays false, the
  network is likely very asymmetric; a few pongs usually settle it.

### Admin key lost / wrong role

- An admin invite can carry `&k=…`; successful entry removes it from the address
  bar and remembers it in `auraRecentRooms_v1`. Normal **Invite friends** links
  join as listeners. An existing admin can grant controls in the people section;
  see [Rooms](rooms.md#authority-model) for recovery when no admin remains.

### Room is stale after a deploy

- Reload `/rooms`. The Worker and the page protocol must be deployed together;
  a schema bump discards old rooms.

## Discord / PreMiD

### Activity doesn’t appear at all

1. PreMiD extension installed and **Activity Developer Mode** enabled.
2. Discord account connected in the extension (current PreMiD uses OAuth, not a
   desktop app). Re-link if the session expired.
3. The activity was loaded: `npx pmd dev "Aura Music"`; the CLI should print
   `Connected to the extension!` and `Activity sent to the extension!`.
4. The site tab must be open and the presence reporter running:
   ```js
   document.getElementById('auraPresence').dataset
   ```
5. A YouTube/music site tab must be the active tab for the extension to choose
   its activity.

### Activity shows but no buttons

- PreMiD includes the buttons, but Discord decides whether to render them. The
  title/artist/cover are clickable via `details_url`/`state_url`/`large_url` as a
  fallback. Try **Activity Type → Playing** in the activity settings.
- If `link` is missing from the presence data, the site is an older deploy;
  redeploy it.

### Progress bar is wrong

- The activity computes timestamps from `position`/`duration`; check the DOM:
  `data-position`, `data-duration`, `data-playing`, `data-updated-at`.
- Live radio intentionally has no timer; paused tracks have no timer.
- A stale page (before a deploy) may publish an older contract; hard reload.

### The activity disappeared after editing files

- `pmd dev` must be re-run after editing the activity sources. The extension
  stores the compiled copy; it does not watch your repo.
- Clearing extension data/reinstalling requires a fresh `pmd dev` (or a store
  install).

## Deployment

- **Pages build fails**: run `npm run build` locally; check the build log for the
  first error. `dist` must contain `index.html`, `admin.html`, `rooms.html` and
  `assets/`.
- **`/admin` or `/rooms` 404**: Pages pretty URLs serve `*.html`; confirm the
  files are in the output and the project’s build output directory is `dist`.
- **Functions 404**: the `functions/` directory must be at the repo root and
  deployed with the project; Pages auto-detects it.
- **Env changes don’t apply**: environment variables are read at deploy time;
  trigger a new deployment after changing them.
- **Custom domain issues**: add the domain in Pages, update Google OAuth
  origins, `SITE_URL`/PreMiD metadata, and the admin proxy if needed.
- **Old assets after deploy**: hashed files are immutable; HTML is
  `must-revalidate`. A hard refresh clears any stale service worker/cache.

## Performance

- First load fetches the bucket tree + manifest; 1000+ tracks can take a moment.
  Skeletons cover the wait; cached catalogues paint instantly.
- YouTube’s iframe API is loaded only when a YouTube track plays. If you see it
  on initial load, you are on an old deploy.
- Covers are lazy-loaded; a long library only fetches visible art.
- The full player samples cover colours once per image and caches the result.

## Reset / clean slate

```js
// catalogue cache only
localStorage.removeItem('auraHfCatalog_v1')

// local library metadata (keeps remote catalogue)
localStorage.removeItem('addedTracks')

// likes
localStorage.removeItem('auraLikedSongs_v2')

// everything (also removes session/theme/settings)
localStorage.clear()

// local audio blobs
indexedDB.deleteDatabase('auraMusicDB')
```

After deleting IndexedDB, local rows remain until you remove them from the
library (or clear `addedTracks`), and will show as `missing`.

## Where to look next

- [Architecture](architecture.md) — module ownership
- [Configuration](configuration.md) — env/keys
- [Deployment](deployment.md) — Pages/worker/workflows
- [Rooms](rooms.md) — protocol and sync
- [Public resource discovery](discovery.md) — navigation guides and public directory access
- [Presence](presence.md) — Discord activity
- [Security](security.md) — trust boundaries
