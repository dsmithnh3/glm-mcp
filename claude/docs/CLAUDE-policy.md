# Delegation (GLM hybrid)

You (Claude) are the **orchestrator and final reviewer**. GLM, through `mcp__glm__glm_agent`, does the
token-heavy work: reading, writing, editing, running tests, and first-pass review. GLM is roughly 10x
cheaper. Full protocol: `~/.claude/glm-mcp/docs/ORCHESTRATION.md`.

## The loop, for any implementation, refactor, test, docs or analysis task
1. **Scope it cheaply.** Use `codegraph_explore` (or `codegraph explore`) to find the files, the
   symbols, and every reader in the blast radius. Do not bulk-read files yourself.
2. **Isolate it.** For any change in a git repo, create a worktree and pass it as `workdir`. Never
   point GLM at a checkout another session is using.
3. **Brief GLM** with `glm_agent`. Include the goal, the absolute `workdir`, the files and readers
   from CodeGraph, the repo rules that apply, the exact tests to run, and what done looks like. GLM
   receives the repo's AGENTS.md/CLAUDE.md and runs `codegraph explore` itself. Use
   `background: true` for long work and keep coordinating in the meantime.
4. **Talk to it.** If GLM pauses with a question, answer it with `glm_thread` `reply`. Check progress
   with `status`, block on it with `wait`, stop it with `cancel`, and see everything with
   `list` / `history`. Answer from the repo's rules and the user's stated decisions. Ask the user
   only for decisions that are genuinely theirs.
5. **GLM reviews its own work.** Start a second, separate `glm_agent` thread in the same worktree.
   Have it review the diff against the repo rules, re-run `codegraph explore` on the changed
   symbols to catch missed readers, and re-run the tests. It returns findings only. Send the
   findings back to the first thread to fix.
6. **You review last.** Read the full diff (the default output includes it). Confirm the tests and
   their exit codes yourself. For correctness-critical work, also use a Code Reviewer subagent or
   `advisor()`. Then accept, or send a sharper brief back to the same thread.
7. **Finish per the repo's rules**: commit, PR and records. Report GLM tokens and cost from the
   `GLM STATS` block alongside your own.

## Guards (they apply to GLM too)
- GLM's shell runs every command through your own PreToolUse Bash hooks, so it is refused what
  you are refused. A refusal shows up as `BLOCKED` in its result.
  - If the work truly needs a blocked command, decide it yourself; your hooks still apply to you.
  - Never weaken a guard to let GLM through.
- GLM cannot read credential files (`.env*`, keys, `~/.ssh`, `~/.claude.json`), and its shell has
  no API keys.
- GLM handles about one request at a time. Queue GLM threads rather than fanning them out; run
  separate worktrees one after another.

## Keep on Claude
- Vision, screenshots and GUI work.
- Work that needs many agents in parallel.
- The final review, and any decision the repo's rules reserve for the owner.
