// The router hook honours the GLM delegation switch (~/.claude/glm-mode, here GLM_MODE_FILE).
// Runs the real hook as Claude Code does: JSON on stdin, advice (or nothing) on stdout.
// Run: node --test claude/glm-mcp/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "glm_subagent_router.mjs");
const DIR = mkdtempSync(join(tmpdir(), "glm-mode-"));
// A spawn the router would advise on: hands-on repo work it rates GLM-suitable.
const PAYLOAD = JSON.stringify({
  tool_name: "Agent",
  cwd: "/repo",
  tool_input: { subagent_type: "general-purpose", description: "Write unit tests", prompt: "Write unit tests for the parser module." },
});

function runHook(modeContent) {
  const file = join(DIR, `mode-${Math.random().toString(36).slice(2)}`);
  if (modeContent !== null) writeFileSync(file, modeContent);
  const env = { ...process.env, GLM_MODE_FILE: file };
  delete env.GLM_API_KEY;
  return execFileSync(process.execPath, [HOOK], { input: PAYLOAD, env, encoding: "utf8" });
}

test("on, missing and unrecognised content all keep today's advice", () => {
  for (const content of ["on", "on\n", null, "", "maybe", "of"]) {
    const out = runHook(content);
    assert.match(out, /\[GLM router\]/, `content ${JSON.stringify(content)} must keep the advice`);
    assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, "PreToolUse");
  }
});

test("off silences the hook completely, so the Agent call passes as normal", () => {
  for (const content of ["off", "off\n", "  OFF  ", "Off"]) {
    assert.equal(runHook(content), "", `content ${JSON.stringify(content)} must produce no output`);
  }
});
