# Team-written work starts on the owner's own computer Plan

**Goal:** A start for Team-written work (`projectSettings: 'off'`) on a machine that is not a Team daemon launches with the
branch's own project settings kept out, instead of failing with "runs only in a Team account" (task #4307).

**Architecture:** Since Swarm v3 there is no Team machine; the backend sends Team-written work only to the project owner's
own computer with project settings off (backend `superTabs/commands.ts` start, `teamWritten.ts`, the PM's ruling #4120).
`cli/src/superTabs/start.ts` launches Claude Code there in the `teamWritten` mode (`--setting-sources user
--strict-mcp-config`). The mode no longer skips permission checks or Codex's sandbox: the code runs as the owner, not in a Team
account's own OS user (review of #3485). Codex keeps the branch's settings out only in an engine home of its own, which off a
Team daemon has no sign-in, and Harness never reads or links one (`loginReads.spec.ts`, security review 2 of #3485). So
Team-written Codex work off a Team daemon is refused before anything is made, naming Claude Code.

**Tech Stack:** TypeScript, Node `fs`, vitest.

**Spec:** the task brief of #4307.

This plan is implemented by its Engineer, task by task, test first.

## Global Constraints

- CLI only; `cli/src/superTabs/start.ts` and its spec.
- Never read a Claude or ChatGPT login, nor name its file (`loginReads.spec.ts`).
- No other start path changes: a Team daemon's starts and every normal start are as before.

## Review Focus

- The branch's own project settings, hooks and trust never load for Team-written code, on Claude Code or Codex.
- Team-written code skips no permission check and no sandbox off a Team daemon.
- A refused start creates nothing and says why.

## Task 1: Team-written starts off a Team daemon

**Files:** `cli/src/superTabs/start.ts`, `cli/src/engines/claude/launch.ts`, `cli/src/engines/codex/launch.ts`,
`cli/src/lib/engineLaunch.ts`, `cli/src/core/agents/create.ts`, their specs and the launch golden record.

**Interfaces:** `TEAM_WRITTEN_CLAUDE_ONLY`, the refusal's text.

- [ ] Write failing specs: on a non-Team machine, Team-written Claude Code work launches in `teamWritten` mode, records no
      bypass and has no engine home of its own; the `teamWritten` argv has no flag that skips permissions or the sandbox;
      no full-mode warning is accepted for it; Team-written Codex work is refused before anything is made, naming Claude Code.
- [ ] Run them and watch them fail.
- [ ] Remove the refusal for Claude Code, drop the bypass flags from `teamWritten`, refuse Codex off a Team daemon.
- [ ] Run the changed specs, the specs of what imports them, `loginReads.spec.ts` and `npm run test:core`.
