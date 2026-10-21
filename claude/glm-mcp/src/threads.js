// threads.js -- the live channel between the orchestrator (Claude) and GLM.
//
// A thread is one GLM conversation about one piece of work in one working directory. Its
// messages are saved to disk (0600, under glm-mcp/threads/), so the orchestrator can:
//   * continue it with a follow-up (glm_agent thread_id, or glm_thread action:"reply"),
//   * answer a question GLM asked with its ask_orchestrator tool,
//   * run it in the background and check its status / wait for it / cancel it.
//
// Job state lives in memory in this server process; the message history survives restarts.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const THREADS_DIR = process.env.GLM_THREADS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "threads");
const PROGRESS_KEEP = 40;

function threadPath(id) {
  if (!/^[a-z0-9-]{8,64}$/i.test(String(id))) throw new Error(`invalid thread_id ${id}`);
  return join(THREADS_DIR, `${id}.json`);
}

export function newThread(root, title) {
  return { id: randomUUID(), root, title: title || "", created: new Date().toISOString(), messages: [], pendingAskId: null, pendingResults: null, runs: [] };
}

export function loadThread(id) {
  const p = threadPath(id);
  if (!existsSync(p)) throw new Error(`unknown thread_id ${id}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveThread(t) {
  mkdirSync(THREADS_DIR, { recursive: true, mode: 0o700 });
  const p = threadPath(t.id);
  t.updated = new Date().toISOString();
  writeFileSync(p, JSON.stringify(t), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

export function listThreads(limit = 20) {
  if (!existsSync(THREADS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(THREADS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(THREADS_DIR, f), "utf8"));
      out.push({ id: t.id, title: t.title, root: t.root, updated: t.updated, pending_question: t.pendingAskId ? lastQuestion(t) : null, runs: (t.runs || []).length });
    } catch {}
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, limit);
}

export function lastQuestion(t) {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ask = m.content.find((b) => b.type === "tool_use" && b.name === "ask_orchestrator");
    if (ask) return String(ask.input?.question || "");
  }
  return null;
}

// ---------------------------------------------------------------- in-process jobs
// state: running | waiting_for_orchestrator | done | error | cancelled
const jobs = new Map();

export function jobOf(id) { return jobs.get(id) || null; }

export function startJob(id, title, runner) {
  const existing = jobs.get(id);
  if (existing && existing.state === "running") throw new Error(`thread ${id} is already running; wait for it, check its status, or cancel it`);
  const controller = new AbortController();
  const job = { id, title, state: "running", startedAt: new Date().toISOString(), finishedAt: null, progress: [], result: null, error: null, controller, waiters: [] };
  jobs.set(id, job);
  job.promise = (async () => {
    try {
      const r = await runner({
        signal: controller.signal,
        onProgress: (msg) => { job.progress.push(`${new Date().toISOString().slice(11, 19)} ${msg}`); if (job.progress.length > PROGRESS_KEEP) job.progress.shift(); },
      });
      job.result = r;
      job.state = r.cancelled ? "cancelled" : r.question ? "waiting_for_orchestrator" : "done";
    } catch (e) {
      job.error = e?.message || String(e);
      job.state = "error";
    } finally {
      job.finishedAt = new Date().toISOString();
      for (const w of job.waiters.splice(0)) w();
    }
    return job;
  })();
  return job;
}

export function waitJob(id, seconds) {
  const job = jobs.get(id);
  if (!job || job.state !== "running" || !seconds) return Promise.resolve(job);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(job), seconds * 1000);
    job.waiters.push(() => { clearTimeout(t); resolve(job); });
  });
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.state !== "running") return false;
  job.controller.abort();
  return true;
}
