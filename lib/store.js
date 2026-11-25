'use strict';

const fs = require('fs');
const path = require('path');
const { slugify, normalizeWhatsApp, normalizeSiteUrl, cleanText, cleanLink } = require('./util');
const { shortHash } = require('./images');
const { saleIsValid } = require('./pricing');
const { MAX_FILTERS, cleanFacetText } = require('./facets');

const isFilled = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const round2 = (n) => Math.round(n * 100) / 100;

/** A discount price: blank means none. Must be above 0 and lower than the price. */
function parseSale(price, raw) {
  if (!isFilled(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Discount price must be a number above 0');
  if (!(price > 0)) throw new Error('Set the price first. The discount price must be lower than the price');
  if (n >= price) throw new Error('Discount price must be lower than the price');
  return round2(n);
}

/** Buying cost: private, optional. Blank means "not recorded". */
function parseCost(raw) {
  if (!isFilled(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error('Buying cost must be a number, 0 or more');
  return round2(n);
}

/** Stock quantity: blank means "not tracked" (only the in-stock switch is used). */
function parseQty(raw) {
  if (!isFilled(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10000000) throw new Error('Stock quantity must be a whole number, 0 or more');
  return n;
}

const NEEDS_PRICE = 'Enter a price, or turn off "Show price" so customers ask you on WhatsApp';

const DEFAULT_SETTINGS = {
  businessName: 'My Shop',
  heroTitle: 'Quality products, delivered across Bangladesh',
  heroSubtitle: 'Browse our catalog and order instantly on WhatsApp.',
  whatsapp: '',
  waGreeting: "Hello! I'd like to order:",
  phone: '',
  email: '',
  address: '',
  mapUrl: '',
  hours: '',
  tagline: '',
  siteUrl: '',
  accentColor: '#6d28d9',
  invoicePrefix: 'INV-',
  taxId: '',
  codEnabled: true,
  bkashNumber: '',
  bankInfo: '',
  stamp: null,
  invoiceTerms: '',
  facebook: '',
  instagram: '',
  youtube: '',
  tiktok: '',
  logo: null,
};

const TEXT_SETTINGS = [
  'businessName', 'heroTitle', 'heroSubtitle', 'waGreeting', 'phone', 'email', 'address', 'hours', 'tagline',
];
const LINK_SETTINGS = ['facebook', 'instagram', 'youtube', 'tiktok', 'mapUrl'];

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    this.imgDir = path.join(dir, 'images');
    this.version = 0; // bumped when SKUs / import filenames change (photo index cache key)
    this._dirty = false;
    this._saving = null;
    this._load();
  }

  _load() {
    fs.mkdirSync(this.imgDir, { recursive: true });
    let data = {};
    if (fs.existsSync(this.file)) data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      categories: Array.isArray(data.categories) ? data.categories : [],
      products: Array.isArray(data.products) ? data.products : [],
      orders: Array.isArray(data.orders) ? data.orders : [],
    };
    for (const c of this.data.categories) if (!Array.isArray(c.filters)) c.filters = [];
    for (const p of this.data.products) {
      if (!p.attrs || typeof p.attrs !== 'object') p.attrs = {};
      if (p.cost === undefined) p.cost = null;
      if (p.stockQty === undefined) p.stockQty = null;
    }
    this._reindex();
  }

  _reindex() {
    this._bySku = new Map();
    this._byId = new Map();
    for (const p of this.data.products) {
      this._bySku.set(p.sku.trim().toLowerCase(), p);
      this._byId.set(p.id, p);
    }
    this.version++;
  }

  /** Coalescing atomic save. Resolves when the latest state is on disk. */
  save() {
    this._dirty = true;
    if (!this._saving) this._saving = this._flushLoop();
    return this._saving;
  }

  async _flushLoop() {
    try {
      while (this._dirty) {
        this._dirty = false;
        const tmp = this.file + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(this.data));
        await fs.promises.rename(tmp, this.file);
      }
    } finally {
      this._saving = null;
    }
  }

  backup(label = 'manual') {
    if (!fs.existsSync(this.file)) return null;
    const dir = path.join(this.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `store-${stamp}-${label}.json`);
    fs.copyFileSync(this.file, dest);
    const all = fs.readdirSync(dir).filter((f) => f.startsWith('store-')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 20))) fs.unlinkSync(path.join(dir, f));
    return dest;
  }

  // ---------- settings ----------
  updateSettings(patch) {
    const s = this.data.settings;
    for (const k of TEXT_SETTINGS) if (k in patch) s[k] = cleanText(patch[k], 300);
    for (const k of LINK_SETTINGS) if (k in patch) s[k] = cleanLink(patch[k]);
    if ('invoicePrefix' in patch) s.invoicePrefix = String(patch.invoicePrefix == null ? '' : patch.invoicePrefix).replace(/[^A-Za-z0-9\-_/]/g, '').slice(0, 12);
    if ('taxId' in patch) s.taxId = cleanText(patch.taxId, 40).replace(/\n/g, ' ');
    if ('codEnabled' in patch) s.codEnabled = patch.codEnabled === true || patch.codEnabled === 'true' || patch.codEnabled === 'on' || patch.codEnabled === '1';
    if ('bkashNumber' in patch) s.bkashNumber = cleanText(patch.bkashNumber, 80).replace(/\n/g, ' ');
    for (const k of ['bankInfo', 'invoiceTerms']) {
      if (k in patch) s[k] = cleanText(patch[k], 600).split('\n').slice(0, 8).join('\n');
    }
    if ('whatsapp' in patch) s.whatsapp = normalizeWhatsApp(patch.whatsapp);
    if ('siteUrl' in patch) s.siteUrl = normalizeSiteUrl(patch.siteUrl);
    if ('accentColor' in patch && /^#[0-9a-f]{6}$/i.test(String(patch.accentColor))) s.accentColor = patch.accentColor.toLowerCase();
    if (!s.businessName) s.businessName = DEFAULT_SETTINGS.businessName;
    return s;
  }

  async setLogo(webpBuffer) {
    const name = `logo.${shortHash(webpBuffer)}.webp`;
    await fs.promises.writeFile(path.join(this.imgDir, name), webpBuffer);
    this._unlink(this.data.settings.logo, name);
    this.data.settings.logo = name;
  }

  removeLogo() {
    this._unlink(this.data.settings.logo);
    this.data.settings.logo = null;
  }

  /** The stamp / signature picture printed on invoices. It is never put on the website. */
  async setStamp(webpBuffer) {
    const name = `stamp.${shortHash(webpBuffer)}.webp`;
    await fs.promises.writeFile(path.join(this.imgDir, name), webpBuffer);
    this._unlink(this.data.settings.stamp, name);
    this.data.settings.stamp = name;
  }

  removeStamp() {
    this._unlink(this.data.settings.stamp);
    this.data.settings.stamp = null;
  }

  // ---------- categories ----------
  findCategory(slug) {
    return this.data.categories.find((c) => c.slug === slug) || null;
  }

  ensureCategory(name) {
    const clean = cleanText(name, 100);
    if (!clean) return null;
    const lower = clean.toLowerCase();
    const found = this.data.categories.find((c) => c.name.toLowerCase() === lower || c.slug === slugify(clean));
    if (found) return found;
    let slug = slugify(clean);
    const taken = new Set(this.data.categories.map((c) => c.slug));
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(clean)}-${i}`;
    const cat = { slug, name: clean, filters: [] };
    this.data.categories.push(cat);
    return cat;
  }

  renameCategory(slug, name) {
    const c = this.findCategory(slug);
    const clean = cleanText(name, 100);
    if (!c || !clean) return null;
    c.name = clean;
    return c;
  }

  deleteCategory(slug) {
    const before = this.data.categories.length;
    this.data.categories = this.data.categories.filter((c) => c.slug !== slug);
    for (const p of this.data.products) if (p.category === slug) p.category = null;
    return this.data.categories.length !== before;
  }

  /**
   * Replace a category's filter groups. Items are labels or { key, label }. A label that already exists keeps
   * its key (and so its product values); a group left out is removed and its values are deleted from products.
   * Returns { category, removed: [labels], valuesLost }.
   */
  setCategoryFilters(slug, list) {
    const c = this.findCategory(slug);
    if (!c) throw new Error('Unknown category');
    if (!Array.isArray(list)) throw new Error('Filters must be a list');
    const next = [];
    const used = new Set();
    for (const item of list) {
      const label = cleanFacetText(typeof item === 'string' ? item : item && item.label, 40);
      if (!label || next.some((n) => n.label.toLowerCase() === label.toLowerCase())) continue;
      const byKey = item && typeof item === 'object' && item.key ? c.filters.find((f) => f.key === item.key) : null;
      const existing = byKey || c.filters.find((f) => f.label.toLowerCase() === label.toLowerCase());
      let key;
      if (existing && !used.has(existing.key)) key = existing.key;
      else {
        const base = slugify(label) || 'filter';
        key = base;
        for (let i = 2; used.has(key) || c.filters.some((f) => f.key === key && !(existing && f === existing)); i++) key = `${base}-${i}`;
      }
      used.add(key);
      next.push({ key, label });
    }
    if (next.length > MAX_FILTERS) throw new Error(`At most ${MAX_FILTERS} filters per category`);
    const removed = c.filters.filter((f) => !used.has(f.key));
    let valuesLost = 0;
    for (const f of removed) {
      for (const p of this.data.products) {
        if (p.category === slug && p.attrs && p.attrs[f.key] !== undefined) {
          if (cleanFacetText(p.attrs[f.key])) valuesLost++;
          delete p.attrs[f.key];
        }
      }
    }
    c.filters = next;
    return { category: c, removed: removed.map((f) => f.label), valuesLost };
  }

  /** Find a filter by label in a category, adding it when missing. Returns its key, or null when the limit is reached. */
  ensureFilter(slug, label) {
    const c = this.findCategory(slug);
    const clean = cleanFacetText(label, 40);
    if (!c || !clean) return null;
    const found = c.filters.find((f) => f.label.toLowerCase() === clean.toLowerCase());
    if (found) return found.key;
    if (c.filters.length >= MAX_FILTERS) return null;
    const base = slugify(clean) || 'filter';
    let key = base;
    for (let i = 2; c.filters.some((f) => f.key === key); i++) key = `${base}-${i}`;
    c.filters.push({ key, label: clean });
    return key;
  }

  /** Values already used, per category and filter, for suggestions: { categorySlug: { key: ['Black', 'White'] } }. */
  filterOptions() {
    const out = {};
    for (const c of this.data.categories) {
      out[c.slug] = {};
      for (const f of c.filters) out[c.slug][f.key] = new Set();
    }
    for (const p of this.data.products) {
      const o = p.category && out[p.category];
      if (!o) continue;
      for (const [k, v] of Object.entries(p.attrs || {})) if (o[k] && cleanFacetText(v)) o[k].add(cleanFacetText(v));
    }
    for (const slug of Object.keys(out)) for (const k of Object.keys(out[slug])) out[slug][k] = [...out[slug][k]].sort((a, b) => a.localeCompare(b));
    return out;
  }

  /** Same spelling as an existing value in this category ("black" becomes "Black"), so filters never split in two. */
  _canonicalValue(catSlug, key, value, selfId) {
    const lower = value.toLowerCase();
    for (const p of this.data.products) {
      if (p.category !== catSlug || p.id === selfId) continue;
      const v = p.attrs && p.attrs[key];
      if (v && cleanFacetText(v).toLowerCase() === lower) return cleanFacetText(v);
    }
    return value;
  }

  /**
   * Validate and merge filter values for a product in a category. Pure: returns the new attrs object.
   * Values of filters the category does not have are dropped (a product moved to another category starts clean).
   */
  _computeAttrs(catSlug, current, patch, selfId) {
    const c = catSlug ? this.findCategory(catSlug) : null;
    const keys = new Set((c ? c.filters : []).map((f) => f.key));
    const entries = Object.entries(patch || {});
    if (!c && entries.some(([, v]) => cleanFacetText(v))) throw new Error('Pick a category first, then fill in its filter values');
    const next = {};
    for (const [k, v] of Object.entries(current || {})) if (keys.has(k) && cleanFacetText(v)) next[k] = cleanFacetText(v);
    for (const [k, v] of entries) {
      const val = cleanFacetText(v);
      if (!keys.has(k)) {
        if (!val) continue;
        throw new Error(`"${k}" is not a filter of this category`);
      }
      if (!val) delete next[k];
      else next[k] = this._canonicalValue(catSlug, k, val, selfId);
    }
    return next;
  }

  reorderCategories(slugs) {
    const by = new Map(this.data.categories.map((c) => [c.slug, c]));
    const next = [];
    for (const s of slugs) if (by.has(s)) { next.push(by.get(s)); by.delete(s); }
    for (const c of by.values()) next.push(c);
    this.data.categories = next;
  }

  // ---------- products ----------
  findBySku(sku) {
    return this._bySku.get(String(sku).trim().toLowerCase()) || null;
  }

  getProduct(id) {
    return this._byId.get(id) || null;
  }

  _uniqueId(base) {
    let id = base;
    for (let i = 2; this._byId.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  addProduct(fields) {
    const sku = cleanText(fields.sku, 100);
    const name = cleanText(fields.name, 200);
    if (!sku) throw new Error('SKU is required');
    if (!name) throw new Error('Name is required');
    if (this.findBySku(sku)) throw new Error(`SKU "${sku}" already exists`);
    const showPrice = fields.showPrice !== false;
    let price = 0;
    if (isFilled(fields.price)) {
      price = Number(fields.price);
      if (!Number.isFinite(price) || price < 0) throw new Error('Price must be a number, 0 or more');
      price = round2(price);
    }
    if (showPrice && !(price > 0)) throw new Error(NEEDS_PRICE);
    const salePrice = parseSale(price, fields.salePrice);
    const categorySlug = fields.category && this.findCategory(fields.category) ? fields.category : null;
    const cost = parseCost(fields.cost);
    const stockQty = parseQty(fields.stockQty);
    const id = this._uniqueId(slugify(sku));
    const attrs = this._computeAttrs(categorySlug, {}, fields.attrs, id);
    const now = new Date().toISOString();
    const p = {
      id,
      sku,
      name,
      price,
      showPrice,
      salePrice,
      category: categorySlug,
      attrs,
      description: cleanText(fields.description, 5000),
      cost,
      stockQty,
      // A product with a stock quantity is in stock exactly when the quantity is above 0.
      inStock: stockQty !== null ? stockQty > 0 : fields.inStock !== false,
      visible: fields.visible !== false,
      featured: fields.featured === true,
      images: [null, null],
      imageNames: [fields.imageNames?.[0] || null, fields.imageNames?.[1] || null],
      createdAt: now,
      updatedAt: now,
    };
    this.data.products.push(p);
    this._bySku.set(sku.toLowerCase(), p);
    this._byId.set(p.id, p);
    this.version++;
    return p;
  }

  /**
   * Patch editable fields. Returns the product. Throws on invalid input, before changing anything.
   * Anything worth telling the owner (for example a discount removed automatically) is pushed to notes.
   */
  updateProduct(id, patch, notes = []) {
    const p = this.getProduct(id);
    if (!p) throw new Error('Product not found');

    // Price, price switch and discount are checked together first, so a bad value changes nothing.
    const nextShow = 'showPrice' in patch ? !!patch.showPrice : p.showPrice !== false;
    let nextPrice = p.price;
    if ('price' in patch) {
      nextPrice = isFilled(patch.price) ? Number(patch.price) : 0;
      if (!Number.isFinite(nextPrice) || nextPrice < 0) throw new Error('Price must be a number, 0 or more');
      nextPrice = round2(nextPrice);
    }
    let nextSale = p.salePrice ?? null;
    if ('salePrice' in patch) nextSale = parseSale(nextPrice, patch.salePrice);
    else if (nextSale !== null && !saleIsValid(nextPrice, nextSale)) {
      if ('price' in patch) notes.push('The old discount price was removed because it is no longer lower than the price.');
      nextSale = null;
    }
    if (('showPrice' in patch || 'price' in patch) && nextShow && !(nextPrice > 0)) throw new Error(NEEDS_PRICE);
    if ('category' in patch && patch.category && !this.findCategory(patch.category)) throw new Error('Unknown category');
    const nextCategory = 'category' in patch ? patch.category || null : p.category;
    let nextAttrs = p.attrs || {};
    if ('attrs' in patch || ('category' in patch && nextCategory !== p.category)) {
      const before = nextAttrs;
      nextAttrs = this._computeAttrs(nextCategory, before, patch.attrs, p.id);
      if (nextCategory !== p.category) {
        const lost = Object.keys(before).filter((k) => !(k in nextAttrs) && !(patch.attrs && k in patch.attrs));
        if (lost.length) notes.push('Filter values were cleared because the category changed. Fill in the new category\'s filters.');
      }
    }
    let nextName = p.name;
    if ('name' in patch) {
      nextName = cleanText(patch.name, 200);
      if (!nextName) throw new Error('Name is required');
    }
    let nextSku = p.sku;
    if ('sku' in patch) {
      nextSku = cleanText(patch.sku, 100);
      if (!nextSku) throw new Error('SKU is required');
      const other = this.findBySku(nextSku);
      if (other && other.id !== p.id) throw new Error(`SKU "${nextSku}" already exists`);
    }

    const nextCost = 'cost' in patch ? parseCost(patch.cost) : p.cost ?? null;
    let nextQty = 'stockQty' in patch ? parseQty(patch.stockQty) : p.stockQty ?? null;
    let nextInStock = 'inStock' in patch ? !!patch.inStock : p.inStock;
    if (nextQty !== null) {
      if (!('stockQty' in patch) && 'inStock' in patch) {
        // The in-stock switch on a product with a quantity: "no" sets the quantity to 0; "yes" cannot invent a quantity.
        if (!nextInStock) nextQty = 0;
        else if (nextQty === 0) notes.push('This product has a stock quantity of 0, so it stays out of stock. Enter the quantity you have.');
      }
      nextInStock = nextQty > 0;
    }

    if (nextSku !== p.sku) {
      this._bySku.delete(p.sku.trim().toLowerCase());
      p.sku = nextSku;
      this._bySku.set(nextSku.toLowerCase(), p);
      this.version++;
    }
    p.name = nextName;
    p.price = nextPrice;
    p.showPrice = nextShow;
    p.salePrice = nextSale;
    if ('category' in patch) p.category = patch.category || null;
    p.attrs = nextAttrs;
    if ('description' in patch) p.description = cleanText(patch.description, 5000);
    for (const k of ['visible', 'featured']) if (k in patch) p[k] = !!patch[k];
    p.cost = nextCost;
    p.stockQty = nextQty;
    p.inStock = nextInStock;
    if ('imageNames' in patch && Array.isArray(patch.imageNames)) {
      p.imageNames = [patch.imageNames[0] || null, patch.imageNames[1] || null];
      this.version++;
    }
    p.updatedAt = new Date().toISOString();
    return p;
  }

  deleteProduct(id) {
    const p = this.getProduct(id);
    if (!p) return false;
    for (const img of p.images) this._unlink(img);
    this.data.products = this.data.products.filter((x) => x.id !== id);
    this._bySku.delete(p.sku.trim().toLowerCase());
    this._byId.delete(id);
    this.version++;
    return true;
  }

  // ---------- photos ----------
  async setPhoto(product, slot, processed) {
    const idx = slot - 1;
    const hash = shortHash(processed.full);
    const img = {
      full: `${product.id}-${slot}.${hash}.webp`,
      thumb: `${product.id}-${slot}t.${hash}.webp`,
      share: processed.share ? `${product.id}-${slot}s.${hash}.jpg` : null,
    };
    await fs.promises.writeFile(path.join(this.imgDir, img.full), processed.full);
    await fs.promises.writeFile(path.join(this.imgDir, img.thumb), processed.thumb);
    if (img.share) await fs.promises.writeFile(path.join(this.imgDir, img.share), processed.share);
    const old = product.images[idx];
    product.images[idx] = img;
    product.updatedAt = new Date().toISOString();
    if (old) this._unlink(old, img.full, img.thumb, img.share);
    return img;
  }

  removePhoto(product, slot) {
    const idx = slot - 1;
    this._unlink(product.images[idx]);
    product.images[idx] = null;
    product.updatedAt = new Date().toISOString();
  }

  _unlink(img, ...keep) {
    if (!img) return;
    const names = typeof img === 'string' ? [img] : [img.full, img.thumb, img.share];
    for (const n of names) {
      if (!n || keep.includes(n)) continue;
      try { fs.unlinkSync(path.join(this.imgDir, n)); } catch { /* already gone */ }
    }
  }

  stats() {
    const ps = this.data.products;
    return {
      products: ps.length,
      visible: ps.filter((p) => p.visible).length,
      hidden: ps.filter((p) => !p.visible).length,
      outOfStock: ps.filter((p) => !p.inStock).length,
      priceHidden: ps.filter((p) => p.showPrice === false).length,
      pendingOrders: this.data.orders.filter((o) => o.status === 'pending').length,
      onSale: ps.filter((p) => p.showPrice !== false && saleIsValid(p.price, p.salePrice)).length,
      noPhoto: ps.filter((p) => !p.images[0] && !p.images[1]).length,
      noCategory: ps.filter((p) => !p.category).length,
      categories: this.data.categories.length,
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
