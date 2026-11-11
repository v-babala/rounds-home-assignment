# Listing source

A local stand-in for competitor websites. It needs Node.js 18 or later and has no dependencies.

```bash
node listing-source-server.mjs                      # listens on :4002
PORT=5000 node listing-source-server.mjs            # custom port
FIXTURES_PATH=./other.json node listing-source-server.mjs
SEED=42 node listing-source-server.mjs              # repeatable random behaviour
```

## Endpoints

### `GET /listings/:id`

Returns the current listing of a competitor as JSON. It behaves like a real website, not like a clean API.

- `200`: the listing.
- `404`: the source does not know the id, or the competitor is not listed at the moment.
- `429`: above the global rate limit. The `Retry-After` header gives the wait in seconds.
- `5xx`: a failure. The body is not always JSON.
- No response: the request can stay open until the connection closes.

The listing changes over time. Every `versionIntervalSeconds`, each competitor moves to its next version. After the last version, the listing stays the same.

### `GET /health`

Returns `{"ok": true}`.

## Control endpoints

Use these endpoints to change the behaviour while you develop and test. They do not count toward the rate limit.

### `GET /control/stats`

Returns the request count by status and by competitor, the current version of each competitor, and the current settings.

### `POST /control/configure`

Changes one or more settings. The settings that you do not send stay the same.

```bash
curl -X POST localhost:4002/control/configure -d '{"rateLimitPerSecond": 2, "failNext": 3}'
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `rateLimitPerSecond` | `5` | Global request limit for all ids. |
| `versionIntervalSeconds` | `120` | Time before each competitor moves to its next version. `0` stops the automatic changes. |
| `latencyMinMs`, `latencyMaxMs` | `50`, `800` | Normal response time range. |
| `slowRate`, `slowMs` | `0.05`, `8000` | Part of requests that are slow, and how slow. |
| `errorRate` | `0.03` | Part of requests that fail with a `5xx` status. |
| `timeoutRate`, `timeoutMs` | `0.01`, `60000` | Part of requests that get no response, and when the connection closes. |
| `partialRate` | `0.03` | Part of responses with one listing field missing, empty or `null`. |
| `noise` | `true` | Adds fields that you do not need, some of which change on each request. |
| `formatVariants` | `true` | Sends the same values in different formats. |
| `failNext` | `0` | The next N requests fail with a `5xx` status. |
| `timeoutNext` | `0` | The next N requests get no response. |
| `partialNext` | `0` | The next N responses have one field missing, empty or `null`. |

Rates are values from `0` to `1`.

### `POST /control/advance`

Moves competitors to a later version now.

```bash
curl -X POST localhost:4002/control/advance -d '{"id": "acme-crm", "steps": 1}'
curl -X POST localhost:4002/control/advance -d '{}'
```

Without `id`, all competitors move. `steps` is `1` if you do not send it.

### `POST /control/reset`

Sets all settings back to the defaults, sets all competitors back to their first version, and clears the stats.

## Fixtures

`listings.json` holds the versions of each competitor:

```json
{
  "competitors": {
    "acme-crm": [
      { "title": "Acme CRM", "tagline": "...", "price": { "amount": 39, "currency": "USD", "period": "month" }, "description": "..." },
      { "delisted": true }
    ]
  }
}
```

A `{ "delisted": true }` version makes the competitor return `404` for that period.

We evaluate your submission with different fixtures and different settings. Do not depend on the content of this file.
