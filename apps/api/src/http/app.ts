import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { competitorIdSchema, createCompetitorSchema, snapshotsQuerySchema } from '@rounds/shared';
import { db as defaultDb, type Database } from '../db/index.js';
import { competitors } from '../db/schema.js';
import {
  addCompetitor,
  decodeCursor,
  listCompetitors,
  listSnapshots,
} from '../competitors/service.js';

export function createApp(db: Database = defaultDb, workerHealthy: () => boolean = () => true) {
  const app = new Hono();
  app.use('*', logger());
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        c.json({ error: { code: 'body_too_large', message: 'Request body exceeds 16 KiB' } }, 413),
    }),
  );
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/health', async (c) => {
    try {
      if (!workerHealthy()) return c.json({ status: 'unavailable', worker: 'stopped' }, 503);
      await db.execute(sql`select 1`);
      return c.json({ status: 'ok', database: 'connected' });
    } catch {
      return c.json({ status: 'unavailable', database: 'disconnected' }, 503);
    }
  });
  app.get('/api/competitors', async (c) => c.json(await listCompetitors(db)));
  app.post(
    '/api/competitors',
    zValidator('json', createCompetitorSchema, (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'invalid_input',
              message: 'Invalid competitor ID',
              details: result.error.issues,
            },
          },
          400,
        );
    }),
    async (c) => {
      const { id } = c.req.valid('json');
      const created = await addCompetitor(db, id);
      return c.json({ id }, created ? 201 : 200);
    },
  );
  app.use('/api/competitors/:id/*', async (c, next) => {
    if (!competitorIdSchema.safeParse(c.req.param('id')).success)
      return c.json({ error: { code: 'invalid_input', message: 'Invalid competitor ID' } }, 400);
    await next();
  });
  app.delete('/api/competitors/:id', async (c) => {
    const result = competitorIdSchema.safeParse(c.req.param('id'));
    if (!result.success)
      return c.json({ error: { code: 'invalid_input', message: 'Invalid competitor ID' } }, 400);
    await db.update(competitors).set({ active: false }).where(eq(competitors.id, result.data));
    return c.body(null, 204);
  });
  app.get(
    '/api/competitors/:id/snapshots',
    zValidator('query', snapshotsQuerySchema, (result, c) => {
      if (!result.success)
        return c.json(
          { error: { code: 'invalid_input', message: 'Invalid pagination parameters' } },
          400,
        );
    }),
    async (c) => {
      const { limit, cursor: encoded } = c.req.valid('query');
      const cursor = encoded ? decodeCursor(encoded) : undefined;
      if (encoded !== undefined && !cursor)
        return c.json({ error: { code: 'invalid_cursor', message: 'Invalid cursor' } }, 400);
      const result = await listSnapshots(db, c.req.param('id').trim(), limit, cursor ?? undefined);
      if (!result)
        return c.json({ error: { code: 'not_found', message: 'Competitor not found' } }, 404);
      if (result.nextCursor) c.header('X-Next-Cursor', result.nextCursor);
      c.header('X-Tracking-Active', String(result.active));
      return c.json(result.data);
    },
  );
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: { code: 'invalid_request', message: error.message } }, error.status);
    console.error(error);
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });
  return app;
}
export const app = createApp();
