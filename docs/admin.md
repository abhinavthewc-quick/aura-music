# Admin panel

`/admin` (built from [`admin.html`](../admin.html) +
[`src/admin/main.ts`](../src/admin/main.ts)) is the owner-only control room for
the library pipeline. It never handles audio itself: it queues YouTube URLs,
dispatches GitHub Actions, and edits bucket metadata through `/api/admin`.

Server contract: [admin-api.md](admin-api.md). Environment setup:
[configuration](configuration.md#2-cloudflare-pages-environment).

## Access

- The gate accepts **Google sign-in** (verified in the browser and again by the
  Function) or the **email + password** fallback when `ADMIN_PASSWORD` is set.
- The email must match `ALLOWED_EMAILS` in the Function. The site allow-list is
  only a hint; the server is authoritative.
- Successful auth stores a 7-day `v1.` session token, so the panel survives a
  Google ID-token expiry (~1 hour).
- Losing/rotating `GH_TOKEN` invalidates all password sessions; sign in again.

## Tabs

### 1. Find & queue (`panelAdd`)

The main workflow: find music, add it to a persistent queue, then download.

- **Search** — YouTube Music (“songs” mode) or YouTube videos. Results show
  title, artist/album/duration, views, and an “already in library” mark.
- **Add** — adds a result to `auraAdmin_queue_v1` (persists across reloads).
  Duplicate ids and already-uploaded ids are refused.
- **Artist** — sweeps the artist’s channels and returns deduped tracks (album
  tiles + uploads), so a whole discography can be queued.
- **Playlist/Album link** — expands a `list=` / album link into its tracks.
  Auto-generated mixes (`RD…`) cannot be expanded.
- **Paste URLs** — paste one or more YouTube links; oEmbed metadata is fetched
  for the queue.
- **Queue size** — the UI shows how many runs the queue will take (25 tracks per
  run).
- **Download** — dispatches the first batch. The server dedupes against the
  bucket, refuses if a run is already active (`409`), and the workflow chains
  the rest of the queue as `more_urls`.
- **Run status** — lists recent `upload-music.yml` runs; expand one to see job
  steps, timings and failures.

### 2. Library (`panelLibrary`)

Shows all bucket audio files, grouped with their cover/manifest state.

- Search/filter by path.
- **Rename** — renames the audio file and its same-basename cover in one HF
  batch operation. The new name must keep an audio extension and must not
  collide.
- **Delete** — removes the audio file and its cover together.
- **Cover** — upload an image (≤ ~1.5 MB). It is staged in `.staging/` and
  dispatched to `manage-music.yml` because new bytes cannot go through the HF
  copy/delete batch endpoint.
- **Metadata** — edit title/artist/album in `manifest.json`. The change is
  staged and dispatched the same way; it takes effect after the workflow
  completes (~1 min).
- “Already uploaded” marks come from the `library` action; the tree cache is
  60 s, so a just-finished upload may be missing until the cache expires.

### 3. Settings (`panelSettings`)

- **YouTube cookies** — load a Netscape `cookies.txt` and save it as the
  `YOUTUBE_COOKIES` GitHub secret (sealed with GitHub’s public key by the
  Function). Only the upload workflow can read it. Needed for age-restricted or
  members-only videos.
- **Server environment** — `GH_TOKEN`, `GOOGLE_CLIENT_ID`, `ADMIN_PASSWORD`,
  `HF_TOKEN`, `HF_BUCKET_ID` and `ROOMS_WORKER_URL` live in Cloudflare Pages,
  not here.
- **Status chips** — lists which GitHub secrets exist (names only) and whether
  the server sees HF credentials.

## Session / UI behaviour

- A top session bar shows the signed-in email and a sign-out action.
- 401/403 responses lock the panel and prompt a fresh sign-in.
- Queue state, run polling and library state are all client-side; a reload keeps
  the queue and re-reads the bucket.
- The panel shares `core/session`, `core/google-auth`, `core/config` and
  `core/catalog` helpers with the main app.
- If the Google script is unavailable, the email/password gate remains usable.

## Common admin tasks

### Add a single track

1. Search for it; press **Add** (or paste its URL).
2. Confirm it is not marked “already in library”.
3. Press **Download**. A run appears in the status list.
4. Wait for the workflow; the track appears in the main library after the
   catalogue refresh.

### Queue a whole album/artist

1. Search by artist; press **Artist** to sweep channels, or paste an album
   playlist link and **Expand**.
2. Review the queue (remove variants/junk), then Download.
3. If the queue exceeds 25, the workflow chains the remaining batches
   automatically. Do not dispatch a second batch while one is active.

### Replace a cover

1. Library → find the audio path → Cover.
2. Upload/choose the image; the panel stages and dispatches.
3. Wait for `manage-music.yml`; refresh the site.

### Fix a title/artist

1. Library → edit metadata for the video id.
2. Save; wait for the manifest workflow.
3. The site picks up the new manifest on its next catalogue refresh (hard
   reload if needed).

### Age-restricted downloads fail

1. Settings → load/save a valid `YOUTUBE_COOKIES`.
2. Re-dispatch. The workflow tries the default client then `visionos` and
   `tv_embedded` fallbacks.
3. Cookies can expire; repeat when YouTube logs the account out.

## Security notes

- The panel holds no server tokens; it only holds the short Google/session
  credential in localStorage.
- Treat `YOUTUBE_COOKIES` as sensitive: it can access the YouTube account.
- Do not share the admin URL or a screenshot of the session bar.
- Rotate `GH_TOKEN`, `HF_TOKEN` and `ADMIN_PASSWORD` after any exposure; see
  [security](security.md).

## Related

- [Admin API](admin-api.md) — request/response shapes and limits.
- [Deployment](deployment.md#3-github-actions) — workflow inputs/secrets.
- [Troubleshooting](troubleshooting.md#admin-panel--api) — 401/409/500 and
  “upload ran but no music appeared”.
