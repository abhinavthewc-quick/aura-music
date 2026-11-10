import { normalizeArtistKey, type ArtistProfile } from '../../lib/artistProfiles';

/* Display grouping is intentionally more forgiving than D1 ownership. A typo
   may join one managed artist, but must never merge two managed profiles. */
export function artistKey(name: string): string {
  return normalizeArtistKey(String(name || '').replace(/\s*-\s*Topic$/i, '')
    .replace(/＜[^＞]*＞/g, '').replace(/\.\s*/g, '.'));
}

function editWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function artistNamesMatch(a: string, b: string): boolean {
  const first = artistKey(a).replace(/^the\s+/, '');
  const second = artistKey(b).replace(/^the\s+/, '');
  if (!first || !second) return false;
  if (first === second) return true;
  return first.length >= 6 && second.length >= 6 && first.slice(0, 3) === second.slice(0, 3) && editWithin(first, second, 3) <= 3;
}

export function artistMergeKey(existing: string[], name: string): string {
  const key = artistKey(name);
  return existing.find((other) => artistNamesMatch(other, key)) || key;
}

export interface ArtistGroup {
  key: string;
  name: string;
  aliases: string[];
  songs: any[];
  cover: string;
  profile?: ArtistProfile;
}

export interface ArtistSelection {
  key: string;
  name: string;
  aliases: string[];
}

export function selectArtist(group: ArtistGroup): ArtistSelection {
  return { key: group.key, name: group.name, aliases: [...group.aliases] };
}

export function resolveArtistSelection(groups: ArtistGroup[], selection: ArtistSelection | string): ArtistGroup | undefined {
  const key = typeof selection === 'string' ? selection : selection.key;
  const direct = groups.find((group) => group.key === key);
  if (direct) return direct;
  const names = typeof selection === 'string' ? [selection] : [selection.name, ...selection.aliases];
  const normalized = new Set(names.map(artistKey));
  const exact = groups.filter((group) => [group.name, ...group.aliases].some((name) => normalized.has(artistKey(name))));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const variants = groups.filter((group) => group.aliases.some((alias) => names.some((name) => artistNamesMatch(alias, name))));
  return variants.length === 1 ? variants[0] : undefined;
}

export function buildArtistGroups(songs: any[], profiles: Record<string, ArtistProfile>): ArtistGroup[] {
  const managed = new Map<string, { key: string; profile: ArtistProfile; aliases: Set<string>; identities: Set<string> }>();
  for (const [alias, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== 'object') continue;
    const key = profile.key ? 'profile:' + profile.key : artistKey(profile.name || alias);
    let entry = managed.get(key);
    if (!entry) { entry = { key, profile, aliases: new Set(), identities: new Set() }; managed.set(key, entry); }
    entry.aliases.add(artistKey(alias));
    entry.identities.add(normalizeArtistKey(alias));
    if (profile.name) {
      entry.aliases.add(artistKey(profile.name));
      entry.identities.add(normalizeArtistKey(profile.name));
    }
  }
  const profileNames = [...managed.values()];
  const groups = new Map<string, ArtistGroup & { tally: Map<string, number> }>();
  for (const song of songs) {
    const name = String(song.artist || '').trim();
    const displayName = name.replace(/\s*-\s*Topic$/i, '').trim();
    const normalized = artistKey(name);
    if (!normalized || normalized === 'unknown artist') continue;
    /* Prefer explicit aliases. Infer spelling only when exactly one profile
       matches, independent of song order or whether its tracks loaded first. */
    const owned = profileNames.filter((entry) => entry.identities.has(normalizeArtistKey(name)));
    const exact = owned.length ? owned : profileNames.filter((entry) => entry.identities.has(normalizeArtistKey(displayName)));
    const matches = exact.length ? exact : profileNames.filter((entry) => [...entry.aliases].some((alias) => artistNamesMatch(alias, name)));
    const managedArtist = matches.length === 1 ? matches[0] : undefined;
    const unmanagedKeys = [...groups.values()].filter((group) => !group.profile).map((group) => group.key);
    const key = managedArtist?.key || artistMergeKey(unmanagedKeys, name);
    let group = groups.get(key);
    if (!group) {
      group = { key, name: '', aliases: managedArtist ? [...managedArtist.aliases] : [], songs: [], cover: '', profile: managedArtist?.profile, tally: new Map() };
      groups.set(key, group);
    }
    group.songs.push(song);
    if (!group.aliases.includes(normalized)) group.aliases.push(normalized);
    group.tally.set(displayName, (group.tally.get(displayName) || 0) + 1);
    if (!group.cover && song.img) group.cover = song.img;
  }
  return [...groups.values()].map(({ tally, ...group }) => ({
    ...group,
    name: group.profile?.name || [...tally].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0][0],
    cover: group.profile?.img || group.cover,
  })).sort((a, b) => b.songs.length - a.songs.length || a.name.localeCompare(b.name));
}
