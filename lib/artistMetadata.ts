import type { ArtistProfile } from './artistProfiles.js';

export interface ArtistMetadataCredit {
  title: string;
  url: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
}

export interface AutomaticArtistMetadata {
  name: string;
  entityId: string;
  img?: string;
  bio?: string;
  imageCredit?: ArtistMetadataCredit;
  bioCredit?: ArtistMetadataCredit;
  fetchedAt: number;
  expiresAt: number;
}

export interface ArtistMetadataResponse {
  key: string;
  status: 'ready' | 'not-found' | 'ambiguous' | 'retry';
  metadata?: AutomaticArtistMetadata;
  /* Seconds until another lookup may be attempted. */
  retryAfter?: number;
}

export type DisplayArtistProfile = ArtistProfile & {
  imageCredit?: ArtistMetadataCredit;
  bioCredit?: ArtistMetadataCredit;
};

const nonempty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/* Display-only overlay: the caller owns identity and cache freshness. Provider
   names/IDs never become profile names/keys, even when no stored profile exists.
   Old managed snapshots lack field intent; conservatively retain their whole
   profile (including blanks) until a fresh directory supplies boolean flags. */
export function composeArtistMetadata(
  profile: ArtistProfile | null | undefined,
  automatic: AutomaticArtistMetadata | null | undefined,
): DisplayArtistProfile | null {
  if (!profile && !nonempty(automatic?.img) && !nonempty(automatic?.bio)) return null;
  const display: DisplayArtistProfile = { ...profile };
  const managed = typeof profile?.version === 'number' && Number.isInteger(profile.version) && profile.version > 0;
  const overridden = (flag: boolean | undefined) => flag === true || (flag !== false && managed);
  /* A previously composed object is still only a fallback here; credits must
     describe automatic fields actually selected by this composition. */
  delete display.imageCredit;
  delete display.bioCredit;
  if (!overridden(profile?.imgOverride) && nonempty(automatic?.img)) {
    display.img = automatic.img;
    if (automatic.imageCredit) display.imageCredit = automatic.imageCredit;
  }
  if (!overridden(profile?.bioOverride) && nonempty(automatic?.bio)) {
    display.bio = automatic.bio;
    if (automatic.bioCredit) display.bioCredit = automatic.bioCredit;
  }
  return display;
}
