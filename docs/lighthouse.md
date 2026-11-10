# Lighthouse performance

Benchmarks use Lighthouse **13.6.0**, a fresh headless Chrome profile, the
default simulated mobile/desktop presets, and the real signed-out entry page.
All four categories are enabled. No audit-only markup or user-agent branching
is used.

## Baseline — 10 November 2026

Production: `https://aura-music-01g.pages.dev`, release `48fd480`.

| Page | Device | Performance | Accessibility | Best practices | SEO |
| --- | --- | ---: | ---: | ---: | ---: |
| Home | Mobile | 46 | 94 | 96 | 83 |
| Home | Desktop | 71 | 100 | 96 | 83 |
| Admin | Mobile | 98 | 100 | 100 | 82 |
| Rooms | Mobile | 98 | 100 | 100 | 91 |

The mobile homepage transferred 19.4 MiB, spent 5,162 ms blocking the main
thread, and had a cumulative layout shift of 0.503.

## Verified production results — 10 November 2026

| Page | Device | Performance | Accessibility | Best practices | SEO |
| --- | --- | ---: | ---: | ---: | ---: |
| Home | Mobile | 100 | 100 | 100 | 100 |
| Home | Desktop | 100 | 100 | 100 | 100 |
| Admin | Mobile | 100 | 100 | 100 | 100 |
| Admin | Desktop | 100 | 100 | 100 | 100 |
| Rooms | Mobile | 100 | 100 | 100 | 100 |
| Rooms | Desktop | 100 | 100 | 100 | 100 |

Home and admin were audited on `bb4a213` at 16:00–16:01 UTC; rooms were
audited on `41958b9` at 16:14 UTC. The rooms release retained the exact
previously audited home/admin asset hashes. All six runs completed without
Lighthouse warnings. These scores measure the public signed-out entry pages.

| Mobile page | FCP / LCP | Blocking time | Layout shift | Transferred |
| --- | ---: | ---: | ---: | ---: |
| Home | 1.28 s | 38 ms | 0 | 93 KiB |
| Admin | 0.93 s | 15 ms | 0 | 111 KiB |
| Rooms | 0.80 s | 12 ms | 0 | 92 KiB |

The mobile homepage transfers **99.5% fewer bytes** than the baseline.
Desktop blocking time and layout shift are zero on all three pages.
The rooms follow-up removed the idle catalogue download, reducing its entry
transfer from 5.76 MiB to 92 KiB.

Exact measurements, timestamps and audited commits are recorded in
[`lighthouse-results.json`](lighthouse-results.json). The accompanying
`aura-lighthouse-2026-11-10.zip` evidence export contains the original HTML/JSON
reports and validation results.

## Changes

- Render the complete black sign-in screen immediately, with accessible
  controls and status messages. Remove the forced 3.8-second WebGL intro.
- Load the music runtime, catalogue, artwork and audio after successful
  sign-in or when restoring a saved session. Preserve local tracks, playlists,
  artist refreshes and playback. Transfer keyboard focus after startup and
  show retry feedback if loading fails.
- Download the rooms catalogue only when joining. Start live refreshes with
  the room and stop them when leaving, including after a cached rejoin.
- Self-host the existing font families and language subsets; preload the
  two Latin fonts. Use selected local SVG-mask icons, shared between the
  music and admin interfaces and loaded when those interfaces open.
- Request Google Identity Services only after an explicit sign-in action.
  Preserve credential verification, the admin allowlist, token exchange,
  password fallbacks and SDK retry handling.
- Resize the favicon, defer hidden artwork and audio preloading, add page
  descriptions/canonicals, and serve valid robots and sitemap documents.
- Revalidate HTML and cache fingerprinted `/assets/*` for one year. Avoid
  overlapping cache rules: Cloudflare Pages joins matching header values.

Final local production-build checks scored 100 in every category for home
(mobile/desktop), admin (mobile), and rooms (mobile). The final mobile home
run transferred 92 KiB with 0 ms blocking time and zero layout shift.

## Reproduce

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 5187 --strictPort
```

In another terminal, audit the local build or replace the URL with production:

```sh
npx --yes lighthouse@13.6.0 http://127.0.0.1:5187/ \
  --chrome-flags="--headless=new --no-first-run --no-default-browser-check" \
  --only-categories=performance,accessibility,best-practices,seo \
  --output=json --output=html --output-path=./lighthouse-mobile --quiet
```

Add `--preset=desktop` for desktop. Repeat for `/admin` and `/rooms`, using
separate output paths. Reports depend on the browser version and network
conditions; the measured browser was Chrome 157.0.0.0.

The isolated [browser regressions](artist-storage.md#concurrency-and-tests)
cover returning sessions, sign-in, local audio, stable playlist and artist
identity, playback continuity, admin editing, and room permissions. All
292 assertions across fourteen mobile/desktop suites passed for this change;
the 18 storage/client tests, typecheck, lint and production build also passed.

Production smoke checks passed **110 assertions** across six mobile/desktop
runs. They exercised browser-local sign-in, returning sessions, the live
catalogue and artist portraits, library-only search, playlist deduplication,
streamed audio, playback-safe refreshes, full-player controls, and the admin
and rooms entry screens. Google sign-in, authenticated admin editing and room
mutations are covered by the isolated regression suites.

Release verification matched all 13 deployed JavaScript/CSS bundles to the
local build, checked their immutable caching, and compared Cloudflare
configuration with the pre-release snapshot. The live artist directory
retained revision 18 and all 18 profiles from that snapshot.

Refresh pinned font/icon assets with `node scripts/vendor-ui-assets.mjs` after
adding icons. Font and icon licenses are in [`licenses/`](licenses/).
