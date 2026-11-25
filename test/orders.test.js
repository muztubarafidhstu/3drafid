'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const orders = require('../lib/orders');
const imp = require('../lib/importer');
const { build } = require('../lib/build');
const { createApp } = require('../server');
const { tmpDir, freePort } = require('./helpers');

function shop() {
  const store = new Store(tmpDir());
  const fil = store.ensureCategory('Filament');
  store.addProduct({ sku: 'FIL-BLK', name: 'PLA+ Black 1kg', price: 1650, salePrice: 1450, cost: 1100, stockQty: 10, category: fil.slug });
  store.addProduct({ sku: 'NOZ-04', name: 'Brass Nozzle 0.4', price: 120, cost: 60, stockQty: 3 });
  store.addProduct({ sku: 'PRN-E3', name: 'Ender 3', price: 25000, showPrice: false, cost: 21000, stockQty: 2 });
  store.addProduct({ sku: 'LUB-1', name: 'Lubricant', price: 450 }); // no cost, stock not tracked
  return store;
}

test('product: buying cost and stock quantity are optional and validated', () => {
  const store = shop();
  const lub = store.findBySku('LUB-1');
  assert.equal(lub.cost, null);
  assert.equal(lub.stockQty, null);
  assert.equal(lub.inStock, true, 'not tracked: the switch decides');
  assert.throws(() => store.updateProduct(lub.id, { cost: -5 }), /Buying cost/);
  assert.throws(() => store.updateProduct(lub.id, { stockQty: 2.5 }), /whole number/);
  assert.throws(() => store.updateProduct(lub.id, { stockQty: -1 }), /whole number/);
  store.updateProduct(lub.id, { cost: '250.5', stockQty: '0' });
  assert.equal(lub.cost, 250.5);
  assert.equal(lub.stockQty, 0);
  assert.equal(lub.inStock, false, 'quantity 0 means out of stock');
  store.updateProduct(lub.id, { stockQty: 7 });
  assert.equal(lub.inStock, true);
  store.updateProduct(lub.id, { stockQty: '' });
  assert.equal(lub.stockQty, null, 'blank stops tracking');
  const notes = [];
  store.updateProduct(lub.id, { stockQty: 4 });
  store.updateProduct(lub.id, { inStock: false }, notes);
  assert.equal(lub.stockQty, 0, 'out-of-stock switch on a tracked product sets the quantity to 0');
  store.updateProduct(lub.id, { inStock: true }, notes);
  assert.equal(lub.inStock, false);
  assert.ok(notes.some((n) => /quantity of 0/.test(n)));
});

test('order: starts pending, takes prices and costs from the product, and does not touch stock', () => {
  const store = shop();
  const o = orders.createOrder(store, {
    customer: { name: 'Karim', phone: '01711000000' },
    items: [{ sku: 'FIL-BLK', qty: 2 }, { sku: 'PRN-E3', qty: 1 }, { sku: 'fil-blk', qty: 1 }],
  });
  assert.equal(o.status, 'pending');
  assert.equal(o.no, 1001);
  assert.equal(o.items.length, 2, 'two lines for the same product are merged');
  const fil = o.items.find((l) => l.sku === 'FIL-BLK');
  assert.equal(fil.qty, 3);
  assert.equal(fil.price, 1450, 'the discount price is used');
  assert.equal(fil.cost, 1100);
  assert.equal(o.items.find((l) => l.sku === 'PRN-E3').price, 25000, 'a hidden-price product still gets the owner\'s stored price');
  assert.equal(store.findBySku('FIL-BLK').stockQty, 10, 'pending: stock unchanged');
  assert.equal(orders.createOrder(store, { items: [{ sku: 'NOZ-04', qty: 1 }] }).no, 1002);
  assert.throws(() => orders.createOrder(store, { items: [] }), /at least one/);
  assert.throws(() => orders.createOrder(store, { items: [{ sku: 'NOPE', qty: 1 }] }), /not found/);
  assert.throws(() => orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 0 }] }), /whole number/);
  assert.throws(() => orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 1, price: -3 }] }), /Price/);
});

test('order: can be corrected while pending, then approval takes the stock', () => {
  const store = shop();
  const o = orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 4 }, { sku: 'NOZ-04', qty: 2 }] });
  orders.updateOrder(store, o.id, { items: [{ productId: 'fil-blk', qty: 3, price: 1500 }, { productId: 'noz-04', qty: 2, price: 100, cost: '' }], discount: 100, note: 'Dhanmondi' });
  assert.equal(o.items[0].price, 1500);
  assert.equal(o.items[1].cost, null, 'a blank cost on a line means "not known"');
  const { shortages } = orders.approveOrder(store, o.id);
  assert.deepEqual(shortages, []);
  assert.equal(o.status, 'approved');
  assert.ok(o.approvedAt);
  assert.equal(store.findBySku('FIL-BLK').stockQty, 7);
  assert.equal(store.findBySku('NOZ-04').stockQty, 1);
  assert.equal(o.items[1].cost, 60, 'an empty cost is filled from the product at approval');
  assert.throws(() => orders.updateOrder(store, o.id, { note: 'x' }), /Only a pending order/);
  assert.throws(() => orders.approveOrder(store, o.id), /already approved/);
  assert.throws(() => orders.deleteOrder(store, o.id), /approved order cannot be deleted/);
});

test('approve: not enough stock stops with the list; allowShort takes what is there; cancel puts it back', () => {
  const store = shop();
  const o = orders.createOrder(store, { items: [{ sku: 'PRN-E3', qty: 5 }, { sku: 'FIL-BLK', qty: 1 }, { sku: 'LUB-1', qty: 2 }] });
  let err;
  try { orders.approveOrder(store, o.id); } catch (e) { err = e; }
  assert.equal(err.status, 409);
  assert.deepEqual(err.shortages, [{ sku: 'PRN-E3', name: 'Ender 3', have: 2, need: 5 }]);
  assert.equal(o.status, 'pending');
  assert.equal(store.findBySku('PRN-E3').stockQty, 2, 'a refused approval changes nothing');
  assert.equal(store.findBySku('FIL-BLK').stockQty, 10);
  orders.approveOrder(store, o.id, { allowShort: true });
  const prn = store.findBySku('PRN-E3');
  assert.equal(prn.stockQty, 0);
  assert.equal(prn.inStock, false, 'reaching 0 switches the product to out of stock on the site');
  assert.equal(store.findBySku('FIL-BLK').stockQty, 9);
  assert.equal(store.findBySku('LUB-1').stockQty, null, 'untracked products are left alone');
  const { restored } = orders.cancelOrder(store, o.id);
  assert.equal(restored, 3, 'only what was really taken goes back (2 printers + 1 filament)');
  assert.equal(prn.stockQty, 2);
  assert.equal(prn.inStock, true);
  assert.equal(store.findBySku('FIL-BLK').stockQty, 10);
  assert.equal(o.status, 'cancelled');
  assert.throws(() => orders.cancelOrder(store, o.id), /already cancelled/);
  orders.deleteOrder(store, o.id);
  assert.equal(store.data.orders.length, 0);
});

test('approve: a line without a price, or a deleted product, is refused', () => {
  const store = shop();
  const o = orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 1, price: '' }] });
  assert.throws(() => orders.approveOrder(store, o.id), /Enter a price/);
  orders.updateOrder(store, o.id, { items: [{ productId: 'fil-blk', qty: 1, price: 1400 }] });
  store.deleteProduct('fil-blk');
  assert.throws(() => orders.approveOrder(store, o.id), /no longer in your product list/);
  assert.equal(orders.present(store, o).items[0].missing, true);
});

test('cancelling a pending order leaves stock alone; cancelling after the product stopped being tracked is safe', () => {
  const store = shop();
  const a = orders.createOrder(store, { items: [{ sku: 'NOZ-04', qty: 2 }] });
  orders.cancelOrder(store, a.id);
  assert.equal(store.findBySku('NOZ-04').stockQty, 3);
  const b = orders.createOrder(store, { items: [{ sku: 'NOZ-04', qty: 2 }] });
  orders.approveOrder(store, b.id);
  store.updateProduct('noz-04', { stockQty: '' });
  orders.cancelOrder(store, b.id);
  assert.equal(store.findBySku('NOZ-04').stockQty, null);
});

test('totals: discount is shared across lines and profit only counts lines with a buying cost', () => {
  const store = shop();
  const o = orders.createOrder(store, {
    items: [{ sku: 'FIL-BLK', qty: 2, price: 1500, cost: 1000 }, { sku: 'LUB-1', qty: 1, price: 500, cost: '' }],
    discount: 150, deliveryFee: 100,
  });
  const t = orders.totals(o);
  assert.equal(t.subtotal, 3500);
  assert.equal(t.net, 3350);
  assert.equal(t.total, 3450, 'delivery is part of what the customer pays');
  // factor 3350/3500; lubricant line (no cost) = 500 * factor = 478.57 is not profit
  assert.equal(t.unknownLines, 1);
  assert.equal(t.unknownNet, 478.57);
  assert.equal(t.cost, 2000);
  assert.equal(t.knownNet, 2871.43);
  assert.equal(t.profit, 871.43, 'delivery fee is not profit');
  assert.throws(() => orders.updateOrder(store, o.id, { discount: 9999 }), /cannot be more/);
});

test('parse: reads the message the shop basket writes, and tolerates edits', () => {
  const store = shop();
  const msg = [
    "Hello! I'd like to order:", '',
    '1. PLA+ Black 1kg (SKU: FIL-BLK)', '   ২ × ৳1,450 = ৳2,900 (regular ৳1,650)', '   https://shop.example/p/fil-blk/',
    '2. Brass Nozzle 0.4 (SKU: NOZ-04)', '   1 × ৳120 = ৳120', '   https://shop.example/p/noz-04/',
    '3. Mystery item (SKU: ZZZ-9)', '   1 × (price on request)',
    '4. Ender 3 (SKU: prn-e3)', '   3 x (price on request)',
    '', '*Total: ৳3,020*', '', 'Name: Rahim Uddin', 'Phone: 01811222333', 'Delivery address: House 5, Road 3, Mirpur', 'Address:',
  ].join('\r\n');
  const r = orders.parseOrderText(store, msg);
  assert.deepEqual(r.items, [{ sku: 'FIL-BLK', qty: 2 }, { sku: 'NOZ-04', qty: 1 }, { sku: 'prn-e3', qty: 3 }]);
  assert.deepEqual(r.unmatched.map((u) => u.sku), ['ZZZ-9']);
  assert.deepEqual(r.customer, { name: 'Rahim Uddin', phone: '01811222333', address: 'House 5, Road 3, Mirpur' });
  assert.throws(() => orders.parseOrderText(store, 'hello there'), /No products found/);
  const o = orders.createOrder(store, { source: 'whatsapp', customer: r.customer, items: r.items });
  assert.equal(o.source, 'whatsapp');
  assert.equal(o.items.find((l) => l.sku === 'PRN-E3').qty, 3, 'SKU match ignores letter case and keeps the product\'s own code');
});

function approvedAt(store, o, iso) {
  orders.approveOrder(store, o.id, { allowShort: true });
  o.approvedAt = iso;
}

test('summary: totals, margin, days in the owner\'s time zone, best sellers, low stock, stock value', () => {
  const store = shop();
  const cat = store.findCategory('filament');
  const o1 = orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 2, price: 1500 }, { sku: 'NOZ-04', qty: 5, price: 100 }] });
  const o2 = orders.createOrder(store, { items: [{ sku: 'LUB-1', qty: 1, price: 500 }] });
  const o3 = orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 1 }] });
  const pending = orders.createOrder(store, { items: [{ sku: 'FIL-BLK', qty: 1, price: 1000 }] });
  approvedAt(store, o1, '2026-11-24T19:00:00.000Z'); // 25 Nov 01:00 in Bangladesh
  approvedAt(store, o2, '2026-11-25T05:00:00.000Z');
  approvedAt(store, o3, '2026-10-01T05:00:00.000Z'); // outside the range
  const s = orders.summarize(store, { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', tzOffset: -360 });
  assert.equal(s.totals.orders, 2);
  assert.equal(s.totals.items, 8);
  assert.equal(s.totals.revenue, 3000 + 500 + 500);
  // profit: FIL 2*(1500-1100)=800, nozzle 5*(100-60)=200; lubricant has no cost so it is left out
  assert.equal(s.totals.cost, 2200 + 300);
  assert.equal(s.totals.profit, 1000);
  assert.equal(s.totals.unknownNet, 500);
  assert.equal(s.totals.unknownLines, 1);
  assert.equal(s.totals.margin, Math.round((1000 / 3500) * 1000) / 10);
  assert.deepEqual(s.days.map((d) => [d.date, d.orders]), [['2026-11-25', 2]], 'both orders fall on 25 Nov in Bangladesh time');
  const utcDays = orders.summarize(store, { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', tzOffset: 0 }).days.map((d) => d.date);
  assert.deepEqual(utcDays, ['2026-11-24', '2026-11-25']);
  assert.equal(s.topProducts[0].sku, 'FIL-BLK');
  assert.equal(s.byCategory.find((c) => c.slug === cat.slug).revenue, 3000);
  assert.deepEqual(s.pending, { count: 1, value: 1000 });
  assert.ok(s.lowStock.some((p) => p.sku === 'NOZ-04'), 'nozzle: 3 - 5 clamps to 0, so it is low');
  assert.ok(s.lowStock.every((p) => p.stockQty <= 3));
  assert.equal(orders.summarize(store, {}).totals.orders, 3, 'no range = all time');
  assert.equal(orders.summarize(store, { from: '2030-01-01T00:00:00Z' }).totals.orders, 0);
  assert.equal(pending.status, 'pending');
  assert.equal(s.stock.tracked, 3);
  assert.equal(s.productsWithoutCost, 1);
});

test('csv: one line per product, formulas defused, phone numbers kept', () => {
  const store = shop();
  const o = orders.createOrder(store, { customer: { name: '=HYPERLINK("x")', phone: '+8801711000000' }, items: [{ sku: 'FIL-BLK', qty: 1 }, { sku: 'NOZ-04', qty: 2 }] });
  orders.approveOrder(store, o.id);
  const csv = orders.ordersCsv(store, {});
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('Order,Status,Date'));
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`), lines[1]);
  assert.ok(lines[1].includes(',+8801711000000,'), 'a plain phone number is not altered');
  assert.equal(orders.ordersCsv(store, { status: 'pending' }).trim().split('\r\n').length, 1);
});

test('import: Buying cost and Stock qty columns; a Stock column of numbers becomes the quantity', () => {
  const store = new Store(tmpDir());
  const headers = ['SKU', 'Name', 'Price', 'Buying cost', 'Stock qty'];
  assert.equal(imp.autoMap(headers).cost, 3);
  assert.equal(imp.autoMap(headers).qty, 4);
  const rows = [['A1', 'One', 100, '60', 12], ['A2', 'Two', 200, 'x', '0'], ['A3', 'Three', 50, '', 'many']];
  const mapping = imp.autoMap(headers);
  const rep = imp.applyImport(store, rows, mapping);
  assert.equal(rep.created, 3);
  assert.equal(store.findBySku('A1').cost, 60);
  assert.equal(store.findBySku('A1').stockQty, 12);
  assert.equal(store.findBySku('A2').cost, null, 'bad cost ignored');
  assert.equal(store.findBySku('A2').stockQty, 0);
  assert.equal(store.findBySku('A2').inStock, false);
  assert.equal(store.findBySku('A3').stockQty, null, 'bad quantity ignored');
  assert.equal(rep.warnings.length, 2);
  // blank cells never erase
  imp.applyImport(store, [['A1', '', '', '', '']], mapping);
  assert.equal(store.findBySku('A1').cost, 60);
  assert.equal(store.findBySku('A1').stockQty, 12);
  // "Stock" holding quantities
  const m2 = imp.autoMap(['SKU', 'Name', 'Price', 'Stock'], [['B1', 'b', 1, 25], ['B2', 'c', 1, 0]]);
  assert.equal(m2.qty, 3);
  assert.equal(m2.stock, -1);
  const m3 = imp.autoMap(['SKU', 'Name', 'Price', 'Stock'], [['B1', 'b', 1, 'yes'], ['B2', 'c', 1, 'no']]);
  assert.equal(m3.stock, 3);
  assert.equal(m3.qty, -1);
});

test('privacy: buying cost and stock quantity never reach the published site', () => {
  const store = new Store(tmpDir());
  store.addProduct({ sku: 'SECRET-1', name: 'Costly thing', price: 9000, cost: 31337, stockQty: 4242 });
  store.addProduct({ sku: 'SECRET-2', name: 'Hidden price thing', price: 8123, showPrice: false, cost: 7777.5, stockQty: 5151 });
  const o = orders.createOrder(store, { customer: { name: 'Private Person', phone: '01999888777' }, items: [{ sku: 'SECRET-1', qty: 1 }] });
  orders.approveOrder(store, o.id);
  const dist = tmpDir('dist-');
  build(store, { distDir: dist, assetsDir: path.join(__dirname, '..', 'assets') });
  const hits = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (!/\.(webp|jpg|png)$/.test(n)) {
        const text = fs.readFileSync(f, 'utf8');
        for (const needle of ['31337', '7777', '4242', '5151', '8123', 'Private Person', '01999888777']) if (text.includes(needle)) hits.push(`${n}: ${needle}`);
      }
    }
  })(dist);
  assert.deepEqual(hits, []);
  assert.ok(fs.readFileSync(path.join(dist, 'p', 'secret-1', 'index.html'), 'utf8').includes('9,000'), 'the shown price is there');
});

test('privacy: a product whose quantity reached 0 is shown as out of stock', () => {
  const store = new Store(tmpDir());
  store.addProduct({ sku: 'LAST-1', name: 'Last one', price: 500, stockQty: 1 });
  const o = orders.createOrder(store, { items: [{ sku: 'LAST-1', qty: 1 }] });
  orders.approveOrder(store, o.id);
  const dist = tmpDir('dist-');
  build(store, { distDir: dist, assetsDir: path.join(__dirname, '..', 'assets') });
  const page = fs.readFileSync(path.join(dist, 'p', 'last-1', 'index.html'), 'utf8');
  assert.ok(page.includes('Out of stock'));
  assert.ok(!page.includes('data-add="last-1"'));
});

test('the orders are saved with the store and survive a restart', async () => {
  const dir = tmpDir();
  const a = new Store(dir);
  a.addProduct({ sku: 'K-1', name: 'Keep', price: 10, stockQty: 5 });
  const o = orders.createOrder(a, { items: [{ sku: 'K-1', qty: 2 }] });
  orders.approveOrder(a, o.id);
  await a.save();
  const b = new Store(dir);
  assert.equal(b.data.orders.length, 1);
  assert.equal(b.data.orders[0].status, 'approved');
  assert.equal(b.findBySku('K-1').stockQty, 3);
  assert.equal(orders.createOrder(b, { items: [{ sku: 'K-1', qty: 1 }] }).no, 1002, 'numbers carry on');
  const old = new Store(tmpDir());
  old.data.products.push({ id: 'legacy', sku: 'LEG', name: 'Legacy', price: 5, inStock: true, images: [null, null], imageNames: [null, null], attrs: {}, createdAt: '', updatedAt: '' });
  fs.writeFileSync(old.file, JSON.stringify(old.data));
  const reread = new Store(old.dir);
  assert.equal(reread.findBySku('LEG').cost, null, 'stores from before this feature load fine');
  assert.equal(reread.findBySku('LEG').stockQty, null);
  assert.deepEqual(reread.data.orders, []);
});

test('API: the whole flow over HTTP, including the 409 and the CSV', async () => {
  const port = await freePort();
  const app = createApp({ dataDir: tmpDir(), distDir: tmpDir('dist-'), port, previewPort: port + 1 });
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${port}`;
  const call = (method, url, body) => fetch(base + url, { method, headers: { 'X-Admin': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call('POST', '/api/products', { sku: 'F-1', name: 'Filament', price: 1000, cost: 700, stockQty: 3 })).status, 200);
    assert.equal((await call('POST', '/api/products', { sku: 'F-2', name: 'Bad', price: 1000, cost: -1 })).status, 400);
    const text = "Hello! I'd like to order:\n\n1. Filament (SKU: F-1)\n   2 × ৳1,000 = ৳2,000\nName: Sumon";
    const made = await (await call('POST', '/api/orders/from-text', { text })).json();
    assert.equal(made.order.status, 'pending');
    assert.equal(made.order.customer.name, 'Sumon');
    assert.equal(made.order.totals.profit, 600);
    assert.equal((await call('POST', '/api/orders/from-text', { text: 'nothing useful' })).status, 400);
    assert.equal((await call('POST', '/api/orders/from-text', { text: '1. X (SKU: NOPE)' })).status, 400);
    const id = made.order.id;
    // edit to 5 (more than the 3 in stock): approval is refused with a 409 and the list
    const edited = await (await call('PUT', '/api/orders/' + id, { items: [{ productId: 'f-1', qty: 5, price: 1000, cost: 700 }] })).json();
    assert.equal(edited.items[0].stockQty, 3);
    const refused = await call('POST', `/api/orders/${id}/approve`, {});
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.deepEqual(body.shortages, [{ sku: 'F-1', name: 'Filament', have: 3, need: 5 }]);
    assert.equal((await (await call('GET', '/api/state')).json()).stats.pendingOrders, 1);
    await call('PUT', '/api/orders/' + id, { items: [{ productId: 'f-1', qty: 2, price: 1000, cost: 700 }] });
    const ok = await (await call('POST', `/api/orders/${id}/approve`, {})).json();
    assert.equal(ok.order.status, 'approved');
    const prod = await (await call('GET', '/api/products?q=F-1')).json();
    assert.equal(prod.items[0].stockQty, 1);
    assert.equal((await call('PUT', '/api/orders/' + id, { note: 'late' })).status, 400);
    assert.equal((await call('DELETE', '/api/orders/' + id)).status, 400);
    const sum = await (await call('GET', '/api/summary?tz=-360')).json();
    assert.equal(sum.totals.profit, 600);
    assert.equal(sum.totals.orders, 1);
    const csvBytes = Buffer.from(await (await call('GET', '/api/orders.csv')).arrayBuffer());
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM so Excel reads Bangla names correctly');
    assert.ok(csvBytes.toString('utf8').includes('F-1'));
    const list = await (await call('GET', '/api/orders?status=approved')).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.counts.approved, 1);
    assert.equal((await call('POST', `/api/orders/${id}/cancel`)).status, 200);
    assert.equal((await (await call('GET', '/api/products?q=F-1')).json()).items[0].stockQty, 3, 'cancelling put the stock back');
    assert.equal((await call('GET', '/api/orders/nope')).status, 404);
    assert.equal((await call('DELETE', '/api/orders/' + id)).status, 200);
    assert.equal((await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'orders need the admin header like everything else');
  } finally {
    server.close();
  }
});
