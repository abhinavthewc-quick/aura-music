# Parallel sound versions — 14 November 2026

The listener now prepares Original, Bass boosted and Bass + reverb concurrently for the selected song. Prepared sounds share one Web Audio clock and switch with a 120 ms complementary crossfade. A requested sound that is still loading leaves the current music playing until it becomes ready.

The dropdowns became three waveform buttons with a moving selection mark. Desktop and full-player controls mirror each other, support radio-group keyboard navigation, and retain the restored black-and-white design.

The native original element remains the transport clock. Switching does not replace its source, pause it, seek it, mutate the track/queue/playlist identity, or add another listening event. Version buffers are temporary and limited to the current song. Skipping, Radio, YouTube and Rooms release them and abort pending preparation requests. Proxy/direct-HF fallback and explicit retries remain available. Pause, seeks, volume, Muffle, engine suspension/resume, and remembered version preference are covered by regression checks.

Full preparation uses additional bandwidth and decoded memory, including a possible overlap between native original streaming and its background fetch. Physical-device background behavior was not verified. The files themselves remain preprocessed; this release does not upload or regenerate audio. See [audio-versions.md](audio-versions.md) for behavior and bucket layout.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`: passed.
- `npm test`: **131 passed** — 75 browser checks and 56 unit checks.
- Browser checks cover concurrent preparation, no network/pause/reload/seek during warm switches, latest selection, delayed loads, skipped-track cancellation, preserved identity/history, keyboard use, and 320/390/900/1440 px controls.
- Distinct 220/440/880 Hz fixture tones and a real Web Audio analyser verify continuous crossfade output, the selected sound, Muffle, seek, volume, and Pause. A suspended engine resumes all three lanes at the current native playhead.
- Chrome DevTools MCP verified the real Hugging Face files locally and on production. Production created three decoded lanes, kept the same source and track/context/history, issued zero extra audio requests during warm switches, and preserved a paused position of 17 seconds.
- Production 390 px controls showed all three sounds with targets over 44 px and no horizontal overflow. Screenshots are in [screenshots](screenshots), prefixed `seamless-versions-20261114-`.

## Deployment

- Site: https://aura-music-01g.pages.dev
- Production deployment: https://e5fef94a.aura-music-01g.pages.dev
- Pages project: `aura-music`, branch `main`.
- Listener assets: `main--ie5BUsH.js`, `main-B24Zo0Yt.css`.
- Pages Functions were included. The Rooms Worker was unchanged.
