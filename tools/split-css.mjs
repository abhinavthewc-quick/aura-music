// Split index.html CSS into src/styles/*.css in original cascade order.
// Loader CSS (lines 5-16) stays inline in index.html for instant paint.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const lines = readFileSync('index.html', 'utf8').split('\n');
const slice = (ranges) => ranges.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');

/** name -> [start,end] ranges (1-indexed, inclusive) of CSS content */
const chunks = [
  ['base', [[25, 74]]],
  ['login', [[75, 372]]],
  ['search', [[373, 395]]],
  ['player-bar', [[396, 446]]],
  ['nav', [[447, 571]]],
  ['full-player', [[572, 633]]],
  ['radio', [[634, 675]]],
  ['add-music', [[676, 735]]],
  ['track-sheet', [[736, 769]]],
  ['beeboo', [[770, 868]]],
  ['library', [[869, 886]]],
  ['settings', [[887, 903]]],
  ['effects', [[904, 937]]],
  ['layout-desktop', [[938, 1173]]],
  ['overrides-1', [[1174, 1259]]],
  ['hero-vinyl', [[1260, 1338]]],
  ['overrides-2', [[1339, 1466]]],
  ['overrides-3', [[1467, 1537]]],
  ['search-premium', [[1538, 1589]]],
  ['overrides-4', [[1590, 1633]]],
  ['hide-nav-names', [[1637, 1637]]],
  ['beeboo-extra', [[1640, 1692], [1696, 1697], [1701, 1738]]],
  ['profile-initial', [[1742, 1744]]],
  ['desktop-player', [[1748, 1899]]],
  ['hero-and-orb', [[1903, 1908]]],
  ['vinyl-final', [[1911, 1974], [1977, 1986], [1989, 1991], [1995, 2018]]],
  ['vinyl-tail', [[6436, 6451], [6454, 6469]]]
];

mkdirSync('src/styles', { recursive: true });

let out = '// Aura Music — stylesheets. @import order mirrors the original cascade order.\n';
chunks.forEach(([name, ranges], i) => {
  const css = slice(ranges).replace(/<\/?style[^>]*>/g, '');
  writeFileSync(`src/styles/${name}.css`, css.replace(/\s+$/, '') + '\n');
  out += `@import './${name}.css';\n`;
});
writeFileSync('src/styles/main.css', out);
console.log('wrote', chunks.length, 'css files + main.css');
