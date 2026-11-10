# Artist storage

Admin portraits, biographies, genres, links, name aliases and track-artist
corrections live in Cloudflare D1 (`aura-artists`), independently of the HF
download manifest. Uploaded JPEG, PNG and WebP portraits are immutable D1 BLOBs
(maximum 1.5 MiB). Removing a portrait clears the profile reference, not old
image URLs. External HTTPS image URLs remain references, not copied uploads.

`/api/artists` is a public, uncached directory. `/api/artist-image?id=…` serves
immutable images with ETags, HEAD support and `nosniff`. Admin writes require
the existing admin session; Farmer credentials cannot read the full library or
write profiles. Public clients refresh on focus/online and every minute without
restarting playback or replacing browser-local `auraPlaylists`.
No-video-ID tracks keep their original catalog artist in their legacy playlist
key; renames change only display attribution. Home and Library reconcile open
artist pages through aliases when cloud profiles first load or names change.

## Setup and legacy cutover

Use existing Wrangler authentication or a `CLOUDFLARE_API_TOKEN` held outside
git. The scripts never print tokens or environment values. Node 22.13+ is
required for the SQLite-backed dry run and tests.

```sh
npx wrangler d1 migrations apply aura-artists --remote --config wrangler.artists.jsonc
npm run artists:migrate
npm run artists:migrate -- --apply
npm run artists:bind -- --apply --backup-dir /path/outside/git
```

Migrate a freshly fetched manifest immediately before deployment, then rerun
after old in-flight admin workflows finish. Imports accept newer legacy
timestamps but never overwrite an admin-owned profile. A repeated import does
not create duplicate images. `--manifest /local/manifest.json` imports a saved
snapshot instead of fetching HF. No download workflow has authority over D1.

The binding script patches only the production/preview D1 maps and verifies
all existing variables and integrations remain unchanged. Keep its private
configuration backup outside git. `wrangler.artists.jsonc` is for D1 migrations;
it is deliberately **not** the root Pages deployment configuration.

## Concurrency and tests

Artist editors capture the profile version when opened. A stale save returns
409; profiles, images, aliases and batch renames roll back together. Batch
renames also check the directory revision. Individual track corrections beat
earlier renames; a later intentional rename replaces corrections only on the
tracks still attributed to that artist. Large writes are parameter-batched.

```sh
npm run test:artists
npm run typecheck
npm run lint
npm run build
npm audit
```

For isolated browser checks, start `npm run test:artists:browser` and open
`http://127.0.0.1:5186/tests/artists/browser.html` in a separate browser profile.
The fixture clears storage on its own origin; do not use a profile with local
development data you need to keep. Open a second fixture with `?page=admin`.
Run this in the console of each freshly loaded page:

```js
(await import('/tests/artists/browser-regressions.js')).runBrowserRegressions()
```

The main page runs 36 assertions; admin runs 18. Repeat on desktop (1440×960)
and mobile (390×844), reloading first because the checks change the synthetic
directory. The fixtures use mocked APIs, generated audio, a real IndexedDB
audio blob and test-only HF image/media redirection. They never submit songs,
upload to a remote bucket, change integration settings or use real credentials.
`?signed-out` and `?page=rooms` provide additional visual checks. The room
fixture replaces sockets with local messages so empty rooms, listener roles,
queues, chat, countdowns and closed rooms can be checked without a real room.
Reload the original `?page=rooms` fixture URL after joining: the room controller
changes browser history to `/rooms`. On a fresh room fixture, run:

```js
(await import('/tests/artists/browser-room-regressions.js')).runRoomRegressions()
```

The 24 room checks also cover idle startup, cold joining, cached rejoining,
refresh cleanup, promotion/demotion with an unchanged queue, and stale admin
button handlers. Repeat on both viewports. For actual
cross-tab storage events, open `/tests/artists/browser-peer.html` in the same
browser profile and publish a synthetic `auraCloudArtists_v1` snapshot there.
An already-open admin editor must retain its fields, portrait and captured
version while the artist list refreshes.

For lazy startup and sign-in regressions, load a fresh `?signed-out` fixture
or `?page=admin&signed-out`, then run:

```js
(await import('/tests/artists/browser-login-regressions.js')).runLoginRegressions()
```

Reload and repeat with `{ method: 'google' }`. These checks cover SDK failure
and retry, credential verification, the admin allowlist, local/password
fallbacks, username selection and the authenticated runtime. Google UI, signing
keys and server authentication responses are synthetic; no real login occurs.
