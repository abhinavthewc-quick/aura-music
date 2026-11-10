#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const origin = 'https://aura-music-01g.pages.dev';
const manifestPath = '/.well-known/ard.json';
const guidePath = '/docs/public-resources.json';
const legacyPath = '/.well-known/ai-catalog.json';
const staticFiles = new Map([
  ['/llms.txt', ['text/plain', 'text/markdown']],
  [manifestPath, ['application/json']],
  [guidePath, ['application/json']],
  ['/sitemap.xml', ['application/xml', 'text/xml']],
  ['/robots.txt', ['text/plain']],
]);
const resourceContracts = [
  ['home', '/', 'text/html', 'browser-sign-in'],
  ['rooms', '/rooms', 'text/html', 'public'],
  ['artists', '/api/artists', 'application/json', 'public'],
  ['sitemap', '/sitemap.xml', 'application/xml', 'public'],
  ['crawler-policy', '/robots.txt', 'text/plain', 'public'],
];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function verifyDocuments(files) {
  const llms = files['/llms.txt'];
  assert(!/^\s*</.test(llms), 'llms.txt must contain Markdown, not an HTML fallback');
  assert(/^#\s+.+/m.test(llms) && llms.length >= 50, 'llms.txt needs an H1 and a useful overview');
  const links = new Set([...llms.matchAll(/\[[^\]\r\n]+\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]));
  for (const path of [...resourceContracts.map(([, path]) => path), manifestPath, guidePath]) {
    assert(links.has(origin + path), `llms.txt must link to ${path}`);
  }

  const guide = JSON.parse(files[guidePath]);
  assert(isText(guide.title) && isText(guide.description), 'Public resource guide needs a title and description');
  assert.equal(guide.site, origin, 'Public resource guide must use the canonical origin');
  assert.equal(guide.discovery?.overview, origin + '/llms.txt');
  assert.equal(guide.discovery?.manifest, origin + manifestPath);
  assert(Array.isArray(guide.resources), 'Public resource guide needs a resources array');
  assert.equal(guide.resources.length, resourceContracts.length, 'Update the resource contracts when adding a real resource');
  for (const [id, path, mediaType, access] of resourceContracts) {
    const matches = guide.resources.filter((resource) => resource.id === id);
    assert.equal(matches.length, 1, `Expected one ${id} resource`);
    const resource = matches[0];
    assert.equal(resource.url, origin + path, `${id}: incorrect URL`);
    assert.equal(resource.mediaType, mediaType, `${id}: incorrect media type`);
    assert.equal(resource.access, access, `${id}: incorrect access conditions`);
    assert(isText(resource.title) && isText(resource.description), `${id}: missing description`);
  }
  const artists = guide.resources.find((resource) => resource.id === 'artists');
  assert.equal(artists.method, 'GET', 'The artist directory is read-only');
  assert.equal(artists.cacheControl, 'no-store');
  for (const field of ['artists', 'trackArtists', 'revision']) {
    assert(isText(artists.responseFields?.[field]), `Describe the artist directory's ${field} field`);
  }
  assert(/disallows crawling \/api\//.test(artists.crawlerPolicy), 'Document the existing API crawler policy');
  assert(/^Disallow:\s*\/api\/\s*$/m.test(files['/robots.txt']), 'Reconcile discovery descriptions with robots.txt');
  for (const path of ['/', '/rooms']) {
    assert(files['/sitemap.xml'].includes(`<loc>${origin}${path}</loc>`), `Sitemap must list ${path}`);
  }

  // These are Aura's resource contracts. --lighthouse adds the full pinned schema/conformance checks.
  const manifest = JSON.parse(files[manifestPath]);
  assert(Array.isArray(manifest.entries) && manifest.entries.length === 2, 'ARD must index the guide and artist directory');
  assert.equal(new Set(manifest.entries.map((entry) => entry.identifier)).size, 2, 'ARD identifiers must be unique');
  assert.deepEqual(new Set(manifest.entries.map((entry) => entry.url)), new Set([origin + guidePath, origin + '/api/artists']));
  for (const entry of manifest.entries) {
    assert.match(entry.identifier, /^urn:air:aura-music-01g\.pages\.dev:public:[a-z0-9._-]+$/);
    assert(isText(entry.displayName) && isText(entry.description), 'ARD entries need names and descriptions');
    assert.equal(entry.type, 'application/json', 'ARD type must describe the actual JSON artifact');
    assert(!Object.hasOwn(entry, 'data'), 'Referenced ARD entries must not also contain inline data');
    assert(Array.isArray(entry.representativeQueries), 'ARD entries need representative queries');
    assert(entry.representativeQueries.length >= 2 && entry.representativeQueries.length <= 5);
    assert(entry.representativeQueries.every(isText), 'Representative queries must be nonempty strings');
  }
  const redirectRules = files['/_redirects'].split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)).filter(([source]) => source === legacyPath);
  assert.deepEqual(redirectRules, [[legacyPath, manifestPath, '301']], 'Legacy discovery URL needs one exact canonical redirect');

  return {
    status: 'passed',
    ardEntries: manifest.entries.length,
    guideResources: guide.resources.length,
    sha256: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')])),
  };
}

async function verifyWithLighthouse(directory, files) {
  const packageInfo = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  assert.equal(packageInfo.name, 'lighthouse', '--lighthouse must point to the installed Lighthouse package directory');
  assert.equal(packageInfo.version, '13.6.0', 'Use Lighthouse 13.6.0 for the pinned ARD v0.91 verification');
  const [{ ConformanceTester, ARD_VERSION }, { default: LlmsTxt }, { default: ArdSchema }] = await Promise.all([
    import(pathToFileURL(resolve(directory, 'third-party/ard/ard.js')).href),
    import(pathToFileURL(resolve(directory, 'core/audits/agentic/llms-txt.js')).href),
    import(pathToFileURL(resolve(directory, 'core/audits/agentic/ard-schema.js')).href),
  ]);
  assert.equal(ARD_VERSION, '0.91 (f073b1e)');
  const tester = new ConformanceTester();
  tester.validate_manifest(files[manifestPath], origin + manifestPath);
  assert.deepEqual(tester.errors, [], 'ARD conformance errors');
  assert.deepEqual(tester.warnings, [], 'ARD conformance warnings');
  // Successful-fetch artifacts exercise document validation only; HTTP has its own explicit mode below.
  const llms = LlmsTxt.audit({ LlmsTxt: { status: 200, content: files['/llms.txt'] } });
  const ard = ArdSchema.audit({
    AgentResourceDiscovery: {
      status: 200, content: files[manifestPath], catalogUrl: origin + manifestPath,
      discoverySource: 'wellKnown', discoverySignals: {}, failedSources: [],
    },
  });
  assert.equal(llms.score, 1, 'Lighthouse llms.txt document validation failed');
  assert.equal(ard.score, 1, 'Lighthouse ARD document validation failed');
  assert(!llms.notApplicable && !ard.notApplicable, 'Discovery documents must be validated as applicable');
  return {
    version: packageInfo.version, ardVersion: ARD_VERSION, mode: 'document-only',
    llmsTxtScore: llms.score, ardSchemaScore: ard.score,
    errors: tester.errors, warnings: tester.warnings, infos: tester.infos,
  };
}

async function verifyHttp(baseUrl, files) {
  const base = new URL(baseUrl);
  assert(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
    '--base-url must be an HTTP(S) origin without credentials, a path, query, or fragment');
  async function get(path) {
    const response = await fetch(new URL(path, base), {
      method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return { response, body, contentType };
  }
  const resources = await Promise.all([
    ...[...staticFiles].map(async ([path, allowedTypes]) => {
      const { response, body, contentType } = await get(path);
      assert.equal(response.status, 200, `${path}: expected HTTP 200`);
      assert(allowedTypes.includes(contentType), `${path}: unexpected Content-Type ${contentType}`);
      assert(body === files[path], `${path}: response differs from the selected local artifact (stale release or HTML fallback)`);
      return { path, status: response.status, contentType, matchesLocalArtifact: true };
    }),
    (async () => {
      const { response } = await get(legacyPath);
      assert.equal(response.status, 301, `${legacyPath}: expected the Pages legacy redirect`);
      const location = response.headers.get('location');
      assert(location, `${legacyPath}: missing Location header`);
      assert.equal(new URL(location, base).href, new URL(manifestPath, base).href, 'Legacy redirect must resolve to the same-origin canonical manifest');
      return { path: legacyPath, status: response.status, location };
    })(),
    (async () => {
      const path = '/api/artists';
      const { response, body, contentType } = await get(path);
      assert.equal(response.status, 200, `${path}: expected the public directory`);
      assert.equal(contentType, 'application/json', `${path}: expected JSON`);
      assert(/\bno-store\b/i.test(response.headers.get('cache-control') || ''), `${path}: expected no-store`);
      const directory = JSON.parse(body);
      assert(isRecord(directory.artists) && isRecord(directory.trackArtists), 'Artist directory must contain artists and trackArtists objects');
      assert(Number.isFinite(directory.revision), 'Artist directory revision must be a number');
      assert(Object.values(directory.trackArtists).every((name) => typeof name === 'string'), 'Track-artist corrections must be strings');
      for (const profile of Object.values(directory.artists)) {
        assert(isRecord(profile), 'Public artist profiles must be objects');
        for (const field of ['key', 'name', 'img', 'bio', 'social']) {
          assert(profile[field] === undefined || typeof profile[field] === 'string', `Artist profile ${field} must be a string when present`);
        }
        assert(profile.genres === undefined || (Array.isArray(profile.genres) && profile.genres.every((genre) => typeof genre === 'string')), 'Artist genres must be strings');
        for (const field of ['updated', 'version']) {
          assert(profile[field] === undefined || Number.isFinite(profile[field]), `Artist profile ${field} must be numeric when present`);
        }
      }
      return { path, status: response.status, contentType, responseShape: 'passed', cacheControl: response.headers.get('cache-control') };
    })(),
  ]);
  return { status: 'passed', baseUrl: base.origin, resources };
}

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: 'string', default: 'public' },
    lighthouse: { type: 'string' },
    'base-url': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: node scripts/verify-discovery.mjs [--directory public|dist] [--lighthouse /path/to/node_modules/lighthouse] [--base-url https://example.com]\nSee docs/discovery.md for document-only and HTTP coverage.\n');
    return;
  }
  const directory = resolve(values.directory);
  const files = Object.fromEntries(await Promise.all([...staticFiles.keys(), '/_redirects'].map(async (path) => [
    path, await readFile(resolve(directory, path.slice(1)), 'utf8'),
  ])));
  const report = { verifiedAt: new Date().toISOString(), directory, documents: verifyDocuments(files) };
  if (values.lighthouse) report.lighthouse = await verifyWithLighthouse(resolve(values.lighthouse), files);
  if (values['base-url']) report.http = await verifyHttp(values['base-url'], files);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`Discovery verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
