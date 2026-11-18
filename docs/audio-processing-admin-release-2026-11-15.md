# Audio processing administration — 15 November 2026

Admin now manages the version database through its **Audio processing** tab.
It shows complete/pending/active/failed/expired song counts, ready-version
coverage and storage, searchable/sortable paginated records, detailed original
and rendition metadata, retry times, errors and a filtered CSV export.

Admins can queue unfinished versions, retry failed songs, recover expired
jobs, reconcile archive availability and regenerate one inspected rendition.
An atomic administrative lease protects active workers and concurrent claims;
regeneration requires the inspected rendition revision. Queue changes are
audited under the verified admin email, and ready partner versions/original
audio are preserved. Browser credentials use the existing Admin gate; the
worker token stays outside the browser.

The updated installed Mac worker reports manual run start/finish, progress
stages and heartbeat timing. Reporting failures preserve valid renders and
uploads. Runs still start manually; the page copies a Terminal command rather
than starting the Mac remotely. Historical local logs are not uploaded.

Migration `003_audio_processing_admin.sql` added telemetry/activity tables to
the existing D1 database. Before/after checks preserved all 492 originals and
984 ready renditions. The listener's black stylesheet is unchanged.

## Verification

- Full Playwright suite: **156 passed**. The four processing browser checks
  also passed after the final retry-status wording adjustment.
- Python: **15 worker checks and 3 legacy preparation checks passed**.
- Typecheck, lint, production build and `git diff --check` passed.
- Real SQLite covered Admin authentication, bot denial, private responses,
  aggregate counts, ready-partner preservation, active/expired leases,
  regeneration revisions, complete archive reconciliation, worker telemetry
  and audit records.
- Chrome DevTools MCP verified live password sign-in, the real registry
  totals (492 songs, 984 versions, 8.59 GB), both published song file links,
  inspector controls and desktop/mobile layouts. No console errors appeared.
- Installed worker code matches the source; its read-only status request
  confirmed all 984 renditions remain ready.

## Release

- Admin: https://aura-music-01g.pages.dev/admin
- Deployment: https://04aee8c8.aura-music-01g.pages.dev
- [Desktop](screenshots/audio-processing-admin-20261115-desktop.png)
- [Mobile](screenshots/audio-processing-admin-20261115-mobile.png)
- [Mobile song inspector](screenshots/audio-processing-admin-20261115-inspector-mobile.png)
- Temporary evidence: `/private/tmp/aura-processing-admin/`.

No commit/push, Pages settings/secret change, remote processing run or archive
audio mutation was performed. Queue mutations were exercised in isolated
fixtures; live checks read the real records. Detailed stage reports begin on
the next manually launched worker run.
