/* A Cloudflare artist correction changes display metadata, not a track's
   catalog identity. Keep the legacy lk: format so existing local playlists,
   play counts and room queues need no storage migration. */
function titleArtistKey(title: unknown, artist: unknown): string {
  return 'lk:' + String(title || '').toLowerCase().trim() + '|' + String(artist || '').toLowerCase().trim();
}

export function trackKey(song: any): string {
  if (song?.videoId) return 'vid:' + song.videoId;
  return titleArtistKey(song?.title, song?.catalogArtist ?? song?.artist);
}

export function trackMatchesKey(song: any, key: string): boolean {
  return trackKey(song) === key || (!song?.videoId && titleArtistKey(song?.title, song?.artist) === key);
}
