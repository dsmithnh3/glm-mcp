#!/usr/bin/env node
// index.js -- GLM MCP server.
// Exposes GLM (Zhipu/Z.ai) to Claude Code as a cheap implementer the orchestrator can talk to:
//   glm_agent      -- run GLM as a file-accessing coding agent (a resumable THREAD; can run in background)
//   glm_thread     -- live channel: list / status / wait / reply (answer GLM's questions) / cancel / history
//   glm_delegate   -- text-only subtask (opt-in: GLM_DELEGATE=on)
//   glm_recommend  -- advisory: should this task go to GLM or Opus? which model?
//   glm_status     -- peak window, model picks, cost multipliers, config sanity
//   glm_quota      -- Z.ai Coding Plan quota: 5-hour and weekly windows, plan level (cached ~60 s)
//
// Design notes baked in (see docs/research):
//   * "auto" model selection defaults to GLM-5.2 in both windows; since GLM-5.2 carries the
//     ~3x peak surcharge, the router routes less work to GLM during peak.
//   * Calls are serialized through a concurrency gate to respect GLM's ~1-in-flight cap.
//   * Output stays high-signal: a short metadata header + GLM's answer, capped.

import "./loadEnv.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { glmMessage, config, usageSummary, effortConfig, resolveApiKey } from "./glmClient.js";
import { createQuotaReader } from "./quota.js";
import {
  resolveModel,
  recommend,
  isPeak,
  chinaHour,
  peakMultiplier,
  estimateCost,
  MODELS,
  resolveMaxTokens,
  MAXTOK,
  USE_HAIKU,
} from "./router.js";
import { runGlmAgent } from "./glmAgent.js";
import { newThread, saveThread, loadThread, listThreads, lastQuestion, jobOf, startJob, waitJob, cancelJob } from "./threads.js";
import { resolve as resolvePath } from "node:path";

const CHARACTER_LIMIT = 50000;

const server = new McpServer({ name: "glm-mcp", version: "1.5.0" });

const TASK_TYPES = [
  // strong GLM
  "frontend", "ui", "boilerplate", "scaffolding", "config", "crud", "regex",
  "docs", "i18n", "type_lint", "unit_test", "refactor_local", "prototype", "toolcall_single",
  // mild GLM
  "sql", "etl", "cicd", "cli", "notebook", "integration_test",
  "algorithm", "research", "summarization", "toolcall_fanout",
  // neutral
  "general", "ml_training",
  // lean / strong Opus
  "iac", "dependency_upgrade", "debugging", "code_review", "perf", "api_integration",
  "migration", "systems", "refactor_large", "architecture", "security",
  "agentic_loop", "toolcall_heavy",
];

// glm_delegate (text-only) is OPT-IN: default OFF so orchestrators always use glm_agent
// (which also handles text-only tasks). Set GLM_DELEGATE=on/true/yes/1 to expose it.
const DELEGATE_ENABLED = /^(1|on|true|yes)$/i.test(process.env.GLM_DELEGATE || "off");

// Build a progress emitter bound to this tool call. If the MCP client supplied a
// progressToken, stream live status (iteration, token count, tok/s) via
// notifications/progress -- rendered by Claude Code and VS Code Copilot, and it also
// keeps the call alive on clients that reset their timeout on progress.
function makeProgress(extra) {
  const token = extra?._meta?.progressToken;
  let seq = 0;
  return (message) => {
    if (token == null || !extra?.sendNotification) return;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++seq, message } }).catch(() => {});
  };
}

// ----------------------------- glm_delegate -----------------------------
if (DELEGATE_ENABLED) {
server.registerTool(
  "glm_delegate",
  {
    title: "Delegate a subtask to GLM",
    description:
      "Text-in/text-out subtask on GLM (~2-3x cheaper than Opus per token, off-peak; less at peak); returns text only. GLM has no " +
      "file/tool access -- put everything in task+context. For file edits use glm_agent instead. " +
      "Not for sensitive, long-debugging, large-refactor, or parallel work.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe("The instruction for GLM. Be explicit and self-contained, e.g. 'Write a React component that...'."),
      context: z
        .string()
        .optional()
        .describe("Supporting material GLM needs: code to modify, file contents, specs, examples. GLM has no file access."),
      model: z
        .string()
        .optional()
        .describe("Model id or 'auto' (default). e.g. glm-5.3, glm-5.3-flash. 'auto' (default) is glm-5.3."),
      system: z.string().optional().describe("Optional system prompt to steer GLM's role/format."),
      thinking: z.boolean().optional().describe("Ignored: GLM-5.3 always reasons, at GLM_EFFORT (default max)."),
      max_tokens: z.union([z.literal("auto"), z.number().int().min(256).max(131072)]).optional().describe("'auto' (default): uncapped/generous — you (the orchestrating agent) decide. Pass a number (256–131072) to cap this call. (GLM_CAP=on enforces a hard limit regardless.)"),
      format: z.enum(["concise", "detailed"]).optional().describe("concise (default) or detailed metadata."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ task, context, model = "auto", system, thinking = false, max_tokens = "auto", format = "concise" }, extra) => {
    const now = new Date();
    const chosen = resolveModel(model, now);
    const onProgress = makeProgress(extra);
    const userContent = context ? `${task}\n\n--- CONTEXT ---\n${context}` : task;
    try {
      const { text, usage } = await glmMessage({
        model: chosen,
        system,
        messages: [{ role: "user", content: userContent }],
        maxTokens: resolveMaxTokens(max_tokens),
        thinking,
        signal: extra?.signal,
        onToken: (outTok, tps) => onProgress(`GLM ${chosen} · ${outTok} tok · ${tps} tok/s`),
      });

      const inTok = usage.input_tokens ?? 0;
      const outTok = usage.output_tokens ?? 0;
      const totalTok = inTok + outTok;
      const cost = estimateCost(chosen, inTok, outTok, now);
      const opusCost = estimateCost("claude-opus", inTok, outTok, now);

      // Every output reports how many tokens were delegated to GLM.
      const tokLine = `[GLM delegated ${totalTok} tokens (${inTok} in / ${outTok} out) to ${chosen} — est $${cost}]`;

      let out;
      if (format === "detailed") {
        out =
          `${tokLine}\n[peak=${isPeak(now)} (CN ${chinaHour(now)}:00) | Opus would be ~$${opusCost}, ` +
          `~${opusCost && cost ? Math.round(opusCost / cost) : "?"}x more]\n\n${text}`;
      } else {
        out = `${tokLine}\n\n${text}`;
      }
      return { content: [{ type: "text", text: clip(out) }] };
    } catch (e) {
      if (e && e.cancelled) return { content: [{ type: "text", text: "GLM call cancelled." }] };
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `GLM delegation failed: ${e.message}\n\n` +
              `Suggested next steps:\n` +
              `- If 'concurrency'/'Too much concurrency': retry shortly; GLM caps in-flight requests (~1). Avoid parallel glm_delegate calls.\n` +
              `- If auth error: check GLM_API_KEY in glm-mcp/.env or .mcp.json env.\n` +
              `- If the task is hard/critical, do it on Opus directly instead of GLM.`,
          },
        ],
      };
    }
  }
);
}

// ----------------------------- glm_agent -----------------------------
// Formats one run (or a job's current state) for the orchestrator.
function formatRun(r, { chosen, now, format, state, job }) {
  const inTok = r.usage.input_tokens || 0;
  const outTok = r.usage.output_tokens || 0;
  const totalTok = inTok + outTok;
  const cost = estimateCost(chosen, inTok, outTok, now);
  const opusCost = estimateCost("claude-opus", inTok, outTok, now);
  const xCheaper = cost > 0 ? Math.round(opusCost / cost) : "?";
  const banner = r.dryRun ? "*** DRY RUN — nothing was written; this is GLM's PROPOSED change for you to approve ***\n" : "";
  const header =
    `[GLM agent] thread=${r.threadId} | state=${state} | ${chosen} | dir=${r.root} | ${r.iters} iterations` +
    `${r.hitCap ? " (HIT CAP -- may be incomplete; continue the thread to finish)" : ""}${r.cancelled ? " (CANCELLED -- partial)" : ""}` +
    ` | ${r.actions.length} actions | ${r.changedFiles.length} files | repo rules ${r.rulesLoaded ? "loaded" : "none found"} | codegraph ${r.codegraphIndexed ? "indexed" : "not indexed"}`;
  const blocked = r.actions.filter((a) => a.startsWith("BLOCKED") || a.startsWith("REFUSED"));
  const blockedTxt = blocked.length ? `\n\nRefused by guards (${blocked.length}):\n- ${blocked.join("\n- ")}` : "";
  const showDiff = r.dryRun || format !== "concise";
  const actions = showDiff && r.actions.length ? `\nActions:\n- ${r.actions.join("\n- ")}` : "";
  const diff = showDiff
    ? (r.diff ? `\n\n=== DIFF (review this) ===\n${r.diff}` : "\n\n(no file changes)")
    : (r.changedFiles.length ? `\n\nChanged files: ${r.changedFiles.join(", ")}  (format:"detailed" for the diff)` : "\n\n(no file changes)");
  const revert = !r.dryRun && r.git && r.git.revertHint && r.changedFiles.length ? `\n\nRevert: ${r.git.revertHint}` : "";
  const ask = r.question
    ? `\n\n=== GLM IS WAITING FOR YOU ===\nQuestion: ${r.question}\nAnswer with glm_thread {action:"reply", thread_id:"${r.threadId}", message:"..."}.`
    : "";
  const stats =
    `\n\n=== GLM STATS (this run) ===\n` +
    `model:      ${chosen}\n` +
    `tokens:     ${totalTok} on GLM (${inTok} in / ${outTok} out)\n` +
    `iterations: ${r.iters}${r.hitCap ? " (hit cap)" : ""}   files changed: ${r.changedFiles.length}\n` +
    `est. cost:  $${cost}  (~${xCheaper}x cheaper than Opus)` +
    (job ? `\nstarted:    ${job.startedAt}${job.finishedAt ? `   finished: ${job.finishedAt}` : ""}` : "");
  return clip(`${banner}${header}${actions}${diff}${blockedTxt}${revert}\n\n=== GLM SUMMARY ===\n${r.text}${ask}${stats}`);
}

function jobStatusText(job, format) {
  if (!job) return null;
  const now = new Date();
  if (job.state === "running") {
    return `[GLM agent] thread=${job.id} | state=running | started ${job.startedAt}\n` +
      `Recent progress:\n${job.progress.slice(-12).join("\n") || "(starting)"}\n\n` +
      `Check again with glm_thread {action:"status"|"wait", thread_id:"${job.id}"}; cancel with action:"cancel".`;
  }
  if (job.state === "error") return `[GLM agent] thread=${job.id} | state=error | ${job.error}\nThe thread is saved; you can continue it with a follow-up.`;
  return formatRun(job.result, { chosen: job.model, now, format, state: job.state, job });
}

// Starts a run as a tracked job; returns the job. Sync callers simply await job.promise.
function launch({ task, context, workdir, thread_id, title, model, thinking, max_tokens, dry_run }) {
  const now = new Date();
  const chosen = resolveModel(model || "auto", now);
  let threadId = thread_id;
  if (!threadId) {
    // allocate the id up front so a background caller gets it immediately
    const t = newThread(workdir ? resolvePath(workdir) : process.cwd(), title || String(task).split("\n")[0].slice(0, 100));
    saveThread(t);
    threadId = t.id;
  }
  const job = startJob(threadId, title || String(task).slice(0, 100), ({ signal, onProgress }) =>
    runGlmAgent({ model: chosen, task, context, workdir, threadId, title, maxTokens: resolveMaxTokens(max_tokens), thinking, dryRun: dry_run, onProgress, signal })
  );
  job.model = chosen;
  return job;
}

server.registerTool(
  "glm_agent",
  {
    title: "Run GLM as a file-accessing agent",
    description:
      "Run GLM as a real coding agent with its OWN file tools (read/write/edit/list/bash) on GLM tokens (~2-3x cheaper than Opus per token, off-peak; less at peak). " +
      "GLM receives the repo's AGENTS.md/CLAUDE.md, uses `codegraph explore` itself, and its shell runs through the same safety hooks as yours. " +
      "Every run is a THREAD: GLM can pause with a question (ask_orchestrator); answer it and check/continue/cancel runs with glm_thread. " +
      "Pass task + absolute workdir (ideally a git worktree). background:true returns the thread_id immediately so you can keep working. " +
      "Default output includes the full diff for your review.",
    inputSchema: {
      task: z.string().min(1).describe("The task for GLM, or (with thread_id) your follow-up to an existing thread."),
      workdir: z.string().optional().describe("Absolute path to the project root GLM should operate in (a git worktree is best). Required for a new thread."),
      thread_id: z.string().optional().describe("Continue an existing thread (its workdir is reused)."),
      title: z.string().optional().describe("Short label for the thread (shown in glm_thread list)."),
      context: z.string().optional().describe("Extra context/constraints: files and readers from codegraph, acceptance criteria, tests to run."),
      model: z.string().optional().describe("Model id or 'auto' (default, peak-aware)."),
      thinking: z.boolean().optional().describe("Ignored: GLM-5.3 always reasons, at GLM_EFFORT (default max)."),
      max_tokens: z.union([z.literal("auto"), z.number().int().min(256).max(131072)]).optional().describe("'auto' (default) or a per-turn cap."),
      dry_run: z.boolean().optional().describe("If true, GLM proposes a diff and writes nothing. Default false."),
      background: z.boolean().optional().describe("If true, start the run and return the thread_id immediately; use glm_thread to check status, wait, answer questions, or cancel. Default false."),
      format: z.enum(["concise", "detailed"]).optional().describe("detailed (default: summary + full diff + actions) or concise (changed file names only)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ task, workdir, thread_id, title, context, model = "auto", thinking = false, max_tokens = "auto", dry_run = false, background = false, format = "detailed" }, extra) => {
    if (!thread_id && !workdir) {
      return { isError: true, content: [{ type: "text", text: "glm_agent needs an absolute workdir for a new thread (or a thread_id to continue one)." }] };
    }
    let job;
    try {
      job = launch({ task, context, workdir, thread_id, title, model, thinking, max_tokens, dry_run });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `GLM agent could not start: ${e.message}` }] };
    }
    if (background) {
      return { content: [{ type: "text", text:
        `[GLM agent] started in background | thread=${job.id} | model=${job.model}\n` +
        `Check: glm_thread {action:"status", thread_id:"${job.id}"} · block until done or a question: glm_thread {action:"wait", thread_id:"${job.id}", wait_seconds:600} · stop: action:"cancel".` } ] };
    }
    const onProgress = makeProgress(extra);
    const relay = setInterval(() => { const p = job.progress[job.progress.length - 1]; if (p) onProgress(p); }, 2000);
    const onAbort = () => cancelJob(job.id);
    extra?.signal?.addEventListener?.("abort", onAbort);
    try {
      await job.promise;
    } finally {
      clearInterval(relay);
      extra?.signal?.removeEventListener?.("abort", onAbort);
    }
    if (job.state === "error") {
      return { isError: true, content: [{ type: "text", text:
        `GLM agent failed: ${job.error}\n\nThread ${job.id} is saved — continue it with glm_thread reply once fixed.\n` +
        `- 'concurrency'/'Too much concurrency': retry shortly (GLM caps in-flight ~1).\n- auth error: check GLM_API_KEY.` }] };
    }
    return { content: [{ type: "text", text: jobStatusText(job, format) }] };
  }
);

// ----------------------------- glm_thread -----------------------------
server.registerTool(
  "glm_thread",
  {
    title: "Talk to, monitor, and steer GLM threads",
    description:
      "The live channel to GLM. action:'list' shows recent threads and any pending question; 'status' shows a thread's state " +
      "(running with recent progress, waiting_for_orchestrator with GLM's question, done with summary+diff, error, cancelled); " +
      "'wait' blocks up to wait_seconds until it finishes or asks something; 'reply' answers GLM's question or sends a follow-up " +
      "and continues the run (background:true to return immediately); 'cancel' stops a running thread; 'history' shows the conversation.",
    inputSchema: {
      action: z.enum(["list", "status", "wait", "reply", "cancel", "history"]),
      thread_id: z.string().optional().describe("Required for every action except list."),
      message: z.string().optional().describe("For reply: your answer to GLM's question, or a follow-up instruction."),
      wait_seconds: z.number().int().min(0).max(1800).optional().describe("For wait (default 600) and for a non-background reply."),
      background: z.boolean().optional().describe("For reply: return immediately instead of waiting. Default false."),
      format: z.enum(["concise", "detailed"]).optional().describe("detailed (default) includes the diff when a run has finished."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ action, thread_id, message, wait_seconds, background = false, format = "detailed" }, extra) => {
    const text = (t) => ({ content: [{ type: "text", text: clip(t) }] });
    const err = (t) => ({ isError: true, content: [{ type: "text", text: t }] });
    try {
      if (action === "list") {
        const rows = listThreads(25).map((t) => {
          const job = jobOf(t.id);
          const state = job ? job.state : t.pending_question ? "waiting_for_orchestrator" : "idle";
          return `- ${t.id} | ${state} | ${t.updated} | ${t.title}${t.pending_question ? `\n    QUESTION: ${t.pending_question}` : ""}\n    dir: ${t.root}`;
        });
        return text(rows.length ? `GLM threads (newest first):\n${rows.join("\n")}` : "No GLM threads yet.");
      }
      if (!thread_id) return err(`glm_thread ${action} needs thread_id.`);
      const thread = loadThread(thread_id);
      const job = jobOf(thread_id);

      if (action === "status" || action === "wait") {
        const j = action === "wait" ? await waitJob(thread_id, wait_seconds ?? 600) : job;
        const live = jobStatusText(j, format);
        if (live) return text(live);
        const q = thread.pendingAskId ? lastQuestion(thread) : null;
        return text(`[GLM thread] ${thread_id} | state=${q ? "waiting_for_orchestrator" : "idle"} (no run in this server session) | dir=${thread.root}\n` +
          `title: ${thread.title}\nruns: ${(thread.runs || []).length}, last update ${thread.updated}` +
          (q ? `\n\n=== GLM IS WAITING FOR YOU ===\nQuestion: ${q}\nAnswer with action:"reply".` : ""));
      }
      if (action === "cancel") {
        return text(cancelJob(thread_id) ? `Cancel requested for ${thread_id}; it stops after the current step. Check with action:"status".` : `Thread ${thread_id} is not running.`);
      }
      if (action === "history") {
        const lines = [];
        for (const m of thread.messages) {
          const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
          for (const p of parts) {
            if (p.type === "text" && p.text) lines.push(`${m.role === "assistant" ? "GLM" : "ORCHESTRATOR/RESULT"}: ${p.text.slice(0, 1500)}`);
            else if (p.type === "tool_use") lines.push(`GLM -> ${p.name} ${JSON.stringify(p.input).slice(0, 200)}`);
            else if (p.type === "tool_result") lines.push(`   <- ${String(typeof p.content === "string" ? p.content : JSON.stringify(p.content)).slice(0, 300)}`);
          }
        }
        return text(`[GLM thread history] ${thread_id}\n${lines.join("\n")}`);
      }
      if (action === "reply") {
        if (!message) return err("reply needs message.");
        if (job && job.state === "running") return err(`Thread ${thread_id} is still running; wait for it or cancel it first.`);
        const j = launch({ task: message, thread_id, model: job?.model || "auto" });
        if (background) return text(`[GLM agent] reply sent; thread ${thread_id} resumed in background. Check with action:"status" or "wait".`);
        const onProgress = makeProgress(extra);
        const relay = setInterval(() => { const p = j.progress[j.progress.length - 1]; if (p) onProgress(p); }, 2000);
        try { await waitJob(thread_id, wait_seconds ?? 1800); } finally { clearInterval(relay); }
        return text(jobStatusText(j, format));
      }
      return err(`unknown action ${action}`);
    } catch (e) {
      return err(`glm_thread ${action} failed: ${e.message}`);
    }
  }
);

// ----------------------------- glm_recommend -----------------------------
server.registerTool(
  "glm_recommend",
  {
    title: "Recommend GLM vs Opus for a task",
    description:
      "Free local advisory (no GLM call): given a task profile, returns GLM-vs-Opus, model, " +
      "confidence, and reasons. Call when unsure which engine to use.",
    inputSchema: {
      task_type: z.enum(TASK_TYPES).optional().describe("Closest task category. Default 'general'."),
      complexity: z.enum(["low", "medium", "high"]).optional().describe("Default 'medium'."),
      sensitive: z.boolean().optional().describe("True if proprietary/security-critical (forces Opus)."),
      needs_parallel: z.boolean().optional().describe("True if it needs several concurrent agents (forces Opus)."),
      long_horizon: z.boolean().optional().describe("True if many sequential steps / multi-hour autonomy."),
      latency_sensitive: z.boolean().optional().describe("True if a tight interactive loop (forces Opus)."),
      vision: z.boolean().optional().describe("True if input includes images/screenshots/GUI/computer-use (forces Opus)."),
      input_tokens: z.number().int().optional().describe("Approx context size needed. >128K forces Opus (GLM degrades past ~100K)."),
      steps: z.number().int().optional().describe("Approx number of dependent sequential steps. >20 forces Opus (goal drift)."),
      tool_pattern: z.enum(["none", "single", "fanout", "heavy"]).optional().describe("Tool-use shape: single one-shot call / short independent fanout (GLM-ok) vs heavy dependent agentic loop (forces Opus)."),
      unfamiliar_api: z.boolean().optional().describe("True if it uses a niche/post-cutoff/internal API GLM can't know (-2; paste docs or use Opus)."),
      chinese: z.boolean().optional().describe("True if Chinese or Chinese-English bilingual (GLM strength, +1)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ task_type, complexity, sensitive, needs_parallel, long_horizon, latency_sensitive, vision, input_tokens, steps, tool_pattern, unfamiliar_api, chinese }) => {
    const now = new Date();
    const rec = recommend(
      {
        taskType: task_type,
        complexity,
        sensitive,
        needsParallel: needs_parallel,
        longHorizon: long_horizon,
        latencySensitive: latency_sensitive,
        vision,
        inputTokens: input_tokens,
        steps,
        toolPattern: tool_pattern,
        unfamiliarApi: unfamiliar_api,
        chinese,
      },
      now
    );
    const body = {
      decision: rec.engine.toUpperCase(),
      glm_model: rec.engine === "glm" ? rec.model : null,
      confidence: rec.confidence,
      peak_now: isPeak(now),
      china_hour: chinaHour(now),
      reasons: rec.reasons,
    };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  }
);

// ----------------------------- glm_status -----------------------------
server.registerTool(
  "glm_status",
  {
    title: "GLM status & config",
    description:
      "Free local status: peak window, active model, GLM usage ledger (proof of GLM tokens spent), and config health. No GLM call.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const now = new Date();
    const status = {
      china_hour: chinaHour(now),
      peak_now: isPeak(now),
      flagship_multiplier: `${peakMultiplier(now)}x`,
      auto_model_now: resolveModel("auto", now),
      reasoning: { effort: effortConfig.effort, sent_as: effortConfig.fields, thinking: effortConfig.thinking },
      models: { offpeak: MODELS.OFFPEAK_MODELS.join(", "), peak: MODELS.PEAK_MODELS.join(", "), cheap: MODELS.CHEAP_MODEL },
      base_url: config.BASE_URL,
      api_key_loaded: config.hasKey,
      max_concurrent: config.MAX_CONCURRENT,
      glm_usage_ledger: usageSummary(),
      use_haiku_subagent: USE_HAIKU,
      delegate_tool: DELEGATE_ENABLED ? "on (GLM_DELEGATE=on)" : "off (default; glm_agent covers text-only tasks too — set GLM_DELEGATE=on to expose glm_delegate)",
      orchestration: USE_HAIKU
        ? "Haiku `glm` subagent allowed (spends some Claude tokens to orchestrate)."
        : "Direct GLM only (GLM_USE_HAIKU=off) -> call glm_agent directly; keeps all tokens on GLM.",
      max_tokens: {
        default_mode: "auto (uncapped/generous unless GLM_CAP=on)",
        cap_enabled: MAXTOK.capEnabled,
        default_per_call: resolveMaxTokens(undefined),
        cap_value_when_on: MAXTOK.capValue,
        hard_ceiling: MAXTOK.uncappedMax,
      },
      note: config.hasKey
        ? "Ready."
        : "No API key loaded -- set GLM_API_KEY in glm-mcp/.env or .mcp.json env before delegating.",
    };
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

// ----------------------------- glm_quota -----------------------------
// Kept apart from glm_status: that tool is free and local, this one calls Z.ai. No field is shared.
const readQuota = createQuotaReader({ apiKey: resolveApiKey() });
server.registerTool(
  "glm_quota",
  {
    title: "GLM Coding Plan quota",
    description:
      "The Z.ai GLM Coding Plan quota: the 5-hour and weekly windows (limit, used, remaining, percent, resetsAt) and the plan level. " +
      "Answers from a ~60 s cache unless fresh is true. Never fails the call: an upstream problem returns ok:false with a short reason and the last good reading.",
    inputSchema: { fresh: z.boolean().optional().describe("Bypass the ~60 s cache and ask Z.ai now.") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ fresh } = {}) => {
    const result = await readQuota({ fresh: fresh === true });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

function clip(s) {
  return s.length > CHARACTER_LIMIT ? s.slice(0, CHARACTER_LIMIT) + "\n…[truncated to fit context]" : s;
}

const transport = new StdioServerTransport();
await server.connect(transport);
