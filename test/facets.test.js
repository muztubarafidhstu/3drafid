'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');
const imp = require('../lib/importer');
const { tmpDir } = require('./helpers');

const mk = () => new Store(tmpDir());

function shop() {
  const s = mk();
  s.ensureCategory('Filament');
  s.ensureCategory('Nozzles');
  s.setCategoryFilters('filament', ['Colour', 'Material', 'Pack']);
  return s;
}

test('filters: set, keep keys on rename and reorder, limit, remove deletes values', () => {
  const s = shop();
  const c = s.findCategory('filament');
  assert.deepEqual(c.filters, [{ key: 'colour', label: 'Colour' }, { key: 'material', label: 'Material' }, { key: 'pack', label: 'Pack' }]);
  s.addProduct({ sku: 'A', name: 'A', price: 1, category: 'filament', attrs: { colour: 'Black', material: 'PLA' } });
  // reorder + a repeated label + a blank one: the key (and so the product's value) survives
  s.setCategoryFilters('filament', ['Material', { key: 'colour', label: 'Colour' }, 'colour', '  ', 'Pack']);
  assert.deepEqual(s.findCategory('filament').filters.map((f) => f.key), ['material', 'colour', 'pack']);
  assert.deepEqual(s.findBySku('A').attrs, { colour: 'Black', material: 'PLA' });
  const r = s.setCategoryFilters('filament', ['Colour']);
  assert.deepEqual(r.removed, ['Material', 'Pack']);
  assert.equal(r.valuesLost, 1);
  assert.deepEqual(s.findBySku('A').attrs, { colour: 'Black' }, 'removed filter values are gone');
  assert.throws(() => s.setCategoryFilters('filament', Array.from({ length: 9 }, (_, i) => 'F' + i)), /At most 8/);
  assert.throws(() => s.setCategoryFilters('nope', ['x']), /Unknown category/);
  assert.equal(s.findCategory('filament').filters.length, 1, 'a failed change leaves the filters alone');
});

test('filter values: one spelling per value, validated, cleared on category change', () => {
  const s = shop();
  s.addProduct({ sku: 'A', name: 'A', price: 1, category: 'filament', attrs: { colour: 'Black', pack: 'Spool' } });
  const b = s.addProduct({ sku: 'B', name: 'B', price: 1, category: 'filament', attrs: { colour: '  black ', pack: 'SPOOL' } });
  assert.deepEqual(b.attrs, { colour: 'Black', pack: 'Spool' }, 'same spelling as the existing value, whitespace trimmed');
  assert.throws(() => s.addProduct({ sku: 'C', name: 'C', price: 1, category: 'filament', attrs: { size: 'big' } }), /not a filter/);
  assert.throws(() => s.addProduct({ sku: 'D', name: 'D', price: 1, attrs: { colour: 'Red' } }), /Pick a category first/);
  assert.equal(s.findBySku('C'), null, 'a rejected product is not created');
  // blank clears one value, others stay
  s.updateProduct(b.id, { attrs: { colour: '' } });
  assert.deepEqual(s.getProduct(b.id).attrs, { pack: 'Spool' });
  // an invalid patch changes nothing at all
  assert.throws(() => s.updateProduct(b.id, { name: 'New name', attrs: { size: 'x' } }), /not a filter/);
  assert.equal(s.getProduct(b.id).name, 'B');
  assert.throws(() => s.updateProduct(b.id, { sku: 'NEW-SKU', name: '' }), /Name is required/);
  assert.equal(s.getProduct(b.id).sku, 'B', 'a failed update does not half-apply');
  assert.equal(s.findBySku('NEW-SKU'), null);
  // moving to a category without these filters clears them and says so
  const notes = [];
  s.updateProduct(b.id, { category: 'nozzles' }, notes);
  assert.deepEqual(s.getProduct(b.id).attrs, {});
  assert.equal(notes.length, 1);
  // moving and filling the new category's filters in one save keeps the new values
  s.ensureFilter('nozzles', 'Size');
  const n2 = [];
  s.updateProduct(b.id, { category: 'nozzles', attrs: { size: '0.4mm' } }, n2);
  assert.deepEqual(s.getProduct(b.id).attrs, { size: '0.4mm' });
  assert.deepEqual(n2, []);
  assert.deepEqual(s.filterOptions().filament.colour, ['Black'], 'suggestions list each value once');
});

test('filters survive a reload and old data without filters still loads', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.ensureCategory('Filament');
  s.setCategoryFilters('filament', ['Colour']);
  s.addProduct({ sku: 'A', name: 'A', price: 1, category: 'filament', attrs: { colour: 'Red' } });
  require('fs').writeFileSync(s.file, JSON.stringify(s.data));
  const again = new Store(dir);
  assert.deepEqual(again.findBySku('A').attrs, { colour: 'Red' });
  const old = tmpDir();
  require('fs').writeFileSync(require('path').join(old, 'store.json'), JSON.stringify({ categories: [{ slug: 'x', name: 'X' }], products: [{ id: 'p', sku: 'P', name: 'P', price: 5 }] }));
  const o = new Store(old);
  assert.deepEqual(o.findCategory('x').filters, []);
  assert.deepEqual(o.getProduct('p').attrs, {});
  o.updateProduct('p', { name: 'P2' });
  assert.equal(o.getProduct('p').name, 'P2');
});

test('import: filter columns become filters, spelling is shared, new columns can be added later', () => {
  const s = mk();
  const rows = [
    ['SKU', 'Name', 'Price', 'Category', 'Color', 'Material type', 'Spool/Refill', 'Diameter', 'Notes'],
    ['F1', 'Filament one', 100, 'Filament', 'Black', 'PLA', 'Spool', '1.75mm', 'x'],
    ['F2', 'Filament two', 100, 'Filament', 'black', 'PETG', 'Refill', '', ''],
    ['N1', 'Nozzle', 10, 'Nozzles', 'Brass', '', '', '0.4mm', ''],
    ['X1', 'No category', 10, '', 'Red', '', '', '', ''],
  ];
  const m = imp.autoMap(rows[0]);
  assert.deepEqual(m.filters.map((f) => f.label), ['Color', 'Material type', 'Spool/Refill', 'Diameter'], 'Notes is not a filter column');
  const r = imp.applyImport(s, rows.slice(1), m);
  assert.equal(r.created, 4);
  assert.deepEqual(s.findCategory('filament').filters.map((f) => f.label), ['Color', 'Material type', 'Spool/Refill', 'Diameter']);
  assert.deepEqual(s.findBySku('F2').attrs, { color: 'Black', 'material-type': 'PETG', 'spool-refill': 'Refill' }, '"black" matched "Black"');
  assert.deepEqual(s.findCategory('nozzles').filters.map((f) => f.label), ['Color', 'Diameter'], 'only columns with a value are added to a category');
  assert.ok(r.warnings.some((w) => /no category/.test(w.message)), 'values without a category are reported');
  // re-import: a blank cell never erases a value
  const r2 = imp.applyImport(s, [['F1', 'Filament one', 100, 'Filament', '', '', '', '', '']], m);
  assert.equal(r2.updated, 1);
  assert.equal(s.findBySku('F1').attrs.color, 'Black');
  // moving a product to another category via import clears the old values and says so
  const r3 = imp.applyImport(s, [['F1', 'Filament one', 100, 'Nozzles', '', '', '', '', '']], m);
  assert.ok(r3.warnings.some((w) => /category changed/.test(w.message)));
  // Nozzles has Color and Diameter too, so those carry over; Material type and Spool/Refill do not exist there.
  assert.deepEqual(s.findBySku('F1').attrs, { color: 'Black', diameter: '1.75mm' });
});
