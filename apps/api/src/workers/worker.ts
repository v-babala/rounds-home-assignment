import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import type { Database } from '../db/index.js';
import type { Config } from '../config/env.js';
import { SourceLimiter } from '../http/client.js';
import {
  claimPoll,
  cleanupHistory,
  fetchListing,
  finishPoll,
  recoverPolls,
  sourceCooldownMs,
  type PollJob,
} from '../polling/poller.js';
import { SummaryQueue } from '../summaries/queue.js';

const WORKER_LOCK = 742_915_031;

export class Worker {
  private readonly controller = new AbortController();
  private readonly sourceTasks = new Set<Promise<void>>();
  private readonly summaries: SummaryQueue;
  private readonly limiter: SourceLimiter;
  private connection: pg.PoolClient | undefined;
  private loop: Promise<void> | undefined;
  private failure: unknown;

  constructor(
    private readonly db: Database,
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {
    this.limiter = new SourceLimiter(config.SOURCE_REQUESTS_PER_SECOND);
    this.summaries = new SummaryQueue(db, pool, config, (error) => this.fail(error));
  }

  async start(): Promise<boolean> {
    const connection = await this.pool.connect();
    this.connection = connection;
    connection.on('error', this.onConnectionError);
    try {
      const result = await connection.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock($1) as acquired',
        [WORKER_LOCK],
      );
      if (!result.rows[0]?.acquired) {
        connection.removeListener('error', this.onConnectionError);
        connection.release();
        this.connection = undefined;
        return false;
      }
      await recoverPolls(this.db);
      await this.summaries.start();
      // Avoid a restart burst against requests initiated by the previous process.
      this.limiter.pause(Math.max(1000, await sourceCooldownMs(this.db)));
      await this.summaries.work(this.controller.signal);
      this.loop = this.run().catch((error: unknown) => this.fail(error));
      return true;
    } catch (error) {
      this.onConnectionError(error instanceof Error ? error : new Error('Worker startup failed'));
      await this.summaries.stop();
      connection.release(true);
      this.connection = undefined;
      throw error;
    }
  }

  private readonly onConnectionError = (error: Error) => this.fail(error);

  private fail(error: unknown): void {
    if (!this.controller.signal.aborted) console.error('Background worker stopped:', error);
    this.failure ??= error;
    this.controller.abort();
  }

  get healthy(): boolean {
    return !this.failure && !this.controller.signal.aborted;
  }

  private launch(tasks: Set<Promise<void>>, work: () => Promise<void>): void {
    const task = work()
      .catch((error: unknown) => this.fail(error))
      .finally(() => tasks.delete(task));
    tasks.add(task);
  }

  private async run(): Promise<void> {
    let nextMaintenance = 0;
    let nextHeartbeat = 0;
    let heldPoll: PollJob | null = null;
    while (!this.controller.signal.aborted) {
      const signal = this.controller.signal;
      if (Date.now() >= nextHeartbeat) {
        await this.connection!.query('select 1');
        nextHeartbeat = Date.now() + 1000;
      }
      if (
        this.sourceTasks.size < this.config.SOURCE_CONCURRENCY &&
        this.limiter.ready &&
        !signal.aborted
      ) {
        heldPoll ??= await claimPoll(this.db, this.config.POLL_INTERVAL_MS);
        if (heldPoll && this.limiter.ready && !signal.aborted) {
          const job = heldPoll;
          heldPoll = null;
          // Claim can take time; start spacing is measured immediately before HTTP.
          this.limiter.started();
          this.launch(this.sourceTasks, async () => {
            const result = await fetchListing(job.competitorId, this.config, signal);
            if (result.status === 'rate_limited') this.limiter.pause(result.retryAfterMs ?? 1000);
            await finishPoll(this.db, job, result, this.config, this.summaries);
          });
        }
      }
      if (Date.now() >= nextMaintenance && !signal.aborted) {
        await this.summaries.expireUnfunded();
        await cleanupHistory(this.db, this.config.RETENTION_DAYS);
        nextMaintenance = Date.now() + 1000;
      }
      await sleep(50, undefined, { signal }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.loop;
    await Promise.all([...this.sourceTasks]);
    await this.summaries.stop();
    if (this.connection) {
      this.connection.removeListener('error', this.onConnectionError);
      try {
        await this.connection.query('select pg_advisory_unlock($1)', [WORKER_LOCK]);
      } catch {
        /* Broken connections release their session locks on disconnect. */
      }
      this.connection.release(true);
      this.connection = undefined;
    }
  }
}
