'use strict';

/**
 * Match uploaded photo filenames to products.
 *   SKU.jpg, SKU-1.jpg, SKU_1.jpg  -> photo 1
 *   SKU-2.jpg, SKU_2.jpg           -> photo 2
 *   filenames listed in the import sheet win over everything.
 * Priority when two products claim the same filename: import filename > exact SKU > SKU-2 style guess.
 */

const LEVEL_DERIVED = 1;
const LEVEL_EXACT = 2;
const LEVEL_EXPLICIT = 3;

function stem(name) {
  return String(name)
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim()
    .toLowerCase();
}

function buildPhotoIndex(products) {
  const map = new Map();
  const shadowed = []; // derived names that lost to another product's exact SKU / explicit name
  const ambiguous = new Set();

  function put(key, product, slot, level) {
    const cur = map.get(key);
    if (!cur || level > cur.level) {
      if (cur && cur.id !== product.id && cur.level === LEVEL_DERIVED) {
        shadowed.push({ file: key, sku: cur.sku, slot: cur.slot, by: product.sku });
      }
      map.set(key, { id: product.id, sku: product.sku, slot, level });
    } else if (cur.id !== product.id) {
      if (level === cur.level) ambiguous.add(key);
      else if (level === LEVEL_DERIVED) shadowed.push({ file: key, sku: product.sku, slot, by: cur.sku });
    }
  }

  for (const p of products) {
    const s = String(p.sku).trim().toLowerCase();
    if (!s) continue;
    put(s, p, 1, LEVEL_EXACT);
  }
  for (const p of products) {
    const s = String(p.sku).trim().toLowerCase();
    if (!s) continue;
    put(`${s}-1`, p, 1, LEVEL_DERIVED);
    put(`${s}_1`, p, 1, LEVEL_DERIVED);
    put(`${s}-2`, p, 2, LEVEL_DERIVED);
    put(`${s}_2`, p, 2, LEVEL_DERIVED);
  }
  for (const p of products) {
    const names = p.imageNames || [];
    if (names[0]) put(stem(names[0]), p, 1, LEVEL_EXPLICIT);
    if (names[1]) put(stem(names[1]), p, 2, LEVEL_EXPLICIT);
  }
  return { map, shadowed, ambiguous: [...ambiguous] };
}

function matchFile(index, filename) {
  const hit = index.map.get(stem(filename));
  if (!hit) return null;
  return { id: hit.id, sku: hit.sku, slot: hit.slot, ambiguous: index.ambiguous.includes(stem(filename)) };
}

module.exports = { stem, buildPhotoIndex, matchFile };
