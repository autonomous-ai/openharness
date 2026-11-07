# Buddy launch flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner restart their Buddy from Desktop with free-form extra launch flags (for example `--chrome`). The flags are
saved on the daemon's agent record and applied on every later launch.

**Architecture:**
- The CLI gains a pure parser and validator (`lib/launchArgs.ts`), an optional `launchArgs` on the registry row, and an append in
  `buildLaunchOverrides`.
- `agent_restart` takes an optional `launchArgs` string, saves it, and echoes the saved words.
- Desktop gains a "Restart Buddy…" dialog in the Buddy chat's menu, sending through `AppNotifier.restartAgent`.

**Tech Stack:** TypeScript (cli, vitest), Dart/Flutter (desktop, flutter_test).

**Spec:** `docs/specs/2026-11-06-buddy-launch-flags.md`

## Global Constraints

- Limits: at most 1024 characters and 20 words; no NUL or newline; an unclosed quote is refused.
- The error code is `INVALID_LAUNCH_ARGS`, with a `detail` naming the problem.
- Refused flags (the part before `=`):
  - **Claude:** `--resume`, `-r`, `--continue`, `-c`, `--model`, `--permission-mode`, `--dangerously-skip-permissions`,
    `--session-id`, `--settings`, `--append-system-prompt`, `--system-prompt`, `--mcp-config`, `--fork-session`.
  - **Codex:** `--model`, `-m`, `--dangerously-bypass-approvals-and-sandbox`, `--ask-for-approval`, `-a`, `--sandbox`, `-s`,
    `--profile`, `-p`, plus `resume` or `fork` as the first word.
  - **Other engines:** only the length, word-count and character rules.
- Never run a shell. The words go into argv as they are.
- The record field is `launchArgs?: string[]`, never written when empty.
- Argv order: after the Swarm's args, before Harness's instructions.
- Desktop copy, exactly:
  - menu item "Restart Buddy…";
  - title "Restart Buddy";
  - field label "Extra launch flags", hint `--chrome`;
  - detail "Added to <engine>'s command line each time this Buddy starts on <machine name>. Your Buddy runs with full
    permissions. Clear the field to remove them.";
  - buttons "Restart" and "Cancel";
  - engine did not start: "The Buddy didn't start with these flags. Fix or clear them and restart.";
  - old daemon: "Update Harness on <machine name> to use launch flags."
- Code, comments and UI text are in English.

## Review Focus

1. **A status re-check after a lost reply.** Desktop re-asks `agent_create_status`, which never echoes `launchArgs`. It must
   not show "Update Harness". Pinned in Task 5.
2. **A repeated Restart with the same receipt but different flags.** The receipt fingerprint must include `launchArgs`, so the
   second request is not treated as the first one. Pinned in Task 3.
3. **A stopped Buddy brought back after a reboot.** The stopped row must keep `launchArgs`, and the restored argv must carry
   them. Pinned in Task 2.
4. **A word that is only `=` or `-`, or a quoted flag such as `"--model"`.** The flag is checked after unquoting, so
   `"--model"` is refused. Pinned in Task 1.
5. **Clearing the field on an agent with no saved flags.** It is a no-op restart, writes no empty array, and echoes `[]`.
   Pinned in Task 3.

---

### Task 1: Parse and validate launch flags (CLI)

**Files:**
- Create: `cli/src/lib/launchArgs.ts`
- Test: `cli/src/lib/launchArgs.spec.ts`

**Interfaces:**
- Produces:
  - `parseLaunchArgs(engine: AgentEngine, text: string): { ok: true; args: string[] } | { ok: false; detail: string }`;
  - `LAUNCH_ARGS_MAX_CHARS = 1024`;
  - `LAUNCH_ARGS_MAX_WORDS = 20`.

- [ ] **Step 1: Write the failing tests** in `launchArgs.spec.ts`:
  - `parseLaunchArgs('claude', '--chrome')` → `{ ok: true, args: ['--chrome'] }`.
  - `parseLaunchArgs('claude', '  ')` → `{ ok: true, args: [] }`.
  - `parseLaunchArgs('claude', `--add-dir "/a b" --x='y z' c\\ d`)` → args `['--add-dir', '/a b', "--x=y z", 'c d']`.
  - Unclosed quote `'--x "a'` → `ok: false`, detail contains `quote`.
  - 21 words → `ok: false`, detail contains `20`.
  - 1025 characters → `ok: false`, detail contains `1024`.
  - Text containing `\n` or `\0` → `ok: false`.
  - Claude: each refused flag, bare and as `--model=opus`, plus the quoted `'"--model"'`, gives `ok: false` with detail
    `--model is set by Harness and can't be added here.`.
  - Claude `-c` → refused. Codex `-c model_reasoning_effort=high` → `ok: true`.
  - Codex `resume` as the first word → refused. Codex `--search resume` → `ok: true`.
  - `parseLaunchArgs('opencode', '--model x')` → `ok: true`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/launchArgs.spec.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `parseLaunchArgs`.**
  - A small POSIX word splitter: whitespace separates words; single quotes are literal; double quotes allow `\"` and `\\`;
    a backslash outside quotes escapes the next character.
  - Then the limits, then the per-engine refused sets from Global Constraints. Compare `word.split('=')[0]`.
  - Detail for a refused flag is `` `${flag} is set by Harness and can't be added here.` ``.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/src/lib/launchArgs.ts cli/src/lib/launchArgs.spec.ts
  git commit -m "cli: parse and validate a Buddy's extra launch flags"
  ```

### Task 2: Save launch flags on the agent record and apply them on every launch (CLI)

**Files:**
- Modify: `cli/src/lib/registry.ts`:
  - `RegisteredSession` near `swarmSkill`;
  - the row normaliser near line 689 (`const { … swarmSkill: rawSwarmSkill, ...rest } = row`);
  - the load near line 1387;
  - add `setLaunchArgs` beside `setLaunchModel` (~2590).
- Modify: `cli/src/lib/launchOverrides.ts`: `LaunchSource` gets `launchArgs?: string[]`; append it after
  `swarm!.args(engine)` (~line 323) and before `swarmInstructions`.
- Modify: `cli/src/core/agents/launch.ts:61`: pass `launchArgs: session.launchArgs` into `buildLaunchOverrides`.
- Test: `cli/src/lib/registry.spec.ts`, `cli/src/lib/launchOverrides.spec.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  - `RegisteredSession.launchArgs?: string[]`;
  - `registry.setLaunchArgs(agentId: string, args: string[]): boolean`. An empty array deletes the field; it returns false
    for an unknown agent.

- [ ] **Step 1: Write the failing tests.**
  - registry.spec:
    - `setLaunchArgs('a1', ['--chrome'])` then reload from disk → `byAgent('a1').launchArgs` equals `['--chrome']`.
    - `setLaunchArgs('a1', [])` → the field is absent (`'launchArgs' in row` is false).
    - A row with `launchArgs: [1, '--x']` or `launchArgs: 'x'` on disk loads with no `launchArgs`. Only an array of strings
      is kept.
    - A stopped-row round trip through the normaliser keeps `['--chrome']`.
  - launchOverrides.spec: a Buddy source (`swarmSkill` role `buddy`) with `launchArgs: ['--chrome']` gives `extraArgs` where
    `--chrome` comes after the Swarm args and before the instruction args (`--append-system-prompt` for Claude). With no
    `launchArgs`, `extraArgs` is unchanged from today.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/registry.spec.ts src/lib/launchOverrides.spec.ts`. Expected: the new
  cases FAIL.
- [ ] **Step 3: Implement.**
  - Parse with a guard `Array.isArray(v) && v.every(w => typeof w === 'string') && v.length > 0`, in both the normaliser and
    the load.
  - `setLaunchArgs` mirrors `setLaunchModel`, persisting the same way.
  - Pass the field through `launch.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `cd cli && npx tsc --noEmit -p .`. Expected: clean.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/src/lib/registry.ts cli/src/lib/registry.spec.ts cli/src/lib/launchOverrides.ts cli/src/lib/launchOverrides.spec.ts cli/src/core/agents/launch.ts
  git commit -m "cli: an agent's saved launch flags ride every relaunch"
  ```

### Task 3: `agent_restart` takes `launchArgs` (CLI)

**Files:**
- Modify: `cli/src/core/agents/launches.ts`: `relaunch` (~line 600). The deps type gains `setLaunchArgs`.
- Modify: `cli/src/core/main.ts`: wire `setLaunchArgs: (id, a) => registry.setLaunchArgs(id, a)` where `launches` is built
  (the block with `byAgent: (id) => registry.byAgent(id), toProject: …` near line 3059).
- Test: `cli/src/core/agents/launches.spec.ts`

**Interfaces:**
- Consumes: `parseLaunchArgs` (Task 1) and `registry.setLaunchArgs` (Task 2).
- Produces:
  - Request `agent_restart { agentId, creationId?, launchArgs?: string }`.
  - Reply: today's shape plus `launchArgs: string[]` whenever the request carried `launchArgs`. That holds for the direct
    reply and for the receipt reply.
  - Error `{ error: 'INVALID_LAUNCH_ARGS', detail }`.

- [ ] **Step 1: Write the failing tests** in launches.spec, using its existing `setup()`:
  - Restart with `launchArgs: '--chrome'` calls `setLaunchArgs('agent-1', ['--chrome'])` before the restart runs. The reply
    contains `launchArgs: ['--chrome']`, both with and without `creationId`.
  - `launchArgs: ''` calls `setLaunchArgs(id, [])` and echoes `[]`.
  - `launchArgs: '--model x'` replies `INVALID_LAUNCH_ARGS` with detail `--model is set by Harness and can't be added here.`,
    and neither restarts nor saves.
  - A non-string `launchArgs` (for example `5`) → `INVALID_LAUNCH_ARGS`.
  - `agent_resume` with `launchArgs` → `INVALID_LAUNCH_ARGS`. Only restart takes them.
  - A team-written agent (`permissionMode: 'teamWritten'`) with `launchArgs` → `INVALID_LAUNCH_ARGS`.
  - Two requests with the same `creationId` and different `launchArgs` → the second is refused as a mismatched receipt.
    Use the error the receipt store already gives a different fingerprint.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/agents/launches.spec.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement in `relaunch`.**
  - Before `invoke`: when `payload.launchArgs !== undefined`:
    - refuse unless `operation === 'restart'` and it is a string;
    - refuse a team-written target;
    - parse it with the target's engine (`byAgent(target)!.engine`);
    - then `setLaunchArgs(target, parsed.args)`.
  - Add `launchArgs` (the parsed words) to `creationFingerprint(...)` when present.
  - Add `launchArgs: parsed.args` to both reply paths when present.
- [ ] **Step 4: Run** the same command plus `cd cli && npx tsc --noEmit -p .`. Expected: PASS, clean.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/src/core/agents/launches.ts cli/src/core/agents/launches.spec.ts cli/src/core/main.ts
  git commit -m "cli: agent_restart saves and echoes extra launch flags"
  ```

### Task 4: The agent frame carries `launchArgs` (CLI)

**Files:**
- Modify: `cli/src/lib/agentFrame.ts`: the `AgentFrame` interface and `agentFrame(s, …)` add `launchArgs?: string[]` when
  the session has any.
- Test: `cli/src/lib/agentFrame.spec.ts`

**Interfaces:**
- Produces: `AgentFrame.launchArgs?: string[]`. It is absent when the session has none.

- [ ] **Step 1: Write the failing tests.**
  - `agentFrame({ ...session, launchArgs: ['--chrome'] }, ctx)` has `launchArgs: ['--chrome']`.
  - A session without the field gives a frame with no `launchArgs` key.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/agentFrame.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the conditional spread in `agentFrame`.
- [ ] **Step 4: Run** the same command, then `cd cli && npx vitest run src/core src/lib && npx tsc --noEmit -p . && npm run test:core`.
  Expected: PASS, clean, 100% coverage for `src/core`.
- [ ] **Step 5: Commit**
  ```bash
  git add cli/src/lib/agentFrame.ts cli/src/lib/agentFrame.spec.ts
  git commit -m "cli: an agent's frame names its extra launch flags"
  ```

### Task 5: Desktop sends `launchArgs` and reads them back

**Files:**
- Modify: `desktop/lib/core/models.dart`:
  - `Agent` gains `final List<String> launchArgs` (default `const []`);
  - `Agent.fromJson` reads `j['launchArgs']`, keeping only strings.
- Modify: `desktop/lib/state/app_state.dart`:
  - `RestartAgentResult` gains `final bool launchArgsIgnored` (default false);
  - `restartAgent(machineId, agentId, {AgentRestartAttempt? attempt, String? launchArgs})` and `_runAgentRestart` add
    `'launchArgs': launchArgs` to the `agent_restart` payload when it is non-null and the request is not a status check.
- Test: `desktop/test/agent_restart_launch_args_test.dart`

**Interfaces:**
- Produces:
  - `AppNotifier.restartAgent(String machineId, String agentId, {AgentRestartAttempt? attempt, String? launchArgs})`;
  - `RestartAgentResult.launchArgsIgnored`;
  - `Agent.launchArgs`.

- [ ] **Step 1: Write the failing tests.** Use the recording fake connection the existing restart tests use.
  - `restartAgent('m1', 'a1', launchArgs: '--chrome')` sends an `agent_restart` payload with `launchArgs: '--chrome'`.
  - A reply that echoes `launchArgs` gives `launchArgsIgnored == false`.
  - A created reply with no `launchArgs` gives `launchArgsIgnored == true`.
  - A status check (`agent_create_status`) path never sends `launchArgs` and never sets `launchArgsIgnored`.
  - `Agent.fromJson({... 'launchArgs': ['--chrome', 3]})` gives `launchArgs == ['--chrome']`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/agent_restart_launch_args_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `launchArgsIgnored` = `launchArgs != null && !checking && result['launchArgs'] == null && no error`.
  - The status-check request keeps its payload unchanged.
- [ ] **Step 4: Run** the same command plus `flutter analyze`. Expected: PASS, no issues.
- [ ] **Step 5: Commit**
  ```bash
  git add desktop/lib/core/models.dart desktop/lib/state/app_state.dart desktop/test/agent_restart_launch_args_test.dart
  git commit -m "desktop: restart an agent with extra launch flags"
  ```

### Task 6: "Restart Buddy…" in the Buddy chat's menu (Desktop)

**Files:**
- Create: `desktop/lib/super_tabs/buddy_restart.dart`:
  - `Future<void> showRestartBuddy(BuildContext context, SuperTabController c, String projectId, {AppNotifier? app})`;
  - its dialog widget, following `showRenameBuddy`'s dialog style.
- Modify: `desktop/lib/super_tabs/view.dart` (~line 3960): after "Rename Buddy…", add `item('Restart Buddy…', …)` when
  `editable && c.buddy(group.projectId) != null`.
- Test: `desktop/test/super_tab_buddy_restart_test.dart`

**Interfaces:**
- Consumes:
  - `AppNotifier.restartAgent(..., launchArgs:)`, `RestartAgentResult.launchArgsIgnored` and `Agent.launchArgs` (Task 5);
  - `c.buddy(projectId)` (`SuperTabAgent` with `machineId`, `harnessId`);
  - `buddyMachineName(c, machineId, app: app)` (`buddies.dart`).

- [ ] **Step 1: Write the failing widget tests.**
  - The menu shows "Restart Buddy…" on the reader's own Buddy chat, and not on a project chat or a read-only Buddy history
    chat.
  - The dialog prefills `--chrome` from the machine agent's `launchArgs` and shows the exact detail line with the engine and
    machine name.
  - Pressing Restart calls `restartAgent(machineId, harnessId, launchArgs: '--chrome --x')`; on success the dialog closes.
  - An `INVALID_LAUNCH_ARGS` result shows the daemon's detail under the field, and the dialog stays open.
  - A failed restart shows "The Buddy didn't start with these flags. Fix or clear them and restart."
  - `launchArgsIgnored` shows "Update Harness on <machine name> to use launch flags."
  - Enter in the field restarts. While the request runs, the field is read-only and Restart shows progress.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_buddy_restart_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** the dialog and the menu item, using the copy from Global Constraints. The restart error text for
  `INVALID_LAUNCH_ARGS` is the daemon's `detail`.
- [ ] **Step 4: Run** the same command plus `flutter analyze`. Expected: PASS, no issues.
- [ ] **Step 5: Commit**
  ```bash
  git add desktop/lib/super_tabs/buddy_restart.dart desktop/lib/super_tabs/view.dart desktop/test/super_tab_buddy_restart_test.dart
  git commit -m "desktop: Restart Buddy with extra launch flags"
  ```

### Final checks

- `cd cli && npx tsc --noEmit -p . && npx vitest run src/lib src/core && npm run test:core`
- `cd desktop && flutter analyze && flutter test test/agent_restart_launch_args_test.dart test/super_tab_buddy_restart_test.dart`
- Manual: on Diego's Mac, restart his Claude Buddy with `--chrome` and confirm the pane's process argv contains `--chrome`
  (`ps`). Then restart with an empty field and confirm it is gone.
