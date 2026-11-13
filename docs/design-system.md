# Aura design system

## Direction

**A private midnight listening room.** Aura is a place to browse a real library, arrange ordered collections, and listen. Album artwork is the memorable visual element; the shell should not compete with it.

- True-black canvas (`#000`), neutral graphite elevations (`#0a0a0a`, `#121212`, `#1a1a1a`).
- White primary actions and active states (`#fff`), with dark control ink (`#0a0a0a`).
- Neutral-white text (`#f5f5f5`), secondary text (`#a3a3a3`) and dim text (`#808080`).
- Saturated color belongs to artwork. Success, warning, and error colors communicate state only.
- Locally bundled DM Sans for the interface; Cormorant Garamond is reserved for the Aura wordmark/record seal. Font Awesome icons are self-hosted SVG masks, not a runtime CDN dependency.
- No cyan/purple glass language, YouTube-red imitation, decorative glow strips, or farm-themed operational cards.

## Ownership

[Tokens](../src/styles/tokens.css) are shared by the main player, [administration](../src/admin/admin.css), and [listening rooms](../src/rooms/rooms.css). Standalone pages import the same token source and keep their own layout rules.

[The main entry](../src/styles/main.css) imports component owners; there is no final “polish,” “quality,” or numbered override layer.

| Owner | Responsibility |
| --- | --- |
| [Baseline](../src/styles/base.css) | Reset, focus, disabled/hidden contracts, feedback states, reduced motion, marquee |
| [Shell](../src/styles/shell.css), [navigation](../src/styles/nav.css), [profile](../src/styles/profile.css) | Page bounds, desktop rail, mobile dock, drawer, profile |
| [Home](../src/styles/home.css), [library](../src/styles/library.css), [search](../src/styles/search.css) | Artwork shelves, shared track rows, collection views, library filters |
| [Transport](../src/styles/player-bar.css), [full player](../src/styles/full-player.css), [lyrics](../src/styles/lyrics.css) | Mini/full controls, responsive companion sheet, Queue, timed lyrics and Related |
| [Overlays](../src/styles/overlays.css), [track actions](../src/styles/track-sheet.css) | Dialog bounds, track sheet, fixed live-region toasts |
| [Playlists](../src/styles/playlists.css), [settings](../src/styles/settings.css), [effects](../src/styles/effects.css), [radio](../src/styles/radio.css), [sign-in](../src/styles/login.css) | Feature interiors and their responsive states |

Change the owner. Do not restore deleted patch files or append another global correction layer.

## Scales and behavior

- Space: 4 / 8 / 12 / 16 / 24 / 32 / 48 px.
- Corners: 8 px controls, 12 px small cards, 16 px artwork/dialogs; circles and pills only when the component calls for them.
- Type: 12–14 px secondary/row copy, 16–22 px sections, 28 px page titles, 28–40 px collection/artist titles. Body copy stays below roughly 72 characters.
- Explicit transport, queue, playlist, and dialog actions use 44 px targets. A seek track can remain visually thin while its input has a 44 px hit region.
- Motion is 140/220 ms interaction feedback. Record rotation reflects actual playback; lyric state transitions reflect timing. No per-card entrance animation or idle surface shimmer.
- Gradients are confined to image legibility, masks, progress fills, and loading indicators. Artist portrait blur follows scroll and respects reduced motion; the shell does not use decorative glass panels.

The mobile dock remains labeled and separate from Search. The mini player sits above it. Desktop transport owns the bottom edge; opening the full player docks Lyrics/Related/Up next in the right column. Each panel owns a real `min-height: 0` scroll region, so long lyrics and queues do not stretch the page. At 900 px and above, the player is nonmodal and its companion is a region without `aria-modal`; Tab is not trapped. Phone player/sheet overlays retain modal focus behavior.

Rich lyrics retain `--word-prog`, `.active`/`.passed`/`.upcoming`/`.done`, transliteration/translation tiers, size modes, and alignment modes. These are functional selectors, not decorative leftovers.

## Theme compatibility

The listener, sign-in, Admin and Rooms use the canonical neutral-black identity. Legacy `auraTheme` values and the OS light preference do not switch palettes; no light-theme control is advertised. Artwork supplies color without changing control contrast.

## Cascade rules

Use class/component specificity and colocated responsive variants. IDs and legacy `.ytm-*` names remain where the existing vanilla DOM needs them; that naming does not prescribe another product’s visual identity.

`!important` is restricted to:

1. The global HTML `[hidden]` contract.
2. User/OS reduced-motion preferences.
3. One admin Google-iframe max-width interoperability exception.

Do not style presentation by substring-matching an inline `style` attribute. Controllers own visibility with `hidden` or normal inline display; CSS owns geometry and appearance.

## Cleanup verification

Reconciliation retains production's component-owned neutral-black styling and functional word-sync, responsive and operational selectors rather than restoring the older warm-palette overrides. The asset refresh includes 7 font subsets and 186 icon variants; surface tests verify visible controls have a real SVG mask.

Browser assertions cover the 320 / 390 / 768 / 1440 px listener and standalone Admin/Rooms surfaces; artist layouts also cover 430 / 1024 px. The four refreshed playlist/player fixture captures were inspected. See [remediation](remediation.md#verification) for exact test counts and limitations. Parsing and fixture screenshots alone do not verify live providers or real-device playback.
