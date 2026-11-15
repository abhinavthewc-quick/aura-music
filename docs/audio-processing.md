# Mac audio processing and the version database

Audio bytes live in `Angelrider/sonora`. Cloudflare D1 owns the version records,
processing state and job leases. The website reads `GET /api/versions`; only
ready renditions belonging to active originals appear in the selector.

## Run on this Mac

The worker is installed at `/Users/thegt/.local/bin/aura-version-worker`.
It runs **manually**. There is no LaunchAgent, login task or background service.

```sh
# Show D1 counts without changing anything.
/Users/thegt/.local/bin/aura-version-worker --status

# Read-only archive inventory; no claims, rendering, uploads or organization.
/Users/thegt/.local/bin/aura-version-worker --dry-run

# Process all currently eligible songs, then exit.
/Users/thegt/.local/bin/aura-version-worker --once

# Process at most four songs as a small batch.
/Users/thegt/.local/bin/aura-version-worker --once --limit 4

# Import metadata and reconcile the archive without rendering.
/Users/thegt/.local/bin/aura-version-worker --sync-only

# Optional: keep this manually launched terminal process checking every 5 minutes.
/Users/thegt/.local/bin/aura-version-worker --watch --interval 300
```

Ctrl+C stops new claims and lets active songs finish. Stopping the terminal
forcibly may leave a lease until it expires, but downloads and rendered files
are retained for another run. A lock prevents duplicate workers on this Mac;
the database prevents another machine from taking the same song concurrently.
`--limit` applies per scan when combined with `--watch`.

The worker closes each SQLite connection after its progress transaction and
raises only its own process's open-file limit to 4,096, subject to the hard
limit. Child processing/upload tools inherit that allowance. DNS lookup
failures retry after 2, 4 and 8 seconds; other failed mutations are not
automatically replayed because their response might have been lost after a
successful commit. If connectivity remains unavailable, run the manual
command again after it returns.

The launcher links directly to `tooling/bin/aura-version-worker` in this
checkout and runs `tooling/audio/audio_version_worker.py`. Install or repair it
with `python3 tooling/install.py`; future source fixes take effect directly.
See [tooling](../tooling/README.md) for imports, database backups and Chrome checks.

The Admin **Audio processing** tab shows song/version counts, searchable jobs,
details and CSV exports, retry/recovery/regeneration controls, worker reports
and activity. Queue changes await the next manual run. Each updated worker
reports downloading, processing, uploading and publishing stages; its regular
lease heartbeat updates the run report. A reporting failure does not discard
rendered/uploaded audio. See [Admin](admin.md#audio-processing-panelprocessing).

## Local configuration and credentials

`~/.config/aura-music/version-worker.json` contains the site URL, bucket, work
directory, executable path, worker count (1–4), and `organize` flag. Its
`token_file` points to `~/.config/aura-music/version-worker.token` (permissions
0600). The matching secret is `VERSION_WORKER_TOKEN` in Cloudflare Pages.
The Hugging Face CLI uses the existing `hf auth login`; HF credentials never
appear in arguments, source files or web bundles.

The executable is `/opt/homebrew/bin/aubatch` (currently 1.2), built from the
user's tool in `/Users/thegt/.local/share/aubatch/`. It uses the saved MINE
presets for bx_subfilter, LUX Sub-Bass and AUMatrixReverb. The worker snapshots
the presets and hashes the executable/settings into a recipe at startup. It
does not edit presets or use unsaved plugin settings. Restart a running watcher
after changing presets; already-ready versions are not automatically rerendered.

## Processing lifecycle

1. Read the complete, paginated HF tree and import original identities plus
   existing processed files. Exclude the same pruned artists/hidden duplicate
   as the listener and skip empty originals. Prefer the organized original path
   and retain canonical `video:…` or `id:hf:<legacy filename>` identities.
2. If a previous upload workflow left new originals/covers at the root, copy
   them server-side into the clean layout, verify Xet hashes and sizes, update
   original locations in D1, then remove only the verified old paths. Set
   `organize: false` in local config to disable this step.
3. Atomically claim a song with a missing version for one hour. Heartbeats
   renew the lease every two minutes. Four lanes independently download,
   render and upload so a slow song does not block the entire batch.
4. Download the original into a directory keyed by track, original Xet hash and
   recipe. Verify its size and readable duration. aubatch produces 320 kbps
   MP3s using its own decoded-peak safety check at a -1 dBFS sample-peak ceiling.
   On retry, retained outputs for all missing modes are checked again; valid
   outputs from the same source and recipe skip rendering.
5. Verify MP3 codec, bitrate and duration; stage **only missing versions** and
   upload with `hf buckets sync --no-delete`. The original and an already-ready
   partner rendition are never uploaded by this step.
6. Report paths, sizes, durations, SHA-256 and recipe to D1. The server confirms
   that each uploaded object is available and has the declared size before
   marking it ready. A stale owner cannot publish after another worker takes
   its lease or a changed original invalidates it.
7. Keep the local SQLite ledger, recipe and per-song logs. Remove only this
   completed job's temporary source/render/upload files after publication.
   On failure, keep those files and record the error. The job becomes eligible
   after five minutes and retries on the next manually launched run (or the
   next scan of an explicitly launched watcher).

Reconciliation deactivates missing/empty originals and returns missing remote
renditions to pending. A changed original Xet hash invalidates its versions and
lease; the worker then processes that source afresh. Imported historical
versions have the recipe `imported-aubatch`; their original recipe/checksums
were not available in the old index.

## Clean archive layout

```text
originals/
  Artist - Song [abcdefghijk].opus
covers/
  Artist - Song [abcdefghijk].webp
versions/
  abcdefghijk/
    bass.mp3
    bass-reverb.mp3
  track-<20-character identity hash>/
    bass.mp3
    bass-reverb.mp3
manifest.json          # existing title/artist/album metadata
```

One folder holds each song's processed versions. Filename-only songs use a
stable hash, not a fuzzy artist/title match. Audio has not been re-encoded as
part of organization: existing objects were copied within HF and validated.
Canonical original IDs stay unchanged; paths used for streaming may change.
The audio proxy resolves known old root and `versions/<mode>/<key>.mp3` paths
on a confirmed 404. Catalogue/admin parsing pairs covers by basename across
their separate folders. Rooms still use only originals.

The website, worker and importer use D1 exclusively for version records.
The legacy `versions.json` rollout fallback has been retired. If D1 is
unreachable during catalogue refresh, originals stay playable. The importer
in `tooling/audio/prepare_audio_versions.py` stages preprocessed files locally,
claims specific missing D1 jobs, uploads only missing partners and publishes
verified metadata to D1. It does not upload a JSON version registry.

## Database and API

The database is `aura-audio-versions`, ID
`e187b796-f6b9-4bbc-9c33-3c0393955f74` (APAC), bound as `VERSION_DB` in Pages.
The existing `ARTIST_DB` binding is independent. The schema is
`migrations/002_audio_versions.sql`; apply it once to a new version database.
Also apply `migrations/003_audio_processing_admin.sql` for the worker runs,
job progress and bounded activity tables.

`audio_tracks` stores the canonical identity, current original path/Xet hash,
storage key, active flag and lease. `audio_renditions` has a compound key
`(track_ref, mode)` and stores pending/processing/ready/failed state, path,
duration, size, checksum, recipe, attempt count, retry time and last error.
These are service records, separate from personal listening data.

`POST /api/versions` requires the high-entropy worker bearer token and accepts
`sync`, `reconcile`, `claim`, `claimOne`, `heartbeat`, `complete`, `fail`, `status`, and
verified `relocate` actions. `runStarted`, `progress` and `runFinished` report
manual run telemetry; progress requires the current job lease. Mutations and diagnostics are not cached. Public
reads return only ready paths and durations and have a 15-second cache lifetime.
No private state or token is included in the public response.

When adding the Pages binding, patch only the new `VERSION_WORKER_TOKEN`
environment key and merge the non-secret D1 binding map. **Never echo existing
`secret_text` values from a Pages GET back into a PATCH:** Cloudflare returns
them as empty redacted strings. The Pages dashboard can also configure the
binding and new secret without touching other settings.

## One-time migration

The installed bucket was migrated on 14–15 November 2026. The plan, before tree,
before index and completion markers are retained in
`~/.local/share/aura-music/archive-migration-2026-11-14/`.

```sh
python3 tooling/audio/organize_audio_bucket.py --state /path/to/new-state --plan --copy
# Deploy a listener/proxy/admin that supports the new paths first.
python3 tooling/audio/organize_audio_bucket.py --state /path/to/new-state --publish
python3 tooling/audio/organize_audio_bucket.py --state /path/to/new-state --prune
```

Planning refuses conflicting destinations. Copying is resumable and retains
the source. Publishing updates D1 only when source/destination contents match
and saves a local audit snapshot. Pruning requires a published marker,
a live database registry, playable new originals, and a fresh complete tree
whose copied hashes and sizes still match. It deletes only exact old paths in
the saved plan. Keep the snapshots for auditing and D1 SQL exports for database recovery.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm test --prefix tooling
```

The unit suite uses real SQLite to check D1 SQL, lease contention/expiry, retries,
upload verification, source invalidation, reconciliation and verified relocation.
Worker tests check partial-version publication, retained outputs after failed
publication, stop behavior and refusal to delete unverified copies. Browser
checks cover normal/seamless playback and stable identities. Live verification
also ran one full song through the real aubatch/HF/D1 workflow and checked the
migrated audio using Chrome DevTools MCP.
