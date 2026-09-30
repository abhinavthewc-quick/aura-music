// Phase A: slice the inline scripts into module files + build declaration/reassign report.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const L = readFileSync('index.html', 'utf8').split('\n');
const line = (i) => L[i - 1];

// ---------- pieces ----------
const LOADER = [2024, 2138];
const MAIN = [2867, 6302];
const MINI = [6306, 6430];

// ---------- contiguous range table for main script ----------
const ENDS = [
  [2919, 'config'], [2941, 'state'], [2954, 'dom'], [2994, 'player'],
  [3005, 'dom'], [3012, 'library'], [3015, 'state'], [3037, 'library'],
  [3056, 'dom'], [3057, 'player'], [3072, 'dom'], [3074, 'nav'],
  [3096, 'home'], [3104, 'search'], [3161, 'home'], [3473, 'library'],
  [3570, 'queue'], [4215, 'beeboo'], [4287, 'settings'], [4645, 'ambience'],
  [4660, 'home'], [4668, 'search'], [4686, 'app'], [4694, 'beeboo'],
  [4705, 'settings'], [4725, 'login'], [4747, 'ambience'], [4812, 'settings'],
  [4871, 'login'], [4924, 'nav'], [4991, 'library'], [5362, 'search'],
  [5555, 'player'], [5622, 'search'], [5819, 'radio'], [5852, 'player'],
  [5887, 'radio'], [5985, 'player'], [6184, 'queue'], [6273, 'player'],
  [6287, 'app'], [6302, 'home'],
];

const PATHS = {
  config: 'src/core/config.ts', state: 'src/core/state.ts', dom: 'src/core/dom.ts',
  player: 'src/features/player.ts', library: 'src/features/library.ts',
  queue: 'src/features/queue.ts', beeboo: 'src/features/beeboo.ts',
  settings: 'src/features/settings.ts', ambience: 'src/features/ambience.ts',
  home: 'src/features/home.ts', search: 'src/features/search.ts',
  radio: 'src/features/radio.ts', nav: 'src/ui/nav.ts', login: 'src/ui/login.ts',
  app: 'src/app.ts', loader: 'src/ui/loader.ts', mini: 'src/ui/mini-player.ts',
};

// ---------- segment starts (same rule as segments.mjs) ----------
const isStart = (i) => {
  const t = line(i);
  if (t === undefined) return false;
  const m = t.match(/^ {4}(\S)/);
  if (!m) return false;
  const c = m[1];
  return c !== '}' && c !== ']' && c !== ')';
};
const segStarts = new Set();
for (let i = MAIN[0]; i <= MAIN[1]; i++) if (isStart(i)) segStarts.add(i);

// ---------- build ranges, validate starts ----------
const ranges = [];
let start = MAIN[0];
for (const [end, mod] of ENDS) {
  ranges.push({ start, end, mod });
  start = end + 1;
}
if (start - 1 !== MAIN[1]) throw new Error('range table does not cover main script exactly');
const problems = [];
for (const r of ranges) {
  const t = line(r.start) ?? '';
  const blank = t.trim() === '';
  if (!segStarts.has(r.start) && !blank) problems.push(`${r.mod} range starts mid-statement at ${r.start}: ${t.trim().slice(0, 80)}`);
}
if (problems.length) { console.error('RANGE PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.error(`ranges ok: ${ranges.length}`);

// ---------- statement scanner (depth + strings + comments + basic regex) ----------
function scanStatement(lines, s, e) {
  // returns {text, endLine} — statement starting at line s (1-based), within [s,e]
  let depth = 0, i = s, text = [];
  let mode = 'code'; // code | sq | dq | tpl | lc | bc | rx
  let tplDepth = [];
  let prevSig = ''; // previous significant code char
  const push = (ch) => { text.push(ch); };
  while (i <= e) {
    const t = lines[i - 1] ?? '';
    let j = 0;
    if (i > s) push('\n');
    if (mode === 'lc') mode = 'code'; // line comments end at newline (lines have no \n)
    while (j < t.length) {
      const c = t[j], n = t[j + 1];
      if (mode === 'code') {
        if (c === '/' && n === '/') { mode = 'lc'; push(c); push(n); j += 2; continue; }
        if (c === '/' && n === '*') { mode = 'bc'; push(c); push(n); j += 2; continue; }
        if (c === "'") { mode = 'sq'; push(c); j++; continue; }
        if (c === '"') { mode = 'dq'; push(c); j++; continue; }
        if (c === '`') { mode = 'tpl'; push(c); j++; continue; }
        if (c === '/' && '=,([{!&|?:;+-*%~^<>'.includes(prevSig)) {
          // regex literal
          mode = 'rx'; push(c); j++; continue;
        }
        if (c === '{' || c === '(' || c === '[') depth++;
        if (c === '}' || c === ')' || c === ']') {
          depth--;
          if (c === '}' && tplDepth.length && depth === tplDepth[tplDepth.length - 1]) {
            mode = 'tpl'; tplDepth.pop(); push(c); j++; continue;
          }
        }
        if (!/\s/.test(c)) prevSig = c;
        push(c); j++;
        // statement end?
        if (depth === 0 && c === ';' && mode === 'code') return { text: text.join(''), endLine: i };
        continue;
      }
      if (mode === 'sq') { push(c); if (c === '\\') { push(n ?? ''); j += 2; continue; } if (c === "'") mode = 'code'; j++; continue; }
      if (mode === 'dq') { push(c); if (c === '\\') { push(n ?? ''); j += 2; continue; } if (c === '"') mode = 'code'; j++; continue; }
      if (mode === 'tpl') {
        if (c === '\\') { push(c); push(n ?? ''); j += 2; continue; }
        if (c === '`') { mode = 'code'; push(c); j++; continue; }
        if (c === '$' && n === '{') { mode = 'code'; tplDepth.push(depth); depth++; push(c); push(n); j += 2; continue; }
        push(c); j++; continue;
      }
      if (mode === 'lc') { push(c); if (c === '\n') mode = 'code'; j++; continue; }
      if (mode === 'bc') { push(c); if (c === '*' && n === '/') { push(n); mode = 'code'; j += 2; continue; } j++; continue; }
      if (mode === 'rx') {
        push(c);
        if (c === '\\') { push(n ?? ''); j += 2; continue; }
        if (c === '[') { // char class
          j++;
          while (j < t.length) { push(t[j]); if (t[j] === '\\') { push(t[j + 1] ?? ''); j += 2; continue; } if (t[j] === ']') { j++; break; } j++; }
          continue;
        }
        if (c === '/') { mode = 'code'; j++; continue; }
        j++; continue;
      }
    }
    i++;
    // ASI / statement-end check at depth 0 (and not inside template ${})
    if (mode === 'code' && depth === 0 && tplDepth.length === 0) {
      // lookahead: next non-empty line
      let k = i;
      while (k <= e && (line(k) ?? '').trim() === '') k++;
      const nt = line(k) ?? '';
      if (/^ {4}(async\s+)?(function|const|let|var|class|if|for|while|switch|try|do|else|return|throw|delete|break|continue)\b/.test(nt)) {
        return { text: text.join(''), endLine: i - 1 };
      }
      const last = (text.join('').split('\n').pop() ?? '').trim();
      if (last === '') return { text: text.join(''), endLine: i - 1 };
      if (last === '}') return { text: text.join(''), endLine: i - 1 };
      const continues = /[,([{:?!&|+\-*/%<>=.]$/.test(last);
      const chainNext = /^[.?[]/.test(nt.trim()) || /^[-+*/%&|^~<>]/.test(nt.trim());
      if (!continues && !chainNext) return { text: text.join(''), endLine: i - 1 };
    }
  }
  return { text: text.join(''), endLine: e };
}

// ---------- declarations ----------
const nameRe = /^[A-Za-z_$][\w$]*/;
function declNames(stmtRaw) {
  // strip leading comments
  let stmt = stmtRaw;
  for (;;) {
    const s = stmt.replace(/^\s+/, '');
    if (s.startsWith('//')) { stmt = s.replace(/^\/\/[^\n]*\n?/, ''); continue; }
    if (s.startsWith('/*')) {
      const close = s.indexOf('*/');
      if (close === -1) return null;
      stmt = s.slice(close + 2); continue;
    }
    stmt = s; break;
  }
  const m = stmt.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
  if (m) return { kind: 'function', names: [m[1]] };
  const d = stmt.match(/^(const|let|var)\s+/);
  if (!d) return null;
  const kind = d[1];
  let pos = d[0].length;
  const names = [];
  let depth = 0, mode = 'code', prevSig = '';
  while (pos < stmt.length) {
    const c = stmt[pos];
    if (mode === 'code') {
      if (c === "'") { mode = 'sq'; pos++; continue; }
      if (c === '"') { mode = 'dq'; pos++; continue; }
      if (c === '`') { mode = 'tpl'; pos++; continue; }
      if (c === '/' && '=,([{!&|?:;+-*%~^<>'.includes(prevSig)) { mode = 'rx'; pos++; continue; }
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      if (depth === 0 && c === ',') { pos++; const mm = stmt.slice(pos).match(/^\s*([A-Za-z_$][\w$]*)/); if (mm) { names.push(mm[1]); pos += mm[0].length; prevSig = ','; continue; } break; }
      if (depth === 0 && c === ';') break;
      if (depth === 0 && c === '=' && stmt[pos + 1] !== '=' && stmt[pos + 1] !== '>') { pos++; prevSig = '='; continue; } // skip initializer start
      if (depth !== 0) { /* inside initializer */ }
      if (!/\s/.test(c)) prevSig = c;
      pos++; continue;
    }
    if (mode === 'sq') { if (c === '\\') { pos += 2; continue; } if (c === "'") mode = 'code'; pos++; continue; }
    if (mode === 'dq') { if (c === '\\') { pos += 2; continue; } if (c === '"') mode = 'code'; pos++; continue; }
    if (mode === 'tpl') { if (c === '\\') { pos += 2; continue; } if (c === '`') mode = 'code'; pos++; continue; }
    if (mode === 'rx') { if (c === '\\') { pos += 2; continue; } if (c === '/') mode = 'code'; pos++; continue; }
  }
  // first name: after keyword
  const first = stmt.slice(d[0].length).match(/^\s*([A-Za-z_$][\w$]*)/);
  if (!first) return null;
  return { kind, names: [first[1], ...names] };
}

function topDecls(contentLines, s, e) {
  const out = [];
  for (let i = s; i <= e; i++) {
    if (!segStarts.has(i)) continue;
    const { text, endLine } = scanStatement(L, i, e);
    const d = declNames(text);
    if (d) for (const n of d.names) out.push({ name: n, kind: d.kind, line: i, endLine });
    i = endLine;
  }
  return out;
}

// ---------- declarations per module ----------
const decls = {}; // name -> {module, kind, line}
const dupes = [];
for (const r of ranges) {
  const list = topDecls(L, r.start, r.end);
  for (const d of list) {
    if (decls[d.name]) dupes.push(`${d.name}: ${decls[d.name].module}:${decls[d.name].line} AND ${r.mod}:${d.line}`);
    else decls[d.name] = { module: r.mod, kind: d.kind, line: d.line, endLine: d.endLine };
  }
}
// loader + mini locals (only to exclude from their own import lists)
function blockDecls(lines, s, e) {
  const out = new Set();
  for (let i = s; i <= e; i++) {
    const t = line(i) ?? '';
    const m = t.match(/^\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/) ||
              t.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (m) out.add(m[1]);
    // multi-name: capture subsequent names on same line
    const m2 = t.match(/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=[^,]*(?:,\s*([A-Za-z_$][\w$]*))+/g);
    if (m2) for (const mm of m2[0].matchAll(/,\s*([A-Za-z_$][\w$]*)/g)) out.add(mm[1]);
  }
  return out;
}
const loaderLocals = blockDecls(L, LOADER[0], LOADER[1]);
const miniLocals = blockDecls(L, MINI[0], MINI[1]);

// ---------- reassignment scan ----------
const modOf = (i) => {
  if (i >= LOADER[0] && i <= LOADER[1]) return 'loader';
  if (i >= MINI[0] && i <= MINI[1]) return 'mini';
  for (const r of ranges) if (i >= r.start && i <= r.end) return r.mod;
  return '?';
};
const reassign = {};
const baseNames = Object.keys(decls);
const zones = [[LOADER[0], LOADER[1]], [MAIN[0], MAIN[1]], [MINI[0], MINI[1]]];
for (const n of baseNames) {
  const re = new RegExp('(?<![.\\w$\'"`])' + n + '\\s*(?:=(?![=>])|\\+\\+|--|\\+=|-=|\\*=|\\/=)', 'g');
  const mods = new Set();
  for (const [s, e] of zones) {
    for (let i = s; i <= e; i++) {
      const t = line(i) ?? '';
      re.lastIndex = 0;
      if (re.test(t)) mods.add(modOf(i));
    }
  }
  if (mods.size) reassign[n] = [...mods];
}

// ---------- write raw module files ----------
const byMod = {};
for (const r of ranges) (byMod[r.mod] ??= []).push(r);
for (const [mod, rs] of Object.entries(byMod)) {
  const parts = [];
  for (const r of rs) {
    parts.push(`/* ===== ${r.start}-${r.end} ===== */`);
    parts.push(...L.slice(r.start - 1, r.end));
  }
  const p = mod === 'state' ? '/tmp/state-raw.ts' : PATHS[mod]; // state.ts is hand-written
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, parts.join('\n') + '\n');
}
writeFileSync(PATHS.loader, L.slice(LOADER[0] - 1, LOADER[1]).join('\n') + '\n');
writeFileSync(PATHS.mini, L.slice(MINI[0] - 1, MINI[1]).join('\n') + '\n');

// ---------- report ----------
const report = { decls, reassign, dupes, loaderLocals: [...loaderLocals], miniLocals: [...miniLocals] };
writeFileSync('/tmp/split-report.json', JSON.stringify(report, null, 1));
console.error(`decls: ${baseNames.length}, dupe names: ${dupes.length}`);
if (dupes.length) console.error(dupes.join('\n'));
console.error('multi-module reassign: ' + Object.entries(reassign).filter(([, v]) => v.length > 1).map(([k, v]) => k + '[' + v.join(',') + ']').join(' '));
