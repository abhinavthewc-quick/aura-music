import { readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync('index.html', 'utf8').split('\n');
// 1-indexed inclusive cut ranges (validated against grep output)
const cuts = [
  [24, 2019],    // main style blocks -> replaced by main.css link
  [2023, 2139],  // orb loader script -> src/ui/loader.ts
  [2866, 6303],  // main script -> src features
  [6304, 6431],  // blank + mini player script -> src/ui/mini-player.ts
  [6434, 6469],  // blank + tail styles -> vinyl-tail.css (already imported last)
];
// sanity checks before cutting
const expect = (idx, s, label) => {
  const got = lines[idx - 1];
  if (!got.includes(s)) { console.error('BAD ' + label + ' line ' + idx + ': got ' + JSON.stringify(got.slice(0, 80))); process.exit(1); }
  console.log('ok ' + label + ' @' + idx);
};
expect(23, 'jsmediatags.min.js', 'keep-landmark');
expect(24, '<style>', 'cut-style-start');
expect(2019, '</style>', 'cut-style-end');
expect(2020, '</head>', 'keep-head');
expect(2022, 'auraLoader', 'keep-loader-div');
expect(2023, 'aura-orb-js', 'cut-orb-start');
expect(2139, '</script>', 'cut-orb-end');
expect(2866, '<script>', 'cut-main-start');
expect(6303, '</script>', 'cut-main-end');
expect(6305, 'aura-desktop-player-js', 'cut-mini-start');
expect(6431, '</script>', 'cut-mini-end');
expect(6432, '</body>', 'keep-body-close');
expect(6433, '</html>', 'keep-html-close');
expect(6435, 'aura-vinyl-final-fix', 'cut-tail-start');
expect(6469, '</style>', 'cut-tail-end');

const cutSet = new Set();
for (const [a, b] of cuts) for (let i = a; i <= b; i++) cutSet.add(i);

const out = [];
for (let i = 1; i <= lines.length; i++) {
  if (cutSet.has(i)) {
    if (i === 24) out.push('  <link rel="stylesheet" href="/src/styles/main.css">');
    continue;
  }
  if (i === 6432) out.push('  <script type="module" src="/src/main.ts"></script>');
  out.push(lines[i - 1]);
}
writeFileSync('index.html', out.join('\n'));
console.log('stripped:', lines.length, '->', out.length, 'lines');
