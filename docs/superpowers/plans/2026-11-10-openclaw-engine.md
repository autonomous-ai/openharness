# OpenClaw Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenClaw becomes a Harness engine like OpenCode and Pi. It is found in a pane, started from New, streamed live, and has history, resume, search, and its name and icon on every client.

**Architecture:**
- The engine is a non-core folder, `cli/src/engines/openclaw/`, loaded only through `engines/inProcess.ts`.
- Harness's session id is the full key `agent:<agentId>:<key>`.
- A `node:sqlite` reader polls `transcript_events` past a cursor once a second. It follows the key to its current window and re-hydrates when a rewrite generation changes.
- A normalizer maps the Pi-style events to `LiveEvent`s, using Pi's turn rule.
- A pane is bound from its screen header, using a pattern `contract.ts` declares as data.
- Launch is `openclaw tui --session harness-<agentId>`. Resume is `openclaw tui <key>`.

**Tech Stack:** TypeScript on Node 24 (after the Node 24 plan), `node:sqlite`, `zlib` zstd, vitest and goldens, Flutter (Desktop, mobile), Rust (TUI).

**Spec:** `docs/superpowers/specs/2026-11-10-openclaw-engine-design.md`. **Depends on:** `docs/superpowers/plans/2026-11-10-node-24-runtime.md` being released.

## Global Constraints

- **The one rule** (`cli/src/engines/README.md`): every field, event type, tool name and screen line comes from a recording of the real binary (OpenClaw `2026.11.2` or newer).
- **Read only.** Harness writes nothing under the OpenClaw state folder and never deletes OpenClaw rows. The DB is opened read-only, with the bounded busy timeout.
- **Hands off the Gateway.** Harness never starts, stops or reconfigures it.
- **Architecture.** `cli/src/architecture.spec.ts` keeps passing. Core, `bind.ts` and `sessionRepair.ts` import only `engines/openclaw/contract.ts`, which is data only.
- **Clean fixtures.** No model key, no Gateway token, no personal content.
- **Idle cost.** Daemon at rest: ≤ 1% of one core with one idle bound OpenClaw pane, with numbers in the PR.
- **Named states**, exact copy:
  - `OpenClaw Gateway is not running. Start it with openclaw gateway.`
  - `OpenClaw has no Gateway token. Run openclaw onboard.`
  - `OpenClaw needs Node 24.`
  - `This OpenClaw runs on another machine.`
  - `This OpenClaw version is not supported yet.`
- **No commits until Ken asks.** "Commit" steps mean "stage for the PR".
- **Click-through tests.** Every Desktop feature gets a Flutter test that clicks through it as a person does.

## Review Focus

1. A key whose window changes mid-stream (`/new`, `reset`, `rewind`, `fork`). Expected: the stream continues with no duplicate or lost turn. An abandoned branch is not shown.
2. A run that aborts, fails or times out without an assistant row. Expected: the turn closes, and the tile leaves "Processing".
3. Heartbeat polls on `main`. Expected: no Processing and no notification.
4. A second pane showing a key that an agent already holds. Expected: the first pane stays bound, the second stays unbound, and nothing flips back and forth.
5. A row whose zstd does not decompress or whose JSON does not parse. Expected: one log line naming the key and seq, and the stream continues.

---

### Task 1: Record the fixtures from the real binary

**Files:**
- Create: `cli/scripts/record-openclaw-fixtures.mjs`. It runs inside the probe and reads the DB read-only with `node:sqlite`.
- Create: `cli/src/engines/openclaw/__fixtures__/`, containing:
  - `schema.sql` (the full `.schema` of the agent DB);
  - `<scenario>.sql`: `INSERT`s for every row of `session_nodes`, `session_windows`, `transcript_events`, `transcript_rewrite_watermarks` and `session_transcript_active_events` for that scenario's key. All columns are included, so STRICT and foreign keys hold, and blobs are written as `X'…'`;
  - `screen-<scenario>[-darwin|-win32].txt`, from `tmux capture-pane -p`;
  - `ps-<os>.txt`, the TUI process line and its open DB file on each OS.

- [ ] **Step 1: Bring up the probe.** Use `docker ps`. Reuse `openclaw-probe`, or recreate it from the spec's "Probe rig". Read the key from `.secrets/openrouter-key`, and never echo it.
- [ ] **Step 2: Record each scenario** under its own `--session` key, as a person would in the TUI:
  - `plain`;
  - `tool` (`exec`);
  - `multi-tool`;
  - `abort` (Esc mid-run);
  - `fail` (`/model` set to an id that does not exist);
  - `model-switch`;
  - `reset` (`/new`);
  - `rewind` (if the TUI offers it; else from `openclaw sessions --help`);
  - `main-heartbeat` (leave `main` idle until a heartbeat poll lands);
  - `approval` (an `exec-policy` that asks before `exec`);
  - `two-panes-main`;
  - `no-gateway`;
  - `no-token`;
  - `remote` (a TUI with `--url ws://<other-host>:18789`; screen only).
- [ ] **Step 3: Export** with `record-openclaw-fixtures.mjs`. Replace the bodies of `openclaw.system-prompt` and workspace file text in tool output with `<redacted>`, re-compressing a zstd row after you edit it. Check: `grep -rE "sk-or-|probe-token|OPENROUTER" cli/src/engines/openclaw/__fixtures__` prints nothing.
- [ ] **Step 4: Repeat on macOS and Windows** (VM at 192.168.65.3), and keep their screens, the `ps` line and the open-file evidence (`lsof -p` on macOS; on Windows, note whether the state DB handle can be read). If OpenClaw does not run natively on Windows, save the exact failure in `win32-unsupported.txt`.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: fixtures recorded from 2026.11.2`.

### Task 2: The contract and the engine id

**Files:**
- Create: `cli/src/engines/openclaw/contract.ts`
- Modify:
  - Enums and tables, each one a compile error once `ENGINES` has `openclaw`:
    - `cli/src/engines/types.ts:12`
    - `engines/facets/inlineRuntime.ts:31`
    - `engines/transcriptBindings.ts:17-30` (`openclaw: null`)
    - `lib/agentNames.ts:15` (`openclaw: 'OpenClaw'`)
    - `lib/engineBin.ts:22-36,73-85,445-477` (command `openclaw`, env `OPENCLAW_PATH`)
    - `lib/engineInstall.ts:43`: `{ command: 'npm install -g openclaw', source: 'https://openclaw.ai/', executable: { names: ['openclaw'], npmGlobal: true } }`
    - `lib/engineInstall.ts:153`: `{ npm: 'openclaw' }`
    - `lib/engineLaunch.ts:41,103,166` (no bypass flag; `FIRST_PROMPT_ARGS: ['--message']`; no named-agent args)
    - `dsh/adapters.ts:13-33` (no instruction file, no context args)
  - Manual edits:
    - `config/env.ts` (`OPENCLAW_PATH`; `OPENCLAW_STATE_DIR`, defaulting to `~/.openclaw`)
    - `lib/gridLaunch.ts:637-648`, refusing with `OpenClaw picks its own model`
    - `engines/windowsHomes.ts:21-25`
    - `engines/kit/nativeLocations.ts:25,49-54`
    - `cli/hook/notify.mjs:1508,1617` (engine name; `transcriptOptional`)
    - `backend/src/types/analytics.ts:20-21`
- Test: `cli/src/lib/engineBin.spec.ts`, `cli/src/lib/engineInstall.spec.ts`, `cli/src/architecture.spec.ts`

**Interfaces:**
- Produces, in `contract.ts` (data only):
  - `OPENCLAW_KEY = /^agent:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9._:-]{1,128})$/`, checked against every key in the fixtures.
  - `OPENCLAW_HEADER = /^\s*session (agent:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9._:-]{1,128})\s*$/m`, the pane header line.
  - `OPENCLAW_HEADER_URL = /^\s*openclaw tui - (wss?:\/\/\S+) - agent /m`.
  - `OPENCLAW_LAUNCH = { base: ['tui'], newSession: (agentId: string) => ['--session', \`harness-${agentId}\`], resume: (key: string) => [key] }`.
  - `openclawAgentDb(stateDir: string, agentId: string, agentDir?: string | null): string`.
  - `OPENCLAW_COLUMNS: Record<string, readonly string[]>`, the tables and columns the reader uses.

- [ ] **Step 1: Write the failing tests:**
  - `engineBin.spec.ts`: `finds openclaw on PATH and honours OPENCLAW_PATH`.
  - `engineInstall.spec.ts`: `openclaw installs with npm on every platform`.
  - In a new `contract.spec.ts`: `OPENCLAW_HEADER reads the key from every recorded screen`; `OPENCLAW_HEADER_URL tells a loopback Gateway from the remote fixture`; `OPENCLAW_KEY matches every key in the fixtures`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/lib/engineBin.spec.ts src/lib/engineInstall.spec.ts src/engines/openclaw/contract.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `npx tsc --noEmit` until it is clean. `engines/inProcess.ts` is not touched yet (Task 3 adds the module).
- [ ] **Step 4: Run them, and `architecture.spec.ts`, and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: contract and engine id`.

### Task 3: The reader

**Files:**
- Create: `cli/src/engines/openclaw/reader.ts`, `cli/src/engines/openclaw/inProcess.ts`
- Modify: `cli/src/engines/inProcess.ts:21,35-47` (`OTHER_ENGINES` and `MODULES`)
- Test: `cli/src/engines/openclaw/reader.spec.ts`. It builds a temp DB from `schema.sql` plus a scenario's `.sql`. Also `cli/src/engines/inProcess.spec.ts`.

**Interfaces:**
- Consumes: `openclawAgentDb` and `OPENCLAW_COLUMNS` (Task 2), and `node:sqlite` through `lib/sqliteRead.ts`'s builtin handle (no CLI fallback for this engine).
- Produces:
  - `type OpenclawEvent = { windowId: string; seq: number; record: Record<string, unknown> }`.
  - `readOpenclawEvents(db: string, key: string, after: { windowId: string; seq: number } | null): Promise<OpenclawEvent[]>`. It finds the current window from `session_nodes.current_session_id`, then reads `WHERE session_id = ? AND seq > ?` and its active events, `ORDER BY seq LIMIT 500`. Hidden rows are filtered in SQL on `navigation_custom_type`/`message_role` before decompressing.
  - `readOpenclawHistory(db: string, key: string): Promise<OpenclawEvent[]>`: the active branch, across the window chain (`previous_session_id`).
  - `class OpenclawReader`:
    - `constructor(deps: { db: string; key: string; onEvents(events: OpenclawEvent[]): void; onTurnStarted(): void; onFatal?(reason: 'unsupported' | 'missing'): void; pollMs?: number })`;
    - members `start(): Promise<void>` and `stop(): void`.

    It owns no turn state: the normalizer does (Task 4).
    - `start()` hydrates the history silently, but calls `onTurnStarted()` if the last run is still open, as `OpencodeReader.hydrate` does.
    - It then polls every `pollMs` (default 1000). On each tick it reads the current window and the rewrite generation of `transcript_rewrite_watermarks`. A new window is read from seq 0. A changed generation re-hydrates and emits only what is new.
  - `onFatal('unsupported')` is called when a column in `OPENCLAW_COLUMNS` is missing. The schema version is logged once, never refused.
- `inProcess.ts` re-exports `OpenclawReader`, `readOpenclawEvents` and `readOpenclawHistory`. Tasks 4, 5 and 6 add their names when they land.

- [ ] **Step 1: Write the failing tests:**
  - `reads only rows past the cursor`
  - `decompresses zstd assistant rows`, against the `tool` fixture
  - `filters hidden rows before decompressing` (spy on the decompress call: never for an `openclaw.system-prompt` row)
  - `follows the key to the new window after reset` (each event once, in order)
  - `re-hydrates on a rewind and never emits the abandoned branch`
  - `skips a row that does not decompress and logs once`
  - `reports a missing column as unsupported`
  - `start emits turn started when attached mid-run`
  - `inProcess loads openclaw only through inProcess`
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/engines/openclaw/reader.spec.ts src/engines/inProcess.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the structure of `engines/opencode/reader.ts`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: SQLite reader`.

### Task 4: The normalizer

**Files:**
- Create: `cli/src/engines/openclaw/normalizer.ts`
- Test: `cli/src/engines/openclaw/normalizer.spec.ts`

**Interfaces:**
- Consumes: `OpenclawEvent` (Task 3), and `LiveEvent` (`lib/normalize.ts`).
- Produces:
  - `class OpenclawNormalizer { push(events: OpenclawEvent[]): LiveEvent[]; readonly turnOpen: boolean; closeTurn(reason: 'aborted' | 'failed' | 'timeout'): LiveEvent[] }`. It is the one owner of turn state.
  - `lastOpenclawTurnText(events: OpenclawEvent[]): string | null`.
  - `openclawMessagesToEvents(events: OpenclawEvent[]): LiveEvent[]` and `windowOpenclawEvents(events: OpenclawEvent[], limit: number): OpenclawEvent[]`, for history.

The mapping comes from the spec's "Event shapes". If a fixture disagrees, the fixture wins.
- The turn ends on an assistant `stopReason` other than `toolUse` once no `toolCall` is unanswered: Pi's rule (`engines/pi/normalizer.ts:107`).
- A heartbeat run is skipped whole: a user row with `__openclaw.senderIsOwner:false` and the heartbeat text, plus the run's `heartbeat_respond` call and its reply.

- [ ] **Step 1: Write the failing tests**, one per fixture:
  - `plain`;
  - `tool` (tool start/end and output);
  - `multi-tool`;
  - `model-switch` (the model changes once);
  - `fail` and `abort`: after `closeTurn`, nothing is left open;
  - `main-heartbeat`: no events at all;
  - `hidden rows never become turns`;
  - `two user messages before an answer make one turn`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/engines/openclaw/normalizer.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the structure of `engines/pi/normalizer.ts`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: normalizer`.

### Task 5: Screen: states, model and the workspace label

**Files:**
- Create: `cli/src/engines/openclaw/runtimeProfile.ts`. Create `askQuestion.ts` only if the `approval` fixture shows a dialog Harness can answer.
- Modify:
  - `cli/src/lib/legacyPane.ts:6` (an `openclaw` branch);
  - `cli/src/lib/runtimeProfileWire.ts:6`;
  - `cli/src/lib/questionPane.ts` and `lib/questionController.ts:~476`, only with `askQuestion.ts`.
- Test: `cli/src/engines/openclaw/runtimeProfile.spec.ts`

**Interfaces:**
- Produces:
  - `openclawPaneState(capture: string): 'ready' | 'busy' | 'no-gateway' | 'no-token' | 'remote' | null`;
  - `createRuntimeProfileReader(...)`, exported as `engines/pi/runtimeProfile.ts` does: the model from the footer, and tokens `<used>/<window>`. It handles the footer wrapping at 80 columns.
  - The agent's workspace label, from the window's seq-0 `cwd`, exposed through the runtime profile.

- [ ] **Step 1: Write the failing tests** against every `screen-*.txt` (Linux, darwin, win32):
  - each state;
  - the model `deepseek/deepseek-v4.1-flash`;
  - tokens at 160 and at 80 columns;
  - `null` for a non-OpenClaw screen.
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/engines/openclaw/runtimeProfile.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and add the names to `openclaw/inProcess.ts`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: pane states, model and workspace label`.

### Task 6: Core wiring: discovery, binding, live, history, last turn, input, search

**Files:**
- Modify:
  - **Discovery.** `cli/src/lib/processTable.ts:~565-610`: basename `openclaw`. The TUI renames itself, so there is no entrypoint; check the pattern against `ps-*.txt`. No `RESUME_ARGS` entry: argv is hidden.
  - **Binding.** `cli/src/core/agents/bind.ts`: for `openclaw`, read the key from the pane capture with `OPENCLAW_HEADER`. A key that existed before the process is accepted (no `bornOnly` for this engine). A key an agent already holds leaves the new pane unbound, so `mayClaim` gives no takeover. A non-loopback `OPENCLAW_HEADER_URL` gives the `remote` state.
  - **State folder.** `cli/src/lib/sessionRepair.ts:411`: the state folder comes from the TUI process's open `state/openclaw.sqlite`. On Linux that is `/proc/<pid>/fd`; on macOS, `lsof -p <pid> -Fn` with a 2 s timeout. Otherwise use the pane's `OPENCLAW_STATE_DIR`, then `~/.openclaw`. The agent folder comes from `openclawAgentDb`, with `agentDir` read from `openclaw.json` (read-only).
  - **Transcripts.** `core/main.ts:306-309,1357,1371,1483,2864` (`dbs.openclaw`). In `core/transcripts/attach.ts` add an `openclaw` branch beside opencode's at `:411-430`. In `core/transcripts/normalizers.ts` add an `openclawReaders` map, with `turnOpen`, stop and `closeTurn` going to `OpenclawNormalizer`. Also `core/transcripts/history.ts:117` (the `databases` entry using `readOpenclawHistory`), `core/transcripts/lastTurn.ts:44`, and the `dbs` types in `history.ts:39`, `lastTurn.ts:22` and `attach.ts:58`.
  - **Input.** `lib/sessionInput.ts:822,896`: the submit window, and trusting the reader's `turn_started`, as for opencode.
  - **Other lists.** `lib/agentTokenUsage.ts` (token usage from the assistant `usage`), `lib/registry.ts:1386,1989` (transcript path optional), `lib/sessionTitle.ts:26,30,162`, `lib/databaseHistory.ts:22-30`, `lib/sessionCheckpoint.ts:26-27` and `lib/worktreeDeletion.ts:98` (protect the state folder).
  - **Search.** `lib/sessionSearch/externals/types.ts:17` and `index.ts:56-57,111-116`.
- Do not modify:
  - `lib/purgeAgentService.ts` (it would delete OpenClaw rows);
  - `core/transcripts/ingest.ts` (JSONL only);
  - `core/main.ts:2697` `PANE_POLLED_ENGINES` (the model comes from the DB);
  - `lib/oneshot.ts` and `lib/disposableOneShotPool.ts` (no recap worker).
- Create: `cli/src/lib/sessionSearch/externals/openclaw.ts` (`openclawProvider`). It skips `created_via` `spawn|cron|internal`, and reads `session_transcript_fts` when the fixtures show it holds the text.
- Test: create `cli/src/core/transcripts/openclaw.spec.ts`, and add cases to `cli/src/core/agents/bind.spec.ts`.

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `dbs.openclaw: (key: string, pane: { pid: number; env?: Record<string, string> }) => Promise<string | null>`.

- [ ] **Step 1: Write the failing tests.**
  - `openclaw.spec.ts`:
    - `a bound openclaw pane streams the tool fixture end to end`
    - `a phone message to an openclaw agent is accepted on the reader's turn_started`
    - `history and last turn read across a reset`
  - `bind.spec.ts`:
    - `binds an openclaw pane to main from its header`
    - `a second pane on the same key stays unbound and the first keeps it`
    - `a remote Gateway header gives the remote state`
    - `finds the state folder from the TUI's open database` (fake `/proc` and `lsof`)
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/core/transcripts/openclaw.spec.ts src/core/agents/bind.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Wire** the files above.
- [ ] **Step 4: Run them and see them pass, then the goldens.** Re-record, each with the `RECORD_*_GOLDEN=1` named in its header:
  - `discovery`
  - `transcript-reads`
  - `session-store`
  - `other-transcripts`
  - `other-identity`
  - `other-screens`
  - `repair-identity`

  Read every diff: each new line is `openclaw`, and no other engine's line changed. Then run `architecture.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: discovery, binding, live stream and search`.

### Task 7: Launch and resume

**Files:**
- Modify:
  - `cli/src/lib/engineLaunch.ts:384` (`buildEngineCommandArgv`), to take `OPENCLAW_LAUNCH.base`;
  - `cli/src/core/agents/launches.ts:360,506`. A new OpenClaw agent's key is Harness-chosen (`harness-<agentId>`), not a resume, and goes with a first prompt and a folder;
  - `cli/src/engines/nativeLaunch.ts:117-122` (env names `OPENCLAW_STATE_DIR`, `OPENCLAW_PATH`);
  - `cli/src/core/agents/create.ts`.
- Test: create `cli/src/engines/openclaw/launch.spec.ts`; re-record the `launch-argv`, `launch-shapes`, `launch-prep`, `dsh-launch-shapes`, `other-launch`, `native-launch-compatibility` and `exact-resume` goldens.

**Interfaces:**
- Produces:
  - New: `['openclaw', 'tui', '--session', 'harness-<agentId>']`, plus `['--message', task]` when there is a first task.
  - Resume: `['openclaw', 'tui', '<agent:…:key>']`.

- [ ] **Step 1: Write the failing tests:**
  - `a new OpenClaw agent gets its own key and keeps its folder`
  - `a first task goes in --message`
  - `resume reopens the same key, also after a reset`
  - `no Gateway gives the named state` (the `no-gateway` screen → `OpenClaw Gateway is not running. Start it with openclaw gateway.`)
  - `openclaw on an old Node gives the named state` (the engines error from Task 1 → `OpenClaw needs Node 24.`)
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/engines/openclaw/launch.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then re-record the launch goldens and read their diffs.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: launch and resume`.

### Task 8: Clients: name, icon, workspace label and New

**Files:**
- Create: `desktop/assets/engine-icons/openclaw.png` and `mobile/assets/engine-icons/openclaw.png`, from OpenClaw's repo logo. Record its license in the PR.
- Modify:
  - **Desktop:**
    - `desktop/lib/widgets/engine_identity.dart:97-183`: label `OpenClaw`, creator `OpenClaw`, homepage `https://openclaw.ai/`.
    - `desktop/lib/state/new_harness.dart:3590-3610`: the picker list.
    - `desktop/lib/core/first_task.dart:8`.
    - The agent row's workspace label, beside the agent's folder, wherever the runtime profile's model is shown today.
  - **Mobile:** `mobile/lib/widgets/engine_identity.dart:30-50`, `mobile/lib/core/first_task.dart:15`.
  - **TUI:**
    - `tui/src/modal.rs:213`: the array length changes.
    - `tui/src/theme.rs:~1272,~1304`.
    - `tui/src/app.rs:6265`.
    - `tui/src/shell_integration.sh:174,225-242,385`.
  - **Store:** `store/tools/presentation.mjs:32`, `store/agents/harness-monitor/lib/panes.mjs:99`, `store/agents/harness-monitor/viewer/app.js:121`.
  - **Design:** `desktop/design/desktop-design-system.md` and its gallery, if the workspace label is a new element (anh Dee's rule).
- Test:
  - create `desktop/test/new_harness_openclaw_test.dart`;
  - `mobile/test/engine_identity_test.dart`;
  - `cd tui && cargo test engine`.

- [ ] **Step 1: Write the failing tests.**
  - Desktop, `a person starts OpenClaw from New`:
    1. open New, pick a folder, tap `OpenClaw` and start;
    2. expect the create request's engine to be `openclaw`;
    3. expect the new row to show the OpenClaw icon and the workspace label.
  - Desktop, `New offers to install OpenClaw when it is missing`.
  - Desktop, `New shows OpenClaw needs Node 24 when the daemon reports it`.
  - The mobile and TUI identity tests.
- [ ] **Step 2: Run them and see them fail.** Run: `cd desktop && flutter test test/new_harness_openclaw_test.dart`, then `cd mobile && flutter test test/engine_identity_test.dart`, then `cd tui && cargo test engine`. Expected: FAIL.
- [ ] **Step 3: Implement.** On Windows, if Task 1 saved `win32-unsupported.txt`, the daemon reports the engine unavailable on win32 with that reason, and New shows it disabled with the reason.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `OpenClaw: name, icon, workspace label and New on every client`.

### Task 9: End to end, numbers, docs and receipts

- [ ] **Step 1: Docs.** Add OpenClaw's lessons to `cli/src/engines/README.md`:
  - the SQLite store and its rewrites;
  - the TUI that hides its argv;
  - the shared `main` key and heartbeats;
  - the agent loop living in the Gateway;
  - finding the state folder from the TUI's open database.
- [ ] **Step 2: E2E on macOS with a real login.**
  1. Install OpenClaw with Harness's recipe, then run `openclaw onboard`.
  2. Start it from New on Desktop, and give it a task with a tool call. Watch it on Desktop, on the phone (simulator, memory `ios-simulator-xcode27`) and on web.
  3. Send a message from the phone.
  4. Stop it and resume it.
  5. Open a plain `openclaw tui` in a terminal pane. Check it is found on `main`, then open a second plain one and check it stays unbound.
  6. Wait for a heartbeat. Expect no notification.
  7. Stop the Gateway, and check the named state.

  Record screenshots.
- [ ] **Step 3: The same on Linux** (a docker box) **and Windows** (the VM). On Windows, record the session's windows during launch: none opens.
- [ ] **Step 4: Idle numbers.** Run the daemon for 10 minutes with one idle bound OpenClaw pane, against the same machine with none. Expected: ≤ 1% of one core, with the difference within noise. Put both in the PR.
- [ ] **Step 5: Gates.** Run once: `cd cli && npm run test:core && npm run test:resume && npm run test:portability`, plus Desktop's macOS tests. Compare against a clean `main` worktree, and record the receipts.
- [ ] **Step 6: Clean up the probe**, once the fixtures are final: `docker rm -f openclaw-probe`.
