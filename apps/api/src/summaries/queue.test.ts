import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type pg from 'pg';
import type { Database } from '../db/index.js';
import { envSchema } from '../config/env.js';
import { SummaryQueue } from './queue.js';

test('both summary handlers replace unsafe database errors before pg-boss serializes them', async () => {
  const unsafe = Object.assign(new Error('SQL failed: Bad\u0000summary\ud800'), {
    params: ['Bad\u0000summary\ud800'],
    cause: new Error('private database details'),
  });
  const fail = () => {
    throw unsafe;
  };
  const db = { select: fail, update: fail } as unknown as Database;
  const queue = new SummaryQueue(db, {} as pg.Pool, envSchema.parse({}), fail);
  const handlers: ((jobs: unknown[]) => Promise<void>)[] = [];
  const work = mock.method(queue.boss, 'work', async (...args: unknown[]) => {
    handlers.push(args.at(-1) as (jobs: unknown[]) => Promise<void>);
    return 'test-worker';
  });
  try {
    await queue.work(new AbortController().signal);
    assert.equal(handlers.length, 2);
    for (const handler of handlers) {
      await assert.rejects(
        handler([{ data: { pollId: 'test' }, signal: new AbortController().signal }]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, 'Summary job processing failed');
          assert.deepEqual(Object.keys(error), ['code']);
          assert.equal((error as Error & { code: string }).code, 'summary_job_error');
          assert.equal(error.cause, undefined);
          assert.ok(!error.stack?.includes('Bad'));
          return true;
        },
      );
    }
  } finally {
    work.mock.restore();
  }
});
