'use strict';

/**
 * What a customer is allowed to see about a product's price.
 *
 * The storefront builder reads prices ONLY through priceView(), so a product whose price is
 * switched off cannot leak its price or its discount into any public file (page, JSON, share tags).
 */

/** A discount is real only when it is above 0 and lower than the price. */
function saleIsValid(price, sale) {
  if (sale === null || sale === undefined || sale === '') return false;
  const s = Number(sale);
  return Number.isFinite(s) && s > 0 && Number.isFinite(price) && price > 0 && s < price;
}

/** Whole percent taken off. Rounded down, so the shop never claims more than it gives. */
function percentOff(price, sale) {
  return Math.floor((1 - sale / price) * 100);
}

/**
 * { shown: false }                                  price hidden: customers are asked to message on WhatsApp
 * { shown: true, price, sale, now, pct }            sale is null without a discount; now = what the customer pays
 */
function priceView(p) {
  if (p.showPrice === false) return { shown: false };
  const price = Number(p.price) || 0;
  const sale = saleIsValid(price, p.salePrice) ? Number(p.salePrice) : null;
  return { shown: true, price, sale, now: sale === null ? price : sale, pct: sale === null ? 0 : percentOff(price, sale) };
}

module.exports = { saleIsValid, percentOff, priceView };
