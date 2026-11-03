# Configuration

There are three configuration surfaces:

1. **Compile-time constants** in `src/core/config.ts` (public, shipped to the browser).
2. **Cloudflare Pages environment variables** (server-side secrets for `/api/admin` and `/api/rooms`).
3. **GitHub repository secrets** (consumed by the upload/manage workflows).

Plus a few values that are currently hard-coded in more than one place — those
are listed explicitly because a fork must update each copy.

## 1. Site constants (`src/core/config.ts`)

| Constant | Current value | Purpose |
| --- | --- | --- |
| `AURA_YOUTUBE_API_KEY` | `''` | Optional shared YouTube Data API key for in-app YouTube search. Empty = YouTube results come only from pasted links. Users can override locally in Settings. |
| `AURA_JAMENDO_CLIENT_ID` | `''` | Optional shared Jamendo `client_id` for full-length CC tracks. Users can override locally. |
| `GOOGLE_CLIENT_ID` | `563051437889-…apps.googleusercontent.com` | Google OAuth Web client used by GIS and verified server-side. |
| `ADMIN_EMAILS` | two Gmail addresses | Client-side hint for the admin gate; the server has its own copy. |

The YouTube/Jamendo keys are optional. Leaving them blank keeps the app usable;
those providers simply return nothing.

### Google OAuth setup

1. Google Cloud Console → APIs & Services → Credentials → Create credentials →
   OAuth client ID → **Web application**.
2. Authorized JavaScript origins:
   - `https://aura-music-01g.pages.dev`
   - `http://localhost:5173`
   - any custom domain you deploy to.
3. Copy the client ID into **both**:
   - `GOOGLE_CLIENT_ID` in `src/core/config.ts`
   - `GOOGLE_CLIENT_ID` in the Pages environment (for `/api/admin` verification).
4. Update the admin allow-list in **both**:
   - `ADMIN_EMAILS` in `src/core/config.ts`
   - `ALLOWED_EMAILS` in `functions/api/admin.ts`

## 2. Cloudflare Pages environment

Set these in **Pages → your project → Settings → Environment variables** for
Production (and Preview if used):

| Variable | Required | Consumed by | Purpose |
| --- | --- | --- | --- |
| `GH_TOKEN` | ✅ | `functions/api/admin.ts` | GitHub token with `actions:write`, `secrets:write`, `contents:write` on this repo. Also keys the HMAC fallback sessions. |
| `GOOGLE_CLIENT_ID` | ✅ | `/api/admin` | Audience check for Google ID tokens. |
| `ADMIN_PASSWORD` | optional | `/api/admin` | Enables the email/password admin login. If unset, only Google sign-in works. |
| `HF_TOKEN` | for bucket mutations | `/api/admin` | Hugging Face token for rename/delete/cover/manifest actions. |
| `HF_BUCKET_ID` | for bucket mutations | `/api/admin` | e.g. `Angelrider/sonora`; must match the client bucket. |
| `ROOMS_WORKER_URL` | for rooms | `functions/api/rooms.ts` | Public URL of `rooms-worker`, e.g. `https://aura-rooms.<sub>.workers.dev`. Without it `/api/rooms` returns 503. |

`GH_TOKEN` must not be exposed to the browser. The admin panel never receives
it: it sends either a Google ID token or a `v1.<exp>.<hmac>` session token, and
the function performs GitHub/HF calls itself.

## 3. GitHub Actions secrets

Repository → Settings → Secrets and variables → Actions:

| Secret | Used by | Notes |
| --- | --- | --- |
| `HF_TOKEN` | upload/manage workflows, optionally admin | Hugging Face write token. |
| `HF_BUCKET_ID` | upload/manage workflows | Bucket id, e.g. `Angelrider/sonora`. |
| `YOUTUBE_COOKIES` | upload workflow | Netscape `cookies.txt` for age-restricted/members-only videos. Editable from the admin panel (encrypted via GitHub's public key). |
| `GH_TOKEN` | optional chain step | If present, used for dispatching the next batch. Otherwise the workflow uses the repository `GITHUB_TOKEN` with `actions: write`. |

`YOUTUBE_COOKIES` is the only secret the admin panel may write
(`setSecret`/`deleteSecret` in `/api/admin`). `HF_TOKEN`/`HF_BUCKET_ID` must be
set as Pages environment variables for the admin bucket actions; they are not
managed from the panel.

## 4. Hard-coded values that must stay in sync

A fork/rename needs to touch these together:

| Value | Locations |
| --- | --- |
| Bucket id `Angelrider/sonora` | `src/core/catalog.ts` (`HF_BUCKET_ID`), `functions/api/admin.ts` (`HF_BUCKET`), plus `HF_BUCKET_ID` env/secret. |
| Site URL `https://aura-music-01g.pages.dev` | `vite.config.js` dev proxy, `premid` metadata/`presence.ts`, docs examples. |
| Google client id | `src/core/config.ts`, Pages env. |
| Admin allow-list | `src/core/config.ts`, `functions/api/admin.ts`. |
| Repo `abhinavthewc-quick/aura-music` | `functions/api/admin.ts` (`REPO`), admin dispatch targets, workflows. |
| PreMiD activity app id `1566089897905758259` | `premid/websites/A/Aura Music/presence.ts` only. |

## 5. Local development configuration

### Vite proxy

`vite.config.js` proxies:

| Path | Target | Why |
| --- | --- | --- |
| `/api/admin` | `https://aura-music-01g.pages.dev` | Test admin against the deployed Function so local Pages env secrets are reused. |
| `/api/rooms` | `http://localhost:8799` (override with `ROOMS_DEV_URL`) | Local rooms worker. |

```bash
# use a different rooms worker port
ROOMS_DEV_URL=http://localhost:8800 npm run dev
```

### Local-only settings

Stored in the browser, not in the repo:

| Key | Purpose |
| --- | --- |
| `auraYoutubeApiKey` | Per-browser YouTube key (overrides `AURA_YOUTUBE_API_KEY`). |
| `auraJamendoClientId` | Per-browser Jamendo client id. |
| `auraTheme` | `light` or `dark`; applied before first paint. |
| `auraSettings_v1` | Autoplay, volume memory, search history flag, YouTube results, reduce motion. |
| `auraVolume` | Last volume (when remember-volume is on). |

## 6. Custom domain checklist

1. Add the domain to Cloudflare Pages (Custom domains) and DNS; wait for the
   certificate.
2. Update the Google OAuth **authorized origins**.
3. Update `SITE_URL`, `metadata.json` `url`/`regExp`/`logo`/`thumbnail`, and the
   `premid` README links.
4. Update `vite.config.js`’s `/api/admin` proxy target (dev convenience only).
5. If the domain changes, re-check `ALLOWED_EMAILS`/`GOOGLE_CLIENT_ID` are
   unchanged and that `ROOMS_WORKER_URL` is still reachable.
6. Redeploy the site; the bucket/worker do not need changes unless their URLs
   are embedded in code (they are not, apart from the bucket id).

## 7. Runtime APIs that need no configuration

These are public/keyless and are called directly from the browser:

- `https://huggingface.co` — catalogue tree, manifest, audio/cover bytes.
- `https://de1.api.radio-browser.info` — radio directory.
- `https://itunes.apple.com`, `https://api.deezer.com`, `https://api.audius.co`,
  `https://api.jamendo.com`, `https://archive.org`, `https://api.openverse.org`,
  `https://ccmixter.org` — search providers.
- `https://www.youtube.com/oembed` — pasted-link metadata.
- Google Fonts, Font Awesome CDN, jsmediatags CDN — UI assets.

If a network blocks any of them, the corresponding feature degrades with a toast
or an empty result; the rest of the app keeps working.

## 8. Validation before shipping

```bash
npm run typecheck
npm run lint
npm run build
```

Then verify on the deployed URL:

- `/` loads and the catalogue paints.
- `/admin` shows the gate and Google sign-in works.
- `/rooms` creates/joins a room (worker configured).
- `/api/rooms` returns a JSON error rather than a timeout if `ROOMS_WORKER_URL`
  is missing.
- PreMiD activity shows the current track (see [presence](presence.md)).
