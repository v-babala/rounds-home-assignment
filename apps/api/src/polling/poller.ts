import { and, asc, desc, eq, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import type { Listing, ListingField, PollStatus } from '@rounds/shared';
import type { Database } from '../db/index.js';
import { competitors, listingVersions, polls } from '../db/schema.js';
import type { Config } from '../config/env.js';
import { backoffMs, ExternalError, normalizeRetryAfterMs, requestJson } from '../http/client.js';
import { changedFields, normalizeListing } from './normalization.js';
import type { SummaryQueue } from '../summaries/queue.js';

export type PollJob = typeof polls.$inferSelect;
export type PollResult =
  | { status: 'success'; listing: Listing; httpStatus: 200 }
  | {
      status: Exclude<PollStatus, 'success' | 'running'>;
      httpStatus: number | null;
      errorCode: string;
      partialFields?: Partial<Listing>;
      missingFields?: ListingField[];
      retryAfterMs?: number;
    };

export async function claimPoll(db: Database, intervalMs: number): Promise<PollJob | null> {
  return db.transaction(async (tx) => {
    const [competitor] = await tx
      .select()
      .from(competitors)
      .where(
        and(
          eq(competitors.active, true),
          lte(competitors.nextPollAt, new Date()),
          notExists(
            tx
              .select({ id: polls.id })
              .from(polls)
              .where(and(eq(polls.competitorId, competitors.id), eq(polls.status, 'running'))),
          ),
        ),
      )
      .orderBy(asc(competitors.nextPollAt), asc(competitors.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!competitor) return null;
    const now = new Date();
    const [job] = await tx
      .insert(polls)
      .values({ competitorId: competitor.id, startedAt: now })
      .returning();
    await tx
      .update(competitors)
      .set({ nextPollAt: new Date(now.getTime() + intervalMs) })
      .where(eq(competitors.id, competitor.id));
    return job ?? null;
  });
}

export async function fetchListing(
  id: string,
  config: Config,
  signal: AbortSignal,
): Promise<PollResult> {
  try {
    const body = await requestJson(
      config.SOURCE_BASE_URL.replace(/\/$/, '') + '/listings/' + encodeURIComponent(id),
      config.SOURCE_TIMEOUT_MS,
      signal,
    );
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return { status: 'invalid_response', httpStatus: 200, errorCode: 'invalid_listing' };
    const normalized = normalizeListing(body);
    if (!normalized.complete)
      return {
        status: 'incomplete',
        httpStatus: 200,
        errorCode: 'incomplete_listing',
        partialFields: normalized.fields,
        missingFields: normalized.missingFields,
      };
    return { status: 'success', listing: normalized.listing, httpStatus: 200 };
  } catch (error) {
    if (!(error instanceof ExternalError)) throw error;
    const status: PollResult['status'] =
      error.status === 404
        ? 'not_found'
        : error.status === 429
          ? 'rate_limited'
          : error.code === 'timeout'
            ? 'timeout'
            : error.code === 'network_error'
              ? 'network_error'
              : error.code === 'interrupted'
                ? 'interrupted'
                : error.code === 'http_error'
                  ? 'http_error'
                  : 'invalid_response';
    return {
      status,
      httpStatus: error.status,
      errorCode: status === 'not_found' ? 'not_found' : error.code,
      retryAfterMs: error.retryAfterMs,
    };
  }
}

export async function finishPoll(
  db: Database,
  job: PollJob,
  result: PollResult,
  config: Config,
  summaries: Pick<SummaryQueue, 'enqueue'>,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock order is always competitor -> poll, including claims and deletion.
    const [competitor] = await tx
      .select()
      .from(competitors)
      .where(eq(competitors.id, job.competitorId))
      .for('update');
    const [current] = await tx.select().from(polls).where(eq(polls.id, job.id)).for('update');
    if (!competitor || !current || current.status !== 'running') return;
    const now = new Date();
    if (result.status !== 'success') {
      const failures = Math.min(competitor.consecutiveFailures + 1, 1000);
      const retryDelay = normalizeRetryAfterMs(result.retryAfterMs ?? 0, now.getTime());
      // No tight retry loop: failures wait at least the configured interval.
      const delay = Math.max(config.POLL_INTERVAL_MS, backoffMs(failures), retryDelay);
      await tx
        .update(polls)
        .set({
          status: result.status,
          fetchedAt: now,
          httpStatus: result.httpStatus,
          errorCode: result.errorCode,
          sourceRetryAt:
            result.status === 'rate_limited' ? new Date(now.getTime() + retryDelay) : null,
          partialFields: result.partialFields,
          missingFields: result.missingFields ?? [],
        })
        .where(eq(polls.id, job.id));
      await tx
        .update(competitors)
        .set({
          lastPolledAt: now,
          lastPollStatus: result.status,
          consecutiveFailures: failures,
          nextPollAt: new Date(now.getTime() + delay),
        })
        .where(eq(competitors.id, job.competitorId));
      return;
    }
    const [previous] = competitor.lastValidVersionId
      ? await tx
          .select()
          .from(listingVersions)
          .where(eq(listingVersions.id, competitor.lastValidVersionId))
      : [];
    const changes = previous ? changedFields(previous, result.listing) : [];
    const comparison = !previous ? 'baseline' : changes.length ? 'changed' : 'unchanged';
    let versionId = previous?.id;
    if (!previous || changes.length) {
      const [version] = await tx
        .insert(listingVersions)
        .values({ competitorId: job.competitorId, ...result.listing, createdAt: now })
        .returning({ id: listingVersions.id });
      versionId = version!.id;
    }
    await tx
      .update(polls)
      .set({
        fetchedAt: now,
        status: 'success',
        httpStatus: 200,
        versionId,
        previousVersionId: previous?.id ?? null,
        comparisonStatus: comparison,
        changedFields: changes,
        summaryStatus: comparison === 'changed' ? 'pending' : comparison,
      })
      .where(eq(polls.id, job.id));
    if (comparison === 'changed') await summaries.enqueue(tx, job.id);
    await tx
      .update(competitors)
      .set({
        lastValidVersionId: versionId,
        lastPolledAt: now,
        lastPollStatus: 'success',
        consecutiveFailures: 0,
        ...(changes.length ? { lastChangedAt: now } : {}),
        nextPollAt: new Date(
          Math.max(job.startedAt.getTime() + config.POLL_INTERVAL_MS, now.getTime()),
        ),
      })
      .where(eq(competitors.id, job.competitorId));
  });
}

export async function recoverPolls(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    const interrupted = await tx
      .update(polls)
      .set({ status: 'interrupted', fetchedAt: new Date(), errorCode: 'worker_restarted' })
      .where(eq(polls.status, 'running'))
      .returning({ competitorId: polls.competitorId });
    for (const row of interrupted) {
      await tx
        .update(competitors)
        .set({ nextPollAt: new Date(), lastPolledAt: new Date(), lastPollStatus: 'interrupted' })
        .where(eq(competitors.id, row.competitorId));
    }
  });
}

export async function sourceCooldownMs(db: Database): Promise<number> {
  const [row] = await db
    .select({ until: polls.sourceRetryAt })
    .from(polls)
    .where(and(eq(polls.status, 'rate_limited'), isNotNull(polls.sourceRetryAt)))
    .orderBy(desc(polls.sourceRetryAt))
    .limit(1);
  return Math.max(0, (row?.until?.getTime() ?? 0) - Date.now());
}

export async function cleanupHistory(db: Database, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  await db.execute(sql`delete from polls where id in (
    select id from polls where started_at < ${cutoff} and status <> 'running'
      and summary_status not in ('pending', 'processing', 'retry_wait')
    order by started_at limit 1000
  )`);
  await db.execute(sql`delete from listing_versions where id in (
    select v.id from listing_versions v where v.created_at < ${cutoff}
      and not exists (select 1 from polls p where p.version_id = v.id)
      and not exists (select 1 from polls p where p.previous_version_id = v.id)
      and not exists (select 1 from competitors c where c.last_valid_version_id = v.id)
    order by v.created_at limit 1000
  )`);
}
