import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { importLegacyArtistProfile, readArtistDirectory } from '../functions/lib/artistStore.js';
import type { ArtistProfile } from '../lib/artistProfiles.js';
import { RestD1 } from './lib/cloudflare.js';
import { SqliteD1 } from './lib/sqliteD1.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fileIndex = args.indexOf('--manifest');
  const file = fileIndex < 0 ? undefined : args[fileIndex + 1];
  if (fileIndex >= 0 && (!file || file.startsWith('--'))) throw new Error('--manifest requires a local file path.');
  let text: string;
  if (file) text = readFileSync(file, 'utf8');
  else {
    const response = await fetch('https://huggingface.co/buckets/Angelrider/sonora/resolve/manifest.json?artist-cutover=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Could not fetch the current legacy manifest (HTTP ' + response.status + ').');
    text = await response.text();
  }
  const manifest = JSON.parse(text) as { artists?: Record<string, ArtistProfile> };
  if (!manifest.artists || typeof manifest.artists !== 'object' || Array.isArray(manifest.artists)) throw new Error('Manifest has no artist profile map.');
  /* Validate every profile locally before any production writes. */
  const local = new SqliteD1();
  try {
    for (const [alias, profile] of Object.entries(manifest.artists)) {
      if (!profile || typeof profile !== 'object') throw new Error('Invalid legacy artist profile.');
      await importLegacyArtistProfile({ ARTIST_DB: local }, alias, profile);
    }
  } finally { local.close(); }
  const digest = createHash('sha256').update(text).digest('hex');
  console.log(`Validated ${Object.keys(manifest.artists).length} legacy profiles; manifest SHA-256 ${digest}.`);
  if (!apply) { console.log('Dry run only. Pass --apply to import into aura-artists.'); return; }
  const db = new RestD1();
  await readArtistDirectory({ ARTIST_DB: db }); // Check both migrations before cutover.
  let imported = 0;
  for (const [alias, profile] of Object.entries(manifest.artists)) {
    if ((await importLegacyArtistProfile({ ARTIST_DB: db }, alias, profile)).imported) imported++;
  }
  const directory = await readArtistDirectory({ ARTIST_DB: db });
  console.log(`Imported ${imported}; preserved ${Object.keys(manifest.artists).length - imported} unchanged or admin-owned profiles. Directory revision ${directory.revision}.`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Artist import failed.'); process.exitCode = 1; });
