# Agents never stop on Claude's folder-trust question: Implementation Plan

> Way of working: this project's Engineer role. Each plan task is implemented test first, by
> superpowers:test-driven-development: the failing test is committed and watched fail before its code. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** A Claude agent the Swarm starts never stops on "Do you trust this folder?". When its start names a temporary folder
(a scratchpad), it starts in a permanent folder Harness makes for it and trusts. Task #3713, reported by Scholes for
project computer's agent Dee.

**Architecture:** A Swarm start without a worktree passes the requested `cwd` through unchanged (`superTabs/start.ts`). The
core trusts a Swarm agent's folder only when it is a Git checkout in the projects root, or a worktree Harness made
(`core/agents/create.ts` `swarmFolder`). A scratchpad is neither, so Claude asks on every run, in a terminal no Swarm view
shows. The fix follows the Buddy home (`superTabs/buddyHome.ts`), the one folder Harness already makes and trusts for a start:
- When the requested folder is temporary, the start makes `<projectsRoot>/worktrees/agent-home/<leaf of super-tab/<startId>>`
  with a marker file, trusts that folder alone in Claude's settings, and launches there.
- The start records it beside its worktrees, so the agent's stop removes it: only that folder, only with its marker, and only
  when no session works in it.

**Tech Stack:** TypeScript, vitest.

**Spec:** task #3713's brief.

## Global Constraints

- Trust only the folder Harness created for the agent, never a parent folder or the home folder.
- Leave the person's own Claude settings unchanged for folders Harness didn't create.
- Never print a secret.
- Only a folder inside Harness's own agent-home area, with its marker, is ever removed; anything else is kept.

## Review Focus

1. A requested folder that is not temporary (a project checkout, the person's own folder) is passed through as before, and is
   never trusted or removed by this change. Task 1 and Task 2 pin it.
2. A temporary folder is recognised as written and with links resolved (`/tmp`, `/private/tmp`, `/var/tmp`, the OS temp
   folder, the macOS `/var/folders` and `/private/var/folders`). Task 1 pins it.
3. A folder named by a request can never be the one Harness removes: the path is made from the start id, inside
   agent-home. Task 3 pins it.
4. A folder another live or paused session works in is kept. Task 3 pins it.
5. Trust is recorded for that exact folder, in the Claude home the launch reads. Task 2 pins it.

---

### Task 1: The agent folder

**Files:**
- Create: `cli/src/superTabs/agentFolder.ts`
- Test: `cli/src/superTabs/agentFolder.spec.ts`

**Interfaces:**
- Produces: `AGENT_FOLDERS = 'agent-home'`, `AGENT_FOLDER_MARK = '.harness-agent-folder'`.
- Produces: `temporaryFolder(path: string, tmp?: string): boolean`.
- Produces: `agentFolderFor(root: string, startId: string): string`.
- Produces: `prepareAgentFolder(folder: string, engine: unknown): Promise<void>`, which makes the folder (0700) and its mark,
  and records Claude's trust for it.
- Produces: `removableAgentFolder(path: string, root: string): boolean`.

- [ ] **Step 1: Write the failing tests:**
  - `temporaryFolder` is true for `/tmp/x`, `/private/tmp/claude-501/a/scratchpad`, `/var/folders/ab/T/x` and `<tmpdir>/x`.
  - It is false for `/Users/me/work`, `/tmp-not/x` and `<root>/worktrees/repo/leaf`.
  - `agentFolderFor(root, 's1')` is `<root>/worktrees/agent-home/<worktreeFolderName('super-tab/s1')>`.
  - `prepareAgentFolder` makes the folder with mode 700 and the mark, and records trust for it alone in a temp Claude home.
  - `removableAgentFolder` is true only for a marked folder directly in `<root>/worktrees/agent-home`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/agentFolder.spec.ts` and watch it fail.
- [ ] **Step 3: Implement** in `agentFolder.ts`, with trust through `folderTrust('claude', …).record(folder)`, as `trustBuddyHome` does.
- [ ] **Step 4: Run and see it pass.** Commit the test first, then the code.

### Task 2: The Swarm start uses it

**Files:**
- Modify: `cli/src/superTabs/start.ts` (the payload's `cwd`)
- Test: `cli/src/superTabs/start.spec.ts`

- [ ] **Step 1: Write the failing test:** a Claude start with `worktree: false` and a scratchpad `cwd` creates the agent with
  `cwd` set to `agentFolderFor(projectsRoot(), startId)`, and that folder exists and is trusted. The same start with a
  non-temporary `cwd` keeps it as before.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/start.spec.ts` and watch it fail.
- [ ] **Step 3: Implement:** compute `agentFolder` only for a start that is not a Buddy home and not a worktree, whose `cwd` is
  temporary; prepare it; send `cwd: agentFolder`.
- [ ] **Step 4: Run and see it pass.** Commit the test first, then the code.

### Task 3: The agent folder goes when its agent stops

**Files:**
- Modify: `cli/src/superTabs/machines.ts` (`recordWorktree`, `removeWorktreeOnce`)
- Test: `cli/src/superTabs/machines.spec.ts`

- [ ] **Step 1: Write the failing tests:**
  - A start whose agent runs in a removable agent folder is recorded with `kind: 'agent-folder'`.
  - Its stop removes that folder once no session uses it.
  - A record whose path is not a removable agent folder is kept and its folder untouched.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement:**
  - `recordWorktree` also records an agent folder.
  - `removeWorktreeOnce` removes a record of `kind: 'agent-folder'` with `rmSync(recursive)`, only when
    `removableAgentFolder(path, projectsRoot())` holds and no session works in it, then drops the record.
- [ ] **Step 4: Run and see them pass.** Commit the test first, then the code.
