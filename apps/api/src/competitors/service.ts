import { and, desc, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Competitor, Snapshot } from '@rounds/shared';
import type { Database } from '../db/index.js';
import { competitors, listingVersions, polls } from '../db/schema.js';

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() }).strict();
export type Cursor = { at: string; id: string };

export function decodeCursor(value: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const result = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function addCompetitor(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(competitors)
      .values({ id })
      .onConflictDoNothing()
      .returning({ id: competitors.id });
    if (created) return true;
    const [existing] = await tx
      .select()
      .from(competitors)
      .where(eq(competitors.id, id))
      .for('update');
    if (!existing) throw new Error('Competitor disappeared during upsert');
    if (existing.active) return false;
    await tx
      .update(competitors)
      .set({ active: true, nextPollAt: new Date(), consecutiveFailures: 0 })
      .where(eq(competitors.id, id));
    return true;
  });
}

export async function listCompetitors(db: Database): Promise<Competitor[]> {
  const rows = await db
    .select()
    .from(competitors)
    .where(eq(competitors.active, true))
    .orderBy(competitors.id);
  const cutoff = Date.now() - 86_400_000;
  return rows.map((row) => ({
    id: row.id,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastChangedAt: row.lastChangedAt?.toISOString() ?? null,
    changedInLast24h: row.lastChangedAt !== null && row.lastChangedAt.getTime() >= cutoff,
    lastPollStatus: row.lastPollStatus,
  }));
}

export async function listSnapshots(db: Database, id: string, limit: number, cursor?: Cursor) {
  const [competitor] = await db
    .select({ id: competitors.id, active: competitors.active })
    .from(competitors)
    .where(eq(competitors.id, id));
  if (!competitor) return null;
  const before = cursor
    ? or(
        lt(polls.startedAt, new Date(cursor.at)),
        and(eq(polls.startedAt, new Date(cursor.at)), lt(polls.id, cursor.id)),
      )
    : undefined;
  const rows = await db
    .select({ poll: polls, version: listingVersions })
    .from(polls)
    .leftJoin(listingVersions, eq(polls.versionId, listingVersions.id))
    .where(and(eq(polls.competitorId, id), before))
    .orderBy(desc(polls.startedAt), desc(polls.id))
    .limit(limit + 1);
  const data: Snapshot[] = rows.slice(0, limit).map(({ poll, version }) => ({
    id: poll.id,
    startedAt: poll.startedAt.toISOString(),
    fetchedAt: poll.fetchedAt?.toISOString() ?? null,
    title: version?.title ?? poll.partialFields?.title ?? null,
    tagline: version?.tagline ?? poll.partialFields?.tagline ?? null,
    price: version?.price ?? poll.partialFields?.price ?? null,
    description: version?.description ?? poll.partialFields?.description ?? null,
    pollStatus: poll.status,
    comparisonStatus: poll.comparisonStatus,
    changed: poll.comparisonStatus === 'changed',
    changedFields: poll.changedFields,
    missingFields: poll.missingFields,
    errorCode: poll.errorCode,
    httpStatus: poll.httpStatus,
    summary: poll.summary,
    summaryStatus: poll.summaryStatus,
    summaryErrorCode: poll.summaryErrorCode,
    summaryAttempts: poll.summaryAttempts,
    summaryProvider: poll.summaryProvider,
  }));
  const last = data.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify({ at: last.startedAt, id: last.id })).toString('base64url')
      : null;
  return { data, nextCursor, active: competitor.active };
}
