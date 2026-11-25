'use strict';

/**
 * Orders, stock and profit. Everything here works on the store in memory; the caller saves afterwards.
 *
 * An order starts as "pending". Nothing happens to stock until the owner approves it, so he can
 * correct quantities and prices first. Approving takes the quantities out of every product that has a
 * stock quantity. Cancelling an approved order puts them back. The buying cost is private: it is never
 * written to the public site (the builder reads products field by field).
 */

const { cleanText, toAsciiDigits } = require('./util');
const { saleIsValid } = require('./pricing');

const MAX_LINES = 100;
const MAX_QTY = 9999;
const LOW_STOCK = 3;
const FIRST_NUMBER = 1001;

const isFilled = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const round2 = (n) => Math.round(n * 100) / 100;
const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});

/** Money typed by a human: blank means "not set" (null). */
function money(raw, what) {
  if (!isFilled(raw)) return null;
  const n = typeof raw === 'number' ? raw : Number(toAsciiDigits(raw).replace(/৳|tk\.?|,/gi, '').trim());
  if (!Number.isFinite(n) || n < 0) throw fail(`${what} must be a number, 0 or more`);
  return round2(n);
}

function quantity(raw, what) {
  const n = Number(toAsciiDigits(raw));
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw fail(`${what} must be a whole number from 1 to ${MAX_QTY}`);
  return n;
}

/** What the customer would pay now, ignoring the "show price" switch (the owner keeps his price list either way). */
function listPrice(p) {
  if (saleIsValid(p.price, p.salePrice)) return Number(p.salePrice);
  return p.price > 0 ? Number(p.price) : null;
}

function nextNumber(store) {
  let max = FIRST_NUMBER - 1;
  for (const o of store.data.orders) if (o.no > max) max = o.no;
  return max + 1;
}

function findOrder(store, id) {
  const o = store.data.orders.find((x) => x.id === id);
  if (!o) throw fail('Order not found', { status: 404 });
  return o;
}

function cleanCustomer(c) {
  const src = c && typeof c === 'object' ? c : {};
  return { name: cleanText(src.name, 100), phone: cleanText(src.phone, 40), address: cleanText(src.address, 300) };
}

/**
 * Turn the lines sent by the admin into stored lines. A product is found by id or SKU.
 * A price or cost key that is present but blank means "not set yet"; an absent key takes the product's value.
 * Lines for the same product are merged.
 */
function buildItems(store, list) {
  if (!Array.isArray(list) || !list.length) throw fail('Add at least one product to the order');
  if (list.length > MAX_LINES) throw fail(`An order can have at most ${MAX_LINES} lines`);
  const byProduct = new Map();
  for (const raw of list) {
    const ref = raw && (raw.productId || raw.sku);
    const p = (raw && raw.productId && store.getProduct(raw.productId)) || (raw && raw.sku && store.findBySku(raw.sku)) || null;
    if (!p) throw fail(`Product "${ref || '?'}" was not found. Remove that line.`);
    const qty = quantity(raw.qty === undefined ? 1 : raw.qty, `Quantity of ${p.name}`);
    const price = 'price' in raw ? money(raw.price, `Price of ${p.name}`) : listPrice(p);
    const cost = 'cost' in raw ? money(raw.cost, `Buying cost of ${p.name}`) : (p.cost ?? null);
    const have = byProduct.get(p.id);
    if (have) have.qty = Math.min(MAX_QTY, have.qty + qty);
    else byProduct.set(p.id, { productId: p.id, sku: p.sku, name: p.name, qty, price, cost });
  }
  return [...byProduct.values()];
}

const PAY_METHODS = ['cod', 'bkash', 'bank'];
/** "Cash on delivery", "bKash", "Bank transfer" typed or pasted by a customer, to one of PAY_METHODS (or ''). */
function payMethodOf(v) {
  const t = String(v == null ? '' : v).toLowerCase();
  if (PAY_METHODS.includes(t)) return t;
  if (/bkash|বিকাশ/.test(t)) return 'bkash';
  if (/bank|account|ব্যাংক/.test(t)) return 'bank';
  if (/cash|cod|delivery|ক্যাশ/.test(t)) return 'cod';
  return '';
}
function applyPayment(order, input) {
  if ('payMethod' in input) order.payMethod = payMethodOf(input.payMethod);
  if ('trxId' in input) order.trxId = cleanText(input.trxId, 60).replace(/\n/g, ' ');
  if ('paid' in input) order.paid = money(input.paid, 'Amount paid') ?? 0;
}
function applyFields(store, order, input) {
  if ('customer' in input) order.customer = cleanCustomer(input.customer);
  if ('note' in input) order.note = cleanText(input.note, 500);
  if ('discount' in input) order.discount = money(input.discount, 'Discount') ?? 0;
  if ('deliveryFee' in input) order.deliveryFee = money(input.deliveryFee, 'Delivery fee') ?? 0;
  if ('items' in input) order.items = buildItems(store, input.items);
  applyPayment(order, input);
  if (order.discount > totals(order).subtotal) throw fail('The discount cannot be more than the items total');
}

/** Money figures of one order. Profit counts only lines that have a buying cost; the rest is reported separately. */
function totals(o) {
  let subtotal = 0, items = 0;
  for (const l of o.items) { subtotal += (l.price || 0) * l.qty; items += l.qty; }
  subtotal = round2(subtotal);
  const discount = Math.min(round2(o.discount || 0), subtotal);
  const net = round2(subtotal - discount);
  const factor = subtotal > 0 ? net / subtotal : 1; // the order discount is shared out across the lines
  let knownNet = 0, cost = 0, unknownNet = 0, unknownLines = 0, unpriced = 0;
  for (const l of o.items) {
    if (l.price === null || l.price === undefined) unpriced++;
    const lineNet = (l.price || 0) * l.qty * factor;
    if (l.cost === null || l.cost === undefined) { unknownNet += lineNet; unknownLines++; }
    else { knownNet += lineNet; cost += l.cost * l.qty; }
  }
  return {
    subtotal, discount, net, deliveryFee: round2(o.deliveryFee || 0), total: round2(net + (o.deliveryFee || 0)), items, unpriced,
    paid: round2(o.paid || 0), due: Math.max(0, round2(round2(net + (o.deliveryFee || 0)) - (o.paid || 0))),
    cost: round2(cost), profit: round2(knownNet - cost), knownNet: round2(knownNet), unknownNet: round2(unknownNet), unknownLines,
  };
}

function createOrder(store, input) {
  const now = new Date().toISOString();
  const no = nextNumber(store);
  const order = {
    id: `o${no}`, no, status: 'pending', source: input.source === 'whatsapp' ? 'whatsapp' : 'manual',
    createdAt: now, updatedAt: now, approvedAt: null, cancelledAt: null,
    customer: cleanCustomer(input.customer), note: cleanText(input.note, 500), discount: 0, deliveryFee: 0, payMethod: '', paid: 0, trxId: '', items: [], stockApplied: [], shortages: [],
  };
  applyFields(store, order, { discount: input.discount, deliveryFee: input.deliveryFee, items: input.items, payMethod: input.payMethod, paid: input.paid, trxId: input.trxId });
  store.data.orders.push(order);
  return order;
}

/** Payment can be recorded at any time, also after the order is approved (the rest of an approved order is locked). */
function setPayment(store, id, patch) {
  const o = findOrder(store, id);
  if (o.status === 'cancelled') throw fail('This order is cancelled.');
  const next = { payMethod: o.payMethod, paid: o.paid, trxId: o.trxId };
  applyPayment(next, patch || {});
  Object.assign(o, next, { updatedAt: new Date().toISOString() });
  return o;
}
function updateOrder(store, id, patch) {
  const o = findOrder(store, id);
  if (o.status !== 'pending') throw fail('Only a pending order can be changed. Cancel it and enter a new one instead.');
  const next = JSON.parse(JSON.stringify(o));
  applyFields(store, next, patch || {});
  Object.assign(o, next, { updatedAt: new Date().toISOString() });
  return o;
}

/**
 * Approve: checks the order, then takes the quantities out of stock (only for products with a stock quantity).
 * Not enough stock stops the approval with a 409 that lists what is short, unless allowShort is set; then
 * only what is there is taken and stock becomes 0.
 */
function approveOrder(store, id, { allowShort = false } = {}) {
  const o = findOrder(store, id);
  if (o.status !== 'pending') throw fail(`This order is already ${o.status}.`, { status: 409 });
  const lines = [];
  for (const l of o.items) {
    const p = store.getProduct(l.productId);
    if (!p) throw fail(`"${l.name}" is no longer in your product list. Remove it from the order first.`);
    if (l.price === null || l.price === undefined) throw fail(`Enter a price for "${l.name}" first.`);
    lines.push({ l, p });
  }
  // Total needed per product, in case a product is on several lines.
  const need = new Map();
  for (const { l } of lines) need.set(l.productId, (need.get(l.productId) || 0) + l.qty);
  const shortages = [];
  for (const [productId, qty] of need) {
    const p = store.getProduct(productId);
    if (p.stockQty !== null && p.stockQty !== undefined && qty > p.stockQty) shortages.push({ sku: p.sku, name: p.name, have: p.stockQty, need: qty });
  }
  if (shortages.length && !allowShort) {
    throw fail(`Not enough stock for ${shortages.map((s) => `${s.name} (have ${s.have}, need ${s.need})`).join(', ')}.`, { status: 409, shortages });
  }
  const applied = [];
  const now = new Date().toISOString();
  for (const [productId, qty] of need) {
    const p = store.getProduct(productId);
    if (p.stockQty === null || p.stockQty === undefined) continue;
    const take = Math.min(qty, p.stockQty);
    p.stockQty -= take;
    p.inStock = p.stockQty > 0;
    p.updatedAt = now;
    applied.push({ productId, qty: take });
  }
  for (const { l, p } of lines) if (l.cost === null || l.cost === undefined) l.cost = p.cost ?? null;
  o.stockApplied = applied;
  o.shortages = shortages;
  o.status = 'approved';
  o.approvedAt = now;
  o.updatedAt = now;
  return { order: o, shortages };
}

/** Pending: just cancelled. Approved: cancelled and the stock it took goes back. */
function cancelOrder(store, id) {
  const o = findOrder(store, id);
  if (o.status === 'cancelled') throw fail('This order is already cancelled.', { status: 409 });
  const now = new Date().toISOString();
  let restored = 0;
  if (o.status === 'approved') {
    for (const a of o.stockApplied || []) {
      const p = store.getProduct(a.productId);
      if (!p || p.stockQty === null || p.stockQty === undefined) continue;
      p.stockQty += a.qty;
      p.inStock = p.stockQty > 0;
      p.updatedAt = now;
      restored += a.qty;
    }
  }
  o.status = 'cancelled';
  o.cancelledAt = now;
  o.updatedAt = now;
  return { order: o, restored };
}

function deleteOrder(store, id) {
  const o = findOrder(store, id);
  if (o.status === 'approved') throw fail('An approved order cannot be deleted. Cancel it first (the stock goes back).');
  store.data.orders = store.data.orders.filter((x) => x.id !== id);
  return true;
}

/**
 * Read an order message sent from the shop's basket. Lines look like
 *   1. PLA+ Filament 1.75mm 1kg - Black (SKU: FIL-PLA-BLK)
 *      2 × ৳1,450 = ৳2,900
 * Customers may edit the message, so this only relies on "SKU: code" and a "2 ×" (or "2 x") nearby.
 */
function parseOrderText(store, text) {
  const lines = toAsciiDigits(String(text || '').replace(/\r\n?/g, '\n')).split('\n');
  const found = [], unmatched = [];
  const customer = { name: '', phone: '', address: '' };
  const pay = { payMethod: '', trxId: '' };
  lines.forEach((line, i) => {
    const m = line.match(/SKU\s*[:：]\s*([^)\n]+)/i);
    if (m) {
      const sku = m[1].trim();
      let qty = 1;
      const same = line.match(/^\s*(\d{1,4})\s*[×x✕*]\s+\S/i);
      const next = [lines[i + 1], lines[i + 2]].map((l) => (l || '').match(/^\s*(\d{1,4})\s*[×x✕*]/i)).find(Boolean);
      if (same) qty = Number(same[1]);
      else if (next) qty = Number(next[1]);
      qty = Math.max(1, Math.min(MAX_QTY, qty));
      if (store.findBySku(sku)) found.push({ sku, qty });
      else unmatched.push({ sku, line: line.trim() });
      return;
    }
    const payLine = line.match(/^\s*(?:payment(?:\s+method)?|pay\s*by)\s*[:：]\s*(.+?)\s*$/i);
    if (payLine) {
      if (!pay.payMethod) pay.payMethod = payMethodOf(payLine[1]);
      const t = payLine[1].match(/(?:trx\s*id|txn\s*id|transaction\s*id|ref(?:erence)?)\s*[:：-]?\s*([A-Za-z0-9]{4,30})/i);
      if (t && !pay.trxId) pay.trxId = t[1];
      return;
    }
    const trx = line.match(/^\s*(?:trx\s*id|txn\s*id|transaction\s*id)\s*[:：]\s*([A-Za-z0-9]{4,30})\s*$/i);
    if (trx) { if (!pay.trxId) pay.trxId = trx[1]; return; }
    const field = line.match(/^\s*(?:my\s+|customer\s+)?(name|phone|mobile|contact|delivery address|address)\s*[:：]\s*(.+?)\s*$/i);
    if (field) {
      const key = /^name$/i.test(field[1]) ? 'name' : /address/i.test(field[1]) ? 'address' : 'phone';
      if (!customer[key]) customer[key] = field[2];
    }
  });
  if (!found.length && !unmatched.length) {
    throw fail('No products found in this message. A message from your shop has lines like "(SKU: FIL-PLA-BLK)".');
  }
  return { items: found, unmatched, customer, ...pay };
}

/**
 * Profit summary of the approved orders whose approval time is in [from, to). Times are ISO strings.
 * tzOffset = minutes behind UTC as the browser reports them (Bangladesh: -360), so days are the owner's days.
 */
function summarize(store, { from, to, tzOffset = 0 } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const off = Number.isFinite(Number(tzOffset)) ? Number(tzOffset) : 0;
  const dayKey = (ms) => new Date(ms - off * 60000).toISOString().slice(0, 10);
  const catOf = (productId) => {
    const p = store.getProduct(productId);
    const slug = (p && p.category) || '';
    const c = slug ? store.findCategory(slug) : null;
    return { slug, name: c ? c.name : 'No category' };
  };

  const t = { orders: 0, items: 0, revenue: 0, cost: 0, profit: 0, knownNet: 0, unknownNet: 0, unknownLines: 0 };
  const days = new Map(), top = new Map(), cats = new Map();
  for (const o of store.data.orders) {
    if (o.status !== 'approved') continue;
    const ms = Date.parse(o.approvedAt);
    if (!(ms >= fromMs && ms < toMs)) continue;
    const ot = totals(o);
    t.orders++;
    t.items += ot.items;
    t.revenue += ot.net;
    t.cost += ot.cost;
    t.profit += ot.profit;
    t.knownNet += ot.knownNet;
    t.unknownNet += ot.unknownNet;
    t.unknownLines += ot.unknownLines;
    const d = days.get(dayKey(ms)) || { date: dayKey(ms), orders: 0, revenue: 0, profit: 0 };
    d.orders++; d.revenue += ot.net; d.profit += ot.profit;
    days.set(d.date, d);
    const factor = ot.subtotal > 0 ? ot.net / ot.subtotal : 1;
    for (const l of o.items) {
      const lineNet = (l.price || 0) * l.qty * factor;
      const known = l.cost !== null && l.cost !== undefined;
      const profit = known ? lineNet - l.cost * l.qty : 0;
      const tp = top.get(l.productId) || { productId: l.productId, sku: l.sku, name: l.name, qty: 0, revenue: 0, profit: 0, unknownCost: false };
      tp.qty += l.qty; tp.revenue += lineNet; tp.profit += profit; if (!known) tp.unknownCost = true;
      top.set(l.productId, tp);
      const c = catOf(l.productId);
      const cg = cats.get(c.slug) || { slug: c.slug, name: c.name, qty: 0, revenue: 0, profit: 0 };
      cg.qty += l.qty; cg.revenue += lineNet; cg.profit += profit;
      cats.set(c.slug, cg);
    }
  }
  const r = (x) => round2(x);
  const rows = (m) => [...m.values()].map((x) => ({ ...x, revenue: r(x.revenue), profit: r(x.profit) }));
  const pending = store.data.orders.filter((o) => o.status === 'pending');
  const tracked = store.data.products.filter((p) => p.stockQty !== null && p.stockQty !== undefined);
  let atCost = 0, withoutCost = 0;
  for (const p of tracked) { if (p.cost === null || p.cost === undefined) { if (p.stockQty > 0) withoutCost++; } else atCost += p.stockQty * p.cost; }
  return {
    totals: {
      orders: t.orders, items: t.items, revenue: r(t.revenue), cost: r(t.cost), profit: r(t.profit),
      margin: t.knownNet > 0 ? Math.round((t.profit / t.knownNet) * 1000) / 10 : null,
      unknownNet: r(t.unknownNet), unknownLines: t.unknownLines,
    },
    days: rows(days).sort((a, b) => (a.date < b.date ? -1 : 1)),
    topProducts: rows(top).sort((a, b) => b.profit - a.profit || b.revenue - a.revenue).slice(0, 10),
    byCategory: rows(cats).sort((a, b) => b.revenue - a.revenue),
    pending: { count: pending.length, value: r(pending.reduce((s, o) => s + totals(o).total, 0)) },
    lowStock: tracked.filter((p) => p.stockQty <= LOW_STOCK).sort((a, b) => a.stockQty - b.stockQty).slice(0, 15)
      .map((p) => ({ id: p.id, sku: p.sku, name: p.name, stockQty: p.stockQty })),
    stock: { tracked: tracked.length, valueAtCost: r(atCost), withoutCost, lowLimit: LOW_STOCK },
    productsWithoutCost: store.data.products.filter((p) => p.cost === null || p.cost === undefined).length,
  };
}

/** Orders as a CSV, one line per product, for the accountant. Cells that could act as spreadsheet formulas are defused. */
function ordersCsv(store, { from, to, status = 'approved' } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const safe = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s.-]+$/.test(s))) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Order', 'Status', 'Date', 'Customer', 'Phone', 'SKU', 'Product', 'Qty', 'Unit price', 'Unit cost', 'Line total', 'Order discount', 'Delivery fee'];
  const out = [head.join(',')];
  const list = store.data.orders.filter((o) => (status === 'all' || o.status === status) && (() => {
    const ms = Date.parse(o.status === 'approved' ? o.approvedAt : o.createdAt);
    return ms >= fromMs && ms < toMs;
  })());
  for (const o of list) {
    const date = (o.status === 'approved' ? o.approvedAt : o.createdAt).slice(0, 16).replace('T', ' ') + ' UTC';
    for (const l of o.items) {
      out.push([o.no, o.status, date, o.customer.name, o.customer.phone, l.sku, l.name, l.qty, l.price ?? '', l.cost ?? '', round2((l.price || 0) * l.qty), o.discount || 0, o.deliveryFee || 0].map(safe).join(','));
    }
  }
  return out.join('\r\n') + '\r\n';
}

/** The order with its money figures, as the admin screens want it. */
function present(store, o) {
  const t = totals(o);
  return {
    ...o,
    totals: t,
    items: o.items.map((l) => {
      const p = store.getProduct(l.productId);
      return { ...l, missing: !p, stockQty: p && p.stockQty !== undefined ? p.stockQty : null };
    }),
  };
}

module.exports = {
  LOW_STOCK, listPrice, totals, createOrder, updateOrder, approveOrder, cancelOrder, deleteOrder, findOrder,
  parseOrderText, summarize, ordersCsv, present, setPayment, payMethodOf, PAY_METHODS,
};
