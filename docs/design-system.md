# Aura design system

## Direction

**A private midnight listening room.** Aura is a place to browse a real library, arrange ordered collections, and listen. Album artwork is the memorable visual element; the shell should not compete with it.

- True-black canvas (`#000`), two useful graphite elevations (`#0a0a0b`, `#121214`).
- Warm tonearm brass (`#d8aa70`) for primary actions and active states, not entire panels.
- Warm-white text (`#f7f5f1`), neutral secondary text (`#9d9a95`).
- Saturated color belongs to artwork. Success, warning, and error colors communicate state only.
- DM Sans for the interface; Cormorant Garamond is reserved for the Aura wordmark/record seal.
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
- Gradients are confined to image legibility, the record illustration, progress fills, and loading indicators. No backdrop filters remain in the main UI.

The mobile dock remains labeled and separate from Search. The mini player sits above it. Desktop transport owns the bottom edge; opening the full player docks Lyrics/Related/Up next in the right column. Each panel owns a real `min-height: 0` scroll region, so long lyrics and queues do not stretch the page.

Rich lyrics retain `--word-prog`, `.active`/`.passed`/`.upcoming`/`.done`, transliteration/translation tiers, size modes, and alignment modes. These are functional selectors, not decorative leftovers.

## Light theme

The main application’s light theme uses the same hierarchy and components with ivory/neutral surfaces and darker brass. Theme aliases are rebound within `body.light-theme`, since CSS custom-property aliases compute before inheritance. Sign-in uses the same palette while the record illustration remains black vinyl.

Admin and Rooms currently expose no light-theme control; their default is the canonical black identity. Do not advertise light mode for those separate pages without wiring and testing that preference.

## Cascade rules

Use class/component specificity and colocated responsive variants. IDs and legacy `.ytm-*` names remain where the existing vanilla DOM needs them; that naming does not prescribe another product’s visual identity.

`!important` is restricted to:

1. The global HTML `[hidden]` contract.
2. User/OS reduced-motion preferences.
3. One admin Google-iframe max-width interoperability exception.

Do not style presentation by substring-matching an inline `style` attribute. Controllers own visibility with `hidden` or normal inline display; CSS owns geometry and appearance.

## Cleanup verification

Compared with the concatenated WIP, the main CSS changed from **1,133 to 9 important declarations**, **7,786 to 4,730 declarations**, **226 to 18 gradients**, and **281,256 to 136,586 source bytes**. Required live class families were checked against markup and dynamic renderers. Retired acquisition/hero aliases and redundant inherited styles were removed; conditional/word-sync states remain.

The admin migration used a CSS AST, exact-selector/context declaration deduplication, and a reviewed removal list for decorative strips/hover lifts. Operational selectors and responsive rules were retained. All CSS parses, all local imports resolve, and all referenced tokens are defined or are documented player-written properties.

Browser regression tests and screenshot review are still required for releases, especially the 390 px dock, missing-track controls, all three companion panels, light-theme dialogs, and the standalone Admin/Rooms pages. Parsing alone is not visual verification.
