import { normalizeArtistKey, type ArtistProfile } from '../../lib/artistProfiles';
import { buildArtistGroups } from '../core/artistGroups';
import { createArtistIdentityResolver } from '../core/artistIdentity';

interface ArtistTrack { id: string; artist: string; album?: string }
export interface AdminArtistGroup<T extends ArtistTrack> {
  key: string;
  name: string;
  normKey: string;
  tracks: T[];
  albums: string[];
  profile?: ArtistProfile;
  metadataName: string;
  renameTrackCount: number;
}

/* Admin and listener pages share the same read-side memberships. Saving a
   profile still targets its real D1 owner, never an inferred display key. */
export function buildAdminArtistGroups<T extends ArtistTrack>(
  tracks: T[], profiles: Record<string, ArtistProfile>, authoritativeNames: Iterable<string> = [],
): AdminArtistGroup<T>[] {
  const options = { authoritativeProfiles: profiles, authoritativeNames: [...authoritativeNames] };
  const resolver = createArtistIdentityResolver({ profiles, ...options });
  const groups = buildArtistGroups(tracks, profiles, options);
  const includedOwners = new Set(groups.flatMap((group) => group.profileKeys || []));
  const result: AdminArtistGroup<T>[] = groups.map((group) => ({
    key: group.key, name: group.name, normKey: group.profile?.key || normalizeArtistKey(group.name),
    tracks: group.songs, albums: [...new Set(group.songs.map((track: T) => track.album).filter(Boolean))],
    profile: group.profile, metadataName: group.key.startsWith('unresolved:') ? '' : group.name,
    renameTrackCount: 0,
  }));

  // Unlike listener shelves, admin must retain unattributed files for editing.
  const unknown = tracks.filter((track) => !resolver.resolve(track.artist));
  if (unknown.length) result.push({ key: 'name:unknown artist', name: 'Unknown Artist', normKey: 'unknown artist',
    tracks: [...new Map(unknown.map((track) => [track.id, track])).values()],
    albums: [...new Set(unknown.map((track) => track.album).filter(Boolean))], metadataName: '', renameTrackCount: 0 });

  // Retain saved zero-track owners. Audited equivalent profiles appear once;
  // arbitrary owners and ambiguous labels remain distinct and editable by key.
  for (const [alias, meta] of Object.entries(profiles)) {
    if (!meta || includedOwners.has(meta.key)) continue;
    const identity = resolver.resolve(alias);
    const sameOwner = identity?.confidence !== 'ambiguous' && identity?.profileKeys.includes(meta.key);
    const profile = sameOwner ? identity.profile! : meta;
    for (const key of sameOwner ? identity.profileKeys : [meta.key]) includedOwners.add(key);
    result.push({ key: sameOwner ? identity.key : 'profile:' + meta.key,
      name: profile.name || alias, normKey: profile.key || normalizeArtistKey(alias),
      tracks: [], albums: [], profile, metadataName: sameOwner ? identity.name : '', renameTrackCount: 0 });
  }

  for (const group of result) {
    /* Mirror artistSet's whole-credit matching, not the display aliases. A
       collaborator's profile save must never erase another person's credit. */
    const aliases = new Set([group.normKey, normalizeArtistKey(group.name)]);
    if (group.profile?.key) for (const [alias, profile] of Object.entries(profiles)) {
      if (profile?.key === group.profile.key) aliases.add(normalizeArtistKey(alias));
    }
    group.renameTrackCount = group.tracks.filter((track) => aliases.has(normalizeArtistKey(track.artist))).length;
  }
  return result;
}
