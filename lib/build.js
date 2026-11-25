'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { esc, formatBDT } = require('./util');
const { priceView } = require('./pricing');
const { visibleAttrs } = require('./facets');

const enc = encodeURIComponent;

const ICON = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  bag: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>',
  chat: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>',
};

// Small line icons for the category tiles. The icon is picked from the category name; anything else gets a cube.
const CAT_ICONS = {
  spool: '<circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="7"/><circle cx="24" cy="10" r="2"/><circle cx="24" cy="38" r="2"/><circle cx="10" cy="24" r="2"/><circle cx="38" cy="24" r="2"/>',
  nozzle: '<path d="M15 5h18v9H15z"/><path d="M18 14h12l-3 17h-6z"/><path d="M21 31h6l-1.5 11h-3z"/>',
  bed: '<path d="M8 28l7-12h18l7 12z"/><rect x="4" y="28" width="40" height="7" rx="2"/><path d="M12 39v4M36 39v4M20 16l-3 12M28 16l3 12"/>',
  printer: '<rect x="6" y="5" width="36" height="38" rx="3"/><path d="M6 13h36M17 13v8l-3 5h12l-3-5v-8M11 38h26"/>',
  drop: '<path d="M24 5c8 10 13 16 13 23a13 13 0 0 1-26 0c0-7 5-13 13-23z"/><path d="M17 29a7 7 0 0 0 6 6"/>',
  cube: '<path d="M24 5l17 9v20l-17 9-17-9V14z"/><path d="M7 14l17 10 17-10M24 24v19"/>',
};
function catIconKey(name) {
  const n = String(name).toLowerCase();
  if (/fila|pla\b|petg|abs\b|tpu|spool|resin/.test(n)) return 'spool';
  if (/nozz|hotend|hot end|extrud/.test(n)) return 'nozzle';
  if (/\bbed\b|plate|build surface/.test(n)) return 'bed';
  if (/printer|machine/.test(n)) return 'printer';
  if (/lubric|grease|oil|glue|adhes|clean|spray/.test(n)) return 'drop';
  return 'cube';
}
const catIcon = (name) => `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CAT_ICONS[catIconKey(name)]}</svg>`;

// The logo mark: a spool of filament in the six layer colours.
const SPOOL_MARK = '<svg class="spool" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#12b5cb"/><circle cx="24" cy="24" r="15" fill="#e11d86"/><circle cx="24" cy="24" r="9" fill="#ffc21a"/><circle cx="24" cy="24" r="4" fill="#fff"/><path d="M24 2v10M42 31l-9-3" stroke="#191c2b" stroke-width="3" stroke-linecap="round"/></svg>';

// Hero picture: a printer that keeps printing a vase, layer by layer, in a loop (the motion lives in style.css;
// with reduced motion it shows the finished vase).
const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0c1 7 5 11 12 12-7 1-11 5-12 12-1-7-5-11-12-12 7-1 11-5 12-12z"/></svg>';
const MINI_SPOOL = (a, b, c) => `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="${a}"/><circle cx="32" cy="32" r="21" fill="${b}"/><circle cx="32" cy="32" r="13" fill="${c}"/><circle cx="32" cy="32" r="6" fill="#fff"/><circle cx="32" cy="9" r="3" fill="#fff" opacity=".8"/><circle cx="55" cy="32" r="3" fill="#fff" opacity=".8"/><circle cx="32" cy="55" r="3" fill="#fff" opacity=".8"/><circle cx="9" cy="32" r="3" fill="#fff" opacity=".8"/></svg>`;
const HERO_ART = (() => {
  const layers = [];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const w = Math.round(58 + 78 * Math.sin(Math.PI * (0.12 + 0.82 * t)) + 14 * Math.sin(t * 9));
    layers.push(`<rect class="layer k${i} l${(i % 6) + 1}" x="${225 - w / 2}" y="${312 - i * 12}" width="${w}" height="11" rx="5.5"/>`);
  }
  return `<svg viewBox="0 0 450 380" role="presentation" focusable="false">
<polygon class="art-top" points="70,330 380,330 430,362 20,362"/><rect class="art-side" x="20" y="362" width="410" height="12" rx="4"/>
<rect class="art-rail" x="46" y="36" width="12" height="298" rx="6"/><rect class="art-rail" x="392" y="36" width="12" height="298" rx="6"/>
<g class="vase">${layers.join('')}</g>
<g class="rig"><rect class="art-beam" x="46" y="92" width="358" height="14" rx="7"/>
<g class="sweep"><path class="art-fil" d="M225 -400V78"/><rect class="art-head" x="196" y="72" width="58" height="38" rx="9"/><rect class="art-vent" x="204" y="80" width="42" height="7" rx="3.5"/><rect class="art-head" x="212" y="108" width="26" height="12" rx="3"/><path class="art-tip" d="M216 120h18l-9 11z"/></g></g>
</svg>
<span class="deco spool1">${MINI_SPOOL('#ffc21a', '#e11d86', '#12b5cb')}</span><span class="deco spool2">${MINI_SPOOL('#12b5cb', '#84cc16', '#ff6a13')}</span>
<span class="deco nozzle"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M13 4h22v10H13z" fill="#fff"/><path d="M16 14h16l-4 20h-8z" fill="#ffc21a"/><path d="M21 34h6l-1.5 11h-3z" fill="#ff6a13"/></svg></span>
<span class="spark s1">${SPARK}</span><span class="spark s2">${SPARK}</span><span class="spark s3">${SPARK}</span><span class="spark s4">${SPARK}</span>`;
})();
const CT_ICONS = {
  wa: '<path d="M4 20l1.4-4.2A8 8 0 1 1 8.4 18.7z"/><path d="M9 9.5c.3 2 2.5 4.2 4.5 4.7l1.3-1.2-1.8-1-.8.6c-.7-.3-1.4-1-1.7-1.7l.6-.8-1-1.8z"/>',
  ph: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  em: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  loc: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.800 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  hrs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.500 2"/>',
};
const ctIcon = (k) => `<span class="ct-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CT_ICONS[k]}</svg></span>`;
const WAVE = '<svg class="hero-wave" viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true"><path d="M0 30C180 70 360 0 600 28S1000 64 1220 26c90-16 160-14 220 0V60H0z"/></svg>';
const STEP_ICONS = {
  pick: '<circle cx="18" cy="38" r="3"/><circle cx="36" cy="38" r="3"/><path d="M4 6h6l5 25h23l4-17H13"/>',
  send: '<path d="M8 10h32a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H22l-9 8v-8H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z"/><path d="M15 20h18M15 26h11"/>',
  done: '<circle cx="24" cy="24" r="19"/><path d="M14 25l7 7 13-15"/>',
};
const stepIcon = (k) => `<svg class="step-ic" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STEP_ICONS[k]}</svg>`;

/** Text colour that stays readable on the shop colour: white, or the dark ink for light colours. */
function onColor(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return '#fff';
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.0617 ? '#fff' : '#191c2b';
}

function sha(buf, n = 8) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, n);
}

function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

/**
 * Writes a file only when its content changed, and replaces it in one step so a visitor never gets half a file.
 * Remembers every path in counter.written so files that are no longer produced can be removed afterwards.
 */
function write(file, content, counter) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let same = false;
  try {
    const st = fs.statSync(file);
    if (st.size === buf.length) same = fs.readFileSync(file).equals(buf);
  } catch { /* new file */ }
  if (!same) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  if (counter) { counter.files++; if (counter.written) counter.written.add(path.resolve(file)); }
}

/** After a build: delete every file this build did not produce (old product pages, old product lists). */
function prune(distDir, written) {
  distDir = path.resolve(distDir);
  const keep = new Set([path.join(distDir, 'img')]);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (keep.has(full)) continue;
      if (ent.isDirectory()) {
        walk(full);
        if (!fs.readdirSync(full).length) fs.rmdirSync(full);
      } else if (!written.has(full)) {
        fs.rmSync(full, { force: true });
      }
    }
  };
  walk(distDir);
}

/**
 * Generate the complete static site into distDir from the store.
 * Returns a report. Only visible products are published.
 */
function build(store, { distDir, assetsDir, siteUrl = '' }) {
  const t0 = Date.now();
  const s = store.data.settings;
  const base = s.siteUrl || siteUrl || '';
  const warnings = [];
  const counter = { files: 0, written: new Set() };

  const all = store.data.products;
  // newest first; array order breaks ties (later imports are "newer")
  const visible = all
    .map((p, idx) => ({ p, idx }))
    .filter((x) => x.p.visible)
    .sort((a, b) => (a.p.createdAt < b.p.createdAt ? 1 : a.p.createdAt > b.p.createdAt ? -1 : b.idx - a.idx))
    .map((x) => x.p);

  const countBySlug = new Map();
  for (const p of visible) if (p.category) countBySlug.set(p.category, (countBySlug.get(p.category) || 0) + 1);
  const cats = store.data.categories.filter((c) => countBySlug.has(c.slug));
  const catBySlug = new Map(store.data.categories.map((c) => [c.slug, c]));

  if (!s.whatsapp) warnings.push('WhatsApp number is not set (Settings). Order buttons will not reach you.');
  if (!base) warnings.push('Site URL is not set (Settings). Facebook/WhatsApp link previews and the sitemap need it.');
  const noPhoto = visible.filter((p) => !p.images[0] && !p.images[1]).length;
  if (noPhoto) warnings.push(`${noPhoto} published product${noPhoto === 1 ? ' has' : 's have'} no photo.`);
  const noCat = visible.filter((p) => !p.category).length;
  if (noCat && cats.length) warnings.push(`${noCat} published product${noCat === 1 ? ' has' : 's have'} no category.`);
  if (!visible.length) warnings.push('No published products yet.');

  // ---- fresh output, keep img/ so unchanged photos are not copied again ----
  fs.mkdirSync(distDir, { recursive: true });

  // ---- assets (content-hashed so browsers cache them forever) ----
  const css = fs.readFileSync(path.join(assetsDir, 'style.css'));
  const js = fs.readFileSync(path.join(assetsDir, 'shop.js'));
  const cssName = `style.${sha(css)}.css`;
  const jsName = `shop.${sha(js)}.js`;
  write(path.join(distDir, 'assets', cssName), css, counter);
  write(path.join(distDir, 'assets', jsName), js, counter);

  // ---- images: copy what is referenced, delete what is not ----
  const needed = new Set();
  const firstImg = (p) => p.images.find(Boolean) || null;
  for (const p of visible) {
    for (const img of p.images) if (img) { needed.add(img.full); needed.add(img.thumb); }
    const f = firstImg(p);
    if (f && f.share) needed.add(f.share);
  }
  if (s.logo) needed.add(s.logo);
  const outImg = path.join(distDir, 'img');
  fs.mkdirSync(outImg, { recursive: true });
  const have = new Set(fs.readdirSync(outImg));
  for (const name of have) if (!needed.has(name)) fs.unlinkSync(path.join(outImg, name));
  let imgBytes = 0;
  let imgCount = 0;
  const missing = new Set();
  for (const name of needed) {
    const src = path.join(store.imgDir, name);
    const dst = path.join(outImg, name);
    if (!fs.existsSync(src)) { missing.add(name); continue; }
    if (!have.has(name)) { try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); } }
    imgBytes += fs.statSync(dst).size;
    imgCount++;
  }
  if (missing.size) warnings.push(`${missing.size} photo file(s) are missing on disk. Re-upload those photos.`);
  const imgUrl = (name) => `/img/${enc(name)}`;
  const ok = (name) => name && !missing.has(name);

  // ---- products.json (catalog + basket read this) ----
  // Filter groups per category, listing only groups that have at least one value on a visible product.
  const filterGroups = (c) => (c.filters || []).filter((f) => visible.some((p) => p.category === c.slug && visibleAttrs(c, p).some((a) => a.key === f.key)));
  const productsJson = JSON.stringify({
    c: cats.map((c) => {
      const f = filterGroups(c);
      return { s: c.slug, n: c.name, ...(f.length ? { f: f.map((g) => ({ k: g.key, l: g.label })) } : {}) };
    }),
    i: visible.map((p) => {
      const first = firstImg(p);
      const pv = priceView(p);
      // Price keys exist only when the price is shown: p = regular price, d = discount price.
      const price = pv.shown ? { p: pv.price, ...(pv.sale !== null ? { d: pv.sale } : {}) } : {};
      const attrs = Object.fromEntries(visibleAttrs(p.category ? catBySlug.get(p.category) : null, p).map((a) => [a.key, a.value]));
      return { i: p.id, s: p.sku, n: p.name, ...price, c: p.category || '', ...(Object.keys(attrs).length ? { a: attrs } : {}), k: p.inStock ? 1 : 0, t: first && ok(first.thumb) ? first.thumb : '' };
    }),
  });
  const dataName = `products.${sha(productsJson)}.json`;
  write(path.join(distDir, 'data', dataName), productsJson, counter);

  // ---- shared layout ----
  const cardHtml = (p) => {
    const first = firstImg(p);
    const img = first && ok(first.thumb)
      ? `<img src="${imgUrl(first.thumb)}" alt="${esc(p.name)}" width="400" height="400" loading="lazy" decoding="async">`
      : '<span class="noimg">No photo</span>';
    const pv = priceView(p);
    const sale = pv.shown && pv.pct >= 1 ? `<span class="badge badge-sale">${pv.pct}% OFF</span>` : '';
    const price = !pv.shown
      ? '<span class="card-price ask">Ask price on WhatsApp</span>'
      : pv.sale !== null
        ? `<span class="card-price"><span class="now">${formatBDT(pv.sale)}</span> <s>${formatBDT(pv.price)}</s></span>`
        : `<span class="card-price">${formatBDT(pv.price)}</span>`;
    return `<a class="card" href="/p/${enc(p.id)}/"><span class="card-img">${img}${p.inStock ? '' : '<span class="badge">Out of stock</span>'}${sale}</span><span class="card-body"><span class="card-name">${esc(p.name)}</span>${price}</span></a>`;
  };
  const waUrl = (msg) => `https://wa.me/${s.whatsapp}?text=${enc(msg)}`;
  const abs = (p) => (base ? base + p : p);
  const mapLink = s.mapUrl || (s.address ? `https://www.google.com/maps/search/?api=1&query=${enc(s.address)}` : '');

  // Simple built-in favicon: the first letter of the business name on the accent colour.
  const initial = esc(Array.from(s.businessName.trim())[0] || 'S');
  const favicon = 'data:image/svg+xml,' + enc(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${s.accentColor}"/><text x="32" y="45" font-size="38" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="700">${initial}</text></svg>`,
  );

  function layout(o) {
    const canonical = base ? `<link rel="canonical" href="${esc(abs(o.path))}">` : '';
    const og = [
      ['og:title', o.title], ['og:description', o.description], ['og:type', o.ogType || 'website'],
      ['og:site_name', s.businessName],
    ];
    if (base) og.push(['og:url', abs(o.path)]);
    if (o.image && base) og.push(['og:image', abs(o.image)]);
    const ogTags = og.map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join('');
    const card = `<meta name="twitter:card" content="${o.image && base ? 'summary_large_image' : 'summary'}">`;
    const brand = s.logo && ok(s.logo)
      ? `<img src="${imgUrl(s.logo)}" alt="${esc(s.businessName)}">`
      : `${SPOOL_MARK}<span>${esc(s.businessName)}</span>`;
    const social = [['Facebook', s.facebook], ['Instagram', s.instagram], ['YouTube', s.youtube], ['TikTok', s.tiktok]]
      .filter(([, u]) => u)
      .map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${n}</a>`).join('');
    const tel = s.phone ? esc(s.phone.replace(/[^\d+]/g, '')) : '';
    const contactLines = [
      s.phone ? `<a href="tel:${tel}">${esc(s.phone)}</a>` : '',
      s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : '',
      s.whatsapp ? `<a href="${esc(waUrl(''))}" target="_blank" rel="noopener">Chat on WhatsApp</a>` : '',
    ].filter(Boolean);
    const findLines = [
      s.address ? `<span>${esc(s.address)}</span>` : '',
      mapLink ? `<a href="${esc(mapLink)}" target="_blank" rel="noopener">Open on the map</a>` : '',
      s.hours ? `<span>${esc(s.hours)}</span>` : '',
    ].filter(Boolean);
    const footer = `<footer class="ftr"><div class="wrap ftr-grid"><div class="ftr-brand"><strong>${esc(s.businessName)}</strong>${s.tagline ? `<p>${esc(s.tagline)}</p>` : ''}${social ? `<div class="socials">${social}</div>` : ''}</div>${contactLines.length ? `<div class="ftr-col"><h4>Contact</h4>${contactLines.join('')}</div>` : ''}${findLines.length ? `<div class="ftr-col"><h4>Find us</h4>${findLines.join('')}</div>` : ''}</div></footer>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="theme-color" content="${esc(s.accentColor)}">
<link rel="icon" href="${s.logo && ok(s.logo) ? imgUrl(s.logo) : favicon}">
${canonical}${ogTags}${card}
<link rel="stylesheet" href="/assets/${cssName}">
<style>:root{--accent:${esc(s.accentColor)};--on-accent:${onColor(s.accentColor)}}</style>
${o.jsonld || ''}${o.noindex ? '<meta name="robots" content="noindex">' : ''}
</head>
<body data-wa="${esc(s.whatsapp)}" data-greet="${esc(s.waGreeting)}" data-site="${esc(base)}" data-products="/data/${dataName}">
<header class="hdr"><div class="wrap hdr-in">
<a class="brand" href="/">${brand}</a>
<form class="search" action="/catalog/" method="get" role="search"><input name="q" type="search" placeholder="Search products" aria-label="Search products" autocomplete="off"><button type="submit" aria-label="Search">${ICON.search}</button></form>
<a class="basket-link" href="/basket/" aria-label="Basket">${ICON.bag}<span class="basket-count" hidden>0</span></a>
</div></header>
<main>${o.body}</main>
${footer}
${s.whatsapp && !o.noFloat ? `<a class="wa-float" href="${esc(waUrl(''))}" target="_blank" rel="noopener" aria-label="Chat on WhatsApp">${ICON.chat}</a>` : ''}
<script src="/assets/${jsName}" defer></script>
</body></html>`;
  }

  // ---- home ----
  const featured = visible.filter((p) => p.featured).slice(0, 8);
  const latest = visible.slice(0, 8);
  const ribbonHalf = cats.length ? cats.map((c) => `<span>${esc(c.name)}<i></i></span>`).join('').repeat(Math.max(1, Math.ceil(12 / cats.length))) : '';
  const ctTile = (cls, icon, label, text, href) => {
    const inner = `${ctIcon(icon)}<span class="ct-t"><b>${esc(label)}</b><span>${esc(text)}</span></span>`;
    return href
      ? `<a class="ctile ${cls}" href="${esc(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`
      : `<div class="ctile ${cls}">${inner}</div>`;
  };
  const ctTiles = [
    s.whatsapp ? ctTile('ct1', 'wa', 'Chat on WhatsApp', 'The fastest way to order', waUrl('')) : '',
    s.phone ? ctTile('ct2', 'ph', 'Call us', s.phone, 'tel:' + s.phone.replace(/[^\d+]/g, '')) : '',
    s.email ? ctTile('ct3', 'em', 'Email us', s.email, 'mailto:' + s.email) : '',
    s.address || s.mapUrl ? ctTile('ct4', 'loc', 'Visit us', s.address || 'Open on the map', mapLink) : '',
    s.hours ? ctTile('ct5', 'hrs', 'Opening hours', s.hours, '') : '',
  ].filter(Boolean);
  const contactSection = ctTiles.length ? `<section class="section"><div class="wrap"><h2>Find us</h2><div class="ctiles">${ctTiles.join('')}</div></div></section>` : '';
  const homeBody = `<section class="hero"><span class="hero-blob b1"></span><span class="hero-blob b2"></span><span class="hero-floor"></span><div class="wrap hero-in"><div class="hero-copy"><h1>${esc(s.heroTitle)}</h1>${s.heroSubtitle ? `<p>${esc(s.heroSubtitle)}</p>` : ''}<div class="hero-cta"><a class="btn btn-yellow" href="/catalog/">Browse all ${visible.length} ${visible.length === 1 ? 'product' : 'products'}</a>${s.whatsapp ? `<a class="btn btn-ghost" href="${esc(waUrl(''))}" target="_blank" rel="noopener">Chat on WhatsApp</a>` : ''}</div></div><div class="hero-art" aria-hidden="true">${HERO_ART}</div></div>${WAVE}</section>
${cats.length ? `<div class="ribbon-wrap" aria-hidden="true"><div class="ribbon"><div class="ribbon-track">${ribbonHalf}${ribbonHalf}</div></div></div>` : ''}
${cats.length ? `<section class="section"><div class="wrap"><h2>Shop by category</h2><div class="cats">${cats.map((c, i) => `<a class="cat c${(i % 6) + 1}" href="/catalog/?cat=${enc(c.slug)}"><span class="cat-bg" aria-hidden="true">${catIcon(c.name)}</span><span class="cat-ic">${catIcon(c.name)}</span><span class="cat-name">${esc(c.name)}</span><small>${countBySlug.get(c.slug)} ${countBySlug.get(c.slug) === 1 ? 'product' : 'products'}</small></a>`).join('')}</div></div></section>` : ''}
${featured.length ? `<section class="section tint"><div class="wrap"><h2>Featured</h2><div class="grid">${featured.map(cardHtml).join('')}</div></div></section>` : ''}
<section class="how"><div class="wrap"><h2>How to order</h2><ol class="steps">
<li class="step">${stepIcon('pick')}<span class="step-n">1</span><h3>Pick your products</h3><p>Browse, filter by colour or material, and add what you need to the basket.</p></li>
<li class="step">${stepIcon('send')}<span class="step-n">2</span><h3>Send it on WhatsApp</h3><p>Your basket turns into a ready-made message. Just press send.</p></li>
<li class="step">${stepIcon('done')}<span class="step-n">3</span><h3>We confirm</h3><p>We check stock and delivery with you in the same chat.</p></li>
</ol></div></section>
${latest.length ? `<section class="section"><div class="wrap"><h2>New arrivals</h2><div class="grid">${latest.map(cardHtml).join('')}</div></div></section>` : ''}
${contactSection}`;
  const homeFirst = visible.map(firstImg).find(Boolean);
  write(path.join(distDir, 'index.html'), layout({
    path: '/', title: s.heroTitle ? `${s.businessName} | ${s.heroTitle}` : s.businessName,
    description: s.heroSubtitle || `Browse ${s.businessName} products and order on WhatsApp.`,
    image: homeFirst && homeFirst.share ? imgUrl(homeFirst.share) : null, body: homeBody,
  }), counter);

  // ---- catalog ----
  const catalogBody = `<div class="wrap" id="catalog">
<h1 id="title" style="margin-top:20px">All products</h1>
<div class="controls">
<input id="q" type="search" placeholder="Name or code" aria-label="Search" autocomplete="off">
<select id="cat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select>
<select id="sort" aria-label="Sort"><option value="newest">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></select>
<button type="button" id="fbtn" class="fbtn" aria-expanded="false" aria-controls="filters" hidden>Filters</button>
</div>
<div class="subbar" id="subbar" aria-label="Quick filters" hidden></div>
<div class="shop nofilters" id="shop">
<aside id="filters" class="filters" aria-label="Filters"></aside>
<div class="results">
<div class="achips" id="achips" aria-label="Active filters"></div>
<p class="count" id="count" aria-live="polite">Loading…</p>
<div class="grid" id="grid" hidden></div>
<div class="empty" id="none" hidden>No products found. <button type="button" class="linkbtn" id="noneclear" hidden>Clear filters</button></div>
<nav class="pager" id="pager" aria-label="Pagination"></nav>
</div>
</div>
<div class="fback" id="fback" hidden></div>
<noscript><p class="empty">Please enable JavaScript to browse the catalog.</p></noscript>
</div>`;
  write(path.join(distDir, 'catalog', 'index.html'), layout({
    path: '/catalog/', title: `Catalog | ${s.businessName}`,
    description: `Browse all products at ${s.businessName}, search by name or code, and order on WhatsApp.`, body: catalogBody,
  }), counter);

  // ---- basket ----
  write(path.join(distDir, 'basket', 'index.html'), layout({
    path: '/basket/', title: `Your basket | ${s.businessName}`, description: 'Review your basket, add your delivery address and payment method, and send your order on WhatsApp.',
    noindex: true, noFloat: true,
    body: `<div class="wrap" style="max-width:720px;padding-top:20px"><h1 style="margin-bottom:14px">Your basket</h1><div id="basket"></div></div>
<script type="application/json" id="pay-config">${JSON.stringify({ cod: s.codEnabled !== false, bkash: s.bkashNumber || '', bank: s.bankInfo || '' }).replace(/</g, '\\u003c')}</script>`,
  }), counter);

  // ---- product pages ----
  for (const p of visible) {
    const imgs = p.images.filter((i) => i && ok(i.full) && ok(i.thumb));
    const cat = p.category ? catBySlug.get(p.category) : null;
    const url = base ? `${base}/p/${enc(p.id)}/` : '';
    const pv = priceView(p);
    const greeting = !pv.shown
      ? (p.inStock ? 'Hello! What is the price of this product?' : 'Hello! What is the price, and is this product available?')
      : p.inStock ? s.waGreeting : 'Hello! Is this product available?';
    const lines = [greeting, '', `*${p.name}*`, `SKU: ${p.sku}`];
    if (pv.shown) lines.push(`Price: ${formatBDT(pv.now)}${pv.sale !== null ? ` (regular ${formatBDT(pv.price)})` : ''}`);
    if (url) lines.push(`Link: ${url}`);
    const waHref = waUrl(lines.join('\n'));
    const gallery = imgs.length
      ? `<div data-gallery><div class="gal-main"><img src="${imgUrl(imgs[0].full)}" alt="${esc(p.name)}" fetchpriority="high"></div>${imgs.length > 1 ? `<div class="gal-thumbs">${imgs.map((im, i) => `<button type="button" data-full="${imgUrl(im.full)}" aria-label="Photo ${i + 1}" aria-current="${i === 0}"><img src="${imgUrl(im.thumb)}" alt="" width="68" height="68" loading="lazy"></button>`).join('')}</div>` : ''}</div>`
      : '<div class="gal-main" style="cursor:default"><span class="noimg">No photo</span></div>';
    const priceBlock = !pv.shown
      ? '<div class="price price-ask">Price on request</div>'
      : pv.sale !== null
        ? `<div><div class="price"><span class="now">${formatBDT(pv.sale)}</span> <s>${formatBDT(pv.price)}</s>${pv.pct >= 1 ? ` <span class="off">${pv.pct}% OFF</span>` : ''}</div><div class="save">You save ${formatBDT(pv.price - pv.sale)}</div></div>`
        : `<div class="price">${formatBDT(pv.price)}</div>`;
    const related = visible.filter((r) => r.id !== p.id && p.category && r.category === p.category).slice(0, 8);
    const specs = visibleAttrs(cat, p);
    const body = `<div class="wrap" data-product>
<nav class="crumbs"><a href="/catalog/">Catalog</a>${cat ? ` / <a href="/catalog/?cat=${enc(cat.slug)}">${esc(cat.name)}</a>` : ''}</nav>
<div class="pdp">${gallery}<div class="info">
<div><h1>${esc(p.name)}</h1><div class="sku">SKU: ${esc(p.sku)}${cat ? ` · ${esc(cat.name)}` : ''}</div></div>
${priceBlock}
<div class="${p.inStock ? 'stock-ok' : 'stock-out'}">${p.inStock ? '✓ In stock' : 'Out of stock'}</div>
${p.inStock ? `<div class="buy"><div class="qty"><button type="button" data-qty-minus aria-label="Decrease">−</button><output data-qty-val>1</output><button type="button" data-qty-plus aria-label="Increase">+</button></div><button type="button" class="btn btn-outline" style="flex:1" data-add="${esc(p.id)}">${ICON.bag} Add to basket</button></div>` : ''}
<a class="btn btn-wa btn-block" href="${esc(waHref)}" target="_blank" rel="noopener">${ICON.chat} ${!pv.shown ? 'Ask price on WhatsApp' : p.inStock ? 'Order on WhatsApp' : 'Ask on WhatsApp'}</a>
${specs.length ? `<dl class="specs">${specs.map((a) => `<div><dt>${esc(a.label)}</dt><dd>${esc(a.value)}</dd></div>`).join('')}</dl>` : ''}
${p.description ? `<div class="desc"><h2>Description</h2><p>${esc(p.description)}</p></div>` : ''}
</div></div>
${related.length ? `<section class="section"><h2>You may also like</h2><div class="grid">${related.map(cardHtml).join('')}</div></section>` : ''}
</div>`;
    const first = imgs[0];
    const shareImg = first ? (first.share && ok(first.share) ? first.share : first.full) : null;
    const desc = (p.description || (pv.shown ? `${p.name} (SKU ${p.sku}) for ${formatBDT(pv.now)}. Order on WhatsApp.` : `${p.name} (SKU ${p.sku}). Ask the price on WhatsApp.`)).replace(/\s+/g, ' ').slice(0, 160);
    const ld = jsonLd({
      '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku,
      ...(first ? { image: [abs(imgUrl(first.full))] } : {}), description: desc,
      // No offer at all when the price is hidden, so search engines cannot publish it either.
      ...(pv.shown ? {
        offers: {
          '@type': 'Offer', priceCurrency: 'BDT', price: pv.now.toFixed(2),
          availability: p.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', ...(url ? { url } : {}),
        },
      } : {}),
    });
    write(path.join(distDir, 'p', p.id, 'index.html'), layout({
      path: `/p/${enc(p.id)}/`, title: pv.shown ? `${p.name} - ${formatBDT(pv.now)} | ${s.businessName}` : `${p.name} | ${s.businessName}`, description: desc,
      ogType: 'product', image: shareImg ? imgUrl(shareImg) : null, jsonld: ld, body, noFloat: true,
    }), counter);
  }

  // ---- 404, sitemap, robots, headers ----
  write(path.join(distDir, '404.html'), layout({
    path: '/404.html', title: `Page not found | ${s.businessName}`, description: 'Page not found.', noindex: true,
    body: '<div class="wrap notfound"><h1>Page not found</h1><p>The page you are looking for does not exist.</p><a class="btn btn-primary" href="/catalog/">Browse products</a></div>',
  }), counter);
  if (base) {
    const urls = [
      { loc: `${base}/` }, { loc: `${base}/catalog/` },
      ...visible.map((p) => ({ loc: `${base}/p/${enc(p.id)}/`, lastmod: p.updatedAt.slice(0, 10) })),
    ];
    write(path.join(distDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`, counter);
  }
  write(path.join(distDir, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /basket/\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ''}`, counter);
  write(path.join(distDir, '_headers'),
    `/img/*\n  Cache-Control: public, max-age=31536000, immutable\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/data/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n`, counter);

  const totalFiles = counter.files + imgCount;
  if (totalFiles > 20000) warnings.push(`The site has ${totalFiles} files. If you ever host it as static files on Cloudflare Pages, that limit is about 20,000 per site.`);

  prune(distDir, counter.written);

  return {
    published: visible.length,
    hidden: all.length - visible.length,
    priceHidden: visible.filter((p) => !priceView(p).shown).length,
    onSale: visible.filter((p) => priceView(p).sale != null).length,
    pages: visible.length + 4,
    images: imgCount,
    imageMB: Math.round((imgBytes / 1e6) * 10) / 10,
    files: totalFiles,
    warnings,
    ms: Date.now() - t0,
    distDir,
  };
}

module.exports = { build };
