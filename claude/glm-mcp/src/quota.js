// quota.js -- reads the Z.ai GLM Coding Plan quota (5-hour window, weekly window, plan level).
//
// The endpoint is undocumented: GET https://api.z.ai/api/monitor/usage/quota/limit, the raw key in
// the Authorization header (no "Bearer "). Its shape was confirmed by a live call on 2026-10-23, so
// every field is validated and every failure is soft: the tool answers { ok:false, error } and never
// throws for an upstream problem. The key stays in this module's request; no returned string carries
// it, the request headers or the response body.
//
// The read does NOT go through glmClient's generation semaphore: a quota read must not queue behind
// a running agent call. Several sessions poll it, so the last good answer is cached for TTL_MS, a
// failure for FAIL_TTL_MS (so a Z.ai outage is not asked again by every poll), and concurrent reads
// share one request. The URL is fixed in code: nothing in the environment can send the key elsewhere,
// and redirects are refused for the same reason.

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FAIL_TTL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 10_000;

// Only these have been observed. Anything else is passed through as "unknown" with its raw
// type, unit and number, never dropped and never guessed (a monthly TIME_LIMIT entry with unit 5
// counts calls, not credits, so it must not read as a credit window).
const KNOWN_TYPES = new Set(["CREDIT_LIMIT"]);
const WINDOW_ID = { "3:5": "5h", "6:1": "week" };

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Map one upstream limit to a window, or null when its shape is wrong. */
function toWindow(l) {
  if (!l || typeof l !== "object") return null;
  const { type, unit, number, usage, currentValue, remaining, percentage, nextResetTime } = l;
  if (![unit, number, usage, currentValue, remaining, percentage, nextResetTime].every(finite)) return null;
  const reset = new Date(nextResetTime);
  if (Number.isNaN(reset.getTime())) return null;
  const known = typeof type === "string" && KNOWN_TYPES.has(type);
  return {
    id: (known && WINDOW_ID[`${unit}:${number}`]) || "unknown",
    type: typeof type === "string" ? type : null,
    unit,
    number,
    limit: usage,
    used: currentValue,
    remaining, // the server's own figure: usage - currentValue has come out 1 higher
    percent: percentage,
    resetsAt: reset.toISOString(),
  };
}

/** Parse an upstream body into the tool's payload, or throw a short, key-free reason. */
export function parseQuota(body, fetchedAt) {
  if (!body || typeof body !== "object") throw new QuotaError("bad response shape");
  if (body.success !== true || body.code !== 200) throw new QuotaError("upstream reported failure");
  const data = body.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.limits)) throw new QuotaError("bad response shape");
  const windows = data.limits.map(toWindow);
  if (windows.some((w) => w === null)) throw new QuotaError("bad response shape");
  return { ok: true, level: typeof data.level === "string" ? data.level : null, fetchedAt, windows };
}

class QuotaError extends Error {}

/**
 * A quota reader with its own cache. Injected `fetch`, `now` and key make it testable without a
 * network or a real key; index.js builds the one the server uses.
 */
export function createQuotaReader({
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  url = QUOTA_URL, // tests only: the server never passes another
  ttlMs = DEFAULT_TTL_MS,
  failTtlMs = DEFAULT_FAIL_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let lastGood = null; // { payload, at }
  let lastFail = null; // { result, at }
  let inflight = null;

  async function request(signal) {
    let res;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { Authorization: apiKey, Accept: "application/json" }, redirect: "error", signal });
    } catch {
      throw new QuotaError(signal.aborted ? "timed out" : "network error");
    }
    if (!res || res.status !== 200) throw new QuotaError(`HTTP ${res ? res.status : "no response"}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new QuotaError(signal.aborted ? "timed out" : "bad response shape");
    }
    return parseQuota(body, new Date(now()).toISOString());
  }

  // The timer settles the read on its own, so a fetch that ignores the abort cannot hang every
  // later read behind the shared in-flight request.
  async function fetchOnce() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new QuotaError("timed out"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([request(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return async function readQuota({ fresh = false } = {}) {
    if (!apiKey) return { ok: false, error: "no GLM key configured" };
    if (!fresh && lastGood && now() - lastGood.at < ttlMs) return { ...lastGood.payload, cached: true };
    if (!fresh && lastFail && now() - lastFail.at < failTtlMs) return lastFail.result;
    if (!inflight) {
      inflight = fetchOnce()
        .then((payload) => {
          lastGood = { payload, at: now() };
          lastFail = null;
          return payload;
        })
        .catch((e) => {
          const error = e instanceof QuotaError ? e.message : "unexpected error";
          const result = { ok: false, error, ...(lastGood ? { lastGood: lastGood.payload } : {}) };
          lastFail = { result, at: now() };
          return result;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
