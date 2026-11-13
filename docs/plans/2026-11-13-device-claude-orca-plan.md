# The dial answers and talks to agents outside Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With Claude Code running in Orca, Ghostty or any terminal and the `harness-device` plugin enabled, a person at the round dial can allow or deny a waiting permission prompt, say the next prompt to an idle agent, and tap an agent in Orca to bring its terminal forward. The terminal stays usable: whoever answers first wins.

**Architecture:**
- A new Claude Code plugin, `plugins/harness-device`, holds a `PermissionRequest` command hook and a voice-only mod. Both reach Harness through its launcher and the daemon's local socket.
- The core gets two hook routes, `/api/hook/approval` and `/api/hook/inbox`. It checks, bounds and forwards each call to the devices process, and keeps only the open requests.
- The devices process owns everything else: the approval queue and the dial's card (`Approvals`), the voice inbox the mod polls (`Inbox`), the Orca commands (`orca terminal send` / `switch`), and per-agent capabilities on `ObservedSource`.
- The `harness` CLI gets `harness device claude status|enable|disable` for the menu-bar app, and the hidden `approve` (the hook's client, which cuts the tool input to a summary) and `link` (the mod's socket path).

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`), the hook script `cli/hook/notify.mjs`, a Claude Code plugin (POSIX sh hook, a JavaScript mod tested with `claude plugin test`), Python host tests for the round firmware (no firmware source changes).

**Spec:** `docs/specs/2026-11-13-device-claude-orca.md`. Wave 0's plan, which this one stacks on: `docs/plans/2026-11-13-device-without-the-app-plan.md`.

## Layers

Every file this plan creates or changes, and the process it runs in (`cli/AGENTS.md`, master / core / services).

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/core/deviceHookCalls.ts` (new) | **Core** (`harnessd-core`). Accepts, bounds and forwards; nothing else | A new line in `src/architecture.coreFiles.txt`; 100% per file (`npm run test:core`) |
| `cli/src/core/api.ts`, `cli/src/core/devicesLink.ts`, `cli/src/core/observedHook.ts` | **Core** | Already listed; 100% per file |
| `cli/src/hookServer.ts` | **Core** (listed in `coreFiles.txt`): the two route blocks only, no logic | `hookServer.spec.ts` (outside the 100% gate) |
| `cli/src/core/main.ts` | **Core**, wiring only | The end-to-end suite |
| `cli/src/architecture.coreFiles.txt` | The list of what the **core** loads: one new line | `architecture.spec.ts` |
| `cli/src/cable/hosts/approvals.ts`, `inbox.ts`, `orca.ts` (new), `observed.ts` | **Devices service process** (`harnessd-devices`) | Their specs |
| `cli/src/cable/cableHost.ts`, `cableSession.ts`, `questionInbox.ts`, `roundGlyphs.ts` (new) | **Devices service process** | Their specs |
| `cli/src/services/devices.ts`, `devicesProcess.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/deviceClaude/approve.ts`, `plugin.ts`, `command.ts` (new), `cli/src/cli.ts` | **CLI only**: the `harness` command's own process, never the daemon | Their specs |
| `cli/hook/notify.mjs` | **Hook**: a process the engine starts for each hook event | `hookNotify.spec.ts` |
| `plugins/harness-device/hooks/approve`, `hooks/hooks.json`, `.claude-plugin/plugin.json` (new) | **Plugin**: run by Claude Code (the hook as a child process) | `harnessDevicePlugin.spec.ts`, `claude plugin validate` |
| `plugins/harness-device/hooks/device.js`, `test/device.test.ts` (new) | **Plugin**: the mod, inside Claude Code | `claude plugin test` |
| `devices/harness-device/firmware/test/test_question_ui.py` | **Firmware** host test only; no firmware source changes | Itself |
| `cli/e2e/deviceClaudeOrca.e2e.ts` (new) | Test: the real daemon, a fake dial, the real CLI client | `cli-e2e.yml` |
| Each file's `*.spec.ts`, and `cli/src/harnessDevicePlugin.spec.ts` (new) | Tests, in vitest's process; no daemon | PR CI's CLI suite |
| `.claude-plugin/marketplace.json`, `.gitignore`, `plugins/harness-device/README.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | Repo files, no process | none |

What this fixes, by layer:
- **The core never** parses a hook payload, builds a summary, queues an approval, holds a transcript longer than one answer, or runs `orca` or `claude`. `core/deviceHookCalls.ts` is the only file added to its process.
- **The summary** is cut from `tool_input` in the CLI client (`deviceClaude/approve.ts`). The rest of the tool input never leaves that process.
- **The approval queue, the voice inbox and the Orca commands** live in the devices process. So does the card's text: what the round dial cannot draw becomes `?` there, when the card is built.
- **`harness device claude …`** runs in the CLI's process. No file under `cli/src/deviceClaude/` is imported by anything the core or a service loads.
- With `HARNESSD_SERVICES=none` (debugging) and on Harness OS the devices service runs inside the core's process, as every service does there. The file boundaries stay the same.

## Wave 0

This branch stacks on `feat/device-without-the-app` at `9bffc37cbb`: wave 0's Tasks 1-8 are here; its Task 9 (end to end) and Task 10 (dial proof) are still running there, and it is not on `main`.

- **Can start now, on the current wave 0 code:** Tasks 1-18. None touches the two files wave 0's Task 9 still writes (`cli/e2e/deviceWithoutApp.e2e.ts`, `cli/e2e/harness/fakeEngine.mjs`). Wave 0's Task 10 writes no file.
- **Edit files wave 0 wrote** (a fix from wave 0's Task 9, Task 10 or review can touch the same lines): Task 1 (`notify.mjs`, `observedHook.ts`), Task 5 (`cableSession.ts`), Task 7 (`observed.ts`), Task 8 (`cableHost.ts`), Task 9 (`api.ts`, `devicesLink.ts`, `devices.ts`, `devicesProcess.ts`), Task 10 (`hookServer.ts`, `main.ts`). When `feat/device-without-the-app` gains a commit, rebase this branch onto it before starting any of these that has not started.
- **Must wait for wave 0 to merge to `main`, then a rebase:** Task 19, the Verification on the final head, and the pull request. The on-dial checks also need wave 0's Task 10 done: they run on the firmware it flashes.
- A failure in wave 0's own code (the machine list, `describe`, the observed hook) found here is reported to the main session as a wave 0 fix. It is not patched on this branch.

## Global Constraints

- **Core boundary.** The only line added to `cli/src/architecture.coreFiles.txt` is `core/deviceHookCalls.ts`, sorted. The pull request says why every session needs it: hook calls are what the core already receives, and it only forwards them, typed and bounded, to the one component that faces the dial.
- **Never starts the devices process.** Both routes first check that a dial is watching (the core's `cableWatchingLocal()`, which the devices' link sets and clears when their process goes). Otherwise they answer at once.
- **Secrets.** `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` are never read or forwarded, by the hook, the client or the mod. `ORCA_TERMINAL_HANDLE` is the only new hint. The client and the mod send no environment variable; the mod reads `HOME` only.
- **Approval route** `/api/hook/approval`: body ≤ 4 KB; `sessionId` 1-128 characters, `tool` 1-64, `summary` ≤ 200 bytes of UTF-8, `cwd` ≤ 1024 and optional; no control character in any; else 400. At most 4 open per session and 16 in all; more get `none` at once. Answers 200 `{ "decision": "allow" | "deny" | "none" }`.
- **Inbox route** `/api/hook/inbox`: body ≤ 1 KB; `sessionId` 1-128. One open poll per session (a newer one replaces it), at most 64 in all. Answers 200 `{ "text": "…" }` (a transcript), 200 `{}` (the hold ran out), or 503 (no dial, replaced, over the bound, or the devices failed). The mod polls again at once after a 200 that was held at least 1 s, after 10 minutes on 404, and after 60 s on anything else.
- **Timers, the inner one decides.** The devices close a card after 300 s and end a poll after 25 s. The core's calls wait a little longer (305 s, 27 s), the client 310 s, the hook 330 s, so an expiry is counted as an expiry and not as a terminal answer.
- **The card.** `question` frame: `id: "approval:<the core's request id>"`; one question `{ key: "approval", q: "Allow <tool>?\n<summary>", options: ["Allow", "Deny"], multi: false }`, no `canText`. In `q`, each character the round dial cannot draw (CJK, an emoji) becomes `?`; then `q` is cut on a character to at most 255 bytes (the firmware's `prompt[256]`). A card always shows its command: the summary line is never dropped.
- **Exact copy:**
  - "This request is closed." (a stale or other id)
  - "Tap Allow or Deny." (a spoken answer to an approval)
  - "<name> is busy. Say it when it is done." (voice to a working or needs-you agent)
  - "<name> did not answer." (no poll in 5 s, or Orca failed)
  - "Orca did not open it." (a failed open, as a toast)
  - "Denied from the Harness device." (the hook's deny message)
  - "Claude Code 2.1.287 or later is needed." (`enable` when unsupported)
- **The hook's client** reads at most 256 KB of stdin, always exits 0, and prints exactly `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, the same with `"behavior":"deny","message":"Denied from the Harness device."`, or nothing.
- **Voice.** Only to an agent that is not `working` or `needs-you`, for every route and engine. An agent has `v` when its session has a poll open or one closed under 35 s ago, or when it has an Orca handle. A transcript waits at most 5 s for a poll. Text is at most 2000 characters.
- **Orca.** Handle `^term_[0-9a-f-]{36}$`. `orca` on `PATH`, else `/Applications/Orca.app/Contents/Resources/bin/orca` on macOS. `execFile`, no shell, 10 s, one command at a time per handle. No polling of Orca.
- **Hints.** The allowlist has 10 names, and both caps are 10 (`notify.mjs`, `MAX_HINTS` in `core/observedHook.ts`).
- **With a window open nothing changes:** approvals answer `none` and observed agents take no voice. A Harness-pane session keeps the pane path: its approval is `none`.
- **Logs** carry outcomes and counts only: no summary, command, path, transcript, session id or handle.
- **Platforms.** macOS and Linux. On Windows `status` says `supported: false` and `enable` refuses.
- **Claude Code.** `supported` needs ≥ 2.1.287. `claude` calls time out after 60 s (marketplace add, install) or 15 s (the rest).
- **Repo rules.** Tests never touch the developer's real `~/.claude`, `~/.codex`, daemon (port 18473), tmux, `orca` or `claude`: fakes on a throwaway `HOME` and `PATH`. No firmware source changes. Never edit `devices/harness-pro`.

## Review Focus

1. **An answer for a card that just closed.** Parallel tool calls queue cards for one agent. A late Allow for the closed one must never land on the next. Covered in Task 6 (`an answer for a closed id never resolves the next card`).
2. **The core restarting while a card is open** (an update hands over several times a day). The devices keep running, and the card would stay with nobody to hear its answer. Covered in Task 9 (`a core that connects again closes the open cards and polls`) and Task 11 (`a connection that closes mid-wait prints nothing and exits 0`).
3. **A session resumed in another terminal.** Its old Orca handle must go, or voice is typed into a terminal that now holds something else. Covered in Task 7 (`an event whose hints carry no handle clears it`).
4. **The carousel.** The dial sends `focus` on every swipe; only a tap may switch Orca. Covered in Task 8 (`a swipe to an Orca agent marks it seen and never opens Orca`).
5. **A transcript for an agent outside Harness offered to the Swarm.** Voice first asks the Swarm chat for any agent; these words must stay in the devices process. Covered in Task 8 (`voice to an agent outside Harness never asks the Swarm`).

---

### Task 1: The hook sends the Orca terminal handle; both hint caps rise to 10

**Layer:** hook process (`notify.mjs`) and core (`observedHook.ts`). **Depends on:** none. **Effort:** `xhigh` (the allowlist is what keeps Orca's secrets in the hook).

**Files:**
- Modify: `cli/hook/notify.mjs` — `HOST_HINTS` (:492), `hostHints()` (:495); `cli/src/core/observedHook.ts` — `MAX_HINTS` (:24)
- Test: `cli/src/hookNotify.spec.ts` (`HINTS` :2200, the allowlist test :2325), `cli/src/core/observedHook.spec.ts` (:31)

**Interfaces:**
- Produces: `hostHints.ORCA_TERMINAL_HANDLE` on every observed event; at most 10 hints, each cut to 64 characters; the core takes 10 keys and refuses 11.

- [ ] **Step 1: Write the failing tests.**
  - `hookNotify.spec.ts`: add `ORCA_TERMINAL_HANDLE` to `HINTS`. Change the allowlist test: with all 10 names set, plus `ORCA_PAIRING_CODE`, `ORCA_AGENT_SESSION_SPAWN_TOKEN` and `ORCA_OTHER`, the body's `hostHints` holds exactly the 10 names with their values, and the body matches none of `/PAIRING|SPAWN|ORCA_OTHER|secret/`.
  - `the largest body the hook can build is under 4096 bytes`: 10 hints of 64 characters, `cwd` and `transcript_path` of 1024, a 128-character session id.
  - `observedHook.spec.ts`: `takes 10 hint keys`; the rejection row becomes `11 hint keys`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts src/core/observedHook.spec.ts`. Expected: FAIL (8 hints kept, 10 keys refused).
- [ ] **Step 3: Implement:** the name, and both caps to 10. Update the two comments that say 8.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core`. Expected: PASS, 100% for `core/observedHook.ts`.
- [ ] **Step 5: Commit** `hook: send the Orca terminal handle, and let all ten hints through`.

### Task 2: Core: check, bound and forward a hook's call

**Layer:** core. **Depends on:** none. **Effort:** `xhigh` (the core's trust boundary; requests racing their clients).

**Files:**
- Create: `cli/src/core/deviceHookCalls.ts`, `cli/src/core/deviceHookCalls.spec.ts`

**Interfaces:**
- Produces:
  - `type ApprovalDecision = 'allow' | 'deny' | 'none'`
  - `interface ApprovalRequest { id: string; sessionId: string; tool: string; summary: string; cwd?: string }`
  - `interface InboxPoll { pollId: string; sessionId: string }`; `type InboxAnswer = { text?: string; off?: true }` (`off`: the devices could not hold the poll)
  - `interface DeviceHookPort { approval(request: ApprovalRequest): Promise<ApprovalDecision>; approvalGone(id: string): void; inboxPoll(poll: InboxPoll): Promise<InboxAnswer>; inboxGone(pollId: string): void }`
  - `parseApproval(body: unknown): Omit<ApprovalRequest, 'id'> | null`, `parseInboxPoll(body: unknown): { sessionId: string } | null`
  - `createDeviceHookCalls(deps: { ready(): boolean; devices(): DeviceHookPort | undefined; newId(): string }): { onApproval(body: unknown, gone: AbortSignal): Promise<'invalid' | ApprovalDecision>; onInbox(body: unknown, gone: AbortSignal): Promise<'invalid' | 'off' | { text?: string }>; open(): { approvals: number; polls: number } }`
- Rules:
  - `ready()` false or no port: `'none'` / `'off'` at once, and the port is not called.
  - Approvals: over 4 open for the session or 16 in all is `'none'` at once. A call that rejects is `'none'`.
  - `gone` aborting while a request is open sends `approvalGone(id)` / `inboxGone(pollId)` once; the late answer is dropped.
  - Inbox: a newer poll for a session answers the older `'off'` and sends `inboxGone` for it. Over 64 open is `'off'`. An answer with `off`, and a call that rejects, are `'off'`. A `text` that is not a string of 1-2000 characters is `{}`.
  - It keeps the open requests and nothing else.

- [ ] **Step 1: Write the failing tests:**
  - `parses an approval`; `takes a 200-byte summary of multi-byte characters`.
  - `rejects`: a non-object, a missing or empty `sessionId`, 129 characters, an empty or 65-character `tool`, a 201-byte `summary`, a 1025-character `cwd`, a control character in any field, a non-string field.
  - `answers none at once and calls nothing when not ready`.
  - `forwards with a new id and answers the devices' decision`; `a call that rejects is none`.
  - `the 5th open approval of a session and the 17th in all are none at once; a closed one frees its place`.
  - `the client going first tells approvalGone once, and its late answer is dropped`; `a client that goes after the answer tells nothing`.
  - Inbox: `rejects a missing or 129-character sessionId`; `off at once when not ready`; `a newer poll answers the older off and tells inboxGone for it`; `the 65th open poll is off`; `the client going first tells inboxGone`; `answers the text, or {} when the hold ran out`; `an off answer and a call that rejects are off`; `a text over 2000 characters or not a string is {}`.
  - `keeps nothing once every request has ended` (`open()` is `{ approvals: 0, polls: 0 }`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/deviceHookCalls.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Use `observedHook.ts`'s `bounded` rule for strings; the summary's bound is `Buffer.byteLength`.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core`. Expected: PASS, 100% for the new file.
- [ ] **Step 5: Commit** `core: check and bound a hook's approval and inbox call, and forward it to the devices`.

### Task 3: Orca actions

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (runs a command with text from outside).

**Files:**
- Create: `cli/src/cable/hosts/orca.ts`, `cli/src/cable/hosts/orca.spec.ts`

**Interfaces:**
- Produces:
  - `const ORCA_HANDLE = /^term_[0-9a-f-]{36}$/`
  - `interface OrcaDeps { run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null }>; onPath(name: string): string | null; exists(path: string): boolean; platform: NodeJS.Platform }`
  - `orcaDeps(): OrcaDeps` — `run` is `execFile` with no shell.
  - `createOrcaActions(deps: OrcaDeps): { send(handle: string, text: string): Promise<boolean>; open(handle: string): Promise<boolean> }`
- Rules:
  - `send` runs `['terminal', 'send', '--terminal', h, '--text', t, '--enter', '--wait-submit', '5', '--json']`; true on exit 0.
  - `open` runs `['terminal', 'switch', '--terminal', h, '--json']`; on exit 0 and macOS it then runs `open -b com.stablyai.orca`; true when the switch exited 0.
  - Every run has a 10 s timeout.
  - False with nothing run: a handle that fails `ORCA_HANDLE`, no `orca` found, an empty text, a text over 2000 characters, or a command already running for that handle.
  - Control characters in the text, newlines included, become spaces before it is passed.

- [ ] **Step 1: Write the failing tests** against a fake `orca` (a script in a temp folder that records its argv) for the real `run`, and a recording `run` for the rest:
  - `send passes the exact argv, the text as one argument`; `a text with quotes, $( ) and a leading -- reaches orca unchanged as the value of --text` (no shell).
  - `a transcript with a newline or a control character is typed as one line`.
  - `open switches, then brings Orca forward on macOS only`.
  - `a handle that is not term_<uuid> runs nothing`; `no orca on PATH and none in the app runs nothing`; `the app's own binary is used on macOS when PATH has none`.
  - `a run that outlasts 10 s is killed and is false`; `a non-zero exit is false`.
  - `a second command for the same handle while one runs is false; another handle's runs`.
  - `a text over 2000 characters runs nothing`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/orca.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `devices: type into and open an Orca terminal by its handle`.

### Task 4: The voice inbox the mod polls

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (polls racing transcripts and timers).

**Files:**
- Create: `cli/src/cable/hosts/inbox.ts`, `cli/src/cable/hosts/inbox.spec.ts`

**Interfaces:**
- Produces: `class Inbox { constructor(deps: { now(): number; after(ms: number, run: () => void): () => void }); poll(pollId: string, sessionId: string): Promise<{ text?: string }>; gone(pollId: string): void; ready(sessionId: string): boolean; deliver(sessionId: string, text: string): Promise<boolean>; closeAll(): void }`. `after` returns its cancel.
- Rules:
  - `poll` is held 25 s, then `{}`. A newer poll for the session answers the older `{}`. `gone` ends it with `{}`. It never answers `{}` at once to a poll it could hold: the mod would ask again at once. The core admits at most 64 open polls (Task 2), which bounds the open ones here.
  - `ready`: a poll is open, or one closed under 35 s ago.
  - `deliver`: an open poll takes the text (`{ text }`) and it is true. With one closed under 35 s ago it waits up to 5 s for the next poll. Otherwise, or when none comes, false. One waiting transcript per session; a second is false.
  - A transcript is held only until a poll takes it or its 5 s pass. Closed-poll times older than 35 s are dropped, and at most 256 are kept (the oldest goes).

- [ ] **Step 1: Write the failing tests** with a fake clock:
  - `a poll is held 25 s and then answers {}`; `a newer poll answers the older {}`; `gone ends the poll`.
  - `a transcript answers the open poll and deliver is true`.
  - `a transcript waits for the poll that opens within 5 s`; `no poll in 5 s is false and the transcript is dropped`.
  - `ready: open, closed 34 s ago, not closed 36 s ago, never polled`.
  - `a session never polled is false at once, without waiting`.
  - `a second transcript while one waits is false`.
  - `keeps at most 256 closed-poll times and drops those older than 35 s`; `closeAll answers every poll {} and every waiting transcript false, and leaves no timer`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/inbox.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `devices: hold the mod's poll, and hand it the next transcript`.

### Task 5: The dial's session: an async send, a refused answer, a failed open

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Files:**
- Modify:
  - `cli/src/cable/questionInbox.ts` — add `export const APPROVAL_REQUEST_PREFIX = 'approval:'`
  - `cli/src/cable/cableSession.ts` — the `CableHost` interface (`sendTurn` :463, `answer` :470, `openAgent` :495); `case 'agent.open'` (:1597), `'turn.send'` (:1686), `'answer'` (:1720), `'voice.begin'` (:1767); `finishVoice` (`sendTurn` at :2478 and :2516)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces, on `CableHost`:
  - `sendTurn(agentId, text): void | SendOutcome | Promise<void | SendOutcome>`, with `type SendOutcome = { ok: true } | { ok: false; machine?: string; reason?: string; message?: string }`. `message` is a sentence for the dial.
  - `answer(agentId, requestId, answers): void | AnswerReceipt`
  - `openAgent(agentId, reason?): void | Promise<void | { ok: false; error: string }>`
- Session behaviour:
  - Voice awaits `sendTurn`. A refusal with `message` is the `voice.error`; without it, today's sentences. The draft's `submit` returns `message` as its `error` the same way.
  - `turn.send` does not wait; a rejection is logged.
  - `answer`: a request id that starts with `APPROVAL_REQUEST_PREFIX` skips the `a` check. A receipt with `ok: false` is toasted.
  - `agent.open`: a result with `ok: false` is toasted.
  - `voice.begin` with a question pin, for an agent whose open question id starts with the prefix: no audio is kept, and `voice.end` answers `voice.error` "Tap Allow or Deny."

- [ ] **Step 1: Write the failing tests:**
  - `voice waits for an async sendTurn, and shows its message when it refuses`.
  - `voice to a harness agent works as today` (a sync `{ ok: true }` and a bare `void`).
  - `a refused answer is toasted with its error`; `an approval's answer reaches the host even when the agent has no a`.
  - `a failed open is toasted; a void open says nothing`.
  - `a spoken answer to an approval keeps no audio and answers Tap Allow or Deny.`
  - `turn.send with a rejecting host does not throw`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The refusal reuses wave 0's `voiceRefusal`.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: wait for a send's answer, and say why an answer or an open was refused`.

### Task 6: Approvals in the devices process

**Layer:** devices service process. **Depends on:** Task 2 (types), Task 5 (`APPROVAL_REQUEST_PREFIX`). **Effort:** `xhigh` (first answer wins; only the exact request; a copy of the firmware's glyph table that must not drift).

**Files:**
- Create: `cli/src/cable/hosts/approvals.ts`, `cli/src/cable/hosts/approvals.spec.ts`, `cli/src/cable/roundGlyphs.ts`, `cli/src/cable/roundGlyphs.spec.ts`

**Interfaces:**
- Consumes: `ApprovalRequest`, `ApprovalDecision` (types only, from `core/deviceHookCalls.js`); `ReviewQuestion`, `AnswerReceipt`, `APPROVAL_REQUEST_PREFIX` (`cable/questionInbox.js`).
- Produces:
  - `roundDrawable(text: string): string` (`cable/roundGlyphs.ts`) — each code point the round dial cannot draw becomes one `?`; a newline and every code point of the table stay. No other change to the text.
    - **Source of truth:** the firmware. `ui_can_display` (`devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` :1083) refuses a question whose prompt holds a code point that is not a newline, a space, or in the Inter face's code table. That table is `inter_20_codes` in `main/ui/habitat/focus_faces.c` (313 code points, written by `scripts/gen_focus_faces.py`; `ht_lv_inter_25`, the face a question is set in, shares it).
    - `roundGlyphs.ts` holds a copy of that table, as ranges. The CLI ships without the firmware folder, so it cannot read the file at run time; the spec reads it and fails when the copy differs.
  - `approvalQuestion(tool: string, summary: string): ReviewQuestion` — the card of Global Constraints: `q` is `roundDrawable('Allow <tool>?\n<summary>')`, then cut to 255 bytes on a character. The summary line is never dropped.
  - `interface ApprovalsDeps { now(): number; after(ms: number, run: () => void): () => void; canShow(): boolean; owned(sessionId: string): Promise<boolean>; mark(sessionId: string, cwd: string | undefined, state: 'open' | 'answered' | 'left'): { id: string } | undefined; show(agentId: string, requestId: string, questions: ReviewQuestion[]): void; close(agentId: string, requestId: string): void; count(outcome: 'shown' | 'allowed' | 'denied' | 'expired' | 'terminal' | 'closed', ms: number): void }`
  - `class Approvals { constructor(deps: ApprovalsDeps); request(r: ApprovalRequest): Promise<ApprovalDecision>; gone(id: string): void; answer(agentId: string, requestId: string, choice: string | undefined): AnswerReceipt; closeAll(): void }`
- Rules:
  - `request` is `'none'` at once when `canShow()` is false, `owned` is true, `mark(…, 'open')` gives no agent, or 16 are already held.
  - One card per agent: the first is shown (`show`, `count('shown')`); the rest wait in order. The next goes out when the current one closes.
  - Each request expires 300 s after it arrived: `'none'`, `close` if shown, `count('expired')`.
  - `answer` takes only the agent's shown card with `requestId === 'approval:' + id`. "Allow" → `'allow'`, "Deny" → `'deny'`, then `close` and `{ ok: true }`. Another id → `{ ok: false, error: 'This request is closed.' }`. Another choice → `{ ok: false, error: 'Tap Allow or Deny.' }`.
  - `gone(id)`: a shown card closes, a waiting one is dropped unseen; `'none'`, `count('terminal')`.
  - `closeAll()`: every held request is `'none'`, shown cards close, `count('closed')`.
  - `mark` when a request ends: `'answered'` after allow, deny or `gone`, and only when the agent has no other request held; `'left'` after expiry or `closeAll`.

- [ ] **Step 1: Write the failing tests** with a fake clock:
  - `no dial or a window's tab view is none at once, with no card`; `a Harness-owned session is none`; `no room for the agent is none`.
  - `shows the card: Allow <tool>?, the summary, Allow and Deny, no canText, id approval:<id>`.
  - `Allow answers allow and closes the card; Deny answers deny`.
  - `a second approval for the agent waits and shows after the first closes; another agent's shows at once`.
  - `an answer for a closed id never resolves the next card`; `another agent's id is refused with This request is closed.`
  - `two answers to one card resolve it once`.
  - `gone closes a shown card and drops a waiting one unseen`.
  - `after 300 s the answer is none and the card closes; the agent is marked left`.
  - `closeAll answers every one none and closes the shown cards`.
  - `marks answered only when the agent's last request ends`.
  - `the 17th held request is none`.
  - `a 64-character tool and a 200-byte multi-byte summary give a q of at most 255 bytes, cut on a character`.
  - `counts shown, allowed with the time to the answer, denied, expired, terminal`.
  - `a summary with CJK and an emoji shows its card with ? in their place`: `approvalQuestion('Bash', 'echo 你好 🙂').q` is `'Allow Bash?\necho ?? ?'`, and that is the `q` `show` gets. (Task 16 draws this same string.)
  - `a tool name the dial cannot draw is replaced the same way`.
  - `a long CJK summary is replaced before the cut`: 66 CJK characters (198 bytes) after a 64-character tool give a summary line of 66 `?`, none of it lost.
  - In `roundGlyphs.spec.ts`:
    - `the table is the firmware's`: read `focus_faces.c` (by URL, as `cable/pets/pack.spec.ts` reads its vector), take `inter_20_codes`, check that `ht_lv_inter_25` names it, and compare it with the copy, code point for code point.
    - `ASCII, Vietnamese, … and ✓ stay, and so does a newline` (`Thêm phần kiểm tra … ✓`, the firmware test's own sentence).
    - `CJK becomes one ? per character` (`echo 你好` → `echo ??`); `an emoji becomes one ?, not two` (`rm 🙂.txt` → `rm ?.txt`).
    - `an arrow, a tab and a lone surrogate become ?`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/approvals.spec.ts src/cable/roundGlyphs.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `devices: one approval card per agent, answered once, by the exact request, with ? for what the dial cannot draw`.

### Task 7: An observed agent's handle, capabilities, voice and open

**Layer:** devices service process. **Depends on:** Task 3 (`ORCA_HANDLE`). **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts` (`capabilities are status only` :87 stays, for a source with no `actions`)

**Interfaces:**
- Produces:
  - `interface ObservedActions { modReady(sessionId: string): boolean; toMod(sessionId: string, text: string): Promise<boolean>; orcaSend(handle: string, text: string): Promise<boolean>; orcaOpen(handle: string): Promise<boolean>; count(what: 'mod' | 'orca' | 'busy' | 'too-long' | 'no-answer'): void }`
  - `ObservedDeps.actions?: ObservedActions` — absent, the source behaves as in wave 0.
  - On every event with hints: `host = detectHost(hints)`, and the handle is `hints.ORCA_TERMINAL_HANDLE` when it matches `ORCA_HANDLE`, else none.
  - `capabilities(agent): Caps` — `status` always; `voice` with a handle, or `actions.modReady(sessionId)` for a `claude` session; `focus` with a handle; `answer` while an approval is open.
  - `approval(sessionId: string, cwd: string | undefined, state: 'open' | 'answered' | 'left'): HostAgent | undefined` — for engine `claude`. `'open'` creates the agent when its hook has not come, turns it `needs-you` and sets the flag. `'answered'` clears the flag and turns `needs-you` back to `working`. `'left'` clears the flag only.
  - `send(agent, text): Promise<SendResult>`, in this order:
    1. Over 2000 characters → `{ ok: false, reason: 'Too long. Say it shorter.' }`.
    2. `working` or `needs-you` → "<name> is busy. Say it when it is done."
    3. A `claude` session with `modReady` → `toMod`; true is `{ ok: true }`.
    4. A handle → `orcaSend`; true is `{ ok: true }`.
    5. Otherwise "<name> did not answer."
    Each outcome is counted; nothing is queued.
  - `focus(agent): Promise<boolean>` — `orcaOpen(handle)`, or false with no handle.

- [ ] **Step 1: Write the failing tests:**
  - `keeps a handle that is term_<uuid> and ignores any other`; `an event whose hints carry no handle clears it`; `a session found by the scan takes its host from its first event`.
  - `caps: s alone with no actions; v and f with a handle; v for a claude session the mod is ready for; never v from the mod for codex; a only while an approval is open`.
  - `approval open creates a claude agent the hook never named and turns it needs-you`; `answered turns it working`; `left keeps it needs-you`; `open with the source full gives undefined`.
  - `send is refused while working and while needs-you, and nothing is typed`.
  - `send goes to the mod when it is ready`; `to Orca with a handle and no mod`; `to Orca when the mod missed its 5 s and there is a handle`; `did not answer with neither`.
  - `a failed Orca send says did not answer`; `a text over 2000 characters is refused before any route`.
  - `focus runs orcaOpen for a handle and is false without one`.
  - `counts mod, orca, busy, too-long and no-answer`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts`. Expected: PASS.
- [ ] **Step 5: Commit** `observed: what the dial may do with each agent, and how its voice and its tap get there`.

### Task 8: The cable host routes voice, answers and taps for agents outside Harness

**Layer:** devices service process. **Depends on:** Task 5. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` — `onMachine` (:522), `swarmSay` (:597), `openAgent` (:762), `sendTurn` (:815), `answerReviewed` (:832), `answer` (:836), `focus` (:841)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `CableHost` as Task 5 widened it; `HostSource.send` / `focus` (`hosts/types.ts`); `APPROVAL_REQUEST_PREFIX`.
- Produces, on `DaemonCableHost`:
  - `setApprovals(a: { answer(agentId: string, requestId: string, choice: string | undefined): AnswerReceipt } | null): void`
  - `machineView(): boolean` — no window and a registry.
  - `sendTurn` is async. For an agent `onMachine` finds in a source other than `harness`: `source.send(agent, text)`, a refusal answered `{ ok: false, machine: '', reason, message: reason }`. Any other agent: today's path.
  - `answer` and `answerReviewed`: a request id with the prefix goes to `approvals.answer(agentId, requestId, answers.approval)` and never to the fleet. With no approvals set: `{ ok: false, error: 'This request is closed.' }`.
  - `openAgent`: for an agent outside Harness with no `reason`, `source.focus(agent)`; false or no `focus` → `{ ok: false, error: 'Orca did not open it.' }`. With `reason: 'question'`: nothing.
  - `focus`: for an agent outside Harness, `markSeen` only.
  - `swarmSay`: for an agent outside Harness, `{ said: false }` without asking the wiring.

- [ ] **Step 1: Write the failing tests:**
  - `sendTurn reaches source.send for an agent outside Harness and answers its result`; `a harness agent keeps the fleet's path`.
  - `with a window open, voice to an observed agent reaches no source.send`.
  - `voice to an agent outside Harness never asks the Swarm`.
  - `an approval id is answered by approvals through answer and through answerReviewed, and the fleet hears neither`; `any other id goes to the fleet as before`; `an approval id with no approvals set is refused`.
  - `a tap on an agent with f runs source.focus`; `a failed focus answers Orca did not open it.`; `an open with reason question never calls source.focus`.
  - `a swipe to an Orca agent marks it seen and never opens Orca`.
  - `machineView is true only with no window and a registry`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `cable: an agent outside Harness takes its voice, its answer and its tap from its own source`.

### Task 9: The devices' port and its wiring

**Layer:** core (`api.ts`, `devicesLink.ts`) and devices service process (`devices.ts`, `devicesProcess.ts`). **Depends on:** Tasks 2, 3, 4, 6, 7, 8. **Effort:** `xhigh` (state across two processes; failure isolation).

**Files:**
- Modify:
  - `cli/src/core/api.ts` — `DevicesPort` (:1626), `DEVICES_FALLBACKS` (:1678)
  - `cli/src/core/devicesLink.ts` — the port (:69-93)
  - `cli/src/services/devicesProcess.ts` — `heard` (:226), the core's requests (:262)
  - `cli/src/services/devices.ts` — `observedSource` (:109), the wiring beside `setRegistry` (:341), `dialAttached` (:604), the port (:621), `swarms` (:683), `stop` (:744)
- Test: `cli/src/core/api.spec.ts`, `cli/src/core/devicesLink.spec.ts`, `cli/src/services/devicesProcess.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces:
  - `DevicesPort` gains `DeviceHookPort`'s four members. Fallbacks: `approval: later('none')`, `approvalGone: undefined`, `inboxPoll: later({ off: true })`, `inboxGone: undefined`. A failing devices service must read as no device (503, 60 s), never as an empty hold the mod repeats at once.
  - `devicesLink`: `APPROVAL_CALL_MS = 305_000`, `INBOX_CALL_MS = 27_000`. `approval` is the call `approval` (reads `decision`; anything but allow or deny is `'none'`). `inboxPoll` is the call `inboxPoll` (keeps a string `text`; an error is the fallback). `approvalGone` and `inboxGone` are the events `approval.gone { id }` and `inbox.gone { pollId }`.
  - `devicesProcess`: the requests `approval` → `{ decision }` and `inboxPoll` → `{ text? }`; the events `approval.gone` and `inbox.gone` call the port.
  - `devices.ts` builds one `Inbox`, the Orca actions, the `ObservedSource` with its `actions`, and one `Approvals`, and calls `cableHost.setApprovals`:
    - `canShow`: a dial is attached and `cableHost.machineView()`.
    - `owned`: after `deps.refresh?.()`, a `core.agents.advertised()` row with that `sessionId`.
    - `mark`: `observed.approval(…)`; undefined with the kill switch off.
    - `show` / `close`: `cable.question` / `cable.questionClose`, through `inOrder`.
    - `count`: one log line, `[device] approval · <outcome> · <ms>ms`; voice: `[device] voice · <what>`.
  - `approvals.closeAll()` when the dial goes (`dialAttached(false)`) and when a window appears (`swarms` with a value). `approvals.closeAll()` and `inbox.closeAll()` when the core connects again (`deps.onCoreConnected`) and on `stop`.
  - A part that throws answers `'none'` / `{ off: true }`, guarded as the other members are.

- [ ] **Step 1: Write the failing tests:**
  - `api.spec.ts`: the four fallbacks.
  - `devicesLink.spec.ts`: `approval asks the devices with a 305 s wait and reads allow and deny; anything else and an error are none`; `inboxPoll waits 27 s and keeps only a string text; an error is { off: true }`; `approvalGone and inboxGone are the events approval.gone and inbox.gone`.
  - `devicesProcess.spec.ts`: `the core's approval and inboxPoll calls reach the port and answer { decision } and { text }`; `approval.gone and inbox.gone reach the port`.
  - `devices.spec.ts`:
    - `an approval with a dial and no window shows the card and answers the dial's Allow`.
    - `no dial, a window open, HARNESS_DEVICE_OBSERVED=off or a Harness-owned session: none at once and no card`.
    - `the dial going and a window opening each close the open card with none`.
    - `a core that connects again closes the open cards and polls`.
    - `approval.gone closes the card`.
    - `a held poll takes the transcript for its idle agent, and the agent lists v`.
    - `an agent with an Orca handle lists v and f; its transcript runs orca terminal send, its tap orca terminal switch` (a recording `run`).
    - `no log line carries the summary, the command, a path, the transcript, a session id or a handle`.
    - `an approvals or inbox part that throws answers none and { off: true }`.
    - `stop ends every approval, poll and timer`.
    - `inline (HARNESSD_SERVICES=none) wiring gets the same port`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/api.spec.ts src/core/devicesLink.spec.ts src/services/devicesProcess.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% per file.
- [ ] **Step 5: Commit** `devices: wire the approvals, the voice inbox and the Orca actions to their port`.

### Task 10: The two hook routes and the core's wiring

**Layer:** core. **Depends on:** Tasks 2, 9. **Effort:** `xhigh` (the daemon's listener; a held request).

**Files:**
- Modify:
  - `cli/src/hookServer.ts` — `HookServerHandlers` (:69); two route blocks beside `/api/hook/observed` (:960)
  - `cli/src/core/main.ts` — beside `createObservedHook` (:2263) and in the `startHookServer` handlers (:2312)
  - `cli/src/architecture.coreFiles.txt` — add `core/deviceHookCalls.ts`, sorted
- Test: `cli/src/hookServer.spec.ts` (beside :303-340)

**Interfaces:**
- Consumes: `createDeviceHookCalls` (Task 2), `DevicesPort` (Task 9), `cableWatchingLocal()` (`main.ts` :1250).
- Produces:
  - `HookServerHandlers.onApproval?(body: unknown, gone: AbortSignal): Promise<'invalid' | ApprovalDecision>` and `onInbox?(body: unknown, gone: AbortSignal): Promise<'invalid' | 'off' | { text?: string }>`.
  - Both routes: 401 without `hookOk`; `readBody(req, 4096)` for approval, `readBody(req, 1024)` for inbox; bad JSON or `'invalid'` → 400. `gone` aborts when `res` closes before it was written; nothing is written after that.
  - `/api/hook/approval` → 200 `{ decision }`; with no handler, 200 `{ decision: 'none' }`.
  - `/api/hook/inbox` → `'off'` or no handler → 503 `{ error: 'NO_DEVICE' }`; else 200 with the answer.
  - `main.ts`: `createDeviceHookCalls({ ready: cableWatchingLocal, devices: () => ports.devices, newId: randomUUID })`, its two members handed to `startHookServer`. Wiring only.

- [ ] **Step 1: Write the failing tests** in `hookServer.spec.ts`, for both routes:
  - `answers 401 without the hook token`; `400 to a bad json body`; `400 to a body one byte over its limit` (4097, 1025); `400 when the handler says invalid`.
  - `answers the handler's decision`; `answers none when no handler is wired`.
  - `inbox answers 200 with the text, 200 {} when the hold ran out, 503 when off or unwired`.
  - `the signal aborts when the client goes before the answer, and not after it`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookServer.spec.ts src/architecture.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS; `architecture.spec.ts` passes with exactly one new line.
- [ ] **Step 5: Commit** `core: /api/hook/approval and /api/hook/inbox take a hook's call to the devices, and start nothing`.

### Task 11: The hook's client, `harness device claude approve`

**Layer:** CLI only. **Depends on:** none. **Effort:** `xhigh` (what leaves the hook; never an environment variable).

**Files:**
- Create: `cli/src/deviceClaude/approve.ts`, `cli/src/deviceClaude/approve.spec.ts`

**Interfaces:**
- Produces:
  - `approvalSummary(tool: string, input: unknown): string` — one line, at most 200 bytes of UTF-8, cut on a character, control characters turned to spaces:
    - `Bash` → the first line of `input.command`
    - `Edit`, `Write`, `Read` → `input.file_path`; `NotebookEdit` → `input.notebook_path`
    - `WebFetch` → the host of `input.url`
    - `mcp__<server>__<tool>` → `<server>: <tool>`
    - anything else, or a missing field → the tool's name
  - `runApprove(deps: { stdin: AsyncIterable<Buffer | string>; post(body: { sessionId: string; tool: string; summary: string; cwd?: string }): Promise<'allow' | 'deny' | 'none'>; out(text: string): void }): Promise<0>`
  - `daemonPost(dataDir: string, port: number): (body) => Promise<'allow' | 'deny' | 'none'>` — `daemonFetch` (`lib/localTransport.ts`) to `/api/hook/approval`, 310 s; the hook token header where there is no socket, as `notify.mjs` sends it. Any error, status or shape other than a 200 with a decision is `'none'`.
- Rules:
  - No decision, and no post: stdin over 256 KB, not JSON, no `session_id` or `tool_name`, or a `tool_name` of `AskUserQuestion` or `ExitPlanMode`.
  - A `tool_name` over 64 characters is cut to 64.
  - The body holds `sessionId`, `tool`, `summary`, `cwd` and nothing else.
  - It imports nothing from `core/`, `services/` or `cable/`: the three decisions are spelled here.

- [ ] **Step 1: Write the failing tests:**
  - `the summary per tool` (a table: every row above, a multi-line command, a URL with a path and query, an MCP name).
  - `cuts 300 bytes of multi-byte text to at most 200 on a character`; `a tab or a newline in the summary becomes a space`.
  - `no decision and no post for AskUserQuestion and ExitPlanMode`; `for 256 KB + 1 of stdin`; `for stdin that is not JSON`.
  - `prints the allow decision`, `the deny decision with its message`, `nothing for none`, each byte for byte; `always exits 0`.
  - `a daemon that is not running, a 500, a 404 and a timeout are none`.
  - `a connection that closes mid-wait prints nothing and exits 0`.
  - `the posted body never carries ORCA_PAIRING_CODE, ORCA_AGENT_SESSION_SPAWN_TOKEN or any other environment variable`: set both and a marker variable, post to a local listener, and compare the whole body with the four expected fields.
  - `the rest of tool_input is not posted` (a `Write` with `content`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/approve.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `cli: the approval hook's client, which asks the dial and decides nothing by itself`.

### Task 12: Status, enable and disable against Claude Code

**Layer:** CLI only. **Depends on:** none. **Effort:** `high`.

**Files:**
- Create: `cli/src/deviceClaude/plugin.ts`, `cli/src/deviceClaude/plugin.spec.ts`

**Interfaces:**
- Produces:
  - `const PLUGIN_ID = 'harness-device@openharness'`, `MARKETPLACE = 'openharness'`, `MIN_CLAUDE = '2.1.287'`
  - `type ClaudeRun = (args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>`
  - `claudeRun(): ClaudeRun | null` — the binary from `installedEngineBin('claude')` (`lib/engineBin.ts`), run with `execFile`; null when not found.
  - `claudeStatus(deps: { run: ClaudeRun | null; platform: NodeJS.Platform }): Promise<{ supported: boolean; installed: boolean; enabled: boolean; claudeVersion: string | null }>`
  - `claudeEnable(deps)`, `claudeDisable(deps)`: `Promise<{ ok: true } | { ok: false; error: string }>`
- Rules:
  - `claudeVersion`: the `x.y.z` in `claude --version`; null when not found or unreadable.
  - `supported`: macOS or Linux, and the version ≥ 2.1.287 compared by number.
  - `installed`, `enabled`: the entry of `claude plugin list --json` with `id === PLUGIN_ID` and `scope === 'user'`; `enabled` is its `enabled`.
  - `enable`: unsupported → `error` "Claude Code 2.1.287 or later is needed." Installed and on → nothing runs. Installed and off → `claude plugin enable harness-device@openharness --scope user`. Else: when `claude plugin marketplace list --json` has no `openharness`, `claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins`; then `claude plugin install harness-device@openharness --scope user`.
  - `disable`: installed → `claude plugin uninstall harness-device@openharness --scope user`; not installed → nothing runs. The marketplace stays.
  - Timeouts: 60 s for the marketplace add and the install, 15 s for the rest. A failed or timed-out call is `error`, the first line of its stderr or "Claude Code did not answer."

- [ ] **Step 1: Write the failing tests** against a fake `claude` (a recording `ClaudeRun`, and one real script on a temp `PATH` for `claudeRun`):
  - `status with no claude`; `2.1.286 is not supported, 2.1.287 and 2.10.0 are`; `Windows is not supported at any version`.
  - `status reads installed and enabled from the user-scope entry and ignores a project-scope one`.
  - `enable adds the marketplace, then installs`; `enable with the marketplace there only installs`; `enable when installed but off runs plugin enable`; `enable twice runs nothing the second time`.
  - `enable when unsupported runs nothing and gives the sentence`.
  - `disable uninstalls and leaves the marketplace`; `disable when not installed runs nothing`.
  - `the install waits 60 s and the list 15 s`; `a failed call gives one line`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/plugin.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `cli: say whether Claude Code has the device plugin, and turn it on or off`.

### Task 13: The `harness device` command

**Layer:** CLI only. **Depends on:** Tasks 11, 12. **Effort:** `high`.

**Files:**
- Create: `cli/src/deviceClaude/command.ts`, `cli/src/deviceClaude/command.spec.ts`
- Modify: `cli/src/cli.ts` — a `case 'device'` beside `'devices'` (:3083), loaded with `import()` as `'swarm'` is (:3116); the usage text (:225)

**Interfaces:**
- Consumes: `runApprove`, `daemonPost` (Task 11); `claudeStatus`, `claudeEnable`, `claudeDisable`, `claudeRun` (Task 12); `localSocketRoute` (`lib/localTransport.ts`).
- Produces:
  - `const DEVICE_USAGE: string` — names `status`, `enable` and `disable` only.
  - `runDeviceCommand(argv: string[], deps: { dataDir: string; port: number; out(line: string): void; err(line: string): void; … }): Promise<number>`:
    - `claude status [--json]` → the status object (one line with `--json`); exit 0.
    - `claude enable`, `claude disable` → exit 0, or the error on stderr and exit 1.
    - `claude approve` (hidden) → `runApprove`; exit 0.
    - `claude link --json` (hidden) → `{"socketPath":"<the daemon's Unix socket>"}`; exit 1 with no output where there is none (Windows). No credential.
    - Anything else → `DEVICE_USAGE` on stderr, exit 1.

- [ ] **Step 1: Write the failing tests:**
  - `status --json prints the four fields on one line`; `enable prints its error on stderr and exits 1`; `disable exits 0`.
  - `link --json prints the socket path and nothing else`; `link on Windows exits 1 with no output`.
  - `approve reads stdin and prints the decision`.
  - `an unknown subcommand prints the usage and exits 1`.
  - `DEVICE_USAGE names status, enable and disable, and neither approve nor link`.
  - `no file under core/, services/ or cable/ imports deviceClaude/` (read the import lines of those folders).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `cli.ts` gets one case and `${DEVICE_USAGE}` in the usage.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run typecheck && npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `cli: harness device claude status, enable and disable`.

### Task 14: The plugin and its approval hook

**Layer:** plugin (run by Claude Code). **Depends on:** none. **Effort:** `high`.

**Files:**
- Create:
  - `plugins/harness-device/.claude-plugin/plugin.json` — name `harness-device`, the author, homepage, repository and license of `plugins/harness`
  - `plugins/harness-device/hooks/hooks.json` — `hooks.PermissionRequest`: matcher `*`, one command hook `${CLAUDE_PLUGIN_ROOT}/hooks/approve`, `timeout: 330`
  - `plugins/harness-device/hooks/approve` — POSIX sh, executable
  - `plugins/harness-device/README.md` — what it does; what it never does (no auto-approve, no "always allow", nothing leaves the computer); how to remove it (`harness device claude disable`)
  - `cli/src/harnessDevicePlugin.spec.ts`
- Modify:
  - `.claude-plugin/marketplace.json` — add `harness-device` after `harness` (`website/scripts/listings.spec.ts` reads `plugins[0]`)
  - `.gitignore` — `plugins/*/.claude-plugin/types/`

**Interfaces:**
- Produces: `hooks/approve` runs `$HOME/.local/bin/harness device claude approve` when that file is executable, else `harness device claude approve` when `harness` is on `PATH`, else exits 0 with no output. It `exec`s, so stdin, stdout and the exit code are the launcher's. It sets no variable.

- [ ] **Step 1: Write the failing tests** in `harnessDevicePlugin.spec.ts`:
  - `the marketplace lists harness first and harness-device second, with source ./plugins/harness-device`.
  - `plugin.json is named harness-device`.
  - `hooks.json holds one PermissionRequest command hook for every tool, at ${CLAUDE_PLUGIN_ROOT}/hooks/approve, with a 330 s timeout`.
  - `hooks/approve is executable and starts with #!/bin/sh`.
  - `with no launcher it exits 0 with no output` (a throwaway `HOME`, `PATH=/usr/bin:/bin`, a `PermissionRequest` input on stdin).
  - `it runs ~/.local/bin/harness first, with device claude approve and the stdin it was given` (a fake launcher that records argv and stdin, and a second one on `PATH` that must not run).
  - `with none in ~/.local/bin it runs the one on PATH`.
  - `the README names harness device claude disable, and says no auto-approve and no always allow`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd website && npx vitest run scripts/listings.spec.ts scripts/agents-site.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `plugin: harness-device, with the hook that asks the dial before the person is asked`.

### Task 15: The mod: voice

**Layer:** plugin (inside Claude Code). **Depends on:** Task 14. **Effort:** `high`.

**Files:**
- Create: `plugins/harness-device/hooks/device.js`, `plugins/harness-device/test/device.test.ts`
- Modify: `plugins/harness-device/hooks/hooks.json` — add `"modules": ["./device.js"]`; `cli/src/harnessDevicePlugin.spec.ts` — the `modules` line

**Interfaces:**
- Consumes: `harness device claude link --json` → `{"socketPath": "…"}` (Task 13's contract); `/api/hook/inbox` and its answers (Global Constraints).
- Produces: `export const register = (on) => …` with one hook, `session.start`, which calls `next(e)` and then starts the loop from `$.clock.after`. Never from an awaited timer inside the hook: that counts toward its 10 s budget.
  - **Link.** `$.env.get('HOME')`, then `$.process.run([`${home}/.local/bin/harness`, 'device', 'claude', 'link', '--json'])`; when that cannot start, `['harness', …]`. No launcher or no socket path: ask again in 60 s.
  - **Poll.** `$.http.fetch('http://harness/api/hook/inbox', { method: 'POST', socketPath, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: await $.session.id() }) })`.
    - 200 with `text` → `$.prompt.submit({ text, asUser: true })`, not awaited; poll again at once.
    - 200 without: poll again at once when the answer took at least 1 s (`$.clock.now()`); sooner than that nothing was held, so again in 60 s.
    - 404 → again in 10 minutes.
    - Anything else, or a fetch that rejects → again in 60 s.
  - It reads `HOME` and no other variable. It registers no tool, command, interface or `classic.*` hook, and touches no settings.

- [ ] **Step 1: Write the failing tests** in `test/device.test.ts` (`test`, `expect`, `mock` from `'claude-code/testing'`; `mock.clock`, `mock.env`; hooks on `process.run`, `http.fetch`, `prompt.submit`, `session.id`):
  - `a delivered text is submitted as the user` (the `prompt.submit` hook sees `text` and `asUser: true`), `and the next poll opens at once`.
  - `an empty 200 after a hold polls again at once and submits nothing`; `an empty 200 that came back at once waits 60 s`.
  - `no daemon: the fetch rejects, and the next try is 60 s later, not before`.
  - `a 503 waits 60 s`; `a 404 waits 10 minutes`.
  - `no launcher in ~/.local/bin falls back to PATH`; `no launcher at all stays idle and asks again in 60 s`.
  - `the poll goes over the socket path link printed, with only the session id in its body`.
  - `with ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN set, neither is read` (`mock.env` records the names asked for: `HOME` only).
- [ ] **Step 2: Run** `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test plugins/harness-device`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.** For types while writing, `claude --plugin-dir plugins/harness-device` lays them in `.claude-plugin/types/` (ignored by git).
- [ ] **Step 4: Run** the step 2 command, then `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device` and `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts`. Expected: PASS; the report shows one `session.start` hook, `$.env.get` of `HOME` only, and no tool, command or interface.
- [ ] **Step 5: Commit** `plugin: the mod takes a spoken prompt from the dial and submits it as the person`.

### Task 16: Round firmware host test: an approval card

**Layer:** firmware host test; no firmware source changes. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior. The firmware is not changed; this test is the proof that it already draws the card. If it fails, stop and report: the spec's "no firmware change" no longer holds.

**Files:**
- Modify: `devices/harness-device/firmware/test/test_question_ui.py`

- [ ] **Step 1: Write the test.** A helper `approval(prompt)` that loads a `question.state` with one question: `key` "approval", options "Allow" and "Deny", `multi` false, no `canText`. Then:
  - `"Allow Bash?\n"` plus a 200-byte command: `s.q.valid && s.q.supported`; `render_question` draws within `HT_RUNS`; no hit in `s.hits` has `A_QUESTION_SAY`; one has `A_QUESTION_CHOICES`.
  - A 255-byte prompt (a 64-character tool name, the summary cut): the same.
  - Choosing "Allow" and sending puts choice mask 1 in the reviewed answer.
  - Write a preview, `approval`, as the other cases do.
  - The card the host sends for a command with CJK and an emoji, `"Allow Bash?\necho ?? ?"` (Task 6's string): `s.q.valid && s.q.supported`; `s.q.item[0].prompt` is that string; `question_rows` of it is 2 (the question and its command line); `render_question` draws within `HT_RUNS`; Allow and Deny as above. Write a preview, `approval-replaced`.
  - The same command as the hook cut it, `"Allow Bash?\necho \xe4\xbd\xa0\xe5\xa5\xbd \xf0\x9f\x99\x82"`: `s.q.valid && !s.q.supported`. This is why the host replaces; when a firmware learns to draw these, this line changes with Task 6's table.
- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_question_ui.py`, then `env -u IDF_PATH make device-test`. Expected: PASS (but the known macOS `test_cable_models.py` "'snprintf' macro redefined").
- [ ] **Step 3: Commit** `round dial tests: an approval card draws with its longest summary and with ? for what it cannot draw, and offers no [say]`.

### Task 17: End to end

**Layer:** test. **Depends on:** Tasks 10, 13. **Effort:** `high`.

**Files:**
- Create: `cli/e2e/deviceClaudeOrca.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `Desk`, `devicesPids`, `FakeDial`, `LocalClient` as `e2e/devicesProcess.e2e.ts` uses them (`fresh()` :51-71, `onTab` :72, `heard` :76). The client is the real CLI: spawn it as `e2e/harness/daemon.ts` starts the daemon (:377-381: the run's bundle, or `--import tsx src/cli.ts`), with `device claude approve`, `d.env`, and a `PermissionRequest` input on stdin (`session_id`, `cwd` under `d.projectsDir`, `tool_name: "Bash"`, `tool_input.command`).

- [ ] **Step 1: Write the tests:**
  - `no dial: the client prints nothing at once and exits 0, and no devices process was started` (`devicesPids(d)` is empty).
  - `the dial gets the card, and Allow prints the allow decision`: the `question` frame has `id` starting `approval:`, the folder's name, and `Allow Bash?` with the command; the agent's row lists `a`. The dial sends `question.read`, then `answer.reviewed` with the token and choice mask 1. The client's stdout is the allow line byte for byte; the dial hears `question.close`.
  - `Deny prints the deny decision with its message`.
  - `killing the client closes the card` (SIGKILL; the dial hears `question.close`).
  - `with a window open the client prints nothing at once`.
  - `the inbox route answers 503 with no dial, and holds a poll with one` (a POST over the daemon's socket, aborted after 1 s).
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS. Then `e2e/devicesProcess.e2e.ts`, `e2e/devicesOnDemand.e2e.ts` and `e2e/deviceCompat.e2e.ts`: PASS.
- [ ] **Step 3: Commit** `e2e: the dial allows and denies a Claude Code prompt outside Harness`.

### Task 18: Say it in the daemon's own docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`. **Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of the processes table), `cli/src/services/AGENTS.md` (the devices paragraph, "A service that drives hardware")

- [ ] **Step 1:** Add to the row: approvals and voice for agents outside Harness. Add to the paragraph, in two or three sentences: a hook's approval and inbox call reach the devices as a request with a deadline (`core/deviceHookCalls.ts`); the core asks only while a dial watches, so a call never starts their process; a client that goes first is told as a notice.
- [ ] **Step 2: Commit** `docs: the devices answer a hook's approval and hold the mod's poll`.

### Task 19: Rebase on wave 0's merge

**Layer:** none. **Depends on:** Tasks 1-18, and wave 0 merged to `main`. **Effort:** `high`. **Red test:** none: no behavior (workflow).

**Files:** none of its own; conflicts only in the files Tasks 1, 5, 7, 8, 9 and 10 touched.

- [ ] **Step 1:** `git fetch origin && git rebase origin/main`. Resolve by keeping wave 0's merged lines and reapplying this plan's change on them.
- [ ] **Step 2: Run** `cd cli && npm run typecheck && npm run test:core && npx vitest run src/cable src/deviceClaude src/hookNotify.spec.ts src/hookServer.spec.ts src/harnessDevicePlugin.spec.ts src/architecture.spec.ts`. Expected: PASS, 100% per file.
- [ ] **Step 3:** Report the new head to the main session. The Verification below runs on it.

---

## Verification

Local gates, recorded in the pull request (PR CI does not run them): `cd cli && npm run typecheck && npm run test:core`; `env -u IDF_PATH make device-test`; check 2's two commands. Platforms the pull request names: macOS and Linux; Windows only refuses (`supported: false`).

No temporary workflow is needed: the one long check has a repo workflow.

**Turns.** Two things here are shared. The tester asks the orchestrator for a turn before using either, and starts nothing until the turn is granted.
- **A runner turn** before starting CLI end to end on GitHub (check 1). It is a heavy run: eight shards, about 70 minutes of test time.
- **A dial turn** before every step that needs the dial (checks 3 and 4). The orchestrator asks Diego. The dial is used only after the turn is granted, and only for the steps asked for.

**1. The daemon, a fake dial and the real hook client**
- Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts e2e/devicesProcess.e2e.ts e2e/devicesOnDemand.e2e.ts e2e/deviceCompat.e2e.ts`, on a Mac or Linux box.
- Isolation: the suite's own (`e2e/harness/daemon.ts`): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, no backend and no sign-in.
- A person sees: every test passes; the daemon's log has `[device] approval · shown` and `· allowed` lines with no command in them.
- On GitHub, by hand, once on the final head, after the orchestrator grants a runner turn: Actions → CLI end to end → Run workflow, branch `feat/device-claude-orca` (`.github/workflows/cli-e2e.yml`). Every shard passes.

**2. The plugin, in Claude Code's own checker and test runner**
- Run on a Mac with Claude Code 2.1.323 or later: `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate plugins/harness-device`, then `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test plugins/harness-device`.
- Isolation: a throwaway config folder; no daemon, no backend, no login.
- A person sees: the validation passes, with one `session.start` hook and `HOME` the only variable read; every test passes.
- On GitHub: none, and no CI job is added. Both run locally and their results (the validation report, the tests passed) go in the pull request.

**3. On a dial: approvals, open and disable** (the spec's checks 1, 2, 3, 7, 8)
- When: only after wave 0 has merged to `main` and this branch is rebased on it (Task 19).
- Where: Diego's Mac, his real round dial and his real Claude Code. The desktop app closed, the dial on USB with wave 0's firmware (`0.1.0-dev`, wave 0 Task 10). No firmware is flashed for this plan.
- Turn: a dial turn (above) before the first step, and again for any step the turn did not name.
- Before anything changes, save what is there, to put it back: `harness version`, `claude plugin marketplace list --json`, `claude plugin list --json`.
- Build: `make install-cli` from the final head (a local install; nothing is published).
- The plugin, before it is in the public marketplace: `claude plugin marketplace add <this checkout>` (the folder is the `openharness` marketplace), then `harness device claude enable`. `harness device claude status --json` says `installed` and `enabled`.
- Backend: none is called. Every frame stays between Claude Code, the daemon and the dial on this Mac. The daemon is the everyday one, because Claude Code in Orca runs the real `~/.claude` hooks and `~/.local/bin/harness`.
- A person does and sees:
  1. Claude Code in an Orca terminal asks to run a command. The dial shows the question; opened, it reads "Allow Bash?" and the command, with Allow and Deny and no `[say]`. Allow runs it and the terminal's prompt closes. Again, with Deny: refused.
  2. The same prompt, answered in the terminal: the dial's card closes.
  3. Auto mode: a command the classifier allows never reaches the dial.
  7. On an Orca agent's latest result, `[desktop]` brings its terminal forward in Orca (`[ on desktop ]`, where a question shows it, does the same). These existing controls are the tap; no firmware change. Swiping through the agents moves nothing in Orca.
  8. `harness device claude disable`: the next prompt never reaches the dial.
- Evidence: the daemon log's `[device] approval · …` lines for each step.
- After, once check 4 is done too, in this order (the release CLI has no `harness device` yet):
  1. `harness device claude disable`; `harness device claude status --json` says `installed: false`.
  2. `claude plugin marketplace remove openharness` removes the folder marketplace. When the saved list had `openharness` from GitHub, add it back (`claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins`). Both `claude` lists read as saved.
  3. Put the release CLI back with the public installer (`curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash`, as `cli/scripts/install-cli.sh` says). `harness version` reads as saved, with no `-dev.`, and the daemon runs on it.
  4. Tell the orchestrator the dial is free.

**4. On a dial: voice** (the spec's checks 4, 5, 6)
- Same Mac, dial, build, plugin and turns as check 3, before its "After".
- Backend: **staging, never production.** Speech-to-text is asked of the backend the daemon is signed in to, so these three checks run on a daemon started on the staging env file (`docs/development.md`, "Isolated end-to-end testing"):
  - `harness stop`, then `HARNESS_ENV_FILE=<the staging env file, absolute> harness start`. The file's path comes from the orchestrator with the dial turn. The everyday daemon stays stopped meanwhile: one daemon holds the dial.
  - Before the first spoken word, `harness status` reports the staging backend and a staging sign-in, and the dial lists the agents of checks 4-6 (their hooks reach this daemon). If either is not so, stop and tell the orchestrator; never fall back to production.
  - When the staging file moves the data folder or the port, start those Claude Code and Codex sessions from a shell that exports the same `HARNESS_ENV_FILE`, so their hook and the launcher find this daemon.
- A person does and sees:
  4. An idle Claude Code in Ghostty: a spoken prompt starts a turn. A working one: the dial says "<name> is busy. Say it when it is done."
  5. Codex in an Orca terminal, idle: a spoken prompt is typed and starts a turn.
  6. Claude Code in an Orca chat: a spoken prompt starts a turn, through the mod.
- Evidence: `[device] voice · mod`, `· orca` and `· busy` lines.
- After: `harness stop`, then `harness start` with no env file; `harness status` reports the everyday backend and account. Then check 3's "After".

## Answers (2026-11-13)

Diego's answers to this plan's open questions:

1. **On-dial checks** run on his real dial, Mac and Claude Code, only after wave 0 merges to `main`. `make install-cli` from this branch is allowed; afterwards the release CLI is put back, `harness device claude disable` runs and the folder marketplace is removed. Every step that needs the dial is asked for from the orchestrator first, and the dial is used only after a turn is granted. The three voice checks run on a daemon on the staging env file, never production. (Verification, checks 3 and 4.)
2. **A summary the dial cannot draw.** The summary line is never dropped: each character the round dial cannot draw becomes `?`, in the devices process, when the card is built. The firmware's table is the source of truth. (Global Constraints, Tasks 6 and 16.)
3. **The tap that opens Orca** is the existing `[desktop]` / `[ on desktop ]`. Per-host labels come later. No firmware change.
4. **`claude plugin validate` and `claude plugin test`** run locally and their results go in the pull request. No CI job.
5. **Measures** are daemon log lines, as the dial's notify tally.

Also: CLI end to end on GitHub is a heavy run; the tester asks the orchestrator for a runner turn before starting it.

Accepted as the plan decided them, where the spec was silent:
- **Timers:** the devices' 300 s and 25 s decide; the core waits 305 s and 27 s, the client 310 s.
- **No dial:** the inbox route answers 503, not an empty 200, so the mod can tell it from a hold that ran out. The mod also waits 60 s after an empty 200 that came back in under 1 s, so no daemon can make it spin.
- **Open polls:** at most 64 in all.
- **After Allow, Deny or a terminal answer** the agent goes back to `working`; after expiry it stays `needs-you`, as the spec says.
- **Voice routes:** when the mod misses its 5 s and the agent has an Orca handle, the words go through Orca.
- **Copy:** an MCP tool's summary is `<server>: <tool>`; a failed Orca send says "<name> did not answer."; a transcript over 2000 characters is refused with "Too long. Say it shorter."
- **The card's text** is cut to 255 bytes, since a 64-character tool name and a 200-byte summary do not fit the firmware's 256.
- **`claude plugin marketplace add`** gets the install's 60 s, not 15 s.
