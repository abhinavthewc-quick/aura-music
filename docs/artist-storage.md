# Artist storage

Admin portraits, biographies, genres, links, name aliases and track-artist
corrections live in Cloudflare D1 (`aura-artists`), independently of the HF
download manifest. Uploaded JPEG, PNG and WebP portraits are immutable D1 BLOBs
(maximum 1.5 MiB). Removing a portrait clears the profile reference, not old
image URLs. External HTTPS image URLs remain references, not copied uploads.

Pictures and biographies have independent explicit override flags. Automatic
Wikimedia metadata is cached separately and fills unlocked fields; a manual clear
remains empty. Existing saved nonempty fields are retained when enabling this
feature. See [Automatic artist profiles](artist-metadata.md).

`/api/artists` is a public, uncached directory. `/api/artist-image?id=…` serves
immutable images with ETags, HEAD support and `nosniff`. Admin writes require
the existing admin session; Farmer credentials cannot read the full library or
write profiles. Public clients refresh on focus/online and every minute without
restarting playback or replacing browser-local `auraPlaylists`.
No-video-ID tracks keep their original catalog artist in their legacy playlist
key; renames change only display attribution. Home and Library reconcile open
artist pages through aliases when cloud profiles first load or names change.

## Read-side artist identity

`src/core/artistIdentity.ts` resolves credits before `artistGroups.ts` builds
pages. Home, Library, artist details, portraits and artist counts use that same
snapshot. Track attribution and persistence keys remain independent of the
display grouping.

- Exact D1 aliases and intentional track corrections take precedence. Ambiguous
  aliases do not pick the first similar profile.
- Formatting handles Unicode normalization, whitespace, typographic apostrophes,
  initials beside full names, and explicit Topic/Official channel annotations.
  Articles, accents, meaningful punctuation and script distinctions are retained.
- `artistAliases.ts` lists reviewed spelling/transliteration equivalences. There
  is no edit-distance matching or transitive fuzzy merging of unrelated artists.
- Collaboration parsing requires independent artist evidence or an explicit
  featured credit. Compound band names and explicitly owned joint projects stay
  intact. Each recording is counted once per credited artist.
- The two observed natural Rahman profile keys are explicitly listed as
  equivalent display identities. Both D1 records survive; an admin owner takes
  precedence over an imported owner, then whole-profile recency resolves peers.
  The winning record retains its field overrides, including clears. Custom
  profile keys and later intentional renames remain distinct.
- Legacy HF profile data supplies fallback metadata only. It cannot override or
  refill a cleared D1 profile, even if the old manifest has a newer timestamp.
- Automatic profiles are composed after identity resolution. Provider records
  cannot create aliases, split collaboration credits or alter saved track keys.

Grouping is deterministic across catalogue/profile iteration order. Cached
snapshots are invalidated by profile revisions and local metadata edits;
selection reconciliation preserves open pages without reloading active audio.
The identity and catalogue tests include distinct-owner conflicts, compound
credits, Unicode, no-ID keys, stale metadata and a thousand similar names.

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

### Node regressions

```sh
npm run test:artists
npm run typecheck
npm run lint
npm run build
npm audit
```

`npm run test:artists` runs `tests/artists/*.test.ts` with Node 22.13+:

- [Storage](../tests/artists/storage.test.ts): atomic profile/image/alias writes,
  stale-version and rename conflicts, bounded batches, repeatable legacy imports,
  portrait validation, public image headers and admin/Farmer authority.
- [Client reconciliation](../tests/artists/client.test.ts): open artist selections,
  revision ordering, concurrent refreshes, cross-tab snapshots and preservation of
  no-ID playlist keys, local tracks and playback during metadata updates.
- [Identity](../tests/artists/identity.test.ts) and
  [catalogue identity](../tests/artists/catalog-identity.test.ts): D1 ownership,
  cleared metadata, aliases, Unicode, compound/collaboration credits, deterministic
  groups and selections, literal metadata keys and stable fresh/cached track keys.
- [Automatic composition](../tests/artists/metadata-composition.test.ts),
  [provider matching](../tests/artists/metadata-provider.test.ts) and
  [metadata storage](../tests/artists/metadata-store.test.ts): independent field
  overrides, source credits, conservative identity checks and shared cache claims.
- [Metadata API](../tests/artists/metadata-api.test.ts) and
  [client scheduling](../tests/artists/metadata-client.test.ts): request intent,
  bounded queues/cache, retry deadlines, session gates and cross-tab fencing.
- [Stored state](../tests/artists/storage-state.test.ts): corrupt or blocked
  storage, read-only initialization, stable IDs and blob references, current-track
  retention/reappearance, explicit deletion and delayed-deletion reconciliation.
- [Room presentation/audio](../tests/artists/room-presentation.test.ts): invite
  parsing, listener-only links, role/sync status, permission/decode races and
  cleanup of retired audio sessions.

### Browser fixtures

Start `npm run test:artists:browser` and open
`http://127.0.0.1:5186/tests/artists/browser.html` in an isolated browser profile.
Each fixture load clears and reseeds its origin's local storage and supplies an
IndexedDB audio blob; use a profile without development data you need to keep.
Repeat the suites at desktop **1440×960** and mobile **390×844**, starting from a
fresh fixture for each independent run except the ordered identity check below.

Fixtures use mocked APIs, generated audio and test-only HF image/media
redirection. They never submit songs, upload to a remote bucket, change
integration settings or use real credentials. Room sockets use local messages;
Google UI, signing keys and authentication responses are synthetic.

### Main/admin artists and controls

On a fresh default main fixture, and separately on `?page=admin`, run:

```js
await (await import('/tests/artists/browser-regressions.js')).runBrowserRegressions();
```

The shared suite covers artist-page reconciliation and metadata refresh,
preserved local playlists/audio, admin portrait editing and stale-editor
conflicts, plus responsive true-black UI. After its **main-page** run, continue
on that same fixture with:

```js
await (await import('/tests/artists/browser-identity-regressions.js'))
  .runArtistIdentityRegressions();
```

This checks shared Home/Library identities and counts, independent native
play/like/menu controls, queue reorder boundaries and focus, and artwork
Info/Share actions. It observes playback callbacks and uses programmatic clicks,
synthetic reorder keys and a Share stub. See the
[native keyboard checks](../tests/playlists/README.md#native-keyboard-checks)
for real browser key input.

### Automatic artist metadata

Import `/tests/artists/browser-metadata-regressions.js` on a fresh fixture for
each row, then call the indicated export:

| Fixture query | Export |
| --- | --- |
| default main | `runAutomaticMetadataRegressions()` |
| `?metadata=held-ready` | `runMetadataLookupRegressions()` |
| `?page=admin` | `runAdminMetadataRegressions()` |
| `?page=admin&admin-gate=held` | `runAdminMetadataGateRegressions()` |
| `?page=admin&admin-gate=denied` | `runAdminMetadataGateRegressions()` |
| `?signed-out` or `?page=admin&signed-out` | `runSignedOutMetadataRegressions()` |

These verify neutral portraits, independent fields and credits, live-node focus
retention, unchanged audio/playlist bytes, older-request fencing, untouched
editor drafts, explicit clears/unlocks, and no work before the appropriate gate.

### Queue playback and library races

On a separate fresh main fixture using native audio, with no active YouTube or
radio source, run:

```js
await (await import('/tests/artists/browser-identity-regressions.js'))
  .runQueuePlaybackRegressions();
```

It exercises real fixture audio and the hydrated local blob: deleted queue IDs,
missing local files and unhydrated entries are skipped while manual order is
retained; ordinary library advancement resumes only after that queue is drained.

On another fresh main fixture, run:

```js
await (await import('/tests/artists/browser-library-races.js'))
  .runLibraryRaceRegressions();
```

This covers catalogue retry/deep-link recovery, late metadata/catalogue results
after newer music or radio choices, and delayed IndexedDB deletions. Newer
playback and radio ownership/media-session state survive stale continuations;
explicit deletion of the still-current local track resets its transport.

### Entry and sign-in

Load a fresh main fixture at
`http://127.0.0.1:5186/tests/artists/browser.html?signed-out`, then run:

```js
await (await import('/tests/artists/browser-login-regressions.js')).runEntryRegressions();
```

The signed-out starting state is required: the default fixture seeds a session.
The suite holds entry modules while inspecting the real HEAD script and CSS,
then checks valid, malformed, expired and blocked-storage sessions, invalidation
during loading, missing-module recovery, boot failures, true-black first paint
and accessible status/focus handoffs. Coverage is described by named checks
rather than a fixed frame-sampling total.

For sign-in, load a separate fresh `?signed-out` or `?page=admin&signed-out`
fixture and run:

```js
await (await import('/tests/artists/browser-login-regressions.js')).runLoginRegressions();
```

Reload the same signed-out fixture before testing the Google path:

```js
await (await import('/tests/artists/browser-login-regressions.js'))
  .runLoginRegressions({ method: 'google' });
```

These cover idle/lazy entry, SDK failure and retry, credential verification,
the admin allowlist, local/password fallbacks, username selection and the
authenticated runtime.

### Rooms and cross-tab updates

On a fresh `?page=rooms` fixture, run:

```js
await (await import('/tests/artists/browser-room-regressions.js')).runRoomRegressions();
```

Room coverage includes idle startup, validation, single-flight entry/cancel
races, cold joining and cached rejoining; listener-only invites and copy/focus
recovery; authoritative first-track/queue acknowledgements; promotion/demotion
with an unchanged queue and stale handlers; chat text/scroll behavior, sync
feedback, disconnects and cleanup across room lifetimes. Reopen the original
`?page=rooms` fixture URL before rerunning: joining changes history to `/rooms`.

For actual cross-tab storage events, open `/tests/artists/browser-peer.html` in
the same browser profile and publish a synthetic `auraCloudArtists_v1` snapshot
there. An already-open admin editor must retain its fields, portrait and captured
version while the artist list refreshes.

See [Playback regressions](../tests/playback/README.md) for source-module and
`runPlaybackRegressions()` coverage, and
[Playlist sharing regressions](../tests/playlists/README.md) for snapshot
sharing/arrival entry points and native keyboard scopes.
