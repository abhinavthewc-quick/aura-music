/* Artist labels may be YouTube channel names rather than recording credits.
 * Match channel suffixes and joined-up spellings without changing track data. */
const TOPIC_SUFFIX = /\s*-\s*Topic$/i;
const VEVO_SUFFIX = /\s*(?:[-_.]\s*)?VEVO$/i;

function withoutChannelSuffix(name: string): string {
  const value = String(name || '').trim().replace(TOPIC_SUFFIX, '').trim();
  return value.replace(VEVO_SUFFIX, '').trim() || value;
}

export function artistKey(name: string): string {
  return withoutChannelSuffix(name).replace(/＜[^＞]*＞/g, '').replace(/\.\s*/g, '.')
    .toLowerCase().replace(/\s{2,}/g, ' ').trim();
}

/* Spaces and periods differ between official credits and compact VEVO handles.
 * Keep other punctuation, including collaboration separators, significant. */
export function artistMatchKey(name: string): string {
  return artistKey(name).replace(/[\s.]/g, '');
}

export function preferredArtistName(names: Iterable<readonly [string, number]>): string {
  const channel = (name: string): number => Number(withoutChannelSuffix(name) !== name.trim());
  const best = [...names].sort(([a, countA], [b, countB]) =>
    channel(a) - channel(b) || countB - countA || b.length - a.length || a.localeCompare(b),
  )[0]?.[0] || 'Unknown Artist';
  const cleaned = withoutChannelSuffix(best);
  // Only infer word boundaries for a VEVO handle when no normal credit exists.
  return VEVO_SUFFIX.test(best.trim().replace(TOPIC_SUFFIX, '').trim())
    ? cleaned.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    : cleaned;
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
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function artistMergeKey(existing: readonly string[], name: string): string {
  const key = artistKey(name);
  const match = artistMatchKey(name);
  // Prefer a known exact alias before the existing article/typo heuristics.
  for (const other of existing) {
    if (other === key || match && artistMatchKey(other) === match) return other;
  }
  const bare = key.replace(/^the\s+/, '');
  for (const otherKey of existing) {
    const other = otherKey.replace(/^the\s+/, '');
    if (!other || !bare) continue;
    if (other === bare) return otherKey;
    if (other.length < 6 || bare.length < 6 || other.slice(0, 3) !== bare.slice(0, 3)) continue;
    if (editWithin(other, bare, 3) <= 3) return otherKey;
  }
  return key;
}
