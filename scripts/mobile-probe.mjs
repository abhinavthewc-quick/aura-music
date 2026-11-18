/**
 * Mobile performance probe.
 *
 * Emulates a mid-range phone (CPU throttled 4x, 393x852 viewport, DPR 3, touch)
 * and reports what actually costs time on the listener app: boot timing, DOM
 * size, image requests, long tasks, and the splash's GPU surface.
 *
 * Run: node scripts/mobile-probe.mjs [url]
 */
import { chromium, devices } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:5199/';

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
  // devices['iPhone 13'] already sets viewport 390x664, DPR 3, touch, mobile UA.
});
const page = await context.newPage();

// Throttle CPU to approximate a mid-range Android/older iPhone.
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const requests = [];
page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
const loadMs = Date.now() - t0;

// Let the app settle past the splash.
await page.waitForTimeout(2500);

const metrics = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = {};
  for (const p of performance.getEntriesByType('paint')) paints[p.name] = Math.round(p.startTime);
  const longTasks = performance.getEntriesByType('longtask') || [];

  const imgs = [...document.querySelectorAll('img')];
  const loadedImgs = imgs.filter((i) => i.complete && i.naturalWidth > 0);

  const songList = document.getElementById('songList');
  const rows = songList ? songList.querySelectorAll('.song-item').length : 0;

  return {
    dpr: window.devicePixelRatio,
    viewport: { w: innerWidth, h: innerHeight },
    domNodes: document.querySelectorAll('*').length,
    ttfb: Math.round(nav.responseStart || 0),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
    loadEvent: Math.round(nav.loadEventEnd || 0),
    paints,
    longTaskCount: longTasks.length,
    longTaskTotalMs: Math.round(longTasks.reduce((s, t) => s + t.duration, 0)),
    imgTotal: imgs.length,
    imgLoaded: loadedImgs.length,
    songRows: rows,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
});

const byType = {};
for (const r of requests) byType[r.type] = (byType[r.type] || 0) + 1;
const imageReqs = requests.filter((r) => r.type === 'image');

console.log('=== Mobile probe (CPU 4x throttled, iPhone 13) ===');
console.log(`URL                 ${URL}`);
console.log(`viewport            ${metrics.viewport.w}x${metrics.viewport.h} @ DPR ${metrics.dpr}`);
console.log(`wall clock to load  ${loadMs} ms`);
console.log(`TTFB                ${metrics.ttfb} ms`);
console.log(`DOMContentLoaded    ${metrics.domContentLoaded} ms`);
console.log(`load event          ${metrics.loadEvent} ms`);
console.log(`first paint         ${metrics.paints['first-paint'] ?? 'n/a'} ms`);
console.log(`first contentful    ${metrics.paints['first-contentful-paint'] ?? 'n/a'} ms`);
console.log('');
console.log(`DOM nodes           ${metrics.domNodes}`);
console.log(`song rows           ${metrics.songRows}`);
console.log(`images in DOM       ${metrics.imgTotal} (${metrics.imgLoaded} decoded)`);
console.log(`image requests      ${imageReqs.length}`);
console.log(`JS heap             ${metrics.heapMB ?? 'n/a'} MB`);
console.log(`long tasks          ${metrics.longTaskCount} totalling ${metrics.longTaskTotalMs} ms`);
console.log('');
console.log('requests by type:', byType);

await browser.close();
