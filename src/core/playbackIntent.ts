/* A shared, monotonic selection token. Async work may finish only while the
   token it captured still matches; importing this module has no DOM effects. */
let playbackIntent = 0;

export function beginPlaybackIntent(): number {
  return ++playbackIntent;
}

export function getPlaybackIntent(): number {
  return playbackIntent;
}
