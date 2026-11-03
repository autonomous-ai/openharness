# An agent is limited only by its engine's own notice Implementation Plan

> **Way of working:** by this project's instructions (Engineer role), not subagent-driven-development: each failing test committed before its code, the branch pushed after each task, one independent review of the pull request. There is no Execution Handoff.

**Goal:** Text an agent prints (tool output, other terminals' screens, quoted logs) never marks it limited; the engine's own limit notice still does; the mark clears as soon as that notice goes or the agent works again.

**Architecture:** The host's `limitOf` keeps its words but reads where they stand. Claude Code draws its notice at the margin, in its own dialog, or as the `⎿` line under its own reply. Codex draws its notice at the margin after `■`. Tool output, by contrast, sits under a tool call (`⏺ Bash(…)`) or indented beneath it. The backend clears `limitedUntil` with the `limit` alert when the episode ends, and when the agent posts or reports work.

**Tech Stack:** TypeScript; Vitest in `cli/` and `backend/`.

**Spec:** Task #2321 (Ken), from River listed "Idle · limited" on 11-03 after printing other agents' screens.

## Global Constraints

- PR body first line: Requested by ken15@autonomous.ai through Harness.
- A test that fails without the fix for every named risk; red/green in a PR comment; the full Super Tab integration suite for the backend change.
- Swarm code stays out of `cli/src/core`. Temp files only in `mktemp -d` folders.

## Review Focus

- A limit line as the first line of a tool's output (`  ⎿  ■ You've hit …` under `⏺ Bash(`) is not the agent's.
- A limit line further down a tool's output, indented, is not.
- Claude Code's own notice under its reply (`⎿  You've hit your session limit …` under `⏺ All green.`), at the margin ("5-hour limit reached"), in its dialog, and "API Error: Usage limit reached" still are; so is Codex's `■ You've hit …`.
- An ended `limit` episode clears `limitedUntil`; a lost task's resume, which reads its own time, still works.
- An agent posting while marked limited clears the mark; anyone else's post doesn't.

## Design

- **Growth, concurrency, migration, audience, identity:** N/A because it reads the same screen and writes the same agent field.
- **Read cost:** none added.
- **Scale:** N/A because it is one more line check per read.
- **Compatibility:** an older host keeps its old reading until updated; the backend side helps every host.
- **Failure:** an engine drawing its notice a new way stops alerting until taught; the agent still works and posts as before.
- **Platforms:** macOS, Linux and Windows hosts share this code.

---

### Task 1: The host reads only the engine's own notice

**Files:** Modify `cli/src/superTabs/terminal.ts`; Test `cli/src/superTabs/terminal.spec.ts` (and a fixture screen).

- [ ] **Step 1:** Failing tests: a Claude Code screen whose tool output shows Codex's limit line, first or further down, is not limited; Claude Code's own notices and Codex's still are.
- [ ] **Step 2:** Run `npx vitest run src/superTabs/terminal.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement in `limitOf`.
- [ ] **Step 4:** Run it again. Expected: PASS. Coverage of the file stays as it was.
- [ ] **Step 5:** Commit the test, then the code; push.

### Task 2: The mark clears with its notice, or when the agent works

**Files:** Modify `backend/src/superTabs/terminal.ts`, `backend/src/superTabs/commands.ts`; Test `backend/src/superTabs/commands.test.ts`.

- [ ] **Step 1:** Failing tests: `active: false` for `limit` clears `limitedUntil`; the agent's own post or work status clears it; another's doesn't.
- [ ] **Step 2:** Run `npm test -- src/superTabs/commands.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again, then `npm run test:super-tabs`. Expected: PASS.
- [ ] **Step 5:** Commit the test, then the code; push.
