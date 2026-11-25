'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Store } = require('../lib/store');
const orders = require('../lib/orders');
const { build } = require('../lib/build');
const { buildModel, renderInvoice } = require('../lib/invoice');
const { createApp } = require('../server');
const { tmpDir, freePort } = require('./helpers');

function shop() {
  const store = new Store(tmpDir());
  store.addProduct({ sku: 'FIL-BLK', name: 'PLA+ Black 1kg', price: 1650, cost: 1100, stockQty: 10 });
  store.addProduct({ sku: 'NOZ-04', name: 'Brass Nozzle 0.4', price: 120, cost: 60, stockQty: 3 });
  return store;
}
const mk = (store, extra = {}) => orders.createOrder(store, { customer: { name: 'Rahim', phone: '01811222333', address: 'House 5, Road 3, Mirpur' }, items: [{ sku: 'FIL-BLK', qty: 2 }], deliveryFee: 100, ...extra });

test('parse: reads Payment and transaction lines from the basket message', () => {
  const store = shop();
  const base = ['Hello!', '', '1. PLA+ Black 1kg (SKU: FIL-BLK)', '   2 × ৳1,650 = ৳3,300', '', 'Name: Rahim', 'Phone: 01811222333', 'Delivery address: House 5, Road 3'];
  let r = orders.parseOrderText(store, [...base, 'Payment: bKash (TrxID: 9K3L2M1N0P)'].join('\n'));
  assert.equal(r.payMethod, 'bkash');
  assert.equal(r.trxId, '9K3L2M1N0P');
  r = orders.parseOrderText(store, [...base, 'Payment: Cash on delivery'].join('\n'));
  assert.equal(r.payMethod, 'cod');
  assert.equal(r.trxId, '');
  r = orders.parseOrderText(store, [...base, 'Payment: Bank transfer (Ref: ABC12345)'].join('\n'));
  assert.equal(r.payMethod, 'bank');
  assert.equal(r.trxId, 'ABC12345');
  r = orders.parseOrderText(store, base.join('\n'));
  assert.equal(r.payMethod, '', 'no payment line means not chosen');
  assert.equal(r.customer.address, 'House 5, Road 3');
  const o = orders.createOrder(store, { source: 'whatsapp', customer: r.customer, items: r.items, payMethod: 'bkash', trxId: '9K3L2M1N0P' });
  assert.equal(o.payMethod, 'bkash');
  assert.equal(o.trxId, '9K3L2M1N0P');
});

test('payment: paid and due follow the total, also after approval; cancelled orders refuse it', () => {
  const store = shop();
  const o = mk(store);
  let t = orders.totals(o);
  assert.equal(t.total, 3400);
  assert.equal(t.paid, 0);
  assert.equal(t.due, 3400);
  orders.setPayment(store, o.id, { payMethod: 'bkash', paid: 1000, trxId: 'TX123456' });
  t = orders.totals(orders.findOrder(store, o.id));
  assert.equal(t.paid, 1000);
  assert.equal(t.due, 2400);
  orders.approveOrder(store, o.id, {});
  orders.setPayment(store, o.id, { paid: 3400 });
  const approved = orders.findOrder(store, o.id);
  assert.equal(approved.status, 'approved');
  assert.equal(orders.totals(approved).due, 0);
  assert.equal(approved.payMethod, 'bkash', 'a payment update that does not mention the method keeps it');
  assert.equal(approved.trxId, 'TX123456');
  orders.setPayment(store, o.id, { paid: 9999 });
  assert.equal(orders.totals(orders.findOrder(store, o.id)).due, 0, 'overpaying never shows a negative due');
  assert.throws(() => orders.setPayment(store, o.id, { paid: -5 }), /Amount paid/);
  assert.equal(orders.payMethodOf('Cash on delivery'), 'cod');
  assert.equal(orders.payMethodOf('বিকাশ'), 'bkash');
  assert.equal(orders.payMethodOf('nonsense'), '');
  orders.cancelOrder(store, o.id);
  assert.throws(() => orders.setPayment(store, o.id, { paid: 1 }), /cancelled/);
});

test('settings: bKash number, bank details and the cash-on-delivery switch reach the basket page, and nothing private does', async () => {
  const store = shop();
  store.updateSettings({ bkashNumber: '01712-345678 (personal)', bankInfo: 'DBBL Mirpur\nA/C 123.456 </script><b>x', codEnabled: false });
  const distDir = tmpDir('dist-');
  await build(store, { distDir, assetsDir: path.join(__dirname, '..', 'assets'), siteUrl: 'https://shop.test' });
  const html = fs.readFileSync(path.join(distDir, 'basket', 'index.html'), 'utf8');
  const m = html.match(/<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/);
  assert.ok(m, 'pay-config is on the basket page');
  const cfg = JSON.parse(m[1]);
  assert.deepEqual(cfg, { cod: false, bkash: '01712-345678 (personal)', bank: 'DBBL Mirpur\nA/C 123.456 </script><b>x' });
  assert.ok(!html.includes('</script><b>x'), 'a closing script tag in the bank text cannot break out of the page');
  // the invoice stamp and the buying cost are never published
  assert.ok(!html.includes('1100'));
});

test('invoice: shows paid and due, the chosen method, and the payment details only while something is due', async () => {
  const store = shop();
  store.updateSettings({ businessName: 'Layer Lab', bkashNumber: '01712345678', bankInfo: 'DBBL 123', facebook: 'https://facebook.com/layerlab', phone: '01712345678', whatsapp: '8801712345678', address: 'Mirpur 10' });
  const o = mk(store, { payMethod: 'bkash', trxId: 'TX123456' });
  orders.approveOrder(store, o.id, {});
  orders.setPayment(store, o.id, { paid: 1000 });
  let m = buildModel(store, orders.findOrder(store, o.id), orders.totals(orders.findOrder(store, o.id)));
  assert.equal(m.totals.paid, 1000);
  assert.equal(m.totals.due, 2400);
  assert.equal(m.statusText, 'Partly paid');
  assert.equal(m.paidInFull, false);
  assert.deepEqual(m.payTo, ['bKash: 01712345678'], 'only the chosen method is printed');
  assert.equal(m.payLabel, 'bKash');
  assert.deepEqual(m.contact.map(([k]) => k), ['Address', 'Mobile / WhatsApp', 'Facebook'], 'company block lists what is filled in');
  assert.equal(m.contact[1][1], '01712345678', 'the same number as WhatsApp is not printed twice');
  assert.equal(m.customer.address, 'House 5, Road 3, Mirpur');
  orders.setPayment(store, o.id, { paid: 3400 });
  m = buildModel(store, orders.findOrder(store, o.id), orders.totals(orders.findOrder(store, o.id)));
  assert.equal(m.paidInFull, true);
  assert.equal(m.statusText, 'Paid in full');
  assert.deepEqual(m.payTo, []);
  const pdf = await renderInvoice(store, orders.findOrder(store, o.id), orders.totals(orders.findOrder(store, o.id)), 'pdf');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const png = await renderInvoice(store, orders.findOrder(store, o.id), orders.totals(orders.findOrder(store, o.id)), 'png');
  assert.equal((await sharp(png).metadata()).format, 'png');
  assert.ok(!JSON.stringify(m).includes('1100'), 'buying cost is not part of the invoice');
});

test('API: payment endpoint, stamp upload and removal, invoice with stamp', async () => {
  const port = await freePort();
  const dataDir = tmpDir();
  const app = createApp({ dataDir, distDir: tmpDir('dist-'), port, previewPort: port + 1 });
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${port}`;
  const call = (method, url, body) => fetch(base + url, { method, headers: { 'X-Admin': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    await call('POST', '/api/products', { sku: 'F-1', name: 'Filament', price: 1000, cost: 700, stockQty: 5 });
    await call('PUT', '/api/settings', { businessName: 'Layer Lab', bkashNumber: '01712345678', codEnabled: false });
    const st = await (await call('GET', '/api/state')).json();
    assert.equal(st.settings.bkashNumber, '01712345678');
    assert.equal(st.settings.codEnabled, false);
    const text = "Hello!\n\n1. Filament (SKU: F-1)\n   2 × ৳1,000 = ৳2,000\nName: Sumon\nPhone: 01811222333\nDelivery address: Road 2, Uttara\nPayment: bKash (TrxID: ZX99AB12)";
    const made = (await (await call('POST', '/api/orders/from-text', { text })).json()).order;
    assert.equal(made.payMethod, 'bkash');
    assert.equal(made.trxId, 'ZX99AB12');
    assert.equal(made.totals.due, 2000);
    // a pending order can be corrected together with its payment
    const edited = await (await call('PUT', '/api/orders/' + made.id, { payMethod: 'cod', paid: '', trxId: '' })).json();
    assert.equal(edited.payMethod, 'cod');
    await call('POST', `/api/orders/${made.id}/approve`, {});
    // ... and after approval only the payment can change
    const paid = await call('PUT', `/api/orders/${made.id}/payment`, { paid: 500, trxId: 'CASH-1' });
    assert.equal(paid.status, 200);
    const pj = await paid.json();
    assert.equal(pj.totals.paid, 500);
    assert.equal(pj.totals.due, 1500);
    assert.equal((await call('PUT', `/api/orders/${made.id}/payment`, { paid: 'abc' })).status, 400);
    assert.equal((await call('PUT', '/api/orders/o9999/payment', { paid: 1 })).status, 404);
    // stamp
    const png = await sharp({ create: { width: 120, height: 120, channels: 4, background: { r: 29, g: 78, b: 216, alpha: 0.6 } } }).png().toBuffer();
    const up = await fetch(base + '/api/settings/stamp', { method: 'POST', headers: { 'X-Admin': '1', 'X-Filename': 'stamp.png', 'Content-Type': 'application/octet-stream' }, body: png });
    assert.equal(up.status, 200);
    const stamp = (await up.json()).stamp;
    assert.match(stamp, /^stamp\..+\.webp$/);
    assert.ok(fs.existsSync(path.join(dataDir, 'images', stamp)));
    const bad = await fetch(base + '/api/settings/stamp', { method: 'POST', headers: { 'X-Admin': '1', 'X-Filename': 'x.png' }, body: Buffer.from('not an image') });
    assert.equal(bad.status, 400);
    const inv = await fetch(`${base}/api/orders/${made.id}/invoice.pdf`);
    assert.equal(inv.status, 200);
    assert.equal(Buffer.from(await inv.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const del = await call('DELETE', '/api/settings/stamp');
    assert.equal(del.status, 200);
    assert.equal((await del.json()).stamp, null);
    assert.ok(!fs.existsSync(path.join(dataDir, 'images', stamp)), 'the file is removed with the setting');
  } finally { server.close(); }
});
