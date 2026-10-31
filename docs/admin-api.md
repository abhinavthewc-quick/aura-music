# Admin API (`/api/admin`)

The admin panel ([`admin.html`](../admin.html)) is a thin client over a single
Cloudflare Pages Function: [`functions/api/admin.ts`](../functions/api/admin.ts).
Everything that needs a secret happens server-side.

## Authentication

Every request is a `POST` with a JSON body.

### Password login (optional)

```json
{ "action": "login", "email": "you@example.com", "password": "…" }
```

- Only emails in `ALLOWED_EMAILS` (inside the Function) are accepted.
- `ADMIN_PASSWORD` must be set in the Pages environment.
- Passwords are compared as plain SHA-256 digests (not constant-time); this is a
  single-owner panel, not a user database.
- Returns `{ token, exp, email }`; `token` is `v1.<unix-exp>.<base64url-hmac>`
  signed with `GH_TOKEN` and valid 7 days.

### Google session exchange

```json
{ "action": "exchange", "credential": "<Google ID token>" }
```

- The Function verifies the RS256 signature against Google’s JWKS, then checks
  `iss`, `aud` (= `GOOGLE_CLIENT_ID`), `exp`, `email_verified`, and the allow-list.
- Returns the same signed token shape, so the admin panel can keep working after
  the ~1 h Google ID token expires.

### Every other request

```json
{ "action": "library", "credential": "<Google ID token or v1 session token>" }
```

`credential` is required. A `v1.` token is verified with HMAC; anything else is
treated as a Google ID token. The resolved email must be in the allow-list.

### Failure responses

| Status | Meaning |
| --- | --- |
| `400` | invalid JSON / missing fields / invalid path or id |
| `401` | invalid/expired credential, wrong password, auth error |
| `403` | valid credential but email not allowed |
| `404` | item not found in the bucket/manifest |
| `409` | a download run is already active, or a rename target exists |
| `500` | server not configured (`GH_TOKEN` missing) or upstream GitHub/HF error |
| `502`/`503` | upstream/rooms/worker failure |

The panel treats 401/403 by locking itself; other errors are shown as toasts.

## Action reference

All examples assume the request contains a valid `credential` unless stated.
“Panel” means the admin UI uses this action. “HF” means it needs `HF_TOKEN` +
`HF_BUCKET_ID`.

### `search`

Search YouTube Music/videos through YouTube’s InnerTube API (no key, no quota
for this endpoint). Results are cached in-memory and in the Worker Cache API for
1 hour.

| Input | Type | Notes |
| --- | --- | --- |
| `q` | string | up to 200 chars |
| `mode` | `music` \| `video` | default `music` |
| `hl`, `gl` | string | locale/market (validated; default `en`/`US`) |

```json
{ "results": [{ "videoId": "…", "title": "…", "sub": "Artist • Album • 3:45", "extra": "…", "duration": "3:45", "thumbnail": "https://…", "isLive": false }] }
```

### `library`

Returns the bucket file list, uploaded video ids, bucket id and the parsed
manifest.

```json
{
  "files": [{ "path": "Artist - Song [id].opus", "size": 7302725, "mtime": "…", "xetHash": "…" }],
  "videoIds": ["id1", "id2"],
  "bucketId": "Angelrider/sonora",
  "manifest": { "id1": { "t": "…", "a": "…", "al": "…", "y": "…", "d": 213.4 } }
}
```

The tree is cached for 60 s; uploads newer than that may not appear until the
cache expires or a mutation invalidates it.

### `bucketDelete`

Deletes an audio file **and its same-basename cover** in one batch mutation.

```json
{ "path": "Artist - Song [id].opus" }
```

- Only audio extensions are accepted (`.opus .mp3 .ogg .m4a .webm`).
- Path must be relative, ≤512 chars, no `..`/NUL/leading slash.
- Returns `{ ok: true, deleted: [...] }`.

### `bucketRename`

Renames the audio file and its cover together.

```json
{ "from": "Old - Name [id].opus", "to": "New - Name [id].opus" }
```

- Both must keep an audio extension.
- Uses HF batch `copyFile` (requires `xetHash` + mtime from the tree) then
  deletes the old files.
- Refuses if any target path already exists (`409`).

### `bucketCover`

Stages a new cover image in the repo and dispatches `manage-music.yml` (new bytes
cannot go through the HF batch endpoint).

```json
{ "path": "Artist - Song [id].opus", "data": "data:image/webp;base64,…" }
```

- Accepts `data:image/png|jpeg|webp;base64,…` up to ~1.5 MB.
- Keeps the existing cover extension when one exists; otherwise writes `.webp`
  with the same basename.
- Returns `{ ok, dispatched: true, target, staged }`.

### `bucketManifestSet`

Updates title/artist/album for an existing manifest entry.

```json
{ "id": "dQw4w9WgXcQ", "title": "…", "artist": "…", "album": "…" }
```

- The video id must already exist in `manifest.json` (404 otherwise).
- Merges fields, stages the new manifest in `.staging/`, dispatches
  `manage-music.yml` with `op: manifest`.
- Changes appear after the workflow finishes (~1 min); the client cache still
  needs its normal TTL/refresh.

### `expand`

Expands a YouTube playlist/album link (or a list id) into tracks for the queue.

```json
{ "url": "https://music.youtube.com/playlist?list=OLAK…" }
```

- `listId` may be passed instead of `url`.
- Auto-generated mixes (`RD…`) are rejected with `400`.
- Returns `{ type: "playlist"|"album", title, tracks: [...], truncated }`;
  `tracks` are YouTube result objects (video ids + metadata).
- Unknown/empty lists return `404`.

### `artist`

Sweeps an artist’s YouTube Music channels and returns deduped songs.

```json
{ "q": "A. R. Rahman", "hl": "en", "gl": "IN" }
```

Returns `{ artist, channels, tracks, dupes, truncated }` with the same track
shape. Results are cached for 1 h. This can be slow if several channels are
crawled; the panel shows a pending state.

### `dispatch`

Starts the upload pipeline.

```json
{
  "urls": ["https://www.youtube.com/watch?v=…"],
  "meta": [{ "id": "…", "title": "…", "artist": "…", "album": "…" }]
}
```

- Accepts 1–300 URLs; each must contain an 11-char YouTube id.
- Dedupes within the batch and against the bucket (`videoIds`); already-uploaded
  tracks are skipped.
- The first 25 go into this run; the rest travel as `more_urls`/`more_meta` and
  the workflow chains the next batch after it completes.
- If a run is already `in_progress`/`queued`, returns `409` with the run id
  (GitHub keeps only one pending run per concurrency group).
- Returns `{ ok, dispatched, skipped, skippedUploaded, runId }`.

### `setSecret` / `deleteSecret`

Only `YOUTUBE_COOKIES` is allowed (`ALLOWED_SECRETS`).

```json
{ "name": "YOUTUBE_COOKIES", "value": "# Netscape HTTP Cookie File\n…" }
```

- Max 128 KB.
- The value is sealed with GitHub’s repo public key using the pure-TS sealed box
  in [`lib/sealedBox.ts`](../lib/sealedBox.ts) (the Workers runtime forbids
  libsodium’s WebAssembly).
- The secret is stored in GitHub Actions secrets; only the upload workflow reads
  it.

### `status`

Returns `{ secrets: ["HF_TOKEN", …], repo, hf: true|false }` — used to render the
admin Settings chips. Secret **values** are never returned.

### `runs` / `runJobs`

- `runs` returns the latest 8 `upload-music.yml` runs:
  `{ id, status, conclusion, created_at, html_url, display_title }`.
- `runJobs` takes `{ run_id }` and returns `{ jobs: [{ id, name, status,
  conclusion, started_at, completed_at, steps: [{ number, name, status,
  conclusion }] }] }` for the admin status panel.

## Example requests

```bash
# library listing
curl -s https://aura-music-01g.pages.dev/api/admin \
  -H 'content-type: application/json' \
  -d '{"action":"library","credential":"⟨session⟩"}'

# search
curl -s https://aura-music-01g.pages.dev/api/admin \
  -H 'content-type: application/json' \
  -d '{"action":"search","q":"ilaiyaraaja","mode":"music","credential":"⟨session⟩"}'

# dispatch one URL
curl -s https://aura-music-01g.pages.dev/api/admin \
  -H 'content-type: application/json' \
  -d '{"action":"dispatch","urls":["https://youtu.be/dQw4w9WgXcQ"],"credential":"⟨session⟩"}'
```

There is no `GET` handler; browsing to `/api/admin` returns 405/404.

## Limits and caching

| Limit | Value |
| --- | --- |
| URLs per dispatch | 300 |
| URLs per run | 25 |
| Search query | 200 chars |
| Search cache | 1 h (memory + edge) |
| Artist cache | 1 h |
| Bucket tree cache | 60 s |
| Manifest cache | 30 s |
| Cover payload | ~1.5 MB |
| Secret payload | 128 KB |
| Run timeout | 90 min |

## Client notes

The admin panel stores its URL queue in `auraAdmin_queue_v1`, polls the run
status, and shows “already uploaded” marks from `library`. It never sees
`GH_TOKEN`, `HF_TOKEN` or any secret value; it only receives secret **names**
from `status`. See [deployment](deployment.md#3-github-actions) for the workflow
side and [security](security.md) for the trust boundaries.
