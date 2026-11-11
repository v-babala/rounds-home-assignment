import { test, expect, type Page } from '@playwright/test';
import type { Competitor, Snapshot, SummaryStatus } from '@rounds/shared';

const competitor = (id = 'acme', changed = false): Competitor => ({
  id,
  changedInLast24h: changed,
  lastPolledAt: null,
  lastChangedAt: null,
  lastPollStatus: null,
});
const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  id: '11111111-1111-4111-8111-111111111111',
  startedAt: '2026-11-10T12:00:00Z',
  fetchedAt: '2026-11-10T12:00:01Z',
  title: 'Acme CRM',
  tagline: 'Track deals',
  price: 'USD 29/month',
  description: 'Sales workspace',
  pollStatus: 'success',
  comparisonStatus: 'changed',
  changed: true,
  changedFields: ['price'],
  missingFields: [],
  errorCode: null,
  httpStatus: 200,
  summary: null,
  summaryStatus: 'pending',
  summaryErrorCode: null,
  summaryAttempts: 0,
  summaryProvider: null,
  ...overrides,
});
async function watchlist(page: Page, items: Competitor[] = []) {
  await page.route('**/api/competitors', (route) => route.fulfill({ json: items }));
}
async function history(page: Page, items: Snapshot[]) {
  await watchlist(page, [competitor()]);
  await page.route('**/api/competitors/acme/snapshots?*', (route) =>
    route.fulfill({ json: items, headers: { 'X-Tracking-Active': 'true' } }),
  );
  await page.goto('/#/competitors/acme');
}

test('watchlist shows loading, empty state and input validation without sending a mutation', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mutations = 0;
  await page.route('**/api/competitors', async (route) => {
    if (route.request().method() === 'POST') mutations++;
    await gate;
    await route.fulfill({ json: [] });
  });
  await page.goto('/');
  await expect(page.getByText('Loading your watchlist…')).toBeVisible();
  release();
  await expect(page.getByText('A little competitive intelligence starts here')).toBeVisible();
  await page.getByLabel('Competitor ID', { exact: true }).fill('bad/id');
  await page.getByRole('button', { name: 'Track competitor', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter an ID');
  await expect(page.getByLabel('Competitor ID', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(mutations).toBe(0);
});

test('adding a competitor submits a trimmed ID, disables duplicate submissions and refreshes the list', async ({
  page,
}) => {
  let items: Competitor[] = [];
  let submissions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/competitors', async (route) => {
    if (route.request().method() === 'POST') {
      submissions++;
      expect(route.request().postDataJSON()).toEqual({ id: 'acme' });
      await gate;
      items = [competitor()];
      await route.fulfill({ status: 201, json: { id: 'acme' } });
    } else await route.fulfill({ json: items });
  });
  await page.goto('/');
  await page.getByLabel('Competitor ID', { exact: true }).fill(' acme ');
  await page.getByRole('button', { name: 'Track competitor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adding…' })).toBeDisabled();
  release();
  await expect(page.getByRole('link', { name: /acme View timeline/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'acme is now tracked' })).toContainText(
    'acme is now tracked',
  );
  await expect(page.getByLabel('Competitor ID', { exact: true })).toHaveValue('');
  expect(submissions).toBe(1);
});

test('already tracked and failed additions show distinct feedback', async ({ page }) => {
  let fail = false;
  await page.route('**/api/competitors', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill(fail ? { status: 500 } : { status: 200, json: { id: 'acme' } })
      : route.fulfill({ json: [] }),
  );
  await page.goto('/');
  const input = page.getByLabel('Competitor ID', { exact: true });
  await input.fill('acme');
  await page.getByRole('button', { name: 'Track competitor', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('already on your watchlist');
  fail = true;
  await input.fill('other');
  await page.getByRole('button', { name: 'Track competitor', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('service is unavailable');
  await expect(input).toHaveValue('other');
});

test('list highlights changed and failed polls and opens the competitor timeline', async ({
  page,
}) => {
  await watchlist(page, [
    competitor('acme', true),
    { ...competitor('broken'), lastPollStatus: 'timeout' },
  ]);
  await page.route('**/snapshots?*', (route) =>
    route.fulfill({ json: [], headers: { 'X-Tracking-Active': 'true' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('row').filter({ hasText: 'acme' })).toContainText('Changed');
  await expect(page.getByRole('row').filter({ hasText: 'broken' })).toContainText('Timed out');
  await page.getByRole('link', { name: /acme View timeline/ }).click();
  await expect(page).toHaveURL(/#\/competitors\/acme$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme');
  await expect(page.getByText('Tracking active')).toBeVisible();
  await page.getByRole('link', { name: 'All competitors' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Competitors');
});

test('removal can be cancelled, retains the row on failure and removes it after retry', async ({
  page,
}) => {
  let items = [competitor()];
  let deletions = 0;
  await page.route('**/api/competitors', (route) => route.fulfill({ json: items }));
  await page.route('**/api/competitors/acme', (route) => {
    expect(route.request().method()).toBe('DELETE');
    deletions++;
    if (deletions === 1) return route.fulfill({ status: 500 });
    items = [];
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  const remove = page.getByRole('button', { name: 'Stop tracking acme' });
  await remove.click();
  await page.getByRole('button', { name: 'Keep tracking' }).click();
  expect(deletions).toBe(0);
  await remove.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Stop tracking', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(remove).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop tracking', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Its history is saved' })).toBeVisible();
});

test('list recovers from an API error through Try again', async ({ page }) => {
  let failed = true;
  await page.route('**/api/competitors', (route) =>
    route.fulfill(failed ? { status: 400 } : { json: [competitor()] }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: /acme View timeline/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

const summaries: [SummaryStatus, string][] = [
  ['baseline', 'First snapshot'],
  ['unchanged', 'No meaningful changes'],
  ['pending', 'Summary queued'],
  ['processing', 'Writing summary'],
  ['retry_wait', 'Summary will retry'],
  ['failed', 'Summary failed'],
  ['budget_exhausted', 'Daily AI limit reached'],
  ['source_unavailable', 'Summary unavailable'],
];
for (const [status, label] of summaries) {
  test(`timeline explains summary state: ${status}`, async ({ page }) => {
    await history(page, [
      snapshot({
        summaryStatus: status,
        summaryAttempts: status === 'failed' ? 3 : 0,
        ...(status === 'baseline' || status === 'unchanged'
          ? { comparisonStatus: status, changed: false, changedFields: [] }
          : {}),
        ...(status === 'source_unavailable'
          ? {
              pollStatus: 'http_error',
              comparisonStatus: 'unavailable',
              changed: false,
              changedFields: [],
              httpStatus: 500,
            }
          : {}),
      }),
    ]);
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(page.getByText('USD 29/month', { exact: true })).toBeVisible();
    if (status === 'failed') await expect(page.getByText('Attempts made: 3.')).toBeVisible();
  });
}

test('timeline displays ready mock summaries and safely renders listing text', async ({ page }) => {
  await history(page, [
    snapshot({
      summaryStatus: 'ready',
      summary: 'Price dropped.',
      summaryProvider: 'mock-llm',
      title: '<img src=x onerror="window.compromised=true">',
    }),
  ]);
  await expect(page.getByText('Price dropped.', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo model', { exact: true })).toBeVisible();
  await expect(
    page.getByText('<img src=x onerror="window.compromised=true">', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.listing-fields img')).toHaveCount(0);
});

test('failed and incomplete source polls retain history and explain missing fields', async ({
  page,
}) => {
  await history(page, [
    snapshot({
      pollStatus: 'incomplete',
      summaryStatus: 'source_unavailable',
      price: null,
      missingFields: ['price'],
    }),
  ]);
  await expect(page.getByText('Missing or invalid: Price.')).toBeVisible();
  await expect(page.getByText('Not available in this poll')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(1);
});

test('history pagination retains loaded snapshots on error and retries with the cursor', async ({
  page,
}) => {
  await watchlist(page);
  let failNext = true;
  await page.route('**/api/competitors/acme/snapshots?*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor)
      return route.fulfill({
        json: [snapshot()],
        headers: { 'X-Next-Cursor': 'older_cursor', 'X-Tracking-Active': 'false' },
      });
    expect(cursor).toBe('older_cursor');
    return route.fulfill(
      failNext
        ? { status: 400 }
        : {
            json: [
              snapshot(),
              snapshot({ id: '22222222-2222-4222-8222-222222222222', title: 'Older listing' }),
            ],
          },
    );
  });
  await page.goto('/#/competitors/acme');
  await page.getByRole('button', { name: 'Load older snapshots' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(1);
  failNext = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByText('Older listing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load older snapshots' })).toHaveCount(0);
  await expect(page.getByText('Tracking stopped')).toBeVisible();
});

test('browsing older history pauses automatic refetches but keeps manual Refresh', async ({
  page,
}) => {
  await page.clock.install();
  await watchlist(page, [competitor()]);
  const requests: (string | null)[] = [];
  await page.route('**/api/competitors/acme/snapshots?*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    requests.push(cursor);
    const index = Number(cursor ?? 0);
    return route.fulfill({
      json: [snapshot({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })],
      headers: { 'X-Next-Cursor': String(index + 1) },
    });
  });
  await page.goto('/#/competitors/acme');
  await expect(page.getByRole('article')).toHaveCount(1);
  for (let count = 2; count <= 3; count++) {
    await page.getByRole('button', { name: 'Load older snapshots' }).click();
    await expect(page.getByRole('article')).toHaveCount(count);
  }
  await expect(page.getByText(/Auto-refresh paused while browsing history/)).toBeVisible();
  // StrictMode can start and abort an initial request during its mount check.
  const loadedRequests = [...requests];
  expect(loadedRequests.slice(-2)).toEqual(['1', '2']);
  await page.clock.runFor(30_000);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });
  await page.clock.runFor(1000);
  expect(requests).toEqual(loadedRequests);
  await expect(page.getByRole('button', { name: 'Load older snapshots' })).toBeEnabled();
  await page.getByRole('link', { name: 'All competitors' }).click();
  await page.getByRole('link', { name: /acme View timeline/ }).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await page.clock.runFor(10_000);
  expect(requests).toEqual(loadedRequests);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => requests).toEqual([...loadedRequests, null, '1', '2']);
  await page.clock.runFor(100);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(page.getByRole('article')).toHaveCount(3);
});

test('automatic refresh updates a pending summary without navigating away', async ({ page }) => {
  await page.clock.install();
  let ready = false;
  await watchlist(page, [competitor()]);
  await page.route('**/snapshots?*', (route) =>
    route.fulfill({
      json: [snapshot(ready ? { summaryStatus: 'ready', summary: 'Price decreased.' } : {})],
    }),
  );
  await page.goto('/#/competitors/acme');
  await expect(page.getByRole('heading', { name: 'Summary queued' })).toBeVisible();
  ready = true;
  await page.clock.fastForward(10_000);
  await expect(page.getByText('Price decreased.', { exact: true })).toBeVisible();
});

for (const payload of ['malformed', 'invalid-cursor']) {
  test(`invalid API ${payload} produces a useful error`, async ({ page }) => {
    await watchlist(page);
    await page.route('**/snapshots?*', (route) =>
      route.fulfill(
        payload === 'malformed'
          ? { json: [{ id: 'invalid' }] }
          : { json: [], headers: { 'X-Next-Cursor': 'invalid cursor!' } },
      ),
    );
    await page.goto('/#/competitors/acme');
    await expect(page.getByRole('alert')).toContainText(
      payload === 'malformed' ? 'unexpected response' : 'invalid history cursor',
    );
  });
}

test('invalid routes show a recoverable not-found page', async ({ page }) => {
  await watchlist(page);
  await page.goto('/#/competitors/%E0%A4%A');
  await expect(page.getByText('This page could not be found')).toBeVisible();
  await page.getByRole('link', { name: 'return to your competitors' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Competitors');
});

test('6000 competitors render at most 50 rows and support search and paging', async ({ page }) => {
  await watchlist(
    page,
    Array.from({ length: 6000 }, (_, index) =>
      competitor(`product-${String(index).padStart(4, '0')}`),
    ),
  );
  await page.goto('/');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(50);
  await expect(page.getByText('Page 1 of 120', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(rows.first()).toContainText('product-0050');
  await expect(rows).toHaveCount(50);
  await page.getByLabel('Search competitors').fill('PRODUCT-5999');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('product-5999');
  await expect(page.getByText('Page 1 of 1', { exact: false })).toBeVisible();
  await page.getByLabel('Search competitors').fill('missing');
  await expect(page.getByText('No competitors match your search')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await page.getByLabel('Search competitors').fill('');
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText('product-0000');
});

test('watchlist clamps the page after a refresh shrinks the list', async ({ page }) => {
  let items = Array.from({ length: 51 }, (_, index) => competitor(`item-${index}`));
  await page.route('**/api/competitors', (route) => route.fulfill({ json: items }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  items = items.slice(0, 50);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(page.getByText('Page 1 of 1', { exact: false })).toBeVisible();
});

test('timeline obtains tracking status without requesting the entire watchlist', async ({
  page,
}) => {
  let listRequests = 0;
  await page.route('**/api/competitors', (route) => {
    listRequests++;
    return route.fulfill({ json: [] });
  });
  await page.route('**/snapshots?*', (route) =>
    route.fulfill({ json: [], headers: { 'X-Tracking-Active': 'false' } }),
  );
  await page.goto('/#/competitors/acme');
  await expect(page.getByText('Tracking stopped')).toBeVisible();
  await expect(
    page.getByText('Tracking is stopped and no snapshots have been saved.', { exact: false }),
  ).toBeVisible();
  expect(listRequests).toBe(0);
});
