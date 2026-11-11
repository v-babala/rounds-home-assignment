import 'dotenv/config';
import { z } from 'zod';

const integer = (fallback: number, min = 1, max = 2_147_483_647) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const httpUrl = z
  .url()
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'Expected an HTTP(S) URL',
  );
export const envSchema = z.object({
  DATABASE_URL: z.url().default('postgresql://rounds:rounds@localhost:5432/rounds'),
  PORT: integer(3000, 1, 65535),
  SOURCE_BASE_URL: httpUrl.default('http://localhost:4002'),
  POLL_INTERVAL_MS: integer(900_000),
  SOURCE_REQUESTS_PER_SECOND: z.coerce.number().positive().max(5).default(5),
  SOURCE_CONCURRENCY: integer(10, 1, 50),
  SOURCE_TIMEOUT_MS: integer(10_000),
  LLM_BASE_URL: httpUrl.default('http://localhost:4001/v1'),
  LLM_API_KEY: z.string().default('mock'),
  LLM_MODEL: z.string().min(1).default('mock-llm'),
  LLM_CONCURRENCY: integer(2, 1, 10),
  LLM_TIMEOUT_MS: integer(15_000),
  LLM_DAILY_CAP: integer(2000, 0, 2000),
  LLM_MAX_ATTEMPTS: integer(3, 1, 3),
  RETENTION_DAYS: integer(90, 90, 3650),
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});
export const env = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
