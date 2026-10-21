#!/usr/bin/env node
// install.mjs -- one-shot installer for the GLM hybrid setup.
// Installs GLM as a cheap, full-capability subagent for Claude Code, with auto-routing.
//
// Usage:
//   node install.mjs                       # install for the current user (global)
//   node install.mjs --key YOUR_ZAI_KEY    # also write the API key into .env
//   node install.mjs --claude-dir PATH     # target a custom .claude dir (default ~/.claude)
//   node install.mjs --no-register         # skip `claude mcp add` (do it manually)
//   node install.mjs --skip-npm            # skip `npm install` (deps already present)
//
// It is idempotent: re-running updates files without duplicating hook/policy entries.

import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const SELF = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getFlag = (n) => args.includes(n);
const getOpt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const CLAUDE = getOpt("--claude-dir") || join(homedir(), ".claude");
const KEY = getOpt("--key") || process.env.GLM_API_KEY || "";
const NO_REGISTER = getFlag("--no-register");
const SKIP_NPM = getFlag("--skip-npm");

const log = (s) => console.log(s);
const step = (s) => console.log(`\n→ ${s}`);

log(`GLM hybrid installer`);
log(`  source : ${SELF}`);
log(`  target : ${CLAUDE}`);

// 1. Copy the MCP server (skip node_modules and any stray .env).
step("Installing MCP server -> " + join(CLAUDE, "glm-mcp"));
mkdirSync(CLAUDE, { recursive: true });
cpSync(join(SELF, "glm-mcp"), join(CLAUDE, "glm-mcp"), {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop();
    return base !== "node_modules" && base !== ".env" && base !== "threads" && base !== "usage.jsonl";
  },
});
// Docs the global CLAUDE.md policy points at.
mkdirSync(join(CLAUDE, "glm-mcp", "docs"), { recursive: true });
copyFileSync(join(SELF, "README.md"), join(CLAUDE, "glm-mcp", "README.md"));
for (const d of ["RULES.md", "ORCHESTRATION.md"]) copyFileSync(join(SELF, "docs", d), join(CLAUDE, "glm-mcp", "docs", d));

// 2. .env
step("Setting up .env");
const envPath = join(CLAUDE, "glm-mcp", ".env");
if (!existsSync(envPath)) {
  copyFileSync(join(CLAUDE, "glm-mcp", ".env.example"), envPath);
  log("  created .env from .env.example");
}
if (KEY) {
  let env = readFileSync(envPath, "utf8");
  env = /^GLM_API_KEY=/m.test(env)
    ? env.replace(/^GLM_API_KEY=.*$/m, `GLM_API_KEY=${KEY}`)
    : `GLM_API_KEY=${KEY}\n` + env;
  writeFileSync(envPath, env);
  log("  wrote GLM_API_KEY into .env");
} else if (!/^GLM_API_KEY=\S+/m.test(readFileSync(envPath, "utf8"))) {
  log("  ⚠ No API key set yet. Edit " + envPath + " and set GLM_API_KEY=... before use.");
}
try { chmodSync(envPath, 0o600); log("  .env permissions set to 600"); } catch {}

// 3. npm install
if (!SKIP_NPM) {
  step("Installing dependencies (npm install)");
  execSync("npm install --no-audit --no-fund", { cwd: join(CLAUDE, "glm-mcp"), stdio: "inherit" });
}

// 4. Subagent + hook
step("Installing subagent and auto-delegation hook");
mkdirSync(join(CLAUDE, "agents"), { recursive: true });
mkdirSync(join(CLAUDE, "hooks"), { recursive: true });
copyFileSync(join(SELF, "agents", "glm.md"), join(CLAUDE, "agents", "glm.md"));
copyFileSync(join(SELF, "hooks", "glm_subagent_router.mjs"), join(CLAUDE, "hooks", "glm_subagent_router.mjs"));
log("  agents/glm.md, hooks/glm_subagent_router.mjs");

// 4b. Optional full-GLM launcher (`glm-code`) — runs the whole session on GLM (~100% GLM, no Opus).
try {
  copyFileSync(join(SELF, "glm-code.mjs"), join(CLAUDE, "glm-code.mjs"));
  writeFileSync(join(CLAUDE, "glm-code.cmd"), '@echo off\r\nnode "%~dp0glm-code.mjs" %*\r\n');
  writeFileSync(join(CLAUDE, "glm-code"), '#!/bin/sh\nexec node "$(dirname "$0")/glm-code.mjs" "$@"\n');
  log("  glm-code launcher (full-GLM mode) -> run: node ~/.claude/glm-code.mjs");
} catch {}

// 5. Merge the PreToolUse hook into settings.json (idempotent, with backup).
step("Wiring the hook into settings.json");
const settingsPath = join(CLAUDE, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
  writeFileSync(settingsPath + ".bak-" + Date.now(), readFileSync(settingsPath));
}
const hookCmd = `node "${join(CLAUDE, "hooks", "glm_subagent_router.mjs").replace(/\\/g, "/")}"`;
settings.hooks ||= {};
settings.hooks.PreToolUse ||= [];
const already = settings.hooks.PreToolUse.some((e) =>
  (e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("glm_subagent_router"))
);
// The subagent tool is "Agent" in current Claude Code builds and "Task" in older ones.
const MATCHER = "Task|Agent";
if (!already) {
  settings.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [{ type: "command", command: hookCmd }] });
  log(`  added PreToolUse(${MATCHER}) -> glm_subagent_router`);
} else {
  for (const e of settings.hooks.PreToolUse) {
    if ((e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("glm_subagent_router")) && e.matcher !== MATCHER) {
      log(`  updated hook matcher ${e.matcher} -> ${MATCHER}`);
      e.matcher = MATCHER;
    }
  }
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

// 6. Global delegation policy, between markers so re-installs replace it (idempotent).
step("Writing the global delegation policy into CLAUDE.md");
const claudeMd = join(CLAUDE, "CLAUDE.md");
const START = "<!-- glm-mcp:policy:start -->", END = "<!-- glm-mcp:policy:end -->";
const policy = readFileSync(join(SELF, "docs", "CLAUDE-policy.md"), "utf8").trim();
const block = `${START}\n${policy}\n${END}`;
let md = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
if (existsSync(claudeMd)) writeFileSync(claudeMd + ".bak-" + Date.now(), md);
if (md.includes(START) && md.includes(END)) {
  md = md.slice(0, md.indexOf(START)) + block + md.slice(md.indexOf(END) + END.length);
  log("  policy block replaced");
} else if (/^# Delegation \(GLM hybrid\)/m.test(md)) {
  // pre-1.4 install: the unmarked block runs from its heading to the next top-level heading or EOF
  const i = md.search(/^# Delegation \(GLM hybrid\)/m);
  const rest = md.slice(i + 1);
  const j = rest.search(/^# (?!#)/m);
  md = md.slice(0, i) + block + "\n" + (j >= 0 ? rest.slice(j) : "");
  log("  pre-1.4 policy block replaced");
} else {
  md = md.replace(/\s*$/, "\n\n") + block + "\n";
  log("  policy appended");
}
writeFileSync(claudeMd, md);

// 7. Register the MCP server (user scope) via the claude CLI.
if (!NO_REGISTER) {
  step("Registering MCP server with Claude Code (user scope)");
  const idx = join(CLAUDE, "glm-mcp", "src", "index.js").replace(/\\/g, "/");
  try {
    try { execSync("claude mcp remove glm -s user", { stdio: "ignore" }); } catch {}
    execSync(`claude mcp add glm -s user -- node "${idx}"`, { stdio: "inherit" });
    log("  registered (key is read from .env).");
  } catch (e) {
    log("  ⚠ Could not run `claude mcp add` (" + e.message + ").");
    log("  Register manually:");
    log(`    claude mcp add glm -s user -- node "${idx}"`);
  }
}

log("\n✅ Done. Next steps:");
log("  1. Ensure GLM_API_KEY is set in " + envPath);
log("  2. RESTART Claude Code, then run `glm_status` to verify (api_key_loaded: true).");
log("  3. Your main agent stays on whatever model Claude Code uses; GLM handles delegated subtasks.");
