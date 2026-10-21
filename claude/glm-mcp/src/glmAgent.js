// glmAgent.js
// Runs GLM as a real tool-using agent against the local filesystem, with oversight built in so
// the orchestrator (Claude) can regulate, converse with, and see exactly what GLM did:
//   - returns a unified DIFF of every change (isolated to the files GLM touched)
//   - returns an ACTION LOG of every read/write/edit/bash, including refused ones
//   - records a non-invasive git checkpoint + a per-file revert hint (when in a git repo)
//   - supports dry_run: GLM proposes changes to an in-memory overlay and writes NOTHING
//   - injects the repo's AGENTS.md / CLAUDE.md and a CodeGraph-first working method
//   - passes every shell command through the orchestrator's own PreToolUse Bash hooks
//   - refuses credential paths and strips API keys from the shell environment
//   - keeps a persistent thread: GLM can ask_orchestrator a question and pause; the
//     orchestrator answers by continuing the thread (see threads.js)

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { glmMessage } from "./glmClient.js";
import { deniedPath, deniedCommand, scrubbedEnv, guardBash, loadRepoRules } from "./guards.js";
import { newThread, loadThread, saveThread } from "./threads.js";

const MAX_ITERS = parseInt(process.env.GLM_AGENT_MAX_ITERS || "30", 10);
const BASH_TIMEOUT = parseInt(process.env.GLM_AGENT_BASH_TIMEOUT_MS || "120000", 10);
const FILE_READ_CAP = 100000;
const BASH_OUT_CAP = 30000;
const DIFF_CAP = 20000;
const DIFF_LINE_CAP = 3000;

const TOOLS = [
  { name: "read_file", description: "Read a UTF-8 text file (path relative to working dir or absolute).",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file. Creates parent dirs as needed.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace an exact substring in a file. old_string must appear exactly once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } },
  { name: "list_dir", description: "List entries in a directory (relative or absolute). Defaults to '.'.",
    input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "run_bash", description: "Run a shell command in the working dir; returns stdout+stderr and the exit code. Disabled in dry_run. Commands pass through the orchestrator's safety hooks; a refused command returns BLOCKED with the reason.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "ask_orchestrator", description: "Pause and ask the orchestrating agent one precise question: when blocked (including a BLOCKED command you need run or approved), when a decision is not yours to make, or when the brief is ambiguous. The answer arrives when the orchestrator continues this thread.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
];

function safeResolve(root, p) {
  return isAbsolute(p || "") ? resolve(p) : resolve(root, p || ".");
}

function unifiedDiff(oldStr, newStr, path) {
  if (oldStr === newStr) return "";
  const A = oldStr.length ? oldStr.split("\n") : [];
  const B = newStr.length ? newStr.split("\n") : [];
  if (A.length > DIFF_LINE_CAP || B.length > DIFF_LINE_CAP) {
    return `--- ${path}\n+++ ${path}\n@@ large file: ${A.length} -> ${B.length} lines (detailed diff omitted) @@\n`;
  }
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push([" ", A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(["-", A[i]]); i++; }
    else { rows.push(["+", B[j]]); j++; }
  }
  while (i < n) rows.push(["-", A[i++]]);
  while (j < m) rows.push(["+", B[j++]]);
  const out = [`--- ${path}`, `+++ ${path}`];
  let ctx = [];
  const flush = () => {
    if (ctx.length > 6) {
      out.push(" " + ctx[0], " " + ctx[1], `@@ ... ${ctx.length - 4} unchanged ... @@`, " " + ctx[ctx.length - 2], " " + ctx[ctx.length - 1]);
    } else for (const c of ctx) out.push(" " + c);
    ctx = [];
  };
  for (const [t, l] of rows) {
    if (t === " ") ctx.push(l);
    else { flush(); out.push(t + l); }
  }
  flush();
  return out.join("\n") + "\n";
}

function gitCheckpoint(root) {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    return { isRepo: false, baseline: null, revertHint: "Not a git repo — review the diff below; revert manually if needed." };
  }
  let baseline = "";
  try { baseline = execFileSync("git", ["-C", root, "stash", "create"], { encoding: "utf8" }).trim(); } catch {}
  if (!baseline) {
    try { baseline = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  }
  return {
    isRepo: true,
    baseline,
    revertHint: baseline
      ? `Baseline ${baseline}. To revert only GLM's edits: \`git -C "${root}" checkout ${baseline} -- <changed files>\`, and delete the files marked (new file). Never run \`git clean\` in a shared checkout.`
      : "Git repo detected but baseline capture failed; use `git diff` to review and revert.",
  };
}

function systemPrompt(root, dryRun, repo) {
  return (
    `You are a capable coding agent working directly in a local repository for an orchestrating agent (Claude) that plans the work and reviews everything you change.\n` +
    `Working directory: ${root}\n` +
    (dryRun
      ? `DRY RUN: write_file/edit_file are STAGED, not written to disk, and run_bash is disabled. Produce the complete set of intended changes, then stop and summarize them.\n`
      : `Make the changes yourself with the tools, and run tests/builds to verify them.\n`) +
    `\nHow to work:\n` +
    (repo.indexed
      ? `- This repository is indexed by CodeGraph. BEFORE grep/find or reading whole files, run \`codegraph explore "<symbol names or a question>"\` via run_bash: it returns the relevant symbols' line-numbered source, the call paths between them, and a blast-radius list of every reader. Trust it. In a git worktree it may answer from the main checkout and say so; then read the changed files directly.\n`
      : `- If the repository has a .codegraph/ directory, run \`codegraph explore "<symbols>"\` via run_bash before grep/find.\n`) +
    `- Before changing a value, enumerate every reader of it (CodeGraph's blast radius or a repo-wide grep) and update or check each one.\n` +
    `- Follow the repository rules below exactly; they override your own habits.\n` +
    `- Run the smallest relevant test first. Report exact commands with their exit codes; never trust the exit code of a piped command.\n` +
    `- A BLOCKED command was refused by the orchestrator's safety hooks. Do not try to work around it. If the task needs it, call ask_orchestrator and explain why.\n` +
    `- Credential files (.env, keys, tokens) are off-limits and are refused.\n` +
    `- If the brief is ambiguous or a decision is not yours to make, call ask_orchestrator with one precise question instead of guessing.\n` +
    `- When done, stop calling tools and reply with: files changed, how you verified (commands + exit codes), what you deliberately left out, and what the reviewer should check.\n` +
    (repo.rules ? `\n===== REPOSITORY RULES (${repo.top}) =====\n${repo.rules}\n` : "")
  );
}

/**
 * Run (or continue) GLM as an agent.
 * Pass threadId to continue an existing thread: `task` is then the orchestrator's follow-up, or
 * its answer to the question GLM asked.
 */
export async function runGlmAgent({ model, task, context, workdir, threadId, title, maxTokens = 131072, thinking = false, dryRun = false, onProgress, signal, messageFn = glmMessage }) {
  let thread = threadId ? loadThread(threadId) : null;
  if (thread && workdir && resolve(workdir) !== thread.root) throw new Error(`thread ${threadId} belongs to ${thread.root}, not ${resolve(workdir)}`);
  const root = thread ? thread.root : (workdir && workdir.trim() ? resolve(workdir) : process.cwd());
  if (!thread) thread = newThread(root, title || String(task).split("\n")[0].slice(0, 100));
  const repo = loadRepoRules(root);
  const log = [];
  const originals = new Map();
  const overlay = new Map();
  const checkpoint = dryRun ? { isRepo: false, baseline: null, revertHint: "dry_run: nothing written." } : gitCheckpoint(root);
  let question = null;

  const recordOriginal = (abs) => {
    if (!originals.has(abs)) {
      try { originals.set(abs, readFileSync(abs, "utf8")); } catch { originals.set(abs, null); }
    }
  };
  const readCurrent = (abs) => (dryRun && overlay.has(abs) ? overlay.get(abs) : readFileSync(abs, "utf8"));
  const writeCurrent = (abs, content) => {
    if (dryRun) { overlay.set(abs, content); return; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  const refuse = (abs, what) => { log.push(`REFUSED ${what} ${abs}`); return `ERROR: ${what} of ${abs} refused: credential path. Do not retry.`; };

  function runTool(name, input) {
    try {
      switch (name) {
        case "read_file": {
          const abs = safeResolve(root, input.path);
          if (deniedPath(abs)) return refuse(abs, "read");
          const txt = readCurrent(abs);
          log.push(`read ${relative(root, abs) || input.path}`);
          return txt.length > FILE_READ_CAP ? txt.slice(0, FILE_READ_CAP) + "\n…[truncated]" : txt;
        }
        case "write_file": {
          const abs = safeResolve(root, input.path);
          if (deniedPath(abs)) return refuse(abs, "write");
          recordOriginal(abs);
          writeCurrent(abs, input.content ?? "");
          log.push(`${dryRun ? "[dry] " : ""}write ${relative(root, abs) || input.path}`);
          return `${dryRun ? "(dry_run, staged) " : ""}Wrote ${(input.content ?? "").length} chars to ${input.path}.`;
        }
        case "edit_file": {
          const abs = safeResolve(root, input.path);
          if (deniedPath(abs)) return refuse(abs, "edit");
          let cur;
          try { cur = readCurrent(abs); } catch { return `ERROR: cannot read ${input.path} to edit.`; }
          const occ = cur.split(input.old_string).length - 1;
          if (occ === 0) return `ERROR: old_string not found in ${input.path}. Read the file and retry with an exact match.`;
          if (occ > 1) return `ERROR: old_string appears ${occ} times in ${input.path}; add surrounding lines to make it unique.`;
          recordOriginal(abs);
          writeCurrent(abs, cur.replace(input.old_string, () => input.new_string));
          log.push(`${dryRun ? "[dry] " : ""}edit ${relative(root, abs) || input.path}`);
          return `${dryRun ? "(dry_run, staged) " : ""}Edited ${input.path} (1 replacement).`;
        }
        case "list_dir": {
          const abs = safeResolve(root, input.path || ".");
          if (deniedPath(abs)) return refuse(abs, "list");
          const entries = readdirSync(abs).map((e) => {
            try { return statSync(join(abs, e)).isDirectory() ? e + "/" : e; } catch { return e; }
          });
          return entries.join("\n") || "(empty)";
        }
        case "run_bash": {
          const cmd = String(input.command || "");
          if (dryRun) return `[dry_run] bash disabled. Use read_file/list_dir to inspect. (cmd was: ${cmd})`;
          if (deniedCommand(cmd)) {
            log.push(`BLOCKED bash (credentials/env): ${cmd.slice(0, 100)}`);
            return "BLOCKED: the command touches credentials or dumps the environment. Do not retry; use ask_orchestrator if the task needs it.";
          }
          const g = guardBash(cmd, root, repo.top);
          if (g.blocked) {
            log.push(`BLOCKED bash: ${cmd.slice(0, 100)} — ${g.reason}`);
            return `BLOCKED by the orchestrator's safety hook: ${g.reason}. Do not work around it; use ask_orchestrator if the task needs it.`;
          }
          log.push(`bash: ${cmd.slice(0, 100)}`);
          let out;
          try {
            out = execSync(cmd, { cwd: root, timeout: BASH_TIMEOUT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash", env: scrubbedEnv() });
            out = `${out}\n[exit 0]`;
          } catch (e) {
            out = `${e.stdout || ""}${e.stderr || ""}\n[exit ${e.status ?? "?"}] ${e.message}`;
          }
          return out.length > BASH_OUT_CAP ? out.slice(0, BASH_OUT_CAP) + "\n…[truncated]" : out;
        }
        case "ask_orchestrator": {
          question = String(input.question || "").trim() || "(empty question)";
          log.push(`ASK: ${question.slice(0, 100)}`);
          return "Question sent to the orchestrator.";
        }
        default:
          return `ERROR: unknown tool ${name}`;
      }
    } catch (e) {
      return `ERROR (${name}): ${e.message}`;
    }
  }

  const system = systemPrompt(root, dryRun, repo);
  const userText = context ? `${task}\n\n--- CONTEXT ---\n${context}` : String(task);
  if (thread.pendingAskId) {
    thread.messages.push({ role: "user", content: [
      ...(thread.pendingResults || []),
      { type: "tool_result", tool_use_id: thread.pendingAskId, content: `Orchestrator's answer: ${userText}` },
    ] });
  } else if (thread.messages.length) {
    const followUp = `Follow-up from the orchestrator:\n${userText}`;
    const last = thread.messages[thread.messages.length - 1];
    if (last.role === "user") {
      // e.g. a run that hit the iteration cap ends on tool_results; keep roles alternating.
      last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), { type: "text", text: followUp }];
    } else {
      thread.messages.push({ role: "user", content: followUp });
    }
  } else {
    thread.messages.push({ role: "user", content: userText });
  }
  thread.pendingAskId = null;
  thread.pendingResults = null;
  const messages = thread.messages;

  let lastText = "";
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  let iters = 0;
  let cancelled = false;
  const emit = (msg) => { if (onProgress) { try { onProgress(msg, iters, MAX_ITERS); } catch {} } };

  try {
    for (; iters < MAX_ITERS; iters++) {
      if (signal?.aborted) { cancelled = true; break; }
      const baseOut = totalUsage.output_tokens;
      emit(`iter ${iters + 1}/${MAX_ITERS} — GLM generating…`);
      let raw, usage;
      try {
        ({ raw, usage } = await messageFn({
          model, system, messages, maxTokens, thinking, tools: TOOLS, signal,
          onToken: (outTok, tps) => emit(`iter ${iters + 1}/${MAX_ITERS} · ${baseOut + outTok} tok · ${tps} tok/s`),
        }));
      } catch (e) {
        if (e && e.cancelled) { cancelled = true; break; }
        throw e;
      }
      totalUsage.input_tokens += usage.input_tokens || 0;
      totalUsage.output_tokens += usage.output_tokens || 0;
      const content = raw.content || [];
      const textParts = content.filter((b) => b.type === "text").map((b) => b.text);
      if (textParts.length) lastText = textParts.join("\n").trim();
      const toolUses = content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content });
      if (raw.stop_reason !== "tool_use" || toolUses.length === 0) break;
      const results = [];
      let askId = null;
      for (const tu of toolUses) {
        const out = String(runTool(tu.name, tu.input || {}));
        if (tu.name === "ask_orchestrator" && !askId) { askId = tu.id; continue; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      if (askId) {
        // Pause. The orchestrator's answer becomes the ask's tool_result on resume, sent together
        // with the results of any sibling tool calls from this turn.
        thread.pendingAskId = askId;
        thread.pendingResults = results;
        emit(`waiting for orchestrator: ${question}`);
        break;
      }
      messages.push({ role: "user", content: results });
      emit(`iter ${iters + 1}/${MAX_ITERS} · ${log.slice(-toolUses.length).join(", ") || toolUses.map((t) => t.name).join(", ")}`);
    }
  } finally {
    // A run that stops between a tool_use and its result (cancel, error, cap) cannot be resumed
    // with that dangling turn; drop it so the thread stays valid.
    const last = messages[messages.length - 1];
    if (!thread.pendingAskId && last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use")) {
      messages.pop();
    }
    thread.runs = thread.runs || [];
    thread.runs.push({ at: new Date().toISOString(), iters, usage: totalUsage, question, cancelled });
    saveThread(thread);
  }

  let diff = "";
  for (const [abs, orig] of originals) {
    let now;
    if (dryRun) now = overlay.has(abs) ? overlay.get(abs) : orig ?? "";
    else now = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const d = unifiedDiff(orig ?? "", now ?? "", relative(root, abs) || abs);
    if (d) diff += (orig == null ? `(new file)\n` : "") + d + "\n";
  }
  if (diff.length > DIFF_CAP) diff = diff.slice(0, DIFF_CAP) + "\n…[diff truncated]";

  return {
    text: cancelled
      ? (lastText ? lastText + "\n\n(cancelled mid-run — partial work above; changes so far are in the diff and can be reverted.)" : "(cancelled before GLM produced output — no changes.)")
      : lastText || (question ? "(GLM paused to ask a question)" : "(GLM finished without a summary)"),
    question,
    threadId: thread.id,
    rulesLoaded: Boolean(repo.rules),
    codegraphIndexed: repo.indexed,
    actions: log,
    iters,
    hitCap: iters >= MAX_ITERS && !question,
    cancelled,
    usage: totalUsage,
    root,
    dryRun,
    diff: diff.trim(),
    changedFiles: [...originals.keys()].map((a) => relative(root, a) || a),
    git: checkpoint,
  };
}
