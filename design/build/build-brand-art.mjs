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

// ---- rich menu ("Hot bowl, calm glass": same palette, radii, glass cards and 24-grid stroke icons as the customer app) ----
// App icon paths (apps/liff-web/src/design/icons.tsx, 24 grid, stroke 1.8, round caps); cart, baht and chat are drawn in the same style.
const ICON = {
  bowl: '<path d="M3 11h18c0 5-4 9-9 9s-9-4-9-9zM8 6c1-1.5 1-2.5 0-4M13 6c1-1.5 1-2.5 0-4"/>',
  cart: '<path d="M3 4h2.4l2.1 11h10.2l2-8H6.4"/><circle cx="9.6" cy="19.3" r="1.3"/><circle cx="16.8" cy="19.3" r="1.3"/>',
  baht: '<circle cx="12" cy="12" r="9.5"/><path d="M10 7.2h3.4a2.2 2.2 0 0 1 0 4.4H10M10 11.6h3.9a2.2 2.2 0 0 1 0 4.4H10M10 7.2V16M12 5.6v1.6M12 16v1.6"/>',
  chat: '<path d="M4 5h16v11h-6.5L9 20v-4H4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" stroke-width="2.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  building: '<path d="M5 21V4h9v17M14 9h5v12M3 21h18"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
};
const icon = (name, cx, cy, size, color, sw = 1.8) =>
  `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</g>`;

// app tokens (packages/ui design.css)
const G = {
  chili2: '#d63a2e',
  chili: '#c62828',
  chiliDeep: '#bd2424',
  chiliInk: '#9c1c1c',
  chiliSoft: '#fce6e1',
  amberSoft: '#ffefd0',
  amberInk: '#8a4b00',
  skySoft: '#e4ecfa',
  skyInk: '#1d4e9e',
  ink: '#1c1411',
  ink2: '#5e504a',
  paper: '#fbf4ec',
};

const defs = (w, h) => `<defs>
<radialGradient id="o1" gradientUnits="userSpaceOnUse" cx="${w * 0.08}" cy="${h * 0.04}" r="${w * 0.42}"><stop offset="0" stop-color="#ff8a65" stop-opacity=".42"/><stop offset="1" stop-color="#ff8a65" stop-opacity="0"/></radialGradient>
<radialGradient id="o2" gradientUnits="userSpaceOnUse" cx="${w * 0.96}" cy="${h * 0.08}" r="${w * 0.36}"><stop offset="0" stop-color="#ffc46b" stop-opacity=".5"/><stop offset="1" stop-color="#ffc46b" stop-opacity="0"/></radialGradient>
<radialGradient id="o3" gradientUnits="userSpaceOnUse" cx="${w * 0.86}" cy="${h}" r="${w * 0.4}"><stop offset="0" stop-color="#d68cc8" stop-opacity=".3"/><stop offset="1" stop-color="#d68cc8" stop-opacity="0"/></radialGradient>
<linearGradient id="hero" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${G.chili2}"/><stop offset="1" stop-color="${G.chiliDeep}"/></linearGradient>
<radialGradient id="glow" cx=".9" cy=".05" r=".7"><stop offset="0" stop-color="#f5a524" stop-opacity=".55"/><stop offset="1" stop-color="#f5a524" stop-opacity="0"/></radialGradient>
<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".94"/><stop offset="1" stop-color="#fff" stop-opacity=".72"/></linearGradient>
<filter id="shR" x="-10%" y="-12%" width="120%" height="140%"><feDropShadow dx="0" dy="26" stdDeviation="28" flood-color="#c62828" flood-opacity=".34"/></filter>
<filter id="shG" x="-12%" y="-12%" width="124%" height="135%"><feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#783c1e" flood-opacity=".16"/></filter>
</defs>`;
const backdrop = (w, h) =>
  `<rect width="${w}" height="${h}" fill="${G.paper}"/><rect width="${w}" height="${h}" fill="url(#o1)"/><rect width="${w}" height="${h}" fill="url(#o2)"/><rect width="${w}" height="${h}" fill="url(#o3)"/>`;

/** Pill with an icon and a label (the app's chip). */
function pill(x, y, size, label, ic) {
  const h = size * 2;
  const w = [...label].length * size * 0.52 + size * 3.1;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#fff" fill-opacity=".92"/>${icon(ic, x + size * 1.15, y + h / 2, size * 1.2, G.chiliInk)}${text(label, { x: x + size * 2.1, y: y + h / 2 + size * 0.36, size, fam: 'p7', fill: G.chiliInk })}`;
}
/** Primary-action card: the app's chili gradient button, scaled up. */
function heroCard(r, k, o) {
  const { x, y, w, h } = r;
  const rad = 56 * k;
  const cid = `hc${Math.round(w)}`;
  const dcx = x + o.discX,
    dcy = y + o.discY;
  const bx = x + o.btnX,
    by = y + o.btnY;
  return `<clipPath id="${cid}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rad}"/></clipPath>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rad}" fill="url(#hero)" filter="url(#shR)"/>
<g clip-path="url(#${cid})"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#glow)"/>
<circle cx="${x + w * 0.82}" cy="${y + h * 1.0}" r="${h * 0.62}" fill="#fff" fill-opacity=".07"/><circle cx="${x + w * 0.1}" cy="${y + h * 1.05}" r="${h * 0.45}" fill="#fff" fill-opacity=".06"/>
<g opacity=".06">${icon('bowl', x + w * 0.64, y + h * 0.5, h * 1.25, '#fff', 1.2)}</g></g>
<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" rx="${rad - 1.5}" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="3"/>
<circle cx="${dcx}" cy="${dcy}" r="${o.discR}" fill="#fff" fill-opacity=".18" stroke="#fff" stroke-opacity=".45" stroke-width="${4 * k}"/>
${icon('bowl', dcx, dcy, o.discR * 1.3, '#fff', 1.7)}
${text('สั่งอาหาร', { x: x + o.tx, y: y + o.ty, size: o.tSize, fill: '#fff', id: 'hero-title' })}
${text('เลือกเมนู ใส่ตะกร้า สั่งได้เลย', { x: x + o.tx + 4, y: y + o.sy, size: o.sSize, fam: 'p', fill: '#fff', id: 'hero-sub' })}
${pill(x + o.tx + 4, y + o.py, o.pSize, 'ส่งถึงทางเข้าอาคาร', 'building')}
<circle cx="${bx}" cy="${by}" r="${o.btnR}" fill="#fff"/>${icon('chevronRight', bx + o.btnR * 0.04, by, o.btnR * 1.1, G.chili, 2.2)}`;
}
/** Soft glass card with a tinted icon chip, label and sub-lines. */
function tileCard(r, k, t, o) {
  const { x, y, w, h } = r;
  const rad = 48 * k;
  const cx = x + w / 2;
  const cy = y + o.chipY;
  const cs = o.chip;
  const subs = t.sub
    .map((s, i) =>
      text(s, {
        x: cx,
        y: y + o.subY + i * o.subGap,
        size: o.subSize,
        fam: 'p',
        fill: G.ink2,
        anchor: 'middle',
      }),
    )
    .join('');
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rad}" fill="url(#glass)" filter="url(#shG)"/>
<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" rx="${rad - 1.5}" fill="none" stroke="#fff" stroke-width="3"/>
<rect x="${cx - cs / 2}" y="${cy - cs / 2}" width="${cs}" height="${cs}" rx="${cs * 0.32}" fill="${t.soft}"/><rect x="${cx - cs / 2 + 2}" y="${cy - cs / 2 + 2}" width="${cs - 4}" height="${cs - 4}" rx="${cs * 0.32 - 2}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="3"/>
${icon(t.ic, cx, cy, cs * 0.6, t.ink, 1.8)}
${text(t.label, { x: cx, y: y + o.labelY, size: o.labelSize, fill: G.ink, anchor: 'middle' })}${subs}`;
}
const TILES = [
  {
    ic: 'cart',
    label: 'ออเดอร์ของฉัน',
    sub: ['ตะกร้า · ดูสถานะอาหาร'],
    soft: G.chiliSoft,
    ink: G.chili,
  },
  {
    ic: 'user',
    label: 'ข้อมูลสมาชิก',
    sub: ['ชื่อ · เบอร์โทร · ตึก'],
    soft: G.amberSoft,
    ink: G.amberInk,
  },
  { ic: 'chat', label: 'ติดต่อร้าน', sub: ['แชทถามร้านได้เลย'], soft: G.skySoft, ink: G.skyInk },
];

function menuFull() {
  const hero = { x: 0, y: 0, w: 2500, h: 843 };
  const bounds = [
    { x: 0, y: 843, w: 833, h: 843 },
    { x: 833, y: 843, w: 834, h: 843 },
    { x: 1667, y: 843, w: 833, h: 843 },
  ];
  // cards sit inside their tap areas: 70 px outer margin, 70 px gap
  const card = (b) => ({
    x: b.x + (b.x === 0 ? 70 : 35),
    y: b.y + 35,
    w: b.w - (b.x === 0 ? 70 + 35 : b.x === 1667 ? 35 + 70 : 70),
    h: 738,
  });
  const hc = { x: 70, y: 70, w: 2360, h: 738 };
  const to = {
    chipY: 215,
    chip: 310,
    labelY: 510,
    labelSize: 92,
    subY: 600,
    subGap: 76,
    subSize: 62,
  };
  const body = `${defs(2500, 1686)}${backdrop(2500, 1686)}
${heroCard(hc, 3.2, { discX: 290, discY: 369, discR: 215, btnX: 2150, btnY: 369, btnR: 135, tx: 600, ty: 340, tSize: 250, sy: 452, sSize: 84, py: 508, pSize: 52 })}
${bounds.map((b, i) => tileCard(card(b), 3.2, TILES[i], to)).join('')}`;
  return {
    svg: svgWrap(2500, 1686, body, 'Rich menu แซ่บโดนเส้น'),
    w: 2500,
    h: 1686,
    tiles: [hero, ...bounds],
  };
}
function menuCompact() {
  const hero = { x: 0, y: 0, w: 1000, h: 843 };
  const bounds = [
    { x: 1000, y: 0, w: 500, h: 843 },
    { x: 1500, y: 0, w: 500, h: 843 },
    { x: 2000, y: 0, w: 500, h: 843 },
  ];
  // 36 px outer margin, 36 px gap
  const hc = { x: 36, y: 36, w: 946, h: 771 };
  const card = (b) => ({ x: b.x + 18, y: 36, w: b.x === 2000 ? 500 - 18 - 36 : 464, h: 771 });
  const to = {
    chipY: 300,
    chip: 240,
    labelY: 535,
    labelSize: 54,
    subY: 615,
    subGap: 62,
    subSize: 44,
  };
  const body = `${defs(2500, 843)}${backdrop(2500, 843)}
${heroCard(hc, 1.6, { discX: 150, discY: 150, discR: 100, btnX: 830, btnY: 150, btnR: 70, tx: 60, ty: 470, tSize: 170, sy: 548, sSize: 52, py: 590, pSize: 38 })}
${bounds.map((b, i) => tileCard(card(b), 1.6, TILES[i], to)).join('')}`;
  return {
    svg: svgWrap(2500, 843, body, 'Rich menu แซ่บโดนเส้น (compact)'),
    w: 2500,
    h: 843,
    tiles: [hero, ...bounds],
  };
}


// ---- tap areas (LINE Messaging API rich menu object; packages/line fills the placeholders) ----
const LIFF = '{{LIFF_BASE_URL}}';
const actions = [
  { type: 'uri', label: 'สั่งอาหาร', uri: `${LIFF}/menu` },
  { type: 'uri', label: 'ออเดอร์ของฉัน', uri: `${LIFF}/orders` },
  { type: 'uri', label: 'ข้อมูลสมาชิก', uri: `${LIFF}/member` },
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
