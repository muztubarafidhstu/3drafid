'use strict';

/**
 * Filters ("facets"). A category owns an ordered list of filter groups, for example
 * Filament: Colour, Material, Pack. A product holds one value per group in product.attrs.
 *
 *   category.filters = [{ key: 'colour', label: 'Colour' }, ...]
 *   product.attrs    = { colour: 'Black', material: 'PLA+' }
 */

const MAX_FILTERS = 8;
const MAX_VALUE = 60;

/** One-line, trimmed text for a filter label or value. */
function cleanFacetText(v, max = MAX_VALUE) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The values a customer may see for a product, in the category's filter order. */
function visibleAttrs(category, product) {
  if (!category || !Array.isArray(category.filters) || !product || !product.attrs) return [];
  const out = [];
  for (const f of category.filters) {
    const value = cleanFacetText(product.attrs[f.key]);
    if (value) out.push({ key: f.key, label: f.label, value });
  }
  return out;
}

module.exports = { MAX_FILTERS, MAX_VALUE, cleanFacetText, visibleAttrs };
