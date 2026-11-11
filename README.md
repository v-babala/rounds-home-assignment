<div align="center">

# CompetitorPulse

**Track competitor listings. See meaningful changes. Keep the full history.**

React · TypeScript · Hono · PostgreSQL · Drizzle · pg-boss

[Quick start](#quick-start) · [Local demo](#try-it-locally) · [Tests](#running-tests) · [Architecture](#architecture-and-decisions) · [API](#api)

</div>

---

## About the assignment

CompetitorPulse is a backend-focused fullstack home assignment. An internal user can track competitors by ID, periodically fetch their product listings, and browse a timeline of every poll. When product information changes meaningfully, a background task requests a short English explanation from an LLM.

The React interface provides a searchable watchlist with 50 rows per page, a change indicator for the last 24 hours, and a paginated competitor timeline. It explains why a summary is queued, unavailable, failed, or skipped because of the daily budget.

The assignment calls for 6,000 competitors, a 15-minute polling interval, a global source limit of 5 requests/second, a hard limit of 2,000 LLM calls/day, and at least 90 days of history. These constraints conflict; see [capacity limits](#capacity-limits).

> **LLM mode:** the default setup uses the supplied zero-dependency **Python mock LLM**. It returns a templated response that echoes input, not a real AI explanation. The interface labels these responses **Demo model**. No paid API key is needed.

The original brief is in [instructions.md](instructions-files/instructions.md).

## Quick start

**Prerequisites:** Docker Engine / Docker Desktop with Docker Compose v2.

From the repository root:

```sh
docker compose up --build
```

Compose installs dependencies, builds the backend, starts PostgreSQL, applies application migrations, and launches the frontend, API, listing source, and mock LLM. pg-boss initializes its own database schema when the worker starts.

| Service                            | Local address                                                           |
| ---------------------------------- | ----------------------------------------------------------------------- |
| **Frontend**                       | [localhost:5173](http://localhost:5173)                                 |
| API                                | [localhost:3000/api/competitors](http://localhost:3000/api/competitors) |
| API readiness: database and worker | [localhost:3000/api/health](http://localhost:3000/api/health)           |
| Process liveness                   | [localhost:3000/health](http://localhost:3000/health)                   |
| Listing source health              | [localhost:4002/health](http://localhost:4002/health)                   |
| Mock LLM health                    | [localhost:4001/health](http://localhost:4001/health)                   |

Defaults work without an `.env` file. To customize ports or application settings, create one **if you do not already have it**:

```sh
cp .env.example .env
```

Edit `POSTGRES_PORT`, `API_PORT`, `WEB_PORT`, `SOURCE_PORT`, or `LLM_PORT` if a host port is occupied. Container-to-container addresses keep their internal ports. Examples below assume the defaults.

<details>
<summary><strong>Useful Docker commands</strong></summary>

```sh
# Run in the background
docker compose up -d --build

# Inspect services and follow backend logs
docker compose ps
docker compose logs -f api

# Rebuild after backend, dependency, or migration changes
docker compose up -d --build

# Stop services; retain database contents
docker compose down
```

PostgreSQL data lives in a named volume. **`docker compose down -v` deletes it.** Frontend source files are mounted into the Vite container for hot reload; backend code runs from compiled TypeScript.

</details>

## Try it locally

### 1. Enable a faster demo

The normal polling interval is **15 minutes**. For a short demonstration, set this in the root `.env`:

```dotenv
POLL_INTERVAL_MS=5000
```

Apply the setting:

```sh
docker compose up -d --force-recreate api
```

For predictable results, reset the supplied source and disable random failures and automatic version changes **before adding a competitor**:

```sh
curl -X POST http://localhost:4002/control/reset
curl -X POST http://localhost:4002/control/configure \
  -H 'Content-Type: application/json' \
  -d '{"versionIntervalSeconds":0,"slowRate":0,"errorRate":0,"timeoutRate":0,"partialRate":0}'
```

Resetting the source changes its in-memory state; it does not clear application history. Changing `POLL_INTERVAL_MS` does not reset existing `nextPollAt` timestamps. If a competitor was already scheduled with the 15-minute interval, remove and re-add it to make it due immediately while preserving history, or wait for its scheduled poll. For an existing watchlist, wait for a successful poll before advancing the source.

### 2. Add a competitor and inspect its history

1. Open [the frontend](http://localhost:5173).
2. Enter `acme-crm` and click **Track competitor**.
3. Open its timeline. The first complete listing establishes the baseline and needs no summary.
4. Leave the page open: the newest history page refreshes every **10 seconds**. Loading older pages pauses automatic refresh, including on window focus and reconnect; use **Refresh** to update the loaded history.

Unknown IDs are accepted. Adding an ID absent from the supplied source produces a saved **Not found** poll rather than rejecting the watchlist entry.

### 3. Trigger a change

```sh
curl -X POST http://localhost:4002/control/advance \
  -H 'Content-Type: application/json' \
  -d '{"id":"acme-crm","steps":1}'
```

Wait for the next poll and UI refresh. Formatting-only changes should produce **No meaningful changes**. Advance again to reach another fixture version if needed; versions are finite. A meaningful change highlights the affected fields, marks the competitor as changed in the last 24 hours, and queues a mock summary.

You can inspect the supplied services:

```sh
curl http://localhost:4002/control/stats
curl http://localhost:4001/control/stats
```

### 4. Exercise failure handling

| Scenario               | Action                                                                            | Expected behavior                                                  |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Source failure         | Configure `failNext` below                                                        | Failed poll stays in the timeline; polling continues               |
| Temporary LLM failure  | Configure `failNext` on the mock, then trigger a meaningful change                | Snapshot remains saved; summary retries up to three total attempts |
| Daily budget exhausted | Set `LLM_DAILY_CAP=0` in `.env`, recreate `api`, then trigger a meaningful change | Timeline shows **Daily AI limit reached**                          |
| Stop tracking          | Remove a competitor through the UI                                                | New polling stops; adding it again preserves its saved history     |

```sh
# The next source request fails
curl -X POST http://localhost:4002/control/configure \
  -H 'Content-Type: application/json' -d '{"failNext":1}'

# The next LLM request fails
curl -X POST http://localhost:4001/control/configure \
  -H 'Content-Type: application/json' -d '{"failNext":1}'
```

Source failures and partial listings do not trigger LLM calls. For slow-summary testing, configure the mock with `{"latencyMs":10000}` and trigger a meaningful change: the API and source polling remain responsive. Reset mock behavior with `POST http://localhost:4001/control/reset`.

After the demo, restore `POLL_INTERVAL_MS=900000` and any changed budget settings, recreate `api`, and reset the source controls. Control endpoints are for manual testing; the application does not call them. See the [listing source guide](instructions-files/listing-source/README.md) for all source controls.

## Development on the host

**Prerequisites:** Node.js 24 (see [.nvmrc](.nvmrc)), npm, and Docker for the supporting services.

Run these commands from the repository root. Create `apps/api/.env` only if it does not already exist:

```sh
nvm use
npm ci
npm run build -w @rounds/shared
cp apps/api/.env.example apps/api/.env

docker compose up -d --wait db listing-source mock-llm
npm run db:migrate
npm run dev
```

`npm run dev` starts **both the API and React frontend**, with reload on source changes. You can also start either workspace separately:

```sh
npm run dev -w @rounds/api
npm run dev -w @rounds/web
```

| File / variable    | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| Root `.env`        | Compose settings, published ports, and Docker service URLs       |
| `apps/api/.env`    | Host API configuration, using `localhost` URLs                   |
| `API_PROXY_TARGET` | Vite's backend proxy target; defaults to `http://localhost:3000` |

If you change published database/source/LLM ports in Compose, update the corresponding host URLs in `apps/api/.env`. If you change the host API port, set Vite's `API_PROXY_TARGET` accordingly. Rebuild `@rounds/shared` after editing its contracts.

Use one active background worker per database. If switching from the full Docker setup to host development, stop the containerized API and frontend first:

```sh
docker compose stop web api
```

An advisory lock prevents two active schedulers. Additional API-only processes can use `WORKER_ENABLED=false`.

## Running tests

Install dependencies and build the shared contracts first:

```sh
npm ci
npm run build -w @rounds/shared
```

### Backend unit tests

```sh
npm test -w @rounds/api
```

Tests cover normalization, meaningful comparisons, input validation, configuration limits, request pacing, and safe error handling in summary consumers. No running database is required.

### Frontend browser tests

```sh
# First run: install Chromium and its system dependencies
npx playwright install --with-deps chromium

npm test -w @rounds/web
```

Chromium is downloaded to Playwright's user cache (on Linux, usually `~/.cache/ms-playwright`), outside the project. The `--with-deps` option also installs OS libraries through the system package manager and may require sudo.

If Chromium is already downloaded but exits before any test with `error while loading shared libraries` (for example, `libnspr4.so`), install the missing system dependencies, then retry:

```sh
npx playwright install-deps chromium
npm test -w @rounds/web
```

Playwright launches a separate Vite server on **127.0.0.1:5174**, which must be available.

Browser tests cover watchlist loading and errors, search and 50-row pagination with 6,000 entries, page adjustment after a list shrinks, timeline tracking status without fetching the full watchlist, validation, adding and removing competitors, navigation, all summary states, incomplete polls, pagination and retries, automatic refresh, invalid API responses, and safe text rendering. Each test gets an isolated browser context. HTTP responses are intercepted, so these tests need **no backend, database, or Python mock**.

Failure traces are saved under `apps/web/test-results/`. To inspect one:

```sh
npx playwright show-trace apps/web/test-results/<test-directory>/trace.zip
```

### Backend integration tests

These tests use **real PostgreSQL** and local HTTP servers that simulate source and LLM responses. The separate Python mock is not required.

> **Use a dedicated test database.** The suite applies migrations and clears tables. `TEST_DATABASE_URL` must point to a database whose name ends in `_test`.

```sh
docker compose up -d --wait db

# Create once; adjust the user if POSTGRES_USER differs
docker compose exec db createdb -U rounds rounds_test

TEST_DATABASE_URL=postgresql://rounds:rounds@localhost:5432/rounds_test \
  npm run test:integration -w @rounds/api
```

Match the connection string to your published PostgreSQL port and credentials. Alternatively, with the API container running:

```sh
docker compose exec \
  -e TEST_DATABASE_URL=postgresql://rounds:rounds@db:5432/rounds_test \
  api npm run test:integration -w @rounds/api
```

Integration tests cover persistence, concurrent claims, cursor pagination, atomic snapshot/enqueue rollback, daily quota reservation, stale completions, source cooldowns, retention, pg-boss retries and `Retry-After`, restart recovery, and dead-letter handling. Regression tests also verify that invalid source Unicode and unusable LLM completions do not stop the worker or discard saved history.

### Project checks

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

`npm test` runs backend unit tests and frontend browser tests. **Database integration tests run separately** using the command above. Chromium must be installed before the combined test command. `npm run format` formats repository files.

## Architecture and decisions

```mermaid
flowchart LR
    UI[React UI] --> API[Hono API]
    API --> DB[(PostgreSQL)]
    Scheduler[Polling scheduler] --> Source[HTTP listing source]
    Source --> Diff[Normalize and compare]
    Diff --> Transaction[Save poll, version and summary job]
    Transaction --> DB
    DB --> Queue[pg-boss worker]
    Queue --> LLM[Mock or compatible LLM]
    LLM --> Summary[Save summary outcome]
    Summary --> DB
```

### Meaningful changes and history

- Compare `title`, `tagline`, `price`, and `description`. Normalize Unicode, HTML entities, whitespace, and equivalent price formats; ignore noisy metadata and key ordering. Currency, billing period, and per-seat pricing remain meaningful.
- Compare against the last complete, valid listing. Incomplete responses, `404`, timeouts, and source failures are saved without replacing that baseline. A disappearance alone is not treated as a confirmed product change.
- Record every poll, including failures and unchanged results, in `polls`. Unchanged polls reuse an immutable `listing_versions` row, avoiding repeated storage of long descriptions.
- Keep at least 90 days of history. Cleanup runs in bounded batches and retains versions referenced by history or the current baseline.

### Scheduling and queues

- Source polling uses `competitors.nextPollAt` as its durable schedule, rather than a second pg-boss queue. This keeps overdue ordering and source cooldowns explicit. pg-boss delayed jobs would also be a valid alternative, but would still need the global HTTP rate limiter and per-competitor coordination.
- Poll the most overdue active competitors first, with one running poll per competitor. A shared limiter spaces source request starts without bursts and bounds concurrency. Missed intervals do not create an unlimited catch-up backlog.
- Persist a global source cooldown for `429 Retry-After`, so restarting cannot bypass it. Source errors are retried as separate recorded polls, no sooner than the normal interval, with additional bounded backoff.
- Save a meaningful change and its pg-boss job in **one transaction** through the Drizzle adapter. Save a summary outcome and queue completion/retry together as well. External HTTP calls execute outside database transactions.
- pg-boss handles LLM delivery, concurrency, backoff, and expired jobs inside PostgreSQL. It avoids a separate Redis service and replaces custom queue infrastructure. Application migrations use Drizzle; pg-boss manages its own `pgboss` schema.
- Recover interrupted source polls as `interrupted`. Expired LLM deliveries become eligible for retry after the job timeout and a supervisor pass. A durable dead-letter handler marks final crashes as failed instead of leaving the UI in `processing`.
- Import legacy unfinished summaries on startup without resetting attempts or budgets. Stable poll IDs avoid duplicate queue jobs. Completed queue jobs are retained for one day, independently of the 90-day application history.

### LLM reliability and budget

- Reserve a daily budget slot atomically in PostgreSQL **before each attempt**, including retries and failures. Days use UTC. Ambiguous failures do not refund reservations, which favors staying within the hard cap over fully using it.
- Allow up to three attempts for temporary failures. Authentication/configuration errors are terminal. Validate response shape, nonempty text, length, completion status, and PostgreSQL-safe Unicode. Invalid completions are ordinary retryable summary failures.
- Keep listing history and changed fields available regardless of summary outcome. Attempt identifiers protect against stale responses. Exactly-once execution of an external LLM call is not promised.
- Summaries skipped because of quota exhaustion are not carried into the following day. The mock's `callCount` counts successful responses, so the database reservation count is the budget authority.

### Capacity limits

| Constraint                         | Implication                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| 6,000 competitors every 15 minutes | Requires **6.67 requests/second**                                                       |
| Source allows 5 requests/second    | A complete sweep takes **at least 20 minutes**, before latency and failures             |
| 2,000 LLM calls/day                | About **0.35%** of the 576,000 polls/day implied by the target interval, before retries |
| 90 days at the target interval     | About **51.84 million poll records**                                                    |

The implementation prioritizes the source rate limit. A guaranteed 15-minute sweep needs a higher source quota with headroom or fewer tracked competitors. Change detection is deterministic and independent of LLM availability. Version reuse and cursor pagination address history growth; partitioning and archival should follow measurements. A 6,000-competitor / 90-day load test has not been performed.

### Scope and tradeoffs

The application assumes one internal user and one active scheduler. Authentication, notifications, WebSockets, distributed scheduling, cloud deployment, and database partitioning are outside this submission. The frontend uses polling through TanStack Query. Watchlist search and pagination run on the client and limit the table to 50 rows; the list API still returns all active competitors. Timeline responses include an `X-Tracking-Active` header, so opening history does not fetch the full watchlist. The mock demonstrates the LLM integration and failure handling; it does not evaluate real summary quality.

## Configuration

See [.env.example](.env.example) for Compose and [apps/api/.env.example](apps/api/.env.example) for host development.

| Setting                      | Compose default              | Purpose                                              |
| ---------------------------- | ---------------------------- | ---------------------------------------------------- |
| `SOURCE_BASE_URL`            | `http://listing-source:4002` | HTTP listing source                                  |
| `POLL_INTERVAL_MS`           | `900000`                     | Target poll interval: 15 minutes                     |
| `SOURCE_REQUESTS_PER_SECOND` | `5`                          | Global source request limit                          |
| `SOURCE_CONCURRENCY`         | `10`                         | Maximum in-flight source requests                    |
| `SOURCE_TIMEOUT_MS`          | `10000`                      | Source timeout, including response body              |
| `LLM_BASE_URL`               | `http://mock-llm:4001/v1`    | Base URL; `/chat/completions` is appended            |
| `LLM_MODEL`                  | `mock-llm`                   | Model name, also recorded with summaries             |
| `LLM_API_KEY`                | `mock`                       | Backend-only bearer token                            |
| `LLM_TIMEOUT_MS`             | `15000`                      | LLM timeout                                          |
| `LLM_CONCURRENCY`            | `2`                          | Independent LLM concurrency                          |
| `LLM_DAILY_CAP`              | `2000`                       | Maximum attempts per UTC day; can be reduced to zero |
| `LLM_MAX_ATTEMPTS`           | `3`                          | Total attempts per summary, including the first      |
| `RETENTION_DAYS`             | `90`                         | History retention; minimum 90 days                   |
| `WORKER_ENABLED`             | `true`                       | Enable scheduler, summary workers, and cleanup       |

Configuration is validated at startup. Source limits above 5 requests/second, daily budgets above 2,000, and more than three LLM attempts are rejected.

To use another source, change `SOURCE_BASE_URL` in the root `.env` for Compose, or in `apps/api/.env` for host development. To use a compatible real LLM, set `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` in the same file. With Compose, apply these changes using `docker compose up -d --force-recreate api`; with host development, restart the API. A container URL must be reachable from inside the API container: `localhost` refers to that container, not the host machine. Requests use the Chat Completions HTTP format through native `fetch`, with no SDK or hidden automatic retries. The supplied source and mock are accessed over HTTP; application code does not import their implementation or read their fixtures.

## API

| Method   | Endpoint                         | Behavior                                                                             |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `GET`    | `/api/competitors`               | Active watchlist, latest poll status/time, and `changedInLast24h`                    |
| `POST`   | `/api/competitors`               | Body: `{"id":"acme-crm"}`; `201` when created/reactivated, `200` when already active |
| `DELETE` | `/api/competitors/:id`           | `204`, including repeat deletion; history is retained                                |
| `GET`    | `/api/competitors/:id/snapshots` | Snapshot array, newest first; available after tracking stops                         |

```sh
curl -H 'Content-Type: application/json' \
  -d '{"id":"acme-crm"}' http://localhost:3000/api/competitors
curl http://localhost:3000/api/competitors
curl 'http://localhost:3000/api/competitors/acme-crm/snapshots?limit=20'
curl -X DELETE http://localhost:3000/api/competitors/acme-crm
```

IDs are case-sensitive, 1–128 characters, start with a letter or number, and contain only letters, numbers, `_`, and `-`. Unknown source IDs can be tracked; an ID never registered in the application returns `404` for history.

History accepts `limit` from 1 to 200 (default 50). The next cursor is returned in `X-Next-Cursor`; send it as `?cursor=...&limit=20`. Ordering is stable by `startedAt DESC, id DESC`, including tied timestamps. Every successful history response also includes `X-Tracking-Active: true|false`, including empty history, so the UI can display tracking status without loading the watchlist.

Snapshots expose listing fields, poll/comparison statuses, changed and missing fields, summary state, attempt count, and provider. `fetchedAt` is null for unfinished polls; unavailable listing fields can be null. `comparisonStatus=unavailable` distinguishes an unknown comparison from a confirmed unchanged result. The [shared schemas](packages/shared/src/competitors.ts) define the full contract.

| Summary status                          | Meaning                                     |
| --------------------------------------- | ------------------------------------------- |
| `baseline`                              | First complete listing; no previous version |
| `unchanged`                             | No meaningful change; no summary needed     |
| `source_unavailable`                    | No complete source listing to compare       |
| `pending` / `processing` / `retry_wait` | Queued, running, or waiting to retry        |
| `ready`                                 | Summary saved                               |
| `failed`                                | Terminal failure or exhausted attempts      |
| `budget_exhausted`                      | Skipped because of the daily cap            |

Errors use `{"error":{"code":"...","message":"..."}}`. Invalid input returns `400`, oversized bodies `413`, and internal errors `500` without SQL or stack traces. The 24-hour change indicator does not depend on successful summary generation.

## Repository layout

```text
apps/
  api/
    src/
      competitors/   Watchlist and history operations
      config/        Validated environment settings
      db/            PostgreSQL connection and Drizzle schema
      http/          HTTP API, outbound client, and unit tests
      polling/       Scheduler operations, normalization, and diffing
      summaries/     pg-boss integration, LLM requests, and daily budget
      workers/       Background lifecycle and source scheduling
    drizzle/         SQL migrations and metadata
    tests/           PostgreSQL integration tests
  web/
    src/
      components/    Shared interface elements
      features/      Watchlist and timeline views
      lib/           Query hooks and presentation helpers
    tests/           Playwright browser scenarios
packages/shared/     Zod contracts and TypeScript types
instructions-files/  Supplied HTTP listing source and Python mock LLM
```

After changing the application database schema:

```sh
npm run db:generate
npm run db:migrate
```

Keep generated SQL and `apps/api/drizzle/meta` together. Compose runs migrations as a one-off dependency before starting the API.

## AI assistance

I used **Codex** for implementation assistance. I reviewed its output and revised the design decisions described below.

One AI-generated approach I changed was custom summary queue and worker logic. I replaced it with **pg-boss** because implementing delivery, retries, concurrency control, and recovery ourselves added unnecessary complexity. pg-boss provides those mechanisms using the PostgreSQL instance already required by the application. The application still owns source polling, daily budget reservations, and user-visible summary states.

Backend framework: Switched from NestJS to Hono, as the backend is relatively small and doesn't require the additional abstractions and complexity of a full-featured framework.

Data modeling: Separated polls from immutable listing_versions. This preserves the history of every polling attempt while avoiding unnecessary duplication of large listing descriptions when the content hasn't changed.

Database indexing: Added indexes to support timeline queries, retention cleanup, version lookups, and active job processing.

Concurrency control: Combined FOR UPDATE SKIP LOCKED with a partial unique index to enforce at most one running poll per competitor. This ensures the constraint is enforced at the database level rather than relying solely on application-level checks.
