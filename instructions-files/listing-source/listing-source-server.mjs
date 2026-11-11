import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4002);
const FIXTURES_PATH =
  process.env.FIXTURES_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), "listings.json");
const SEED = Number(process.env.SEED ?? Date.now()) >>> 0;

const DEFAULT_SETTINGS = Object.freeze({
  rateLimitPerSecond: 5,
  versionIntervalSeconds: 120,
  latencyMinMs: 50,
  latencyMaxMs: 800,
  slowRate: 0.05,
  slowMs: 8000,
  errorRate: 0.03,
  timeoutRate: 0.01,
  timeoutMs: 60000,
  partialRate: 0.03,
  noise: true,
  formatVariants: true,
  failNext: 0,
  timeoutNext: 0,
  partialNext: 0,
});

const RATE_KEYS = new Set(["slowRate", "errorRate", "timeoutRate", "partialRate"]);
const BOOLEAN_KEYS = new Set(["noise", "formatVariants"]);
const LISTING_FIELDS = ["title", "tagline", "price", "description"];
const CURRENCY_SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };
const PERIOD_FORMATS = {
  month: { short: "/mo", spaced: " / month", words: "per month" },
  year: { short: "/yr", spaced: " / year", words: "per year" },
  seat_month: { short: "/seat/mo", spaced: " / seat / month", words: "per seat per month" },
};
const PROMO_BANNERS = [
  "Spring sale: 20% off annual plans",
  "New: integrations marketplace",
  "Webinar Thursday: scaling your team",
  null,
  "Rated #1 by small teams",
];

const competitors = loadFixtures(FIXTURES_PATH);
const random = createRandom(SEED);

let settings = { ...DEFAULT_SETTINGS };
let clock = createClock();
let stats = createStats();
const bucket = { tokens: settings.rateLimitPerSecond, updatedAt: Date.now() };

function loadFixtures(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const entries = Object.entries(parsed.competitors ?? {});
  if (entries.length === 0) {
    throw new Error(`No competitors found in ${path}`);
  }
  return new Map(entries);
}

function createRandom(seed) {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(items) {
  return items[Math.floor(random() * items.length)];
}

function chance(rate) {
  return random() < rate;
}

function createClock() {
  return { startedAt: Date.now(), offsets: new Map() };
}

function createStats() {
  return { requests: 0, byStatus: {}, byCompetitor: {} };
}

function elapsedSteps() {
  if (settings.versionIntervalSeconds <= 0) {
    return 0;
  }
  return Math.floor((Date.now() - clock.startedAt) / (settings.versionIntervalSeconds * 1000));
}

function versionIndex(id) {
  const versions = competitors.get(id);
  const index = elapsedSteps() + (clock.offsets.get(id) ?? 0);
  return Math.max(0, Math.min(versions.length - 1, index));
}

function freezeVersions() {
  const offsets = new Map();
  for (const id of competitors.keys()) {
    offsets.set(id, versionIndex(id));
  }
  clock = { startedAt: Date.now(), offsets };
}

function advance(ids, steps) {
  for (const id of ids) {
    clock.offsets.set(id, (clock.offsets.get(id) ?? 0) + steps);
  }
}

function takeToken() {
  const now = Date.now();
  const capacity = Math.max(1, settings.rateLimitPerSecond);
  bucket.tokens = Math.min(
    capacity,
    bucket.tokens + ((now - bucket.updatedAt) / 1000) * settings.rateLimitPerSecond,
  );
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 0;
  }
  if (settings.rateLimitPerSecond <= 0) {
    return 60;
  }
  return Math.max(1, Math.ceil((1 - bucket.tokens) / settings.rateLimitPerSecond));
}

function formatAmount(amount, withCents) {
  return withCents || !Number.isInteger(amount) ? amount.toFixed(2) : String(amount);
}

function formatPrice(price) {
  if (price.amount === 0) {
    return settings.formatVariants ? pick(["Free", "$0/mo", "Free forever"]) : "Free";
  }
  const symbol = CURRENCY_SYMBOLS[price.currency] ?? `${price.currency} `;
  const period = PERIOD_FORMATS[price.period] ?? PERIOD_FORMATS.month;
  const variants = [
    `${symbol}${formatAmount(price.amount, false)}${period.short}`,
    `${symbol}${formatAmount(price.amount, false)}${period.spaced}`,
    `${price.currency} ${formatAmount(price.amount, false)} ${period.words}`,
    `${symbol}${formatAmount(price.amount, true)}${period.short}`,
  ];
  return settings.formatVariants ? pick(variants) : variants[0];
}

function formatText(text) {
  if (!settings.formatVariants) {
    return text;
  }
  const variants = [
    (value) => value,
    (value) => value,
    (value) => `  ${value} `,
    (value) => value.replace(/ /g, (space) => (chance(0.2) ? "  " : space)),
    (value) => value.replace(/&/g, "&amp;"),
    (value) => value.replace(" ", "&nbsp;"),
    (value) => `${value}\n`,
  ];
  return pick(variants)(text);
}

function damageListing(listing) {
  const field = pick(LISTING_FIELDS);
  const damage = pick(["missing", "empty", "null"]);
  if (damage === "missing") {
    delete listing[field];
  } else {
    listing[field] = damage === "empty" ? "" : null;
  }
}

function shuffleKeys(object) {
  const keys = Object.keys(object);
  for (let index = keys.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [keys[index], keys[swap]] = [keys[swap], keys[index]];
  }
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

function renderListing(id, version) {
  const listing = {
    id,
    title: formatText(version.title),
    tagline: formatText(version.tagline),
    price: formatPrice(version.price),
    description: formatText(version.description),
  };
  if (settings.noise) {
    Object.assign(listing, {
      renderedAt: new Date().toISOString(),
      requestId: randomUUID(),
      promoBanner: PROMO_BANNERS[stats.requests % PROMO_BANNERS.length],
      viewerCount: Math.floor(random() * 200),
      cache: { hit: chance(0.5), ageSeconds: Math.floor(random() * 300) },
    });
  }
  return settings.noise ? shuffleKeys(listing) : listing;
}

function latency() {
  if (chance(settings.slowRate)) {
    return settings.slowMs;
  }
  const spread = Math.max(0, settings.latencyMaxMs - settings.latencyMinMs);
  return settings.latencyMinMs + Math.floor(random() * spread);
}

function consumeOnce(key, rate) {
  if (settings[key] > 0) {
    settings[key] -= 1;
    return true;
  }
  return chance(rate);
}

function record(id, status) {
  stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
  if (id) {
    const entry = (stats.byCompetitor[id] ??= { requests: 0, byStatus: {} });
    entry.requests += 1;
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + 1;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendServerError(res) {
  const failure = pick([
    () => {
      sendJson(res, 500, { error: "internal_error" });
      return 500;
    },
    () => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body><h1>502 Bad Gateway</h1></body></html>");
      return 502;
    },
    () => {
      sendJson(res, 503, { error: "service_unavailable" });
      return 503;
    },
  ]);
  return failure();
}

function handleListing(res, id) {
  stats.requests += 1;
  const retryAfter = takeToken();
  if (retryAfter > 0) {
    record(id, 429);
    sendJson(res, 429, { error: "rate_limited" }, { "retry-after": String(retryAfter) });
    return;
  }
  if (consumeOnce("timeoutNext", settings.timeoutRate)) {
    record(id, "timeout");
    setTimeout(() => res.socket?.destroy(), settings.timeoutMs);
    return;
  }
  const shouldFail = consumeOnce("failNext", settings.errorRate);
  setTimeout(() => {
    if (shouldFail) {
      record(id, sendServerError(res));
      return;
    }
    const version = competitors.has(id) ? competitors.get(id)[versionIndex(id)] : null;
    if (!version || version.delisted) {
      record(id, 404);
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const listing = renderListing(id, version);
    if (consumeOnce("partialNext", settings.partialRate)) {
      damageListing(listing);
    }
    record(id, 200);
    sendJson(res, 200, listing);
  }, latency());
}

function validateSettings(patch) {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return "Body must be a JSON object";
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) {
      return `Unknown setting: ${key}`;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") return `${key} must be a boolean`;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `${key} must be a number >= 0`;
    }
    if (RATE_KEYS.has(key) && value > 1) {
      return `${key} must be between 0 and 1`;
    }
  }
  return null;
}

function configure(res, patch) {
  const error = validateSettings(patch);
  if (error) {
    sendJson(res, 400, { error });
    return;
  }
  if ("versionIntervalSeconds" in patch) {
    freezeVersions();
  }
  settings = { ...settings, ...patch };
  if ("rateLimitPerSecond" in patch) {
    bucket.tokens = Math.min(bucket.tokens, Math.max(1, settings.rateLimitPerSecond));
  }
  sendJson(res, 200, { settings });
}

function handleAdvance(res, body) {
  const ids = body.id ? [body.id] : [...competitors.keys()];
  const steps = body.steps ?? 1;
  if (!Number.isInteger(steps)) {
    sendJson(res, 400, { error: "steps must be an integer" });
    return;
  }
  if (ids.some((id) => !competitors.has(id))) {
    sendJson(res, 404, { error: `Unknown competitor: ${body.id}` });
    return;
  }
  advance(ids, steps);
  sendJson(res, 200, { versions: currentVersions() });
}

function currentVersions() {
  return Object.fromEntries(
    [...competitors.keys()].map((id) => [
      id,
      { index: versionIndex(id), of: competitors.get(id).length },
    ]),
  );
}

function reset(res) {
  settings = { ...DEFAULT_SETTINGS };
  clock = createClock();
  stats = createStats();
  bucket.tokens = settings.rateLimitPerSecond;
  bucket.updatedAt = Date.now();
  sendJson(res, 200, { settings });
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        rejectBody(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(raw.trim() === "" ? {} : JSON.parse(raw));
      } catch {
        rejectBody(new Error("Invalid JSON body"));
      }
    });
    req.on("error", rejectBody);
  });
}

async function handleControl(req, res, path) {
  if (req.method === "GET" && path === "/control/stats") {
    sendJson(res, 200, { ...stats, versions: currentVersions(), settings, seed: SEED });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  if (path === "/control/configure") return configure(res, body);
  if (path === "/control/advance") return handleAdvance(res, body);
  if (path === "/control/reset") return reset(res);
  sendJson(res, 404, { error: "not_found" });
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const listingMatch = path.match(/^\/listings\/([^/]+)$/);
  if (req.method === "GET" && listingMatch) {
    handleListing(res, decodeURIComponent(listingMatch[1]));
    return;
  }
  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path.startsWith("/control/")) {
    handleControl(req, res, path).catch(() => sendJson(res, 500, { error: "internal_error" }));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(
    `Listing source on http://localhost:${PORT} (${competitors.size} competitors, seed ${SEED})`,
  );
});
