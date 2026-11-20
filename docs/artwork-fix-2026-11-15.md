# Artwork recovery — 15 November 2026

Recently played cards used the image URL saved in history, even when the
catalogue had the current artwork. After Hugging Face artwork moved into
`covers/`, those saved root URLs returned 404. Playing a song replaced that
one history entry and made its image appear again.

Cards now prefer the current song's artwork without changing saved history,
order or listening counts. Failed root artwork URLs in the Sonora bucket retry
the same filename in `covers/` before using the existing placeholder. This
also handles cached songs, artist portraits and playlist snapshots. Working
root artwork from fresh uploads remains supported, and reused player images
can recover after a previous image failed.

## Verification

- Typecheck, lint, production build and `git diff --check` passed.
- Final full test suite: **145 passed**, including seven artwork checks.
- Chrome DevTools MCP reproduced the old behavior using Sita's Aspiration and
  Every Breath You Take, then verified their actual Hugging Face covers before
  playback on local and live desktop/mobile pages.
- A real obsolete root URL recovered through the `covers/` retry locally.
- Live saved history/order remained intact, and no error console messages
  appeared. The deployed JavaScript matched the local build.
- The live black background and stylesheet are unchanged:
  `main-B24Zo0Yt.css`.

## Deployment and evidence

- Site: https://aura-music-01g.pages.dev
- Deployment: https://05adbc59.aura-music-01g.pages.dev
- [Live desktop](screenshots/artwork-fix-20261115-live-desktop.png)
- [Live mobile](screenshots/artwork-fix-20261115-live-mobile.png)
- Detailed temporary logs: `/private/tmp/aura-artwork-fix/`.

Refresh the site once to load the fix; clearing site storage is unnecessary.
No commit/push, Hugging Face mutation or Pages settings change was made during
this fix.
