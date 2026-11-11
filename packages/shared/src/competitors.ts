import { z } from 'zod';

export const competitorIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const createCompetitorSchema = z.object({ id: competitorIdSchema }).strict();
export const listingFields = ['title', 'tagline', 'price', 'description'] as const;
export const listingFieldSchema = z.enum(listingFields);
export const listingSchema = z.object({
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
});
export const pollStatuses = [
  'running',
  'success',
  'not_found',
  'rate_limited',
  'timeout',
  'network_error',
  'http_error',
  'invalid_response',
  'incomplete',
  'interrupted',
] as const;
export const comparisonStatuses = ['baseline', 'unchanged', 'changed', 'unavailable'] as const;
export const summaryStatuses = [
  'baseline',
  'unchanged',
  'source_unavailable',
  'pending',
  'processing',
  'retry_wait',
  'ready',
  'failed',
  'budget_exhausted',
] as const;
export const pollStatusSchema = z.enum(pollStatuses);
export const comparisonStatusSchema = z.enum(comparisonStatuses);
export const summaryStatusSchema = z.enum(summaryStatuses);
export const competitorSchema = z.object({
  id: competitorIdSchema,
  lastPolledAt: z.iso.datetime().nullable(),
  lastChangedAt: z.iso.datetime().nullable(),
  changedInLast24h: z.boolean(),
  lastPollStatus: pollStatusSchema.nullable(),
});
export const snapshotSchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  fetchedAt: z.iso.datetime().nullable(),
  title: z.string().nullable(),
  tagline: z.string().nullable(),
  price: z.string().nullable(),
  description: z.string().nullable(),
  pollStatus: pollStatusSchema,
  comparisonStatus: comparisonStatusSchema,
  changed: z.boolean(),
  changedFields: z.array(listingFieldSchema),
  missingFields: z.array(listingFieldSchema),
  errorCode: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  summary: z.string().nullable(),
  summaryStatus: summaryStatusSchema,
  summaryErrorCode: z.string().nullable(),
  summaryAttempts: z.number().int().nonnegative(),
  summaryProvider: z.string().nullable(),
});
export const snapshotsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).optional(),
  })
  .strict();
export type Listing = z.infer<typeof listingSchema>;
export type ListingField = z.infer<typeof listingFieldSchema>;
export type PollStatus = z.infer<typeof pollStatusSchema>;
export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;
export type SummaryStatus = z.infer<typeof summaryStatusSchema>;
export type Competitor = z.infer<typeof competitorSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
