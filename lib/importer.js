'use strict';

const XLSX = require('xlsx');
const { parsePrice, cleanText, toAsciiDigits } = require('./util');
const { cleanFacetText } = require('./facets');

const FIELDS = ['sku', 'name', 'price', 'salePrice', 'showPrice', 'category', 'description', 'stock', 'image1', 'image2', 'featured', 'visible', 'cost', 'qty'];

const SYNONYMS = {
  sku: ['sku', 'code', 'productcode', 'itemcode', 'id', 'productid', 'itemno', 'কোড', 'পণ্যকোড'],
  name: ['name', 'productname', 'product', 'title', 'item', 'itemname', 'নাম', 'পণ্য', 'পণ্যেরনাম'],
  price: ['price', 'rate', 'mrp', 'amount', 'sellingprice', 'unitprice', 'regularprice', 'দাম', 'মূল্য', 'টাকা'],
  salePrice: ['saleprice', 'sale', 'offerprice', 'discountprice', 'discountedprice', 'specialprice', 'nowprice', 'ছাড়েরদাম', 'অফারদাম', 'ডিসকাউন্টদাম'],
  showPrice: ['showprice', 'displayprice', 'pricevisible', 'priceshown', 'showthepric', 'pricetoggle', 'দামদেখান', 'দামদেখাবেন'],
  category: ['category', 'type', 'group', 'department', 'ক্যাটাগরি', 'ধরন', 'বিভাগ'],
  description: ['description', 'details', 'desc', 'about', 'বিবরণ', 'বর্ণনা'],
  stock: ['stock', 'instock', 'availability', 'available', 'status', 'স্টক'],
  image1: ['image', 'image1', 'photo', 'photo1', 'picture', 'picture1', 'imagefilename', 'image1filename', 'filename', 'ছবি'],
  image2: ['image2', 'photo2', 'picture2', 'image2filename', 'secondimage', 'ছবি২'],
  featured: ['featured', 'highlight', 'bestseller'],
  visible: ['visible', 'show', 'shown', 'showonsite', 'active', 'published', 'display'],
  cost: ['cost', 'buyingcost', 'buyprice', 'buyingprice', 'purchaseprice', 'purchasecost', 'costprice', 'unitcost', 'cp', 'কেনাদাম', 'ক্রয়মূল্য', 'ক্রয়', 'কস্ট'],
  qty: ['stockqty', 'qty', 'quantity', 'stockquantity', 'onhand', 'stocklevel', 'স্টকসংখ্যা', 'পরিমাণ', 'সংখ্যা'],
};

// Extra columns with these headings become filters automatically (the owner can add or untick others in the wizard).
const FILTER_HEADERS = new Set([
  'colour', 'color', 'material', 'materialtype', 'pack', 'packtype', 'packaging', 'spoolrefill', 'refillspool', 'refill', 'spool',
  'brand', 'make', 'manufacturer', 'size', 'diameter', 'weight', 'model', 'compatibility', 'compatiblewith', 'technology', 'nozzlesize',
  'ams', 'amssupport', 'version', 'origin', 'madein', 'printertype', 'printtype', 'edition', 'company',
  'রং', 'রঙ', 'ম্যাটেরিয়াল', 'ব্র্যান্ড', 'সাইজ',
]);

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');

/** Read the first sheet of an .xlsx/.xls/.csv buffer into { headers, rows } (rows are arrays). */
function parseSheet(buffer) {
  // codepage 65001 = UTF-8, so Bangla text in CSV files saved without a BOM is read correctly
  const wb = XLSX.read(buffer, { type: 'buffer', codepage: 65001, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheets');
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });
  if (!all.length) throw new Error('The sheet is empty');
  const headers = all[0].map((h, i) => (String(h).trim() ? String(h).trim() : `Column ${i + 1}`));
  const rows = all
    .slice(1)
    .map((r) => headers.map((_, i) => (r[i] === undefined || r[i] === null ? '' : r[i])))
    .filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) throw new Error('No products found below the header row. The first row must hold the column names.');
  return { headers, rows };
}

/** Guess which column is which. Returns { field: columnIndex | -1 }. */
function autoMap(headers, rows) {
  const mapping = {};
  const used = new Set();
  for (const f of FIELDS) {
    let hit = -1;
    // exact synonym match first, so "image2" is not taken by "image"
    for (let i = 0; i < headers.length && hit < 0; i++) {
      if (!used.has(i) && SYNONYMS[f].includes(norm(headers[i]))) hit = i;
    }
    mapping[f] = hit;
    if (hit >= 0) used.add(hit);
  }
  // A "Stock" column that holds quantities (numbers above 1) is a stock quantity, not a yes/no.
  if (Array.isArray(rows) && mapping.stock >= 0 && mapping.qty < 0) {
    const col = mapping.stock;
    if (rows.some((r) => /^\d+$/.test(toAsciiDigits(r[col]).trim()) && Number(toAsciiDigits(r[col])) > 1)) {
      mapping.qty = col;
      mapping.stock = -1;
    }
  }
  mapping.filters = [];
  headers.forEach((h, i) => {
    if (!used.has(i) && FILTER_HEADERS.has(norm(h))) mapping.filters.push({ col: i, label: cleanFacetText(h, 40) });
  });
  return mapping;
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'instock', 'in stock', 'available', 'stock', 'show', 'active', 'হ্যাঁ', 'আছে']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', 'outofstock', 'out of stock', 'unavailable', 'soldout', 'sold out', 'hide', 'inactive', 'না', 'নেই']);

/** true / false / null (blank or unknown). */
function parseFlag(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  const s = toAsciiDigits(v).trim().toLowerCase();
  if (s === '') return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  const n = Number(s);
  if (Number.isFinite(n)) return n > 0;
  return null;
}

/**
 * Turn one sheet row into a validated change set. Pure: does not touch the store.
 * existing = the product with this SKU, or null.
 */
function analyzeRow(row, mapping, existing) {
  const get = (f) => (mapping[f] >= 0 ? row[mapping[f]] : '');
  const str = (f) => cleanText(get(f), f === 'description' ? 5000 : 200);
  const errors = [];
  const warnings = [];
  const sku = String(get('sku') ?? '').trim();
  const name = str('name');
  const priceRaw = get('price');
  const price = parsePrice(priceRaw);
  const out = { sku };

  // "Show price": no = customers see "Ask price on WhatsApp" instead of the price.
  if (mapping.showPrice >= 0) {
    const v = parseFlag(get('showPrice'));
    if (v !== null) out.showPrice = v;
    else if (String(get('showPrice')).trim() !== '') warnings.push(`Show price "${get('showPrice')}" not understood, left unchanged`);
  }
  const willShow = out.showPrice !== undefined ? out.showPrice : existing ? existing.showPrice !== false : true;

  if (!sku) errors.push('Missing SKU');
  if (!existing && !name) errors.push('Missing name');
  if (name) out.name = name;
  if (Number.isNaN(price)) errors.push(`Price "${priceRaw}" is not a number`);
  else if (price === null && !existing && willShow) errors.push('Missing price (or set "Show price" to no)');
  else if (price !== null) out.price = price;
  // Turning the price on for an existing product that has no price yet cannot work.
  if (existing && out.showPrice === true && !(out.price > 0) && !(existing.price > 0)) errors.push('Missing price (needed to show it)');

  // Discount price. Blank = leave as is. 0 = remove the discount. Never an error: a bad one is ignored with a warning.
  if (mapping.salePrice >= 0) {
    const saleRaw = get('salePrice');
    const sale = parsePrice(saleRaw);
    const effective = out.price !== undefined ? out.price : existing ? existing.price : 0;
    if (Number.isNaN(sale)) warnings.push(`Discount price "${saleRaw}" is not a number, ignored`);
    else if (sale === 0) out.salePrice = null;
    else if (sale !== null) {
      if (!(effective > 0) || sale >= effective) warnings.push(`Discount price ${sale} must be lower than the price${effective > 0 ? ` (${effective})` : ''}, ignored`);
      else out.salePrice = sale;
    }
  }

  const category = str('category');
  if (category) out.categoryName = category;
  const description = str('description');
  if (description) out.description = description;

  if (mapping.stock >= 0) {
    const f = parseFlag(get('stock'));
    if (f !== null) out.inStock = f;
    else if (String(get('stock')).trim() !== '') warnings.push(`Stock "${get('stock')}" not understood, left unchanged`);
  }
  // Buying cost (private) and stock quantity. Blank cells leave the product as it is.
  if (mapping.cost >= 0) {
    const raw = get('cost');
    const c = parsePrice(raw);
    if (Number.isNaN(c)) warnings.push(`Buying cost "${raw}" is not a number, ignored`);
    else if (c !== null) out.cost = c;
  }
  if (mapping.qty >= 0) {
    const raw = String(get('qty') ?? '').trim();
    if (raw !== '') {
      const q = Number(toAsciiDigits(raw).replace(/,/g, ''));
      if (Number.isInteger(q) && q >= 0) out.stockQty = q;
      else warnings.push(`Stock qty "${raw}" must be a whole number, ignored`);
    }
  }
  for (const f of ['featured', 'visible']) {
    if (mapping[f] >= 0) {
      const v = parseFlag(get(f));
      if (v !== null) out[f] = v;
    }
  }
  const filterCols = Array.isArray(mapping.filters) ? mapping.filters : [];
  const attrsByLabel = {};
  for (const f of filterCols) {
    const v = cleanFacetText(row[f.col]);
    if (v && f.label) attrsByLabel[f.label] = v;
  }
  if (Object.keys(attrsByLabel).length) out.attrsByLabel = attrsByLabel;
  const i1 = str('image1');
  const i2 = str('image2');
  if (i1 || i2) out.imageNames = [i1 || existing?.imageNames?.[0] || null, i2 || existing?.imageNames?.[1] || null];

  return { out, errors, warnings };
}

/** Dry run: counts and the first problems, without changing anything. */
function analyze(store, rows, mapping) {
  const seen = new Map(); // sku -> first valid row that used it
  const res = { total: rows.length, wouldCreate: 0, wouldUpdate: 0, errorRows: 0, problems: [] };
  rows.forEach((row, i) => {
    const excelRow = i + 2;
    const sku = String(mapping.sku >= 0 ? row[mapping.sku] : '').trim();
    const key = sku.toLowerCase();
    const existing = sku ? store.findBySku(sku) : null;
    const prior = sku ? seen.get(key) : undefined;
    // A row repeating an earlier SKU in the same file updates that product, so it is not "new".
    const { errors, warnings } = analyzeRow(row, mapping, existing || (prior ? {} : null));
    if (errors.length) {
      res.errorRows++;
      if (res.problems.length < 50) res.problems.push({ row: excelRow, sku, level: 'error', message: errors.join('; ') });
      return;
    }
    if (prior) warnings.push(`Duplicate SKU (also on row ${prior}); later row wins`);
    if (existing || prior) res.wouldUpdate++;
    else res.wouldCreate++;
    if (sku) seen.set(key, prior || excelRow);
    if (warnings.length && res.problems.length < 50) res.problems.push({ row: excelRow, sku, level: 'warning', message: warnings.join('; ') });
  });
  return res;
}

/** Apply the import. Blank cells never erase existing data. Upserts by SKU. */
function applyImport(store, rows, mapping, { createCategories = true } = {}) {
  const report = { created: 0, updated: 0, skipped: 0, errors: [], warnings: [], newCategories: [] };
  const before = new Set(store.data.categories.map((c) => c.slug));
  const seen = new Map();
  rows.forEach((row, i) => {
    const excelRow = i + 2;
    const sku = String(mapping.sku >= 0 ? row[mapping.sku] : '').trim();
    const existing = sku ? store.findBySku(sku) : null;
    const { out, errors, warnings } = analyzeRow(row, mapping, existing);
    if (errors.length) {
      report.skipped++;
      report.errors.push({ row: excelRow, sku, message: errors.join('; ') });
      return;
    }
    if (sku && seen.has(sku.toLowerCase())) warnings.push(`Duplicate SKU (also on row ${seen.get(sku.toLowerCase())}); later row used`);
    seen.set(sku.toLowerCase(), excelRow);

    let categorySlug;
    if (out.categoryName) {
      const found = store.data.categories.find((c) => c.name.toLowerCase() === out.categoryName.toLowerCase());
      if (found) categorySlug = found.slug;
      else if (createCategories) categorySlug = store.ensureCategory(out.categoryName).slug;
      else warnings.push(`Category "${out.categoryName}" does not exist; left empty`);
    }
    const fields = { ...out };
    delete fields.categoryName;
    delete fields.attrsByLabel;
    if (categorySlug !== undefined) fields.category = categorySlug;
    if (out.attrsByLabel) {
      const catSlug = categorySlug !== undefined ? categorySlug : existing ? existing.category : null;
      if (!catSlug) warnings.push('Filter values ignored: this product has no category');
      else {
        fields.attrs = {};
        for (const [label, value] of Object.entries(out.attrsByLabel)) {
          const key = store.ensureFilter(catSlug, label);
          if (key) fields.attrs[key] = value;
          else warnings.push(`"${label}" ignored: a category can have at most 8 filters`);
        }
      }
    }
    const notes = [];
    try {
      if (existing) {
        store.updateProduct(existing.id, fields, notes);
        report.updated++;
      } else {
        store.addProduct(fields);
        report.created++;
      }
    } catch (e) {
      report.skipped++;
      report.errors.push({ row: excelRow, sku, message: e.message });
      return;
    }
    for (const w of [...warnings, ...notes]) report.warnings.push({ row: excelRow, sku, message: w });
  });
  report.newCategories = store.data.categories.filter((c) => !before.has(c.slug)).map((c) => c.name);
  return report;
}

function templateBuffer() {
  // Columns after Category are customer filters. Fill only the ones that fit the product; leave the rest empty.
  const rows = [
    ['SKU', 'Name', 'Price', 'Sale price', 'Show price', 'Category', 'Brand', 'Colour', 'Material', 'Pack', 'Technology', 'AMS', 'Version', 'Buying cost', 'Stock qty', 'Description', 'Image 1', 'Image 2'],
    ['FIL-PLA-BLK', 'PLA+ Filament 1.75mm 1kg - Black', 1650, 1450, 'yes', 'Filament', 'Sunlu', 'Black', 'PLA+', 'Spool', '', '', '', 1100, 25, 'Smooth, low warp, 1 kg spool', 'FIL-PLA-BLK.jpg', 'FIL-PLA-BLK-2.jpg'],
    ['FIL-PLA-BLK-R', 'PLA+ Filament 1.75mm 1kg Refill - Black', 1500, '', 'yes', 'Filament', 'Sunlu', 'Black', 'PLA+', 'Refill', '', '', '', 980, 12, 'Refill without spool', 'FIL-PLA-BLK-R.jpg', ''],
    ['NOZ-BRS-04', 'Brass Nozzle 0.4mm (MK8)', 120, '', 'yes', 'Nozzles', '', '', 'Brass', '', '', '', '', 60, 80, '', 'NOZ-BRS-04.jpg', ''],
    ['HB-235', 'Heated Bed 235x235mm', '', '', 'no', 'Heat bed', '', '', '', '', '', '', '', 1800, 4, 'Price on request: customers will ask you on WhatsApp', '', ''],
    ['PRN-ENDER3', 'Creality Ender-3 V3 SE 3D Printer', '', '', 'no', '3D Printers', 'Creality', '', '', '', 'FDM/FFF', 'Without AMS', 'Global', 21000, 2, '', '', ''],
    ['PRN-A1-AMS', 'Bambu Lab A1 mini Combo (with AMS lite)', '', '', 'no', '3D Printers', 'Bambu Lab', '', '', '', 'FDM/FFF', 'With AMS', 'Global', 40000, 1, '', '', ''],
    ['PRN-SATURN4', 'Elegoo Saturn 4 Ultra Resin Printer', 62000, '', 'yes', '3D Printers', 'Elegoo', '', '', '', 'Resin', '', 'Chinese', 48000, 2, '', '', ''],
    ['LUB-PTFE', 'PTFE Lubricant Grease 20g', '৳450', '', 'yes', 'Lubricants', '', '', '', '', '', '', '', 250, 0, '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 15 }, { wch: 40 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 11 }, { wch: 13 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 38 }, { wch: 18 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { FIELDS, parseSheet, autoMap, parseFlag, analyzeRow, analyze, applyImport, templateBuffer };
