import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from './app.js';

test('liveness does not require Postgres', async () => {
  const response = await app.request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
test('unknown route returns JSON 404', async () => {
  const response = await app.request('/api/missing');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: 'not_found', message: 'Not found' } });
});

test('validates competitor input and pagination before accessing Postgres', async () => {
  for (const body of [
    { id: '' },
    { id: '../escape' },
    { id: 123 },
    { id: 'a'.repeat(129) },
    { id: 'valid', extra: true },
  ]) {
    const response = await app.request('/api/competitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  for (const query of ['limit=0', 'limit=201', 'limit=x', 'cursor=bad', 'cursor=', 'extra=1']) {
    assert.equal((await app.request('/api/competitors/test/snapshots?' + query)).status, 400);
  }
  assert.equal(
    (
      await app.request('/api/competitors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request('/api/competitors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'a'.repeat(17_000) }),
      })
    ).status,
    413,
  );
});
