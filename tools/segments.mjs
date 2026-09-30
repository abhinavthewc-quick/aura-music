// Print top-level statement segments of the main inline script for review.
import { readFileSync } from 'node:fs';
const L = readFileSync('index.html', 'utf8').split('\n');
const S = 2867, E = 6302;
const isStart = (i) => {
  const t = L[i - 1];
  if (t === undefined) return false;
  const m = t.match(/^ {4}(\S)/);
  if (!m) return false;
  const c = m[1];
  return c !== '}' && c !== ']' && c !== ')';
};
const segs = [];
let cur = null;
for (let i = S; i <= E; i++) {
  if (isStart(i)) {
    if (cur) segs.push(cur);
    cur = { s: i };
  }
}
if (cur) segs.push(cur);
console.error('segments:', segs.length);
for (const g of segs) console.log(g.s + ': ' + L[g.s - 1].trim().slice(0, 110));
