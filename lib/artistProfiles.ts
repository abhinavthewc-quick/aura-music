/* Shared, browser-safe artist identity and public data. Music stays in HF;
   these records and track-name overrides are independent of its manifest. */
export interface ArtistProfile {
  key?: string;
  name?: string;
  img?: string;
  bio?: string;
  genres?: string[];
  social?: string;
  updated?: number;
  version?: number;
  source?: 'admin' | 'manifest';
  /* Overrides include explicit empty strings. False allows automatic data. */
  imgOverride?: boolean;
  bioOverride?: boolean;
}

export interface ArtistDirectory {
  artists: Record<string, ArtistProfile>;
  trackArtists: Record<string, string>;
  revision: number;
}

export const normalizeArtistKey = (name: string): string =>
  String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const artistTrackId = (videoId: string, path: string): string =>
  videoId ? 'vid:' + videoId : 'hf:' + path;

export const PORTRAIT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(jpg|png|webp)$/;
export const portraitUrl = (id: string): string => '/api/artist-image?id=' + encodeURIComponent(id);
