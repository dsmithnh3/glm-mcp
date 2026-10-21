// guards.js -- what keeps glm_agent inside the same rules as the orchestrating Claude session.
//
//   * guardBash(): every run_bash command is passed through the PreToolUse "Bash" hooks Claude
//     Code itself runs (~/.claude/settings.json plus the repo's .claude/settings{,.local}.json),
//     with the same JSON payload, so GLM is refused exactly what the orchestrator is refused.
//   * deniedPath() / deniedCommand(): credential files and env dumps are refused, so secrets are
//     never read into a prompt that leaves this machine.
//   * scrubbedEnv(): API keys and tokens are removed from the environment run_bash inherits.
//   * loadRepoRules(): the repo's AGENTS.md / CLAUDE.md, injected into GLM's system prompt.

import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";

const HOME = process.env.GLM_GUARD_HOME || homedir();
const RULES_CAP = parseInt(process.env.GLM_RULES_CAP || "40000", 10);
const HOOK_TIMEOUT = parseInt(process.env.GLM_HOOK_TIMEOUT_MS || "20000", 10);

const DENY_PATH_RES = [
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/,
  /(^|\/)auth\.json$/,
  /credentials/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(?!\.pub$)[^/]*$/,
  /(^|\/)\.(netrc|npmrc|pypirc)$/,
];
const DENY_PATH_PREFIXES = [
  join(HOME, ".ssh"), join(HOME, ".aws"), join(HOME, ".gnupg"), join(HOME, ".config", "gh"),
  join(HOME, "Library", "Keychains"), join(HOME, ".claude.json"), join(HOME, ".claude", ".credentials.json"),
];

export function deniedPath(abs) {
  if (DENY_PATH_PREFIXES.some((p) => abs === p || abs.startsWith(p + "/"))) return true;
  return DENY_PATH_RES.some((re) => re.test(abs));
}

// Best-effort: catches the obvious ways a shell command reads credentials or dumps the env.
const DENY_BASH_RES = [
  /(^|[\s"'=\/<>])\.env(\.(?!example\b)[\w.-]+)?(?![\w.-])/,
  /\.ssh\//, /\.claude\.json/, /\.aws\//, /\bauth\.json\b/, /\.credentials\.json/,
  /\bsecurity\s+find-(generic|internet)-password\b/,
  /\bprintenv\b/, /(^|[;&|(]\s*)(env|set|export\s+-p|declare\s+-x)\s*($|[;&|)])/,
];
export function deniedCommand(cmd) {
  return DENY_BASH_RES.some((re) => re.test(cmd));
}

export function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(GLM_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN)$/.test(k) ||
        /(_SECRET|_TOKEN|_API_KEY|_PASSWORD|PASSWORD)$/.test(k)) delete env[k];
  }
  return env;
}

export function gitTop(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

export function loadRepoRules(root) {
  const top = gitTop(root) || root;
  const parts = [];
  for (const name of ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md")]) {
    const p = join(top, name);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, "utf8");
    if (/^\s*(#[^\n]*\n\s*)*@AGENTS\.md\s*$/.test(txt)) continue; // a CLAUDE.md that only imports AGENTS.md
    parts.push(`----- ${name} -----\n${txt}`);
  }
  let rules = parts.join("\n\n");
  if (rules.length > RULES_CAP) rules = rules.slice(0, RULES_CAP) + "\n…[repository rules truncated]";
  return { top, rules, indexed: existsSync(join(top, ".codegraph")) };
}

function matcherHits(matcher) {
  if (!matcher || matcher === "*") return false; // catch-alls are telemetry/status hooks, not guards
  try { return new RegExp(`^(?:${matcher})$`).test("Bash"); } catch { return matcher === "Bash"; }
}

export function bashHooks(top) {
  const files = [join(HOME, ".claude", "settings.json")];
  if (top) files.push(join(top, ".claude", "settings.json"), join(top, ".claude", "settings.local.json"));
  const out = [];
  for (const f of files) {
    let s;
    try { s = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    for (const h of s?.hooks?.PreToolUse || []) {
      if (!matcherHits(h.matcher)) continue;
      for (const c of h.hooks || []) if (c.type === "command" && c.command) out.push({ command: c.command, from: f });
    }
  }
  return out;
}

export function guardBash(command, cwd, top) {
  const payload = JSON.stringify({
    session_id: "glm-agent", hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command, description: "GLM agent command" }, cwd,
  });
  for (const h of bashHooks(top)) {
    const r = spawnSync("/bin/bash", ["-c", h.command], {
      input: payload, encoding: "utf8", timeout: HOOK_TIMEOUT, cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: top || cwd },
    });
    let decision = null, reason = "";
    try {
      const j = JSON.parse((r.stdout || "").trim());
      const hs = j.hookSpecificOutput || {};
      if (hs.permissionDecision === "deny" || hs.permissionDecision === "ask") { decision = hs.permissionDecision; reason = hs.permissionDecisionReason || ""; }
      if (j.decision === "block") { decision = "deny"; reason = j.reason || reason; }
    } catch {}
    if (r.status === 2) { decision = "deny"; reason = reason || (r.stderr || "").trim(); }
    if (decision) {
      const hookName = basename((h.command.match(/[\w.\/${}-]+\.(sh|mjs|js|py)/) || [h.command])[0]);
      return { blocked: true, decision, reason: `${reason || "refused"} [hook: ${hookName}${decision === "ask" ? ", needs approval" : ""}]` };
    }
  }
  return { blocked: false };
}
