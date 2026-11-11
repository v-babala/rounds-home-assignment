import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle, type JobWithMetadata } from 'pg-boss';
import type pg from 'pg';
import type { Config } from '../config/env.js';
import type { Database, Transaction } from '../db/index.js';
import { llmDailyUsage, polls } from '../db/schema.js';
import {
  beginSummaryAttempt,
  expireUnfundedSummaries,
  finishSummary,
  generateSummary,
} from './service.js';

export const SUMMARY_QUEUE = 'listing-summary';
export const SUMMARY_FAILED_QUEUE = 'listing-summary-failed';
type SummaryData = { pollId: string };

function safeSummaryHandler<T>(handler: (jobs: T) => Promise<void>): (jobs: T) => Promise<void> {
  return async (jobs) => {
    try {
      await handler(jobs);
    } catch {
      // pg-boss serializes thrown errors to jsonb. Database errors can contain
      // external text in SQL parameters, so never forward their message or cause.
      throw Object.assign(new Error('Summary job processing failed'), {
        code: 'summary_job_error',
      });
    }
  };
}

export class SummaryQueue {
  readonly boss: PgBoss;

  constructor(
    private readonly db: Database,
    pool: pg.Pool,
    private readonly config: Config,
    onError: (error: Error) => void,
  ) {
    this.boss = new PgBoss({
      db: { executeSql: (text, values) => pool.query(text, values) },
      schedule: false,
    });
    this.boss.on('error', onError);
  }

  async start(): Promise<void> {
    // pg-boss owns migrations in its separate pgboss schema.
    await this.boss.start();
    await this.boss.createQueue(SUMMARY_FAILED_QUEUE, { retryLimit: 10, retryDelay: 5 });
    const options = {
      retryLimit: this.config.LLM_MAX_ATTEMPTS - 1,
      retryDelay: 1,
      retryBackoff: true,
      expireInSeconds: Math.max(60, Math.ceil(this.config.LLM_TIMEOUT_MS / 1000) + 30),
      retentionSeconds: 90 * 86400,
      deleteAfterSeconds: 86400,
    };
    await this.boss.createQueue(SUMMARY_QUEUE, { ...options, deadLetter: SUMMARY_FAILED_QUEUE });
    await this.boss.updateQueue(SUMMARY_QUEUE, options);
    await this.importPendingSummaries();
  }

  async enqueue(tx: Transaction, pollId: string): Promise<void> {
    // This is admission control, not a reservation. Consumers still atomically
    // reserve each actual attempt, including concurrent deliveries and retries.
    const [exhausted] = await tx
      .select({ day: llmDailyUsage.day })
      .from(llmDailyUsage)
      .where(
        and(
          eq(llmDailyUsage.day, sql`(clock_timestamp() at time zone 'UTC')::date`),
          sql`${llmDailyUsage.calls} >= ${this.config.LLM_DAILY_CAP}`,
        ),
      );
    if (this.config.LLM_DAILY_CAP === 0 || exhausted) {
      await tx
        .update(polls)
        .set({ summaryStatus: 'budget_exhausted', summaryErrorCode: 'daily_cap_reached' })
        .where(eq(polls.id, pollId));
      return;
    }
    const id = await this.boss.send(
      SUMMARY_QUEUE,
      { pollId },
      {
        id: pollId,
        db: fromDrizzle(tx, sql),
      },
    );
    if (!id) throw new Error('Summary job already exists for poll ' + pollId);
  }

  async expireUnfunded(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await expireUnfundedSummaries(tx, this.config.LLM_DAILY_CAP);
      // Also reconcile terminal polls left by older releases or by a consumer
      // that found no budget. Read pg-boss state, but settle through its API.
      const jobs = await tx.execute<{ id: string }>(sql`
        select p.id from polls p join pgboss.job j on j.id = p.id
        where p.summary_status = 'budget_exhausted'
          and j.name = ${SUMMARY_QUEUE} and j.state in ('created', 'retry', 'active')
        limit 1000 for update of p skip locked
      `);
      if (jobs.rows.length) {
        await this.boss.cancel(
          SUMMARY_QUEUE,
          jobs.rows.map(({ id }) => id),
          { db: fromDrizzle(tx, sql) },
        );
      }
    });
  }

  private async importPendingSummaries(): Promise<void> {
    // Upgrade existing databases without losing the old queue in polls. Stable IDs
    // make repeated starts harmless; existing pg-boss jobs retain their retry schedule.
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db
        .select({ id: polls.id })
        .from(polls)
        .where(
          and(
            inArray(polls.summaryStatus, ['pending', 'retry_wait', 'processing']),
            cursor ? gt(polls.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(polls.id))
        .limit(100);
      if (!batch.length) return;
      await this.db.transaction(async (tx) => {
        for (const { id } of batch) {
          await this.boss.send(
            SUMMARY_QUEUE,
            { pollId: id },
            {
              id,
              db: fromDrizzle(tx, sql),
            },
          );
        }
      });
      cursor = batch.at(-1)!.id;
    }
  }

  async work(signal: AbortSignal): Promise<void> {
    await this.boss.work<SummaryData>(
      SUMMARY_FAILED_QUEUE,
      safeSummaryHandler(async ([job]) => {
        // A crash on the final delivery never reaches finishSummary. The durable
        // dead-letter job makes that failure visible in the timeline after restart.
        await this.db
          .update(polls)
          .set({
            summaryStatus: 'failed',
            summaryErrorCode: 'queue_attempts_exhausted',
            summaryAttemptId: null,
          })
          .where(
            and(
              eq(polls.id, job!.data.pollId),
              inArray(polls.summaryStatus, ['pending', 'processing', 'retry_wait']),
            ),
          );
      }),
    );
    await this.boss.work(
      SUMMARY_QUEUE,
      {
        localConcurrency: this.config.LLM_CONCURRENCY,
        pollingIntervalSeconds: 0.5,
        includeMetadata: true,
      },
      safeSummaryHandler(async ([queued]: JobWithMetadata<SummaryData>[]) => {
        const job = queued!;
        const attemptSignal = AbortSignal.any([signal, job.signal]);
        attemptSignal.throwIfAborted();
        // Processing also covers an interrupted attempt imported from the old queue.
        const attempt = await beginSummaryAttempt(this.db, this.config, job.data.pollId, true);
        if (!attempt) return;
        attemptSignal.throwIfAborted();
        const result = await generateSummary(this.db, attempt, this.config, attemptSignal);
        await this.db.transaction(async (tx) => {
          const connection = { db: fromDrizzle(tx, sql) };
          const retry = await finishSummary(
            tx,
            attempt,
            result,
            this.config,
            job.retryCount < job.retryLimit,
          );
          if (!retry) {
            const settled = await this.boss.complete(SUMMARY_QUEUE, job, undefined, connection);
            if (!('affected' in settled) || settled.affected !== 1)
              throw new Error('Summary job lease lost');
            return;
          }
          const settled = await this.boss.fail(
            SUMMARY_QUEUE,
            job,
            { code: result.ok ? null : result.code },
            connection,
          );
          if (!('affected' in settled) || settled.affected !== 1)
            throw new Error('Summary job lease lost');
          if (!result.ok && result.retryAfterMs) {
            const [next] = await this.boss.findJobs(SUMMARY_QUEUE, { id: job.id, ...connection });
            if (next?.state === 'retry') {
              await this.boss.update(SUMMARY_QUEUE, undefined, {
                id: job.id,
                startAfter: new Date(
                  Math.max(new Date(next.startAfter).getTime(), Date.now() + result.retryAfterMs),
                ),
                ...connection,
              });
            }
          }
        });
      }),
    );
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 5000 });
  }
}
