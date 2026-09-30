// Extract base64 data-URI images from index.html into src/assets/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const file = 'index.html';
let html = readFileSync(file, 'utf8');

const names = [
  { match: /src="data:image\/jpeg;base64,[^"]{0,400}/, name: 'about-logo.jpg' } // first jpeg = about modal logo (short)
];

// More robust: walk all data:image src attributes in document order with known contexts
const specs = [
  { needle: 'about-logo', ext: 'jpg' }
];

// 1) About logo (jpeg inside .about-logo)
html = html.replace(/(<div class="about-logo"><img src=")data:image\/jpeg;base64,([A-Za-z0-9+/=]+)(")/,
  (_, pre, b64, post) => {
    writeFileSync('src/assets/about-logo.jpg', Buffer.from(b64, 'base64'));
    return pre + './src/assets/about-logo.jpg' + post;
  });

// 2) Desktop brand logo (png inside .desktop-brand-mark)
html = html.replace(/(<div class="desktop-brand-mark"><img src=")data:image\/png;base64,([A-Za-z0-9+/=]+)(")/,
  (_, pre, b64, post) => {
    writeFileSync('src/assets/brand-logo.png', Buffer.from(b64, 'base64'));
    return pre + './src/assets/brand-logo.png' + post;
  });

// 3) Beeboo mascot button face
html = html.replace(/(<span class="beeboo-face">\s*<img src=")data:image\/png;base64,([A-Za-z0-9+/=]+)(")/,
  (_, pre, b64, post) => {
    writeFileSync('src/assets/beeboo-mascot.png', Buffer.from(b64, 'base64'));
    return pre + './src/assets/beeboo-mascot.png' + post;
  });

// 4) Hero vinyl record
html = html.replace(/(<img class="hero-vinyl-record" src=")data:image\/png;base64,([A-Za-z0-9+/=]+)(")/,
  (_, pre, b64, post) => {
    writeFileSync('src/assets/hero-vinyl.png', Buffer.from(b64, 'base64'));
    return pre + './src/assets/hero-vinyl.png' + post;
  });

// 5) Beeboo chat head face (the remaining png in chat head)
html = html.replace(/(<span class="beeboo-face"><img src=")data:image\/png;base64,([A-Za-z0-9+/=]+)(")/,
  (_, pre, b64, post) => {
    writeFileSync('src/assets/beeboo-face.png', Buffer.from(b64, 'base64'));
    return pre + './src/assets/beeboo-face.png' + post;
  });

// 6) Radio tea hero (remaining jpeg)
html = html.replace(/(<img class="radio-tea-hero-img" id="radioTeaHeroImg" alt="" src=")data:image\/jpeg;base64,([A-Za-z0-9+/=]+)(")/,
  (_, pre, b64, post) => {
    writeFileSync('src/assets/radio-hero.jpg', Buffer.from(b64, 'base64'));
    return pre + './src/assets/radio-hero.jpg' + post;
  });

const remaining = (html.match(/data:image\/(png|jpeg);base64,/g) || []).length;
writeFileSync(file, html);
console.log('remaining data URIs (non-svg):', remaining);
