# Aura remediation and release boundaries

This is a source remediation for the existing personal, library-first music app,
not a wholesale framework rewrite or a deployment. The canonical listener theme
is **true black, neutral graphite and white interaction states**. Existing radio, rooms,
lyrics, administration, presence, local profiles and legacy saved audio remain
part of the product; experimental recommendations are not promoted to shipped
scope simply because prototype code exists.

## Playback foundation

Personal transport uses a collection context rather than consuming a playlist
as the generic manual queue:

```text
Library / playlist / artist / search selection
             │
             ▼
  Collection order + cursor + shuffle permutation
  Explicit queue interruptions + history/future
             │
             ▼
  Next / Previous / natural end / Media Session / Up Next
             │
             ▼
       HTML audio or official YouTube iframe
```

- Reaching a playlist boundary does not fall into unrelated global tracks.
- Selecting a row establishes that collection and cursor.
- Shuffle is collection-scoped; repeat cycles off/all/one, initially all. Repeat-one applies to
  natural end, not a user's manual Next action.
- Queue interruptions resume the collection, while Previous follows listening
  history. Next after Previous replays future visits before pending queue items;
  Up Next uses that same order. Temporary Up Next reorder is not a playlist edit.
- History visits carry stable track identity and optional `anchorId` for overrides;
  restoring a cursor rebases it by identity against the current permutation after
  shuffle/live reorder, rather than trusting the old array index.
- The production raw-ID `manualQueue` and mutable artist `playOrder` remain
  compatible; artist traversal is mirrored into stable-reference
  `state.playbackContext`. Library/search retain ordinary fallback behavior.
  Collection handoffs, retirement, row selection and shuffle retain unheard
  interruptions, including those held only in forward history. Up Next previews
  at most 4 tracks on phones and 30 on desktop.
- Playback-intent/source guards reject stale native promises/events and iframe
  callbacks. YouTube callbacks must match the exact current iframe target;
  advancement is delayed and native ended events require actual source completion.
  Pending YouTube exclusively owns transport/time: prior native audio remains
  paused, reported time is zero and seeking is unavailable.
- Missing tracks are handled in a bounded traversal; room mode and live radio
  deliberately have separate server/live transport ownership.

See [architecture](architecture.md#personal-playback-domain) and
[data model](data-model.md#personal-playback-context-in-memory).

## Local-first playlists

- `auraPlaylists` has a version-2 store envelope and per-playlist `schemaVersion`.
- Track identity is `video:<videoId>` or `id:<trackId>`, with snapshots/legacy
  aliases for migration and recovery. Canonical references resolve only to direct
  stable/source identity; unique alias/metadata fallback is reserved for unresolved
  `legacy:` placeholders. Mutable title/artist is not the primary reference and
  global array positions are never durable identity.
- Unavailable entries remain visible with remove/relink, rather than silently
  disappearing or becoming misleading empty collections.
- Reorder is available through pointer interaction and keyboard-accessible move
  controls. Native track/edit/recovery buttons avoid nested custom activation.
- JSON export/import transfers ordered references and metadata. Import previews
  missing/available tracks; it does not copy audio blobs or grant access rights.
- Strict parsing rejects malformed/unsupported/oversized/duplicate imports
  before mutation. Limits are 16 MiB per import, 2,000 tracks per playlist and
  200 collections. Corrupted saved stores freeze writes and offer raw recovery;
  legacy migrations are prepared before title/artist edits. An explicit mutation
  must save the original legacy payload in `auraPlaylists_backup_v1` before
  replacing the primary store; backup failure aborts mutation. Startup, previews,
  refreshes, metadata repaints and library deletion never migrate playlists.
- Web Locks or short IndexedDB transaction coordination locks serialize writes;
  without either safe mechanism saving is refused. Storage/BroadcastChannel
  refresh all same-origin views and reconcile active name/order without
  restarting current audio. Deleting the playlist detaches a labeled playback
  snapshot; no stale collection identity remains.
- Existing `privacy`, `year` and valid received `shared` metadata are retained;
  privacy labels are descriptive, not ACLs.
- Version-1 `#playlist=` snapshot links remain supported alongside version-2
  file import/export. Links contain ordered labels/keys and omission counts,
  never media/artwork URLs, local-file IDs or account data. Preview is read-only;
  explicit Save creates a browser-local copy without fetching audio or starting
  playback. Sender edits do not update received copies. Permanent hosted links,
  ACLs and automatic cross-device sync are **not** claimed.

Details: [playlist/file contract](data-model.md#playlists-and-export-files).

## Navigation and product contracts

- Search is the existing Aura library, not a podcast or acquisition service.
- Local files is a real filter and device-audio import with filename metadata,
  not a label that opens all tracks. Missing blobs expose Restore under their
  existing identity; no jsmediatags/tagging provider is implied.
- Local-file operations serialize by raw ID and recheck after awaits. Stale
  hydration, restore, metadata edits and cover FileReaders cannot revive deleted
  or replaced tracks. Blob writes roll back on failed metadata persistence;
  object URLs are released only when no longer in use. Deletion saves metadata
  before destroying blobs and finishes transport changes before awaiting
  IndexedDB deletion. Numeric `toggleFavorite` arguments remain indices;
  internal raw-ID callers use strings.
- Search → playlist clears Search's body/layout state.
- Playlist icon-only actions retain accessible names on mobile; track, reorder,
  import/export and recovery controls expose actual user actions.
- Ingestion remains the separate Discord/admin/GitHub pipeline. Removed online
  acquisition forms and preview-provider fan-out are not restored implicitly.

## Radio and rooms source boundaries

- [Radio](../src/features/radio.ts) validates credential-free HTTP(S) streams
  before changing ownership, pauses personal audio and stops active/pending
  YouTube without rewriting saved playlists or consuming the personal queue.
  Artist transport retires with unheard interruptions retained; scoped playlist
  traversal stays intact. Promises/errors are guarded by selection, request
  generation and explicit intent.
- Live play/pause/stop own Media Session; next/previous/all seeks and position
  state are cleared. Stop restores personal handlers/metadata. Restored stations
  remain paused. Explicit Pause/Stop cancels foreground recovery, which otherwise
  uses the guarded radio request path only for previously active, intended audio.
- [Room create/join](../src/rooms/page.ts) checks HTTP success, honors
  `exists: false`, and validates credential-free `ws:`/`wss:` service URLs before
  creating transport. Failures appear in the visible join banner, not a hidden
  room-only banner. These checks are not live Worker/authentication verification.
- The presence reporter and bridge source are unchanged. The external PreMiD
  extension still needs its own owner-side integration smoke test.

## Design ownership

The black listener UI is the source of truth. Album art is the memorable/colorful
part; the surrounding shell is quiet and disciplined. Typography, spacing,
radii, surfaces, active states, focus, errors and reduced motion use a shared
foundation across desktop/mobile. Responsive layouts may differ intentionally
without becoming different products.

Fonts and Font Awesome SVG-mask icons are self-hosted, with licenses retained.
At 900 px and above, the full player is nonmodal and docked Up Next is a region
without `aria-modal` or trapped Tab. Phone overlays retain modal focus behavior.
Initial playlist rendering and Media Session setup occur in authenticated
`app.ready`, after initialization and local hydration.

Numbered patches and separate YTM/polish/quality override layers are retired.
A new feature or fix belongs in its component owner, not another last-file
`!important` patch. Do not infer release quality from CSS size alone: review the
actual desktop/mobile screens and interactions after the final build.

## Security changes

[The audio router](../functions/api/audio.ts) and
[OCI signer](../functions/lib/ociS3.ts) provide:

- Environment-only optional OCI configuration; absent/partial/invalid config
  makes zero OCI requests/writes and preserves public HF playback.
- Header-token-only, no-store aggregate diagnostics with generic 404 for
  unauthorized callers; no public storage inventory.
- RFC 3986 key encoding, safe relative paths, one byte range, HEAD support,
  meaningful 404/416, and sanitized provider errors/logs. Validated audio MIME
  plus `nosniff` prevents mislabelled upstream HTML from executing on Aura's origin.
- Bounded unknown-length reads (25 MiB), no partial/truncated audio cache writes,
  signed paged listings, oldest-audio-first eviction, and no write after failed
  capacity checks. Non-audio objects are not evicted.
- Per-isolate serialization/deduplication. The 30-track target is best effort
  across isolates, **not** a globally atomic capacity guarantee or true LRU.

### Owner infrastructure action required

Historical source exposed an OCI customer-secret-key pair. The current checkout
removes it; **the owner must revoke/rotate that key in OCI**, update the new
Production and Preview Pages environment values, and review IAM/storage activity.
Source removal, a local test or even a later redeploy does not revoke credentials
or erase Git history. No remote key use, rotation, storage mutation or deployment
was performed by this remediation.

Use a dedicated least-privilege cache bucket, storage quotas/alerts, and a
separate random `AUDIO_ADMIN_TOKEN` if diagnostics are needed. Never pass real
keys to the unit suite, browser, `VITE_*`, a URL, tracked `.dev.vars`, or terminal
history. See [security](security.md#audio-cache-security).

## Half-features and experiments

[Telepathy](../experiments/telepathy/README.md) is quarantined outside `src/` and
`functions/`. The browser/API prototypes do not bundle or deploy accidentally.
Its Python package has explicit setuptools discovery, an asyncio SQLAlchemy
extra, pinned tested dependencies and a safe test runner. The old React wrapper
and dependencies are removed; the existing licensed vanilla loader renderer is
retained, not silently relicensed.

The Python experiment remains research: no production auth/consent/catalogue
contract, chunk-delivery service, cloud playlists or integrated recommendation
claim is inferred from those files.

## Verification

### Required frontend/server gate

```bash
npm run typecheck
npm run lint
npm test
npm run test:artists
npm run test:playback
npm run test:playlists
npm run build
```

### Recorded reconciliation gate — 13 November 2026

| Check | Recorded result |
| --- | --- |
| `npm test` | **116/116 passed**: 62 browser tests and 54 unit tests; Playwright discovers only `**/*.spec.ts` |
| Separate Node runners | **266/266 passed**: artist/metadata/storage **181/181**, playback **43/43**, sharing **42/42**; Node `*.test.ts` fixtures stay separate |
| Retained/native-browser runner | **48 suites / 1,236 checks passed**, including source ownership, sharing, local storage races and native input/layout |
| TypeScript | Both TypeScript configurations passed |
| Source/HTML lint | 70 source files / 3 HTML files passed |
| Vite production build | All three entry pages built: listener, administration and rooms |
| `npm audit` | 0 reported vulnerabilities |
| `git diff --check` | Passed |
| Dependency lock alignment | All 75 npm/Bun package versions and checksums agree; isolated frozen installs with scripts disabled preserve package/lock bytes |
| Self-hosted UI assets | 7 font subsets / 186 SVG-mask rules regenerated (196 style/name selectors, including 8 grouped alias rules); all masks/font headers and literal icon classes validated; targeted surface tests passed **13/13** |
| Isolated Python safe runner | Historical **14/14** result only; **not rerun** during this reconciliation |
| Computed browser assertions | Layout, contrast, input, pointer and keyboard assertions passed at **320 / 390 / 768 / 1440 px** |
| Artist/native-layout coverage | Home and Library at **320 / 390 / 430 / 768 / 1024 / 1440 px**; local storage races at **390 / 1440 px** |

The read-only preservation audit also verified both initial/drift archives and
history bundles, all five patches, recovery Git objects/indexes, and the retained
299-path integration checkpoint (including its 39 unmerged paths). The protected
original checkout's HEAD, index and all 252 recorded paths match the drift backup.
Its six newer audio-version paths remain separate and are not part of this merge.

[Audio security tests](../tests/unit/audio-security.spec.ts) use fake keys and
fully mocked fetches. Pure playback tests and isolated browser fixtures cover
the collection domain and regression flows. This is local synthetic-fixture
verification, not verification of live providers, authenticated infrastructure,
a deployed Worker, the external PreMiD extension or a production cache.

### Synthetic fixture screenshots

These captures use synthetic fixture tracks and data, not the owner's live
catalogue. All four refreshed captures were visually inspected during
reconciliation after the full suite recaptured them. Computed assertions cover
the tested layout/contrast/interaction contracts; image inspection is not
owner design approval or verification of live providers and real devices.

| Surface | Desktop | Mobile |
| --- | --- | --- |
| Playlist | [Desktop playlist](<screenshots/aura-fixture-playlist-desktop.png>) | [Mobile playlist](<screenshots/aura-fixture-playlist-mobile.png>) |
| Player | [Desktop player](<screenshots/aura-fixture-player-desktop.png>) | [Mobile player](<screenshots/aura-fixture-player-mobile.png>) |

Review at least:

- scoped Next/Previous, repeat/shuffle, queue precedence/history, natural end,
  unavailable tracks and current-catalogue identity;
- metadata edit/migration, missing placeholders, reorder, import/export,
  cross-tab edits/deletes, storage failure and keyboard/mobile names;
- navigation/search state, 390 px and desktop layout, full/mini player, radio,
  existing local files, dialogs, reduced motion and absence of console errors;
- preserved presence/deep links, rooms and administration entry points.

### Historical isolated Python experiment

```bash
bash experiments/telepathy/run-tests.sh -q
```

The earlier **14/14** result in **3.06 s** came from the safe runner in the
experiment's CPython 3.12 virtual environment; it was **not rerun during the
13 November reconciliation**. The suite forces in-memory
SQLite before singleton import, uses deterministic metadata/lyrics, clears
provider keys, blocks external HTTP/Internet sockets, disposes connections, and
exercises the API in-process. The pinned dependency file includes
SQLAlchemy's required `greenlet` dependency; no global pip install was used.

### Not verified by local fixtures

Real provider uptime/codec support/mobile autoplay and background behavior,
Google sign-in against the owner's client, authenticated admin/session/API flows,
room Worker deployment/drift on separate devices, the external PreMiD extension,
and owner-side OCI credential revocation/rotation remain owner tests/actions.
They require approved staging/device checks and real infrastructure bindings.
Do not label the project production-ready or claim deployment based solely on
fixture/unit/build success or a dependency audit.

## Future release discipline

Do not add another recommendation/lyrics-provider/admin feature until the
transport, playlist, accessibility and visual regression gate stays green. A
future CI change should run typecheck, lint, unit/browser tests and build in
isolated fixtures; the optional Python research job should use CPython 3.12 and
the locked experiment environment. No new CI workflow or deployment is implied
by this proposal.
