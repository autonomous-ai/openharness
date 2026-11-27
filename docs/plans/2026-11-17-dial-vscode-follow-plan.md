# A swipe shows a Claude Code session in the VS Code extension's tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** On macOS, while VS Code is the latest app in front, a dial's rest on a Claude Code session in the VS Code extension's panel shows that session's tab, through the extension's own link `vscode://anthropic.claude-code/open?session=<uuid>` sent to VS Code alone.

**Architecture:**
- **One adapter** (`cli/src/cable/hosts/vscode.ts`) builds its verbs with `createAppLink` (`appLink.ts`), as `claudeApp.ts` and `codexApp.ts` do: `tap: 'instead'`, bundle `APP_BUNDLES.vscode`, `canShow` = macOS and VS Code in front, `show` = the same link, one at a time per agent. Its own `focus` goes. `paneOf` is unchanged.
- **One wiring line** (`cli/src/services/devices.ts`) gives it `inFront: () => cableHost.latestFront() === 'vscode'`, as the Claude app's adapter is given `'claude'`.
- Everything is in the devices process. Nothing in `cli/src/core`, nothing stored, no new log line.

**Tech Stack:** TypeScript daemon (Node, vitest), `cli/`.

**Spec:** `docs/plans/2026-11-17-dial-vscode-follow-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core, rules 4 to 6) and `cli/src/services/AGENTS.md`.

## Base

- Branch `feat/dial-vscode-follow`, at `e9670ffd23`, in the worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-vscode-follow`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund`. This worktree's `cli/` has no `node_modules`. One process runs it, never two tasks at once.
- The tasks name functions, never lines. Names at the base:
  - `appLink.ts`: `createAppLink`, `AppLinkDeps` (`run`, `platform`, `inFront()`, `bin?`), `AppLink` (`session`, `url`, `bundle?`, `forward?`). `hostDetect.ts`: `APP_BUNDLES` (`vscode: 'com.microsoft.VSCode'`, `cursor`, `claude`, `orca`). `open.ts`: `createOpenActions`, `bundleOf`, `openPath`. `orca.ts`: `RUN_TIMEOUT_MS` (10 000).
  - `vscode.ts`: `createVscodeAdapter`, `VSCODE_SESSION`.
  - `services/devices.ts`: `apps`, `openBin`, `cableHost`, `adapters`, `noting`.
  - Spec helpers: `vscode.spec.ts` `recorder`, `target`, `run`, `forward`; `observed.spec.ts` `fakeActions`; `devices.spec.ts` (in `describe('the mod's voice and Orca, …')`) `startHere`, `mac`, `orca` (Linux), `hook`, `attach`, `said`, `host`, `orcaRuns`, `swiped`, `fakeListener`, `calls`, `inClaudeApp`, `exiting`, `observedAgentId`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 A rest shows the VS Code extension's session | `cli/src/cable/hosts/vscode.ts`, `vscode.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | none | high | `vscode.spec.ts`, `devices.spec.ts` |
| 2 End to end: two extension sessions, each rest its own link | `cli/e2e/dialVscodeFollow.e2e.ts` (new) | 1 | high | the new e2e, run against the base's `vscode.ts` and `devices.ts` (Step 2) |
| 3 The docs name the VS Code adapter | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | none | medium | none: docs only, one commit |

Longest chain: 1 → 2, two tasks. Tasks 1 and 3 share no file and start at once.

- Task 1 is one task because its parts cannot be green apart: `createVscodeAdapter` now takes `AppLinkDeps`, whose `inFront` `devices.ts` and `observed.spec.ts` must pass (`npm run typecheck` covers `src/**`), and the tap's runs change from two (`open <link>`, then `open -b`) to one (`open -b com.microsoft.VSCode <link>`), which two existing `devices.spec.ts` tests pin.
- Task 2 needs Task 1: its claim is about the wired daemon.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/vscode.ts` | **Devices service process** only | its spec (PR CI `cli-tests`) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `cli/e2e/dialVscodeFollow.e2e.ts` | Test: the real daemon, a fake dial, fake hooks, the fake `open` | Verification 1 (macOS, local) |
| `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | Docs | review |

Not changed, and a diff in any is a finding:
- anything under `cli/src/core/`, and `cli/src/architecture.coreFiles.txt`;
- `cable/hosts/appLink.ts`, `open.ts`, `observed.ts`, `claudeApp.ts`, `codexApp.ts`, `hostDetect.ts`, `frontApp.ts`, `cable/cableHost.ts`, `cable/cableSession.ts`, `cli/hook/notify.mjs`;
- the order of `adapters` in `devices.ts`.

## Global Constraints

- **The link.** `vscode://anthropic.claude-code/open?session=<uuid>`, run as `<open> -b com.microsoft.VSCode <link>` (`<open>` is `openPath(HARNESS_OPEN_BIN)`, `/usr/bin/open` by default): no shell, each value one argument, under `RUN_TIMEOUT_MS`. Never to Cursor, VS Code Insiders or another app that registers `vscode://`.
- **The session** is checked against `VSCODE_SESSION` (lower-case UUID) in `paneOf` and again before every command (`createAppLink` does it).
- **The pane** (`paneOf`) is unchanged: `engine === 'claude'`, `CLAUDE_CODE_ENTRYPOINT === 'claude-vscode'`, `__CFBundleIdentifier === 'com.microsoft.VSCode'`, a UUID session. A session in VS Code's integrated terminal has no pane, and a rest there runs nothing, as today.
- **A rest** runs only while `cableHost.latestFront() === 'vscode'` and on macOS. One link at a time per agent: a second rest on the same agent while its link runs is `busy`. A link that fails is `failed` and brings nothing forward.
- **A tap** (`tap: 'instead'`) runs the one link; a link that fails is answered false and the opener's own fallback runs `open -b com.microsoft.VSCode` with `[device] open · vscode · fallback`. No `forward` of the adapter's own (its pane exists only with VS Code's bundle id from a hook, so the opener always has the bundle).
- **Logs.** Only the existing lines: `[device] swipe · ok|failed|busy|superseded`, `[device] open · vscode · fallback`. No line names the session, the link, the bundle or the agent id.
- **Two windows** (spec, decision 3): accepted, not handled in code. Written in the pull request.
- **Rule 7.** No file under `cli/src/core` changes.
- **macOS only.** On Linux and Windows `canFocus` and `canShow` are false and nothing runs.

## Review Focus

1. **VS Code leaves the front during the 400 ms rest** (a person clicks another app right after the swipe): the rest runs nothing. Pinned in Task 1 (`a front that changes during the rest runs none`).
2. **Cursor in front** (it runs the same extension and says the same `claude-vscode`): a rest on a VS Code agent runs nothing; Cursor's front is not VS Code's. Pinned in Task 1 (the "another app in front" test includes `'cursor'`).
3. **A Claude Code session in VS Code's integrated terminal** (`TERM_PROGRAM=vscode`, no entrypoint word) with VS Code in front: no rest is asked for and nothing runs. Pinned in Task 1.
4. **Two extension agents rested in quick turns**: each runs its own link once; a busy link on one never blocks the other. Pinned in Task 1 (two agents, and busy).
5. **A link that hangs or fails on a rest**: `failed`, no `open -b` fallback (a rest never brings an app), and the dial is sent nothing. Pinned in Task 1.

---

### Task 1: A rest shows the VS Code extension's session

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red tests:** `cli/src/cable/hosts/vscode.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/vscode.ts`
- Modify: `cli/src/services/devices.ts` (the one `createVscodeAdapter` call in `adapters`)
- Test: `cli/src/cable/hosts/vscode.spec.ts`, `cli/src/services/devices.spec.ts`
- Modify: `cli/src/cable/hosts/observed.spec.ts` (only `fakeActions`' `createVscodeAdapter(deps)` call, which must now pass `inFront`; no test there changes)

**Interfaces:**
- Consumes: `createAppLink(deps: AppLinkDeps, link: AppLink): AppLinkVerbs` (`appLink.ts`), `APP_BUNDLES.vscode`, `cableHost.latestFront(): string | undefined`.
- Produces: `createVscodeAdapter(deps: AppLinkDeps): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>`, id `'vscode'`, `tap: 'instead'`, `paneOf` as at the base, then `...createAppLink(deps, { session: VSCODE_SESSION, url: (session) => \`vscode://anthropic.claude-code/open?session=${session}\`, bundle: APP_BUNDLES.vscode })`. In `devices.ts`: `createVscodeAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'vscode' })`, in the same place in `adapters` (inside the list `noting` wraps). No `noteLink` or other echo guard: VS Code sends no attach the follow could take as a person's (the comment says so, as the Codex app's line does).

Constants for the tests: `VSCODE = 'com.microsoft.VSCode'`, `UUID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`, a second `UUID2 = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'`, `link(id) = \`vscode://anthropic.claude-code/open?session=${id}\``, and the run `['/usr/bin/open', ['-b', VSCODE, link(id)], 10_000]`.

- [ ] **Step 1: Write the tests in `vscode.spec.ts`.** `recorder` takes `inFront` (default `() => true`) into `Deps` (now `AppLinkDeps`).
  - Rewrite `its id is vscode, …` as `its id is vscode, a tap is its link instead of its app, and only macOS can focus or show`: `tap` is `'instead'`; `show` and `canShow` are functions; `type` is undefined; on darwin `canFocus` and `canShow` are true, and `canShow` is false with `inFront: () => false`; on `'linux'` and `'win32'` `canFocus` and `canShow` are false, `focus` answers false, `show(pane, 'a1')` answers `'failed'`, and nothing runs.
  - The `HARNESS_OPEN_BIN %j` cases: `calls` is `[run(file, '-b', VSCODE, link(UUID))]`.
  - `a pane id not in its form runs nothing`: for each bad id, `focus` is false and `show(…, 'a1')` is `'failed'`; `calls` is empty.
  - In the tap describe: `the VS Code extension's tab: its session's link, sent to VS Code alone`: `opener.open('a1', target(TAB))` is true, `calls` is `[run(OPEN, '-b', VSCODE, link(UUID))]` and nothing else, `logs` is empty. `a link that fails still brings VS Code forward, …`: exit `[1]` gives `calls` `[run(OPEN, '-b', VSCODE, link(UUID)), forward(VSCODE)]` and `logs` `['[device] open · vscode · fallback']`, with no `UUID` in a log. The other tap tests (no link without all three, another engine) keep their expectations.
  - New `describe('a rest on a session in the VS Code extension\'s tab (docs/plans/2026-11-17-dial-vscode-follow-design.md)')`:
    - `with VS Code in front, a rest runs the session's link once, sent to VS Code alone`: `show({ adapter: 'vscode', id: UUID }, 'a1')` is `'ok'`; `calls` is `[run(OPEN, '-b', VSCODE, link(UUID))]`.
    - `a rest whose link fails is failed and brings nothing forward`: exit `[1]`; `'failed'`; `calls` holds only the link.
    - `a second rest on the same agent while its link runs is busy; another agent's runs`: a runner whose first call waits on a promise; `show(UUID,'a1')` pending, `show(UUID,'a1')` is `'busy'`, `show(UUID2,'a2')` is `'ok'`; after release the first is `'ok'`; `calls` is the link for `UUID`, then for `UUID2`, each once.
  - Run `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts`. Expected: FAIL (`tap` is `'before'`, `show` undefined, the link has no `-b`).
- [ ] **Step 2: Write the tests in `devices.spec.ts`,** in `describe('the mod's voice and Orca, …')`.
  - Edit two existing tap tests, whose runs this decision changes (spec, `tap: 'instead'`): `a session in the VS Code extension's tab opens by its link, sent to VS Code alone`: `orcaRuns` is `[['/usr/bin/open', ['-b', VSCODE, link(SESSION)], 10_000]]`. In `the Claude app's, the Codex app's and VS Code's links run HARNESS_OPEN_BIN as their open`, VS Code's two runs become one: `['/tmp/e2e/fake-open', ['-b', VSCODE, link(VSCODE_ID)], 10_000]`. No other existing expectation changes.
  - `inVscode(over)`, a copy of `inClaudeApp`: fake timers, `fakeListener`, `startHere({ orca: mac, listen, ...over })`, two `session-start` hooks with `sessionId` `UUID` and `UUID2`, each `hostHints: { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }`, `attach`, the listener started, and `front(app)`. `V1 = observedAgentId('claude', UUID)`, `V2 = observedAgentId('claude', UUID2)`.
  - `with VS Code in front, a rest on a VS Code extension agent runs one link, sent to VS Code alone`: `front('vscode')`; `swipeSwitches(V1)` is true; `swipeEnded(V1, 'rest')`; `swiped('ok')`; `orcaRuns` is `[run of link(UUID)]`; `said()` is `['[device] swipe · ok']`. Red.
  - `two VS Code extension agents: a rest on each runs its own session's link exactly once, never the other's` (spec, decision 3's fake): rest on V1, `swiped('ok')`, rest on V2, wait for the second `ok`; `orcaRuns` is `[link(UUID) run, link(UUID2) run]`, nothing else. Red.
  - `another app in front, none, or no front known: no rest is asked for on a VS Code extension agent`: `swipeSwitches(V1)` false with no front, then after `front` of `'claude'`, `'orca'`, `'cursor'`, `'none'`; a rest asked all the same (`swipeEnded(V1, 'rest')`) is `swiped('failed')` and `orcaRuns` is empty.
  - `a front that changes during the rest runs none`: `front('vscode')`, `swipeSwitches(V1)` true, `front('orca')`, `swipeEnded(V1, 'rest')`, `swiped('failed')`, `orcaRuns` empty, the dial sent nothing more.
  - `a VS Code link still running drops the next rest for that agent: busy`: as the Claude app's busy test; then the release gives `ok`; `orcaRuns` holds the link once.
  - `a rest whose VS Code link fails stays failed, and brings nothing forward`: `exiting(1)`; `swiped('failed')`; `orcaRuns` is the link alone (no `['-b', VSCODE]` run).
  - `a session in VS Code's integrated terminal has no rest, with VS Code in front`: a third hook, `sessionId` `'7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b'`, `hostHints: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE }`; `front('vscode')`; its `swipeSwitches` is false.
  - `on Linux a VS Code extension agent has no rest`: `inVscode({ orca })`, `front('vscode')`, `swipeSwitches(V1)` false, nothing runs.
  - `no swipe line carries the session, the link or the bundle`: exits `[0, 1]`, two rests, `said()` is `['[device] swipe · ok', '[device] swipe · failed']`, and no log line holds `UUID`, `V1`, `vscode://` or `com.microsoft.VSCode`.
  - Run `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the edited tap tests and the rest tests marked red (`swipeSwitches` is false; the tap runs two commands).
- [ ] **Step 3: Commit** `test(dial): a rest shows a VS Code extension session by its link, sent to VS Code alone (red)`.
- [ ] **Step 4: Implement** `createVscodeAdapter` on `createAppLink` (Interfaces above), dropping its own `focus` and the imports only it used; update the file's header comment (a tap and a rest open the tab by the link sent to VS Code alone; a rest only while VS Code is in front; the link may change with any release). Wire `inFront` in `devices.ts`. In `observed.spec.ts` `fakeActions`, pass `{ ...deps, inFront: () => true }`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, 100% for `services/devices.ts`, and `observed.spec.ts`, `appLink.spec.ts`, `claudeApp.spec.ts`, `codexApp.spec.ts`, `open.spec.ts` pass with no test edited.
- [ ] **Step 6: Commit** `dial: a rest shows a Claude Code session in VS Code's extension tab while VS Code is in front`.

### Task 2: End to end: two extension sessions, each rest its own link

**Layer:** test: the real daemon, a fake dial, fake hooks, the harness's fake `open`. **Depends on:** 1. **Effort:** `high`.

**Red test:** this file, run once against the base's `vscode.ts` and `devices.ts` (Step 2). No production file changes; one commit.

**Files:**
- Create: `cli/e2e/dialVscodeFollow.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `CLI_ROOT`, `d.opens()` (`e2e/harness/daemon.ts`; `HARNESS_OPEN_BIN` is its fake, one line of arguments per run); `Desk`, `FakeDial`; `InOrca` (`e2e/harness/inOrca.ts`). Shapes to copy: `deviceHerdrApp.e2e.ts` (`a swipe with Herdr in front …`: Orca holds more agents so the ring's switch is the settle; `harness hardware watch --json` with `{ front: <bundle> }`; `dial.send({ t: 'focus', agentId })`; `said`), and `dialClaudeAppFollow.e2e.ts` (`fresh`, `inClaudeApp`, `watch`).
- `describe.skipIf(process.platform !== 'darwin')`: the link is macOS's, so off macOS no rest exists. The header comment says so, and that the real VS Code and `/usr/bin/open` never run.

- [ ] **Step 1: Write the test** `with VS Code in front, a rest on each extension session runs its own link once; with another app in front, none`.
  - `fresh()` as in `dialClaudeAppFollow.e2e.ts`: a daemon of its own (`env: { CABLE_DISABLE: 'false' }`), `HARNESSD_TEST_DIAL_PORT`, a dial plugged with `{ appFilter: 'v1' }`, its first `agents.end`. Check `isAbsolute(d.env.HARNESS_OPEN_BIN)` and that it is inside `d.root`, as the Herdr tap test does.
  - Three Orca sessions (`InOrca` with `ORCA_TERMINAL_HANDLE: term_<uuid>`, `__CFBundleIdentifier: 'com.stablyai.orca'`), each listed: Orca holds more agents than VS Code, so the ring's switch to VS Code is the settle.
  - Two extension sessions: `new InOrca(d, 'v1' | 'v2', children, { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', ORCA_AGENT_SESSION_ID: '' })` (`InOrca.sessionId` is a `randomUUID()`, lower case), each `hook('SessionStart', { source: 'startup' })`; wait for an `apps` frame, shown `'orca'`, counting `vscode` 2.
  - Start the watch; write `{ front: 'com.microsoft.VSCode' }`; wait for `apps` shown `'vscode'` and both rows.
  - Rest on v2: `dial.send({ t: 'focus', agentId: v2.id })`; wait for one `[device] swipe · ok`; `d.opens()` is `[['-b', 'com.microsoft.VSCode', \`vscode://anthropic.claude-code/open?session=${v2.sessionId}\`]]`.
  - Rest on v1: wait for the second `ok`; `d.opens()` is v2's run then v1's, each once.
  - Another app in front: write `{ front: 'com.stablyai.orca' }`, wait for `apps` shown `'orca'`; send `focus` for v1. Then write VS Code again and wait for `apps` shown `'vscode'` (the settle, 1 s, outlasts a rest's 400 ms): `d.opens()` still holds the two runs alone, and the log still has exactly two `[device] swipe ·` lines.
  - The daemon's log holds neither session id, no `vscode://` and no `[device] open · vscode · fallback`.
  - If a hand's `focus` is dropped (`cable: dropped dial focus` in the log) because the daemon's own `focus` after the ring switch awaits its echo, the fake dial first echoes that `focus` as a dial does; no wait of a fixed time.
- [ ] **Step 2: See it fail on the base's code:** `git checkout e9670ffd23 -- cli/src/cable/hosts/vscode.ts cli/src/services/devices.ts`, run the Step 3 command (Expected: FAIL, no `[device] swipe · ok`), then `git checkout HEAD -- cli/src/cable/hosts/vscode.ts cli/src/services/devices.ts` and `git status --short` shows only the new e2e file.
- [ ] **Step 3: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscodeFollow.e2e.ts`. Expected: PASS, one test, not skipped.
- [ ] **Step 4: Commit** `test(e2e): a rest with VS Code in front shows each extension session by its own link`.

### Task 3: The docs name the VS Code adapter

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none. No behavior changes. One commit.

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of its process table)
- Modify: `docs/specs/2026-11-15-device-host-adapter.md` (the adapter table under "The adapters")

- [ ] **Step 1: Edit `cli/AGENTS.md`.** In the `devices` row, after the Codex app's clause, add: a tap opens a Claude Code session in VS Code's extension tab by `vscode://anthropic.claude-code/open?session=<id>`, and a rest does while VS Code is in front (`cable/hosts/vscode.ts`, through `cable/hosts/appLink.ts`). Nothing else in the row changes.
- [ ] **Step 2: Add a `vscode` row** after `codex` in the adapter table: file `hosts/vscode.ts`; `paneOf` the engine `claude`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, VS Code's bundle id and a UUID session; `type` none; `focus` the link to VS Code alone (`open -b com.microsoft.VSCode <url>`) through `hosts/appLink.ts`, macOS only; `show` the link through `hosts/appLink.ts`, while VS Code is in front. Nothing outside the table changes.
- [ ] **Step 3: Check** `git diff --stat` lists these two files alone, and each name used matches Global Constraints.
- [ ] **Step 4: Commit** `docs(dial): the devices row and the adapter table name the VS Code extension's link`.

---

## Verification

**Platforms the pull request names:** macOS, where all of it runs. Linux and Windows: nothing runs and nothing a person sees changes; unit tests with `platform: 'linux'` and `'win32'` hold it (Task 1).

**Never touched by a tester or a test:** the real VS Code, the real Claude Code extension, `/usr/bin/open`, Diego's everyday daemon (port 18473), `~/.claude`, his dial, any backend, production.

**Temporary workflow:** none. The one end-to-end check needs macOS (the rest exists only there) and the repo's `cli-e2e.yml` runs on `ubuntu-latest`, where the file is skipped; it is about a minute, so it runs locally (PM decision).

**Local gates**, recorded in the pull request, on this Mac at the final head:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. It runs `cli-core` (`npm run test:core`, 100% per file under `src/core/` and `src/services/`). **Applies:** `cli/src/services/devices.ts` changes. Its receipt goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/hosts/appLink.ts cli/src/cable/hosts/open.ts cli/src/cable/hosts/observed.ts cli/src/cable/cableHost.ts cli/src/cable/cableSession.ts cli/hook` prints nothing.
- Not needed: `npm run test:harnessd`, desktop, firmware, device-app. No path of theirs changes.

**1. Two fake extension sessions, each rest its own link (tester, this Mac)**
- Run at the final head: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialVscodeFollow.e2e.ts`. `E2E_BUNDLE=1` builds the daemon that ships; `TMPDIR=/tmp` keeps its socket path short. About a minute.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, `cli/AGENTS.md` rules 5 and 6): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, `HARNESS_OPEN_BIN` a fake that records its arguments and opens nothing; no backend, no account, no secret. The VS Code sessions are hooks run by hand with VS Code's bundle id and `CLAUDE_CODE_ENTRYPOINT=claude-vscode`; the app in front is a line on the real `harness hardware watch --json`.
- Before and after the run, `pgrep -fl "Visual Studio Code"` reads the same.
- A person sees: one test passes, not skipped. On failure the daemon's log is printed.
- Also re-run, as they share the devices' wiring: `e2e/dialClaudeAppFollow.e2e.ts`, `e2e/dialAppFilter.e2e.ts`, `e2e/dialCodexApp.e2e.ts`, same command.

**2. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run Task 1's specs on Linux. Nothing is started by hand.

**3. Numbers:** none to take. No hot path gains work: `canShow` is one comparison at each look, and the link runs only on a rest or a tap.

**4. Diego's own check, on his Mac. Holds the merge.**
- **The owner's, not a tester's:** his VS Code with his own Claude Code extension sessions, his dial and his eye. The PM asks him once the pull request is ready. No tester and no agent runs it.
- What runs: the daemon built from the pull request's head (`make install-cli` in that checkout).
- With one VS Code window in front holding two Claude Code extension panels, a swipe from one to the other on the dial switches VS Code's tab to that session.

**5. Written in the pull request** (spec, decision 3): with two VS Code windows, a rest on a session whose panel is in the window behind opens a second tab on that session in the window in front, because VS Code hands the link to its last active window. The tap has had the same risk since #4336; the Harness VS Code extension's branch removes it. The link is undocumented and may change with any extension release.

**6. Against production:** none.
