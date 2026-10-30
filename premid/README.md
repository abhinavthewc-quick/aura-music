# Aura Music — PreMiD activity

Shows what you're playing on [Aura Music](https://aura-music-01g.pages.dev) in
Discord: track, artist, cover art, playback progress, and the site name.

```
premid/
└── websites/A/Aura Music/
    ├── metadata.json   # store entry: name, domain match, settings, artwork
    ├── presence.ts     # the activity itself (Discord presence logic)
    ├── state.ts        # reads the page contract (unit-testable, no Discord deps)
    └── tsconfig.json   # editor/tsc config for the Activities repo
```

The activity is written against the current PreMiD Activities format
(`metadata 1.17`, `apiVersion 1`, TypeScript 6) and typechecks against
`@types/premid` from the upstream repo.

---

## How the site exposes its state

Aura is a static SPA with no API to query, so the player mirrors its state for
browser extensions. Three layers, in the order the activity tries them:

| Layer | For | Contents |
| --- | --- | --- |
| `window.auraPresence` | PreMiD `getPageVariable()` (extension 2.5+) | plain snapshot object |
| `window.AuraPresence.getState()` | PreMiD `execInPage()` (2.14+) | snapshot with a live position |
| `#auraPresence[data-*]` | any content script | same values as text attributes |

The hidden element looks like this while a library track plays:

```html
<div id="auraPresence" hidden aria-hidden="true"
     data-v="1" data-site="Aura Music" data-kind="track"
     data-title="Starboy" data-artist="The Weeknd" data-album="Starboy"
     data-cover="https://…/Starboy.jpg" data-url="https://…/"
     data-video-id="3_g2un5M350" data-duration="230.4" data-position="42.1"
     data-playing="1" data-live="0" data-tab="Home"
     data-updated-at="1699999999999"></div>
```

- `kind`: `idle` | `track` | `radio`
- `duration` / `position`: seconds; `0` for live radio
- `updatedAt`: epoch **milliseconds** of the last publish (the activity uses it
  to extrapolate the position between one-second ticks)
- `tab`: the active section (`Home`, `Search`, `Library`, `Radio`, `Add Music`)
- `cover`: absolute `http(s)` URL, or empty when the art is a placeholder

The site side lives in `src/core/presence.ts` (publisher) and
`src/features/presence-reporter.ts` (reads the player once a second). It is
wired from `src/main.ts`; `index.html` contains the hidden element. **Deploy the
site before testing**, or the activity will only show browsing mode.

The activity does not scrape player markup, so restyling the UI cannot break the
Discord status — only a change to the contract above would.

---

## 1. Create the Discord application

1. Open <https://discord.com/developers/applications> → **New Application**.
2. Name it **Aura Music**. That name is what Discord shows ("Listening to
   Aura Music"); the activity's `service` name is only for the PreMiD store.
3. Upload [`public/aura-logo.png`](../../public/aura-logo.png) as the app icon.
4. Copy the **Application ID** and paste it into `CLIENT_ID` at the top of
   `presence.ts`.

Without a real application ID, the extension will refuse the connection.

## 2. Build and deploy the site

The bridge and the activity artwork are part of the site build:

```bash
npm run build      # dist/ now contains aura-logo.png, aura-thumbnail.png
```

Deploy `dist/` as usual. `metadata.json` points at
`https://aura-music-01g.pages.dev/aura-logo.png` and `/aura-thumbnail.png`; if you
use a custom domain, update those two URLs, `url`, `regExp` and `SITE_URL` in
`presence.ts`.

## 3. Develop the activity

```bash
git clone https://github.com/PreMiD/Activities.git
cd Activities
npm install

# from the Aura Music repo:
mkdir -p "Activities/websites/A"
cp -R "premid/websites/A/Aura Music" "Activities/websites/A/"
```

Then:

1. Install the PreMiD extension + desktop app: <https://premid.app/downloads>
2. Extension settings (⚙️) → enable **Activity Developer Mode**.
3. In the `Activities` repo: `npx pmd dev "Aura Music"`.
4. Open <https://aura-music-01g.pages.dev> (or `http://localhost:5173` while
   running `npm run dev` in this repo) and play something.

`pmd dev` watches the folder, rebuilds on change and pushes the activity to the
extension. Add `--validate` to check metadata and artwork:

```bash
npx pmd dev "Aura Music" --validate
```

## 4. What to check

- Nothing playing → "Browsing Aura Music" with the current tab and a timer.
- A library/YouTube track → song title, artist, cover, elapsed/remaining bar.
- Pause → pause icon, timer disappears (Discord cannot show a frozen bar).
- Seek → the bar jumps to the new position within a second.
- YouTube playback → a **Play on YouTube** button (plus **Open Aura Music**).
- Live radio → station name, `Live radio`, no timer.
- Settings → privacy mode, cover on/off, timestamps, status display
  (app/artist/song), buttons, hide-when-paused, browsing.

## 5. Publishing (optional)

Personal use is fine as a sideloaded dev activity — just keep the folder in your
local `Activities` clone and run `pmd dev` when you want the status.

To submit it to the PreMiD store:

1. Replace the placeholder `author` in `metadata.json` with your Discord
   username and numeric ID (the schema validates the format).
2. Move the artwork to PreMiD's CDN (the maintainers handle uploads through the
   PR review/`update-assets` flow) and update `logo` / `thumbnail`.
3. Remove the `localhost:5173` alternative from `regExp` if you prefer, and make
   sure `service` still matches the folder name (`Aura Music`).
4. Open a PR against <https://github.com/PreMiD/Activities> following their
   [README](https://github.com/PreMiD/Activities#readme).

## Implementation notes

- `presence.ts` never imports the site bundle; it only reads the contract.
- `state.ts` has no Discord dependency and can be exercised in plain Node (it
  takes an optional `now` argument so position extrapolation is testable).
- Timestamps are computed with `getTimestamps(position, duration)` only while
  playing a non-live item with a known duration, so Discord's bar is accurate in
  both directions.
- Artwork is restricted to `http(s)` URLs (data URIs fall back to the logo),
  because Discord cannot fetch `data:` images.
- `metadata.json` validates against `https://schemas.premid.app/metadata/1.17`.
- Not covered yet: `rooms.html` ("Listen together") is a separate page with its
  own player, so a synced room shows browsing mode. It can publish the same
  contract later without touching this activity.
