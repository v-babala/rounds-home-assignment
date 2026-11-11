# Home Assignment – Fullstack Developer (Backend Focus)

## Overview

- Build **CompetitorPulse**: a small system that tracks competitor product listings over time and uses an LLM to explain, in plain English, what changed between two consecutive snapshots.
- This is a **backend-focused** fullstack role: most of the evaluation weight is on your backend design (persistence, scheduling, and how you integrate the LLM call). You'll also build a small React frontend — kept intentionally simple, but real enough that we can look at your frontend work too.
- Time estimate: ~3 hours.
- AI tools expected — we're evaluating your judgment, not typing speed. Note which ones you used in your README.
- Parts of this brief are left open on purpose. Where you need to make a decision, make it and briefly write it down in your README.

## How the System Works

1. A user can **add or remove a tracked competitor** by id (e.g. `acme-crm`).
2. For each tracked competitor, the backend **periodically fetches its current listing** from the data source below.
3. When the listing **changes in a way that matters to a product manager**, the backend calls an **LLM** to write a short, plain-English summary of the change. Not every difference in the raw response is a change that matters. You decide what is.
4. A minimal UI shows each competitor's history as a timeline, most recent first.

## Data Source (provided)

A local HTTP service is provided in [`files/listing-source/`](files/listing-source/). Run it with `node listing-source-server.mjs` (Node.js 18 or later, no dependencies). It listens on `http://localhost:4002`.

Your backend must get every listing from this service over HTTP. Treat it as an external website: do not import its code and do not read its `listings.json`. Make the base URL configurable, because we point your backend at our own instance.

`GET /listings/:id` returns the competitor's current listing as JSON. It behaves like a real third-party website, not like a clean API:

- The response contains fields that you do not need and fields that change on every request.
- The same information can come back in a different format from one request to the next.
- It is sometimes slow, sometimes fails, and sometimes returns an incomplete listing.
- A competitor can disappear from the source and come back later.
- It enforces a **global rate limit** across all ids. Above the limit it answers `429` with a `Retry-After` header.
- `/control/*` endpoints let you change its behaviour while you develop (see its `README.md`).

## Frontend (build it)

Build a small **React** frontend with two views:

1. **Competitor list:** add, list, and remove competitors. Show which competitors had a change in the last 24 hours.
2. **Competitor timeline:** the snapshots of one competitor, newest first, with the fetched time, the listing fields, and the summary, or a clear state that explains why there is no summary.

This is not a design test — no styling effort is expected. For reference, here's a plain, unstyled example of the two views. Yours doesn't need to match it visually, but it must show the same information, plus what the list above asks for (changes in the last 24 hours, and why a summary is not available):

![Competitor list view example](/assignments/fullstack_developer_backend_focus/images/competitor-list.png)

![Competitor timeline view example](/assignments/fullstack_developer_backend_focus/images/competitor-timeline.png)

Your backend must implement at least this API contract:

```
GET    /api/competitors                      -> [{ "id": string }, ...]
POST   /api/competitors      { "id": string } -> 201 Created
DELETE /api/competitors/:id                  -> 204 No Content
GET    /api/competitors/:id/snapshots        -> [Snapshot, ...]   // newest first
```

`Snapshot` contains at least:

```jsonc
{
  "fetchedAt": "2026-09-10T12:00:00Z", // ISO 8601
  "title": "Acme CRM",
  "tagline": "Simple CRM for small teams",
  "price": "$29/mo",
  "description": "Track leads and deals in one place.",
  "changed": true,      // whether this differs, in a way that matters, from the previous one
  "summary": "Price dropped from $39/mo to $29/mo." // null when no summary is available
}
```

Add fields and endpoints when they help. The UI must be able to tell the user **why** a summary is not available.

## Requirements

### Step 1 – Tracking API/UI

- Add and remove a tracked competitor by id. No auth; assume one internal user.
- The source does not tell you in advance which ids exist. Decide what happens when a user adds an id that the source does not know.

### Step 2 – Scheduler

- Poll every tracked competitor periodically. Make the interval configurable.
- Respect the source's rate limit.

### Step 3 – Snapshot Persistence & Diffing

- Keep the history that the timeline needs (see the production context in Additional Notes).
- Decide whether each poll changed something that matters, compared with the previous state of that competitor.

### Step 4 – AI Change Summary

- On a change that matters, call the LLM and store the summary with the snapshot.
- A user must never lose a poll result because of a problem with the LLM.
- Decide what the user sees when the LLM is slow, fails, returns something unusable, or when the daily cap is reached.

**Which LLM to use** — use any of these, and say in the README which one you used:

- A real provider (OpenAI, Anthropic, or other) with your own API key.
- A local model (e.g. Ollama).
- The **mock LLM server** in [`files/mock-llm/mock-llm-server.py`](files/mock-llm/mock-llm-server.py). It speaks the OpenAI Chat Completions shape. It does not write real summaries; it echoes its input. It can also be made slow or made to fail.

### Step 5 – Frontend

- Build the two React views described above, wired to your backend through the API contract.
- No design effort is needed.

## Additional Notes

**Production context** — design for this, even though you will only run it locally:

- **6,000 tracked competitors**, each to be polled **every 15 minutes**.
- The data source allows **at most 5 requests per second** in total.
- Finance gives you a hard cap of **2,000 LLM calls per day**, across all competitors.
- Users must be able to see each competitor's history, including polls where nothing changed and polls that failed, for **at least 90 days**.

These numbers do not all fit together. Tell us what you would do about that.

**Tech stack**

- The frontend must be **React**.
- The backend: **Node.js, Python, or Go**. TypeScript is preferred. Use disciplined typing.
- A real database with migrations. Use an established migration tool for your stack (for example Prisma Migrate, drizzle-kit, Knex, Alembic or golang-migrate), so that the database can be set up with one command.
- `docker compose up` must start the whole system, including the provided source and mock LLM, so that we can swap them for our own instances.

## Deliverables

- A new GitHub repository with the system code.
- A clear README covering: how to run the system locally, which LLM option you used and how to configure it, and how to point it at a different data source URL.
- In the README, also briefly mention:
  - the main decisions you made (for example: what counts as a change, how you handle the rate limit and the LLM cap, how you store the history), and what you considered instead;
  - what you left out on purpose;
  - which AI tools you used, and one place where you changed what the AI proposed.
- Come prepared for a follow-up technical interview: questions about your code and your decisions.

## Bonus Points

- Real database with migrations, instead of a flat file.
- Dockerfile + docker-compose for one-command local startup.
- Deploy the service to the cloud and provide access to it, with an explanation of how it was deployed.
