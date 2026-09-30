// Phase B: strip state-member declarations, rewrite state refs, add exports + imports.
import { readFileSync, writeFileSync } from 'node:fs';

const report = JSON.parse(readFileSync('/tmp/split-report.json', 'utf8'));
const decls = report.decls;

const PATHS = {
  config: 'src/core/config.ts', state: 'src/core/state.ts', dom: 'src/core/dom.ts',
  player: 'src/features/player.ts', library: 'src/features/library.ts',
  queue: 'src/features/queue.ts', beeboo: 'src/features/beeboo.ts',
  settings: 'src/features/settings.ts', ambience: 'src/features/ambience.ts',
  home: 'src/features/home.ts', search: 'src/features/search.ts',
  radio: 'src/features/radio.ts', nav: 'src/ui/nav.ts', login: 'src/ui/login.ts',
  app: 'src/app.ts', loader: 'src/ui/loader.ts', mini: 'src/ui/mini-player.ts',
};
const STATE_MEMBERS = ['addedSongs', 'songs', 'auraLikedHistory', 'recentlyPlayed',
  'currentIndex', 'isPlaying', 'isShuffle', 'repeatMode', 'audio',
  'auraYTQueueIndex', 'radioIsPlaying'];
const OWNER = {};
for (const [n, d] of Object.entries(decls)) OWNER[n] = d.module;
for (const n of STATE_MEMBERS) OWNER[n] = 'state';

// sanity: reassignment outside owner must be a state member
const errs = [];
for (const [n, mods] of Object.entries(report.reassign)) {
  const owner = OWNER[n];
  const extra = mods.filter((m) => m !== owner);
  if (extra.length && !STATE_MEMBERS.includes(n)) errs.push(`${n} reassigned outside owner (${owner}): ${extra.join(',')}`);
}
if (errs.length) { console.error('REASSIGN ERRORS:\n' + errs.join('\n')); process.exit(1); }

// code mask: 1 = code (incl. comments), 0 = string/template-text/regex
function codeMask(text) {
  const mask = new Uint8Array(text.length);
  let mode = 'code', depth = 0, prevSig = '';
  const tpl = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (mode === 'code') {
      mask[i] = 1;
      if (c === '/' && n === '/') { mode = 'lc'; i++; mask[i] = 1; continue; }
      if (c === '/' && n === '*') { mode = 'bc'; i++; mask[i] = 1; continue; }
      if (c === "'") { mode = 'sq'; continue; }
      if (c === '"') { mode = 'dq'; continue; }
      if (c === '`') { mode = 'tpl'; continue; }
      if (c === '/' && '=,([{!&|?:;+-*%~^<>'.includes(prevSig)) { mode = 'rx'; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (tpl.length && depth === tpl[tpl.length - 1]) { mode = 'tpl'; tpl.pop(); }
      }
      if (c === '$' && n === '{') { tpl.push(depth); depth++; i++; mask[i] = 1; continue; }
      if (!/\s/.test(c)) prevSig = c;
      continue;
    }
    if (mode === 'lc') { if (c === '\n') mode = 'code'; mask[i] = 1; continue; }
    if (mode === 'bc') { mask[i] = 1; if (c === '*' && n === '/') { i++; mask[i] = 1; mode = 'code'; } continue; }
    if (mode === 'sq') { if (c === '\\') { i++; continue; } if (c === "'") mode = 'code'; continue; }
    if (mode === 'dq') { if (c === '\\') { i++; continue; } if (c === '"') mode = 'code'; continue; }
    if (mode === 'rx') { if (c === '\\') { i++; continue; } if (c === '\n') mode = 'code'; else if (c === '/') mode = 'code'; continue; }
    if (mode === 'tpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { mode = 'code'; continue; }
      if (c === '$' && n === '{') { tpl.push(depth); depth++; i++; mask[i] = 1; mode = 'code'; continue; }
      continue;
    }
  }
  return mask;
}

const NAME_HEAD = '(?:(?<=\\.\\.\\.)|(?<![\\w$.]))'; // plain ident or spread ...ident

function rewriteState(text, mask) {
  let out = '', last = 0;
  const re = new RegExp(NAME_HEAD + '(' + STATE_MEMBERS.map((s) => s.replace(/\$/g, '\\$')).join('|') + ')(?![\\w$])', 'g');
  let m;
  while ((m = re.exec(text))) {
    if (!mask[m.index + m[0].length - m[1].length]) continue;
    const idx = m.index + m[0].length - m[1].length;
    const after = text.slice(idx + m[1].length, idx + m[1].length + 4);
    const before = text.slice(Math.max(0, idx - 24), idx);
    // skip object-literal property keys (foo: ...), but not ternary values (c ? foo : x)
    if (/^\s*:(?!:)/.test(after) && !/\?\s*$/.test(before)) continue;
    const prefix = m[0].slice(0, m[0].length - m[1].length); // '...' if present
    out += text.slice(last, idx) + prefix + 'state.' + m[1];
    last = idx + m[1].length;
  }
  return out + text.slice(last);
}

function importsFor(text, mask, selfOwner, fileLocals = []) {
  const used = new Set();
  const re = new RegExp(NAME_HEAD + '([A-Za-z_$][\\w$]*)', 'g');
  let m;
  while ((m = re.exec(text))) {
    const n = m[1];
    const idx = m.index + m[0].length - n.length;
    if (!mask[idx]) continue;
    if (STATE_MEMBERS.includes(n)) continue;
    if (n === 'state') continue;
    if (fileLocals.includes(n)) continue;
    const owner = OWNER[n];
    if (!owner || owner === selfOwner) continue;
    used.add(n);
  }
  return used;
}

function relPath(fromKey, toMod) {
  const from = PATHS[fromKey].split('/').slice(0, -1);
  const to = PATHS[toMod].split('/').slice(0, -1);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const segs = [...Array(from.length - i).fill('..'), ...to.slice(i)];
  const base = PATHS[toMod].split('/').pop().replace(/\.ts$/, '');
  if (!segs.length) return './' + base;
  const prefix = segs[0] === '..' ? '' : './';
  return prefix + segs.join('/') + '/' + base;
}

function stripLine(file, pattern) {
  const lines = file.split('\n');
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx === -1) { console.error('WARN: strip pattern not found: ' + pattern); return file; }
  lines.splice(idx, 1);
  return lines.join('\n');
}
function applyStrips(key, text) {
  if (key === 'search') text = stripLine(text, /^\s*let auraYTQueueIndex = -1;\s*$/);
  if (key === 'radio') text = stripLine(text, /^\s*let radioIsPlaying = false;\s*$/);
  return text;
}

// export insertion — top-level (indent 4) statements only, first declarator only;
// multi-declarator statements are covered by their first name's export.
function addExports(key, text) {
  const mine = Object.entries(decls).filter(([, d]) => d.module === key);
  if (!mine.length) return text;
  const lines = text.split('\n');
  const done = new Set();
  for (const [name] of mine) {
    if (STATE_MEMBERS.includes(name)) continue;
    const fnKw = new RegExp('^ {4}(export\\s+)?(async\\s+function\\s+' + name + '\\b|function\\s*\\*?\\s*' + name + '\\b)');
    const varKw = new RegExp('^ {4}(export\\s+)?(const|let|var)\\s+' + name + '\\s*[=,;]');
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      if (fnKw.test(lines[i]) || varKw.test(lines[i])) { found = i; break; }
    }
    if (found === -1) { console.error(`WARN: decl line for ${name} not found in ${key}`); continue; }
    if (done.has(found)) continue;
    done.add(found);
    if (!/^ {4}export\b/.test(lines[found])) {
      lines[found] = lines[found].replace(/^( {4})(async\s+function|function|const|let|var)/, '$1export $2');
    }
  }
  return lines.join('\n');
}

for (const [key, path] of Object.entries(PATHS)) {
  if (key === 'state') continue; // hand-written, never touch
  let text = readFileSync(path, 'utf8');
  text = applyStrips(key, text);
  text = addExports(key, text);
  let mask = codeMask(text);
  text = rewriteState(text, mask);
  mask = codeMask(text);
  const locals = key === 'mini' ? report.miniLocals : key === 'loader' ? report.loaderLocals : [];
  const used = importsFor(text, mask, key, locals);
  if (text.includes('state.')) used.add('__state__');
  const groups = {};
  for (const n of used) {
    const owner = n === '__state__' ? 'state' : OWNER[n];
    (groups[owner] ??= []).push(n === '__state__' ? 'state' : n);
  }
  const lines = [];
  for (const [owner, names] of Object.entries(groups).sort()) {
    const uniq = [...new Set(names)].sort();
    lines.push(`import { ${uniq.join(', ')} } from '${relPath(key, owner)}';`);
  }
  if (lines.length) text = lines.join('\n') + '\n' + text;
  writeFileSync(path, text);
  console.error(`${key}: ${lines.length} import-group(s)`);
}
