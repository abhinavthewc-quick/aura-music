# Aura Music documentation

These guides describe the Aura Music web app, its companion services, and the
conventions used to keep them working together. They are written for the person
maintaining this deployment, not for end users.

**Last verified:** 2026-10-31 · live at <https://aura-music-01g.pages.dev>

## Read in this order

| # | Document | What it answers |
| --- | --- | --- |
| 1 | [Architecture](architecture.md) | How does the app boot? Which module owns what? How do the three entry points and two backends fit together? |
| 2 | [Features](features.md) | What does every screen/flow do, including edge cases? |
| 3 | [Configuration](configuration.md) | Which constants, environment variables, OAuth clients and credentials are required? |
| 4 | [Development](development.md) | How do I run, debug and test everything locally? |
| 5 | [Deployment](deployment.md) | How do I ship the site, functions, rooms worker and upload pipeline? |
| 6 | [Data model](data-model.md) | What is a track? How are ids, dedupe, manifests, bucket files and browser storage shaped? |
| 7 | [Listen Together](rooms.md) | How do synchronized rooms, the Durable Object, clock sync and the Web Audio engine work? |
| 8 | [Discord presence](presence.md) | How does the site expose “now playing”, and what does the PreMiD activity send to Discord? |
| 9 | [Admin API](admin-api.md) | What are the `/api/admin` actions, request shapes, auth rules and limits? |
| 10 | [Admin panel](admin.md) | How do I use the owner panel to queue, download and curate the library? |
| 11 | [Security](security.md) | What are the trust boundaries, secrets, XSS rules and known limitations? |
| 12 | [Troubleshooting](troubleshooting.md) | Why is X broken, and what should I check first? |
| 13 | [Contributing](contributing.md) | What is the definition of done for a change? |

## Other sources of truth

| File | Contents |
| --- | --- |
| [../README.md](../README.md) | Project overview and quick start |
| [../premid/README.md](../premid/README.md) | Building, testing and publishing the PreMiD activity |
| [../YOUTUBE_SEARCH_IMPL_GUIDE.md](../YOUTUBE_SEARCH_IMPL_GUIDE.md) | YouTube InnerTube research notes used by the admin search endpoint |
| [../functions/api/admin.ts](../functions/api/admin.ts) | The admin API implementation (authoritative over the summary docs) |
| [../src/rooms/protocol.ts](../src/rooms/protocol.ts) | Room message/state contract |
| [../rooms-worker/src/room.ts](../rooms-worker/src/room.ts) | Durable Object plumbing |
| [../src/core/config.ts](../src/core/config.ts) | Site-wide constants |
| [../scripts/lint.mjs](../scripts/lint.mjs) | Automated project invariants |

## Screenshots

The images in `docs/assets/` are captured from the production build with a
seeded test library:

- `home-desktop.webp` — home, quick access, Aura Picks, artist spotlight
- `library-desktop.webp` — library group headers and track list
- `settings-desktop.webp` — settings dialog
- `home-mobile.webp` — 390 px mobile layout with the bottom dock

## Documentation conventions

- **Paths** are relative to the repository root unless a doc says otherwise.
- **Secrets** are never printed. Placeholders look like `⟨HF_TOKEN⟩`.
- **Types** refer to TypeScript interfaces in `src/`.
- When behavior changes, update the matching doc in the same commit. The
  [contributing checklist](contributing.md#pull-request-checklist) lists the
  docs that usually need touching.
- Screenshots are illustrative; the UI can change without the data contract
  changing. The contracts that matter are listed in [data-model](data-model.md)
  and [presence](presence.md).
