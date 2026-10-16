/* Rename the product from AURA to Peak, in user-visible text only.
 *
 * A blind find/replace cannot work here: the three brand words are substrings
 * of live identifiers (auraSettings, AuraSession, hero-vinyl-aura,
 * aura-music-01g.pages.dev) and of two third-party names that must not move —
 * the Azure speech voices Aura_1_En_Output / Aura_2_Es_Input, and the Audius
 * app_name. Renaming any of those either breaks storage keys or addresses
 * someone else's service.
 *
 * So this masks every token that merely *contains* the brand, swaps the bare
 * words, then unmasks. Longest tokens are masked first so that a short token
 * can never eat part of a longer one.
 *
 * Run with --dry to see what would change without writing.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.wrangler', '.staging', '.vite']);
const KEEP_EXT = new Set(['.html', '.ts', '.css', '.js', '.mjs', '.json', '.jsonc', '.md']);

/* Tokens that contain the brand but are not branding. Masked before the swap.
   Built by inspection of every distinct aura-containing token in the tree. */
const PROTECT = [
  // const names / internal code identifiers
  'AURA_YOUTUBE_API_KEY', 'AURA_JAMENDO_CLIENT_ID', 'AURA_LIKED_KEY',
  'AURA_SETTINGS_KEY', 'AURA_EFFECT_KEY',
  'applyAuraSettings', 'saveAuraSettings', 'defaultAuraSettings',
  'AuraSession', 'heroVinylAura', 'loAuraPulse', 'playYouTubeInsideAura',
  'renderAuraPicks', 'stopAuraYouTube', 'auraArchiveResolveCache',
  'auraCaptureBackgroundState', 'auraDot', 'auraFirstLogin', 'auraGsiScript',
  'auraJamendoClientId', 'auraLastLogin', 'auraLikedHistory', 'auraLoader',
  'auraLoaderCanvas', 'auraLoaderFailsafe', 'auraLoaderText', 'auraLoaderTextIn',
  'auraMasterCtx', 'auraMini', 'auraMuffleAudioFilter', 'auraMuffleRadioFilter',
  'auraMusicDB', 'auraPickIds', 'auraPicksScroll', 'auraResumeAfterForeground',
  'auraSettings', 'auraSidebarCollapsed', 'auraSpatialLFO', 'auraUserName',
  'auraVolume', 'auraYoutubeApiKey', 'auraYoutubeKeyInvalid', 'auraYTDesiredPlaying',
  'auraYTFrameHost', 'auraYTPendingPlay', 'auraYTPlayer', 'auraYTPlayerReady',
  'auraYTPoster', 'auraYTQueue', 'auraYTQueueIndex', 'auraYTReady',
  'auraYTReadyPromise', 'auraYTTitle', 'auraYTVideoId', '__auraYoutubeSearchTimer',
  '__aura', 'auraJsonp_', 'auraYtCache_v1',
  // localStorage keys — renaming these logs people out and drops their likes
  'auraAdmin_pat', 'auraAdmin_queue_v1', 'auraAdmin_repo', 'auraAmbientEffect_v1',
  'auraBeebooBubbleSeen_v1', 'auraBeebooVoiceLanguage_v1', 'auraHfCatalog_v1',
  'auraLikedSongs_v2', 'auraLocalAccounts_v1', 'auraProfiles_v1',
  'auraRadioPlaybackState_v1', 'auraRecentRooms_v1', 'auraRoomName_v1',
  'auraSearchHistory_v1', 'auraSession_v2', 'auraSettings_v1',
  // internal cache names, request params, user agents
  'aura-bucket.internal', 'aura-search.internal', 'aura-fallback', 'aura-admin',
  'AURA_MUSIC',
  // the repo, the deployed Pages project, the rooms worker
  'aura-music-01g.pages.dev', 'aura-music', 'aura-rooms-worker', 'aura-rooms',
  // CSS classes and ids
  'aura-orb-mini', 'aura-pick-info', 'aura-pick-play', 'aura-pick', 'aura-picks-head',
  'aura-picks-kicker', 'aura-picks-refresh', 'aura-picks-scroll', 'aura-picks',
  'aura-reduce-motion', 'aura-state-btn', 'aura-state-denied', 'aura-state-error',
  'aura-state-icon', 'aura-state-loading', 'aura-state-offline', 'aura-state-orb',
  'aura-state-slow', 'aura-state-success', 'aura-state', 'aura-loader-css',
  'aura-loading', 'aura-room-', 'hero-vinyl-aura', 'lg-aura',
  // the Marathi language name, which is not a brand and must not move
  'aurashtra',
].sort((a, b) => b.length - a.length);

const RULES = [
  [/\bAURA\b/g, 'PEAK'],
  [/\bAura\b/g, 'Peak'],
  [/\baura\b/g, 'peak'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (KEEP_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

const changed = [];
for (const file of walk(ROOT)) {
  if (file.endsWith('rename-brand.mjs')) continue; // this script's own rules
  const before = readFileSync(file, 'utf8');
  if (!/aura/i.test(before)) continue;

  // Mask protected tokens with sentinels that contain no letters, so the word
  // rules below cannot see them.
  const store = [];
  let text = before;
  for (const token of PROTECT) {
    if (!text.includes(token)) continue;
    const sentinel = `\u0000${store.length}\u0000`;
    store.push(token);
    text = text.split(token).join(sentinel);
  }

  for (const [re, to] of RULES) text = text.replace(re, to);

  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)]);

  if (text === before) continue;
  const rel = relative(ROOT, file);
  changed.push(rel);
  if (!DRY) writeFileSync(file, text);
}

console.log(`${DRY ? 'would change' : 'changed'} ${changed.length} files:`);
for (const f of changed) console.log('  ' + f);
