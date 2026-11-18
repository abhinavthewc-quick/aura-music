# D1 registry and manual Mac processor — 15 November 2026

The listener now reads ready song versions from Cloudflare D1. The installed
manual Mac command downloads eligible originals, processes them with the user's
aubatch executable and saved presets, uploads only missing versions with
`hf buckets sync`, and updates D1 after verifying the uploaded objects. Job
leases, heartbeats, retry state, immutable recipe snapshots and retained local
outputs make interruptions recoverable. No login/background service is installed.

Hugging Face now uses `originals/`, `covers/`, and `versions/<stable-song-key>/`.
All 1,820 legacy audio/cover/rendition paths were copied server-side, checked
against their original Xet hashes and sizes, then removed after compatible
client/API deployment and database publication. Root metadata files remain.
Old streaming URLs resolve through the audio proxy; original IDs and listening
context remain stable. Two pre-existing empty Opus encodings were preserved;
their healthy M4A alternatives are used by the processor.

## Current state

- 492 healthy canonical originals in the registry, excluding the listener's
  pruned/hidden sources.
- 410 songs with both versions ready: 820 ready rendition records.
- 82 songs remain eligible: 164 pending renditions. They run when the owner
  launches `/Users/thegt/.local/bin/aura-version-worker --once`.
- One real smoke-test song, The Police — Every Breath You Take
  (`video:-SaUrDhp034`), was downloaded, rendered, uploaded and published
  successfully. A metadata rescan preserved it without rendering/uploading again.
- The restored black design and the concurrent preparation/120 ms crossfade
  remain intact.

## Verification

- Typecheck, lint, build and `git diff --check` passed.
- `npm test`: **138 passed** (75 browser checks, 63 unit checks).
- Python: six worker/storage failure checks and three legacy preparation checks
  passed.
- Real SQLite exercised registry SQL, lease contention/expiry, stale owners,
  missing-upload rejection, ready-partner preservation, source invalidation,
  reconciliation and verified relocation.
- Chrome DevTools MCP verified real migrated versions on desktop and 390 px
  mobile: prepared lanes, audible output, stable IDs/history/context, preserved
  paused position, accessible controls and no extra requests during warm switches.
- A final Chrome check discovered the newly processed smoke-test song through
  D1, prepared its real original and aubatch outputs, and switched with zero
  pause/reload/seek events or additional requests. No error console messages.
- Live legacy original/bass/reverb URLs returned successful 32-byte ranges.
- Live password sign-in, admin library, GitHub Actions listing, authenticated
  Discord settings proxy, Rooms proxy and private/public version APIs passed.

During configuration, existing Pages secrets were accidentally cleared by
echoing Cloudflare's redacted empty values into a PATCH. Service values were
restored from saved authorized logins; shared bot tokens were updated at both
ends. Following the owner's instruction to update the secret, ADMIN_PASSWORD
was replaced with a strong value stored privately in
`~/.config/aura-music/admin-password.txt` (0600). Admin sessions may need a fresh
sign-in. The final deployment and live service checks above include this repair.

## Deployment and retained evidence

- Site: https://aura-music-01g.pages.dev
- Final deployment: https://dd060c94.aura-music-01g.pages.dev
- D1: `aura-audio-versions`, binding `VERSION_DB`, APAC.
- Migration plan/snapshots: `~/.local/share/aura-music/archive-migration-2026-11-14/`.
- Local config: `~/.config/aura-music/version-worker.json`; private token file
  is beside it and outside the repository.
- Worker ledger/logs: `~/.local/share/aura-music/version-worker/`.
- Temporary test, deployment and Chrome evidence: `/private/tmp/aura-version-pipeline/`.
- New-song desktop capture: [screenshot](screenshots/d1-worker-new-song-20261115.png).
- Usage and maintenance: [audio processing](audio-processing.md).

No commit/push was made; unrelated workspace changes were preserved. The Rooms
Worker code was unchanged. The Farmer Worker received only the paired service
secret updates described above. Original audio/presets were not re-encoded or
edited during the archive move. The backup JSON index remains an emergency
snapshot; D1 owns current readiness.
