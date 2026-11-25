'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createApp } = require('../server');
const { tmpDir, freePort, testImage } = require('./helpers');

let server, base, app, dataDir, distDir;

test.before(async () => {
  const port = await freePort();
  dataDir = tmpDir();
  distDir = tmpDir('dist-');
  app = createApp({ dataDir, distDir, port, previewPort: port + 1 });
  await new Promise((r) => { server = app.listen(port, '127.0.0.1', r); });
  base = `http://127.0.0.1:${port}`;
});
test.after(() => server.close());

const H = { 'X-Admin': '1' };
const json = (method, url, body) => fetch(base + url, { method, headers: { ...H, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const upload = (url, buf, name) => fetch(base + url, { method: 'POST', headers: { ...H, 'x-filename': encodeURIComponent(name) }, body: buf });

test('security: wrong Host header and missing X-Admin header are refused', async () => {
  const wrongHost = await new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: '/api/state', headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const r = await fetch(base + '/api/products', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"sku":"X","name":"x","price":1}' });
  assert.equal(r.status, 403);
  const del = await fetch(base + '/api/products/x', { method: 'DELETE' });
  assert.equal(del.status, 403);
  assert.equal((await fetch(base + '/api/state')).status, 200);
});

test('products: create, validate, edit, list filters, delete', async () => {
  const cat = await (await json('POST', '/api/categories', { name: 'Saree' })).json();
  const r = await json('POST', '/api/products', { sku: 'T-1', name: 'Test one', price: '1500', category: cat.slug });
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.id, 't-1');
  assert.equal((await json('POST', '/api/products', { sku: 't-1', name: 'dupe', price: 1 })).status, 400);
  assert.equal((await json('POST', '/api/products', { sku: 'T-2', name: '', price: 1 })).status, 400);
  assert.equal((await json('PUT', '/api/products/t-1', { price: 'abc' })).status, 400);
  assert.equal((await json('PUT', '/api/products/nope', { price: 1 })).status, 404);
  const upd = await (await json('PUT', '/api/products/t-1', { price: 1600, inStock: false, visible: true })).json();
  assert.equal(upd.price, 1600);
  assert.equal(upd.inStock, false);

  const list = (qs) => fetch(base + '/api/products?' + qs).then((x) => x.json());
  assert.equal((await list('q=test')).total, 1);
  assert.equal((await list('q=zzz')).total, 0);
  assert.equal((await list('filter=outofstock')).total, 1);
  assert.equal((await list('filter=nophoto')).total, 1);
  assert.equal((await list(`category=${cat.slug}`)).total, 1);
  assert.equal((await list('category=_none')).total, 0);

  assert.equal((await json('DELETE', '/api/products/t-1')).status, 200);
  assert.equal((await list('')).total, 0);
});

test('import flow: template -> parse -> analyze -> run', async () => {
  const tpl = Buffer.from(await (await fetch(base + '/api/import/template.xlsx')).arrayBuffer());
  const parsed = await (await upload('/api/import/parse', tpl, 'products-template.xlsx')).json();
  assert.equal(parsed.total, 8);
  assert.equal(parsed.mapping.sku, 0);
  assert.equal(parsed.analysis.wouldCreate, 8);
  const unmapped = await (await json('POST', '/api/import/analyze', { token: parsed.token, mapping: { ...parsed.mapping, price: -1 } })).json();
  assert.equal(unmapped.errorRows, 5, 'unmapping price makes new products with a shown price invalid; the hidden-price one stays valid');
  assert.equal((await json('POST', '/api/import/run', { token: parsed.token, mapping: { ...parsed.mapping, sku: -1 } })).status, 400);
  const run = await (await json('POST', '/api/import/run', { token: parsed.token, mapping: parsed.mapping })).json();
  assert.deepEqual([run.created, run.updated, run.skipped], [8, 0, 0]);
  assert.equal((await json('POST', '/api/import/run', { token: parsed.token, mapping: parsed.mapping })).status, 410, 'session is single use');
  assert.equal((await upload('/api/import/parse', Buffer.from('%PDF-1.4 not a sheet'), 'x.xlsx')).status, 400, 'garbage with a sheet name');
  assert.equal((await upload('/api/import/parse', Buffer.from('a,b\n1,2\n'), 'report.pdf')).status, 400, 'wrong file type');
  assert.equal((await upload('/api/import/parse', Buffer.from('SKU,Name,Price\n'), 'empty.csv')).status, 400, 'header only');
  assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).length >= 1, 'backup made before import');
});

test('bulk photos: match by SKU, shrink, report unmatched and failed', async () => {
  const big = await testImage({ width: 4000, height: 3000 });
  const ok1 = await (await upload('/api/photos/upload', big, 'fil-pla-blk.jpg')).json();
  assert.deepEqual([ok1.status, ok1.sku, ok1.slot], ['matched', 'FIL-PLA-BLK', 1]);
  const ok2 = await (await upload('/api/photos/upload', big, 'FIL-PLA-BLK-2.JPG')).json();
  assert.deepEqual([ok2.status, ok2.slot], ['matched', 2]);
  const named = await (await upload('/api/photos/upload', big, 'fil-pla-blk.jpg')).json();
  assert.equal(named.status, 'matched', 're-running is safe');
  assert.equal((await (await upload('/api/photos/upload', big, 'nobody.jpg')).json()).status, 'unmatched');
  const heic = await (await upload('/api/photos/upload', Buffer.from('x'), 'IMG_1.HEIC')).json();
  assert.equal(heic.status, 'failed');
  assert.match(heic.message, /HEIC/);
  assert.equal((await (await upload('/api/photos/upload', Buffer.from('not an image'), 'LUB-PTFE.jpg')).json()).status, 'failed');
  assert.equal((await (await upload('/api/photos/upload', Buffer.from('x'), 'notes.pdf')).json()).status, 'failed');

  const p = app.locals.store.findBySku('FIL-PLA-BLK');
  assert.ok(p.images[0] && p.images[1]);
  const meta = await sharp(path.join(dataDir, 'images', p.images[0].full)).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 1600);
  const files = fs.readdirSync(path.join(dataDir, 'images'));
  assert.equal(files.filter((f) => f.startsWith('fil-pla-blk-1.')).length, 1, 'no stale copies after re-upload');
  const sizes = files.map((f) => fs.statSync(path.join(dataDir, 'images', f)).size);
  assert.ok(Math.max(...sizes) < 200 * 1024, 'every stored file is small');
});

test('single product photo endpoints', async () => {
  const img = await testImage({ width: 900, height: 900 });
  const r = await (await upload('/api/products/lub-ptfe/photo/2', img, 'x.png')).json();
  assert.ok(r.images[1] && !r.images[0]);
  assert.equal((await upload('/api/products/lub-ptfe/photo/3', img, 'x.png')).status, 400);
  assert.equal((await upload('/api/products/nope/photo/1', img, 'x.png')).status, 404);
  const gone = await (await json('DELETE', '/api/products/lub-ptfe/photo/2')).json();
  assert.equal(gone.images[1], null);
});

test('settings, logo, build', async () => {
  const s = await (await json('PUT', '/api/settings', { businessName: 'Shop & Co', whatsapp: '01711223344', siteUrl: 'shop.example.com/', accentColor: '#112233' })).json();
  assert.equal(s.whatsapp, '8801711223344');
  assert.equal(s.siteUrl, 'https://shop.example.com');
  assert.equal((await (await json('PUT', '/api/settings', { accentColor: 'red' })).json()).accentColor, '#112233', 'invalid colour ignored');
  const logo = await (await upload('/api/settings/logo', await testImage({ width: 800, height: 300 }), 'logo.png')).json();
  assert.match(logo.logo, /^logo\.[0-9a-f]{8}\.webp$/);

  const r = await (await json('POST', '/api/build')).json();
  assert.equal(r.published, 8);
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(distDir, 'img', logo.logo)));
  assert.ok(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8').includes('Shop &amp; Co'));
  const home = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  assert.ok(home.includes(`<link rel="icon" href="/img/${logo.logo}">`), 'the logo becomes the browser-tab icon');
  assert.equal((await json('DELETE', '/api/settings/logo')).status, 200);
});

test('categories: rename, reorder, delete', async () => {
  await json('POST', '/api/categories', { name: 'Panjabi' });
  const before = (await (await fetch(base + '/api/state')).json()).categories.map((c) => c.slug);
  const rev = [...before].reverse();
  const after = await (await json('POST', '/api/categories/reorder', { slugs: rev })).json();
  assert.deepEqual(after.map((c) => c.slug), rev);
  assert.equal((await (await json('PUT', '/api/categories/saree', { name: 'Sarees' })).json()).name, 'Sarees');
  assert.equal((await json('DELETE', '/api/categories/saree')).status, 200);
  assert.equal((await json('DELETE', '/api/categories/saree')).status, 404);
});

test('admin page and stored photos are served', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('Shop admin'));
  assert.equal((await fetch(base + '/admin.js')).status, 200);
  const p = app.locals.store.findBySku('FIL-PLA-BLK');
  assert.equal((await fetch(base + '/photos/' + p.images[0].thumb)).status, 200);
});

test('settings: logo, name, contact, map link and hours are saved; links are cleaned', async () => {
  const r = await json('PUT', '/api/settings', {
    businessName: 'Layer Lab', tagline: '3D printing parts', phone: '01712 345678', email: 'a@b.com', address: 'Shop 12, Elephant Road',
    mapUrl: 'maps.google.com/?q=layerlab', hours: 'Sat to Thu 10-8', facebook: 'facebook.com/layerlab', instagram: 'javascript:alert(1)', youtube: '',
  });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.tagline, '3D printing parts');
  assert.equal(s.mapUrl, 'https://maps.google.com/?q=layerlab', 'https:// is added');
  assert.equal(s.facebook, 'https://facebook.com/layerlab');
  assert.equal(s.instagram, '', 'only http(s) links are kept');
  assert.equal(s.hours, 'Sat to Thu 10-8');
});
