# Dial voice: ten minutes of speech reach the agent, and Free gets 30 minutes a day — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** A transcript of any recording within the dial's 10-minute cap reaches an agent outside Harness whole, on every host path, and the dial hears it was sent; over 20,000 characters it is still refused with "Too long. Say it shorter."; the Free plan allows 30 minutes of voice a day.

**Architecture:**
- **One cap, 20,000 UTF-16 units** (`text.length`): `MAX_TEXT` in `cli/src/cable/hosts/orca.ts`, which every host path already reads, and the core's own copy in `cli/src/core/deviceHookCalls.ts` (the core imports nothing from `cable/`). The review draft (`cli/src/cable/voiceDraft.ts`) counts characters against the same `MAX_TEXT` instead of 16,000 bytes. No path chunks or cuts.
- **The cable session** (`cli/src/cable/cableSession.ts`) keeps a recording that runs to the dial's own stop (`VOICE_MAX_BYTES` gains 15 s), and its `voice.transcript` loses `text` when the frame would pass the cable's 8 KB cap, so the dial still hears "sent".
- **Backend:** Free's `dailyVoiceLimitSeconds` and the fallback for an account with no readable plan go from 10 to 30 minutes. The worker's `ensurePlans()` writes the row at the next release; no migration.
- Devices process, one number in the core, the backend. No firmware change.

**Tech Stack:** TypeScript (Node, vitest) in `cli/` and `backend/`. No new dependency.

**Spec:** `docs/plans/2026-11-19-dial-voice-ten-minutes-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core, rules 3 and 7; Rules 4 to 6) and `backend/AGENTS.md`.

**Open questions:** one, at the end of this plan (Windows). This draft takes its recommended answer.

## Base

- Branch `fix/dial-voice-ten-minutes` at `36c4c41a3c`, worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-voice-length`. Nothing else has to merge first. (`origin/main` has moved since; integrating it is phase 5's.)
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` and `cd backend && npm ci --no-audit --no-fund` (neither has `node_modules`). One process per folder, never two tasks at once.
- Names at the base (the tasks name functions, never lines):
  - `cable/hosts/orca.ts`: `MAX_TEXT`, `CONTROL`, `RUN_TIMEOUT_MS`, `createOrcaActions` (`send`). Readers of `MAX_TEXT`, unchanged by this plan: `observed.ts`, `herdrSource.ts`, `hcSource.ts`, `cmuxSource.ts`, `opencodeSource.ts`, `herdrClient.ts`, `hcClient.ts`, `cmuxApp.ts`, `opencodeClient.ts`, `codexQueue.ts`.
  - Host specs: `orca.spec.ts` `recorder`, `HANDLE`; `codexQueue.spec.ts` `recorder`, `THREAD`, `REFUSED`; `herdrClient.spec.ts` / `hcClient.spec.ts` `client`, `server`; `opencodeClient.spec.ts` `start`, `found`, `routes`, `opencodeMessageId`; `cmuxApp.spec.ts` `recorder`, `PANE`; `observed.spec.ts` `fakeActions` (`toMod`, `orcaSend`, `codexQueue.send`), `setup`, `ev`, `withHandle`, `given`, `cx`, `counted`; the `voice` tests of `herdrSource.spec.ts`, `hcSource.spec.ts`, `opencodeSource.spec.ts` (`sent`, `refused`, the prompt fake, `server.got`); `cmuxSource.spec.ts` `describe('words, a tap and a rest')`, `setup`, `started`, `record`, `s.prompt`.
  - `services/devices.spec.ts`: `withHerdr`, `withHc`, `withOpencode`, `listed`, `host`, `said`, the fakes' `asked` / `prompted`; its three voice tests `the dial's words reach an idle herdr agent…`, `…an idle Herdr agent…`, `…a session at rest…`.
  - `core/deviceHookCalls.ts`: `MAX_TEXT` (2,000, module-private), `createDeviceHookCalls().onInbox`; spec `setup`, `live`, `a text over 2000 characters or not a string is {}`.
  - `cable/voiceDraft.ts`: `MAX_BYTES`, `PART_BYTES`, `spans`, `valid`, `VoiceDraft.create` / `edit` / `command`; spec `setup`.
  - `cable/cableSession.ts`: `VOICE_MAX_BYTES`, `onPcm`, `finishVoice` (its `reply`, its two `voice.transcript` replies), `withinCap`, `send`; `CABLE_MAX_PAYLOAD` in `cableFrame.ts`. `cableSession.spec.ts`: `LoopbackPort` (`say`, `pcm`, `sent`, `types`), `makeHost`, `connect`, `settle`, `AGENTS`.
  - Backend: `lib/db/seed.ts` `CAMPAIGN_TIERS`, `seedLocalPlans`, `ensurePlansForEnvironment`; `lib/voiceQuota.ts` `FALLBACK_USER_LIMIT_SECONDS`, `limitForUser`; `routes/voice.test.ts` `FREE`, `PRO`, `MAX`, `send`, `wav`, `usedSeconds`, `voiceInflightBytes`; `lib/db/seed.test.ts` `planDb`, `fetchPlans`, `FULL_CATALOG`; `services/MachineBillingService.test.ts` `freePlan`.
  - `cli/e2e`: `deviceWithoutApp.e2e.ts` `fresh`, `startOutside`, `inboxPoll`, `showing`, `heard`; `deviceCmux.e2e.ts` `ME`, its `fresh` (the sign-in) and `speak`; `harness/fakeBackend.ts` `FakeBackend` (`start`, `addMachine`, `speech`, `wsUrl`, `httpUrl`, `close`), `FakeMachine`; `harness/outsideAgent.ts` `Outside`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 Every host path takes 20,000 characters | `cli/src/cable/hosts/orca.ts`; specs: `orca`, `codexQueue`, `herdrClient`, `hcClient`, `opencodeClient`, `cmuxApp`, `observed`, `herdrSource`, `hcSource`, `opencodeSource`, `cmuxSource` (all `cli/src/cable/hosts/*.spec.ts`), `cli/src/services/devices.spec.ts` | none | high | the twelve specs |
| 2 The core's inbox answer holds 20,000 characters | `cli/src/core/deviceHookCalls.ts`, `deviceHookCalls.spec.ts` | none | medium | `deviceHookCalls.spec.ts` |
| 3 The review draft counts characters, up to `MAX_TEXT` | `cli/src/cable/voiceDraft.ts`, `voiceDraft.spec.ts` | 1 | medium | `voiceDraft.spec.ts` |
| 4 A recording to the dial's stop is kept, and a long transcript's "sent" fits the cable | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts` | none | high | `cableSession.spec.ts` |
| 5 Free gets 30 minutes of voice a day | `backend/src/lib/db/seed.ts`, `backend/src/lib/voiceQuota.ts`, `backend/src/lib/db/seed.test.ts`, `backend/src/routes/voice.test.ts`, `backend/src/services/MachineBillingService.test.ts` | none | high | `seed.test.ts`, `voice.test.ts` |
| 6 End to end: a 10,000-character transcript reaches the mod whole | `cli/e2e/deviceWithoutApp.e2e.ts` | 1, 2, 4 | high | the new e2e test, run against the base's three source files |
| 7 The timing write-up for the PR | `docs/plans/2026-11-19-dial-voice-ten-minutes-timing.md` (new) | none | medium | none: docs only, one commit |

Longest chain: two tasks (1 → 3, and 1, 2, 4 → 6).

- Tasks 1, 2, 4, 5 and 7 start at once. Task 3 after 1. Task 6 after 1, 2 and 4.
- No two tasks share a file. A dependency is a value or a behavior: Task 3 imports `MAX_TEXT` and its tests need it at 20,000 (1); Task 6 needs the hosts (1), the core (2) and the frame (4) to pass.
- A run that reads another task's file (Task 4's `cableSession.spec.ts` reads `voiceDraft.ts`) reports a failure there; it does not edit it.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/orca.ts`, `cli/src/cable/voiceDraft.ts`, `cli/src/cable/cableSession.ts` | **Devices service process** | their specs (PR CI `cli-tests`, Linux) |
| `cli/src/services/devices.spec.ts` | test of the devices service | 100% per file (`npm run test:core`, local) |
| `cli/src/core/deviceHookCalls.ts` | **Core process** (`core/main.ts` loads it): one number in an existing bound, no new rule, list or record (core rule 7), no line of `architecture.coreFiles.txt` changes | 100% per file (`npm run test:core`, local) |
| `backend/src/lib/db/seed.ts`, `backend/src/lib/voiceQuota.ts` | **Backend** (worker start and the STT route), Linux | PR CI `backend-desk`, `backend-integration` |
| `cli/e2e/deviceWithoutApp.e2e.ts` | test: the real daemon, a fake dial, a fake backend, the suite's fake Claude Code | Verification 1 and 2 |
| `docs/plans/2026-11-19-dial-voice-ten-minutes-timing.md` | docs | review |

Not changed, and a diff in any is a finding: any other file under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, the readers of `MAX_TEXT` listed in Base, `cli/src/cable/hosts/inbox.ts`, `cli/src/cable/cableHost.ts`, `cli/src/cable/questionInbox.ts`, `cli/src/services/router.ts`, `cli/e2e/harness/`, `plugins/`, anything under `devices/` (firmware), `backend/prisma/`, `backend/src/routes/voice.ts`, `backend/src/lib/sttTimeout.ts`.

## Global Constraints

- **The cap:** `MAX_TEXT = 20_000` UTF-16 units (`text.length`), one exported constant in `cli/src/cable/hosts/orca.ts`, read by every host path; `cli/src/core/deviceHookCalls.ts` keeps its own `MAX_TEXT = 20_000`, whose comment names the one it matches. Over the cap the text is refused whole, never cut or chunked.
- **Copy, unchanged:** `Too long. Say it shorter.` (every host), `Record a shorter message to review.` and `That edit is too long. Try a shorter part.` (the draft), `Some words cannot display. Edit them before sending.` (the draft's Latin-1 check at Send, kept), `Didn't catch that` (an empty or dropped recording).
- **Audio:** `VOICE_MAX_BYTES = (10 * 60 + 15) * 32_000` (19,680,000 bytes). Over it the recording is dropped and logged as today.
- **The frame:** a `voice.transcript` whose JSON is over `CABLE_MAX_PAYLOAD - 256` UTF-8 bytes loses `text` and nothing else, on both routes. Neither firmware reads `text`.
- **Backend:** Free `dailyVoiceLimitSeconds` and `FALLBACK_USER_LIMIT_SECONDS` are `30 * 60`; Pro stays `30 * 60`. No migration, no script, no release, no deploy.
- **Logs:** this plan adds no log line. Any line a task does add has ids and counts only, and a failure is `errorKind(err)` (`cli/src/lib/log.ts`), never its message, path or stack: `cli/src/architecture.failureLogs.spec.ts` (#4488) stays green. No test or log holds a transcript.
- **Never the person's own:** no test runs or reads the real Claude Code, Codex, Orca, herdr, Herdr, cmux, opencode or VS Code, `~/.claude`, `~/.codex`, Diego's daemon (port 18473), dial or terminals. The e2e uses the suite's throwaway home, data folder and port, a fake dial, a fake backend and the suite's fake Claude Code.
- **Repo rules:** test first, at the layer where the behavior lives; no fixed sleeps; comments say why; `src/core` and `src/services` stay at 100% per file.

## Review Focus

1. **A transcript in Vietnamese, or with emoji.** Counted in UTF-16 units for the cap, but up to 3 bytes each on the cable: 3,000 such characters already pass 8 KB. Expected: delivered, and the dial still hears `voice.transcript`. Task 4 (`'ệ'.repeat(3_000)` loses `text` by bytes); Task 3 (`'é'.repeat(10_000)`, 20,000 bytes, is a valid draft).
2. **A recording run to the dial's own stop**, which lands on a tick after 600 s. Expected: transcribed, never dropped. Task 4, the 601 s recording.
3. **A spoken draft grown by appends past 20,000 characters.** Expected: `That edit is too long. Try a shorter part.`, the old draft kept at its revision. Task 3, `bounds cumulative edits…`.
4. **No agent named: the window picks and delivers a long transcript.** Expected: the dial is told sent, as on the direct route. Task 4, the window's route case.
5. **The core's cap and the hosts' drift apart.** The mod path would then drop the words silently (the core answers `{}`, the inbox counts them taken). Expected: both are 20,000, each pinned by a test with the literal number: Task 1 (`MAX_TEXT` is `20_000`), Task 2 (20,000 answered, 20,001 `{}`), and Task 6 end to end.

## Decided (the PM, 2026-11-19)

The spec's "Decisions" and the brief: (1) the cap is 20,000 characters, one shared constant in `cable/hosts/orca.ts`, the core's own copy at the same value, the same refusal, no chunking; (2) `voiceDraft.ts` drops `MAX_BYTES` and checks `text.length <= MAX_TEXT`; (3) `VOICE_MAX_BYTES = (10 * 60 + 15) * 32_000`, and `withinCap` drops `text` from a `voice.transcript` over `CABLE_MAX_PAYLOAD - 256`, both sends in `finishVoice` through it; (4) Free = Pro = 30 minutes in `seed.ts` and `voiceQuota.ts`, no migration, no release or deploy; (5) no firmware change; the PR records the upload and transcription times for 2, 5 and 10 minutes, an assessment of `STT_TIMEOUT_MS = 60_000` for 10 minutes of audio, and the follow-up proposal, before merge; (6) logs as in Global Constraints.

## Decided here, where the spec was silent

- **Which numbers prove what.** A source's red test delivers 10,000 characters (the customer's case) and 20,000 (the cap); a client's delivers 20,000. Every refusal guard reads `MAX_TEXT + 1`, so it holds before and after. The core's spec uses the literal numbers: a core spec imports nothing from `cable/`.
- **`devices.spec.ts`** gets one new test beside each of its three voice tests, so their refusal counts and `said()` lists stay as they are.
- **`withinCap` drops `text` silently**, as it drops a summary's `full`: the frame still arrives, so nothing failed and no line is logged.
- **The audio-cap tests** feed the session PCM frames of 8,000 bytes through `LoopbackPort.pcm`, as the dial does, never by calling `onPcm`.
- **The e2e's agent** is the suite's fake Claude Code with `TERM_PROGRAM=vscode`, the customer's terminal, in its own environment only. Its words go through its mod as in every terminal. The harness already points the daemon's VS Code at its own fake (`HARNESS_VSCODE_BIN`).
- **`MachineBillingService.test.ts`'s `freePlan`** follows the row to 1,800: it is a fixture that names the Free allowance. Nothing in that service changes.
- **The unlimited-plan test** in `voice.test.ts` is raised to 2,360 s, so it still proves "unlimited" above Free's new 1,800.
- **The timing write-up** is a doc of its own (Task 7), so no task edits the spec the main session commits; the PR body carries it.

---

### Task 1: Every host path takes 20,000 characters

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (every host path's refusal and its fakes, twelve spec files).

**Red tests:** the twelve specs below.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts` (`MAX_TEXT` and its comment only)
- Test: `cli/src/cable/hosts/orca.spec.ts`, `codexQueue.spec.ts`, `herdrClient.spec.ts`, `hcClient.spec.ts`, `opencodeClient.spec.ts`, `cmuxApp.spec.ts`, `observed.spec.ts`, `herdrSource.spec.ts`, `hcSource.spec.ts`, `opencodeSource.spec.ts`, `cmuxSource.spec.ts`; `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces: `export const MAX_TEXT = 20_000` in `orca.ts`. Its comment says what sizes it: about 13,000 characters of fast speech in 10 minutes (200 words a minute, ~6.5 characters a word), plus a carried passage or selection (up to 4,096 bytes, each line quoted), plus margin; and that `core/deviceHookCalls.ts` holds the same number for the mod's poll. Task 3 imports it.

- [ ] **Step 1: Write the failing tests.** Each spec imports `MAX_TEXT` from `./orca.js` (`devices.spec.ts` from `../cable/hosts/orca.js`, its type import becoming a value import) where it needs it.

| Spec | Red (fails today) | Guard (rewritten; passes before and after) |
|---|---|---|
| `orca.spec.ts` | `MAX_TEXT` is `20_000`; `orca.send(HANDLE, 'a'.repeat(20_000))` is `true`, and its one run's arguments hold `` `--text=${'a'.repeat(20_000)}` `` | `'a'.repeat(MAX_TEXT + 1)` is `false`, nothing run; the test is named `a text over MAX_TEXT characters runs nothing` |
| `codexQueue.spec.ts` | `queue.send(THREAD, 'a'.repeat(20_000), false)` is `{ outcome: 'queued' }`, its run's arguments hold `` `--message=${'a'.repeat(20_000)}` `` | `'a'.repeat(MAX_TEXT + 1)` is `REFUSED`, nothing run |
| `herdrClient.spec.ts` | `herdr.prompt('w1:p1', 'claude', 'x'.repeat(20_000))` is `{ outcome: 'sent' }`; the fake server's `agent.prompt` request holds the 20,000 characters whole | `'x'.repeat(MAX_TEXT + 1)` is `bad_request`, nothing connects |
| `hcClient.spec.ts` | `hc.prompt('t7', 'claude', 'x'.repeat(20_000))` is `{ outcome: 'sent' }`; the fake's `terminal.send` request holds them whole | `'x'.repeat(MAX_TEXT + 1)` is `bad_request`, nothing connects |
| `opencodeClient.spec.ts` | `opencode.prompt('ses_a1', 'x'.repeat(20_000), id)` is `'sent'`; the POST's body text is whole | `'x'.repeat(MAX_TEXT + 1)` is `'failed'`; `routes(server)` is `['GET /api/info']` |
| `cmuxApp.spec.ts` | `adapter.prompt(PANE, 'claude', 'x'.repeat(20_000))` is `'sent'`; its `paste` holds the text whole | `'x'.repeat(MAX_TEXT + 1)` is `'no-answer'`, nothing asked |
| `observed.spec.ts` | new `a text of 10,000 or 20,000 characters reaches the mod, Codex's queue and an Orca terminal whole`: for each length, `{ ok: true }`, and `actions.toMod`, `actions.codexQueue.send` and `actions.orcaSend` each called with the text whole | the four `repeat(2001)` become `repeat(MAX_TEXT + 1)`; the two tests named `over 2000 characters` say `over MAX_TEXT characters` |
| `herdrSource.spec.ts`, `hcSource.spec.ts`, `opencodeSource.spec.ts` (each `voice` test) | at the idle agent, `'x'.repeat(10_000)` and `'x'.repeat(20_000)` are `{ ok: true }`, and the prompt fake's call (opencode: `server.got(POST, n).body.text`) holds each whole; the test's later counts follow | `refused('Too long. Say it shorter.', 'x'.repeat(MAX_TEXT + 1))` is `0` |
| `cmuxSource.spec.ts` | new in `words, a tap and a rest`: an idle agent takes `'x'.repeat(10_000)` and `'x'.repeat(20_000)`, `{ ok: true }`, `s.prompt` called with each whole | `send refuses by its own state before any prompt` uses `MAX_TEXT + 1` |
| `services/devices.spec.ts` | new beside each of the three voice tests: `a 10,000-character text reaches an idle herdr agent whole` (Herdr app: `…an idle Herdr agent whole`; opencode: `…a session at rest whole`): `host().sendTurn(id, 'x'.repeat(10_000))` is `{ ok: true }`, the fake's one prompt holds it whole, `said()` is `['[device] voice · <herdr \| herdr-app \| opencode>']` | the three `repeat(2001)` become `repeat(MAX_TEXT + 1)` |

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts`. Expected: FAIL, only the red cases (refused, `bad_request`, `'failed'`, `'no-answer'` or `false` where `sent` or `{ ok: true }` is expected, and `MAX_TEXT` is `2000`). Commit `test(dial): every host path takes a 20,000-character text whole (red)`.
- [ ] **Step 3: Set** `MAX_TEXT = 20_000` and its comment in `orca.ts`. No reader changes.
- [ ] **Step 4: Run** the same command and `cd cli && npm run typecheck`. Expected: PASS, no type error.
- [ ] **Step 5: Commit** `dial: every host takes 20,000 characters, a fast ten-minute transcript and a passage`.

### Task 2: The core's inbox answer holds 20,000 characters

**Layer:** core process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/core/deviceHookCalls.spec.ts`.

**Files:**
- Modify: `cli/src/core/deviceHookCalls.ts` (`MAX_TEXT` and its comment only)
- Test: `cli/src/core/deviceHookCalls.spec.ts`

**Interfaces:**
- `const MAX_TEXT = 20_000` stays private to the module. Its comment: the same number as `cable/hosts/orca.ts`'s `MAX_TEXT`, the longest dial text every host path takes; the core imports nothing from `cable/`, so it keeps its own; over it the poll is answered `{}` and the devices' inbox counts the words taken, so the two must not differ.

- [ ] **Step 1: Write the failing test.** `a text over 20,000 characters or not a string is {}`: texts `['x'.repeat(20_001), '', 42, null, 'x'.repeat(20_000), 'x'.repeat(10_000)]` answer `[{}, {}, {}, {}, { text: 'x'.repeat(20_000) }, { text: 'x'.repeat(10_000) }]`. Literal numbers, as above.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/deviceHookCalls.spec.ts`. Expected: FAIL, the 20,000 and 10,000 texts answered `{}`. Commit `test(core): the mod's inbox answer holds 20,000 characters (red)`.
- [ ] **Step 3: Set** `MAX_TEXT = 20_000` and its comment.
- [ ] **Step 4: Run** the same command. Expected: PASS. `git diff --stat -- cli/src/architecture.coreFiles.txt` prints nothing.
- [ ] **Step 5: Commit** `core: the mod's inbox answer holds a ten-minute transcript, 20,000 characters`.

### Task 3: The review draft counts characters, up to `MAX_TEXT`

**Layer:** devices service process. **Depends on:** 1. **Effort:** `medium`.

**Red test:** `cli/src/cable/voiceDraft.spec.ts`.

**Files:**
- Modify: `cli/src/cable/voiceDraft.ts`
- Test: `cli/src/cable/voiceDraft.spec.ts`

**Interfaces:**
- Consumes: `MAX_TEXT` from `./hosts/orca.js` (Task 1).
- `MAX_BYTES` is removed. `valid(text)` is: not blank, `text.length <= MAX_TEXT`, and no control character but `\n` (today's regex). `PART_BYTES` (480), `spans`, the Latin-1 check at Send and every copy string stay.

- [ ] **Step 1: Write the failing tests.**
  - New `takes a transcript of up to 20,000 characters, counted in characters, not bytes`: `setup('x'.repeat(20_000)).page` is `ok` with `total` 42; `setup('é'.repeat(10_000)).page` (20,000 bytes) is `ok` with `canSend` true.
  - `rejects invalid text`: `'x'.repeat(16001)` becomes `'x'.repeat(MAX_TEXT + 1)`.
  - `bounds cumulative edits and preserves the old draft on failure`: `setup('a'.repeat(MAX_TEXT - 100))`; appending `'b'.repeat(200)` is not `ok`, and the draft's revision stays 1.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/voiceDraft.spec.ts`. Expected: FAIL, the 20,000-byte drafts refused at create. Commit `test(dial): a review draft holds 20,000 characters (red)`.
- [ ] **Step 3: Change** `valid` and remove `MAX_BYTES`.
- [ ] **Step 4: Run** the same command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a review draft holds what every host takes, counted in characters`.

### Task 4: A recording to the dial's stop is kept, and a long transcript's "sent" fits the cable

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (the audio cap and the frames every dial reads).

**Red test:** `cli/src/cable/cableSession.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`VOICE_MAX_BYTES` and its comment, `withinCap` and its comment, the two `voice.transcript` replies in `finishVoice`)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- `VOICE_MAX_BYTES = (10 * 60 + 15) * 32_000`. Comment: both dials stop at 600 s on a tick after the 600 s have passed, so a recording run to that stop passes 600 s by up to a tick; 15 s leaves room for it and still bounds a stuck dial.
- `private withinCap(msg: Message): Message`: a summary over `CABLE_MAX_PAYLOAD - 256` loses `full` (today); a `voice.transcript` over it loses `text`; anything else comes back as it is. Its comment says why `text` may go: neither firmware reads it (round `cable_client.c`, Pro `pro_cable.c` `handle_voice_transcript`), and the margin holds the `uploadId` `reply` adds and the `seq` `send` adds.
- `finishVoice`: both `voice.transcript` replies (the window's route and the direct send) are `reply(this.withinCap({ … }))`.

- [ ] **Step 1: Write the failing tests**, in a new `describe('a long recording and its long transcript')`. A helper `record(port, uploadId, bytes, fields = { agentId: 'a1' })` says `voice.begin` with `uploadId` and `fields`, sends `bytes` of PCM in frames of 8,000 bytes (one reused buffer, the last frame cut), says `voice.end`, and waits for the `voice.transcript` or `voice.error` with that `uploadId`.
  - `a recording of 600 s, and one a second past it to the dial's own stop, are transcribed`: 600 × 32,000 and then 601 × 32,000 bytes each answer `voice.transcript`, and `transcribe` was handed a PCM of exactly those bytes each time.
  - `a recording of 615 s is transcribed; past it, a stuck dial's is dropped and logged`: 615 × 32,000 answers `voice.transcript`; 615 × 32,000 + 2 answers `voice.error` `Didn't catch that`, `transcribe` is not called for it, and the log holds `cable: voice over the length cap, dropped` once.
  - `a transcript too long for one frame reaches the dial as voice.transcript without its text, on either route`:
    - `transcribe` answers `` `${'word '.repeat(2_000).trim()}.` `` (10,000 characters), agent `a1` named: `host.sendTurn` was called once with `('a1', <the whole text>)`; the dial gets `{ t: 'voice.transcript', uploadId, routeId: '', agentId: 'a1', agentName: 'Fix login screen', needsConfirm: false }` with no `text` property; no log line holds `dropped a voice.transcript`.
    - No agent named, `routeInWindow: async () => ({ t: 'sent', agentId: 'a2' })`: the same, `agentId: 'a2'`, no `text`.
    - `'ệ'.repeat(3_000)` (3,000 characters, 9,000 UTF-8 bytes): no `text`.
    - At the margin: a text that makes the message exactly `CABLE_MAX_PAYLOAD - 256` bytes (measured from `JSON.stringify` of the same fields with an empty `text`) keeps its `text` and arrives with its `uploadId`; one more character and it loses `text`.
  - If a 600 s case passes the suite's 30 s timeout under load, give that test an explicit timeout; never a sleep.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL: the 601 s and 615 s recordings answer `Didn't catch that`, and each long transcript is dropped by `send` (`cable: dropped a voice.transcript frame`), so the dial hears nothing for it. Commit `test(dial): a ten-minute recording and its long transcript reach the dial (red)`.
- [ ] **Step 3: Change** `VOICE_MAX_BYTES`, `withinCap` and the two replies.
- [ ] **Step 4: Run** the same command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a recording run to the dial's stop is transcribed, and a long transcript's sent frame fits the cable`.

### Task 5: Free gets 30 minutes of voice a day

**Layer:** backend, Linux. **Depends on:** none. **Effort:** `high` (a stored value on each environment's Free row at the next release; no schema, query, index or migration).

**Red tests:** `backend/src/lib/db/seed.test.ts`, `backend/src/routes/voice.test.ts`.

**Files:**
- Modify: `backend/src/lib/db/seed.ts` (`CAMPAIGN_TIERS.free.dailyVoiceLimitSeconds` only), `backend/src/lib/voiceQuota.ts` (`FALLBACK_USER_LIMIT_SECONDS` only; its comment stays true)
- Test: `backend/src/lib/db/seed.test.ts`, `backend/src/routes/voice.test.ts`, `backend/src/services/MachineBillingService.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `seed.test.ts`, new `gives Free 30 minutes of voice a day, as Pro, whether or not the catalog answers`: with `fetchPlans` answering `[]`, and again with `FULL_CATALOG`, every `planDb.upsert` whose `where` names `Free` holds `dailyVoiceLimitSeconds: 1800` in its `update` (and in its `create` where it has one), and the one for `Pro` holds 1800.
  - `voice.test.ts`, `holds even with no plan rows: a forgotten default never means unlimited`: `store.plans = []`; three `wav(590)` are 200, then `wav(31)` (1,801 s) is 429.
  - Moved with the fixture, not red (the `FREE` row is test data): `FREE.dailyVoiceLimitSeconds` is `30 * 60`; `refuses a Free account past 30 minutes a day, in plain words, without calling Deepgram`: three `wav(580)` pass (1,740 s), `wav(61)` is 429 with a message matching `/30 minutes/` and Deepgram not called, `usedSeconds` stays 1,740, then `wav(60)` passes; `lifts the cap for an account on an unlimited plan`: four `wav(590)` (2,360 s) are 200; the deleted-or-unpaid and the lapsed tests: three `wav(590)` are 200, `wav(31)` is 429; the memory-budget test's stored `usedMs` is `1_800_000`. `gives a Pro account 30 minutes a day` stays as it is.
  - `MachineBillingService.test.ts`: `freePlan.dailyVoiceLimitSeconds` 1800, and its plans list expects `['Free', 1800]`.
- [ ] **Step 2: Run** `cd backend && npm test -- src/lib/db/seed.test.ts src/routes/voice.test.ts src/services/MachineBillingService.test.ts src/lib/voiceQuota.test.ts`. Expected: FAIL in the new seed test (600) and in `holds even with no plan rows` (the second `wav(590)` refused). Commit `test(backend): Free has 30 minutes of voice a day (red)`.
- [ ] **Step 3: Set** both values to `30 * 60`.
- [ ] **Step 4: Run** the same command and `cd backend && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `backend: Free gets 30 minutes of voice a day`.

### Task 6: End to end: a 10,000-character transcript reaches the mod whole

**Layer:** test. **Depends on:** 1, 2, 4. **Effort:** `high`.

**Red test:** the new test, run with the base's three source files put back (Step 3). One commit: the test only.

**Files:**
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts`

**Interfaces:**
- Consumes: `FakeBackend`, `FakeMachine` (`./harness/fakeBackend.js`); `deviceCmux.e2e.ts`'s sign-in, copied in shape; the file's `fresh`, `startOutside`, `inboxPoll`, `showing`, `heard`.

- [ ] **Step 1: Write the test.**
  - The header gains a bullet: a ten-minute transcript, 10,000 characters, reaches Claude Code's mod whole in VS Code's terminal, and the dial hears it was sent.
  - `ME: FakeMachine` of this file's own (`machineId: 'c5'.repeat(16)`, `computerId: 'e2e-device-without-app-computer'`, `name: 'Fixture'`, `token: 'e2e-device-without-app-token'`). `let backend: FakeBackend | undefined`, closed in `afterEach` after the daemon.
  - `fresh(env = {}, relay?: FakeBackend)`: with a relay, the daemon's env also gets `BACKEND_WS_URL: relay.wsUrl`, `WEB_URL: relay.httpUrl`, `ADAPTER_COMPUTER_ID: ME.computerId`, and `auth/session.json` is written before `d.start()` as `deviceCmux.e2e.ts`'s `fresh` writes it. Without one, `fresh` is as today.
  - `a ten-minute transcript, 10,000 characters, reaches Claude Code's mod whole, and the dial hears it was sent`:
    1. `const relay = await FakeBackend.start()`, `backend = relay`, `relay.addMachine(ME)`, `fresh({}, relay)`; a dial plugged in; its first `agents.end`.
    2. `const engine = await startOutside(d, 'in-vscode', { TERM_PROGRAM: 'vscode' })`; listed.
    3. `const poll = inboxPoll(d, engine.sessionId)`; the dial's list shows the agent with `v` in its `caps`.
    4. ``const words = `${'word '.repeat(2_000).trim()}.` `` (10,000 characters); `relay.speech = words`; the dial sends `{ t: 'voice.begin', agentId: engine.id, uploadId: 'e2e-long-1', sr: 16_000, lang: 'en' }`, `dial.audio(Buffer.alloc(3_200, 1))`, `{ t: 'voice.end', uploadId: 'e2e-long-1' }`.
    5. The dial's first `voice.transcript` or `voice.error` with that `uploadId` (`heard`, 45 s) matches `{ t: 'voice.transcript', agentId: engine.id, needsConfirm: false }` and has no `text`.
    6. `await poll` equals `{ status: 200, body: { text: words } }`.
    7. `d.log()` does not contain `word word`.
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts --reporter=default`. Expected: PASS, every test of the file, none skipped.
- [ ] **Step 3: Show it red.** Put back the base's three files (`git show 36c4c41a3c:<path> > <path>` for `cli/src/cable/hosts/orca.ts`, `cli/src/core/deviceHookCalls.ts`, `cli/src/cable/cableSession.ts`), run the new test alone (`-t 'ten-minute transcript'`). Expected: FAIL, the dial's answer is `voice.error` `Too long. Say it shorter.`. Then `git checkout -- <the three paths>`; `git status --short` shows only the e2e file. Record the failing line for the PR.
- [ ] **Step 4: Commit** `e2e: a ten-minute transcript reaches Claude Code's mod whole, and the dial hears it was sent`.

### Task 7: The timing write-up for the PR

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: docs only. One commit.

**Files:**
- Create: `docs/plans/2026-11-19-dial-voice-ten-minutes-timing.md`

- [ ] **Step 1: Measure the daemon's own share** with a script in the implementer's scratch folder, never committed, in the shape of `cli/scripts/benchmark-dial-tab-read.ts`: a throwaway `HOME`, `USERPROFILE`, `ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR` and `HARNESS_AUTH_DIR` set before any module of the tree loads; a `node:http` server on `127.0.0.1:0` that reads the whole body and answers `{ success: true, data: { transcript: '' } }`; `BACKEND_WS_URL` set to `ws://127.0.0.1:<its port>`; then `DaemonCableHost` imported and `transcribe(pcm, 16_000, 'en')` called with the stub wiring of `cableVoice.spec.ts`'s `setup()`. Five rounds each for 120, 300 and 600 s of PCM; the median and the largest, in ms, with Node's version and this Mac's model. Run from `cli/` with `node --import tsx <the script>`. No network but loopback, no account.
- [ ] **Step 2: Write the doc**, each number marked **measured** or **estimated**:
  1. Sizes: WAV bytes for 2, 5 and 10 minutes (44 + 32,000 × seconds), the multipart around it.
  2. The daemon's share, measured (Step 1).
  3. Upload at 1, 3, 10 and 50 Mbps uplink: bytes × 8 / rate, estimated.
  4. The backend's share: it takes the whole upload (`routes/voice.ts`, 25 MB cap) before one call to Deepgram (`lib/deepgramWav.ts`: nova-3 for English, nova-2 for Vietnamese), under `AbortSignal.timeout(STT_TIMEOUT_MS)`. Deepgram's time for 2, 5 and 10 minutes from Deepgram's own published figures, cited with the link and the date read, estimated.
  5. **`STT_TIMEOUT_MS = 60_000`:** whether the backend-to-Deepgram transfer of 19.2 MB and Deepgram's processing fit in 60 s for 10 minutes; the risk if not (a 502, the seconds given back, the dial shows the error, the words are lost, nothing retries). It is not changed here.
  6. **The dial's 65 s after Done:** upload + backend + delivery (Orca and `codex queue` up to 10 s; the mod's inbox waits up to 5 s for a poll); the uplink below which a 2, 5 and a 10-minute recording miss it.
  7. **Follow-up proposal** for the PM: the firmware waits in proportion to the recording's length (both dials), or the daemon compresses the audio before upload; the second also needs the backend, which takes only PCM WAV today because it counts a clip's seconds from its PCM length (`UNSUPPORTED_AUDIO`).
  8. **Unverified, named in the PR:** the real Claude Code's `$.prompt.submit` with 20,000 characters; herdr's and Herdr Core's line limits; whether Orca (`--wait-submit 5` in a 10 s run) and `codex queue` (10 s) take 20,000 characters in time; on Windows, a 32,767-character command line (an argument of 20,000 characters made almost wholly of quotes is refused by the spawn and the dial says the agent did not answer; never cut).
- [ ] **Step 3: Commit** `docs: how long two, five and ten minutes of dial voice take after Done`.

## Verification

**Platforms the pull request names:** macOS, Linux and Windows for the CLI; Linux for the backend. Tested: the unit specs on Linux in PR CI and on this Mac; check 1 on this Mac; check 2 on Linux runners. Windows: the change is platform-neutral code with no Windows branch; it is named in the PR as not run on a Windows machine, with the command-line note of Task 7 (open question 1).

**Never touched by a tester or a test:** Diego's daemon (port 18473), dial, terminals and apps; the real Claude Code, Codex, Orca, herdr, Herdr, cmux, opencode, VS Code; `~/.claude`, `~/.codex`; any real backend; production. No real-app gate on this Mac. No test account: the e2e signs in to its own fake backend.

**Temporary workflow:** none. Check 1 is one file on this Mac; check 2 has the repo's own workflow.

**Required local gates**, on this Mac at the final head, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/core/deviceHookCalls.spec.ts src/architecture.spec.ts src/architecture.failureLogs.spec.ts`.
- `cd cli && npm run test:core`: 100% per file under `src/core/` and `src/services/` (`deviceHookCalls.ts` and `devices.spec.ts` change).
- `cd backend && npm run typecheck && npm test -- src/lib/db/seed.test.ts src/routes/voice.test.ts src/services/MachineBillingService.test.ts src/lib/voiceQuota.test.ts`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipt goes in the pull request's body before the tested commit is pushed.
- `git diff --stat 36c4c41a3c -- cli/src/core cli/src/architecture.coreFiles.txt` lists only `deviceHookCalls.ts` and its spec. The PR says: one number in an existing bound, no core exception (core rule 7).
- Not needed: `test:harnessd`, the serial and PTY specs (no serial code changes), a firmware build or flash, the backend's production read (`backend/AGENTS.md` rule 5: no collection, index or query changes).

**1. A 10,000-character transcript through the real daemon to Claude Code's mod**
- Where: this Mac, at the final head. Nothing to build by hand: the suite starts the daemon from the working tree's bundle.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts --reporter=default`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, `cli/AGENTS.md` rules 5 and 6): a throwaway home, data folder and port, a private tmux server, a fake dial on a pseudo-terminal, the daemon's VS Code and `open` the harness's fakes; the backend is `FakeBackend` on loopback, its speech set by the test; the Claude Code is the suite's fake (`e2e/harness/outsideAgent.ts`), its `TERM_PROGRAM=vscode` in its own environment only.
- A person sees: every test of the file pass, none skipped. The new one: the dial records, the fake backend answers 10,000 characters, the mod's poll gets them whole (`{ status: 200, body: { text } }`), the dial gets `voice.transcript` for the agent with no `text`, and the daemon's log holds none of the words. Task 6's red line (the base answering `Too long. Say it shorter.`) goes in the PR beside it.
- Skipped or not run: report it as not verified, never as passed.

**2. Every other dial and voice flow still holds**
- On GitHub, by hand, once on the final head, in phase 4, after the PM's turn (asked through the main session): Actions → CLI end to end → Run workflow, branch `fix/dial-voice-ten-minutes`, `agent_browser_podman` not ticked (`.github/workflows/cli-e2e.yml`). Every shard passes; the link goes in the pull request.
- Isolation: the suite's own, on Linux runners. No account, no secret.
- What it shows: `deviceWithoutApp` (check 1 on Linux), `deviceHerdr`, `deviceHerdrApp`, `deviceOpencode`, `deviceCodex`, `deviceClaudeOrca`, `dialPaneFollow` and `devicesProcess` speak and deliver as before.
- On this Mac beside check 1, for the macOS-only file the shards skip: the same command with `e2e/deviceCmux.e2e.ts`; every test passes.

**3. In PR CI, by itself:** `cli-typecheck`, `cli-tests` (and the `companions` and `pty-checks` jobs a `cli/` change selects), `backend-desk`, `backend-integration`, `process-checks`. Nothing is started by hand.

**4. The timing write-up** (Task 7) is in the PR body before merge, with its measured and estimated numbers marked.

**5. Diego's own check, after a CLI release he decides on** (his dial, his Claude Code in VS Code's terminal, his eye; no tester or agent runs it): a three- to five-minute recording reaches Claude Code whole and the dial shows it sent. Not a merge gate.

**6. Against production:** none. Production's Free row changes when the backend is next released, which is Diego's call.

## Open questions

1. **Windows.** PR CI runs these specs on Linux only, and no workflow of the repo runs them on Windows (`windows.yml` runs a fixed list of pty and install specs). Either (a) add a temporary workflow, `.github/workflows/tmp-dial-voice-ten-minutes.yml`, on `push` to this branch only, `windows-latest`, `permissions: contents: read`, no secrets, running `npm ci` and the changed `cli/src/cable` and `cli/src/core` specs, removed before merge; or (b) name Windows in the PR as covered by platform-neutral code and not run on a Windows machine. **Recommended: (b).** The change is constants and JSON with no Windows branch, and the one Windows difference, the 32,767-character command line, needs a real spawn of Orca or `codex`, which these fakes never reach. This draft is written for (b); (a) would add one temporary-workflow task with no dependency.
