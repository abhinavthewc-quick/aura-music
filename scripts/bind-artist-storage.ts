import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ARTIST_DATABASE_ID, cloudflareClient, RestD1 } from './lib/cloudflare.js';
import { readArtistDirectory } from '../functions/lib/artistStore.js';

interface Project {
  deployment_configs: Record<'production' | 'preview', Record<string, any>>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const api = cloudflareClient();
  const path = '/pages/projects/aura-music';
  const before = await api<Project>(path);
  const deployment_configs: Record<string, unknown> = {};
  for (const environment of ['production', 'preview'] as const) {
    const config = before.deployment_configs[environment];
    if (!config) throw new Error('Missing Pages deployment configuration.');
    const current = config.d1_databases?.ARTIST_DB?.id;
    if (current && current !== ARTIST_DATABASE_ID) throw new Error('ARTIST_DB is already bound to another database; refusing to overwrite it.');
    deployment_configs[environment] = { d1_databases: { ...config.d1_databases, ARTIST_DB: { id: ARTIST_DATABASE_ID } } };
  }
  if (!args.includes('--apply')) { console.log('Dry run: bind ARTIST_DB in production and preview; leave existing variables and integrations untouched. Pass --apply to proceed.'); return; }
  await readArtistDirectory({ ARTIST_DB: new RestD1(api) });
  const backupIndex = args.indexOf('--backup-dir');
  const base = backupIndex < 0 ? tmpdir() : args[backupIndex + 1];
  if (!base || base.startsWith('--')) throw new Error('--backup-dir requires a directory path.');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const backup = join(mkdtempSync(join(base, 'aura-artist-binding-')), 'pages-config.json');
  writeFileSync(backup, JSON.stringify(before, null, 2), { mode: 0o600 });
  /* PATCH is field-wise. Omit env_vars entirely: sending redacted secret
     values back would overwrite credentials. Preserve the existing D1 map. */
  await api(path, 'PATCH', { deployment_configs });
  const after = await api<Project>(path);
  for (const environment of ['production', 'preview'] as const) {
    const oldConfig = before.deployment_configs[environment];
    const newConfig = after.deployment_configs[environment];
    if (newConfig.d1_databases?.ARTIST_DB?.id !== ARTIST_DATABASE_ID) throw new Error('Artist binding verification failed. Backup: ' + backup);
    for (const [key, value] of Object.entries(oldConfig)) {
      const expected = key === 'd1_databases' ? { ...value, ARTIST_DB: { id: ARTIST_DATABASE_ID } } : value;
      /* Pages normalizes an empty env_vars map from null to {} when adding a
         binding. Compare its entries, not that empty-map representation. */
      const unchanged = key === 'env_vars'
        ? isDeepStrictEqual(newConfig[key] ?? {}, expected ?? {})
        : isDeepStrictEqual(newConfig[key], expected);
      if (!unchanged) throw new Error('An existing Pages setting changed unexpectedly: ' + environment + '.' + key + '. Backup: ' + backup);
    }
  }
  console.log('ARTIST_DB bound in production and preview. Existing variables and integrations verified unchanged. Private backup: ' + backup);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Artist binding failed.'); process.exitCode = 1; });
