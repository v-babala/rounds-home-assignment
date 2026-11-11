import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';
import { env } from './config/env.js';
import { db, pool } from './db/index.js';
import { Worker } from './workers/worker.js';

const worker = env.WORKER_ENABLED ? new Worker(db, pool, env) : null;
if (worker && !(await worker.start())) {
  await pool.end();
  throw new Error(
    'Another background worker holds the database lock. Run one worker, or set WORKER_ENABLED=false for API-only mode.',
  );
}
const app = createApp(db, () => worker?.healthy ?? true);

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});
let shuttingDown = false;
const monitor = setInterval(() => {
  if (worker && !worker.healthy) void shutdown(1);
}, 1000);
monitor.unref();
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(monitor);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([httpClosed, worker?.stop()]);
  await pool.end();
  process.exit(code);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
