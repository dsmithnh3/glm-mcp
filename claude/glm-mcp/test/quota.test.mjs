// Offline tests for glm_quota's reader: fetch is mocked, the key is a sentinel, no network.
// Run: node --test claude/glm-mcp/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuotaReader, parseQuota } from "../src/quota.js";

const SENTINEL = "sk-SENTINEL-do-not-leak-7f3a";

// The live response from 2026-10-23, key redacted (it never carried one).
const LIVE = {
  code: 200, msg: "Operation successful", success: true,
  data: { level: "pro", limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 3150, remaining: 8849, percentage: 26, nextResetTime: 1792779223261 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 25273, remaining: 34726, percentage: 42, nextResetTime: 1792800508983 },
  ] },
};

const response = (body, status = 200) => ({ status, json: async () => body });

/** A fetch that records each call and answers from `answer(call)`. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return answer(calls.length, init);
  };
  fn.calls = calls;
  return fn;
}

const noKey = (value) => assert.equal(JSON.stringify(value).includes(SENTINEL), false, "the key must never appear in a result");

test("parses the verbatim live response into two windows", async () => {
  const fetch = fakeFetch(() => response(LIVE));
  const read = createQuotaReader({ apiKey: SENTINEL, fetch, now: () => Date.parse("2026-10-23T15:00:00Z") });
  const r = await read();
  assert.equal(r.ok, true);
  assert.equal(r.level, "pro");
  assert.equal(r.fetchedAt, "2026-10-23T15:00:00.000Z");
  assert.deepEqual(r.windows, [
    { id: "5h", type: "CREDIT_LIMIT", unit: 3, number: 5, limit: 12000, used: 3150, remaining: 8849, percent: 26, resetsAt: new Date(1792779223261).toISOString() },
    { id: "week", type: "CREDIT_LIMIT", unit: 6, number: 1, limit: 60000, used: 25273, remaining: 34726, percent: 42, resetsAt: new Date(1792800508983).toISOString() },
  ]);
  noKey(r);
});

test("sends the raw key with no Bearer prefix, to Z.ai's quota URL only, refusing redirects", async () => {
  const fetch = fakeFetch(() => response(LIVE));
  process.env.GLM_QUOTA_URL = "https://attacker.test/collect"; // ignored: the URL is fixed in code
  await createQuotaReader({ apiKey: SENTINEL, fetch })();
  delete process.env.GLM_QUOTA_URL;
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(fetch.calls[0].init.headers.Authorization, SENTINEL);
  assert.equal(fetch.calls[0].init.redirect, "error");
});

test("an unknown unit, or an unknown type, is kept as unknown with its raw fields", () => {
  const body = structuredClone(LIVE);
  body.data.limits.push({ type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 12, remaining: 988, percentage: 1, nextResetTime: 1793000000000 });
  body.data.limits.push({ type: "TIME_LIMIT", unit: 3, number: 5, usage: 50, currentValue: 5, remaining: 45, percentage: 10, nextResetTime: 1793000000000 });
  body.data.limits.push({ type: "CREDIT_LIMIT", unit: 3, number: 2, usage: 50, currentValue: 5, remaining: 45, percentage: 10, nextResetTime: 1793000000000 });
  const r = parseQuota(body, "t");
  assert.equal(r.windows.length, 5);
  assert.deepEqual(r.windows.slice(2).map((w) => [w.id, w.type, w.unit, w.number]), [
    ["unknown", "TIME_LIMIT", 5, 1],
    ["unknown", "TIME_LIMIT", 3, 5],
    ["unknown", "CREDIT_LIMIT", 3, 2],
  ]);
});

test("HTTP 200 with success:false is a failure, and so is code !== 200", async () => {
  for (const body of [{ ...LIVE, success: false }, { ...LIVE, code: 401 }]) {
    const r = await createQuotaReader({ apiKey: SENTINEL, fetch: fakeFetch(() => response(body)) })();
    assert.deepEqual(r, { ok: false, error: "upstream reported failure" });
  }
});

test("a non-200 status and a malformed body fail softly with a short reason", async () => {
  const r1 = await createQuotaReader({ apiKey: SENTINEL, fetch: fakeFetch(() => response({ secret: SENTINEL }, 401)) })();
  assert.deepEqual(r1, { ok: false, error: "HTTP 401" });
  const bad = structuredClone(LIVE);
  bad.data.limits[0].percentage = "26";
  const r2 = await createQuotaReader({ apiKey: SENTINEL, fetch: fakeFetch(() => response(bad)) })();
  assert.deepEqual(r2, { ok: false, error: "bad response shape" });
  const r3 = await createQuotaReader({ apiKey: SENTINEL, fetch: fakeFetch(() => ({ status: 200, json: async () => { throw new Error(SENTINEL); } })) })();
  assert.deepEqual(r3, { ok: false, error: "bad response shape" });
  noKey([r1, r2, r3]);
});

test("a network error never echoes the thrown message", async () => {
  const r = await createQuotaReader({ apiKey: SENTINEL, fetch: async () => { throw new Error(`connect failed with ${SENTINEL}`); } })();
  assert.deepEqual(r, { ok: false, error: "network error" });
  noKey(r);
});

test("a timeout returns ok:false, with lastGood after an earlier success", async () => {
  let t = 0;
  const fetch = fakeFetch((n, init) => n === 1
    ? response(LIVE)
    : new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const read = createQuotaReader({ apiKey: SENTINEL, fetch, now: () => t, timeoutMs: 20, ttlMs: 1000, failTtlMs: 0 });
  const first = await read();
  assert.equal(first.ok, true);
  t = 5000; // past the TTL, so the next read goes upstream and hangs
  const second = await read();
  assert.equal(second.ok, false);
  assert.equal(second.error, "timed out");
  assert.deepEqual(second.lastGood, first);
  assert.ok(second.lastGood.fetchedAt);
  noKey(second);
});

test("a timeout with no earlier success has no lastGood", async () => {
  const fetch = fakeFetch((n, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const r = await createQuotaReader({ apiKey: SENTINEL, fetch, timeoutMs: 20 })();
  assert.deepEqual(r, { ok: false, error: "timed out" });
});

test("the cache answers within the TTL, and fresh bypasses it", async () => {
  let t = 0;
  const fetch = fakeFetch(() => response(LIVE));
  const read = createQuotaReader({ apiKey: SENTINEL, fetch, now: () => t, ttlMs: 60_000 });
  await read();
  t = 59_000;
  const cached = await read();
  assert.equal(fetch.calls.length, 1, "within the TTL no second request");
  assert.equal(cached.cached, true);
  await read({ fresh: true });
  assert.equal(fetch.calls.length, 2, "fresh goes upstream");
  t = 59_000 + 60_001;
  await read();
  assert.equal(fetch.calls.length, 3, "past the TTL goes upstream");
});

test("concurrent reads share one request", async () => {
  const fetch = fakeFetch(() => response(LIVE));
  const read = createQuotaReader({ apiKey: SENTINEL, fetch });
  const rs = await Promise.all([read(), read(), read()]);
  assert.equal(fetch.calls.length, 1);
  assert.ok(rs.every((r) => r.ok));
});

test("no key configured answers without a request", async () => {
  const fetch = fakeFetch(() => response(LIVE));
  for (const apiKey of ["", undefined]) {
    assert.deepEqual(await createQuotaReader({ apiKey, fetch })(), { ok: false, error: "no GLM key configured" });
  }
  assert.equal(fetch.calls.length, 0);
});

test("a fetch that ignores the abort still times out, and the next read is not stuck behind it", async () => {
  let t = 0;
  const fetch = fakeFetch(() => new Promise(() => {})); // never settles, ignores the signal
  const read = createQuotaReader({ apiKey: SENTINEL, fetch, now: () => t, timeoutMs: 20, failTtlMs: 0 });
  assert.deepEqual(await read(), { ok: false, error: "timed out" });
  t = 1;
  assert.deepEqual(await read(), { ok: false, error: "timed out" });
  assert.equal(fetch.calls.length, 2, "the second read made its own request");
});

test("a failure is cached briefly, so an outage is not asked again by every poll; fresh still asks", async () => {
  let t = 0;
  const fetch = fakeFetch(() => response({}, 503));
  const read = createQuotaReader({ apiKey: SENTINEL, fetch, now: () => t, failTtlMs: 15_000 });
  await read();
  t = 14_000;
  assert.deepEqual(await read(), { ok: false, error: "HTTP 503" });
  assert.equal(fetch.calls.length, 1);
  await read({ fresh: true });
  assert.equal(fetch.calls.length, 2);
  t = 30_000;
  await read();
  assert.equal(fetch.calls.length, 3);
});
