import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { snapshotSchema } from '@rounds/shared';
import * as schema from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import {
  addCompetitor,
  decodeCursor,
  listCompetitors,
  listSnapshots,
  type Cursor,
} from '../src/competitors/service.js';
import {
  claimPoll,
  cleanupHistory,
  fetchListing,
  finishPoll,
  recoverPolls,
  sourceCooldownMs,
  type PollResult,
} from '../src/polling/poller.js';
import { beginSummaryAttempt, finishSummary, generateSummary } from '../src/summaries/service.js';
import { envSchema } from '../src/config/env.js';
import { SummaryQueue, SUMMARY_QUEUE, SUMMARY_FAILED_QUEUE } from '../src/summaries/queue.js';
import { Worker } from '../src/workers/worker.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must point to a dedicated database ending in _test; tests clear its tables',
  );
const pool = new pg.Pool({ connectionString: url, max: 20 });
const db = drizzle(pool, { schema });
const config = envSchema.parse({ DATABASE_URL: url, POLL_INTERVAL_MS: 1000 });
const listing = {
  title: 'Product',
  tagline: 'CRM',
  price: 'USD 39/month',
  description: 'Track deals.',
};
const { competitors, listingVersions, polls, llmDailyUsage } = schema;
const queueErrors: Error[] = [];
const summaries = new SummaryQueue(db, pool, config, (error) => queueErrors.push(error));
before(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  await summaries.start();
});
beforeEach(async () => {
  assert.deepEqual(queueErrors, []);
  await summaries.boss.deleteAllJobs(SUMMARY_QUEUE);
  await summaries.boss.deleteAllJobs(SUMMARY_FAILED_QUEUE);
  await db.execute(sql`truncate competitors, listing_versions, polls, llm_daily_usage cascade`);
});
after(async () => {
  await summaries.stop();
  await pool.end();
  assert.deepEqual(queueErrors, []);
});

async function poll(
  id: string,
  result: PollResult = { status: 'success', listing, httpStatus: 200 },
) {
  await db
    .update(competitors)
    .set({ nextPollAt: new Date(0) })
    .where(eq(competitors.id, id));
  const job = await claimPoll(db, config.POLL_INTERVAL_MS);
  assert.ok(job);
  assert.equal(job.competitorId, id);
  await finishPoll(db, job, result, config, summaries);
  return job;
}
async function change(id: string) {
  await addCompetitor(db, id);
  await poll(id);
  return poll(id, {
    status: 'success',
    httpStatus: 200,
    listing: { ...listing, price: 'USD 29/month' },
  });
}
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
async function eventually(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(30);
  }
  assert.fail('Condition did not become true within ' + timeout + 'ms');
}

test('API upserts concurrently, validates contracts and retains deleted history', async () => {
  const app = createApp(db);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.request('/api/competitors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'unknown' }),
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 7);
  await poll('unknown', { status: 'not_found', httpStatus: 404, errorCode: 'not_found' });
  const response = await app.request('/api/competitors/unknown/snapshots');
  assert.equal(response.headers.get('X-Tracking-Active'), 'true');
  const history = snapshotSchema.array().parse(await response.json());
  assert.equal(history[0]!.summaryStatus, 'source_unavailable');
  assert.equal(history[0]!.title, null);
  assert.equal((await app.request('/api/competitors/missing/snapshots')).status, 404);
  assert.equal((await app.request('/api/competitors/unknown', { method: 'DELETE' })).status, 204);
  assert.equal((await app.request('/api/competitors/unknown', { method: 'DELETE' })).status, 204);
  assert.deepEqual(await listCompetitors(db), []);
  assert.equal(
    (await app.request('/api/competitors/unknown/snapshots')).headers.get('X-Tracking-Active'),
    'false',
  );
  assert.equal((await listSnapshots(db, 'unknown', 50))!.data.length, 1);
  assert.equal(await addCompetitor(db, 'unknown'), true);
});

test('history preserves failures and deduplicates unchanged versions; cursor ties are stable', async () => {
  await addCompetitor(db, 'acme');
  await poll('acme');
  await poll('acme', {
    status: 'incomplete',
    httpStatus: 200,
    errorCode: 'incomplete_listing',
    partialFields: { title: 'Partial' },
    missingFields: ['price'],
  });
  await poll('acme');
  await poll('acme', { status: 'not_found', httpStatus: 404, errorCode: 'not_found' });
  await poll('acme', {
    status: 'success',
    httpStatus: 200,
    listing: { ...listing, price: 'USD 29/month' },
  });
  await poll('acme'); // A -> B -> A creates a third version.
  assert.equal((await db.select().from(listingVersions)).length, 3);
  const rows = (await listSnapshots(db, 'acme', 50))!.data;
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((p) => p.changed).length, 2);
  assert.equal(rows.filter((p) => p.summaryStatus === 'baseline').length, 1);
  assert.equal((await listCompetitors(db))[0]!.changedInLast24h, true);
  const tiedTime = new Date('2026-01-01T12:00:00.123Z');
  await db.update(polls).set({ startedAt: tiedTime });
  const ids: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = (await listSnapshots(db, 'acme', 2, cursor))!;
    ids.push(...page.data.map((p) => p.id));
    cursor = page.nextCursor ? decodeCursor(page.nextCursor)! : undefined;
  } while (cursor);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
});

test('claim serialization, deletion during fetch, and interrupted recovery', async () => {
  await addCompetitor(db, 'acme');
  const claimed = await Promise.all(Array.from({ length: 8 }, () => claimPoll(db, 1000)));
  assert.equal(claimed.filter(Boolean).length, 1);
  const job = claimed.find((value) => value !== null)!;
  await db.update(competitors).set({ active: false }).where(eq(competitors.id, 'acme'));
  await finishPoll(db, job, { status: 'success', httpStatus: 200, listing }, config, summaries);
  assert.equal((await db.select().from(competitors))[0]!.active, false);
  assert.equal(await claimPoll(db, 1000), null);
  await addCompetitor(db, 'acme');
  assert.ok(await claimPoll(db, 1000));
  await recoverPolls(db);
  assert.equal(
    (await listSnapshots(db, 'acme', 50))!.data.filter((p) => p.pollStatus === 'interrupted')
      .length,
    1,
  );
  assert.ok(await claimPoll(db, 1000));
});

test('snapshot, version and baseline roll back together when persistence fails', async () => {
  await addCompetitor(db, 'acme');
  await poll('acme');
  await db
    .update(competitors)
    .set({ nextPollAt: new Date(0) })
    .where(eq(competitors.id, 'acme'));
  const job = (await claimPoll(db, 1000))!;
  await db.execute(sql`create function test_reject_update() returns trigger language plpgsql as $$
    begin raise exception 'injected persistence failure'; end $$`);
  await db.execute(
    sql`create trigger test_reject_update before update on competitors for each row execute function test_reject_update()`,
  );
  try {
    await assert.rejects(
      finishPoll(
        db,
        job,
        { status: 'success', httpStatus: 200, listing: { ...listing, price: 'USD 29/month' } },
        config,
        summaries,
      ),
    );
    assert.equal((await db.select().from(listingVersions)).length, 1);
    const [interrupted] = await db.select().from(polls).where(eq(polls.id, job.id));
    assert.equal(interrupted!.status, 'running');
    assert.equal(interrupted!.summaryStatus, 'source_unavailable');
    assert.deepEqual(await summaries.boss.findJobs(SUMMARY_QUEUE), []);
    assert.equal(await beginSummaryAttempt(db, config, job.id), null);
  } finally {
    await db.execute(sql`drop trigger test_reject_update on competitors`);
    await db.execute(sql`drop function test_reject_update()`);
  }
});

test('last daily slot is reserved atomically; failed attempts count and exhausted jobs are terminal', async () => {
  const changed: { id: string }[] = [];
  for (const id of ['one', 'two', 'three', 'four']) changed.push(await change(id));
  const day = new Date().toISOString().slice(0, 10);
  await db.insert(llmDailyUsage).values({ day, calls: 1999 });
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      beginSummaryAttempt(db, config, changed[i % changed.length]!.id),
    ),
  );
  const jobs = claims.filter((job) => job !== null);
  assert.equal(jobs.length, 1);
  assert.equal((await db.select().from(llmDailyUsage))[0]!.calls, 2000);
  await finishSummary(db, jobs[0]!, { ok: false, code: 'timeout', retryable: true }, config);
  await summaries.expireUnfunded();
  const changes = (await db.select().from(polls)).filter((p) => p.comparisonStatus === 'changed');
  assert.ok(changes.every((p) => p.summaryStatus === 'budget_exhausted'));
  assert.ok(changes.every((p) => p.versionId !== null));
  assert.ok((await summaries.boss.findJobs(SUMMARY_QUEUE)).every((j) => j.state === 'cancelled'));
  assert.equal((await db.select().from(llmDailyUsage))[0]!.calls, 2000);
});

test('budget expiration cancels a backlog atomically without consumers and admits work after reset', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) ids.push((await change('backlog-' + i)).id);
  // Delayed retries must be cancelled too, without waiting for their due time.
  await summaries.boss.update(SUMMARY_QUEUE, undefined, {
    id: ids[0]!,
    startAfter: new Date(Date.now() + 86400_000),
  });
  await db.update(polls).set({ summaryStatus: 'retry_wait' }).where(eq(polls.id, ids[0]!));
  // Simulate a terminal poll left behind by the previous implementation.
  await db.update(polls).set({ summaryStatus: 'budget_exhausted' }).where(eq(polls.id, ids[1]!));
  const processing = await change('processing');
  assert.ok(await beginSummaryAttempt(db, config, processing.id));
  await db.update(llmDailyUsage).set({ calls: config.LLM_DAILY_CAP });

  await db.execute(sql`create function test_reject_cancel() returns trigger language plpgsql as $$
    begin if NEW.state = 'cancelled' then raise exception 'injected cancellation failure'; end if; return NEW; end $$`);
  await db.execute(sql`create trigger test_reject_cancel before update on pgboss.job
    for each row execute function test_reject_cancel()`);
  try {
    await assert.rejects(summaries.expireUnfunded());
    const [pending] = await db.select().from(polls).where(eq(polls.id, ids[2]!));
    assert.equal(pending!.summaryStatus, 'pending');
    assert.ok((await summaries.boss.findJobs(SUMMARY_QUEUE)).every((j) => j.state === 'created'));
  } finally {
    await db.execute(sql`drop trigger test_reject_cancel on pgboss.job`);
    await db.execute(sql`drop function test_reject_cancel()`);
  }
  await summaries.expireUnfunded();
  const jobs = await summaries.boss.findJobs(SUMMARY_QUEUE);
  assert.equal(jobs.filter((j) => j.state === 'cancelled').length, 40);
  const [inFlight] = await db.select().from(polls).where(eq(polls.id, processing.id));
  assert.equal(inFlight!.summaryStatus, 'processing');
  for (const row of await db.select().from(polls)) {
    if (ids.includes(row.id)) assert.equal(row.summaryStatus, 'budget_exhausted');
  }
  const unfunded = await change('unfunded');
  assert.deepEqual(await summaries.boss.findJobs(SUMMARY_QUEUE, { id: unfunded.id }), []);
  const [unfundedPoll] = await db.select().from(polls).where(eq(polls.id, unfunded.id));
  assert.equal(unfundedPoll!.summaryStatus, 'budget_exhausted');
  assert.ok(unfundedPoll!.versionId);
  // Model the UTC budget reset without depending on wall-clock midnight.
  await db.delete(llmDailyUsage);
  const funded = await change('funded');
  assert.equal(
    (await summaries.boss.findJobs(SUMMARY_QUEUE, { id: funded.id }))[0]!.state,
    'created',
  );
  assert.ok(await beginSummaryAttempt(db, config, funded.id));
});

test('zero budget records changes without creating summary jobs', async () => {
  const zeroBudget = new SummaryQueue(db, pool, { ...config, LLM_DAILY_CAP: 0 }, (error) => {
    throw error;
  });
  await addCompetitor(db, 'zero');
  await poll('zero');
  await db.update(competitors).set({ nextPollAt: new Date(0) });
  const job = (await claimPoll(db, 1000))!;
  await finishPoll(
    db,
    job,
    {
      status: 'success',
      httpStatus: 200,
      listing: { ...listing, price: 'USD 29/month' },
    },
    config,
    zeroBudget,
  );
  assert.deepEqual(await summaries.boss.findJobs(SUMMARY_QUEUE), []);
  const [row] = await db.select().from(polls).where(eq(polls.id, job.id));
  assert.equal(row!.summaryStatus, 'budget_exhausted');
  assert.equal(row!.summaryErrorCode, 'daily_cap_reached');
  assert.equal((await db.select().from(llmDailyUsage)).length, 0);
});

test('new UTC day has a separate budget and cap zero makes no reservation', async () => {
  const acme = await change('acme');
  await db.insert(llmDailyUsage).values({ day: '2000-01-01', calls: 2000 });
  assert.ok(await beginSummaryAttempt(db, config, acme.id));
  assert.equal((await db.select().from(llmDailyUsage)).length, 2);
  const other = await change('other');
  assert.equal(await beginSummaryAttempt(db, { ...config, LLM_DAILY_CAP: 0 }, other.id), null);
  assert.equal(
    (await listSnapshots(db, 'other', 50))!.data.find((p) => p.changed)!.summaryStatus,
    'budget_exhausted',
  );
});

test('oversized Retry-After persists rate limits with valid retry dates', async () => {
  const source = await server((_req, res) => {
    res.writeHead(429, { 'Retry-After': '999999999999999' });
    res.end();
  });
  try {
    const result = await fetchListing(
      'limited',
      { ...config, SOURCE_BASE_URL: source.url },
      new AbortController().signal,
    );
    assert.equal(result.status, 'rate_limited');
    assert.equal(result.retryAfterMs, 1000);
    await addCompetitor(db, 'limited');
    // Also exercise persistence independently of the HTTP parser's validation.
    let failures = 0;
    for (const retryAfterMs of [result.retryAfterMs, 999999999999999000, Infinity, NaN]) {
      const job = await poll('limited', { ...result, retryAfterMs });
      const [row] = await db.select().from(polls).where(eq(polls.id, job.id));
      const [competitor] = await db.select().from(competitors).where(eq(competitors.id, 'limited'));
      assert.equal(row!.status, 'rate_limited');
      assert.equal(row!.httpStatus, 429);
      assert.equal(row!.sourceRetryAt!.getTime(), row!.fetchedAt!.getTime() + 1000);
      assert.equal(competitor!.lastPollStatus, 'rate_limited');
      assert.equal(competitor!.consecutiveFailures, ++failures);
      assert.ok(Number.isFinite(competitor!.nextPollAt.getTime()));
      assert.ok(competitor!.nextPollAt.getTime() >= row!.sourceRetryAt!.getTime());
    }
  } finally {
    await source.close();
  }
});

test('restart preserves source cooldown and does not revive yesterday’s exhausted summaries', async () => {
  await addCompetitor(db, 'limited');
  await poll('limited', {
    status: 'rate_limited',
    httpStatus: 429,
    errorCode: 'http_error',
    retryAfterMs: 60_000,
  });
  await recoverPolls(db);
  assert.ok((await sourceCooldownMs(db)) > 59_000);
  const acme = await change('acme');
  await db
    .update(polls)
    .set({ fetchedAt: new Date('2000-01-01T12:00:00Z') })
    .where(eq(polls.comparisonStatus, 'changed'));
  await db.insert(llmDailyUsage).values({ day: '2000-01-01', calls: 2000 });
  assert.equal(await beginSummaryAttempt(db, config, acme.id), null);
  assert.equal(
    (await listSnapshots(db, 'acme', 50))!.data.find((p) => p.changed)!.summaryStatus,
    'budget_exhausted',
  );
});

test('retry recovery rejects stale completions and stops after three attempts', async () => {
  const acme = await change('acme');
  const first = (await beginSummaryAttempt(db, config, acme.id))!;
  const second = (await beginSummaryAttempt(db, config, acme.id, true))!;
  await finishSummary(db, first, { ok: true, summary: 'Stale result' }, config);
  assert.equal((await db.select().from(polls).where(eq(polls.id, first.id)))[0]!.summary, null);
  await finishSummary(
    db,
    second,
    { ok: false, code: 'invalid_completion', retryable: true },
    config,
  );
  const third = (await beginSummaryAttempt(db, config, acme.id))!;
  await finishSummary(db, third, { ok: false, code: 'timeout', retryable: true }, config);
  assert.equal(
    (await db.select().from(polls).where(eq(polls.id, first.id)))[0]!.summaryStatus,
    'failed',
  );
  assert.equal(await beginSummaryAttempt(db, config, acme.id), null);
  assert.equal((await db.select().from(llmDailyUsage))[0]!.calls, 3);
});

test('HTTP failures, malformed/partial/oversized bodies, timeout and real LLM request context', async () => {
  let mode = 'normal';
  let context = '';
  const external = await server(async (req, res) => {
    if (mode === 'timeout') return;
    if (mode === '500') {
      res.writeHead(500);
      res.end('<html>Error</html>');
      return;
    }
    if (mode === '401') {
      res.writeHead(401);
      res.end();
      return;
    }
    if (mode === '429') {
      res.writeHead(429, { 'Retry-After': '2' });
      res.end();
      return;
    }
    if (mode === '404') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (mode === 'bad') {
      res.end('{');
      return;
    }
    if (mode === 'large') {
      res.end('x'.repeat(300_000));
      return;
    }
    if (req.url?.includes('chat/completions')) {
      for await (const chunk of req) context += String(chunk);
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: mode === 'empty' ? ' ' : 'Price dropped from USD 39 to USD 29 per month.',
              },
            },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify(mode === 'partial' ? { title: 'Partial' } : listing));
  });
  const settings = {
    ...config,
    SOURCE_BASE_URL: external.url,
    SOURCE_TIMEOUT_MS: 80,
    LLM_BASE_URL: external.url,
    LLM_TIMEOUT_MS: 80,
  };
  const signal = new AbortController().signal;
  try {
    for (const [scenario, expected] of [
      ['normal', 'success'],
      ['500', 'http_error'],
      ['429', 'rate_limited'],
      ['404', 'not_found'],
      ['bad', 'invalid_response'],
      ['large', 'invalid_response'],
      ['partial', 'incomplete'],
      ['timeout', 'timeout'],
    ]) {
      mode = scenario!;
      const result = await fetchListing('acme', settings, signal);
      assert.equal(result.status, expected);
      if (result.status === 'rate_limited') assert.equal(result.retryAfterMs, 2000);
    }
    const acme = await change('acme');
    const job = (await beginSummaryAttempt(db, settings, acme.id))!;
    mode = 'normal';
    const result = await generateSummary(db, job, settings, signal);
    assert.equal(result.ok, true);
    const sent = JSON.parse(context) as { messages: { content: string }[] };
    assert.match(sent.messages[1]!.content, /USD 39\/month/);
    assert.match(sent.messages[1]!.content, /USD 29\/month/);
    mode = 'empty';
    assert.deepEqual(await generateSummary(db, job, settings, signal), {
      ok: false,
      code: 'invalid_completion',
      retryable: true,
    });
    mode = 'timeout';
    assert.equal((await generateSummary(db, job, settings, signal)).ok, false);
    mode = '500';
    const transient = await generateSummary(db, job, settings, signal);
    assert.ok(!transient.ok && transient.retryable);
    mode = '401';
    const permanent = await generateSummary(db, job, settings, signal);
    assert.ok(!permanent.ok && !permanent.retryable);
  } finally {
    await external.close();
  }
});

test('retention deletes old polls but keeps versions referenced by current baseline or recent history', async () => {
  await change('acme');
  const old = new Date(Date.now() - 100 * 86_400_000);
  await db.update(polls).set({ startedAt: old, summaryStatus: 'failed' });
  await db.update(listingVersions).set({ createdAt: old });
  await poll('acme', {
    status: 'success',
    httpStatus: 200,
    listing: { ...listing, price: 'USD 29/month' },
  });
  await cleanupHistory(db, 90);
  assert.equal((await db.select().from(polls)).length, 1);
  assert.equal((await db.select().from(listingVersions)).length, 1);
  assert.ok((await db.select().from(competitors))[0]!.lastValidVersionId);
});

test('worker enforces a global cooldown, bounded concurrency and independent LLM processing', async () => {
  let price = '$39/mo';
  let rateLimitNext = true;
  let active = 0;
  let maxActive = 0;
  const starts: number[] = [];
  let llmCalls = 0;
  const external = await server(async (req, res) => {
    if (req.url?.includes('chat/completions')) {
      llmCalls++;
      await sleep(900);
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'Price decreased.' } }],
        }),
      );
      return;
    }
    starts.push(Date.now());
    if (rateLimitNext) {
      rateLimitNext = false;
      res.writeHead(429, { 'Retry-After': '1' });
      res.end();
      return;
    }
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(250);
    active--;
    res.end(JSON.stringify({ ...listing, price }));
  });
  const settings = {
    ...config,
    SOURCE_BASE_URL: external.url,
    LLM_BASE_URL: external.url,
    SOURCE_CONCURRENCY: 2,
    SOURCE_TIMEOUT_MS: 2000,
    LLM_TIMEOUT_MS: 2000,
  };
  for (const id of ['one', 'two', 'three']) await addCompetitor(db, id);
  const worker = new Worker(db, pool, settings);
  const duplicate = new Worker(db, pool, settings);
  try {
    assert.equal(await worker.start(), true);
    assert.equal(await duplicate.start(), false);
    await eventually(async () => (await db.select().from(listingVersions)).length === 3, 7000);
    assert.ok(starts[1]! - starts[0]! >= 990, '429 must pause all IDs');
    assert.ok(maxActive <= 2);
    for (let i = 1; i < starts.length; i++)
      assert.ok(starts[i]! - starts[i - 1]! >= 190, 'requests must be paced');
    assert.equal(llmCalls, 0, 'baseline and unchanged polls do not call LLM');
    price = '$29/mo';
    await eventually(async () => llmCalls > 0);
    const countAtLlmStart = starts.length;
    await eventually(async () => starts.length > countAtLlmStart, 1000);
    assert.equal((await createApp(db).request('/api/competitors')).status, 200);
    await eventually(async () =>
      (await db.select().from(polls)).some((p) => p.summaryStatus === 'ready'),
    );
  } finally {
    await worker.stop();
    await duplicate.stop();
    await external.close();
  }
});

for (const scenario of [
  { name: 'NUL', title: 'Acme\u0000CRM', missingPrice: false },
  { name: 'unpaired surrogate', title: 'Acme\ud800CRM', missingPrice: true },
]) {
  test(`repeated ${scenario.name} source data completes polls without stopping the worker or replacing a baseline`, async () => {
    await addCompetitor(db, 'bad');
    await poll('bad');
    const [baseline] = await db.select().from(listingVersions);
    await db.update(competitors).set({ nextPollAt: new Date(0) });
    await addCompetitor(db, 'good');
    const external = await server((req, res) => {
      res.end(
        JSON.stringify(
          req.url?.endsWith('/bad')
            ? {
                ...listing,
                title: scenario.title,
                ...(scenario.missingPrice ? { price: undefined } : {}),
              }
            : { ...listing, title: 'Good' },
        ),
      );
    });
    const worker = new Worker(db, pool, { ...config, SOURCE_BASE_URL: external.url });
    try {
      assert.equal(await worker.start(), true);
      await eventually(async () => {
        const rows = await db.select().from(polls);
        return (
          rows.filter((p) => p.competitorId === 'bad' && p.status === 'incomplete').length >= 2 &&
          rows.some((p) => p.competitorId === 'good' && p.status === 'success')
        );
      }, 10000);
      assert.equal(worker.healthy, true);
      const badPolls = await db.select().from(polls).where(eq(polls.competitorId, 'bad'));
      assert.ok(badPolls.every((p) => p.status !== 'running'));
      for (const row of badPolls.filter((p) => p.status === 'incomplete')) {
        assert.ok(row.fetchedAt);
        assert.deepEqual(row.missingFields, scenario.missingPrice ? ['title', 'price'] : ['title']);
        assert.deepEqual(row.partialFields, {
          tagline: listing.tagline,
          ...(scenario.missingPrice ? {} : { price: listing.price }),
          description: listing.description,
        });
      }
      const [bad] = await db.select().from(competitors).where(eq(competitors.id, 'bad'));
      assert.equal(bad!.lastValidVersionId, baseline!.id);
      assert.equal(
        (await db.select().from(listingVersions).where(eq(listingVersions.competitorId, 'bad')))
          .length,
        1,
      );
      assert.equal(
        (await createApp(db, () => worker.healthy).request('/api/competitors')).status,
        200,
      );
    } finally {
      await worker.stop();
      await external.close();
    }
  });
}

test('enqueue failure rolls back snapshot, version and baseline', async () => {
  await addCompetitor(db, 'acme');
  await poll('acme');
  await db.update(competitors).set({ nextPollAt: new Date(0) });
  const job = (await claimPoll(db, 1000))!;
  const [before] = await db.select().from(competitors);
  await db.execute(sql`create function test_reject_enqueue() returns trigger language plpgsql as $$
    begin raise exception 'injected enqueue failure'; end $$`);
  await db.execute(sql`create trigger test_reject_enqueue before insert on pgboss.job
    for each row execute function test_reject_enqueue()`);
  try {
    await assert.rejects(
      finishPoll(
        db,
        job,
        {
          status: 'success',
          httpStatus: 200,
          listing: { ...listing, price: 'USD 29/month' },
        },
        config,
        summaries,
      ),
    );
    assert.equal((await db.select().from(listingVersions)).length, 1);
    assert.equal(
      (await db.select().from(competitors))[0]!.lastValidVersionId,
      before!.lastValidVersionId,
    );
    assert.equal((await db.select().from(polls).where(eq(polls.id, job.id)))[0]!.status, 'running');
    assert.deepEqual(await summaries.boss.findJobs(SUMMARY_QUEUE), []);
  } finally {
    await db.execute(sql`drop trigger test_reject_enqueue on pgboss.job`);
    await db.execute(sql`drop function test_reject_enqueue()`);
  }
});

test('pg-boss retries honor Retry-After and survive restarting the consumer', async () => {
  const starts: number[] = [];
  const external = await server((_req, res) => {
    starts.push(Date.now());
    if (starts.length === 1) {
      res.writeHead(429, { 'Retry-After': '2' });
      res.end();
    } else {
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'Price decreased.' } }],
        }),
      );
    }
  });
  const settings = { ...config, LLM_BASE_URL: external.url };
  const first = new SummaryQueue(db, pool, settings, (error) => queueErrors.push(error));
  const second = new SummaryQueue(db, pool, settings, (error) => queueErrors.push(error));
  const acme = await change('acme');
  try {
    await first.start();
    await first.work(new AbortController().signal);
    await eventually(async () => {
      const [job] = await summaries.boss.findJobs(SUMMARY_QUEUE, { id: acme.id });
      if (job?.state === 'retry')
        assert.equal(
          (await db.select().from(polls).where(eq(polls.id, acme.id)))[0]!.summaryStatus,
          'retry_wait',
          JSON.stringify(job.output),
        );
      return job?.state === 'retry';
    });
    assert.equal(
      (await db.select().from(polls).where(eq(polls.id, acme.id)))[0]!.summaryStatus,
      'retry_wait',
    );
    await first.stop();
    await second.start();
    assert.equal(
      (await summaries.boss.findJobs(SUMMARY_QUEUE)).length,
      1,
      'restart must not duplicate jobs',
    );
    await second.work(new AbortController().signal);
    await eventually(
      async () =>
        (await db.select().from(polls).where(eq(polls.id, acme.id)))[0]!.summaryStatus === 'ready',
    );
    assert.equal(starts.length, 2);
    assert.ok(starts[1]! - starts[0]! >= 2000);
    assert.equal((await db.select().from(llmDailyUsage))[0]!.calls, 2);
    assert.equal(
      (await summaries.boss.findJobs(SUMMARY_QUEUE, { id: acme.id }))[0]!.state,
      'completed',
    );
  } finally {
    await first.stop();
    await second.stop();
    await external.close();
  }
});

test('pg-boss stops permanent errors immediately and transient errors after three calls', async () => {
  let status = 401;
  let calls = 0;
  const external = await server((_req, res) => {
    calls++;
    res.writeHead(status);
    res.end();
  });
  const consumer = new SummaryQueue(db, pool, { ...config, LLM_BASE_URL: external.url }, (error) =>
    queueErrors.push(error),
  );
  try {
    await consumer.start();
    const permanent = await change('permanent');
    await consumer.work(new AbortController().signal);
    await eventually(
      async () =>
        (await db.select().from(polls).where(eq(polls.id, permanent.id)))[0]!.summaryStatus ===
        'failed',
    );
    assert.equal(calls, 1);
    status = 500;
    const transient = await change('transient');
    await eventually(
      async () =>
        (await db.select().from(polls).where(eq(polls.id, transient.id)))[0]!.summaryStatus ===
        'failed',
      10000,
    );
    assert.equal(calls, 4);
    assert.equal((await db.select().from(llmDailyUsage))[0]!.calls, 4);
    assert.equal(
      (await db.select().from(polls).where(eq(polls.id, transient.id)))[0]!.summaryAttempts,
      3,
    );
  } finally {
    await consumer.stop();
    await external.close();
  }
});

test('invalid Unicode LLM completions fail normally while the worker continues polling and processing summaries', async () => {
  const invalid = ['Bad\u0000summary', 'Bad\ud800summary', 'Bad\udc00summary'];
  let llmCalls = 0;
  let recovered = false;
  const external = await server((req, res) => {
    if (req.url?.includes('chat/completions')) {
      const content = recovered ? 'Price decreased. 🚀' : invalid[llmCalls % invalid.length];
      llmCalls++;
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    } else {
      const price = req.url?.endsWith('/bad') || recovered ? 'USD 29/month' : listing.price;
      res.end(JSON.stringify({ ...listing, price }));
    }
  });
  const bad = await change('bad');
  await addCompetitor(db, 'good');
  await poll('good');
  const worker = new Worker(db, pool, {
    ...config,
    SOURCE_BASE_URL: external.url,
    LLM_BASE_URL: external.url,
  });
  try {
    assert.equal(await worker.start(), true);
    await eventually(
      async () =>
        (await db.select().from(polls).where(eq(polls.id, bad.id)))[0]!.summaryStatus === 'failed',
      10000,
    );
    const [failed] = await db.select().from(polls).where(eq(polls.id, bad.id));
    assert.equal(failed!.status, 'success');
    assert.equal(failed!.summaryErrorCode, 'invalid_completion');
    assert.equal(failed!.summaryAttempts, 3);
    assert.equal(failed!.summary, null);
    assert.ok(failed!.versionId);
    assert.equal(llmCalls, 3);
    assert.equal(worker.healthy, true);
    const goodPolls = await db.select().from(polls).where(eq(polls.competitorId, 'good'));
    assert.ok(goodPolls.filter((p) => p.status === 'success').length >= 2);
    recovered = true;
    await eventually(
      async () =>
        (await db.select().from(polls).where(eq(polls.competitorId, 'good'))).some(
          (p) => p.summaryStatus === 'ready' && p.summary === 'Price decreased. 🚀',
        ),
      10000,
    );
    assert.equal(worker.healthy, true);
  } finally {
    await worker.stop();
    await external.close();
  }
});

test('expired deliveries recover through pg-boss and final crashes become visible failures', async () => {
  const acme = await change('acme');
  // No HTTP or sleeping: age the persisted claim to simulate a process killed
  // after reserving budget. The real pg-boss supervisor handles the expiration.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [queued] = await summaries.boss.fetch<{ pollId: string }>(SUMMARY_QUEUE);
    assert.ok(queued);
    assert.equal(queued.retryCount, attempt);
    assert.ok(await beginSummaryAttempt(db, config, acme.id, true));
    await db.execute(sql`update pgboss.job set started_on = now() - interval '2 minutes'
      where name = ${SUMMARY_QUEUE} and id = ${acme.id}`);
    await db.execute(
      sql`update pgboss.queue set monitor_on = null, monitor_claim_on = null where name = ${SUMMARY_QUEUE}`,
    );
    await summaries.boss.supervise(SUMMARY_QUEUE);
    if (attempt < 2) {
      assert.equal(
        (await summaries.boss.findJobs(SUMMARY_QUEUE, { id: acme.id }))[0]!.state,
        'retry',
      );
      await summaries.boss.update(SUMMARY_QUEUE, undefined, {
        id: acme.id,
        startAfter: new Date(0),
      });
    }
  }
  assert.equal((await summaries.boss.findJobs(SUMMARY_FAILED_QUEUE)).length, 1);
  const consumer = new SummaryQueue(db, pool, config, (error) => queueErrors.push(error));
  try {
    await consumer.start();
    await consumer.work(new AbortController().signal);
    await eventually(
      async () =>
        (await db.select().from(polls).where(eq(polls.id, acme.id)))[0]!.summaryStatus === 'failed',
    );
    assert.equal(
      (await db.select().from(llmDailyUsage))[0]!.calls,
      3,
      'recovery must not refund or reserve extra calls',
    );
    assert.equal(
      (await db.select().from(polls).where(eq(polls.id, acme.id)))[0]!.summaryErrorCode,
      'queue_attempts_exhausted',
    );
  } finally {
    await consumer.stop();
  }
});

test('existing pending and processing summaries are imported once without resetting attempts', async () => {
  const pending = await change('pending');
  const processing = await change('processing');
  await beginSummaryAttempt(db, config, processing.id);
  await summaries.boss.deleteAllJobs(SUMMARY_QUEUE); // Database predating pg-boss.
  const consumer = new SummaryQueue(db, pool, config, (error) => queueErrors.push(error));
  try {
    await consumer.start();
    const jobs = await summaries.boss.findJobs(SUMMARY_QUEUE);
    assert.deepEqual(new Set(jobs.map((job) => job.id)), new Set([pending.id, processing.id]));
    assert.equal(
      (await db.select().from(polls).where(eq(polls.id, processing.id)))[0]!.summaryAttempts,
      1,
    );
    assert.equal((await db.select().from(llmDailyUsage))[0]!.calls, 1);
  } finally {
    await consumer.stop();
  }
});
