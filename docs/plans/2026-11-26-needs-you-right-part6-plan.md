# Needs you, right, Part 6: an outside Claude Code session's question form and plan approval reach the dial

> **For agentic workers:** REQUIRED SUB-SKILL: devcrew phase 3 implements this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** `harness device claude asked` tells the daemon of Claude Code's `AskUserQuestion` form and `ExitPlanMode`
approval as it tells any other waiting prompt, each with a line of its own, so an outside session's form or plan
approval rings the dial once as a wait card.

**Architecture:** The change is in `cli/src/deviceClaude/asked.ts` alone: drop the `PERSON_ONLY` skip and give the two
tools their own summary line in `askedSummary`. Everything downstream (the core's `/api/hook/observed`, the observed
source's `asked`, the devices' `waiting` and `showWaits`, the wait counts) is the path a permission ask takes today
and does not change. No plugin change: the hook (`plugins/harness-device/hooks/asked`) and the Windows mod
(`hooks/device.js` `ask`) already hand both tools' input to this command.

**Tech Stack:** TypeScript, Vitest (unit and `cli/e2e` end to end), the e2e harness's `InOrca` stand-in for Claude
Code's hooks and its fake dial.

**Spec:** [docs/plans/2026-11-26-needs-you-right-design.md](2026-11-26-needs-you-right-design.md), section "Part 6. An
outside Claude Code session's question form and plan approval reach the dial"; also "Platforms", "Release order",
"Tests (red first)", "Design".

## Context: the probe (first task of Part 6, done 2026-11-26)

Real Claude Code 2.1.332 on macOS, outside any pane: a private tmux server, `env -i`, HOME and CLAUDE_CONFIG_DIR in a
scratch folder, `ANTHROPIC_BASE_URL` a local model stub on 127.0.0.1, a dummy API key. Hooks in the isolated
`settings.json` logged every PreToolUse, PermissionRequest, Notification, PostToolUse, Stop and UserPromptSubmit; a probe
plugin's mod logged `classic.PermissionRequest`, the event the harness-device mod uses on Windows.

| Tool | Permission mode | Hooks, in order |
|---|---|---|
| AskUserQuestion | default (`manual`) | PreToolUse, mod `classic.PermissionRequest`, PermissionRequest, ~6.5 s later Notification `permission_prompt` ("Claude needs your permission") |
| AskUserQuestion | auto | same |
| AskUserQuestion | bypassPermissions | same |
| ExitPlanMode | plan (started in plan) | PreToolUse, mod `classic.PermissionRequest`, PermissionRequest, ~6.3 s later Notification `permission_prompt` ("Claude Code needs your approval for the plan") |
| ExitPlanMode | plan entered from auto (Shift+Tab) | same |

- AskUserQuestion's PermissionRequest input: `tool_name: "AskUserQuestion"`, `tool_input.questions[0].question`,
  `.header`, `.options`, and the session's `permission_mode`.
- ExitPlanMode's: `tool_name: "ExitPlanMode"`, `tool_input: {}` (no plan text in 2.1.332, although the model's call
  carried one). It is a deferred tool: the model loads it with ToolSearch first.
- The mod's event carries the same object (`hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`).

So the prompt is first heard at PermissionRequest (on Windows at the mod's `classic.PermissionRequest`), and both reach
`harness device claude asked`, which drops the two tools through `PERSON_ONLY`. The change belongs there alone.

Codex (code reading, `cli/hook/notify.mjs`): outside a pane Codex's PermissionRequest and PreToolUse
(`request_user_input`) hooks fire, but `observedEvent` maps neither (`OBSERVED_EVENTS` holds SessionStart,
UserPromptSubmit, Stop, StopFailure, SessionEnd; Notification is Claude Code's), and Codex has no `asked` path. No Codex
wait outside a pane reaches the devices at all, permission asks included: not the same kind of skip, so not fixed here
(the spec fixes it here only if it is).

What the code downstream does, read on main 3929f94029:

- `core/observedHook.ts` accepts `asked` with `tool` at most 64 characters and `summary` at most 200 bytes with no
  control character; anything else refuses the whole event.
- `cable/hosts/observed.ts` `asked()` acts only on an agent the session's own hooks listed (the plugin's hook also runs in
  Harness's panes), sets it needs-you, keeps `entry.asked = e.summary || e.tool`, and logs only
  `[observed] waiting prompt · shown`. `clearAsked` runs when its state leaves needs-you or its session ends: for an
  outside session that is the turn's Stop, as for a permission ask today.
- `services/devices.ts` `waiting()` builds `askedLine(summary, host)` (`<summary> · answer in <app>`, cut to the dial's
  line with the app kept); `showWaits` asks a shown-only question card with options `In <app>` and counts the outside
  wait (`countOutsideWaits`). Nothing there reads the tool: the two tools need no change in the devices.

## Global Constraints

- The CLI alone changes. No backend change, no new count name, no plugin change.
- The daemon core does not change: no file joins `cli/src/architecture.coreFiles.txt`, no request joins `core/api.ts`.
- AskUserQuestion's line: `tool_input.questions[0].question`, else its `header`, else `A question`; one line, cut as
  every summary is (200 bytes, control characters to spaces).
- ExitPlanMode's line: the fixed words `Plan ready to approve`. The plan's text is never read or sent.
- No question text, plan text, tool input, session or folder in a log line, a count or the backend.
- Platforms: macOS, Linux, Windows.
- One pull request. Released as soon as it is done (CLI only).
- `cli/src/services/devices.ts` stays untouched (open PRs #4650, #4627, #4564 change it); `devices.spec.ts` gets
  additions only, beside existing tests, so a rebase is cheap.
- Docs in English. Commit nothing until the executor's flow says so.

## Review Focus

1. A Claude Code that someday sends the plan in `ExitPlanMode`'s `tool_input` (the model's call carries one): the line
   stays `Plan ready to approve` and no plan text leaves the hook. Pinned in Task 1 (`plan` in the input, checked absent
   from the posted body).
2. A form whose `questions` is not what the docs say (not an array, empty, a string, `null` items, a non-string
   `question`, a whitespace-only question): `A question` or the header, never a throw, always exit 0, never the tool's
   name. Pinned in Task 1.
3. A long or multi-line question (multi-byte text, newlines, tabs): one line within 200 bytes that the core accepts,
   so the event is not refused whole. Pinned in Task 1 (`parseObservedHook` round trip at the bound).
4. One ring per prompt: the Notification `permission_prompt` ~6 s after the hook must not ask a second card, and on
   Windows the mod and the hook must not both tell (`HARNESS_DEVICE_MOD_ASKS`, unchanged). Pinned in Task 2 (one
   `question` call through the later `needs-input`) and Task 3 (one `question` frame through the Notification hook).
5. A Claude Code session in a Harness pane whose plugin hook tells of its form: no second card beside the Harness
   agent's own question. Covered today by "a session no hook listed shows nothing" in `devices.spec.ts`, which reads no
   tool; nothing new to add.

---

### Task 1: `asked` tells the question form and the plan approval, each with its own line

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/deviceClaude/asked.ts` (`PERSON_ONLY`, `askedSummary`, `askedBody`, the file's header comment)
- Test: `cli/src/deviceClaude/asked.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `askedSummary(tool: string, input: unknown): string` (signature unchanged) returns, for `AskUserQuestion`,
  the first question's text, else its header, else `'A question'`; for `ExitPlanMode`, `'Plan ready to approve'`.
  `runAsked` posts both tools as it posts any other. Task 3 relies on these two exact lines.

- [ ] **Step 1: Write the failing tests** in `asked.spec.ts`

  In `describe('askedSummary')`, add rows to the per-tool `it.each` (input → expected summary):

  ```ts
  const FORM = { questions: [{ question: 'Which database should the export use?', header: 'Database', multiSelect: false,
    options: [{ label: 'Postgres', description: 'The main one' }, { label: 'SQLite', description: 'A local file' }] }] }
  ['AskUserQuestion', FORM, 'Which database should the export use?'],
  ['AskUserQuestion', { questions: [{ question: 'First?' }, { question: 'Second?' }] }, 'First?'],
  ['AskUserQuestion', { questions: [{ header: 'Database' }] }, 'Database'],
  ['AskUserQuestion', { questions: [{ question: ' \n ', header: 'Database' }] }, 'Database'],
  ['AskUserQuestion', { questions: [{ question: 7, header: 'Database' }] }, 'Database'],
  ['AskUserQuestion', { questions: [{ options: [] }] }, 'A question'],
  ['AskUserQuestion', { questions: [] }, 'A question'],
  ['AskUserQuestion', { questions: [null] }, 'A question'],
  ['AskUserQuestion', { questions: ['Which?'] }, 'A question'],
  ['AskUserQuestion', { questions: 'Which?' }, 'A question'],
  ['AskUserQuestion', {}, 'A question'],
  ['AskUserQuestion', null, 'A question'],
  ['ExitPlanMode', {}, 'Plan ready to approve'],
  ['ExitPlanMode', { plan: '# Plan\n\n1. Secret plan text.' }, 'Plan ready to approve'],
  ['ExitPlanMode', null, 'Plan ready to approve'],
  ```

  Add to the bounds tests:
  - `askedSummary('AskUserQuestion', { questions: [{ question: '日'.repeat(100) }] })` is `'日'.repeat(66)`.
  - `askedSummary('AskUserQuestion', { questions: [{ question: 'Pick one:\n\tA or B?' }] })` is `'Pick one:  A or B?'`
    (each control character a space, as every summary).
  - A header over 200 bytes with no question is cut the same way.

  In `describe('runAsked')`, replace `it.each(['AskUserQuestion', 'ExitPlanMode'])('sends nothing for %s', …)` with:
  - `'sends a question form with its first question'`: stdin `hookInput({ tool_name: 'AskUserQuestion', tool_input: FORM })`
    posts exactly `{ ...BODY, tool: 'AskUserQuestion', summary: 'Which database should the export use?' }`.
  - `'sends a plan approval with fixed words, and never its plan'`: stdin
    `hookInput({ tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: '# Plan\n\n1. Secret plan text.' } })`
    posts exactly `{ ...BODY, tool: 'ExitPlanMode', summary: 'Plan ready to approve' }`, and
    `JSON.stringify(bodies)` does not contain `'Secret plan'`.

  In `'the core takes every body it sends, at each bound'`, add a form whose question is `'日'.repeat(100) + '\nmore'`
  and a plan approval with `tool_input: {}`; expect 5 bodies, each `parseObservedHook(body)` equal to the body.

  Update the spec's header comment where it says what is not sent.

- [ ] **Step 2: Run the tests and see them fail**

  Run: `cd cli && npx vitest run src/deviceClaude/asked.spec.ts`
  Expected: FAIL. The `AskUserQuestion` rows give `'AskUserQuestion'` (the tool-name fallback), the `ExitPlanMode` rows
  `'ExitPlanMode'`, and the two `runAsked` cases post nothing (`[]`).

- [ ] **Step 3: Implement in `asked.ts`**

  - Delete `PERSON_ONLY` and its use in `askedBody`; drop "or a tool that is the person's" from `askedBody`'s comment.
  - In `askedSummary`, two branches: `AskUserQuestion` takes `questions[0].question`, else `questions[0].header` (each
    only when a string with text after trimming), with `'A question'` as its fallback in place of the tool's name;
    `ExitPlanMode` returns `'Plan ready to approve'` without reading the input. Both go through the same control
    character replacement and `cutBytes(…, MAX_SUMMARY_BYTES)` as every summary.
  - Constants for the two fixed lines, each with a one-line why (the plan's text never leaves this process; a form with
    no words still waits on the person).
  - The header comment: the command tells every waiting prompt, a question form by its first question and a plan
    approval by fixed words, the plan never read.

- [ ] **Step 4: Run the tests and see them pass**

  Run: `cd cli && npx vitest run src/deviceClaude/asked.spec.ts src/deviceClaude/command.spec.ts && npm run typecheck`
  Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit** the red tests first, then the code (devcrew's red commit, then code commit).

### Task 2: the devices show, ring and count the two prompts as any waiting prompt

**Effort:** medium. **Depends on:** none.

These are coverage tests, not red ones: `services/devices.ts` never reads the tool (`entry.asked = e.summary || e.tool`,
then `askedLine`), so an `asked` event for either tool already shows, rings and counts today. They pin that the devices
keep doing so, as the spec's test list asks. No source change; one commit.

**Files:**
- Test: `cli/src/services/devices.spec.ts` (additions only)

**Interfaces:**
- Consumes: the two lines Task 1 defines, as literal strings (the spec does not import `asked.ts`).
- Produces: nothing.

- [ ] **Step 1: Write the tests**

  In `describe('agents outside a pane, from their hooks and the open sessions (cable/hosts/observed.ts)')`, after
  `'a prompt asked mid-turn, then its Notification: one line, told once'`:

  ```ts
  it.each([
    ['AskUserQuestion', 'Which database should the export use?'],
    ['ExitPlanMode', 'Plan ready to approve'],
  ])('%s waits as a card "<line> · answer in Orca", rung once through its Notification, closed at the Stop', async (tool, summary) => { … })
  ```

  With fake timers: `hook('turn-start')`, `asked({ tool, summary })`, `hook('needs-input')`. Expect
  `calls('question')` to equal `[[ID, /^shown:/, shownAs(`${summary} · answer in Orca`)]]` (one card, not two),
  `host().activityText(ID)` to be `` `${summary} · answer in Orca` ``. Then `hook('turn-stop')`,
  `advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)`: `calls('questionClose')` is `[[ID, <that card's id>]]`.

  In `describe('the waits on the person and the interrupt')`, after `'an outside agent\'s wait'`:

  ```ts
  it.each(['AskUserQuestion', 'ExitPlanMode'])('%s is an outside agent\'s wait', async (tool) => { … })
  ```

  With fake timers: `hook('session-start')`, `attach(port)`, `hook('turn-start')`, `asked({ tool, summary: 'x' })`,
  `hook('turn-stop')`, `advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)`; `waits(port)` is
  `{ dial_wait_elsewhere_under_30s: 1 }`.

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/services/devices.spec.ts -t "AskUserQuestion|ExitPlanMode"`
  Expected: PASS on the base as on the branch (coverage tests). If either fails, stop: the devices filter the tool
  somewhere this plan did not find, and the fix belongs in a new task, not in a loosened test.

- [ ] **Step 3: Commit** (one commit, tests only).

### Task 3: end to end, the real CLI shows a form and a plan approval on a fake dial

**Effort:** high. **Depends on:** Task 1.

The existing end-to-end file for this path is `cli/e2e/deviceClaudeOrca.e2e.ts`: the real daemon, the hooks the daemon
installs run as Claude Code runs them (`harness/inOrca.ts` `InOrca`), the plugin's PermissionRequest hook as the real
`harness device claude asked`, and a fake dial on the desk. `InOrca.asked(command)` posts a Bash prompt only; it is
widened to take the hook's tool, and the two existing callers (`deviceClaudeOrca.e2e.ts`, `harness/appEvalOrca.ts`)
stay as they are.

Changing `inOrca.ts` selects more of PR CI (docs/validation-and-release.md): `linux-e2e` runs the five Orca files and
the six app-eval files beside this one, and `dial-hosts` runs. The alternative, a second spawn of the CLI inside the e2e
file, would copy `InOrca.run` and its settings write: one way to run the hook is kept instead.

**Files:**
- Modify: `cli/e2e/harness/inOrca.ts` (`asked`)
- Test: `cli/e2e/deviceClaudeOrca.e2e.ts` (one new `it`, and the file's header list)

**Interfaces:**
- Consumes: Task 1's lines `Which database should the export use?` (from the form below) and `Plan ready to approve`.
- Produces: `InOrca.asked(prompt: string | { tool_name: string; tool_input: Record<string, unknown>; permission_mode?: string })`:
  a string is a Bash command, as today; an object is the PermissionRequest input's tool fields as Claude Code writes
  them, over the same defaults (`hook_event_name: 'PermissionRequest'`, `permission_mode: 'default'`).

- [ ] **Step 1: Widen `InOrca.asked`** as in Interfaces; no behavior change for a string.

- [ ] **Step 2: Write the e2e case** in `describe('the dial shows Claude Code waiting outside Harness')`:

  `it('a question form and a plan approval each wait on the dial with their own line, rung once, and their Stop closes them')`

  One daemon (`fresh()`), one dial (`plugged`), one `InOrca` session:
  1. `SessionStart`, the agent listed; `UserPromptSubmit`; its turn started.
  2. `claude.asked({ tool_name: 'AskUserQuestion', tool_input: <the form of Task 1's FORM> })` exits 0 with no output;
     then `claude.hook('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' })`.
     The dial gets the line `Which database should the export use? · answer in Orca` and a `question` frame for the
     agent with a `shown:` id.
  3. `Stop`: that question is closed and the turn done. Between the `asked` and that `question.close`, the dial got
     exactly one `question` frame for the agent: the Notification asked no second card.
  4. `UserPromptSubmit` with `permission_mode: 'plan'`; `claude.asked({ tool_name: 'ExitPlanMode', permission_mode: 'plan',
     tool_input: { plan: '# Plan\n\n1. Secret plan text.' } })`; the Notification as above with
     `'Claude Code needs your approval for the plan'`. The dial gets `Plan ready to approve · answer in Orca` and one new
     `question` frame; `Stop` closes it.
  5. `d.log()` holds `[observed] waiting prompt · shown` twice, and neither the log nor `JSON.stringify(dial.messages)`
     holds `Which database` (the log only) or `Secret plan` (both).

  Add the case to the file's header list.

- [ ] **Step 3: See it fail on the base's `asked.ts`**

  From the repo root: `git show 3929f94029:cli/src/deviceClaude/asked.ts > cli/src/deviceClaude/asked.ts`, then
  `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts -t "question form"`.
  Expected: FAIL, timed out waiting for the form's waiting line. Then restore Task 1's file from the repo root:
  `git checkout HEAD -- cli/src/deviceClaude/asked.ts`, and `git status` shows it unchanged.

- [ ] **Step 4: Run it, and the file's other cases, green**

  Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts && npm run typecheck`
  Expected: PASS, every case of the file.

- [ ] **Step 5: Commit** (one commit: the harness change and the case; the red evidence is Step 3's run).

### Task 4: docs: the plugin's README names question forms and plan approvals

**Effort:** medium. **Depends on:** none. No test (docs only); one commit.

**Files:**
- Modify: `plugins/harness-device/README.md`

`cli/AGENTS.md`'s devices row does not name the skip (it names only the PermissionRequest hook and how it runs under Git
Bash or PowerShell), so it stays as it is. `plugins/harness-device/hooks/asked`'s comment ("about to ask the person to
allow a tool call") also stays: a form and a plan approval reach it through the same PermissionRequest, and a change
there would select Windows CI for a comment.

- [ ] **Step 1: Edit the README**
  - Opening line: the dial shows Claude Code's waiting prompts: a permission ask, a question form and a plan approval.
  - "What it does", first paragraph: a question form shows its first question, a plan approval the words
    "Plan ready to approve"; the example line stays.
  - "What it never does": the dial sees the tool's name and one line: a command or path for a permission ask, the
    first question for a form, fixed words for a plan approval, whose plan stays in the hook.
- [ ] **Step 2: Commit.**

---

## Verification

**PR CI (selected by the paths):** `cli-typecheck`, `cli-tests` (runs `asked.spec.ts` and `devices.spec.ts`);
`linux-e2e` (runs `deviceClaudeOrca.e2e.ts` on ubuntu-24.04, plus the five Orca files, the six app-eval files and the
canary, as `inOrca.ts` changed); `dial-hosts` (`inOrca.ts`). Linux is covered there: `asked.ts` has no Linux-only code
and the hook is the same POSIX script as on macOS, so no local Linux or Ubuntu VM check is needed.

**Local gates PR CI does not run:** `npm run test:core` (`src/services/devices.spec.ts` changed). Run
`python3 scripts/local-checks.py --run` from a clean tree at the final commit (it names `cli-core` for these paths) and
paste its fence into the PR body. `npm run typecheck` in `cli/` once more at the end.

**macOS, the real Claude Code** (local; no workflow runs the real Claude Code; recorded in the PR). Never Ken's daemon
(port 18473), `~/.claude`, `~/.codex` or any backend.

1. Build the branch: `cd cli && BUNDLE_OUT_DIR=<scratch>/bundle node build-bundle.mjs`.
2. Start the model stub from the probe folder,
   `/private/tmp/claude-502/-Users-nqhieu84-orca-workspaces-openharness-needs-you-right-asks/be1adf76-c0ea-4f67-ba12-e4e8cafcd404/scratchpad/probe/stub.mjs`
   (`PORT=0 node stub.mjs` prints its port on 127.0.0.1). A prompt with `ASKQ` makes it call AskUserQuestion with the
   question `Which database should the export use?`; `PLANX` in plan mode makes it load ExitPlanMode with ToolSearch and
   call it with a plan holding `Secret plan text that must never leave.` If the scratch folder is gone, write a stub that
   does the same (Anthropic Messages, streamed) in a new scratch folder.
3. A scratch driver (not committed), run with `npx tsx` from `cli/`, `E2E_BUNDLE_PATH=<scratch>/bundle/cli.js`: an
   `IsolatedDaemon` (`e2e/harness/daemon.ts`) with `CABLE_DISABLE: 'false'` and `HARNESSD_TEST_DIAL_PORT` at a
   `dials.json` in its root, a `Desk` (`e2e/harness/desk.ts`) with one fake dial plugged, as `deviceClaudeOrca.e2e.ts`
   `fresh()` and `plugged()` do. The daemon gets its own HOME, data folder, port, tmux and hook routes from the harness,
   is signed in to nothing, and installs Claude Code's hooks into that HOME. The driver prints each dial message for the
   agent (`turn.started`, `turn.activity`, `question`, `question.close`) and, at the end, the daemon log's `[observed]`
   lines. Start it from a stable folder outside any worktree that will be deleted.
4. Put the built CLI where the plugin's hook looks first: `<daemon HOME>/.local/bin/harness`, a `#!/bin/sh` wrapper
   that execs `node <scratch>/bundle/cli.js "$@"`.
5. Run the real Claude Code (2.1.332 or later) in a private tmux server of its own (`tmux -L <unique>`, `TMUX_TMPDIR`
   in scratch) under `env -i` with the daemon's environment (its HOME, `ADAPTER_DATA_DIR`, `PORT`, hook routes, PATH
   with `<daemon HOME>/.local/bin` first), `CLAUDE_CONFIG_DIR=<daemon HOME>/.claude`, `ANTHROPIC_BASE_URL` the stub,
   a dummy `ANTHROPIC_API_KEY`, `DISABLE_TELEMETRY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
   `DISABLE_AUTOUPDATER=1`: `claude --plugin-dir <repo>/plugins/harness-device` in a scratch project folder (accept the
   folder trust prompt with Enter).
   - Send `ASKQ pick a database`. Seen: the dial gets `Which database should the export use? · answer in <app>` and
     one `question` frame (`shown:` id); still one after the Notification ~6 s later. Answer the form in the TUI; at
     the turn's Stop the dial gets `question.close`.
   - Quit; start again with `--permission-mode plan`; send `PLANX make a plan`. Seen:
     `Plan ready to approve · answer in <app>` and one `question` frame; approve in the TUI; `question.close` at the
     Stop.
   - Repeat the form once with `--permission-mode auto` and once with `--permission-mode bypassPermissions`: same card.
   - The daemon log has `[observed] waiting prompt · shown` once per prompt. Neither the log nor the dial's messages
     hold `Which database` (log) or `Secret plan` (both).
6. Clean up only what the check made: the tmux server, the stub, the driver's daemon and root.

**Windows, the real Claude Code** (needs the orchestrator's go: one VM at a time, suspend the Ubuntu VM first). On the
Windows UTM VM (`ssh admin@192.168.64.7`), as a temporary standard user made for this check and removed after, never a
person's account. Per `cli/scripts/windows-dial-e2e/README.md`: build the desk and CLI on the Mac
(`cd cli && node scripts/windows-dial-e2e/bundle.mjs <out>`), copy `<out>`, the plugin folder and `stub.mjs` over, and
run `desk.mjs --own-account` (the stand-in dial, Harness's folders in `%USERPROFILE%\.harness-dial-check`) through
`console.ps1` in that user's console session. Put a `harness.cmd` that runs `<out>`'s `cli.js` on that user's PATH (the
mod looks for `%USERPROFILE%\.harness\bin\harness.exe`, then `harness` on PATH). Run that user's Claude Code 2.1.332 or
later with `--plugin-dir`, the stub's `ANTHROPIC_BASE_URL`, a dummy key, and `ADAPTER_DATA_DIR` and `PORT` from the
desk's first line. Seen: the mod tells the prompt (`HARNESS_DEVICE_MOD_ASKS` set, the hook runs nothing), the desk
prints one `question` frame with `Which database should the export use? · answer in <app>`, and for a plan approval
`Plan ready to approve · answer in <app>`; the daemon log has `[observed] waiting prompt · shown` once per prompt, not
twice. If Claude Code cannot be installed for the test user, record the check as not run with that reason.

**Proposal (not built here):** no workflow runs the real Claude Code against a stub model for the plugin's hooks. A
manual workflow that installs a pinned Claude Code on a Linux runner and runs this check headless would let later pull
requests that touch `plugins/harness-device/` or `deviceClaude/` rerun it; proposed to the maintainers, not added.
