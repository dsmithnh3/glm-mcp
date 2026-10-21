// glmClient.js
// Thin client over the GLM Anthropic-compatible endpoint with the things that
// matter for GLM specifically:
//   1. A concurrency gate (GLM caps in-flight requests at ~1 even on paid tiers).
//   2. Exponential backoff on 429 / "concurrency" / 5xx errors.
//   3. STREAMING (SSE) so we can (a) report live token count + tok/s progress,
//      (b) use an idle/stall timeout instead of a wall-clock cap (a long but
//      actively-streaming turn is never aborted), and (c) cancel cleanly when the
//      MCP client cancels the tool call.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { estimateCost } from "./router.js";

// Local usage ledger: every GLM call is appended here so you have independent, on-disk
// proof of GLM usage (model + tokens + estimated cost), regardless of what the z.ai dashboard
// shows. GLM_USAGE_LOG overrides the location (tests point it at a temp file).
const USAGE_LOG = process.env.GLM_USAGE_LOG || join(dirname(fileURLToPath(import.meta.url)), "..", "usage.jsonl");

/** Append one GLM call to the ledger with its estimated USD cost (estimateCost). */
export function logUsage(model, usage, date = new Date()) {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  try {
    appendFileSync(
      USAGE_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        est_cost_usd: estimateCost(model, inputTokens, outputTokens, date),
      }) + "\n"
    );
  } catch {}
}

/** Cumulative GLM usage from the local ledger — independent proof of GLM token spend. */
export function usageSummary() {
  const out = {
    calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0,
    est_cost_usd: 0, lines_with_cost: 0,
    by_model: {}, log_path: USAGE_LOG,
  };
  try {
    for (const l of readFileSync(USAGE_LOG, "utf8").trim().split(/\r?\n/)) {
      if (!l) continue;
      const e = JSON.parse(l);
      out.calls++;
      out.input_tokens += e.input_tokens || 0;
      out.output_tokens += e.output_tokens || 0;
      if (typeof e.est_cost_usd === "number" && Number.isFinite(e.est_cost_usd)) {
        out.est_cost_usd += e.est_cost_usd;
        out.lines_with_cost++; // older lines carry no est_cost_usd and are not counted
      }
      out.by_model[e.model] = (out.by_model[e.model] || 0) + 1;
    }
    out.total_tokens = out.input_tokens + out.output_tokens;
    out.est_cost_usd = Math.round(out.est_cost_usd * 1e6) / 1e6;
  } catch {}
  return out;
}

const BASE_URL = (process.env.GLM_BASE_URL || "https://api.z.ai/api/anthropic").replace(/\/$/, "");
const API_KEY = process.env.GLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.GLM_MAX_CONCURRENT || "1", 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.GLM_MAX_RETRIES || "4", 10));
// Idle/stall timeout: abort a turn only if NO stream bytes arrive for this long (default 2 min).
// A long-but-active generation keeps resetting this, so it is never cut off mid-stream.
const STALL_MS = parseInt(process.env.GLM_STALL_TIMEOUT_MS || process.env.GLM_TIMEOUT_MS || "120000", 10);

// ---- tiny semaphore so we never exceed GLM's concurrency cap ----
let active = 0;
const waiters = [];
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise((res) => waiters.push(res));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Error thrown when the MCP client cancels the tool call (do NOT retry these). */
export class CancelledError extends Error {
  constructor(msg = "cancelled by client") { super(msg); this.name = "CancelledError"; this.cancelled = true; }
}

function isRetryable(status, bodyText) {
  if (status === 429 || status === 503 || status === 502 || status === 500) return true;
  if (bodyText && /concurren|rate.?limit|too\s+much/i.test(bodyText)) return true;
  return false;
}

/**
 * Call GLM's /v1/messages (Anthropic Messages API shape) with streaming.
 * @param {object} p
 * @param {string}   p.model
 * @param {Array}    p.messages
 * @param {string}   [p.system]
 * @param {number}   [p.maxTokens]
 * @param {boolean}  [p.thinking]
 * @param {Array}    [p.tools]
 * @param {(outTokens:number, tokPerSec:number)=>void} [p.onToken]  live progress callback (throttled)
 * @param {AbortSignal} [p.signal]  cancels the call when the MCP client cancels the tool
 * @returns {Promise<{text:string, usage:object, raw:object}>}
 */
// GLM-5.3 always reasons (thinking cannot be disabled) and takes an effort of low | high | max,
// default max (docs.z.ai/guides/llm/glm-5.3). Claude Code sends effort to the Anthropic-compatible
// endpoint as output_config.effort; the GLM docs show a reasoning_effort field. Both are sent by
// default; GLM_EFFORT_FIELDS trims the list if an endpoint ever rejects one.
const EFFORT = (process.env.GLM_EFFORT || "max").toLowerCase();
const EFFORT_FIELDS = (process.env.GLM_EFFORT_FIELDS || "output_config,reasoning_effort").split(",").map((s) => s.trim()).filter(Boolean);
const THINKING = (process.env.GLM_THINKING || "enabled").toLowerCase(); // enabled | adaptive
export const effortConfig = { effort: EFFORT, fields: EFFORT_FIELDS, thinking: THINKING };

export async function glmMessage({ model, messages, system, maxTokens = 131072, thinking = true, tools, onToken, signal }) {
  if (!API_KEY) {
    throw new Error(
      "GLM_API_KEY (or ANTHROPIC_AUTH_TOKEN) is not set. Add it to glm-mcp/.env or the MCP server env in .mcp.json."
    );
  }

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools } : {}),
    // Reasoning is always on (the `thinking` argument is kept for API compatibility only).
    // budget_tokens must stay below max_tokens; leave room for the visible answer.
    thinking: THINKING === "adaptive" ? { type: "adaptive" } : { type: "enabled", budget_tokens: Math.max(1024, maxTokens - Math.min(16384, Math.floor(maxTokens / 4))) },
    ...(EFFORT_FIELDS.includes("output_config") ? { output_config: { effort: EFFORT } } : {}),
    ...(EFFORT_FIELDS.includes("reasoning_effort") ? { reasoning_effort: EFFORT } : {}),
  };

  await acquire();
  try {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) throw new CancelledError();

      // Per-attempt abort controller: fires on external cancel OR on stream stall.
      const ac = new AbortController();
      let stallTimer = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ac.abort(new Error("__stall__")), STALL_MS);
      };
      const onExternalAbort = () => ac.abort(new CancelledError());
      if (signal) signal.addEventListener("abort", onExternalAbort, { once: true });
      const cleanup = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (signal) signal.removeEventListener("abort", onExternalAbort);
      };

      let res;
      try {
        armStall();
        res = await fetch(`${BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            authorization: `Bearer ${API_KEY}`,
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        cleanup();
        if (signal?.aborted) throw new CancelledError();
        if (attempt < MAX_RETRIES) { await sleep(backoff(attempt++)); continue; }
        throw new Error(`GLM request failed (network/timeout): ${e.message}`);
      }

      if (!res.ok) {
        let txt = "";
        try { txt = await res.text(); } catch {}
        cleanup();
        if (isRetryable(res.status, txt) && attempt < MAX_RETRIES) { await sleep(backoff(attempt++, txt)); continue; }
        throw new Error(`GLM API error ${res.status}: ${truncate(txt, 800)}`);
      }

      try {
        const result = await parseSSE(res.body, { armStall, onToken });
        cleanup();
        if (!result.text && !(result.raw.content || []).some((b) => b.type === "tool_use")) {
          // Stream yielded nothing usable — treat like a retryable hiccup.
          if (attempt < MAX_RETRIES) { await sleep(backoff(attempt++)); continue; }
        }
        logUsage(model, result.usage);
        return result;
      } catch (e) {
        cleanup();
        if (signal?.aborted || e instanceof CancelledError) throw new CancelledError();
        // stall or mid-stream error -> retry the whole turn
        if (attempt < MAX_RETRIES) { await sleep(backoff(attempt++)); continue; }
        throw new Error(`GLM stream failed: ${e.message}`);
      }
    }
  } finally {
    release();
  }
}

/**
 * Parse an Anthropic-style SSE stream into { text, usage, raw }, reconstructing the
 * content blocks (text / thinking / tool_use) exactly as the non-streaming JSON would.
 * Resets the stall timer on every chunk and reports live token progress via onToken.
 */
async function parseSSE(stream, { armStall, onToken }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const raw = { id: null, role: "assistant", model: null, stop_reason: null, content: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const blocks = {}; // index -> { type, text?, thinking?, signature?, _json? , ...tool_use fields }
  const start = Date.now();
  let outChars = 0;
  let lastEmit = 0;
  let curEvent = null;

  const mergeUsage = (u) => {
    if (!u) return;
    if (u.input_tokens) raw.usage.input_tokens = u.input_tokens;
    if (u.output_tokens != null) raw.usage.output_tokens = u.output_tokens;
  };
  const maybeEmit = (force) => {
    if (!onToken) return;
    const now = Date.now();
    if (!force && now - lastEmit < 600) return;
    lastEmit = now;
    const outTok = raw.usage.output_tokens || Math.round(outChars / 4);
    const secs = Math.max((now - start) / 1000, 0.5); // floor so tiny fast bursts don't report absurd rates
    onToken(outTok, Math.round(outTok / secs));
  };

  const handle = (evt, data) => {
    switch (evt) {
      case "message_start":
        if (data.message) {
          raw.id = data.message.id ?? raw.id;
          raw.model = data.message.model ?? raw.model;
          raw.role = data.message.role ?? raw.role;
          mergeUsage(data.message.usage);
        }
        break;
      case "content_block_start": {
        const b = { ...(data.content_block || {}) };
        if (b.type === "text" && b.text == null) b.text = "";
        if (b.type === "thinking" && b.thinking == null) b.thinking = "";
        if (b.type === "tool_use") b._json = "";
        blocks[data.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[data.index] || (blocks[data.index] = { type: "text", text: "" });
        const d = data.delta || {};
        if (d.type === "text_delta") { b.text = (b.text || "") + (d.text || ""); outChars += (d.text || "").length; maybeEmit(); }
        else if (d.type === "thinking_delta") { b.thinking = (b.thinking || "") + (d.thinking || ""); outChars += (d.thinking || "").length; maybeEmit(); }
        else if (d.type === "signature_delta") { b.signature = (b.signature || "") + (d.signature || ""); }
        else if (d.type === "input_json_delta") { b._json = (b._json || "") + (d.partial_json || ""); }
        break;
      }
      case "content_block_stop": {
        const b = blocks[data.index];
        if (b && b.type === "tool_use") {
          try { b.input = JSON.parse(b._json || "{}"); } catch { b.input = {}; }
          delete b._json;
        }
        break;
      }
      case "message_delta":
        if (data.delta && data.delta.stop_reason != null) raw.stop_reason = data.delta.stop_reason;
        if (data.usage) { mergeUsage(data.usage); maybeEmit(); }
        break;
      case "message_stop":
      case "ping":
      default:
        break;
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    armStall();
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") { curEvent = null; continue; }
      if (line.startsWith("event:")) { curEvent = line.slice(6).trim(); continue; }
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let data;
        try { data = JSON.parse(payload); } catch { continue; }
        handle(curEvent || data.type, data);
      }
    }
  }

  raw.content = Object.keys(blocks).sort((a, b) => a - b).map((k) => blocks[k]);
  const text = raw.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  maybeEmit(true);
  return { text, usage: raw.usage, raw };
}

function backoff(attempt, bodyText) {
  const concurrency = bodyText && /concurren|too\s+much/i.test(bodyText);
  const base = concurrency ? 2000 : 800;
  const jitter = Math.random() * 400;
  return Math.min(base * 2 ** attempt + jitter, 30000);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

export const config = { BASE_URL, MAX_CONCURRENT, MAX_RETRIES, hasKey: Boolean(API_KEY), stallMs: STALL_MS };
