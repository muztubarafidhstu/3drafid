'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const imp = require('../lib/importer');
const { build } = require('../lib/build');
const { priceView, percentOff } = require('../lib/pricing');
const { tmpDir } = require('./helpers');

const ASSETS = path.join(__dirname, '..', 'assets');
const mk = () => new Store(tmpDir());

test('priceView: hidden, plain, discounted, invalid discount ignored', () => {
  assert.deepEqual(priceView({ price: 100, showPrice: false, salePrice: 50 }), { shown: false });
  assert.deepEqual(priceView({ price: 100 }), { shown: true, price: 100, sale: null, now: 100, pct: 0 }, 'old products without the field show their price');
  assert.deepEqual(priceView({ price: 1650, showPrice: true, salePrice: 1450 }), { shown: true, price: 1650, sale: 1450, now: 1450, pct: 12 });
  assert.equal(priceView({ price: 100, salePrice: 100 }).sale, null, 'discount must be lower than the price');
  assert.equal(priceView({ price: 100, salePrice: 120 }).sale, null);
  assert.equal(priceView({ price: 100, salePrice: 0 }).sale, null);
  assert.equal(percentOff(1000, 999), 0, 'rounded down, never over-claims');
  assert.equal(percentOff(200, 150), 25);
});

test('store: price is required unless the price switch is off; discount rules', () => {
  const store = mk();
  assert.throws(() => store.addProduct({ sku: 'A', name: 'A' }), /Enter a price/);
  assert.throws(() => store.addProduct({ sku: 'A', name: 'A', price: '' }), /Enter a price/);
  assert.throws(() => store.addProduct({ sku: 'A', name: 'A', price: 0 }), /Enter a price/);
  const hidden = store.addProduct({ sku: 'H', name: 'Hidden', showPrice: false });
  assert.deepEqual([hidden.price, hidden.showPrice, hidden.salePrice], [0, false, null]);
  assert.throws(() => store.addProduct({ sku: 'B', name: 'B', price: 100, salePrice: 100 }), /lower than the price/);
  assert.throws(() => store.addProduct({ sku: 'B', name: 'B', price: 100, salePrice: 'abc' }), /Discount price/);
  assert.throws(() => store.addProduct({ sku: 'B', name: 'B', showPrice: false, salePrice: 5 }), /Set the price first/);
  const ok = store.addProduct({ sku: 'C', name: 'C', price: 100, salePrice: '80' });
  assert.deepEqual([ok.price, ok.salePrice, ok.showPrice], [100, 80, true]);

  // turning the switch on needs a price
  assert.throws(() => store.updateProduct(hidden.id, { showPrice: true }), /Enter a price/);
  store.updateProduct(hidden.id, { showPrice: true, price: 50 });
  assert.equal(hidden.showPrice, true);
  // clearing the discount with a blank value
  store.updateProduct(ok.id, { salePrice: '' });
  assert.equal(ok.salePrice, null);
  // toggling off keeps the stored price and discount for when it is switched back on
  store.updateProduct(ok.id, { salePrice: 70 });
  store.updateProduct(ok.id, { showPrice: false });
  assert.deepEqual([ok.price, ok.salePrice, ok.showPrice], [100, 70, false]);
  store.updateProduct(ok.id, { showPrice: true });
  assert.deepEqual([ok.price, ok.salePrice, ok.showPrice], [100, 70, true]);
});

test('store: lowering the price below the discount removes the discount and says so; bad patches change nothing', () => {
  const store = mk();
  const p = store.addProduct({ sku: 'D', name: 'Original', price: 100, salePrice: 90 });
  const notes = [];
  store.updateProduct(p.id, { price: 80 }, notes);
  assert.equal(p.salePrice, null);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /discount/i);

  const q = store.addProduct({ sku: 'E', name: 'Keep me', price: 100, salePrice: 90 });
  assert.throws(() => store.updateProduct(q.id, { name: 'Changed', salePrice: 100 }), /lower than the price/);
  assert.equal(q.name, 'Keep me', 'a rejected edit leaves every field untouched');
  assert.throws(() => store.updateProduct(q.id, { name: 'Changed', price: -5 }), /Price/);
  assert.equal(q.name, 'Keep me');
  assert.deepEqual(store.stats().onSale, 1);
  store.updateProduct(q.id, { showPrice: false });
  assert.deepEqual([store.stats().onSale, store.stats().priceHidden], [0, 1]);
});

test('import: Sale price and Show price columns', () => {
  const m = imp.autoMap(['SKU', 'Name', 'Price', 'Sale price', 'Show price', 'Category']);
  assert.deepEqual([m.price, m.salePrice, m.showPrice], [2, 3, 4], '"Sale price" must not be taken as the price');
  assert.deepEqual(imp.autoMap(['Code', 'Name', 'Offer Price', 'MRP']).salePrice, 2);

  const store = mk();
  const run = (rows) => imp.applyImport(store, rows, m);
  const r1 = run([
    ['T-1', 'Tool one', 1650, 1450, 'yes', ''],
    ['T-2', 'Hidden bed', '', '', 'no', ''],
    ['T-3', 'Bad discount', 100, 150, 'yes', ''],
    ['T-4', 'No price, shown', '', '', 'yes', ''],
  ]);
  assert.deepEqual([r1.created, r1.skipped], [3, 1]);
  assert.match(r1.errors[0].message, /Missing price/);
  assert.deepEqual(r1.warnings.map((w) => w.sku), ['T-3']);
  assert.match(r1.warnings[0].message, /lower than the price/);
  assert.deepEqual([store.findBySku('T-1').salePrice, store.findBySku('T-1').showPrice], [1450, true]);
  assert.deepEqual([store.findBySku('T-2').showPrice, store.findBySku('T-2').price], [false, 0]);
  assert.equal(store.findBySku('T-3').salePrice, null, 'product is imported, the bad discount is ignored');

  // blank leaves things alone, 0 ends a discount, new lower price drops an old discount with a warning
  run([['T-1', '', '', '', '', '']]);
  assert.deepEqual([store.findBySku('T-1').price, store.findBySku('T-1').salePrice], [1650, 1450], 'blank cells never erase');
  run([['T-1', '', '', 0, '', '']]);
  assert.equal(store.findBySku('T-1').salePrice, null, 'a 0 discount removes it');
  run([['T-5', 'Five', 500, 400, 'yes', '']]);
  const r2 = run([['T-5', '', 300, '', '', '']]);
  assert.equal(store.findBySku('T-5').salePrice, null);
  assert.ok(r2.warnings.some((w) => /discount/i.test(w.message)), 'owner is told the old discount was removed');
  // switching the price on for a product that never had one is an error, not a silent 0
  const r3 = run([['T-2', '', '', '', 'yes', '']]);
  assert.equal(r3.skipped, 1);
  assert.equal(store.findBySku('T-2').showPrice, false);
  // Bangla amounts and words work too
  const r4 = run([['T-6', 'ছয়', '১,২৫০', '১,০০০', 'হ্যাঁ', '']]);
  assert.equal(r4.created, 1);
  assert.deepEqual([store.findBySku('T-6').price, store.findBySku('T-6').salePrice], [1250, 1000]);
});

test('build: hidden prices appear NOWHERE in the published files; discounts and basket data are right', () => {
  const store = mk();
  store.updateSettings({ businessName: 'Print Shop', whatsapp: '01712345678', siteUrl: 'https://printshop.example' });
  const fil = store.ensureCategory('Filament');
  // Distinct, searchable numbers: a hidden product's price/discount must never show up in any file.
  const secret = store.addProduct({ sku: 'SECRET-1', name: 'Heated bed', price: 7654.32, salePrice: 6543.21, showPrice: false, category: fil.slug });
  const plain = store.addProduct({ sku: 'PLAIN-1', name: 'Plain nozzle', price: 1111, category: fil.slug });
  const sale = store.addProduct({ sku: 'SALE-1', name: 'PLA filament', price: 2000, salePrice: 1500, category: fil.slug, featured: true });
  const dist = tmpDir('dist-');
  const r = build(store, { distDir: dist, assetsDir: ASSETS });
  assert.deepEqual([r.published, r.priceHidden, r.onSale], [3, 1, 1]);

  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else if (!/\.(webp|jpg)$/.test(f)) files.push([full, fs.readFileSync(full, 'utf8')]); } })(dist);
  assert.ok(files.length > 8 && files.some(([, t]) => t.includes('৳1,111')), 'sanity: the scan reads the files and finds shown prices');
  for (const needle of ['7654', '7,654', '6543', '6,543', '765432', '654321']) {
    const leak = files.find(([, t]) => t.includes(needle));
    assert.ok(!leak, `hidden price "${needle}" leaked into ${leak && leak[0]}`);
  }

  const page = fs.readFileSync(path.join(dist, 'p', secret.id, 'index.html'), 'utf8');
  assert.ok(page.includes('Ask price on WhatsApp') && page.includes('Price on request'));
  assert.ok(!/application\/ld\+json[^<]*"offers"/.test(page) && !page.includes('"offers"'), 'no price offer in search-engine data');
  assert.ok(!/<title>[^<]*৳/.test(page), 'no price in the page title');
  const waLink = decodeURIComponent(page.match(/https:\/\/wa\.me\/[^"]+/)[0]);
  assert.match(waLink, /What is the price of this product\?/);
  assert.ok(!waLink.includes('Price:'), 'the WhatsApp message does not carry a price');

  // catalog data: no price keys for the hidden product, discount key only for the discounted one
  const dataFile = fs.readdirSync(path.join(dist, 'data')).find((f) => /^products\..+\.json$/.test(f));
  const data = JSON.parse(fs.readFileSync(path.join(dist, 'data', dataFile), 'utf8'));
  const by = Object.fromEntries(data.i.map((x) => [x.s, x]));
  assert.ok(!('p' in by['SECRET-1']) && !('d' in by['SECRET-1']));
  assert.deepEqual([by['PLAIN-1'].p, 'd' in by['PLAIN-1']], [1111, false]);
  assert.deepEqual([by['SALE-1'].p, by['SALE-1'].d], [2000, 1500]);

  // product page for a discounted product, and its search-engine price is what the customer pays
  const sp = fs.readFileSync(path.join(dist, 'p', sale.id, 'index.html'), 'utf8');
  assert.ok(sp.includes('25% OFF') && sp.includes('<s>৳2,000</s>') && sp.includes('৳1,500') && sp.includes('You save ৳500'));
  assert.ok(sp.includes('"price":"1500.00"'), 'JSON-LD uses the discounted price');
  assert.match(decodeURIComponent(sp.match(/https:\/\/wa\.me\/[^"]+/)[0]), /Price: ৳1,500 \(regular ৳2,000\)/);

  // home page cards (server side) show all three kinds
  const home = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(home.includes('card-price'), 'home has product cards');
});
