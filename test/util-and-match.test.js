'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, parsePrice, formatBDT, esc, normalizeWhatsApp, normalizeSiteUrl } = require('../lib/util');
const { buildPhotoIndex, matchFile } = require('../lib/photo-match');

test('formatBDT uses Indian digit grouping', () => {
  assert.equal(formatBDT(125000), '৳1,25,000');
  assert.equal(formatBDT(1500), '৳1,500');
  assert.equal(formatBDT(1500.5), '৳1,500.50');
});

test('parsePrice accepts what people really type', () => {
  assert.equal(parsePrice('1,250'), 1250);
  assert.equal(parsePrice('৳ ১২৫০'), 1250);
  assert.equal(parsePrice('Tk 1250'), 1250);
  assert.equal(parsePrice('1250/-'), 1250);
  assert.equal(parsePrice(99), 99);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(undefined), null);
  assert.ok(Number.isNaN(parsePrice('abc')));
  assert.ok(Number.isNaN(parsePrice(-5)));
  assert.ok(Number.isNaN(parsePrice('12 13')));
});

test('slugify keeps Bangla letters and vowel signs', () => {
  assert.equal(slugify('AB 100/X'), 'ab-100-x');
  const bn = slugify('শাড়ি ১');
  assert.ok(bn.startsWith('শাড়ি'), bn);
  assert.equal(slugify('!!!'), 'item');
});

test('WhatsApp numbers and site URLs are normalised', () => {
  assert.equal(normalizeWhatsApp('01712-345678'), '8801712345678');
  assert.equal(normalizeWhatsApp('+880 1712 345678'), '8801712345678');
  assert.equal(normalizeWhatsApp('০১৭১২৩৪৫৬৭৮'), '8801712345678');
  assert.equal(normalizeSiteUrl('yourshop.com/'), 'https://yourshop.com');
  assert.equal(normalizeSiteUrl('http://x.com/a/b'), 'http://x.com');
  assert.equal(normalizeSiteUrl(''), '');
  assert.equal(normalizeSiteUrl('not a url'), '');
});

test('esc escapes HTML', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

const P = (id, sku, names) => ({ id, sku, imageNames: names || [null, null] });

test('photo matching: SKU.jpg is photo 1, SKU-2.jpg is photo 2', () => {
  const idx = buildPhotoIndex([P('a', 'AB-100')]);
  assert.deepEqual(matchFile(idx, 'ab-100.jpg'), { id: 'a', sku: 'AB-100', slot: 1, ambiguous: false });
  assert.equal(matchFile(idx, 'AB-100-2.jpeg').slot, 2);
  assert.equal(matchFile(idx, 'AB-100_2.PNG').slot, 2);
  assert.equal(matchFile(idx, 'AB-100-1.jpg').slot, 1);
  assert.equal(matchFile(idx, 'C:\\photos\\AB-100.jpg').id, 'a');
  assert.equal(matchFile(idx, 'random.jpg'), null);
});

test('photo matching: import filenames win', () => {
  const idx = buildPhotoIndex([P('b', 'X9', ['IMG_001.JPG', 'img_002.png'])]);
  assert.deepEqual(matchFile(idx, 'img_001.jpg').slot, 1);
  assert.deepEqual(matchFile(idx, 'IMG_002.png').slot, 2);
});

test('photo matching: a SKU ending in -2 is not hijacked, and the clash is reported', () => {
  for (const order of [['100', '100-2'], ['100-2', '100']]) {
    const idx = buildPhotoIndex(order.map((s) => P(`p${s}`, s)));
    assert.deepEqual(matchFile(idx, '100-2.jpg'), { id: 'p100-2', sku: '100-2', slot: 1, ambiguous: false }, `order ${order}`);
    assert.equal(matchFile(idx, '100.jpg').id, 'p100');
    assert.equal(idx.shadowed.length, 1);
    assert.deepEqual(idx.shadowed[0], { file: '100-2', sku: '100', slot: 2, by: '100-2' });
  }
});

test('photo matching: explicit filename lets product 100 own its second photo', () => {
  const idx = buildPhotoIndex([P('p100', '100', [null, '100-2.jpg']), P('p1002', '100-2')]);
  assert.deepEqual(matchFile(idx, '100-2.jpg'), { id: 'p100', sku: '100', slot: 2, ambiguous: false });
});

test('photo matching: two products claiming the same explicit name are flagged ambiguous', () => {
  const idx = buildPhotoIndex([P('a', 'A', ['same.jpg', null]), P('b', 'B', ['same.jpg', null])]);
  assert.equal(matchFile(idx, 'same.jpg').ambiguous, true);
});
