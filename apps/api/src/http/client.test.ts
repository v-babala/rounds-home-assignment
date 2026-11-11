import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceLimiter, normalizeRetryAfterMs, retryAfterMs } from './client.js';
import { envSchema } from '../config/env.js';

test('limiter spaces starts, never accumulates bursts, and pauses globally', () => {
  let now = 0;
  const limiter = new SourceLimiter(5, () => now);
  assert.equal(limiter.ready, true);
  limiter.started();
  now = 199;
  assert.equal(limiter.ready, false);
  now = 200;
  assert.equal(limiter.ready, true);
  limiter.started();
  limiter.pause(2000);
  now = 2199;
  assert.equal(limiter.ready, false);
  now = 2200;
  assert.equal(limiter.ready, true);
  now = 9000;
  limiter.started();
  assert.equal(limiter.ready, false);
  now = 9199;
  assert.equal(limiter.ready, false);
  now = 9200;
  assert.equal(limiter.ready, true);
});
test('Retry-After supports seconds, dates and invalid values', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
  assert.equal(retryAfterMs('nonsense'), 1000);
});
test('Retry-After falls back when a finite delay exceeds the Date range', () => {
  const now = 1_700_000_000_000;
  for (const value of ['999999999999999', '1'.repeat(400), 'nonsense', null]) {
    const delay = retryAfterMs(value, now);
    assert.equal(delay, 1000);
    assert.ok(Number.isFinite(new Date(now + delay).getTime()));
  }
  const maxDate = 8_640_000_000_000_000;
  const maxDelay = maxDate - now;
  assert.equal(retryAfterMs(String(maxDelay / 1000), now), maxDelay);
  assert.equal(retryAfterMs(String(maxDelay / 1000 + 1), now), 1000);
  // A delay valid at parse time may overflow by the time it is persisted.
  assert.equal(normalizeRetryAfterMs(maxDelay, now + 1), 1000);
  for (const delay of [NaN, Infinity, -Infinity, -1, 0]) {
    assert.equal(normalizeRetryAfterMs(delay, now), 1000);
  }
});
test('configuration enforces hard upper limits and retention floor', () => {
  for (const config of [
    { SOURCE_REQUESTS_PER_SECOND: 6 },
    { LLM_DAILY_CAP: 2001 },
    { LLM_MAX_ATTEMPTS: 4 },
    { RETENTION_DAYS: 89 },
    { SOURCE_BASE_URL: 'file:///tmp/data' },
  ]) {
    assert.equal(envSchema.safeParse(config).success, false);
  }
  assert.equal(envSchema.parse({ WORKER_ENABLED: 'false' }).WORKER_ENABLED, false);
});
