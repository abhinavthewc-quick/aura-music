# Production verification — 14 November 2026

The current working tree was deployed to Cloudflare Pages production, including
the listener, Admin, Rooms page, and Pages Functions. The Rooms Worker was also
deployed. This was a direct deployment; the working tree was not committed or
pushed to GitHub.

| Component | Deployment |
| --- | --- |
| Site | https://aura-music-01g.pages.dev |
| Pages deployment | https://8ba7bc82.aura-music-01g.pages.dev |
| Pages project / branch | `aura-music` / `main` |
| Rooms Worker | https://aura-rooms.abhinavthewc.workers.dev |
| Worker version | `b0331d30-0fcd-42b9-8c5b-f6f7d4cd3fb2` |
| Previous Pages production deployment | `492d75c6-3105-40cb-acef-999e5df6371f` |

## Automated checks

| Check | Result |
| --- | --- |
| Frontend browser and unit suite | 126 passed |
| Audio preparation Python suite | 3 passed |
| Isolated Telepathy experiment suite | 14 passed |
| Rooms Worker integration suite, local | 20 passed |
| Rooms Worker integration suite, production | 20 passed |
| App and Worker TypeScript checks | Passed |
| Source lint, production build, whitespace check | Passed |
| App and Worker dependency audits | 0 reported vulnerabilities |

Worker tooling advisories were resolved through compatible dependency updates
in `rooms-worker/package-lock.json`. Deployment documentation now uses the actual
Pages project name, which differs from its public subdomain.

## Live Chrome DevTools MCP checks

Chrome DevTools MCP controlled a dedicated Chrome for Testing instance. Listener
checks used a temporary local account; room clients used separate browser
contexts. Real production APIs and audio were used, without fixture interception.

- Original, Bass boosted, and Bass + reverb audio loaded and played through the
  deployed audio proxy. The observed audio responses supported byte ranges
  with HTTP 206.
- Switching versions preserved elapsed position, track identity, collection,
  queue, and listening counts. Paused and rapid switches retained pause and
  pending position. Next retained the preferred version and started at zero.
- Version controls fit at exact 320, 390, 900, and 1440 pixel viewports without
  horizontal overflow.
- Local account login, selected version, and a two-song playlist survived reload.
  Playlist creation, adding songs, and playback retained playlist order and
  the selected rendition.
- The listener catalogue had 490 tracks and 407 with both processed versions.
  Three of the 410 indexed originals are excluded by existing rules: duplicate
  Hosanna and Bindaas entries, and the pruned Michael Jackson entry. Processed
  files did not become separate catalogue tracks. All 820 uploaded audio paths
  and sizes had already been verified against the upload inventory.
- The Admin gate loaded, and unauthenticated Admin requests returned 401.
  Unauthenticated audio diagnostics returned 404. The Pages Rooms endpoint
  reached the deployed Worker.
- A room was created through the live Rooms UI. Its creator received the admin
  role, and a second browser joined as listener with both participants visible.
  Both test clients left after verification.
- Radio directory discovery worked. MANGORADIO played, paused personal audio,
  and stopped successfully.

## Observed limits

One initial browser Rooms WebSocket handshake timed out. Retrying the live UI
succeeded, and the two-browser join plus production Worker suite passed.
SomaFM's selected stream returned HTTP 403 from its own server; the alternative
station played successfully. Station availability remains provider-dependent.

Owner-authenticated Google Admin operations, real ingestion workflow dispatch,
the external PreMiD extension, and physical-device audio synchronization were
not exercised. Signed-out Google/FedCM errors appeared in the isolated listener
context; local account authentication succeeded.

## Live screenshots

- [Desktop version selector](screenshots/release-20261114-live-player-1440.png)
- [Mobile version selector](screenshots/release-20261114-live-player-390.png)
- [Playlist after reload](screenshots/release-20261114-live-playlist-persisted.png)
- [Two-browser room](screenshots/release-20261114-live-room-two-browsers-full.png)
- [Live radio playback](screenshots/release-20261114-live-radio-playing.png)

Desktop and mobile player screenshots were visually inspected. These captures
show the live catalogue with the temporary verification account.
