# Black design restoration — 14 November 2026

Restored the listener's previous black design using source revision `2912877` and its deployed site, https://492d75c6.aura-music-01g.pages.dev, as the reference. Desktop and mobile screenshots confirm the previous layout, typography, neutral controls, silver sign-in record, navigation, and artwork shelves. Current catalogue and artwork data can differ from the reference deployment.

The song-version feature remains available. Current queue, playlist recovery/reordering, artist biography, accessibility, catalogue filtering, and security behavior were preserved. Shared tokens also return Admin and Rooms to neutral colors while retaining their current controllers and markup. The listener's existing optional light mode uses neutral colors.

UI fonts and listener icons are bundled locally again. The startup loader now waits for the page and fonts without relying on removed CDN stylesheet callbacks. The restored native mini-player button opens the full player with keyboard or pointer input. Album artwork can still tint the full-player backdrop; primary transport and shell colors stay neutral.

## Production

- Site: https://aura-music-01g.pages.dev
- Deployment: https://639305fd.aura-music-01g.pages.dev
- Pages project: `aura-music`, production branch `main`.
- Listener assets: `main-gev3ymA3.js`, `main-CpjdRfcB.css`.
- Deployment includes the current Pages Functions. The Rooms Worker was unchanged.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed.
- `npm test`: **126 passed** (70 browser tests, 56 unit tests). Palette assertions were updated to the restored neutral colors.
- Chrome DevTools MCP compared the reference and restored desktop/mobile designs, then checked production sign-in through a temporary device-local account.
- Production Original, Bass boosted, and Bass + reverb playback passed with the actual Hugging Face files. Version switches preserved track identity, queue, collection context, and position. Switching a paused track kept it paused.
- Production desktop transport used white/neutral controls. The 390 px full-player version selector had a 44 px target and no horizontal overflow. Automated coverage also passed at 320 px and larger desktop/tablet widths.
- Production catalogue: **490 tracks**, **407 visible tracks with both versions**; processed files remain excluded as separate songs.
- The production listener had no error-level console messages during verification.

Screenshots are in [docs/screenshots](screenshots), prefixed `design-restore-20261114-`; filenames distinguish the previous reference, restored local UI, and restored live site. Earlier `release-20261114-*` images show the superseded gold design.

Owner-authenticated Admin mutations, real provider sign-in, external ingestion, and physical-device Rooms synchronization were not repeated for this visual restoration. See the earlier release verification for the prior functional deployment's coverage and limits.
