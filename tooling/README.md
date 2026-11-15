# Aura tooling

Project-owned audio workers, import/migration tools, database utilities and
Chrome DevTools MCP checks live here. These sources are committed with the
registry API and D1 schema they use. Older metadata/cache tools already tracked
in `scripts/` remain available there.

## Install on a Mac

Requirements: Python 3.10+, Node 22.13+, `hf` with bucket support, `ffprobe`,
Wrangler (tested with 4.64.0), and the user's existing `aubatch` executable.
Install the HF CLI using its documented installer, run `hf auth login`, and
run `wrangler login` for database/deployment commands.

```sh
npm ci --prefix tooling
python3 tooling/install.py
aura-version-worker --help
aura-version-worker --status
```

The installer links `~/.local/bin/aura-version-worker` to this checkout. It
backs up an old launcher, preserves existing settings and creates a private
example config only if absent. Moving the checkout requires rerunning the
installer from its new location. No background service is installed.

Edit `~/.config/aura-music/version-worker.json` for the site, bucket, aubatch
path, work directory and 1–4 processing lanes. Store the worker bearer token in
the configured token file with permissions 0600. It must match the Pages
`VERSION_WORKER_TOKEN` secret. The example configuration contains no credentials.
The existing `/Users/thegt/.local/share/aubatch/` project and installed plugins
are external dependencies; this repo does not copy or modify them.

## Manual processing and importing

```sh
aura-version-worker --dry-run           # read-only inventory
aura-version-worker --once --limit 4    # download/render/upload four eligible songs
aura-version-worker --once              # drain eligible work and exit
aura-version-worker --sync-only         # reconcile/import archive metadata
```

Jobs use D1 leases, retry protection, source hashes and verified publication.
Failed jobs retain their local downloads/renders for the next manual run.
The local SQLite ledger and recipe snapshots help resume work; they are not
the public version registry. See [processing details](../docs/audio-processing.md).

To import files already processed in `BASS/` and `BASS_REVERB/`:

```sh
python3 tooling/audio/prepare_audio_versions.py /path/to/processed \
  --output "$HOME/.local/share/aura-music/prepared-import" --probe
# Review the local upload-report.json, then explicitly publish.
python3 tooling/audio/prepare_audio_versions.py /path/to/processed \
  --output "$HOME/.local/share/aura-music/prepared-import" --upload
```

The importer matches exact video IDs or unique normalized filenames, validates
all missing partners before upload, claims that specific D1 job, and uploads
only missing versions with `hf buckets sync --no-delete`. Ready versions and
active jobs are skipped. A failed publication retains files for retry.
Deploy the API supporting `claimOne` before using this importer.

Archive organization uses verified server-side copies, never re-encoding:

```sh
python3 tooling/audio/organize_audio_bucket.py --state "$HOME/.local/share/aura-music/new-migration" --plan --copy
# Deploy compatible listener/proxy/admin before switching paths.
python3 tooling/audio/organize_audio_bucket.py --state "$HOME/.local/share/aura-music/new-migration" --publish
python3 tooling/audio/organize_audio_bucket.py --state "$HOME/.local/share/aura-music/new-migration" --prune
```

Plans, before/after registry snapshots and completion markers stay local.
Pruning verifies copies and live database paths before removing exact old files.

## D1 is the version registry

`GET /api/versions` reads D1. The worker/importer publish readiness, file paths,
durations, sizes, checksums and recipes to D1 after remote upload verification.
The website no longer falls back to the legacy HF `versions.json`. A database
outage leaves original playback available; cached/offline catalogue snapshots
may retain previously known versions until a successful refresh.

HF stores originals, covers, `versions/<track-key>/{bass,bass-reverb}.mp3` and
`manifest.json`. The manifest stores titles/artists/albums: the current version
database does not replace that metadata source. Local JSON configuration,
recipes, upload reports and migration plans serve different purposes; none is
a second live version registry.

```sh
python3 tooling/database/versions.py status
python3 tooling/database/versions.py backup
python3 tooling/database/versions.py migrate
```

The default non-secret Wrangler config selects the current version database.
Use `--config` and `--database` to target another environment. SQL exports go to
`~/.local/share/aura-music/db-backups/` with permissions 0600. `migrate` exports
a backup first and applies only migrations 002 and 003, whose table/index
creation is idempotent. It does not change Pages secrets or bindings.

## Chrome DevTools MCP verification

Launch Chrome for Testing with a private profile and local debugging port:

```sh
"$CHROME_BINARY" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9339 \
  --user-data-dir="$HOME/.local/share/aura-music/chrome-check-profile" --no-first-run
npm run devtools --prefix tooling -- --output "$HOME/.local/share/aura-music/browser-checks"
```

Set `CHROME_BINARY` to your installed Chrome/Chrome for Testing executable.
In another terminal:

```sh
python3 tooling/browser/verify.py
# Include read-only Admin checks using an existing private password file.
python3 tooling/browser/verify.py --email your-admin-email \
  --password-file "$HOME/.config/aura-music/admin-password.txt"
```

The bridge uses pinned `chrome-devtools-mcp`, binds localhost, rejects browser
origins, and serializes MCP calls. `--browser-url`, `--port`, `--output`, `--site`
and `--bridge` let you select local services or a deployed environment. Browser
profiles, screenshots, console/network logs and credentials stay outside Git.
Close the bridge and test Chrome after verification.

## Checks

```sh
npm test --prefix tooling
npm run typecheck
npm run lint
npm test
npm run build
```

Tooling tests cover descriptor exhaustion, DNS failures, source changes,
retained renders, targeted import leases, partial uploads, verified relocation,
private backups and launcher installation. They use local fixtures/SQLite and
do not render real audio or upload files.
