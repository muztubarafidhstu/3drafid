'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { Store } = require('../lib/store');
const imp = require('../lib/importer');
const { processPhoto } = require('../lib/images');
const { tmpDir, testImage } = require('./helpers');

function xlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const mk = () => new Store(tmpDir());

test('CSV with Bangla text and no BOM is read as UTF-8', () => {
  const { headers, rows } = imp.parseSheet(Buffer.from('SKU,Name,Price\nA1,শাড়ি,"1,250"\n,,\nA2,Panjabi,900\n', 'utf8'));
  assert.deepEqual(headers, ['SKU', 'Name', 'Price']);
  assert.equal(rows.length, 2, 'blank row dropped');
  assert.equal(rows[0][1], 'শাড়ি');
});

test('autoMap finds common column names, English and Bangla', () => {
  const m = imp.autoMap(['Product Code', 'Product Name', 'Rate', 'Group', 'Photo', 'Photo2', 'In Stock', 'নাম']);
  assert.equal(m.sku, 0);
  assert.equal(m.name, 1);
  assert.equal(m.price, 2);
  assert.equal(m.category, 3);
  assert.equal(m.image1, 4);
  assert.equal(m.image2, 5);
  assert.equal(m.stock, 6);
  assert.equal(imp.autoMap(['কোড', 'নাম', 'দাম']).price, 2);
  assert.equal(imp.autoMap(['SKU', 'Shown']).visible, 1, '"Shown" column hides products marked no');
  assert.equal(imp.autoMap(['x']).sku, -1);
});

test('parseFlag understands yes/no style cells', () => {
  for (const v of ['yes', 'Y', 'TRUE', 1, 'In Stock', 'আছে', '5']) assert.equal(imp.parseFlag(v), true, String(v));
  for (const v of ['no', 'FALSE', 0, 'Out of stock', 'নেই', '0']) assert.equal(imp.parseFlag(v), false, String(v));
  assert.equal(imp.parseFlag(''), null);
  assert.equal(imp.parseFlag('maybe'), null);
});

test('import: creates, updates, never erases with blanks, reports problems', () => {
  const store = mk();
  const first = imp.parseSheet(xlsx([
    ['SKU', 'Name', 'Price', 'Category', 'Description', 'In stock'],
    ['A1', 'Saree', '৳1,850', 'Saree', 'Soft cotton', 'yes'],
    ['A2', 'Panjabi', 2400, 'Panjabi', '', 'no'],
    ['', 'No sku', 100, '', '', ''],
    ['A3', 'Bad price', 'abc', '', '', ''],
    ['A4', '', 50, '', '', ''],
    ['A5', 'No price', '', '', '', ''],
  ]));
  const map = imp.autoMap(first.headers);
  const dry = imp.analyze(store, first.rows, map);
  assert.deepEqual([dry.wouldCreate, dry.wouldUpdate, dry.errorRows], [2, 0, 4]);

  const r1 = imp.applyImport(store, first.rows, map);
  assert.deepEqual([r1.created, r1.updated, r1.skipped], [2, 0, 4]);
  assert.deepEqual(r1.newCategories.sort(), ['Panjabi', 'Saree']);
  assert.equal(store.findBySku('a1').price, 1850);
  assert.equal(store.findBySku('A2').inStock, false);
  assert.ok(r1.errors.some((e) => /Missing SKU/.test(e.message)));
  assert.ok(r1.errors.some((e) => /not a number/.test(e.message)));
  assert.ok(r1.errors.some((e) => /Missing name/.test(e.message)));
  assert.ok(r1.errors.some((e) => /Missing price/.test(e.message)));

  const second = imp.parseSheet(xlsx([
    ['SKU', 'Name', 'Price', 'Category', 'Description', 'In stock'],
    ['a1', '', 2000, '', '', ''],
    ['A9', 'New one', 10, 'Saree', 'x', ''],
    ['A9', 'New one v2', 12, '', '', ''],
  ]));
  const dry2 = imp.analyze(store, second.rows, imp.autoMap(second.headers));
  assert.deepEqual([dry2.wouldCreate, dry2.wouldUpdate, dry2.errorRows], [1, 2, 0], 'dry run predicts the real run');
  const r2 = imp.applyImport(store, second.rows, imp.autoMap(second.headers));
  assert.deepEqual([r2.created, r2.updated], [1, 2]);
  const a1 = store.findBySku('A1');
  assert.equal(a1.price, 2000, 'price updated');
  assert.equal(a1.name, 'Saree', 'blank name kept');
  assert.equal(a1.description, 'Soft cotton', 'blank description kept');
  assert.equal(a1.category, 'saree', 'blank category kept');
  assert.equal(a1.inStock, true, 'blank stock kept');
  assert.equal(store.findBySku('A9').name, 'New one v2');
  assert.equal(store.data.products.length, 3);
  assert.ok(r2.warnings.some((w) => /Duplicate SKU/.test(w.message)));
});

test('import: createCategories=false leaves unknown categories empty with a note', () => {
  const store = mk();
  const t = imp.parseSheet(xlsx([['SKU', 'Name', 'Price', 'Category'], ['Z1', 'Thing', 5, 'Nope']]));
  const r = imp.applyImport(store, t.rows, imp.autoMap(t.headers), { createCategories: false });
  assert.equal(store.findBySku('Z1').category, null);
  assert.equal(store.data.categories.length, 0);
  assert.ok(r.warnings.some((w) => /does not exist/.test(w.message)));
});

test('the sample template imports cleanly', () => {
  const store = mk();
  const t = imp.parseSheet(imp.templateBuffer());
  const r = imp.applyImport(store, t.rows, imp.autoMap(t.headers));
  assert.equal(r.skipped, 0);
  assert.equal(r.created, 8);
  assert.deepEqual(store.findBySku('FIL-PLA-BLK').imageNames, ['FIL-PLA-BLK.jpg', 'FIL-PLA-BLK-2.jpg']);
  const fil = store.findBySku('FIL-PLA-BLK');
  assert.deepEqual([fil.price, fil.salePrice, fil.showPrice], [1650, 1450, true]);
  const bed = store.findBySku('HB-235');
  assert.deepEqual([bed.price, bed.salePrice, bed.showPrice], [0, null, false], 'blank price is fine when "Show price" is no');
  assert.equal(store.findBySku('NOZ-BRS-04').salePrice, null);
  assert.equal(store.findBySku('LUB-PTFE').price, 450);
  assert.equal(store.findBySku('LUB-PTFE').inStock, false);
  // Colour / Material / Pack / Brand columns became filters of the right category automatically.
  const filament = store.findCategory('filament');
  assert.deepEqual(filament.filters.map((f) => f.label), ['Brand', 'Colour', 'Material', 'Pack']);
  assert.deepEqual(fil.attrs, { brand: 'Sunlu', colour: 'Black', material: 'PLA+', pack: 'Spool' });
  assert.equal(store.findBySku('FIL-PLA-BLK-R').attrs.pack, 'Refill');
  assert.deepEqual(store.findCategory('3d-printers').filters.map((f) => f.label), ['Brand', 'Technology', 'AMS', 'Version']);
  assert.deepEqual(store.findBySku('PRN-ENDER3').attrs, { brand: 'Creality', technology: 'FDM/FFF', ams: 'Without AMS', version: 'Global' });
  assert.equal(store.findBySku('PRN-SATURN4').attrs.technology, 'Resin');
  assert.equal(store.findBySku('PRN-A1-AMS').attrs.ams, 'With AMS');
  assert.deepEqual(store.findCategory('nozzles').filters.map((f) => f.label), ['Material']);
  assert.deepEqual(store.findCategory('heat-bed').filters, [], 'blank cells add no filters');
  assert.deepEqual(store.findCategory('lubricants').filters, []);
});

test('store: SKU rules, unique ids, category deletion, persistence', async () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const a = store.addProduct({ sku: 'A/1', name: 'One', price: 5 });
  const b = store.addProduct({ sku: 'A-1', name: 'Two', price: 6 });
  assert.notEqual(a.id, b.id, 'ids that slugify the same stay unique');
  assert.throws(() => store.addProduct({ sku: 'a/1', name: 'dupe', price: 1 }), /already exists/);
  assert.throws(() => store.updateProduct(b.id, { sku: 'A/1' }), /already exists/);
  assert.throws(() => store.updateProduct(b.id, { price: -1 }), /Price/);
  const cat = store.ensureCategory('Shoes');
  store.updateProduct(a.id, { category: cat.slug });
  store.deleteCategory(cat.slug);
  assert.equal(a.category, null);
  await store.save();
  const again = new Store(dir);
  assert.equal(again.data.products.length, 2);
  assert.equal(again.findBySku('a-1').name, 'Two');
  assert.equal(fs.existsSync(path.join(dir, 'store.json.tmp')), false);
});

test('store: replacing and deleting photos cleans up files', async () => {
  const store = mk();
  const p = store.addProduct({ sku: 'P1', name: 'P', price: 1 });
  const one = await processPhoto(await testImage({ color: { r: 255, g: 0, b: 0 } }), { share: true });
  const img1 = await store.setPhoto(p, 1, one);
  const files = () => fs.readdirSync(store.imgDir).sort();
  assert.equal(files().length, 3);
  const two = await processPhoto(await testImage({ color: { r: 0, g: 0, b: 255 } }), { share: true });
  const img2 = await store.setPhoto(p, 1, two);
  assert.notEqual(img1.full, img2.full);
  assert.equal(files().length, 3, 'old files removed');
  store.deleteProduct(p.id);
  assert.equal(files().length, 0);
});

test('photos: originals become small WebP, 1600px max, 400px square thumb', async () => {
  const big = await testImage({ width: 4000, height: 3000 });
  const out = await processPhoto(big, { share: true });
  const sharp = require('sharp');
  const f = await sharp(out.full).metadata();
  const t = await sharp(out.thumb).metadata();
  const s = await sharp(out.share).metadata();
  assert.equal(f.format, 'webp');
  assert.equal(Math.max(f.width, f.height), 1600);
  assert.deepEqual([t.width, t.height, t.format], [400, 400, 'webp']);
  assert.equal(s.format, 'jpeg');
  assert.ok(out.full.length < big.length / 3);
  const small = await processPhoto(await testImage({ width: 800, height: 600 }));
  assert.equal((await sharp(small.full).metadata()).width, 800, 'small photos are not enlarged');
});
