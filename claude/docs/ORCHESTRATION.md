# Orchestrating GLM from Claude Code

How the orchestrator (Claude) and GLM work together in this fork, and how each guard is enforced.
The short form lives in the global `CLAUDE.md` policy (`docs/CLAUDE-policy.md`, written there by
`install.mjs`).

## Roles

| Role | Who | What |
| --- | --- | --- |
| Orchestrator | Claude (Opus) | Scopes with CodeGraph, creates worktrees, writes briefs, answers GLM's questions, gives the final review, and handles commits, PRs and records. |
| Implementer | GLM, thread A | Reads, edits and runs tests end-to-end in the worktree. |
| Self-reviewer | GLM, thread B | Reviews thread A's diff against the repo rules and CodeGraph's blast radius, and re-runs the tests. Returns findings only. |
| Final reviewer | Claude | Reads the full diff, confirms tests and exit codes, and accepts or sends work back. |

## Tools

- **`glm_agent`**: start a thread, or continue one with `thread_id`.
  - Important arguments: `task`, `workdir` (absolute, ideally a worktree), `context`, `background`,
    `dry_run`, `format` (default `detailed`, which includes the full diff).
- **`glm_thread`**: the live channel. Actions:
  - `list`: recent threads, their state, and any pending question.
  - `status`: running (with recent progress), `waiting_for_orchestrator` (with GLM's question),
    `done` (with summary and diff), `error`, or `cancelled`.
  - `wait`: block up to `wait_seconds` until the thread finishes or asks something.
  - `reply`: answer GLM's question or send a follow-up. The thread resumes with its full history.
  - `cancel`: stop a running thread after its current step.
  - `history`: the whole conversation, including every tool GLM called.
- **`glm_recommend`**, **`glm_status`**: unchanged.

GLM itself gets an `ask_orchestrator` tool. When it calls it, the run pauses, the thread's state
becomes `waiting_for_orchestrator`, and the orchestrator's `reply` comes back as the answer.

Threads are saved under `~/.claude/glm-mcp/threads/` with mode 0600, so a thread can be continued
after the server restarts. Running-job state is held in memory by the server process.

## What GLM is told

Every run's system prompt contains:
- the working method:
  - CodeGraph first (`codegraph explore` via `run_bash`);
  - enumerate readers before changing a value;
  - smallest test first;
  - report commands with their exit codes;
  - ask instead of guessing;
- the repository's `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md` from the git top level, capped
  at 40,000 characters (`GLM_RULES_CAP`). A `CLAUDE.md` that only imports `@AGENTS.md` is skipped.

## Guards

| Guard | Where | Effect |
| --- | --- | --- |
| Hook parity | `guards.js` `guardBash()` | Before `run_bash` executes, the command is sent to every PreToolUse hook whose matcher matches `Bash`, from `~/.claude/settings.json` and the repo's `.claude/settings.json` / `settings.local.json`. They receive the same JSON payload Claude Code sends, with `CLAUDE_PROJECT_DIR` set. Exit 2, `permissionDecision: deny/ask` or `decision: block` refuses the command. Catch-all matchers (`""`, `*`) are skipped because they are status/telemetry hooks. |
| Credential paths | `deniedPath()` | `read_file` / `write_file` / `edit_file` / `list_dir` refuse `.env*` (not `.env.example`), `auth.json`, `*credentials*`, private keys, `.netrc`/`.npmrc`/`.pypirc`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, the Keychains, and `~/.claude.json`. |
| Credential commands | `deniedCommand()` | Best-effort refusal of shell commands that name those paths or dump the environment (`printenv`, a bare `env`/`set`). |
| Clean environment | `scrubbedEnv()` | `run_bash` children get no `GLM_API_KEY`, `ANTHROPIC_*` tokens, `GH_TOKEN`/`GITHUB_TOKEN`, or variables ending in `_SECRET`, `_TOKEN`, `_API_KEY` or `PASSWORD`. |
| Reversible | `gitCheckpoint()` | A `git stash create` baseline, and a per-file revert hint. The hint never suggests `git clean`. |

The guards are best-effort and run in the server's own process: a determined shell command can
still find another way. The worktree, the orchestrator's final review, and git history are the
backstops.

## Limits

- GLM caps in-flight requests at about one per key. Threads queue through `glmClient`'s semaphore.
- `GLM_AGENT_MAX_ITERS` (default 30) caps one run. A run that hits it says so; continue the thread
  to finish.
