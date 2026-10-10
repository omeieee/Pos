// Generates the logo and LINE rich-menu art from design/brand.md values.
//   node design/build/build-brand-art.mjs
// Needs: python with fonttools (pip install fonttools), and playwright-core with a
// Chromium (set PW_CORE to its path if it is not resolvable from here). Fonts are
// downloaded to the OS temp folder, subset, and embedded in each SVG as base64 WOFF
// (Kanit and IBM Plex Sans Thai, both SIL OFL), so every SVG is self-contained.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const design = resolve(here, '..');
const out = { logo: join(design, 'logo'), menu: join(design, 'rich-menu') };
for (const d of Object.values(out)) mkdirSync(d, { recursive: true });

// ---- brand tokens (design/brand.md section 3; packages/ui baseTokens) ----
const C = {
  brand: '#C62828', brandDeep: '#A61E1E', brandSubtle: '#FDECEA', accent: '#F57C1F',
  bg: '#FAF7F2', sunken: '#F3EEE7', border: '#E4DCD1', ink: '#1F1A17', muted: '#5E554D', white: '#FFFFFF',
};

// ---- fonts ----
const FONTS = [
  { fam: 'SDS Kanit', weight: 600, key: 'kanit600', url: 'https://fonts.gstatic.com/s/kanit/v17/nKKU-Go6G5tXcr5KPyWg.ttf' },
  { fam: 'SDS Plex', weight: 500, key: 'plex500', url: 'https://fonts.gstatic.com/s/ibmplexsansthai/v11/m8JMje1VVIzcq1HzJq2AEdo2Tj_qvLqE-vUFbQ.ttf' },
  { fam: 'SDS Plex', weight: 700, key: 'plex700', url: 'https://fonts.gstatic.com/s/ibmplexsansthai/v11/m8JMje1VVIzcq1HzJq2AEdo2Tj_qvLqEsvMFbQ.ttf' },
];
const cache = join(tmpdir(), 'sds-brand-fonts');
mkdirSync(cache, { recursive: true });
for (const f of FONTS) {
  f.path = join(cache, `${f.key}.ttf`);
  if (!existsSync(f.path)) writeFileSync(f.path, Buffer.from(await (await fetch(f.url)).arrayBuffer()));
}
// U+0E4D (nikhahit) and U+0E32 (sara aa) are always kept: browsers decompose sara am (U+0E33)
// into them before shaping, so a subset without them mis-draws "ำ" (seen on "ชำ").
const used = new Set([...' 0123456789.,:·-/฿()+ํา']);
const KANIT = "'SDS Kanit', Kanit, 'Leelawadee UI', Tahoma, sans-serif";
const PLEX = "'SDS Plex', 'IBM Plex Sans Thai', 'Leelawadee UI', Tahoma, sans-serif";
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** A <text> element; records its characters for font subsetting. */
function text(s, { x, y, size, fam = 'k', fill, anchor = 'start', ls = 0, id }) {
  for (const ch of s) used.add(ch);
  const font = fam === 'k' ? `${KANIT}` : PLEX;
  const w = fam === 'k' ? 600 : fam === 'p7' ? 700 : 500;
  return `<text${id ? ` id="${id}"` : ''} x="${x}" y="${y}" font-family="${font}" font-weight="${w}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ''}>${esc(s)}</text>`;
}
function fontCss() {
  const chars = [...used].join('');
  const txt = join(cache, 'chars.txt');
  writeFileSync(txt, chars, 'utf8');
  return FONTS.map((f) => {
    const o = join(cache, `${f.key}.sub.woff`);
    execFileSync('python', ['-m', 'fontTools.subset', f.path, `--text-file=${txt}`, '--layout-features=*', '--flavor=woff', '--no-hinting', `--output-file=${o}`]);
    return `@font-face{font-family:'${f.fam}';font-weight:${f.weight};src:url(data:font/woff;base64,${readFileSync(o).toString('base64')}) format('woff')}`;
  }).join('');
}

// ---- logo ----
/** Bowl glyph in a 256 box: bowl, three noodle wisps, chili-oil stripe. */
function glyph({ bowl, wisp, stripe }) {
  return `<path d="M64 124H192A64 64 0 0 1 64 124Z" fill="${bowl}"/>
<g fill="none" stroke="${wisp}" stroke-width="9" stroke-linecap="round"><path d="M96 112C86 94 108 88 98 66"/><path d="M128 112C118 94 140 88 130 66"/><path d="M160 112C150 94 172 88 162 66"/></g>
<rect x="72" y="204" width="112" height="14" rx="7" fill="${stripe}"/>`;
}
const markReg = (g = glyph({ bowl: C.white, wisp: C.white, stripe: C.accent })) => `<rect width="256" height="256" rx="56" fill="${C.brand}"/>${g}`;
const markRev = () => `<rect width="256" height="256" rx="56" fill="${C.white}"/>${glyph({ bowl: C.brand, wisp: C.brand, stripe: C.accent })}`;
const svgWrap = (w, h, body, title, css = '{{FONT}}') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title><style>${css}</style>${body}</svg>\n`;

const NAME = 'แซ่บโดนเส้น';
function horizontal(width, rev) {
  const word = rev ? C.white : C.brand;
  const sub = rev ? C.white : C.ink;
  const body = `<g>${rev ? markRev() : markReg()}</g>
${text(NAME, { x: 296, y: 158, size: 150, fill: word, id: 'wm' })}
${text('SAAP DON SEN', { x: 302, y: 222, size: 44, fam: 'p7', fill: sub, ls: 14, id: 'wl' })}`;
  return svgWrap(width, 256, body, 'แซ่บโดนเส้น Saap Don Sen');
}
const logoSvgs = {
  'logo-mark.svg': () => svgWrap(256, 256, markReg(), 'แซ่บโดนเส้น'),
  'logo-mark-reverse.svg': () => svgWrap(256, 256, markRev(), 'แซ่บโดนเส้น'),
  // LINE OA profile: full bleed (LINE crops to a circle), glyph kept inside the circle safe zone.
  'logo-line-profile.svg': () => svgWrap(256, 256, `<rect width="256" height="256" fill="${C.brand}"/><g transform="translate(128 128) scale(.82) translate(-128 -128)">${glyph({ bowl: C.white, wisp: C.white, stripe: C.accent })}</g>`, 'แซ่บโดนเส้น'),
};

// ---- rich menu ----
const ICON = {
  bowl: (s) => `<g fill="none" stroke="${s}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 54H88A38 38 0 0 1 12 54Z"/><path d="M34 46C28 36 40 32 34 22M50 46C44 36 56 32 50 22M66 46C60 36 72 32 66 22"/></g>`,
  cart: (s) => `<g fill="none" stroke="${s}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 18H24L34 62H78L88 30H28"/><circle cx="42" cy="78" r="6"/><circle cx="72" cy="78" r="6"/></g>`,
  pay: (s) => `<circle cx="50" cy="50" r="38" fill="none" stroke="${s}" stroke-width="6"/>${text('฿', { x: 50, y: 69, size: 54, fam: 'p7', fill: s, anchor: 'middle' })}`,
  chat: (s) => `<g fill="none" stroke="${s}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 20H86V68H48L28 86V68H14Z"/></g><g fill="${s}"><circle cx="34" cy="44" r="5"/><circle cx="50" cy="44" r="5"/><circle cx="66" cy="44" r="5"/></g>`,
};
const icon = (name, cx, cy, size, stroke) => `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 100})">${ICON[name](stroke)}</g>`;

function smallTile(r, { ic, label, sub, iconR, labelSize, subSize, top }) {
  const cx = r.x + r.w / 2;
  const cy = r.y + top;
  const lines = sub.map((s, i) => text(s, { x: cx, y: cy + iconR + labelSize * 1.55 + subSize * 1.45 * (i + 1) + 6, size: subSize, fam: 'p', fill: C.muted, anchor: 'middle' })).join('');
  return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${C.bg}"/>
<circle cx="${cx}" cy="${cy}" r="${iconR}" fill="${C.brandSubtle}"/>${icon(ic, cx, cy, iconR * 1.15, C.brand)}
${text(label, { x: cx, y: cy + iconR + labelSize * 1.3, size: labelSize, fill: C.ink, anchor: 'middle' })}${lines}`;
}
const heroBg = (r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${C.brand}"/><rect x="${r.x}" y="${r.y + r.h - 22}" width="${r.w}" height="22" fill="${C.accent}"/>`;
const badge = (x, y, size, label) => {
  const w = [...label].length * size * 0.5 + size * 1.6;
  return `<rect x="${x}" y="${y}" width="${w}" height="${size * 1.9}" rx="${size * 0.95}" fill="${C.white}"/>${text(label, { x: x + size * 0.8, y: y + size * 1.32, size, fam: 'p7', fill: C.brand })}`;
};

function menuFull() {
  const hero = { x: 0, y: 0, w: 2500, h: 843 };
  const tiles = [
    { x: 0, y: 843, w: 833, h: 843, ic: 'cart', label: 'ออเดอร์ของฉัน', sub: ['ตะกร้า · ดูสถานะอาหาร'] },
    { x: 833, y: 843, w: 834, h: 843, ic: 'pay', label: 'วิธีชำระเงิน', sub: ['PromptPay · เงินสด', 'ไทยช่วยไทย'] },
    { x: 1667, y: 843, w: 833, h: 843, ic: 'chat', label: 'ติดต่อร้าน', sub: ['แชทถามร้านได้เลย'] },
  ];
  const body = `<rect width="2500" height="1686" fill="${C.bg}"/>${heroBg(hero)}
<g opacity=".16" transform="translate(1560 90) scale(3.1)" fill="#fff">${ICON.bowl('#fff')}</g>
${icon('bowl', 330, 380, 360, C.white)}
${text('สั่งอาหาร', { x: 600, y: 440, size: 250, fill: C.white, id: 'hero-title' })}
${text('เลือกเมนู ใส่ตะกร้า สั่งได้เลย', { x: 606, y: 560, size: 86, fam: 'p', fill: C.white, id: 'hero-sub' })}
${badge(606, 620, 54, 'ส่งถึงทางเข้าอาคาร')}
${tiles.map((t) => smallTile(t, { ic: t.ic, label: t.label, sub: t.sub, iconR: 150, labelSize: 120, subSize: 62, top: 255 })).join('')}
<g fill="${C.border}"><rect x="832" y="843" width="3" height="843"/><rect x="1665" y="843" width="3" height="843"/></g>`;
  return { svg: svgWrap(2500, 1686, body, 'Rich menu แซ่บโดนเส้น'), w: 2500, h: 1686, tiles: [hero, ...tiles] };
}
function menuCompact() {
  const hero = { x: 0, y: 0, w: 1000, h: 843 };
  const tiles = [
    { x: 1000, y: 0, w: 500, h: 843, ic: 'cart', label: 'ออเดอร์ของฉัน', sub: ['ตะกร้า · สถานะ'] },
    { x: 1500, y: 0, w: 500, h: 843, ic: 'pay', label: 'วิธีชำระเงิน', sub: ['PromptPay · เงินสด', 'ไทยช่วยไทย'] },
    { x: 2000, y: 0, w: 500, h: 843, ic: 'chat', label: 'ติดต่อร้าน', sub: ['แชทถามร้านได้เลย'] },
  ];
  const body = `<rect width="2500" height="843" fill="${C.bg}"/>${heroBg(hero)}
${icon('bowl', 150, 175, 170, C.white)}
${text('สั่งอาหาร', { x: 70, y: 500, size: 190, fill: C.white, id: 'hero-title' })}
${text('เลือกเมนู ใส่ตะกร้า สั่งได้เลย', { x: 74, y: 585, size: 56, fam: 'p', fill: C.white, id: 'hero-sub' })}
${badge(74, 625, 40, 'ส่งถึงทางเข้าอาคาร')}
${tiles.map((t) => smallTile(t, { ic: t.ic, label: t.label, sub: t.sub, iconR: 100, labelSize: 62, subSize: 44, top: 330 })).join('')}
<g fill="${C.border}"><rect x="1000" y="0" width="3" height="843"/><rect x="1500" y="0" width="3" height="843"/><rect x="2000" y="0" width="3" height="843"/></g>`;
  return { svg: svgWrap(2500, 843, body, 'Rich menu แซ่บโดนเส้น (compact)'), w: 2500, h: 843, tiles: [hero, ...tiles] };
}

// ---- tap areas (LINE Messaging API rich menu object; packages/line fills the placeholders) ----
const LIFF = '{{LIFF_BASE_URL}}';
const actions = [
  { type: 'uri', label: 'สั่งอาหาร', uri: `${LIFF}/menu` },
  { type: 'uri', label: 'ออเดอร์ของฉัน', uri: `${LIFF}/orders` },
  { type: 'postback', label: 'วิธีชำระเงิน', data: 'rm=pay-info', displayText: 'วิธีชำระเงิน' },
  { type: 'postback', label: 'ติดต่อร้าน', data: 'rm=contact', displayText: 'ติดต่อร้าน' },
];
const menuJson = (m, name) => ({
  size: { width: m.w, height: m.h },
  selected: true,
  name,
  chatBarText: 'สั่งอาหาร',
  areas: m.tiles.map((t, i) => ({ bounds: { x: t.x, y: t.y, width: t.w, height: t.h }, action: actions[i] })),
});

// ---- build ----
const full = menuFull();
const compact = menuCompact();
// Width of the horizontal logo is measured in the browser below; start generous.
const pending = {
  ...Object.fromEntries(Object.entries(logoSvgs).map(([k, fn]) => [join(out.logo, k), fn])),
  [join(out.logo, 'logo-horizontal.svg')]: () => horizontal(W_H, false),
  [join(out.logo, 'logo-horizontal-reverse.svg')]: () => horizontal(W_H, true),
  [join(out.menu, 'rich-menu-full.svg')]: () => full.svg,
  [join(out.menu, 'rich-menu-compact.svg')]: () => compact.svg,
};
var W_H = 1400;
const pwPath = process.env.PW_CORE ?? 'playwright-core';
const { chromium } = await import(pwPath.startsWith('/') || /^[A-Za-z]:/.test(pwPath) ? pathToFileURL(pwPath).href : pwPath);
const browser = await chromium.launch();
const page = await browser.newPage();

function writeAll() {
  const svgs = Object.entries(pending).map(([file, fn]) => [file, fn()]); // collects characters first
  const css = fontCss();
  for (const [file, svg] of svgs) writeFileSync(file, svg.replace('{{FONT}}', () => css));
}
async function shot(svgFile, pngFile, w, h, transparent) {
  await page.setViewportSize({ width: w, height: h });
  const html = join(cache, 'shot.html');
  writeFileSync(html, `<body style="margin:0;background:${transparent ? 'transparent' : '#fff'}"><img id="i" src="${pathToFileURL(svgFile).href}" width="${w}" height="${h}" style="display:block"></body>`);
  await page.goto(pathToFileURL(html).href);
  await page.evaluate(() => document.getElementById('i').decode());
  await page.screenshot({ path: pngFile, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
}
// pass 1: write, measure the wordmark so the horizontal logo has a tight canvas
writeAll();
await page.setViewportSize({ width: 1600, height: 300 });
await page.goto(pathToFileURL(join(out.logo, 'logo-horizontal.svg')).href);
const right = await page.evaluate(() => Math.max(...['wm', 'wl'].map((id) => { const b = document.getElementById(id).getBBox(); return b.x + b.width; })));
W_H = Math.ceil(right + 28);
writeAll();

// text-fit check for the rich menu (every label must sit inside its tile with margin)
const problems = [];
for (const [name, m] of [['full', full], ['compact', compact]]) {
  await page.setViewportSize({ width: m.w, height: m.h });
  await page.goto(pathToFileURL(join(out.menu, `rich-menu-${name}.svg`)).href);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('text')].map((t) => { const b = t.getBBox(); return { s: t.textContent, x: b.x, y: b.y, w: b.width, h: b.height }; }));
  for (const b of boxes) {
    const tile = m.tiles.find((t) => b.x + b.w / 2 >= t.x && b.x + b.w / 2 < t.x + t.w && b.y + b.h / 2 >= t.y && b.y + b.h / 2 < t.y + t.h);
    if (!tile || [...b.s].length < 2) continue; // skip the baht glyph (local coordinates)
    const mx = Math.min(b.x - tile.x, tile.x + tile.w - (b.x + b.w));
    const my = Math.min(b.y - tile.y, tile.y + tile.h - (b.y + b.h));
    if (mx < 30 || my < 20) problems.push(`${name}: "${b.s}" margin x=${Math.round(mx)} y=${Math.round(my)}`);
  }
}
if (problems.length) console.warn('TEXT FIT WARNINGS\n' + problems.join('\n'));

// PNG exports
const L = (f) => join(out.logo, f);
const M = (f) => join(out.menu, f);
await shot(L('logo-mark.svg'), L('logo-mark-1024.png'), 1024, 1024, true);
await shot(L('logo-mark-reverse.svg'), L('logo-mark-reverse-1024.png'), 1024, 1024, true);
await shot(L('logo-line-profile.svg'), L('logo-line-profile-640.png'), 640, 640, false);
const hh = 512;
await shot(L('logo-horizontal.svg'), L('logo-horizontal-2x.png'), W_H * 2, hh, true);
await shot(L('logo-horizontal-reverse.svg'), L('logo-horizontal-reverse-2x.png'), W_H * 2, hh, true);
await shot(M('rich-menu-full.svg'), M('rich-menu-full.png'), 2500, 1686, false);
await shot(M('rich-menu-compact.svg'), M('rich-menu-compact.png'), 2500, 843, false);
await browser.close();

writeFileSync(M('rich-menu-full.json'), `${JSON.stringify(menuJson(full, 'sds-main-full-v1'), null, 2)}\n`);
writeFileSync(M('rich-menu-compact.json'), `${JSON.stringify(menuJson(compact, 'sds-main-compact-v1'), null, 2)}\n`);

for (const f of [M('rich-menu-full.png'), M('rich-menu-compact.png')]) {
  const kb = Math.round(statSync(f).size / 1024);
  console.log(`${f}: ${kb} KB`);
  if (kb >= 1024) throw new Error('rich menu image is 1 MB or more (LINE limit)');
}
console.log('done; horizontal logo width', W_H);
