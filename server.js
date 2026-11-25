'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { processPhoto, processLogo, processStamp, checkSupported } = require('./lib/images');
const { buildPhotoIndex, matchFile } = require('./lib/photo-match');
const importer = require('./lib/importer');
const orders = require('./lib/orders');
const { build } = require('./lib/build');
const { Auth, parseCookies } = require('./lib/auth');
const { Publisher } = require('./lib/publisher');
const { renderInvoice, invoiceFileName } = require('./lib/invoice');
const { saleIsValid } = require('./lib/pricing');
const { cleanText } = require('./lib/util');

const ROOT = __dirname;

/**
 * Create the admin app.
 *  - On a computer (default): only answers to localhost, and no password is needed until you set one.
 *  - Online (live: true): only answers to its own admin address(es), and always needs the password.
 * Every change you save rebuilds the customer website a moment later (autoPublish).
 */
function createApp({
  dataDir = path.join(ROOT, 'data'), distDir = path.join(ROOT, 'dist'), port = 3000, previewPort = 3001,
  adminHosts = null, live = false, publicSiteUrl = '', autoPublish = false, log = () => {},
} = {}) {
  const store = new Store(dataDir);
  const auth = new Auth(dataDir);
  const publisher = new Publisher({ store, distDir, assetsDir: path.join(ROOT, 'assets'), siteUrl: publicSiteUrl, log });
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);

  const hostOf = (req) => String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set(adminHosts ? adminHosts.map((h) => h.toLowerCase()) : [`localhost:${port}`, `127.0.0.1:${port}`]);
  app.use((req, res, next) => {
    const h = hostOf(req);
    const ok = adminHosts ? allowedHosts.has(h.replace(/:\d+$/, '')) : allowedHosts.has(h);
    if (!ok) return res.status(403).send('Forbidden host');
    res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });
    next();
  });

  // ---------- sign-in ----------
  const authRequired = () => live || auth.hasPassword();
  const signedIn = (req) => auth.valid(parseCookies(req.headers.cookie).sid);
  const OPEN_PATHS = new Set(['/login.html', '/login.js', '/admin.css', '/api/login', '/api/logout', '/api/session']);
  app.use((req, res, next) => {
    if (!authRequired() || OPEN_PATHS.has(req.path) || signedIn(req)) return next();
    if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Please sign in', login: true });
    return res.redirect('/login.html');
  });
  // Mutating requests must carry a custom header. Browsers only allow that from our own pages
  // (cross-site pages would need a CORS preflight, which we never grant).
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-admin'] !== '1') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
  // Any successful change to the shop schedules a website update.
  const NO_REBUILD = /^\/(login|logout|password|import\/parse|import\/analyze)$/;
  app.use('/api', (req, res, next) => {
    if (autoPublish && !['GET', 'HEAD'].includes(req.method) && !NO_REBUILD.test(req.path)) {
      res.on('finish', () => { if (res.statusCode < 400) publisher.schedule(); });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  const raw = express.raw({ type: () => true, limit: '60mb' });
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  });
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const publicProduct = (p) => ({ ...p, showPrice: p.showPrice !== false, salePrice: p.salePrice ?? null, thumb: p.images[0]?.thumb || p.images[1]?.thumb || null });

  // ---------- sign-in routes ----------
  const clientIp = (req) => req.ip || req.socket.remoteAddress || '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cookieFlags = (req, maxAge) => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;

  app.get('/api/session', (req, res) => {
    res.json({ required: authRequired(), signedIn: !authRequired() || signedIn(req), passwordSet: auth.hasPassword() });
  });

  app.post('/api/login', wrap(async (req, res) => {
    if (!auth.hasPassword()) throw bad('The admin password has not been set yet. On the server run: npm run set-password', 503);
    const ip = clientIp(req);
    const wait = auth.waitSeconds(ip);
    if (wait) { res.set('Retry-After', String(wait)); throw bad(`Too many wrong passwords. Try again in ${wait} seconds.`, 429); }
    const ok = await auth.verify(String((req.body || {}).password || ''));
    if (!ok) {
      auth.failed(ip);
      await sleep(400);
      throw bad('That password is not right.', 401);
    }
    auth.succeeded(ip);
    res.set('Set-Cookie', `sid=${auth.issue()}; ${cookieFlags(req, 14 * 24 * 3600)}`);
    res.json({ ok: true });
  }));

  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `sid=; ${cookieFlags(req, 0)}`);
    res.json({ ok: true });
  });

  // Change (or first set) the password. Changing it signs every device out.
  app.post('/api/password', wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (auth.hasPassword() && !(await auth.verify(String(current || '')))) throw bad('Your current password is not right.', 401);
    await auth.setPassword(String(next || ''));
    res.set('Set-Cookie', `sid=${auth.issue()}; ${cookieFlags(req, 14 * 24 * 3600)}`);
    res.json({ ok: true });
  }));

  // ---------- state ----------
  const liveUrl = () => store.data.settings.siteUrl || publicSiteUrl || `http://localhost:${previewPort}`;
  app.get('/api/state', (req, res) => {
    res.json({
      settings: store.data.settings, categories: store.data.categories, filterOptions: store.filterOptions(), stats: store.stats(),
      distDir, previewUrl: liveUrl(), live, authRequired: authRequired(), passwordSet: auth.hasPassword(), site: publisher.status(),
    });
  });
  app.get('/api/site', (req, res) => res.json({ ...publisher.status(), url: liveUrl() }));

  // ---------- products ----------
  app.get('/api/products', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const cat = String(req.query.category || '');
    const filter = String(req.query.filter || 'all');
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    let list = store.data.products;
    if (q) list = list.filter((p) => `${p.name} ${p.sku}`.toLowerCase().includes(q));
    if (cat === '_none') list = list.filter((p) => !p.category);
    else if (cat) list = list.filter((p) => p.category === cat);
    if (filter === 'hidden') list = list.filter((p) => !p.visible);
    else if (filter === 'outofstock') list = list.filter((p) => !p.inStock);
    else if (filter === 'lowstock') list = list.filter((p) => p.stockQty !== null && p.stockQty !== undefined && p.stockQty <= orders.LOW_STOCK);
    else if (filter === 'nophoto') list = list.filter((p) => !p.images[0] && !p.images[1]);
    else if (filter === 'pricehidden') list = list.filter((p) => p.showPrice === false);
    else if (filter === 'onsale') list = list.filter((p) => p.showPrice !== false && saleIsValid(p.price, p.salePrice));
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const items = list.slice().reverse().slice((page - 1) * pageSize, page * pageSize).map(publicProduct);
    res.json({ items, total, page, pages });
  });

  app.post('/api/products', wrap(async (req, res) => {
    let p;
    try { p = store.addProduct(req.body || {}); } catch (e) { throw bad(e.message); }
    await store.save();
    res.json(publicProduct(p));
  }));

  app.put('/api/products/:id', wrap(async (req, res) => {
    let p;
    const notes = [];
    try { p = store.updateProduct(req.params.id, req.body || {}, notes); } catch (e) { throw bad(e.message, e.message === 'Product not found' ? 404 : 400); }
    await store.save();
    res.json({ ...publicProduct(p), notes });
  }));

  app.delete('/api/products/:id', wrap(async (req, res) => {
    if (!store.deleteProduct(req.params.id)) throw bad('Product not found', 404);
    await store.save();
    res.json({ ok: true });
  }));

  function slotOf(req) {
    const slot = parseInt(req.params.slot, 10);
    if (slot !== 1 && slot !== 2) throw bad('Photo slot must be 1 or 2');
    return slot;
  }

  app.post('/api/products/:id/photo/:slot', raw, wrap(async (req, res) => {
    const p = store.getProduct(req.params.id);
    if (!p) throw bad('Product not found', 404);
    const slot = slotOf(req);
    const name = decodeURIComponent(String(req.headers['x-filename'] || 'photo.jpg'));
    const unsupported = checkSupported(name);
    if (unsupported) throw bad(unsupported);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty file');
    let processed;
    try { processed = await processPhoto(req.body, { share: slot === 1 }); } catch { throw bad('This file is not a readable image'); }
    await store.setPhoto(p, slot, processed);
    await store.save();
    res.json(publicProduct(p));
  }));

  app.delete('/api/products/:id/photo/:slot', wrap(async (req, res) => {
    const p = store.getProduct(req.params.id);
    if (!p) throw bad('Product not found', 404);
    store.removePhoto(p, slotOf(req));
    await store.save();
    res.json(publicProduct(p));
  }));

  // ---------- categories ----------
  app.post('/api/categories', wrap(async (req, res) => {
    const c = store.ensureCategory(req.body?.name);
    if (!c) throw bad('Category name is required');
    await store.save();
    res.json(c);
  }));
  app.post('/api/categories/reorder', wrap(async (req, res) => {
    if (!Array.isArray(req.body?.slugs)) throw bad('slugs must be a list');
    store.reorderCategories(req.body.slugs);
    await store.save();
    res.json(store.data.categories);
  }));
  app.put('/api/categories/:slug', wrap(async (req, res) => {
    const body = req.body || {};
    const c = store.findCategory(req.params.slug);
    if (!c) throw bad('Category not found', 404);
    if ('name' in body && !store.renameCategory(req.params.slug, body.name)) throw bad('Category name is required');
    let summary = { removed: [], valuesLost: 0 };
    if ('filters' in body) {
      try { summary = store.setCategoryFilters(req.params.slug, body.filters); } catch (e) { throw bad(e.message); }
    }
    await store.save();
    res.json({ ...c, removed: summary.removed, valuesLost: summary.valuesLost });
  }));
  app.delete('/api/categories/:slug', wrap(async (req, res) => {
    if (!store.deleteCategory(req.params.slug)) throw bad('Category not found', 404);
    await store.save();
    res.json({ ok: true });
  }));

  // ---------- settings ----------
  app.put('/api/settings', wrap(async (req, res) => {
    const s = store.updateSettings(req.body || {});
    await store.save();
    res.json(s);
  }));
  app.post('/api/settings/logo', raw, wrap(async (req, res) => {
    const name = decodeURIComponent(String(req.headers['x-filename'] || 'logo.png'));
    const unsupported = checkSupported(name);
    if (unsupported) throw bad(unsupported);
    let webp;
    try { webp = await processLogo(req.body); } catch { throw bad('This file is not a readable image'); }
    await store.setLogo(webp);
    await store.save();
    res.json(store.data.settings);
  }));
  app.post('/api/settings/stamp', raw, wrap(async (req, res) => {
    const name = decodeURIComponent(String(req.headers['x-filename'] || 'stamp.png'));
    const unsupported = checkSupported(name);
    if (unsupported) throw bad(unsupported);
    let webp;
    try { webp = await processStamp(req.body); } catch { throw bad('This file is not a readable image'); }
    await store.setStamp(webp);
    await store.save();
    res.json(store.data.settings);
  }));

  app.delete('/api/settings/stamp', wrap(async (req, res) => {
    store.removeStamp();
    await store.save();
    res.json(store.data.settings);
  }));

  app.delete('/api/settings/logo', wrap(async (req, res) => {
    store.removeLogo();
    await store.save();
    res.json(store.data.settings);
  }));

  // ---------- import ----------
  const sessions = new Map(); // token -> { headers, rows, expires }
  function session(token) {
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) { sessions.delete(token); throw bad('Import session expired. Choose the file again.', 410); }
    return s;
  }
  function cleanMapping(m) {
    const out = {};
    for (const f of importer.FIELDS) out[f] = Number.isInteger(m?.[f]) ? m[f] : -1;
    // Extra columns the owner wants as customer filters: [{ col, label }], never a column already used for a field.
    const used = new Set(Object.values(out));
    out.filters = [];
    if (Array.isArray(m?.filters)) {
      for (const f of m.filters.slice(0, 12)) {
        const col = f && f.col;
        const label = cleanText(f && f.label, 40);
        if (!Number.isInteger(col) || col < 0 || col > 500 || used.has(col) || !label) continue;
        used.add(col);
        out.filters.push({ col, label });
      }
    }
    return out;
  }

  app.get('/api/import/template.xlsx', (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="products-template.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(importer.templateBuffer());
  });

  app.post('/api/import/parse', raw, wrap(async (req, res) => {
    const fname = decodeURIComponent(String(req.headers['x-filename'] || ''));
    if (!/\.(xlsx|xlsm|xls|ods|csv|txt)$/i.test(fname)) throw bad('Please choose an Excel (.xlsx) or CSV file.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('The file is empty.');
    let parsed;
    try { parsed = importer.parseSheet(req.body); } catch (e) { throw bad(`Could not read this file: ${e.message}`); }
    const token = crypto.randomBytes(12).toString('hex');
    for (const [k, v] of sessions) if (v.expires < Date.now()) sessions.delete(k);
    sessions.set(token, { ...parsed, expires: Date.now() + 30 * 60 * 1000 });
    const mapping = importer.autoMap(parsed.headers, parsed.rows);
    res.json({ token, headers: parsed.headers, sample: parsed.rows.slice(0, 8), total: parsed.rows.length, mapping, analysis: importer.analyze(store, parsed.rows, mapping) });
  }));

  app.post('/api/import/analyze', wrap(async (req, res) => {
    const s = session(req.body?.token);
    res.json(importer.analyze(store, s.rows, cleanMapping(req.body.mapping)));
  }));

  app.post('/api/import/run', wrap(async (req, res) => {
    const s = session(req.body?.token);
    const mapping = cleanMapping(req.body.mapping);
    if (mapping.sku < 0) throw bad('Choose which column holds the SKU / product code');
    store.backup('before-import');
    const report = importer.applyImport(store, s.rows, mapping, { createCategories: req.body.createCategories !== false });
    await store.save();
    sessions.delete(req.body.token);
    res.json(report);
  }));

  // ---------- bulk photos ----------
  let photoIndex = null;
  let photoIndexVersion = -1;
  function getPhotoIndex() {
    if (!photoIndex || photoIndexVersion !== store.version) {
      photoIndex = buildPhotoIndex(store.data.products);
      photoIndexVersion = store.version;
    }
    return photoIndex;
  }

  app.get('/api/photos/notes', (req, res) => {
    const idx = getPhotoIndex();
    res.json({ shadowed: idx.shadowed.slice(0, 50), ambiguous: idx.ambiguous.slice(0, 50) });
  });

  // One photo per request so the browser can show progress and retry. Always 200 for expected outcomes.
  app.post('/api/photos/upload', raw, wrap(async (req, res) => {
    const filename = decodeURIComponent(String(req.headers['x-filename'] || ''));
    if (!filename) throw bad('Missing file name');
    const unsupported = checkSupported(filename);
    if (unsupported) return res.json({ status: 'failed', filename, message: unsupported });
    const hit = matchFile(getPhotoIndex(), filename);
    if (!hit) return res.json({ status: 'unmatched', filename, message: 'No product has this SKU or image filename' });
    const p = store.getProduct(hit.id);
    let processed;
    try { processed = await processPhoto(req.body, { share: hit.slot === 1 }); } catch { return res.json({ status: 'failed', filename, message: 'Not a readable image' }); }
    await store.setPhoto(p, hit.slot, processed);
    await store.save();
    res.json({ status: 'matched', filename, sku: hit.sku, slot: hit.slot, ambiguous: hit.ambiguous });
  }));

  // ---------- orders, stock and profit ----------
  // A failed order action keeps its HTTP status (409 = not enough stock, with the list of what is short).
  const orderFail = (e) => Object.assign(bad(e.message, e.status || 400), e.shortages ? { shortages: e.shortages } : {});
  const sendOrderError = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.shortages ? { shortages: e.shortages } : {}) });
  const orderRoute = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (!e.status || e.status >= 500) console.error(e);
    sendOrderError(res, e.status ? e : orderFail(e));
  });

  app.get('/api/orders', (req, res) => {
    const status = String(req.query.status || 'all');
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = store.data.orders;
    const counts = { pending: 0, approved: 0, cancelled: 0, all: list.length };
    for (const o of list) counts[o.status]++;
    if (status !== 'all') list = list.filter((o) => o.status === status);
    if (q) list = list.filter((o) => `${o.no} ${o.customer.name} ${o.customer.phone} ${o.items.map((l) => `${l.name} ${l.sku}`).join(' ')}`.toLowerCase().includes(q));
    const items = list.slice().sort((a, b) => b.no - a.no).slice(0, 300).map((o) => orders.present(store, o));
    res.json({ items, counts, shown: items.length, total: list.length });
  });

  app.get('/api/orders/:id', orderRoute((req, res) => res.json(orders.present(store, orders.findOrder(store, req.params.id)))));

  app.post('/api/orders', orderRoute(async (req, res) => {
    const o = orders.createOrder(store, req.body || {});
    await store.save();
    res.json(orders.present(store, o));
  }));

  // Paste a message from the shop's basket (or type the lines): the products are found by SKU and a pending order is made.
  app.post('/api/orders/from-text', orderRoute(async (req, res) => {
    const parsed = orders.parseOrderText(store, req.body && req.body.text);
    if (!parsed.items.length) throw bad('None of the SKUs in this message match a product. Check the codes: ' + parsed.unmatched.map((u) => u.sku).join(', '));
    const o = orders.createOrder(store, { source: 'whatsapp', customer: parsed.customer, items: parsed.items, payMethod: parsed.payMethod, trxId: parsed.trxId });
    await store.save();
    res.json({ order: orders.present(store, o), unmatched: parsed.unmatched });
  }));

  app.put('/api/orders/:id', orderRoute(async (req, res) => {
    const o = orders.updateOrder(store, req.params.id, req.body || {});
    await store.save();
    res.json(orders.present(store, o));
  }));

  // Record how and how much the customer paid. Works on pending and approved orders.
  app.put('/api/orders/:id/payment', orderRoute(async (req, res) => {
    const o = orders.setPayment(store, req.params.id, req.body || {});
    await store.save();
    res.json(orders.present(store, o));
  }));

  app.post('/api/orders/:id/approve', orderRoute(async (req, res) => {
    const { order, shortages } = orders.approveOrder(store, req.params.id, { allowShort: !!(req.body && req.body.allowShort) });
    await store.save();
    res.json({ order: orders.present(store, order), shortages });
  }));

  app.post('/api/orders/:id/cancel', orderRoute(async (req, res) => {
    const { order, restored } = orders.cancelOrder(store, req.params.id);
    await store.save();
    res.json({ order: orders.present(store, order), restored });
  }));

  app.delete('/api/orders/:id', orderRoute(async (req, res) => {
    orders.deleteOrder(store, req.params.id);
    await store.save();
    res.json({ ok: true });
  }));

  const range = (req) => ({ from: String(req.query.from || '') || undefined, to: String(req.query.to || '') || undefined });
  app.get('/api/summary', (req, res) => {
    res.json(orders.summarize(store, { ...range(req), tzOffset: Number(req.query.tz) || 0 }));
  });
  app.get('/api/orders.csv', (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="orders.csv"');
    res.type('text/csv').send('\ufeff' + orders.ordersCsv(store, { ...range(req), status: String(req.query.status || 'approved') }));
  });

  // ---------- invoices ----------
  async function sendInvoice(req, res, format) {
    const order = orders.findOrder(store, req.params.id);
    const pres = orders.present(store, order);
    const bytes = await renderInvoice(store, order, pres.totals, format);
    res.set('Content-Type', format === 'pdf' ? 'application/pdf' : 'image/png');
    res.set('Content-Disposition', `${req.query.view === '1' ? 'inline' : 'attachment'}; filename="${invoiceFileName(store.data.settings, order, format)}"`);
    res.send(bytes);
  }
  app.get('/api/orders/:id/invoice.pdf', orderRoute((req, res) => sendInvoice(req, res, 'pdf')));
  app.get('/api/orders/:id/invoice.png', orderRoute((req, res) => sendInvoice(req, res, 'png')));

  // ---------- backup of the shop data (products, orders, settings; photos are in the data folder) ----------
  app.get('/api/backup.json', wrap(async (req, res) => {
    await store.save();
    res.set('Content-Disposition', `attachment; filename="shop-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type('application/json').send(fs.readFileSync(store.file));
  }));

  // ---------- website update (it also happens by itself after every change) ----------
  app.post('/api/build', wrap(async (req, res) => {
    await store.save();
    const st = await publisher.run();
    if (st.state === 'error') throw bad(st.error || 'The website could not be updated', 500);
    res.json(publisher.last);
  }));

  // ---------- admin UI + product photos for the admin tables ----------
  app.use('/photos', express.static(store.imgDir, { maxAge: '1h' }));
  app.use(express.static(path.join(ROOT, 'admin')));

  app.locals.store = store;
  app.locals.publisher = publisher;
  app.locals.auth = auth;
  if (autoPublish) publisher.run();
  return app;
}

/**
 * The customer website: plain files from dist. Photos, styles and product data have names that change when they
 * change, so they are cached for a year; pages are checked again each time.
 */
function createSite(distDir, publisher) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', true);
  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    if (req.path === '/_headers') return res.status(404).end();
    next();
  });
  app.use(express.static(distDir, {
    maxAge: 0,
    setHeaders(res, file) {
      const rel = path.relative(distDir, file).split(path.sep)[0];
      if (rel === 'img' || rel === 'assets' || rel === 'data') res.set('Cache-Control', 'public, max-age=31536000, immutable');
      else res.set('Cache-Control', 'no-cache');
    },
  }));
  app.use((req, res) => {
    const f = path.join(distDir, '404.html');
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      res.status(503).set('Retry-After', '5').type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Getting ready</title><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h1>Our shop is getting ready</h1><p>Please refresh in a few seconds.</p>');
      return;
    }
    res.status(404);
    fs.existsSync(f) ? res.sendFile(f) : res.send('Not found');
  });
  void publisher;
  return app;
}
const createPreview = createSite;

function listen(app, port, label, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use (${label}). Close the other program or set PORT / PREVIEW_PORT.`));
      else reject(e);
    });
  });
}

async function start() {
  const port = parseInt(process.env.PORT, 10) || 3000;
  const previewPort = parseInt(process.env.PREVIEW_PORT, 10) || 3001;
  const distDir = path.resolve(process.env.DIST_DIR || path.join(ROOT, 'dist'));
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  const adminHost = String(process.env.ADMIN_HOST || '').trim().toLowerCase();
  const siteHost = String(process.env.SITE_HOST || '').trim().toLowerCase();
  const live = !!adminHost;
  const host = process.env.HOST || '127.0.0.1';
  const publicSiteUrl = process.env.SITE_URL || (siteHost ? `https://${siteHost}` : '');
  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

  const app = createApp({ dataDir, distDir, port, previewPort, live, adminHosts: live ? [adminHost] : null, publicSiteUrl, autoPublish: true, log });
  const { auth, publisher } = app.locals;
  if (process.env.ADMIN_PASSWORD && !auth.hasPassword()) {
    await auth.setPassword(process.env.ADMIN_PASSWORD);
    log('Admin password set from ADMIN_PASSWORD. You can delete that setting now; the password is kept (hashed) in the data folder.');
  }

  const servers = [];
  const site = createSite(distDir, publisher);
  if (live) {
    // One program, two addresses: the admin address shows the admin (password needed), everything else shows the shop.
    const router = express();
    router.disable('x-powered-by');
    if (process.env.TRUST_PROXY === '1') router.set('trust proxy', true);
    router.use((req, res, next) => (String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '') === adminHost ? app(req, res, next) : site(req, res, next)));
    servers.push(await listen(router, port, 'live', host));
    console.log(`\nLive mode on port ${port}.`);
    console.log(`Shop:  ${publicSiteUrl || '(set SITE_HOST)'}`);
    console.log(`Admin: https://${adminHost}   ${auth.hasPassword() ? '' : '(no password yet: run npm run set-password)'}\n`);
  } else {
    servers.push(await listen(app, port, 'admin'));
    servers.push(await listen(site, previewPort, 'website'));
    console.log(`\nAdmin panel:  http://localhost:${port}`);
    console.log(`Your website: http://localhost:${previewPort}  (updates by itself when you change something)`);
    console.log(`Website files: ${distDir}\n`);
  }
  const stop = async () => {
    publisher.stop();
    await app.locals.store.save();
    servers.forEach((sv) => sv.close());
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp, createPreview, createSite };
