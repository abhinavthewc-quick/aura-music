# Playlist sharing regressions

## Node checks

From the repository root:

```sh
node --import tsx --test tests/playlists/*.test.ts
npm run typecheck
npm run lint
npm run build
```

The tests use hand-built wire payloads as well as complete sender → URL →
recipient round trips. They cover stable catalog keys and aliases, missing/local
files, Unicode, size limits, invalid UTF-8/JSON/schema, and account/URL exclusion.

## Browser checks

Start the existing **local-only** fixture server:

```sh
npm run test:artists:browser
```

Open a fresh `http://127.0.0.1:5186/tests/artists/browser.html` in an isolated
browser profile. Each fixture load resets its origin's local storage; see
[fixture setup](../../docs/artist-storage.md#browser-fixtures). In its console:

```js
const suite = await import('/tests/playlists/browser-playlist-regressions.js');
const result = await suite.runPlaylistSharingRegressions();
console.log(result);
```

This in-page suite uses programmatic clicks, synthetic keyboard events and
stubbed Web Share/clipboard APIs. It checks sharing success/cancellation/rejection,
both clipboard fallbacks, manual copying, size errors, preview/import/storage
failure, repeat import, malicious markup, library-only matching and active audio
continuity. It also opens a received link behind the full player and checks the
active keyboard scope and Escape handling. Real browser key input is covered by
the [native keyboard checks](#native-keyboard-checks) below.

For **startup** receipt, copy `new URL(result.arrivalLink).hash`. Open each of
these in a separate, clean browser context, appending that fragment:

1. `http://127.0.0.1:5186/tests/artists/browser.html`
2. `http://127.0.0.1:5186/tests/artists/browser.html?signed-out`

Then run, respectively:

```js
(await import('/tests/playlists/browser-playlist-regressions.js'))
  .runPlaylistArrivalRegressions();
```

```js
(await import('/tests/playlists/browser-playlist-regressions.js'))
  .runPlaylistArrivalRegressions({ signIn: true });
```

The signed-out case uses a synthetic local fixture account and an empty playlist
store/catalog cache. It exercises the existing first-entry username flow before
the received snapshot opens. All saving requires the explicit Save button.

[browser-suites.json](browser-suites.json) contains equivalent entries for the
parent browser-suite registry, including a captured Unicode sender link for
fresh/returning startup. Run sharing and both arrival modes at **390×844** and
**1440×960**. The fixture blocks external APIs and supplies its own audio; these
tests must not run against a deployed site.

## Native keyboard checks

The separate native-input runner complements the in-page suite with real browser
Tab, Shift+Tab, Enter, Space and Escape input at both viewports. Sharing APIs
remain fixture-controlled. Verify these focus scopes:

- **Desktop (`min-width:900px`)**: the open player's artwork
  (`#fullPlayerOverlay`), Lyrics/Related/Queue companion (`#upNextSheet`) and
  transport (`#miniPlayer`) are nonmodal. Tab and Shift+Tab are not trapped.
  The full player owns the companion and transport through `aria-owns`; the
  companion is a region with no `aria-modal`. Incoming playlist previews can
  focus their heading without closing or interrupting the desktop player.
- **Mobile (below 900px)**: the full player and its Related/lyrics sheet are
  stacked dialogs. Tab and Shift+Tab stay in the top sheet. Escape closes only
  that sheet and restores its opener; a subsequent Escape closes the player and
  restores the mini-player opener.
- **Nested playlist actions**: artwork Track options → Add to Playlist picker →
  New playlist editor carries the original artwork opener through replacement
  dialogs. Escape from the editor returns to that player control; closing the
  player returns to its opener while audio continues.
- **Inline sharing**: Enter on Share creates the snapshot link in
  `#playlistSharePanel`. Closing that panel restores `[data-share-current]`
  without interrupting audio.

Playlist cards and rows expose independent native buttons with Enter/Space
activation. Native checks exercise these flows:

| Control | Expected behavior |
| --- | --- |
| Card title `[data-open-playlist]` | Enter opens the selected playlist. |
| Card edit `[data-edit-playlist]` | Space opens its editor independently of card navigation; Escape restores that edit button. |
| Track play `[data-play-index]` | Enter plays the selected row, including rows after the first. |
| Track removal `[data-remove-key]` | Space removes playlist membership while preserving active audio; focus moves to a surviving remove button. |

When removal leaves no rows, focus falls back to the playlist's Edit button
(`[data-edit-current]`). Playback-specific source and race coverage is described
in [Playback regressions](../playback/README.md).

## Format and product behavior

- `/#playlist=<base64url UTF-8 JSON>` is a version-1 snapshot, not a synced list.
- Maximum 100 tracks (including omission counts) and 16 KiB decoded JSON. Large
  playlists fail visibly rather than being truncated.
- The strict allowlist includes the playlist title/description, track
  title/artist/stable key, and omission counts. It excludes media/artwork URLs,
  local file identifiers, playlist IDs, account details, and incoming URL query
  parameters. The fragment is not sent in HTTP requests or referrers.
- Receivers preview first. Save creates a private browser-local copy and retains
  missing keys/labels for later library resolution. It never imports media,
  performs discovery, submits downloads, or starts playback.
- Source local files are omitted and counted; an unresolvable legacy entry is
  omitted rather than guessing whether it is a local file. Missing entries from
  previously imported snapshots can be re-shared using their safe metadata.
