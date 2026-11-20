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
