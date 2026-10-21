// Offline tests for the orchestration layer: guards, hook parity, and the ask/reply thread loop.
// No GLM key needed: the agent loop runs against a scripted fake GLM.
// Run: node --test claude/glm-mcp/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SANDBOX = mkdtempSync(join(tmpdir(), "glm-orch-"));
const FAKE_HOME = join(SANDBOX, "home");
const REPO = join(SANDBOX, "repo");
process.env.GLM_GUARD_HOME = FAKE_HOME;
process.env.GLM_THREADS_DIR = join(SANDBOX, "threads");
process.env.GLM_API_KEY = "test-not-used";

// A fake home with one global Bash guard (exit 2 on "git reset --hard"), and a repo whose own
// settings add a JSON-deny guard (on "db push") and a catch-all telemetry hook that must be skipped.
mkdirSync(join(FAKE_HOME, ".claude", "hooks"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".claude", "hooks", "g.sh"),
  `#!/bin/bash\ninput=$(cat)\ncase "$input" in *"git reset --hard"*) echo "git reset --hard is not allowed" >&2; exit 2;; esac\nexit 0\n`);
writeFileSync(join(FAKE_HOME, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [
  { matcher: "Bash", hooks: [{ type: "command", command: `bash "${join(FAKE_HOME, ".claude", "hooks", "g.sh")}"` }] },
  { matcher: "*", hooks: [{ type: "command", command: `touch "${join(SANDBOX, "catchall-ran")}"` }] },
] } }));
mkdirSync(join(REPO, ".claude", "hooks"), { recursive: true });
execFileSync("git", ["init", "-q", REPO]);
writeFileSync(join(REPO, ".claude", "hooks", "db.sh"),
  `#!/bin/bash\ninput=$(cat)\ncase "$input" in *"db push"*) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"db push is refused"}}';; esac\nexit 0\n`);
writeFileSync(join(REPO, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [
  { matcher: "Bash", hooks: [{ type: "command", command: "bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/db.sh" }] },
] } }));
writeFileSync(join(REPO, "AGENTS.md"), "# Repo rules\nAlways write tests first.\n");
writeFileSync(join(REPO, "CLAUDE.md"), "@AGENTS.md\n");
writeFileSync(join(REPO, "app.txt"), "value = 1\n");
writeFileSync(join(REPO, ".env"), "SECRET=shh\n");
execFileSync("git", ["-C", REPO, "add", "."]);
execFileSync("git", ["-C", REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

const guards = await import("../src/guards.js");
const { runGlmAgent } = await import("../src/glmAgent.js");
const { loadThread } = await import("../src/threads.js");

test("credential paths are refused, ordinary ones are not", () => {
  assert.equal(guards.deniedPath(join(REPO, ".env")), true);
  assert.equal(guards.deniedPath(join(REPO, ".env.local")), true);
  assert.equal(guards.deniedPath(join(REPO, ".env.example")), false);
  assert.equal(guards.deniedPath(join(FAKE_HOME, ".ssh", "config")), true);
  assert.equal(guards.deniedPath(join(FAKE_HOME, ".claude.json")), true);
  assert.equal(guards.deniedPath(join(REPO, "keys", "id_ed25519")), true);
  assert.equal(guards.deniedPath(join(REPO, "keys", "id_ed25519.pub")), false);
  assert.equal(guards.deniedPath(join(REPO, "src", "app.ts")), false);
});

test("credential and env-dump commands are refused, ordinary ones are not", () => {
  for (const c of ["cat .env", "cat ./.env.local", "printenv", "env | grep KEY", "cat ~/.ssh/id_rsa", "security find-generic-password -s x"]) {
    assert.equal(guards.deniedCommand(c), true, c);
  }
  for (const c of ["cp .env.example .env.example.bak", "pnpm test", "node --env-file-if-exists=x app.js", "git status", "codegraph explore \"createApiStore\""]) {
    assert.equal(guards.deniedCommand(c), false, c);
  }
});

test("hook parity: global exit-2 guard and repo JSON-deny guard both refuse; catch-all hooks are skipped", () => {
  const a = guards.guardBash("git reset --hard HEAD", REPO, REPO);
  assert.equal(a.blocked, true);
  assert.match(a.reason, /not allowed/);
  const b = guards.guardBash("pnpm prisma db push", REPO, REPO);
  assert.equal(b.blocked, true);
  assert.match(b.reason, /db push is refused/);
  assert.equal(guards.guardBash("git status", REPO, REPO).blocked, false);
  assert.equal(existsSync(join(SANDBOX, "catchall-ran")), false, "catch-all hook must not run for GLM commands");
});

test("the repo's AGENTS.md reaches GLM's system prompt; an import-only CLAUDE.md is skipped", () => {
  const r = guards.loadRepoRules(REPO);
  assert.match(r.rules, /Always write tests first/);
  assert.doesNotMatch(r.rules, /----- CLAUDE\.md -----/);
});

test("scrubbed env drops keys and tokens", () => {
  process.env.SOME_SERVICE_TOKEN = "x";
  const env = guards.scrubbedEnv();
  assert.equal(env.GLM_API_KEY, undefined);
  assert.equal(env.SOME_SERVICE_TOKEN, undefined);
  assert.ok(env.PATH);
});

// ------------------------------------------------------------ the live loop, with a fake GLM
function fakeGlm(script) {
  const seen = [];
  let i = 0;
  const fn = async ({ system, messages }) => {
    seen.push({ system, messages: JSON.parse(JSON.stringify(messages)) });
    const step = script[i++];
    if (!step) throw new Error("fake GLM ran out of script");
    const content = typeof step === "function" ? step(messages) : step;
    const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    return { raw: { content, stop_reason: stop }, usage: { input_tokens: 10, output_tokens: 5 } };
  };
  fn.seen = seen;
  return fn;
}

test("GLM asks, the run pauses, the orchestrator replies, GLM continues with its history", async () => {
  const fake = fakeGlm([
    [{ type: "text", text: "Need a decision." }, { type: "tool_use", id: "t1", name: "ask_orchestrator", input: { question: "Set value to 2 or 3?" } }],
    (messages) => {
      const last = messages[messages.length - 1];
      const answer = last.content.find((b) => b.tool_use_id === "t1");
      assert.match(answer.content, /use 3/);
      return [{ type: "tool_use", id: "t2", name: "edit_file", input: { path: "app.txt", old_string: "value = 1", new_string: "value = 3" } }];
    },
    [{ type: "text", text: "Done: value = 3." }],
  ]);
  const r1 = await runGlmAgent({ model: "fake", task: "Update the value.", workdir: REPO, messageFn: fake });
  assert.equal(r1.question, "Set value to 2 or 3?");
  assert.equal(r1.changedFiles.length, 0);
  assert.ok(r1.threadId);
  assert.match(fake.seen[0].system, /Always write tests first/, "repo rules in system prompt");
  assert.match(fake.seen[0].system, /ask_orchestrator/);
  assert.ok(loadThread(r1.threadId).pendingAskId, "thread is waiting");

  const r2 = await runGlmAgent({ model: "fake", task: "use 3", threadId: r1.threadId, messageFn: fake });
  assert.equal(r2.question, null);
  assert.equal(readFileSync(join(REPO, "app.txt"), "utf8"), "value = 3\n");
  assert.match(r2.diff, /\+value = 3/);
  assert.equal(loadThread(r1.threadId).pendingAskId, null);
  const mode = statSync(join(process.env.GLM_THREADS_DIR, `${r1.threadId}.json`)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a blocked command and a credential read come back to GLM as refusals, and nothing runs", async () => {
  const fake = fakeGlm([
    [
      { type: "tool_use", id: "a", name: "run_bash", input: { command: "git reset --hard HEAD" } },
      { type: "tool_use", id: "b", name: "read_file", input: { path: ".env" } },
      { type: "tool_use", id: "c", name: "run_bash", input: { command: "cat .env" } },
    ],
    (messages) => {
      const results = messages[messages.length - 1].content;
      assert.match(results.find((x) => x.tool_use_id === "a").content, /BLOCKED by the orchestrator's safety hook/);
      assert.match(results.find((x) => x.tool_use_id === "b").content, /refused: credential path/);
      assert.match(results.find((x) => x.tool_use_id === "c").content, /BLOCKED/);
      assert.doesNotMatch(JSON.stringify(results), /shh/, "the secret never reaches GLM");
      return [{ type: "text", text: "Could not proceed." }];
    },
  ]);
  const r = await runGlmAgent({ model: "fake", task: "Reset and read secrets.", workdir: REPO, messageFn: fake });
  assert.equal(r.actions.filter((a) => /^(BLOCKED|REFUSED)/.test(a)).length, 3);
});

test("a follow-up after a finished run keeps roles alternating", async () => {
  const fake = fakeGlm([
    [{ type: "text", text: "First done." }],
    (messages) => {
      const roles = messages.map((m) => m.role);
      for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], `roles alternate: ${roles}`);
      return [{ type: "text", text: "Second done." }];
    },
  ]);
  const r1 = await runGlmAgent({ model: "fake", task: "One.", workdir: REPO, messageFn: fake });
  const r2 = await runGlmAgent({ model: "fake", task: "Two.", threadId: r1.threadId, messageFn: fake });
  assert.equal(r2.text, "Second done.");
});
