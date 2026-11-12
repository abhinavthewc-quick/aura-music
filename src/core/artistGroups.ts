import { normalizeArtistKey, type ArtistProfile } from '../../lib/artistProfiles';
import { composeArtistMetadata, type AutomaticArtistMetadata, type DisplayArtistProfile } from '../../lib/artistMetadata';
import {
  artistDisplayName, artistKey, artistNamesMatch, artistSourceCredit, compareArtistText,
  createArtistIdentityResolver, type ArtistIdentityOptions,
} from './artistIdentity';
export { artistKey, artistNamesMatch } from './artistIdentity';

/* Compatibility for callers of the old display helper. Group construction no
   longer does greedy, order-dependent pairwise merges. */
export function artistMergeKey(existing: string[], name: string): string {
  const matches = [...new Set(existing.filter((other) => artistNamesMatch(other, name)))];
  return matches.length === 1 ? matches[0] : artistKey(name);
}

export interface ArtistGroup {
  key: string;
  name: string;
  aliases: string[];
  profileKeys?: string[];
  songs: any[];
  cover: string;
  profile?: DisplayArtistProfile;
}

export interface ArtistSelection {
  key: string;
  name: string;
  aliases: string[];
  profileKeys?: string[];
}

export function selectArtist(group: ArtistGroup): ArtistSelection {
  return { key: group.key, name: group.name, aliases: [...group.aliases], profileKeys: [...(group.profileKeys || [])] };
}

/* Keep raw-name navigation in the same ownership context as grouping. A D1
   owner with no loaded tracks still blocks an alias from opening somebody
   else's page. Weak keys allow old catalogue snapshots to be collected. */
const groupResolvers = new WeakMap<ArtistGroup[], ReturnType<typeof createArtistIdentityResolver>>();

export function resolveArtistSelection(groups: ArtistGroup[], selection: ArtistSelection | string): ArtistGroup | undefined {
  const key = typeof selection === 'string' ? selection : selection.key;
  const direct = groups.find((group) => group.key === key);
  if (direct) return direct;
  const owners = typeof selection === 'string' ? [] : [...(selection.profileKeys || [])];
  if (key.startsWith('profile:')) owners.push(key.slice('profile:'.length));
  const owned = groups.filter((group) => (group.profileKeys || []).some((owner) => owners.includes(owner)));
  if (owners.length) return owned.length === 1 ? owned[0] : undefined;
  const names = typeof selection === 'string' ? [selection] : [selection.name, ...selection.aliases];
  const resolver = groupResolvers.get(groups);
  if (resolver) {
    const identities = new Set(names.map((name) => resolver.resolve(name)?.key).filter(Boolean));
    const matches = groups.filter((group) => identities.has(group.key));
    return matches.length === 1 ? matches[0] : undefined;
  }
  // A literal cloud alias beats typography when two intentionally distinct
  // owners have similarly formatted names. Never choose the first fuzzy hit.
  const normalized = new Set(names.map(normalizeArtistKey));
  const exact = groups.filter((group) => [group.name, ...group.aliases].some((name) => normalized.has(normalizeArtistKey(name))));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const variants = groups.filter((group) => [group.name, ...group.aliases].some((alias) => names.some((name) => artistNamesMatch(alias, name))));
  return variants.length === 1 ? variants[0] : undefined;
}

function preferredLabel(tally: Map<string, number>): string {
  // Stable tie breaking: avoid an all-lowercase or SHOUTING uploader spelling
  // when an equally common mixed-case label exists. No locale-dependent keys.
  const mixedCase = (name: string) => Number(name !== name.toLowerCase() && name !== name.toUpperCase());
  return [...tally].sort(([a, ac], [b, bc]) => bc - ac || mixedCase(b) - mixedCase(a) || compareArtistText(a, b))[0]?.[0] || '';
}

export function buildArtistGroups(
  songs: any[], profiles: Record<string, ArtistProfile>,
  options: Pick<ArtistIdentityOptions, 'authoritativeNames' | 'authoritativeProfiles'> & {
    automaticMetadata?: (canonicalName: string) => AutomaticArtistMetadata | undefined;
  } = {},
): ArtistGroup[] {
  const { automaticMetadata, ...identityOptions } = options;
  const resolver = createArtistIdentityResolver({ ...identityOptions, profiles,
    names: songs.map((song) => song?.artist), creditSources: songs.map(artistSourceCredit) });
  const groups = new Map<string, ArtistGroup & {
    tally: Map<string, number>; seen: Set<unknown>; preferredName: boolean;
  }>();
  for (const song of songs) {
    if (!song || typeof song.artist !== 'string') continue;
    const credited = new Set<string>();
    for (const credit of resolver.splitCredits(song.artist)) {
      const identity = resolver.resolve(credit);
      if (!identity || credited.has(identity.key)) continue;
      credited.add(identity.key);
      let group = groups.get(identity.key);
      if (!group) {
        group = { key: identity.key, name: identity.name, aliases: [...identity.aliases], profileKeys: identity.profileKeys,
          songs: [], cover: '', profile: identity.profile, tally: new Map(), seen: new Set(),
          preferredName: identity.preferredName };
        groups.set(identity.key, group);
      }
      for (const alias of [credit, identity.name]) if (!group.aliases.includes(alias)) group.aliases.push(alias);
      // One track may credit multiple artists (or the same artist twice), but
      // keeps its original object, ID, attribution, playback index and keys.
      const id = song.id == null ? song : String(song.id);
      if (group.seen.has(id)) continue;
      group.seen.add(id);
      group.songs.push(song);
      const label = artistDisplayName(identity.name);
      group.tally.set(label, (group.tally.get(label) || 0) + 1);
    }
  }
  const result = [...groups.values()].map(({ tally, seen, preferredName, ...group }) => {
    const name = preferredName ? group.name : preferredLabel(tally);
    // Resolve ownership FIRST. Provider names/IDs never enter the resolver or
    // rename the credit; an unresolved ownership conflict stays neutral.
    const profile = composeArtistMetadata(group.profile,
      group.key.startsWith('unresolved:') ? undefined : automaticMetadata?.(name)) || undefined;
    return { ...group, aliases: group.aliases.sort(compareArtistText), name, profile,
      // Album artwork is not an artist portrait. Track/album covers stay on
      // their original songs; artist views render a neutral fallback instead.
      cover: profile?.img || '' };
  }).sort((a, b) => b.songs.length - a.songs.length || compareArtistText(a.name.toLowerCase(), b.name.toLowerCase()) || compareArtistText(a.key, b.key));
  groupResolvers.set(result, resolver);
  return result;
}
