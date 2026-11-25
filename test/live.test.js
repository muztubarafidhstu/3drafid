'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createApp, createSite } = require('../server');
const { Auth, parseCookies } = require('../lib/auth');
const { numberToWords, amountInWords, invoiceNumber } = require('../lib/invoice');
const { tmpDir, freePort } = require('./helpers');

const HJ = { 'X-Admin': '1', 'Content-Type': 'application/json' };

/** Starts one program the way a server would: admin address with a password, everything else is the shop. */
async function startLive({ password = 'correct horse', autoPublish = true } = {}) {
  const port = await freePort();
  const dataDir = tmpDir(), distDir = tmpDir('dist-');
  if (password) await new Auth(dataDir).setPassword(password);
  const app = createApp({ dataDir, distDir, port, live: true, adminHosts: ['admin.shop.test'], publicSiteUrl: 'https://shop.test', autoPublish });
  const site = createSite(distDir, app.locals.publisher);
  const router = express();
  router.use((req, res, next) => (String(req.headers.host).replace(/:\d+$/, '') === 'admin.shop.test' ? app(req, res, next) : site(req, res, next)));
  const server = await new Promise((r) => { const s = router.listen(port, '127.0.0.1', () => r(s)); });
  const call = (host, method, url, { body, cookie, headers } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let data; try { data = JSON.parse(buf.toString()); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString(), buf, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  return { app, server, dataDir, distDir, call, close: () => { app.locals.publisher.stop(); server.close(); } };
}
const login = async (L, pw = 'correct horse') => {
  const r = await L.call('admin.shop.test', 'POST', '/api/login', { body: { password: pw }, headers: { 'X-Admin': '1' } });
  return { r, cookie: r.headers['set-cookie'] ? r.headers['set-cookie'][0].split(';')[0] : '' };
};

test('auth: password is hashed on disk; strength rules; tokens are signed and expire', async () => {
  const dir = tmpDir();
  const a = new Auth(dir);
  assert.equal(a.hasPassword(), false);
  await assert.rejects(() => a.setPassword('short'), /at least 8/);
  await assert.rejects(() => a.setPassword('password'), /too easy/);
  await a.setPassword('a long enough one');
  const disk = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!disk.includes('a long enough one'), 'the password itself is never stored');
  assert.equal(await a.verify('a long enough one'), true);
  assert.equal(await a.verify('A long enough one'), false);
  const t = a.issue();
  assert.equal(a.valid(t), true);
  assert.equal(a.valid(t.slice(0, -2) + '00'), false, 'a changed signature is refused');
  assert.equal(a.valid('9999999999999.' + 'a'.repeat(64)), false);
  assert.equal(a.valid(t, Date.now() + 15 * 24 * 3600 * 1000), false, 'expires after two weeks');
  await a.setPassword('another good one');
  assert.equal(a.valid(t), false, 'changing the password signs everyone out');
  assert.deepEqual(parseCookies('a=1; sid=abc.def; z=9'), { a: '1', sid: 'abc.def', z: '9' });
});

test('auth: too many wrong tries are slowed down', () => {
  const a = new Auth(tmpDir());
  for (let i = 0; i < 5; i++) a.failed('1.2.3.4', 1000);
  assert.equal(a.waitSeconds('1.2.3.4', 1000), 0, 'five free tries');
  a.failed('1.2.3.4', 1000);
  assert.equal(a.waitSeconds('1.2.3.4', 1000), 10);
  assert.equal(a.waitSeconds('5.6.7.8', 1000), 0, 'other people are not affected');
  a.succeeded('1.2.3.4');
  assert.equal(a.waitSeconds('1.2.3.4', 1000), 0);
});

test('live: admin address needs the password; the shop address is public and never shows the admin', async () => {
  const L = await startLive();
  try {
    const other = await L.call('evil.example', 'GET', '/api/state');
    assert.equal(other.status, 404, 'other hosts get the shop, not the admin');
    assert.ok(!other.text.includes('settings'), 'and no data');
    const anon = await L.call('admin.shop.test', 'GET', '/api/state');
    assert.equal(anon.status, 401);
    const page = await L.call('admin.shop.test', 'GET', '/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login.html');
    assert.equal((await L.call('admin.shop.test', 'GET', '/login.html')).status, 200, 'the sign-in page itself is open');
    assert.equal((await L.call('admin.shop.test', 'GET', '/admin.js')).status, 302, 'the admin program is not');
    assert.equal((await L.call('admin.shop.test', 'GET', '/photos/x.webp')).status, 302);

    const bad = await login(L, 'wrong password');
    assert.equal(bad.r.status, 401);
    const noHeader = await L.call('admin.shop.test', 'POST', '/api/login', { body: { password: 'correct horse' } });
    assert.equal(noHeader.status, 403, 'sign-in only from the admin page');

    const ok = await login(L);
    assert.equal(ok.r.status, 200);
    const flags = ok.r.headers['set-cookie'][0];
    assert.match(flags, /HttpOnly/);
    assert.match(flags, /SameSite=Strict/);
    const st = await L.call('admin.shop.test', 'GET', '/api/state', { cookie: ok.cookie });
    assert.equal(st.status, 200);
    assert.equal(st.data.live, true);
    assert.equal(st.data.previewUrl, 'https://shop.test');
    assert.equal((await L.call('admin.shop.test', 'GET', '/', { cookie: ok.cookie })).status, 200);
    // wrong cookie
    assert.equal((await L.call('admin.shop.test', 'GET', '/api/state', { cookie: 'sid=1.2' })).status, 401);
    // logout clears it
    const out = await L.call('admin.shop.test', 'POST', '/api/logout', { headers: { 'X-Admin': '1' }, cookie: ok.cookie });
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  } finally { L.close(); }
});

test('live: before a password exists the admin explains how to set one; changing it needs the old one', async () => {
  const L = await startLive({ password: '' });
  try {
    const r = await L.call('admin.shop.test', 'POST', '/api/login', { body: { password: 'anything' }, headers: { 'X-Admin': '1' } });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /set-password/);
    assert.equal((await L.call('admin.shop.test', 'GET', '/api/state')).status, 401, 'locked until a password is set');
  } finally { L.close(); }
  const M = await startLive();
  try {
    const { cookie } = await login(M);
    const bad = await M.call('admin.shop.test', 'POST', '/api/password', { body: { current: 'nope', next: 'new password 1' }, headers: { 'X-Admin': '1' }, cookie });
    assert.equal(bad.status, 401);
    const weak = await M.call('admin.shop.test', 'POST', '/api/password', { body: { current: 'correct horse', next: 'abc' }, headers: { 'X-Admin': '1' }, cookie });
    assert.equal(weak.status, 400);
    const ok = await M.call('admin.shop.test', 'POST', '/api/password', { body: { current: 'correct horse', next: 'new password 1' }, headers: { 'X-Admin': '1' }, cookie });
    assert.equal(ok.status, 200);
    assert.equal((await M.call('admin.shop.test', 'GET', '/api/state', { cookie })).status, 401, 'the old session is signed out');
    assert.equal((await login(M, 'new password 1')).r.status, 200);
  } finally { M.close(); }
});

test('auto-publish: a change in the admin reaches the website by itself, and a hidden product disappears', async () => {
  const L = await startLive();
  try {
    const { cookie } = await login(L);
    const post = (url, body, m = 'POST') => L.call('admin.shop.test', m, url, { body, cookie, headers: { 'X-Admin': '1' } });
    L.app.locals.publisher.delay = 50;
    const waitIdle = () => L.app.locals.publisher.whenIdle();
    await L.app.locals.publisher.run();
    assert.equal((await L.call('shop.test', 'GET', '/')).status, 200, 'the shop is up after the first build');

    assert.equal((await post('/api/products', { sku: 'LIVE-1', name: 'Live product one', price: 1200 })).status, 200);
    await waitIdle();
    const page = await L.call('shop.test', 'GET', '/p/live-1/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Live product one/);
    assert.match(page.text, /1,200/);

    assert.equal((await post('/api/products/live-1', { price: 1500 }, 'PUT')).status, 200);
    await waitIdle();
    assert.match((await L.call('shop.test', 'GET', '/p/live-1/')).text, /1,500/, 'a price change is live');

    assert.equal((await post('/api/products/live-1', { visible: false }, 'PUT')).status, 200);
    await waitIdle();
    assert.equal((await L.call('shop.test', 'GET', '/p/live-1/')).status, 404, 'a hidden product is gone from the site');

    const site = await L.call('admin.shop.test', 'GET', '/api/site', { cookie });
    assert.equal(site.data.state, 'live');
    assert.ok(site.data.builtAt);
    // nothing private on the site
    const files = [];
    (function walk(d) { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else if (/\.(html|json|xml|txt)$/.test(f)) files.push(fs.readFileSync(full, 'utf8')); } })(L.distDir);
    assert.ok(!files.some((t) => /stockQty|"cost"|auth\.json/.test(t)));
  } finally { L.close(); }
});

test('auto-publish: a burst of changes is combined; failed requests do not trigger a rebuild', async () => {
  const L = await startLive();
  try {
    const { cookie } = await login(L);
    const pub = L.app.locals.publisher;
    await pub.run();
    pub.delay = 80;
    const v0 = pub.version;
    const post = (url, body) => L.call('admin.shop.test', 'POST', url, { body, cookie, headers: { 'X-Admin': '1' } });
    assert.equal((await post('/api/products', { sku: '', name: '', price: 1 })).status, 400);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pub.version, v0, 'a refused change builds nothing');
    for (let i = 0; i < 6; i++) await post('/api/products', { sku: 'B-' + i, name: 'Burst ' + i, price: 10 + i });
    await pub.whenIdle();
    assert.ok(pub.version - v0 <= 2, `6 quick changes made ${pub.version - v0} rebuilds`);
    assert.match((await L.call('shop.test', 'GET', '/p/b-5/')).text, /Burst 5/);
  } finally { L.close(); }
});

test('site: pages are checked each time, photos and data are cached long; no admin files; a clear message before the first build', async () => {
  const L = await startLive({ autoPublish: false });
  try {
    const early = await L.call('shop.test', 'GET', '/');
    assert.equal(early.status, 503);
    assert.match(early.text, /getting ready/);
    await L.app.locals.publisher.run();
    const home = await L.call('shop.test', 'GET', '/');
    assert.equal(home.headers['cache-control'], 'no-cache');
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    const css = home.text.match(/\/assets\/style\.[a-f0-9]+\.css/)[0];
    assert.match((await L.call('shop.test', 'GET', css)).headers['cache-control'], /immutable/);
    assert.equal((await L.call('shop.test', 'GET', '/_headers')).status, 404);
    assert.equal((await L.call('shop.test', 'GET', '/login.html')).status, 404, 'the shop address has no admin files');
    assert.equal((await L.call('shop.test', 'GET', '/api/state')).status, 404);
    assert.equal((await L.call('shop.test', 'GET', '/healthz')).text, 'ok');
    assert.equal((await L.call('shop.test', 'GET', '/nope/')).status, 404);
  } finally { L.close(); }
});

test('invoices: PDF and PNG per order, with a number from the settings; only for signed-in admins', async () => {
  const L = await startLive();
  try {
    const { cookie } = await login(L);
    const call = (m, u, body) => L.call('admin.shop.test', m, u, { body, cookie, headers: { 'X-Admin': '1' } });
    await call('PUT', '/api/settings', { businessName: 'Layer Lab', invoicePrefix: 'LL/', paymentInfo: 'bKash 01712 345678', taxId: '123' });
    const p = (await call('POST', '/api/products', { sku: 'INV-A', name: 'নীল ফিলামেন্ট Blue filament', price: 1650, cost: 1000 })).data;
    const o = (await call('POST', '/api/orders', { customer: { name: 'মোঃ রহমান', phone: '01711111111' }, items: [{ productId: p.id, qty: 2 }], deliveryFee: 100 })).data;
    const pdf = await call('GET', `/api/orders/${o.id}/invoice.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(pdf.headers['content-disposition'], /attachment; filename="Invoice-LL_1001\.pdf"/);
    assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
    const png = await call('GET', `/api/orders/${o.id}/invoice.png`);
    assert.equal(png.status, 200);
    assert.equal(png.buf.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.buf.length > 20000);
    assert.equal((await call('GET', '/api/orders/o9999/invoice.pdf')).status, 404);
    assert.equal((await L.call('admin.shop.test', 'GET', `/api/orders/${o.id}/invoice.pdf`)).status, 401, 'no invoice without signing in');
    // the invoice never shows the buying cost: the PDF text is not searchable here, so check the model instead
    const { buildModel } = require('../lib/invoice');
    const order = L.app.locals.store.data.orders[0];
    const m = buildModel(L.app.locals.store, order, { subtotal: 3300, discount: 0, deliveryFee: 100, total: 3400, unpriced: 0 });
    assert.ok(!JSON.stringify(m).includes('1000'), 'cost is not in the invoice data');
    assert.equal(m.number, 'LL/1001');
  } finally { L.close(); }
});

test('invoices: amount in words uses lakh and crore; invoice number follows the prefix', () => {
  assert.equal(numberToWords(0), 'Zero');
  assert.equal(numberToWords(1650), 'One Thousand Six Hundred Fifty');
  assert.equal(numberToWords(125000), 'One Lakh Twenty Five Thousand');
  assert.equal(numberToWords(12345678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
  assert.equal(amountInWords(1650.5), 'One Thousand Six Hundred Fifty Taka and Fifty Paisa Only');
  assert.equal(invoiceNumber({ invoicePrefix: '' }, { no: 7 }), '7');
  assert.equal(invoiceNumber({}, { no: 1001 }), 'INV-1001');
  assert.equal(invoiceNumber({ invoicePrefix: 'a b<script>' }, { no: 1 }), 'abscript1');
});

test('build: unchanged files are left alone; removed products and old product lists are deleted at once', async () => {
  const L = await startLive({ autoPublish: false });
  try {
    const store = L.app.locals.store, pub = L.app.locals.publisher;
    store.addProduct({ sku: 'K-1', name: 'Keep', price: 10 });
    store.addProduct({ sku: 'D-1', name: 'Drop', price: 20 });
    await pub.run();
    const keepFile = path.join(L.distDir, 'assets', fs.readdirSync(path.join(L.distDir, 'assets')).find((f) => f.endsWith('.css')));
    const t1 = fs.statSync(keepFile).mtimeMs;
    const dataBefore = fs.readdirSync(path.join(L.distDir, 'data'));
    await new Promise((r) => setTimeout(r, 30));
    store.updateProduct('d-1', { price: 25 });
    store.deleteProduct('d-1');
    await pub.run();
    assert.equal(fs.statSync(keepFile).mtimeMs, t1, 'a file that did not change is not rewritten');
    assert.ok(!fs.existsSync(path.join(L.distDir, 'p', 'd-1')), 'the deleted product page is gone');
    const dataAfter = fs.readdirSync(path.join(L.distDir, 'data'));
    assert.equal(dataAfter.length, 1, 'only the current product list is kept, so a price you hide is gone from the website at once');
    assert.notDeepEqual(dataAfter, dataBefore);
    const j = fs.readFileSync(path.join(L.distDir, 'data', dataAfter[0]), 'utf8');
    assert.ok(!j.includes('"25"') && !j.includes('Drop'));
  } finally { L.close(); }
});
