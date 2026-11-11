import { decodeHTML } from 'entities';
import { listingFields, type Listing, type ListingField } from '@rounds/shared';

export function normalizeText(value: string): string {
  return decodeHTML(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function normalizePrice(value: string): string {
  const text = normalizeText(value);
  if (/^free(?: forever)?$/i.test(text)) return 'Free';
  const match = /^(USD|EUR|GBP|[A-Z]{3}|[$€£])\s*(\d+(?:\.\d{1,2})?)\s*(.*)$/i.exec(text);
  if (!match) return text;
  const [, currencyInput, amountInput, periodInput] = match;
  const period = periodInput!.toLowerCase().replace(/\s+/g, '').replace(/per/g, '/');
  const periods: Record<string, string> = {
    '/mo': 'month',
    '/month': 'month',
    '/yr': 'year',
    '/year': 'year',
    '/seat/mo': 'seat_month',
    '/seat/month': 'seat_month',
  };
  const canonicalPeriod = periods[period];
  if (!canonicalPeriod) return text;
  const [whole, fraction = ''] = amountInput!.split('.');
  const decimals = fraction.replace(/0+$/, '');
  const amount = BigInt(whole!).toString() + (decimals ? '.' + decimals : '');
  if (amount === '0') return 'Free';
  const currencies: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };
  const currency = currencies[currencyInput!] ?? currencyInput!.toUpperCase();
  return currency + ' ' + amount + '/' + canonicalPeriod;
}

export type NormalizedListing =
  | { complete: true; listing: Listing }
  | { complete: false; fields: Partial<Listing>; missingFields: ListingField[] };

export function normalizeListing(input: unknown): NormalizedListing {
  const object =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const fields: Partial<Listing> = {};
  const missingFields: ListingField[] = [];
  for (const field of listingFields) {
    const value = object[field];
    const normalized =
      // PostgreSQL text and jsonb cannot store U+0000, including partial fields.
      typeof value === 'string' && value.length <= 20_000 && !value.includes('\u0000')
        ? field === 'price'
          ? normalizePrice(value)
          : normalizeText(value)
        : '';
    // With the Unicode flag, surrogate pairs are matched as a single code point;
    // this range detects only unpaired surrogates, which PostgreSQL jsonb rejects.
    if (!normalized || normalized.includes('\u0000') || /[\uD800-\uDFFF]/u.test(normalized))
      missingFields.push(field);
    else fields[field] = normalized;
  }
  if (missingFields.length) return { complete: false, fields, missingFields };
  return { complete: true, listing: fields as Listing };
}

export function changedFields(previous: Listing, current: Listing): ListingField[] {
  return listingFields.filter((field) => previous[field] !== current[field]);
}
