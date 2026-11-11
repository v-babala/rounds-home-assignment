import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  pollStatuses,
  comparisonStatuses,
  summaryStatuses,
  type Listing,
  type ListingField,
} from '@rounds/shared';

const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
export const pollStatus = pgEnum('poll_status', pollStatuses);
export const comparisonStatus = pgEnum('comparison_status', comparisonStatuses);
export const summaryStatus = pgEnum('summary_status', summaryStatuses);

export const competitors = pgTable(
  'competitors',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    active: boolean('active').default(true).notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    nextPollAt: time('next_poll_at').defaultNow().notNull(),
    lastPolledAt: time('last_polled_at'),
    lastPollStatus: pollStatus('last_poll_status'),
    lastChangedAt: time('last_changed_at'),
    lastValidVersionId: uuid('last_valid_version_id').references(
      (): AnyPgColumn => listingVersions.id,
    ),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  },
  (table) => [
    index('competitors_due_idx')
      .on(table.nextPollAt, table.id)
      .where(sql`${table.active} = true`),
    index('competitors_baseline_idx').on(table.lastValidVersionId),
  ],
);

export const listingVersions = pgTable(
  'listing_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    competitorId: varchar('competitor_id', { length: 128 })
      .references((): AnyPgColumn => competitors.id)
      .notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    title: text('title').notNull(),
    tagline: text('tagline').notNull(),
    price: text('price').notNull(),
    description: text('description').notNull(),
  },
  (table) => [index('versions_created_idx').on(table.createdAt)],
);

export const polls = pgTable(
  'polls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    competitorId: varchar('competitor_id', { length: 128 })
      .references(() => competitors.id)
      .notNull(),
    startedAt: time('started_at').defaultNow().notNull(),
    fetchedAt: time('fetched_at'),
    status: pollStatus('status').default('running').notNull(),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    sourceRetryAt: time('source_retry_at'),
    versionId: uuid('version_id').references(() => listingVersions.id),
    previousVersionId: uuid('previous_version_id').references(() => listingVersions.id),
    comparisonStatus: comparisonStatus('comparison_status').default('unavailable').notNull(),
    changedFields: jsonb('changed_fields').$type<ListingField[]>().default([]).notNull(),
    partialFields: jsonb('partial_fields').$type<Partial<Listing>>(),
    missingFields: jsonb('missing_fields').$type<ListingField[]>().default([]).notNull(),
    summaryStatus: summaryStatus('summary_status').default('source_unavailable').notNull(),
    summary: text('summary'),
    summaryErrorCode: text('summary_error_code'),
    summaryAttempts: integer('summary_attempts').default(0).notNull(),
    summaryAttemptId: uuid('summary_attempt_id'),
    summaryStartedAt: time('summary_started_at'),
    summaryProvider: text('summary_provider'),
  },
  (table) => [
    index('polls_timeline_idx').on(table.competitorId, table.startedAt.desc(), table.id.desc()),
    index('polls_retention_idx').on(table.startedAt),
    index('polls_source_retry_idx')
      .on(table.sourceRetryAt)
      .where(sql`${table.status} = 'rate_limited'`),
    index('polls_pending_summary_idx')
      .on(table.id)
      .where(sql`${table.summaryStatus} in ('pending', 'processing', 'retry_wait')`),
    uniqueIndex('polls_one_running_idx')
      .on(table.competitorId)
      .where(sql`${table.status} = 'running'`),
    index('polls_version_idx').on(table.versionId),
    index('polls_previous_version_idx').on(table.previousVersionId),
    check(
      'polls_attempts_check',
      sql`${table.summaryAttempts} >= 0 and ${table.summaryAttempts} <= 3`,
    ),
  ],
);

export const llmDailyUsage = pgTable(
  'llm_daily_usage',
  {
    day: date('day').primaryKey(),
    calls: integer('calls').default(0).notNull(),
  },
  (table) => [check('llm_calls_check', sql`${table.calls} >= 0 and ${table.calls} <= 2000`)],
);
