# Lighthouse performance

Benchmarks use Lighthouse **13.6.0**, Chrome **157.0.0.0**, fresh headless
profiles and the default simulated mobile/desktop presets. All five categories
are enabled on the real public signed-out home, admin and rooms entry pages.
No audit-only markup or user-agent branching is used.

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

### Agentic Browsing baseline

The separate mobile-home observation at **16:45:05.514 UTC** on `42cd4ec` was
**2/4 applicable audits**: accessibility tree and layout shift passed;
`llms-txt` and `ard-schema` failed while discovery URLs returned homepage HTML.
`baseline-agentic-home-mobile.summary.json` is a retained observed summary,
reconstructed from session observations. Its original full Lighthouse report
was not retained, and the user's original PageSpeed Insights report was unavailable.

## Local and production results — 10 November 2026

All six local and six live audits cover implementation commit `51e1a9f`.
Local runs were fetched at **18:09:32–18:10:30 UTC** and live runs at
**18:13:38–18:14:35 UTC**. The following results apply to both environments:

| Page | Device | Performance | Accessibility | Best practices | SEO | Agentic Browsing |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Home | Mobile | 100 | 100 | 100 | 100 | 4/4 |
| Home | Desktop | 100 | 100 | 100 | 100 | 4/4 |
| Admin | Mobile | 100 | 100 | 100 | 100 | 4/4 |
| Admin | Desktop | 100 | 100 | 100 | 100 | 4/4 |
| Rooms | Mobile | 100 | 100 | 100 | 100 | 4/4 |
| Rooms | Desktop | 100 | 100 | 100 | 100 | 4/4 |

Agentic Browsing is a **passed/applicable fraction**, alongside the four numeric
scores. Its accessibility-tree, layout-shift, `llms-txt` and `ard-schema` audits
passed. WebMCP form coverage, registered tools and schema validity were **N/A**
and are excluded from that fraction. All twelve runs completed without
Lighthouse warnings or runtime errors.

| Mobile page | Live FCP / LCP | Live blocking | Live transfer | Local FCP / LCP | Local transfer |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home | 0.930 s | 16 ms | 94 KiB | 0.763 s | 93 KiB |
| Admin | 0.905 s | 0 ms | 115 KiB | 0.756 s | 113 KiB |
| Rooms | 0.790 s | 40 ms | 105 KiB | 0.757 s | 102 KiB |

Layout shift is zero in every run. Blocking time is zero in all local runs and
all live desktop runs. Live mobile Home transfers approximately **99.5% fewer
bytes** than the initial baseline; Rooms transfers 105 KiB versus its earlier
5.76 MiB eager-entry transfer.

[`lighthouse-results.json`](lighthouse-results.json) records every run's full
implementation hash, UTC timestamp and exact metrics: timings in **milliseconds**,
layout shift **unitless**, and transfer size in **bytes**. The table rounds FCP/LCP
to seconds and transfer sizes to KiB (1 KiB = 1,024 bytes).

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
- Publish truthful [discovery documents](discovery.md): `/llms.txt`, the ARD
  0.91 manifest at `/.well-known/ard.json`, and `/docs/public-resources.json`.
  They describe existing read-only resources and actual sign-in/crawler access
  rules. The legacy `/.well-known/ai-catalog.json` URL redirects to the manifest.
  These static resources preserve lazy entry; they introduce no WebMCP tools or
  eager catalogue/audio initialization.
- Revalidate HTML and cache fingerprinted `/assets/*` for one year. Avoid
  overlapping cache rules: Cloudflare Pages joins matching header values.

## Reproduce

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 5187 --strictPort
```

In another terminal, audit the local build or replace the URL with production.
Choose an existing evidence directory outside git:

```sh
npx --yes lighthouse@13.6.0 http://127.0.0.1:5187/ \
  --chrome-flags="--headless=new --no-first-run --no-default-browser-check" \
  --only-categories=performance,accessibility,best-practices,seo,agentic-browsing \
  --output=json --output=html --save-assets \
  --output-path=/path/outside/git/local-home-mobile --quiet
```

Add `--preset=desktop` for desktop. Repeat for `/admin` and `/rooms`, using
separate output paths. Reports depend on browser version and network conditions.
The [discovery guide](discovery.md#document-checks) also documents document/schema
validation and the Pages-specific HTTP redirect checks.

## Regression and release verification

The recorded isolated checks for this implementation passed:

| Check | Recorded result |
| --- | --- |
| Node tests | 132 passed, 0 failed |
| Browser regressions | 28 suites, 1,268 assertions, 0 failed |
| Native keyboard | 53 checks, 0 failed |
| axe accessibility | 72 app states + 16 rooms states; 0 violations, horizontal overflows or uncaught errors |

Browser and native-input runs use **390×844** and **1440×960**. Entry frame
sampling can change assertion totals on reruns. Typecheck, lint, production
build, Worker typecheck and Worker dry run also passed. An earlier **local
Worker** end-to-end run passed **22 checks**, recorded as a session observation.

Coverage includes [entry, identity and rooms](artist-storage.md#concurrency-and-tests),
[playback races](../tests/playback/README.md), and
[playlist sharing/native controls](../tests/playlists/README.md). Google sign-in,
admin editing and room mutations use isolated regression fixtures. **Live admin
saving was not verified:** no usable live admin credential was available.

### Production smoke

`production-smoke-summary.json` records **146 checks across six completed runs**
on audited implementation `51e1a9f`:

| Page | Mobile | Desktop |
| --- | ---: | ---: |
| Home | 55 | 55 |
| Admin entry | 9 | 9 |
| Rooms entry | 9 | 9 |

Each Home total includes **11 recipient checks** in an independent browser
context with separate storage. On each device, **two shared tracks** resolved
from the actual **407-track live library**; catalogue arrival preserved exact
saved bytes, and repeat import reused the saved copy. Home used browser-local
sign-in; admin and rooms checks covered only entry gates, with no remote mutations.

Returning-session sampling captured **3 mobile frames and 1 desktop frame**,
with **zero visible sign-in frames** in each sample. Both recorded
`returning: true` and `done: true`; these observations apply to the captured
frames, not every possible visit.

Final totals combine the completed mobile run with a filtered desktop rerun
after a clean Chrome exit (`Connection closed`) interrupted its recipient step.
The harness's earlier catalogue assertion was corrected to wait for
`!state.catalogLoading`; the application needed no changes.

### Verified implementation deployment

The verified implementation Pages deployment is
`21552980-40c6-4859-95f5-f8bf82d4d194`, for `51e1a9f`.
Release verification matched **13 live JavaScript/CSS bundle SHA-256
hashes** to the local build and confirmed `public, max-age=31536000, immutable`
caching. Pages source, build and deployment configurations matched their
pre-release snapshot. The live artist directory remained exactly equal
to its snapshot at **revision 18, all 18 profiles**.

Rooms Worker version `798c7ce0-da30-4fd8-b2e8-11866dc79ab5` was verified at **100%**.
Its runtime settings and subdomain were preserved; the only intentional metadata
addition was `annotations.workers/message`. These release comparisons were
recorded at **18:13:17 UTC** in `implementation-release-verification.json` and
`worker-release-verification.json`. The archive's `release-verification.json`
records the final documentation deployment and rechecks the same application
bundles, configuration and artist snapshot.

## Evidence

Release evidence is packaged outside git as `aura-ux-and-discovery-2026-11-10.zip`:
the local/live JSON and HTML reports, retained observed Agentic baseline, safe
verification summaries, `run-keyboard-regressions.mjs` and screenshots. Report
and summary filenames in `lighthouse-results.json` refer to that evidence set
outside git. `functional-verification.json`, `browser-regressions-summary.json`,
`keyboard-regressions.json`, the app/rooms axe summaries and
`production-smoke-summary.json` retain the detailed verification results.

Refresh pinned font/icon assets with `node scripts/vendor-ui-assets.mjs` after
adding icons. Font and icon licenses are in [`licenses/`](licenses/).
