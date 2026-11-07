# An agent's own temp folder needs no prompt Plan

**Goal:** A Swarm agent reads and writes its own temporary files without stopping at Claude Code's "Allow this read outside
the working directories?" under its owner's own settings (task #4395).

**Architecture:** Since #4215 an agent starts in its owner's own permission settings; on the Mac Studio those block reads
outside the working directories, and the shared-machine rule puts temp files in `mktemp -d "${TMPDIR:-/tmp}/…"`. Harness gave
an agent a private `TMPDIR` only on a computer with a Team account, and since v3 there are none, so agents used the system's
`/var/folders/…/T` and stopped there (Authorder, 11-07). `cli/src/lib/agentTmp.ts` now gives every Swarm agent (not a Buddy,
not a person's own session, not a terminal) a private 0700 folder of its own, one per agent workspace
(`<data>/agent-tmp/<hash of its folder>`), as its `TMPDIR`, which `mktemp` uses, and adds exactly that folder to the engine's
working directories (`--add-dir=<folder>` for Claude Code and Codex). One call, `agentTmpLaunch`, gives the variable and the
argument together, at `agent_create` (`core/agents/create.ts`) and at every relaunch (`lib/launchOverrides.ts`), and replaces
`agentTmpEnv`.

A folder of its own, not one all agents share: Claude Code reads an added folder's own `.claude` settings, skills, commands
and agents, so a shared folder would let one agent plant them for others. Whatever can write in an agent's own folder runs as
its owner and could already write the owner's own `~/.claude`, so the added folder opens no new way in. The value is joined to
the flag (`--add-dir=…`): Claude Code's flag takes several values and would otherwise swallow what follows it.

**Tech Stack:** TypeScript, Node `fs`, vitest.

**Spec:** the task brief of #4395.

This plan is implemented by its Engineer, task by task, test first.

## Global Constraints

- CLI only. Never the home folder, a repository's parent, or a login or settings folder; never read a Claude or ChatGPT login.
- Windows keeps its own per-account temporary folder: nothing changes there.
- A Team-written start keeps its project settings off.

## Review Focus

- Only the agent's own temp folder is added, at its real path, made private; nothing broader.
- `TMPDIR` and the added folder are the same folder, at launch and at relaunch.
- A Buddy, a person's own session and a Team-written start's other flags are unchanged.

## Task 1: The folder and its launch

**Files:** `cli/src/lib/agentTmp.ts`, `cli/src/lib/agentTmp.spec.ts`

**Interfaces:** `agentTmpLaunch(engine, role, cwd, deps): { env: Record<string, string>; args: string[] }`, replacing
`agentTmpEnv`; `agentTmpOf(cwd, deps): string | null`.

- [ ] Write failing specs: a Swarm agent gets a private folder of its own, the same for the same workspace and another for
      another, as `TMPDIR`, with `--add-dir=<that folder>` for Claude Code and Codex and nothing for other engines; a Buddy,
      a terminal, a person's own session and Windows get no argument; a folder that cannot be made private gives neither.
- [ ] Watch them fail, then add `agentTmpLaunch` and `agentTmpOf`, and make the folder a root for what agents drop wherever
      it is used.

## Task 2: Given at every launch

**Files:** `cli/src/core/agents/create.ts`, `cli/src/lib/launchOverrides.ts`, their specs

- [ ] Write failing specs: `agent_create` and a relaunch put the folder's argument with the engine's other arguments and its
      `TMPDIR` in the launch's variables, the launch's own variables still winning; a Team-written start keeps
      `--setting-sources user --strict-mcp-config`.
- [ ] Watch them fail, then call `agentTmpLaunch` in both.
- [ ] Run the changed specs, the specs of what imports them, and the local checks `scripts/local-checks.py --list` names;
      a fresh agent on the Mac Studio reads its `mktemp` file with no prompt (Mac test).
