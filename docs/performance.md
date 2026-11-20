# Aura Music — performance notes

What was optimized, what it bought, and how to keep it. Every change here is
reversible; nothing was deleted that the app still uses.

## Measured result

Critical path for the listener app (what must download before the app can boot),
gzipped:

| | before | after |
| --- | --- | --- |
| main JS | 85.7 K | 70.5 K |
| main CSS | 50.4 K | 43.5 K |
| **total** | **136.1 K** | **113.7 K** |

That is 22.4 K gz off the critical path, a 16.5% reduction. The JS figure is
1.2 K higher than the first pass alone because the boot fixes below add guards;
they remove megabytes of network and seconds of main-thread time, not bytes.

The splash animation's 17 K (gz) moved off the critical path entirely into its
own lazy chunk.

Time to interactive on the built site, local, cold cache: **load event 286 ms**,
DOMContentLoaded 239 ms, TTFB single-digit, single CSS request, splash chunk
fetched in parallel and never blocks boot.

On a throttled phone (Fast 3G, 4x CPU) the splash now clears at **~2,090 ms**
and the boot no longer downloads audio: see [Second pass](#second-pass-what-the-app-did-before-anyone-asked).

## What changed

### 1. The splash animation no longer blocks the app

`src/ui/loader.ts` imported the Liquid Glass renderer statically. Because
`src/main.ts` imports the loader first, 78 KB of shader source had to parse
before *anything* else in the app could run.

It is now a dynamic `import()` inside the loader. The static vinyl logo shows
until the renderer is ready (`#auraLoader:not([data-ready])` already did this),
so nothing looks different — the app just isn't waiting on it.

Two follow-on fixes in the same file:

- The `load`/`fonts.ready` listeners are registered **before** the dynamic
  import. Awaiting a network fetch before attaching them meant a `load` event
  firing during that await was missed, leaving the splash up until the failsafe.
- The intro floor dropped from 3800 ms to 1800 ms, and the sequence `speed`
  went 0.45 → 1.2 with `loopDelay` 2.4 → 0.6. The old numbers held the app
  behind a splash for nearly four seconds even when everything was parsed.

### 2. Icon sheet pruned to what is used

`src/styles/icons.css` vendored all 179 Font Awesome 6.4.0 icons: 128 KB raw,
29.5 KB gzipped, on the blocking stylesheet.

Now 128 icon rules / 95 KB raw / 22 KB gz — **28% smaller raw, 24% smaller gz**.

Regenerate with:

```bash
node scripts/prune-icons.mjs          # report what would change
node scripts/prune-icons.mjs --apply  # rewrite src/styles/icons.css
```

The script scans `index.html`, `admin.html`, `rooms.html` and all of `src/` for
`fa-*` names, plus a `DYNAMIC` list for icons built at runtime from ternaries
(`fa-${canPause ? 'pause' : 'play'}`, `fa-align-${alignMode}`, and the `toast()`
icon argument). **If you add a dynamically constructed icon, add its name to
`DYNAMIC` or it will be pruned.**

Nothing is lost: the complete original sheet is preserved at
`tooling/icons-full.css`, and the script always reads from there. Any dropped
icon can be restored by adding its name to the usage set and re-running.

Three icons the app referenced were never in the vendored sheet at all
(`sun`, `leaf`, `list-check` — the theme toggle and sidebar decorations were
rendering as blank boxes). They were added to `tooling/icons-full.css` from the
upstream Font Awesome 6.4.0 SVGs, so they now render.

### 3. Admin and Rooms stopped loading remote CSS

`admin.html` and `rooms.html` each pulled two blocking stylesheets from
third-party CDNs:

- `fonts.googleapis.com` for DM Sans + Cormorant Garamond
- `cdnjs.cloudflare.com` for the full Font Awesome CSS

Both pages already import `src/styles/fonts.css` (self-hosted, subsetted woff2,
`font-display: swap`) through their own stylesheet, so the Google Fonts request
was a duplicate. `admin.css` now also imports `icons.css`, which is where its
icons come from — previously it relied entirely on the cdnjs build.

Net effect: two fewer third-party origins on the critical path, no render-blocking
cross-origin CSS, and admin/rooms now work offline and behind a strict CSP.

Measured on the admin page:

| | before | after |
| --- | --- | --- |
| same-origin CSS | 52.8 K | 144.2 K |
| `cdnjs` Font Awesome | 102.0 K | 0 |
| `fonts.googleapis.com` CSS | 1.0 K | 0 |
| requests / origins | 3 / 3 | 1 / 1 |

The single file is bigger because it now carries the icon sheet locally, but it
is one same-origin request instead of three across three origins, two of which
needed their own DNS lookup and TLS handshake. Font binaries also stop coming
from Google's CDN — `fonts.css` serves them from the same immutable `/assets/`
path as everything else.

### 4. Caching headers

`public/_headers` set `no-store` on everything except `/assets/*`. That meant
every visit re-downloaded the logos, icons and manifest.

Now:

| path | cache |
| --- | --- |
| `/*` (HTML) | `no-cache, must-revalidate` — revalidates, so deploys land instantly |
| `/assets/*` | 1 year, immutable (content-hashed) |
| `/*.png`, `/*.svg`, `/*.webp` | 1 week |
| `/manifest.json` | 5 minutes |

Also added `X-Content-Type-Options: nosniff` and a `Referrer-Policy`.

### 5. Dead assets moved out of the bundle

These were in `src/assets/` or `public/` but referenced nowhere:

| file | size | moved to |
| --- | --- | --- |
| `hero-vinyl.png` | 580 KB | `tooling/unused-assets/` |
| `brand-logo.png` | 148 KB | `tooling/unused-assets/` (`.webp` is the one used) |
| `your-logo.svg` | 78 KB | `tooling/unused-assets/` (byte-identical duplicate of `aura-vinyl-logo.svg`) |

808 KB total. All three are still in git history and in `tooling/unused-assets/`,
so restoring any of them is a `git mv` back.

`public/aura-logo.png` was re-encoded losslessly with `optimize=True`:
139 KB → 113 KB. The original is still in git history (`git show HEAD:public/aura-logo.png`),
and a working copy is kept in `tooling/image-backup/` (gitignored).

## Verification

```
npm run typecheck   # clean
npm run lint        # clean
npm run build       # clean
npx playwright test # 153 passed (85 e2e + 68 unit)
```

Browser checks against the built site: all 1152 icon elements resolve a mask
(the theme toggle's sun→moon swap included), fonts report `loaded` with both
DM Sans and Cormorant available, no console errors beyond the pre-existing
Google Identity Services FedCM warning.

## Not done, and why

- **`main.css` is still one blocking file (221 KB raw / 43 KB gz).** Splitting
  it per-route would help, but the app is a single-page shell where every
  surface is in the same document, so there is no route to split on. The real
  win was the icon sheet, which is done.
- **`index.html` is 58 KB.** It is almost entirely inline markup for the whole
  app shell. Moving it into templates would delay first paint, not help it.
- **The JS bundle is 220 KB raw.** It is hand-written TypeScript with no
  framework; there is no single large dependency to cut. Further gains would
  come from splitting features behind interaction, which is a bigger change
  than a performance pass and needs its own testing.
- **Fonts are still 7 files.** The Cyrillic and Vietnamese subsets are unused by
  an `lang="en"` app, but they are only fetched by the browser when a character
  in that range appears, so they cost nothing at runtime. Removing them would
  break non-Latin song titles, which this library has plenty of.

---

# Mobile

Desktop numbers do not transfer to a phone. A phone has a slower CPU, a much
weaker GPU, a smaller viewport that makes horizontal rails worse, and often a
cellular connection. Measured with `scripts/mobile-probe.mjs`, which emulates an
iPhone 13 (390x664, DPR 3, touch) with the CPU throttled 4x.

## Measured result

| | before | after |
| --- | --- | --- |
| DOM nodes at boot | 8,404 | 965 |
| `<img>` elements in DOM | 937 | 10 |
| image requests on load | 205 | 57 |
| time behind the splash | 3,096 ms | 2,325 ms (1,933 ms on the second pass) |
| JS heap | 9.5 MB | 12.1 MB |

The heap figure moves around between runs (it depends on what the catalogue
returns); it is not a regression signal here.

## What was actually wrong

Profiling found the problem was **not** CSS, fonts or bundle size. It was that
the Home tab eagerly built the entire library.

**1. The Home preview rendered all 493 tracks.** `#songList` is the "From your
library" preview on Home, not the full library (that is `#librarySongList`,
built on demand by `renderLibrary`). It rendered every track: 493 rows, 493
cover `<img>` tags, ~200 cover images fetched from Hugging Face before the user
touched anything. `loading="lazy"` does not defer inside a subtree that is
`display:none`, and the Library tab is hidden on boot, so lazy loading never
engaged. Capped at 12 rows.

**2. The artist spotlight rendered every song of every artist.** 334 cards in
horizontal rails. `loading="lazy"` does not defer inside a horizontal scroller
either, so every card's cover was requested. Capped at 6 blocks x 10 cards, and
`content-visibility: auto` added to rail children so offscreen cards never
request at all.

**3. The splash gated on `window.load`.** That event does not fire until every
image in the document has downloaded. The app was interactive at ~290 ms but sat
behind a splash for ~3 s waiting on cover art for rails nobody had scrolled to.
It now gates on DOM readiness plus fonts, which is what "the app can paint
correctly" actually requires. Images stream in behind the splash.

**4. The splash's own animation was too long on touch.** Floor cut from 1800 ms
to 900 ms on coarse-pointer devices, cap from 4000 ms to 2600 ms. The animation
still plays; it just stops making a phone user wait for a brand moment.

**5. The splash renderer and orb ignored device capability.** The Liquid Glass
renderer shades a fullscreen fragment shader every frame: at DPR 3 a 393px phone
shades ~1.13 megapixels per frame. It now caps DPR at 1.25 on low-core devices instead of 2, and touch devices
skip the shader entirely. The 2D orb loader likewise drops from 520 to ~285
particles and caps DPR at 1.5.

## Keeping it

`node scripts/mobile-probe.mjs [url]` prints the table above for any URL. Run it
after touching Home, the library list, or the splash. The numbers that matter:
DOM nodes under ~1,500, image requests under ~80, splash under ~2.5 s.

The rule the two list fixes encode: **a preview must not render the whole
collection.** If a surface is a rail or a "top N" strip, slice it at render time.
`content-visibility` is the safety net for the ones that genuinely need many
children, not a substitute for slicing.

## Second pass: what the app did before anyone asked

The first pass made the *document* cheap. This pass made the boot **not do
work nobody requested**. Measured on the same emulated iPhone 13 with Fast 3G
(150 ms RTT, 250 KB/s) and 4x CPU throttling, cold context:

| | before | after |
| --- | --- | --- |
| splash gone | 6,394 ms | ~2,090 ms |
| DOMContentLoaded | 2,348 ms | ~1,240 ms |
| long tasks | 11 / 5,814 ms total / 2,390 ms max | 4–5 / ~600 ms total / ≤300 ms max |

**1. Boot downloaded the first song.** `loadSong(0)` assigned `audio.src` and
called `audio.load()`. Chrome's `load()` starts a range request even with
`preload="none"`, so every visitor pulled the whole 1.44 MB file before pressing
play (verified from the network entry: 1,438,347 bytes). Boot now only paints
the player bar's title and artwork; the source is assigned by the first real
play (`loadSong(i, prepare, loadSource)` in `src/features/player.ts`). The same
call also prepared the bass / bass-reverb renditions, which fetch and
`decodeAudioData` every version — that now happens on play, not on load.

**2. The home screen waited for IndexedDB.** `hydrateLocalTracks()` was awaited
before the first render, although `state.songs` is already seeded from the
localStorage catalogue at module init. The first paint now happens immediately
and hydration only refreshes the rails when it resolves.

**3. The catalogue refresh raced the first paint.** With a warm cache the
Hugging Face fetch now waits for an idle slot (`requestIdleCallback`, 3.2 s
timeout); a cold visit still fetches immediately because there is nothing else
to show. The remaining ~290 ms long task is the cold catalogue parse and merge —
it is real work, but it no longer overlaps the splash.

**4. Search was a second page that rendered the whole library.** The Search
tab was also the destination of the header field, so a keystroke rebuilt 493
rows — 561 KB of HTML, ~3,400 extra DOM nodes, a 20.6 ms `innerHTML` at 4x CPU,
and 493 artwork requests — inside a tab most people never opened. Search now
lives in the Home page, directly under its field, and renders **nothing until
it is opened**: 30 rows per page with a "show more" control, a cached
per-song haystack, and 70 ms coalescing between keystrokes. At 4x CPU throttle
the panel opens in 13.8 ms including its first 30 rows, the first query costs
3.9 ms (it builds the cache), and each later keystroke costs ~1.1–1.6 ms.
Enter, clear, Escape and the category chips apply immediately, and leaving Home
closes the panel so the feed is what you come back to.

**5. One heart tap rebuilt three surfaces.** `toggleFavorite()` ran
`filterSongs()`, `renderQuickAccess()` (picks + artist shelf) and
`renderLibrary()` (493 rows) for a single boolean. Visible hearts are patched in
place, artist grouping is memoised against `libraryVersion` + the artist overlay
string + a song fingerprint, and returning to an unchanged Library tab reuses
what is already on screen (`renderLibraryIfStale()`).

**6. Rails repainted identical content.** The picks, featured artists and
spotlight now compare a content signature and skip `innerHTML` when nothing
changed, so playback no longer re-creates dozens of `<img>` nodes per update.
Horizontal rails also set `overscroll-behavior-x: contain`, so a swipe at the
end no longer triggers the browser's back gesture.

Each skip stays correct because the signature includes everything the rail
draws: a changed favourite, artist profile, track order or play state changes
it, and returning to the Library tab also checks the catalogue version.

---

# Caching

Three cache layers, each with a different lifetime and a different reason to
exist. All of it is constrained by Cloudflare's documented behaviour, which is
where the subtle bugs live.

## The layers

| layer | what | lifetime | invalidated by |
| --- | --- | --- | --- |
| Browser + edge, static | hashed build output under `/assets/` | 1 year, immutable | a new hash in the filename |
| Browser + edge, static | unhashed logos/icons in `public/` | 1 week | a deploy |
| Browser + edge, HTML | `index.html`, `admin.html`, `rooms.html` | revalidate every time | a deploy |
| Edge, audio | `/api/audio` full 200s | 1 day, keyed by revision | a new rendition (new key) |
| Edge, versions index | `/api/versions` GET | 5 min + 60s stale-while-revalidate | time |
| Never cached | admin mutations, auth, status | — | — |

## Cloudflare rules this depends on

These are the constraints that shaped the implementation. Each one is a way the
code would be wrong if ignored.

**1. Repeated headers are joined, not overridden.**
A `Cache-Control` set by two matching `_headers` rules becomes one
comma-joined value, and `no-cache` wins over `max-age`. A blanket rule on `/*`
therefore defeats every narrower rule below it. Narrower rules must detach
first:

```
/*        Cache-Control: no-cache, must-revalidate
/assets/* ! Cache-Control
          Cache-Control: public, max-age=31536000, immutable
```

**2. A splat is greedy and matches `/`.**
`/*.png` also matches `/assets/logo-B6rNPeia.png`. So the extension rules must
come *before* `/assets/*`, or they would detach the immutable rule and silently
downgrade hashed assets to a week. `/assets/*` is deliberately last.

**3. `cache.put` throws on 206 Partial Content.**
Audio is range-heavy: seeking issues `Range` requests. Caching a partial body
would either throw or, worse, store a fragment as if it were the whole file.
`writeEdgeCache` refuses anything that is not a 200, and the call sites only
pass full responses.

**4. `cache.match` slices a cached 200 into a 206 itself.**
This is what makes seeking work with a whole-file cache: the lookup carries the
`Range` header and Cloudflare returns the slice. Nothing partial is ever stored.

**5. The cache key is the URL.**
`cache.match` cannot be told to ignore headers, so the revision cannot live in a
header — a stale rendition is the one failure that would be audible. The
revision is part of the key instead, so a re-published rendition is a different
entry. The key is built on the real request origin; nothing in the docs promises
a synthetic hostname resolves to a usable cache entry.

**6. Cache API is per-datacenter, not global.**
An entry written in one colo is not visible in another. That is fine here: it is
an accelerator in front of the OCI hot cache and Hugging Face, not a source of
truth. Nothing correctness-critical depends on a hit.

## Verification

```bash
node scripts/validate-headers.mjs          # resolve every rule against the build
node scripts/validate-headers.mjs --dump   # also print resolved Cache-Control
npx playwright test tests/unit/audio-edge-cache.spec.ts
```

`validate-headers.mjs` models the join/detach/splat rules and asserts what each
real build file resolves to. It is not decorative: reordering `/assets/*` above
the extension rules produces 6 failures, and removing the `! Cache-Control`
detaches produces a failure on every hashed asset. Both were real bugs during
this pass.

`audio-edge-cache.spec.ts` uses a fake `caches.default` that rejects 206 the way
the real one does. It caught a genuine bug: `writeEdgeCache` rebuilt the response
with a hardcoded `status: 200`, so a partial body would have been stored as a
whole file.

## What is deliberately not cached

- **Anything without a revision.** If the identity lookup fails, the file at a
  path can be replaced, so it streams uncached rather than risk a stale hit.
- **HEAD requests.** They would populate the cache with an empty body.
- **Admin mutations.** `POST /api/versions` and every admin route are `no-store`.
- **The hot-cache status endpoint.** It is admin-only and returns live counts.
- **Error responses.** 4xx/5xx are `no-store`; caching a transient 502 would
  turn a blip into a day-long outage.

## Fourth pass: the hand-off from the logo reveal

The complaint was specific: the logo animation ends and the app underneath is
not there yet. On a phone the owner saw a home screen that read "No library
tracks are available yet. Add local audio or check the catalogue connection."
for a few seconds — an error-looking state during a completely normal boot.

### What was actually happening

The catalogue lived in the browser. Boot ran

1. `tree?recursive=true&limit=1000` for the bucket → **2 paginated requests,
   1,993 entries, 522 KB of JSON**,
2. `manifest.json` (~1.4 s on its own),
3. `/api/versions` (38 KB from D1),

then merged all of it on the main thread. None of that started until the module
graph had evaluated, so it could not overlap the splash at all. Measured on a
throttled phone (390×844, 4× CPU, 10 Mbps, cold cache): real quick-pick cards
at **~2.8 s**, and a 5/5 chance of the empty-library message being on screen in
between.

### 1. The catalogue is compiled at the edge, once, and cached

`functions/api/catalog.ts` lists the bucket, reads the manifest and calls
`publicVersions()` on the server, then compiles the tracks with the *same*
`compileCatalog()` the client uses (`src/core/catalog.ts`). The response is
compact — `url`/`hfUrl` are derived from `hfPath` on the client instead of being
repeated twice per track — and cached in `caches.default` with
`max-age=300, stale-while-revalidate=600`.

| | before | after |
| --- | --- | --- |
| requests before Home fills | 2 tree pages + manifest + versions | **1** |
| JSON parsed in the browser | ~560 KB | **316 KB (50 KB gzip)** |
| cacheable at the edge | no | yes (`cf-cache-status: HIT`) |

`fetchCatalog()` adopts the prefetched promise, then `tracksFromCatalogResponse()`
rebuilds the player shape and rejects anything malformed. If the Function is
missing (the Vite dev server) or answers 503/slow (>5 s), the client falls back
to the direct bucket listing exactly as before — the fast path is never the only
path.

### 2. The request starts before the document is parsed

`index.html` issues the `/api/catalog` fetch as the first thing in `<head>`,
before the inline loader CSS, and only when a session exists (the welcome screen
does not need a catalogue). The request now overlaps the logo animation instead
of queueing behind it.

### 3. The rails exist before JavaScript does

Home used to be an empty grid until `renderQuickPicks()` ran, seconds later. The
document now ships the skeleton cards themselves — 12 quick picks, 8 artists,
8 picks — and the renderers leave that markup alone instead of repainting it.
The rails' `aria-hidden` placeholders are replaced in place, so the layout does
not jump when the real cards land. "No library tracks are available yet" is
reserved for a catalogue that actually came back empty.

### Measured

Median of five cold runs, 390×844, 4× CPU, 10 Mbps, cold HTTP cache:

| | before | after |
| --- | --- | --- |
| quick-pick cards painted | 2,768 ms | **1,675 ms** |
| empty-library / "Loading artists…" visible | 5/5 | **0/5** |

### Verification

```bash
npx playwright test tests/unit/catalog-function.spec.ts   # Function contract + edge cache
npx playwright test tests/unit/catalog-edge.spec.ts       # payload → player round-trip
npx playwright test tests/e2e/home-boot.spec.ts           # skeletons instead of the empty state
```

`catalog-function.spec.ts` stubs the bucket and a fake `caches.default`: it
fails if the endpoint stops following `Link: rel="next"`, starts shipping
redundant URLs, forgets the cache, or answers anything but 503 when the listing
breaks.

### Not done, and why

- **Serving the payload to signed-out visitors.** The welcome screen never
  renders a track, so that request would be pure waste on cellular.
- **Waiting for the catalogue before dismissing the splash.** It would make
  every slow connection slower to interactive; the skeleton rails do the same
  job without holding the app hostage.

## Fifth pass: the intro only plays when the boot needs covering

The logo reveal used to run on every visit: a floor of 1,100 ms on desktop and
350 ms on touch, then a 450 ms dissolve. On a fast connection the app was ready
in roughly a third of that, so the animation was pure delay — the site was
finished and the listener was still watching dots.

It is now a fallback rather than a gate.

### How the decision is made

`index.html` contains a small gate that runs while the head is parsed, before
the body exists:

- **Slow signals** — `saveData`, `effectiveType` of `3g`/`2g`/`slow-2g`,
  `rtt >= 400 ms`, or two cores — reveal the splash immediately, so it covers
  the boot from the first paint.
- **Everyone else** waits 1,500 ms (1,800 ms on touch). If `markAppReady()` has
  run by then, the splash never appears at all; if not, it fades in and covers
  the boot. The budget is deliberately generous: a healthy boot on a fast device
  can take a second on a busy phone, and flashing the intro at 560 ms only to
  cover a screen that was about to paint is worse than showing it late. Slow
  connections never reach this branch — they reveal from the first paint. The attribute is applied even before the body is parsed, so a document
  that streams slowly still shows the cover the moment the element exists.
- **Missing the budget on a fast device but ready shortly after** is handled by
  the loader: the splash is never shown for less than ~220 ms and dissolves in
  200–300 ms, so it reads as an intro rather than a flicker.

`src/core/boot.ts` fires `markAppReady()` once the first meaningful screen is in
the DOM: the welcome screen for signed-out visitors, the cached/local rails when
a library already exists, and the catalogue response (or its failure) on a cold
visit. The loader hears `aura:ready`, unlocks scroll and removes the splash. A
crash that prevents the module graph from running is covered by a 10 s inline
failsafe that removes the cover and the scroll lock.

The renderer chunk is imported inside `start()` instead of at module scope, so a
fast boot never downloads the shader it will not show.

Measured on the built site:

| | before | after |
| --- | --- | --- |
| intro on a fast desktop (cards at ~420 ms) | shown, floor 1,100 ms | **never shown** |
| intro on a 4× CPU / 1.25 Mbps phone | shown from parse | shown from parse, leaves ~0.4 s after ready |
| first content on a fast desktop | after the intro | **immediately** |

### What this does not do

The budget is a time-to-ready test, not a speed test: a fast machine on a cold
CDN edge can still miss 1.5 s and get the intro, and a slow machine with a warm
cache can skip it. Both outcomes are correct for what the listener experiences —
the animation only ever covers a wait that is actually happening.

## Sixth pass: the login screen only paints for guests

`#welcomeScreen` is a fixed overlay on top of the app. The app hid it from
`init()` once the bundle had loaded — fast enough that a reload never showed
it, but a cold first visit painted the sign-in screen for the length of the
module download before Home replaced it. With the intro splash no longer
covering every boot, that flash became visible.

The decision now happens in the document, not in the bundle: an inline script
runs before the body exists, reads the same session record `getSession()` uses
(email, token, unexpired `exp`) and marks `<html data-aura-authed>`. The loader
stylesheet, which is already parsed at that point, hides `.welcome-screen` for
that attribute, so the first paint is already Home. Guests get
`data-aura-guest` and the overlay stays up — and stays eligible for the
fallback splash, which is what covers their boot.

The same script releases the scroll lock for signed-in visitors, because the
app is on screen and nothing should cover it. `init()` removes the attribute
again if the session turns out to be expired by the time the bundle runs, so a
sign-in screen can never be lost.

Verified with the entry module blocked (so the app never runs): a signed-in
document paints with the overlay hidden, a signed-out one keeps it. On a
4× CPU / 0.5 Mbps profile the signed-in first paint is Home at ~3.8 s instead
of the login screen followed by Home.

## Seventh pass: Lighthouse, and the CSS a first visit does not need

The goal was a perfect mobile and desktop Lighthouse run on the live URL.
The first audit scored 70 mobile — not because anything was slow to compute but
because the boot still did work the screen never used.

### What the audits found

| audit | mobile, before | why |
| --- | --- | --- |
| total blocking time | 8.3 s | the whole app graph (198 kB) evaluated before the login screen was settled |
| first contentful paint | 1.3 s | 15 kB document, then a round trip for a 44 kB stylesheet |
| `charset` / best practices | 96 | `<meta charset>` sat past Lighthouse's 1,024-byte window |
| largest contentful paint | the splash PNG | the 17 kB intro art became the LCP candidate on guests |
| cumulative layout shift, desktop | 0.108 | the invisible Home behind the overlay kept re-laying out |

### What changed

- The entry split in two: `main-*.js` (28 kB — loader, session, login, boot)
  starts immediately, and the 198 kB app chunk is imported only once a session
  exists or a sign-in completes. A guest never downloads the player, library,
  lyrics, playlists, rooms or the media-session shim.
- The landing stylesheet is inlined at build time (`inlineLandingCss()` in
  `vite.config.js`) instead of linked. Vite does not process a stylesheet link
  that carries `media="print"` or sits in `<noscript>`, so the inline pass reads
  the *built* asset — with hashed font URLs and `@import`s already resolved —
  and replaces the link with a `<style>` block. One less round trip before the
  first paint; the tradeoff is that the document is no longer cacheable
  separately from the CSS (`/` is `max-age=0` anyway, and the SPA is a single
  navigation).
- `critical.css` now holds only what the document can paint — fonts, icons,
  tokens, base, shell, nav, profile, login, home, player bar, effects — and the
  app-interior sheets (library, artists, search, full player, audio versions,
  lyrics, radio, overlays, track sheet, settings, playlists) are imported by the
  app chunk. A guest parses 536 rules instead of 1,180; HTML transfer went
  293 kB → 218 kB (59 → 48 kB gzip, 49 kB brotli). A signed-in visitor gets the
  deferred sheets together with the code that builds the markup they style, so
  nothing paints unstyled.
- `charset` and `viewport` moved to the top of `<head>`.
- The splash art is drawn in CSS (`.aura-fallback-vinyl`) instead of the PNG, so
  the intro can no longer win the LCP race; the brand image on the login screen
  is `alt=""`, `loading="lazy"` and `fetchpriority="low"`.
- Guests get `html[data-aura-guest] .app-container { display: none }`, so the
  overlay no longer lays out a Home nobody can see.

### Measured

Live URL, Lighthouse 13.6, three consecutive mobile runs and one desktop run:

| | mobile | desktop |
| --- | --- | --- |
| Performance / Accessibility / Best Practices / SEO | **100 / 100 / 100 / 100** | **100 / 100 / 100 / 100** |
| first contentful paint | 1.13–1.16 s | 310 ms |
| largest contentful paint | 1.13–1.16 s | 310 ms |
| total blocking time | 0–46 ms | 0 ms |
| cumulative layout shift | 0.0053 | 0.0002 |

The local preview (`vite preview`, same throttling) is a little faster still:
mobile FCP 0.95 s, desktop FCP 0.26 s. The remaining mobile cost is the 49 kB
document itself plus CDN latency; the only weightless layout shift left is DM
Sans swapping in for the fallback on the sign-in copy.

### Keeping it

- The style split is verified by comparing fourteen landmarks (computed display,
  colour, typography, geometry, mask) at 1440 px and 390 px, signed in and signed
  out: the two builds are identical except a margin inside the shell guests do
  not render.
- `npm run build` must keep emitting exactly one inlined `<style>` for `/` and a
  separate app stylesheet; if `inlineLandingCss()` stops matching, the page
  silently returns to a blocking link and the FCP budget goes with it.
- Adding a component that the document markup uses before the app chunk runs
  means adding its sheet to `critical.css`, not `main.css`.
