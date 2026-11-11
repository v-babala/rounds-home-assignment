import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listingFields } from '@rounds/shared';
import { changedFields, normalizeListing, normalizePrice, normalizeText } from './normalization.js';

const listing = {
  title: 'Acme & Partners',
  tagline: 'Simple CRM',
  price: '$39/mo',
  description: 'Track leads.',
};
test('rejects NUL in every listing field without retaining it in partial data', () => {
  for (const field of listingFields) {
    for (const value of ['Acme\u0000CRM', '\u0000', '\u0000Acme', 'Acme\u0000']) {
      const result = normalizeListing(JSON.parse(JSON.stringify({ ...listing, [field]: value })));
      assert.ok(!result.complete);
      assert.deepEqual(result.missingFields, [field]);
      assert.equal(Object.hasOwn(result.fields, field), false);
      assert.equal(JSON.stringify(result.fields).includes('\\u0000'), false);
      assert.equal(Object.keys(result.fields).length, listingFields.length - 1);
    }
  }
});
test('rejects unpaired surrogates in every field while preserving valid Unicode', () => {
  for (const field of listingFields) {
    for (const value of [
      '\ud800',
      '\udfff',
      'Acme\ud800CRM',
      '\udc00Acme',
      'Acme\ud800',
      '\udc00\ud800',
    ]) {
      const result = normalizeListing(JSON.parse(JSON.stringify({ ...listing, [field]: value })));
      assert.ok(!result.complete);
      assert.deepEqual(result.missingFields, [field]);
      assert.equal(Object.hasOwn(result.fields, field), false);
    }
    const valid = normalizeListing({ ...listing, [field]: 'Café 🚀 𐐀' });
    assert.ok(valid.complete);
    assert.equal(valid.listing[field], 'Café 🚀 𐐀');
  }
  const partial = normalizeListing(
    JSON.parse('{"title":"Acme\\ud800CRM","tagline":"CRM","description":"Deals"}'),
  );
  assert.deepEqual(partial, {
    complete: false,
    fields: { tagline: 'CRM', description: 'Deals' },
    missingFields: ['title', 'price'],
  });
});

test('normalizes formatting without erasing meaningful text', () => {
  assert.equal(normalizeText('  Acme&nbsp;&amp;  Partners\n'), 'Acme & Partners');
  assert.equal(normalizeText('Cafe\u0301 &#x26; &#38;'), 'Café & &');
  for (const price of ['$39/mo', '$39.00/mo', '$39 / month', 'USD 39 per month'])
    assert.equal(normalizePrice(price), 'USD 39/month');
  for (const price of ['Free', 'Free forever', '$0/mo', 'USD 0.00 per month'])
    assert.equal(normalizePrice(price), 'Free');
  assert.equal(normalizePrice('€29.50 / seat / month'), 'EUR 29.5/seat_month');
  assert.equal(normalizePrice('GBP 29 per year'), 'GBP 29/year');
  assert.equal(normalizePrice('Contact   sales'), 'Contact sales');
  assert.notEqual(normalizePrice('$39/mo'), normalizePrice('$39/yr'));
  assert.notEqual(normalizePrice('$39/mo'), normalizePrice('€39/mo'));
  assert.notEqual(normalizeText('CRM!'), normalizeText('crm'));
});

test('ignores noise and preserves missing fields as incomplete', () => {
  const first = normalizeListing(listing);
  const second = normalizeListing({
    description: ' Track  leads.\n',
    price: 'USD 39 per month',
    title: 'Acme &amp; Partners',
    tagline: 'Simple&nbsp;CRM',
    viewerCount: 70,
    requestId: 'new',
  });
  assert.deepEqual(first, second);
  assert.ok(first.complete && second.complete);
  assert.deepEqual(changedFields(first.listing, { ...second.listing, price: 'USD 29/month' }), [
    'price',
  ]);
  for (const field of ['title', 'tagline', 'description'] as const) {
    assert.deepEqual(changedFields(first.listing, { ...first.listing, [field]: 'New content' }), [
      field,
    ]);
  }
  for (const value of [null, '', undefined, 42, '   ']) {
    const result = normalizeListing({ ...listing, title: value });
    assert.ok(!result.complete);
    assert.deepEqual(result.missingFields, ['title']);
    assert.equal(result.fields.price, 'USD 39/month');
  }
});
