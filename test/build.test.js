'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const { build } = require('../lib/build');
const { processPhoto } = require('../lib/images');
const { tmpDir, testImage } = require('./helpers');

const ASSETS = path.join(__dirname, '..', 'assets');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

async function fixture() {
  const store = new Store(tmpDir());
  store.updateSettings({ businessName: 'Rafid & Sons', whatsapp: '01712345678', siteUrl: 'shop.example', waGreeting: 'Hi! I want:', phone: '+880 1712-345678' });
  const saree = store.ensureCategory('Saree');
  store.ensureCategory('Empty Category');
  const a = store.addProduct({ sku: 'SR-1', name: 'Blue Saree', price: 1850, category: saree.slug, description: 'Soft\ncotton', featured: true });
  const b = store.addProduct({ sku: 'SR-2', name: '<script>alert(1)</script> Red', price: 1200.5, category: saree.slug, inStock: false });
  const c = store.addProduct({ sku: 'HID-1', name: 'Secret product', price: 10, visible: false });
  const d = store.addProduct({ sku: 'NP-1', name: 'No photo item', price: 5 });
  for (const [p, slot, color] of [[a, 1, { r: 0, g: 0, b: 255 }], [a, 2, { r: 0, g: 255, b: 0 }], [b, 1, { r: 255, g: 0, b: 0 }], [c, 1, { r: 9, g: 9, b: 9 }]]) {
    await store.setPhoto(p, slot, await processPhoto(await testImage({ width: 1200, height: 900, color }), { share: slot === 1 }));
  }
  return { store, a, b, c, d, dist: tmpDir('dist-') };
}

test('build: pages, privacy, escaping, share tags, sitemap', async () => {
  const { store, a, b, c, dist } = await fixture();
  const r = build(store, { distDir: dist, assetsDir: ASSETS });

  assert.equal(r.published, 3);
  assert.equal(r.hidden, 1);
  assert.ok(fs.existsSync(path.join(dist, 'index.html')));
  assert.ok(fs.existsSync(path.join(dist, 'catalog', 'index.html')));
  assert.ok(fs.existsSync(path.join(dist, 'basket', 'index.html')));
  assert.ok(fs.existsSync(path.join(dist, '404.html')));
  assert.ok(fs.existsSync(path.join(dist, 'p', a.id, 'index.html')));

  // hidden product is nowhere in the output
  assert.equal(fs.existsSync(path.join(dist, 'p', c.id)), false);
  const everything = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else if (!/\.(webp|jpg)$/.test(f)) everything.push(read(full)); } })(dist);
  assert.ok(!everything.some((t) => t.includes('Secret product') || t.includes('HID-1')), 'hidden product leaked');

  // XSS: product names are escaped everywhere they are written
  const pb = read(dist, 'p', b.id, 'index.html');
  assert.ok(!pb.includes('<script>alert(1)</script>'));
  assert.ok(pb.includes('&lt;script&gt;alert(1)&lt;/script&gt; Red'));
  assert.ok(!read(dist, 'index.html').includes('<script>alert(1)'));

  // product page: absolute share tags, product schema, WhatsApp link
  const pa = read(dist, 'p', a.id, 'index.html');
  assert.match(pa, /<meta property="og:url" content="https:\/\/shop\.example\/p\/sr-1\/">/);
  assert.match(pa, /<meta property="og:image" content="https:\/\/shop\.example\/img\/sr-1-1s\.[0-9a-f]{8}\.jpg">/);
  assert.match(pa, /<link rel="canonical" href="https:\/\/shop\.example\/p\/sr-1\/">/);
  assert.match(pa, /"priceCurrency":"BDT"/);
  assert.match(pa, /"availability":"https:\/\/schema\.org\/InStock"/);
  assert.match(pa, /<title>Blue Saree - ৳1,850 \| Rafid &amp; Sons<\/title>/);
  const wa = /href="(https:\/\/wa\.me\/[^"]+)"[^>]*>[^<]*<svg[^>]*>.*?<\/svg> Order on WhatsApp/s.exec(pa);
  assert.ok(wa, 'order button present');
  const url = new URL(wa[1].replace(/&amp;/g, '&'));
  assert.equal(url.pathname, '/8801712345678', 'local number converted to international');
  const msg = url.searchParams.get('text');
  assert.equal(msg, 'Hi! I want:\n\n*Blue Saree*\nSKU: SR-1\nPrice: ৳1,850\nLink: https://shop.example/p/sr-1/');
  assert.ok(pa.includes('data-gallery') && pa.includes('Photo 2'), 'two photos give a gallery');
  assert.ok(pa.includes('data-add="sr-1"'), 'add to basket for in-stock item');

  // out of stock: no add button, softer WhatsApp wording, schema says so
  assert.ok(!pb.includes('data-add='));
  assert.ok(pb.includes('Ask on WhatsApp') && pb.includes('Out of stock'));
  assert.match(pb, /OutOfStock/);

  // home: only categories that have published products; featured section
  const home = read(dist, 'index.html');
  assert.ok(home.includes('Saree') && !home.includes('Empty Category'));
  assert.ok(home.includes('Featured') && home.includes('New arrivals'));

  // catalog data file: only published products, short keys, cache-busted name
  const dataFile = fs.readdirSync(path.join(dist, 'data')).find((f) => /^products\.[0-9a-f]{8}\.json$/.test(f));
  assert.ok(dataFile);
  const data = JSON.parse(read(dist, 'data', dataFile));
  assert.equal(data.i.length, 3);
  assert.deepEqual(data.c, [{ s: 'saree', n: 'Saree' }]);
  assert.ok(read(dist, 'catalog', 'index.html').includes(`data-products="/data/${dataFile}"`));

  // sitemap, robots, cache headers
  const sm = read(dist, 'sitemap.xml');
  assert.ok(sm.includes('https://shop.example/p/sr-1/') && !sm.includes('hid-1'));
  assert.ok(read(dist, 'robots.txt').includes('Sitemap: https://shop.example/sitemap.xml'));
  assert.ok(read(dist, '_headers').includes('immutable'));

  // every image the pages reference exists in dist
  const refs = new Set();
  for (const t of everything) for (const m of t.matchAll(/\/img\/([^"'?\s*]+)/g)) refs.add(decodeURIComponent(m[1]));
  assert.ok(refs.size >= 4);
  for (const f of refs) assert.ok(fs.existsSync(path.join(dist, 'img', f)), `missing ${f}`);

  assert.ok(r.warnings.some((w) => /no photo/.test(w)), 'warns about NP-1');
  assert.ok(!r.warnings.some((w) => /WhatsApp number|Site URL/.test(w)), 'no false warnings');
});

test('build: rebuild removes stale files, keeps unchanged photos, handles hide/delete', async () => {
  const { store, a, b, dist } = await fixture();
  build(store, { distDir: dist, assetsDir: ASSETS });
  const before = fs.readdirSync(path.join(dist, 'img'));
  const mtime = fs.statSync(path.join(dist, 'img', a.images[0].full)).mtimeMs;

  store.updateProduct(b.id, { visible: false });
  store.deleteProduct(a.id);
  const r = build(store, { distDir: dist, assetsDir: ASSETS });
  assert.equal(r.published, 1);
  assert.equal(fs.existsSync(path.join(dist, 'p', a.id)), false);
  assert.equal(fs.existsSync(path.join(dist, 'p', b.id)), false);
  const after = fs.readdirSync(path.join(dist, 'img'));
  assert.ok(after.length < before.length, 'photos of removed products are gone from dist');
  assert.equal(after.length, 0);

  // rebuilding an unchanged store does not recopy photos
  const s2 = await fixture();
  build(s2.store, { distDir: s2.dist, assetsDir: ASSETS });
  const f = path.join(s2.dist, 'img', s2.a.images[0].full);
  fs.utimesSync(f, new Date(2000, 0, 1), new Date(2000, 0, 1));
  build(s2.store, { distDir: s2.dist, assetsDir: ASSETS });
  assert.equal(fs.statSync(f).mtime.getFullYear(), 2000, 'unchanged photo left alone');
  assert.ok(mtime > 0);
});

test('build: works with an empty store and with no settings filled in', () => {
  const store = new Store(tmpDir());
  const dist = tmpDir('dist-');
  const r = build(store, { distDir: dist, assetsDir: ASSETS });
  assert.equal(r.published, 0);
  assert.ok(r.warnings.some((w) => /WhatsApp number/.test(w)));
  assert.ok(r.warnings.some((w) => /Site URL/.test(w)));
  assert.ok(r.warnings.some((w) => /No published products/.test(w)));
  assert.ok(fs.existsSync(path.join(dist, 'index.html')));
  assert.equal(fs.existsSync(path.join(dist, 'sitemap.xml')), false, 'no sitemap without a site URL');
  assert.ok(!read(dist, 'index.html').includes('og:url'), 'no relative og:url');
});

test('build: Bangla names and SKUs produce working paths', async () => {
  const store = new Store(tmpDir());
  const p = store.addProduct({ sku: 'শাড়ি-১', name: 'নীল শাড়ি', price: 1500 });
  const dist = tmpDir('dist-');
  build(store, { distDir: dist, assetsDir: ASSETS });
  assert.ok(fs.existsSync(path.join(dist, 'p', p.id, 'index.html')));
  const home = read(dist, 'index.html');
  assert.ok(home.includes(`/p/${encodeURIComponent(p.id)}/`));
  assert.ok(home.includes('নীল শাড়ি'));
});
