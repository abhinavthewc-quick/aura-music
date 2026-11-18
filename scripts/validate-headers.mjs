#!/usr/bin/env node
/**
 * Validate public/_headers against Cloudflare Pages' documented matching rules.
 *
 * This exists because the file is easy to get subtly wrong and the failure is
 * silent: a header set by two matching rules is JOINED with a comma rather than
 * overridden, so a blanket rule can quietly defeat every narrower one. That is
 * not something a build error will catch.
 *
 * Rules modelled (https://developers.cloudflare.com/pages/configuration/headers/):
 *   - Blocks are `pattern` then indented `Name: value` lines.
 *   - `! Name` detaches a header added by an EARLIER rule.
 *   - Rules apply in file order; matching rules accumulate.
 *   - Repeated headers are joined with ", ".
 *   - A splat `*` is greedy and matches `/` too.
 *   - Up to 100 rules; 2000 chars per line.
 *
 * Usage:
 *   node scripts/validate-headers.mjs            # check the file + expectations
 *   node scripts/validate-headers.mjs --dump     # also print resolved headers
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS = join(ROOT, 'public/_headers');
const DIST = join(ROOT, 'dist');

const MAX_RULES = 100;
const MAX_LINE = 2000;

/** Parse _headers into ordered rules: { pattern, ops: [{detach, name, value}] } */
function parse(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      current = { pattern: line.trim(), ops: [], line: rules.length + 1 };
      rules.push(current);
      continue;
    }
    if (!current) throw new Error(`header line before any pattern: ${line}`);
    const detach = /^\s*!\s*([A-Za-z0-9-]+)\s*$/.exec(line);
    if (detach) { current.ops.push({ detach: true, name: detach[1] }); continue; }
    const pair = /^\s*([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`unparseable header line: ${line}`);
    current.ops.push({ detach: false, name: pair[1], value: pair[2] });
  }
  return rules;
}

/** Cloudflare splat matching: `*` is greedy and matches `/` as well. */
function matches(pattern, path) {
  if (!pattern.includes('*')) return pattern === path;
  const [head, ...rest] = pattern.split('*');
  const tail = rest.join('*');
  if (!path.startsWith(head)) return false;
  if (!tail) return true;
  return path.length >= head.length + tail.length && path.endsWith(tail);
}

/** Resolve the headers a request path would receive. */
function resolve(rules, path) {
  const out = new Map();
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    for (const op of rule.ops) {
      if (op.detach) { out.delete(op.name.toLowerCase()); continue; }
      const key = op.name.toLowerCase();
      const prev = out.get(key);
      out.set(key, prev === undefined ? op.value : `${prev}, ${op.value}`);
    }
  }
  return out;
}

/** Parse a Cache-Control value into directives. */
function directives(value) {
  const out = {};
  for (const part of String(value || '').split(',')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k.toLowerCase()] = v === undefined ? true : v;
  }
  return out;
}

const text = readFileSync(HEADERS, 'utf8');
const rules = parse(text);
const failures = [];
const fail = (msg) => failures.push(msg);

// ---- structural limits -----------------------------------------------------
if (rules.length > MAX_RULES) fail(`${rules.length} rules exceeds Cloudflare's limit of ${MAX_RULES}`);
for (const line of text.split('\n')) {
  if (line.length > MAX_LINE) fail(`line exceeds ${MAX_LINE} chars: ${line.slice(0, 60)}...`);
}

// ---- expectations ----------------------------------------------------------
// Each case: a path that exists in the build, and what its Cache-Control must
// resolve to. These encode the intent of the file, so a future edit that
// reorders rules and silently downgrades an asset fails here.
const CASES = [
  // HTML revalidates so a deploy lands immediately.
  { path: '/', expect: { revalidate: true }, why: 'HTML entry' },
  { path: '/index.html', expect: { revalidate: true }, why: 'HTML entry' },
  { path: '/admin.html', expect: { revalidate: true }, why: 'HTML entry' },
  { path: '/rooms.html', expect: { revalidate: true }, why: 'HTML entry' },

  // Hashed build output: one year, immutable, and NOT poisoned by no-cache.
  { path: '/assets/main-B6rNPeia.js', expect: { maxAge: 31536000, immutable: true }, why: 'hashed JS' },
  { path: '/assets/main-CGOO1qts.css', expect: { maxAge: 31536000, immutable: true }, why: 'hashed CSS' },
  { path: '/assets/dm-sans-latin-CwMReqGs.woff2', expect: { maxAge: 31536000, immutable: true }, why: 'hashed font' },
  { path: '/assets/about-logo-C-N56Vop.jpg', expect: { maxAge: 31536000, immutable: true }, why: 'hashed image (must beat /*.jpg)' },
  { path: '/assets/brand-logo-7QNYNHky.webp', expect: { maxAge: 31536000, immutable: true }, why: 'hashed image (must beat /*.webp)' },
  { path: '/assets/radio-hero-Dj_XRjr1.jpg', expect: { maxAge: 31536000, immutable: true }, why: 'hashed image (must beat /*.jpg)' },

  // Unhashed public files: a week, never a year.
  { path: '/aura-logo.png', expect: { maxAge: 604800 }, why: 'unhashed logo' },
  { path: '/aura-vinyl-logo.svg', expect: { maxAge: 604800 }, why: 'unhashed svg' },

  // Admin pipeline input.
  { path: '/manifest.json', expect: { maxAge: 300 }, why: 'catalogue manifest' },
];

for (const testCase of CASES) {
  const headers = resolve(rules, testCase.path);
  const cc = headers.get('cache-control') || '';
  const d = directives(cc);
  const label = `${testCase.path} (${testCase.why})`;

  if (testCase.expect.revalidate) {
    if (!('no-cache' in d)) fail(`${label}: expected no-cache, got "${cc}"`);
  }
  if (testCase.expect.maxAge !== undefined) {
    if (Number(d['max-age']) !== testCase.expect.maxAge) {
      fail(`${label}: expected max-age=${testCase.expect.maxAge}, got "${cc}"`);
    }
    // A joined value containing no-cache would defeat the TTL entirely.
    if ('no-cache' in d) fail(`${label}: no-cache leaked into "${cc}"`);
    if ('no-store' in d) fail(`${label}: no-store leaked into "${cc}"`);
  }
  if (testCase.expect.immutable && !('immutable' in d)) {
    fail(`${label}: expected immutable, got "${cc}"`);
  }
}

// ---- every real build asset resolves to something cacheable ----------------
let checked = 0;
if (existsSync(DIST)) {
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue; }
      const headers = resolve(rules, rel);
      const cc = headers.get('cache-control') || '';
      if (!cc) fail(`${rel}: no Cache-Control resolved at all`);
      // Hashed assets must never end up revalidating.
      if (rel.startsWith('/assets/') && /no-cache|no-store/.test(cc)) {
        fail(`${rel}: hashed asset resolved to "${cc}"`);
      }
      checked++;
    }
  };
  walk(DIST);
}

if (process.argv.includes('--dump')) {
  for (const c of CASES) {
    console.log(`${c.path}\n  -> ${resolve(rules, c.path).get('cache-control')}`);
  }
  console.log('');
}

console.log(`_headers: ${rules.length} rules, ${checked} build files checked`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('all header expectations hold');
