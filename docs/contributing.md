# Contributing

This is a personal project, but it is structured so a change can be made safely.
The short version: **typecheck, lint, build, exercise the affected flow, escape
user data, keep contracts stable, update docs.**

## Set up

```bash
git clone https://github.com/abhinavthewc-quick/aura-music.git
cd aura-music
npm ci
npm run dev
```

For rooms, also:

```bash
cd rooms-worker && npm ci && npx wrangler dev --port 8799
```

See [development](development.md) for the full local topology, debug globals and
test harnesses.

## Definition of done

```bash
npm run typecheck   # zero errors
npm run lint        # zero findings
npm run build       # dist/ produced
```

Then manually verify the flows you touched. At minimum:

| Change area | Must check |
| --- | --- |
| Library / catalogue | cold load (cache cleared), skeleton/empty/error, play, like, cover fallback |
| Player | pause/resume, seek, next/previous, YouTube, radio, autoplay rejection |
| Search | 1-char (no fan-out), 3+ chars (results), pasted link, provider failure/retry |
| Local files | add, reload, play from IndexedDB, delete |
| Settings/auth | sign in/out, username, theme persistence, Escape/focus trap |
| Rooms | create/join in two tabs, transport, queue/chat, leave/grace |
| Admin | gate, one dispatch, run status, library actions |
| Presence | `#auraPresence` data + activity card + deep link |

For rooms also run:

```bash
node rooms-worker/test/e2e.mjs ws://localhost:8799
```

## Code rules

1. **Escape everything dynamic.** `escapeHtml()` before any text/attribute value
   enters an HTML string. Never put a string id inside inline JavaScript; use
   `data-*` + delegated handlers.
2. **Keep inline-handler globals explicit.** If an `onclick` needs a function,
   add it to `src/expose.ts`. Prefer `addEventListener` for new code.
3. **Typed buttons, labelled controls.** Every `<button>` needs `type="button"`
   unless it is a submit button in a real form; every icon-only control needs an
   accessible name; images need `alt` (empty for decorative).
4. **Keyboard parity.** New interactive rows/cards get
   `role="button" tabindex="0"`; dialogs get `role="dialog" aria-modal="true"`
   and a close control; do not hide a focused subtree.
5. **No `console.log`/`debugger`.** `console.warn`/`error` are for genuine
   diagnostics and are allowed.
6. **Performance.** No `findIndex` inside a row render; batch list renders; lazy
   below-the-fold media; debounce network input; clear any timer you create.
7. **Storage stability.** New keys are versioned (`*_v1`) and documented in
   [data-model](data-model.md). Never repurpose an existing key.
8. **CSS.** Respect the import order in `main.css`; add new overrides at the end;
   use the shared tokens (`--radius-*`, `--ease-out`, `--dur`, `--focus-ring`,
   `--skeleton`) instead of new magic values.
9. **No core contract changes** to the bucket layout, manifest shape, presence
   fields, admin API actions or room protocol without a migration and a doc
   update.

## Commit & branch

- Branch from `main`; keep commits focused.
- Subjects are short, sentence-style descriptions of the change (the history
  uses e.g. “Fix the rooms sync bugs and finish the frequency-split playback”).
- Do not commit `dist/`, `.wrangler/`, `node_modules/`, `.freebuff/`, or local
  caches.
- If a change affects behaviour, update the relevant doc in the same commit.
- Do not rewrite published history.

## Docs to update

| If you change… | Update |
| --- | --- |
| a screen/flow | [features](features.md) |
| a config/env key | [configuration](configuration.md) |
| a module/boot/data flow | [architecture](architecture.md) |
| a bucket field/format/storage key | [data-model](data-model.md) |
| rooms behaviour/protocol | [rooms](rooms.md) |
| presence fields/activity | [presence](presence.md), `premid/README.md` |
| an admin action/env/limit | [admin-api](admin-api.md), [deployment](deployment.md) |
| auth/secrets/XSS handling | [security](security.md) |
| a new failure mode | [troubleshooting](troubleshooting.md) |

## Pull request checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm run build` pass.
- [ ] The affected flow was exercised in a browser (desktop + 390 px mobile).
- [ ] Dynamic text is escaped; no new inline string ids.
- [ ] Buttons have `type`, icon controls have labels, images have `alt`.
- [ ] Keyboard: Tab order works, Escape closes the top overlay, focus returns.
- [ ] No new `console.log`/`debugger`; lint is clean.
- [ ] No unnecessary network calls or eager third-party scripts.
- [ ] Public contracts (bucket, manifest, presence, admin API, room protocol)
      unchanged or migrated + documented.
- [ ] Docs updated for user-visible or operational changes.
- [ ] Screenshots refreshed if the UI changed materially.

## Reporting issues

Include:

- The URL/page and whether it is the deployed site or local dev.
- Browser/OS and whether an extension (ad blocker/PreMiD) is active.
- Console errors and the failing request (redact tokens/cookies).
- Presence DOM (`#auraPresence.dataset`) for Discord issues.
- Room diagnostics (`driftMs`, `clockOffsetMs`, `inSync`) for sync issues.

Do not paste `GH_TOKEN`, `HF_TOKEN`, `YOUTUBE_COOKIES`, Google ID tokens or room
admin keys into an issue.

## Design principles

- **Local-first:** personal data belongs in the browser; the bucket is the
  library, not a user database.
- **One source of truth:** catalogue tracks and identity live in `state.ts`;
  room playback lives in the referee; presence is derived, never scraped.
- **Prefer boring:** vanilla TypeScript, explicit DOM, no framework churn.
- **Degrade, don't blank:** every remote dependency needs an empty/error/retry
  path; images need fallbacks; audio failures need a reset state.
- **Accessible by default:** focus rings, labels, keyboard, reduced motion.
- **Fast by default:** no eager third-party SDKs, lazy media, batched renders,
  debounced search.
