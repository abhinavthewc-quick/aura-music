import { normalizeArtistKey, type ArtistProfile } from '../../lib/artistProfiles';
import { COMPOUND_ARTIST_NAMES, VERIFIED_ARTISTS, type VerifiedArtist } from './artistAliases';

export const compareArtistText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/* Presentation normalization deliberately retains accents, articles, words,
   symbols and script. ZWJ/ZWNJ are meaningful in several writing systems. */
export function artistDisplayName(name: string): string {
  return typeof name === 'string' ? name.normalize('NFKC')
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim() : '';
}

function withoutChannelAnnotation(name: string): string {
  let clean = artistDisplayName(name);
  for (let i = 0; i < 4; i++) {
    const next = clean.replace(/\s*(?:[-\u2010-\u2015]\s*Topic|[[(]\s*Topic\s*[\])])$/i, '').trim()
      .replace(/\s*(?:[-\u2010-\u2015]\s*Official(?: (?:Artist|Music))?(?: Channel)?|[[(]\s*Official(?: (?:Artist|Music))?(?: Channel)?\s*[\])])$/i, '').trim();
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

/* A formatting key, NEVER a persistence key. Initials are only compacted next
   to a full word: A.R. Rahman / A R Rahman / AR Rahman, Sam C.S. / Sam CS.
   Bare MG / M G, H.E.R. / HER, punctuation and qualifiers stay distinct. */
export function artistKey(name: string): string {
  return withoutChannelAnnotation(name).toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/(^|\s)((?:[a-z](?:\.\s*|\s+))+)(?=[\p{L}]{2})/gu,
      (_, before: string, initials: string) => before + initials.replace(/[.\s]/g, '') + ' ')
    .replace(/([\p{L}]{2,})\s+((?:[a-z](?:\.\s*|\s+))+[a-z]?\.?)$/u,
      (_, word: string, initials: string) => word + ' ' + initials.replace(/[.\s]/g, ''));
}

const verifiedNames = new Map<string, VerifiedArtist>();
for (const artist of VERIFIED_ARTISTS) {
  for (const name of [artist.name, ...(artist.aliases || [])]) verifiedNames.set(artistKey(name), artist);
}
const compoundNames = new Set(COMPOUND_ARTIST_NAMES.map(artistKey));

function bareChannelBase(name: string): string {
  const base = name.replace(/\s+Official(?: (?:Artist|Music))?(?: Channel)?$|\s*VEVO$/i, '').trim();
  return base !== name && base.length >= 3 && !/^(?:the|unknown artist|official|music|topic)$/i.test(base) ? base : '';
}

function verifiedArtist(name: string): VerifiedArtist | undefined {
  const direct = verifiedNames.get(artistKey(name));
  if (direct) return direct;
  const base = bareChannelBase(withoutChannelAnnotation(name));
  return base ? verifiedNames.get(artistKey(base)) : undefined;
}

export function artistNamesMatch(a: string, b: string): boolean {
  const first = artistKey(a), second = artistKey(b);
  if (!first || !second) return false;
  if (first === second) return true;
  const known = verifiedArtist(a);
  return !!known && known.id === verifiedArtist(b)?.id;
}

export type ArtistConfidence = 'owned' | 'formatted' | 'verified' | 'literal' | 'ambiguous';
export interface ArtistIdentity {
  key: string;
  name: string;
  aliases: string[];
  profileKeys: string[];
  profile?: ArtistProfile;
  preferredName: boolean;
  confidence: ArtistConfidence;
}
export interface ArtistIdentityOptions {
  profiles?: Record<string, ArtistProfile>;
  /* When supplied, only this D1 snapshot owns identities. HF can contain old
     imported keys too; their presence must not promote fallback data to D1. */
  authoritativeProfiles?: Record<string, ArtistProfile>;
  /* Full catalogue credits, used only as independent evidence for splitting
     collaborations and unadorned "Official" channel suffixes. */
  names?: Iterable<string>;
  /* A D1 track edit is an explicit identity when no cloud alias owns its name.
     Do not reinterpret that correction as a typo or a collaboration. */
  authoritativeNames?: Iterable<string>;
}

interface IdentityRecord {
  key: string;
  name: string;
  aliases: Set<string>;
  profileKeys: Set<string>;
  profile?: ArtistProfile;
}
type Index = Map<string, Set<IdentityRecord>>;
const addIndex = (index: Index, name: string, record: IdentityRecord) => {
  if (!name) return;
  const entries = index.get(name) || new Set<IdentityRecord>();
  entries.add(record);
  index.set(name, entries);
};
interface ProfileIndex { exact: Index; labels: Index; formatted: Index; verified: Index }
const profileIndex = (): ProfileIndex => ({ exact: new Map(), labels: new Map(), formatted: new Map(), verified: new Map() });

function indexAlias(index: ProfileIndex, alias: string, record: IdentityRecord, literal = true) {
  addIndex(literal ? index.exact : index.labels, normalizeArtistKey(alias), record);
  addIndex(index.formatted, artistKey(alias), record);
  const known = verifiedArtist(alias);
  if (known) addIndex(index.verified, known.id, record);
}

/* Version orders copies of ONE owner. Only audited equivalent owners prefer
   admin over manifest; then updated orders their edits, not an old high version.
   Select the whole record, carrying its clears and field override intentions. */
function newerProfile(a: ArtistProfile, b: ArtistProfile, auditedOwners = false): ArtistProfile {
  const time = (p: ArtistProfile) => Number.isFinite(p.updated) ? p.updated! : 0;
  const version = (p: ArtistProfile) => Number.isFinite(p.version) ? p.version! : 0;
  const order = a.key === b.key
    ? version(a) - version(b) || time(a) - time(b)
    : (auditedOwners ? Number(a.source === 'admin') - Number(b.source === 'admin') : 0)
      || time(a) - time(b) || version(a) - version(b);
  if (order) return order > 0 ? a : b;
  const tie = (p: ArtistProfile) => JSON.stringify([
    p.key, p.name, p.img, p.bio, p.genres, p.social, p.source, p.imgOverride, p.bioOverride,
  ]);
  return compareArtistText(tie(a), tie(b)) <= 0 ? a : b;
}

interface CreditPart { name: string; start: number; end: number; separator: 'list' | 'feature' | 'weak' | '' }
function creditParts(name: string): CreditPart[] {
  if (name.length > 2000) return [];
  const parts: CreditPart[] = [];
  const separators = /\s*[,;&]\s*|\s+(?:feat\.?|ft\.?|featuring|with|and|x|×)\s+/gi;
  let start = 0, depth = 0, scanned = 0;
  for (const match of name.matchAll(separators)) {
    const index = match.index!;
    for (; scanned < index; scanned++) {
      if ('([{'.includes(name[scanned])) depth++;
      else if (')]}'.includes(name[scanned])) depth = Math.max(0, depth - 1);
    }
    if (depth) continue;
    const token = match[0].trim();
    parts.push({ name: name.slice(start, index).trim(), start, end: index,
      separator: /^(?:feat\.?|ft\.?|featuring)$/i.test(token) ? 'feature' : /^[,;&]$/.test(token) ? 'list' : 'weak' });
    start = index + match[0].length;
    if (parts.length > 24) return [];
  }
  parts.push({ name: name.slice(start).trim(), start, end: name.length, separator: '' });
  return parts.every((part) => part.name) ? parts : [];
}

/** A deterministic read-side resolver. There is no edit-distance search or
 * transitive fuzzy union. Strong aliases win; multiple owners mean abstain.
 * Construct once for a catalogue snapshot, then resolve its distinct credits. */
export function createArtistIdentityResolver(options: ArtistIdentityOptions = {}) {
  const owned = profileIndex(), fallback = profileIndex();
  const edited: Index = new Map();
  const records = new Map<string, IdentityRecord>();
  const names = [...new Set(options.names || [])].filter((name) => typeof name === 'string');
  const observed = new Set(names.map(artistKey));

  function matches(index: ProfileIndex, name: string): { entries: Set<IdentityRecord>; confidence: ArtistConfidence } | undefined {
    const exact = index.exact.get(normalizeArtistKey(name));
    if (exact?.size) return { entries: exact, confidence: 'owned' };
    const labels = index.labels.get(normalizeArtistKey(name));
    if (labels?.size) return { entries: labels, confidence: 'owned' };
    const formatted = index.formatted.get(artistKey(name));
    if (formatted?.size) return { entries: formatted, confidence: 'formatted' };
    const known = verifiedArtist(name);
    const verified = known && index.verified.get(known.id);
    if (verified?.size) return { entries: verified, confidence: 'verified' };
  }

  const validProfiles = (profiles: Record<string, ArtistProfile>) => Object.entries(profiles).filter((entry): entry is [string, ArtistProfile] =>
    !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]));
  const entries = validProfiles(options.profiles || {});
  const cloudEntries = options.authoritativeProfiles === undefined
    ? entries.filter(([, profile]) => typeof profile.key === 'string' && profile.key)
    : validProfiles(options.authoritativeProfiles);
  const legacyEntries = options.authoritativeProfiles === undefined
    ? entries.filter(([, profile]) => !profile.key)
    : entries.filter(([alias]) => !Object.prototype.hasOwnProperty.call(options.authoritativeProfiles, alias));
  const owners = new Map<string, { profile: ArtistProfile; aliases: Set<string> }>();
  for (const [alias, profile] of cloudEntries) {
    if (typeof profile.key !== 'string' || !profile.key) continue;
    const previous = owners.get(profile.key);
    owners.set(profile.key, { profile: previous ? newerProfile(previous.profile, profile) : profile,
      aliases: new Set([...(previous?.aliases || []), alias]) });
  }
  const literalAliases = new Map<string, Set<string>>();
  for (const [owner, { profile, aliases }] of [...owners].sort(([a], [b]) => compareArtistText(a, b))) {
    const known = verifiedArtist(profile.name || '');
    const audited = known?.equivalentProfileKeys?.includes(owner);
    const key = audited ? 'artist:' + known.id : 'profile:' + owner;
    let record = records.get(key);
    if (!record) {
      record = { key, name: '', aliases: new Set(), profileKeys: new Set() };
      records.set(key, record);
    }
    record.profile = record.profile ? newerProfile(record.profile, profile, !!audited) : profile;
    record.profileKeys.add(owner);
    literalAliases.set(key, new Set([...(literalAliases.get(key) || []), ...aliases]));
    for (const alias of aliases) record.aliases.add(alias);
    if (typeof profile.name === 'string' && profile.name.trim()) record.aliases.add(profile.name);
    record.name = typeof record.profile.name === 'string' && record.profile.name.trim()
      ? record.profile.name : [...record.aliases].sort(compareArtistText)[0];
  }
  for (const record of records.values()) {
    for (const alias of record.aliases) indexAlias(owned, alias, record, literalAliases.get(record.key)?.has(alias));
  }

  for (const name of [...new Set(options.authoritativeNames || [])].sort(compareArtistText)) {
    if (typeof name !== 'string' || !name.trim() || owned.exact.has(normalizeArtistKey(name)) ||
      owned.labels.get(normalizeArtistKey(name))?.size === 1) continue;
    const key = 'edited:' + normalizeArtistKey(name);
    let record = records.get(key);
    if (!record) {
      record = { key, name, aliases: new Set(), profileKeys: new Set() };
      records.set(key, record);
    }
    record.aliases.add(name);
    addIndex(edited, normalizeArtistKey(name), record);
  }

  for (const [alias, profile] of legacyEntries.sort(([a], [b]) => compareArtistText(a, b))) {
    const label = typeof profile.name === 'string' && profile.name.trim() ? profile.name : alias;
    const candidates = new Set([...(matches(owned, alias)?.entries || []), ...(matches(owned, label)?.entries || [])]);
    let record = candidates.size === 1 ? [...candidates][0] : undefined;
    if (!record) {
      const known = verifiedArtist(label);
      const key = known ? 'artist:' + known.id : 'name:' + artistKey(label);
      record = records.get(key);
      if (!record) {
        record = { key, name: known?.name || withoutChannelAnnotation(label), aliases: new Set(), profileKeys: new Set() };
        records.set(key, record);
      }
      // A legacy row can supply a fallback, never fields for a D1 owner.
      if (!record.profileKeys.size) {
        record.profile = record.profile ? newerProfile(record.profile, profile) : profile;
        record.name = known?.name || withoutChannelAnnotation(record.profile.name || label);
      }
    }
    record.aliases.add(alias);
    record.aliases.add(label);
    indexAlias(fallback, alias, record);
    indexAlias(fallback, label, record);
  }

  function channelName(name: string): string {
    const plain = withoutChannelAnnotation(name);
    const base = bareChannelBase(plain);
    if (base && (verifiedArtist(base) || observed.has(artistKey(base)) || matches(owned, base) || matches(fallback, base))) return base;
    return plain;
  }

  const memo = new Map<string, ArtistIdentity | undefined>();
  function resolve(name: string): ArtistIdentity | undefined {
    if (typeof name !== 'string') return undefined;
    if (memo.has(name)) return memo.get(name);
    const clean = channelName(name), key = artistKey(clean);
    if (!key || key === 'unknown artist') { memo.set(name, undefined); return undefined; }
    const exact = owned.exact.get(normalizeArtistKey(name));
    const correction = edited.get(normalizeArtistKey(name));
    const label = owned.labels.get(normalizeArtistKey(name));
    const cleanExact = owned.exact.get(normalizeArtistKey(clean));
    const match = exact?.size ? { entries: exact, confidence: 'owned' as const }
      : correction?.size ? { entries: correction, confidence: 'owned' as const }
      : label?.size ? { entries: label, confidence: 'owned' as const }
      : cleanExact?.size ? { entries: cleanExact, confidence: 'formatted' as const }
      : matches(owned, name) || matches(owned, clean) || matches(fallback, name) || matches(fallback, clean);
    const record = match?.entries.size === 1 ? [...match.entries][0] : undefined;
    const known = match ? undefined : verifiedArtist(clean);
    const ambiguous = !!match && !record;
    const result: ArtistIdentity = {
      key: record?.key || (ambiguous ? 'unresolved:' + normalizeArtistKey(name) : known ? 'artist:' + known.id : 'name:' + key),
      name: record?.name || known?.name || clean,
      aliases: record ? [...record.aliases].sort(compareArtistText) : known ? [known.name, ...(known.aliases || [])] : [],
      profileKeys: record ? [...record.profileKeys].sort(compareArtistText) : [],
      profile: record?.profile,
      preferredName: !!record || !!known,
      confidence: ambiguous ? 'ambiguous' : match?.confidence || (known ? 'verified' : 'literal'),
    };
    memo.set(name, result);
    return result;
  }

  function atomic(name: string): boolean {
    return !!(owned.exact.has(normalizeArtistKey(name)) || owned.labels.has(normalizeArtistKey(name)) || edited.has(normalizeArtistKey(name)) ||
      owned.formatted.has(artistKey(name)) || fallback.exact.has(normalizeArtistKey(name)) || fallback.formatted.has(artistKey(name)) ||
      verifiedArtist(name) || compoundNames.has(artistKey(name)));
  }
  const independent = new Set(names.filter((name) => atomic(name) || creditParts(name).length === 1).map(artistKey));
  function anchor(name: string): boolean {
    const identity = resolve(name);
    return !!identity && identity.confidence !== 'ambiguous' && (identity.preferredName || atomic(name) || independent.has(artistKey(name)));
  }

  function splitCredits(raw: string): string[] {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    if (atomic(raw)) return [raw];
    // Feature brackets describe credits; other parenthetical qualifiers belong
    // to the name. Never strip arbitrary parentheses, angle brackets or slashes.
    const name = channelName(raw).replace(/\s*[[(]\s*((?:feat\.?|ft\.?|featuring)\s+[^()[\]]+)[\])]$/i, ' $1');
    if (atomic(name)) return [name];
    const parts = creditParts(name);
    if (parts.length < 2) return [raw];
    const combined: CreditPart[] = [];
    for (let i = 0; i < parts.length; i++) {
      let end = i;
      for (let j = parts.length - 1; j > i; j--) {
        if (atomic(name.slice(parts[i].start, parts[j].end).trim())) { end = j; break; }
      }
      combined.push({ ...parts[i], name: name.slice(parts[i].start, parts[end].end).trim(),
        end: parts[end].end, separator: parts[end].separator });
      i = end;
    }
    const supported = combined.some((part) => anchor(part.name) || part.separator === 'feature');
    const credits: string[] = [];
    let start = combined[0].start;
    for (let i = 0; i < combined.length; i++) {
      const part = combined[i];
      const split = part.separator === 'feature' || (part.separator === 'list' && supported) ||
        (part.separator === 'weak' && anchor(part.name) && anchor(combined[i + 1]?.name));
      if (split || i === combined.length - 1) {
        credits.push(name.slice(start, part.end).trim());
        start = combined[i + 1]?.start;
      }
    }
    return credits.length > 1 ? credits : [raw];
  }

  return { resolve, splitCredits };
}
