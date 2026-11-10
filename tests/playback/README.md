# Playback regressions

## Source-module checks

```sh
node --import tsx --test tests/playback/*.test.ts
npm run typecheck
npm run lint
```

Each test transpiles the shipped `player.ts`, `lyrics.ts`, `queue.ts`,
`playbackIntent.ts` and `roomFlag.ts` into an isolated VM. Browser surfaces and
unrelated features are mocked; no production function is copied into the tests.
Controlled media promises, iframe events, timers and animation frames cover:

- Active-source lyric rendering, clicking, offsets and synchronization while
  playing, paused, at zero, loading, stopped or unable to seek; visibility
  observers follow the independent lyrics sheet and tab.
- Retained YouTube A → B → C and mixed YouTube/local queue autoplay.
- Duplicate and delayed end events, superseded API/ready/state/error callbacks,
  same-source replay, seeking, repeat-one, autoplay settings, radio and rooms.
- Original artwork control-node/listener identity and pointer gesture guards.
- Passive loads versus genuine playback intent, same-millisecond requests,
  stale audio promises/events/fallbacks, foreground resume and lyric requests.

## Browser companion

Use the existing local fixture server:

```sh
npm run test:artists:browser
```

Open a fresh `http://127.0.0.1:5186/tests/artists/browser.html` page in an isolated
browser profile. Run at **390×844** and **1440×960**:

```js
await (await import('/tests/playback/browser-playback-regressions.js'))
  .runPlaybackRegressions();
```

This companion exercises the shipped DOM, inline lyric/Like handlers, bound
Info/Share controls, actual muted local audio, the real queue and radio module.
It also checks paused zero-time lyrics across sheet/tab visibility changes and
native related-track buttons after library reordering or removal.
A synthetic iframe API makes late-event races deterministic and avoids external
YouTube requests. It does not test YouTube's remote service or autoplay policy.

## APIs

- `beginPlaybackIntent(): number` and `getPlaybackIntent(): number` are
  dependency-free. Capture a token before asynchronous selection work; discard
  its result if the token changes. Passive `loadSong()` stays token-neutral.
- `getActivePlaybackTime(): number` reads the selected source, including paused
  and zero positions. Unavailable or externally owned sources return zero.
- `seekActivePlayback(seconds): boolean` seeks only the selected source and
  preserves pause state; false means no seek occurred. It cancels queued
  YouTube end advancement without starting a new selection.
- `seekToLyric(seconds)` is exported from `lyrics.ts` and remains bound to the
  existing inline `window.seekToLyric` handler.
