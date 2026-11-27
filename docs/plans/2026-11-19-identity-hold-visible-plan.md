# A held agent says why — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges, and every task ends green.

**Goal:** A hold only the person can clear (a build with no native helper, a program replaced while it ran) is a named state with the person's sentence; the daemon logs it once; `harness wait`, `show`, `watch` and `ps` read `namedState`, and `wait` ends with exit 3 on a held one.

**Architecture:**
- **The hold's reason is the sentence (approach A).** `nativeProcessControl` throws `IdentityReadUnavailable` whose message is the sentence itself, so `identityHold` is the sentence and `agentFrame` passes it on as `namedState` (it already does for any string in `NAMED_STATES`). Nothing maps one string to another.
- **The core changes in one place:** `hold()` in `cli/src/core/agents/bind.ts` logs only when `registry.setIdentityHold` changed the row.
- **The client decides held by a list it knows** (`namedStateOf` in `cli/src/agentClient/model.ts`): the OpenClaw states, OpenClaw's local stop and the two new sentences are held; any other sentence is recovering. Every verb asks that one function.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`. No Dart change.

**Spec:** `docs/plans/2026-11-19-identity-hold-visible-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core; Testing rules 4-6) and `docs/validation-and-release.md` ("What PR CI does not run").

## Base

- `fix/identity-hold-visible` at `959a54236f` (`main` after #4463). The spec and this plan are untracked; the main session commits them, no task does.
- External dependency of Task 8 only: `fix/agentclient-trust-macos` (commits `f360b64a2f..bb7e6c657b`) merges into `main` and the main session rebases this branch onto it. After that merge every macOS `IsolatedDaemon` carries the helper (`--import $E2E_PROCESS_IMAGES_PRELOAD` from the sources, embedded in the `E2E_BUNDLE` build). Tasks 1-7 and 9 do not wait for it.
- Line numbers below are the base's. A task follows the expression it names when a line has moved.
- Nothing is installed in this worktree (no `cli/node_modules`): the first task runs `npm ci` in `cli/`.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The two sentences, and the replaced-program hold is one | `cli/src/engines/kit/identityScan.ts`, `cli/src/lib/agentFrame.ts`, `cli/src/lib/agentFrame.spec.ts`, `cli/src/lib/nativeProcessControl.ts`, `cli/src/lib/nativeProcessControl.spec.ts`, `cli/src/lib/agentHandoff.ts`, `cli/src/lib/agentHandoff.spec.ts` | none | high | `agentFrame.spec.ts`, `nativeProcessControl.spec.ts`, `agentHandoff.spec.ts` (new cases) |
| 2 A build with no usable helper is held with its sentence | `cli/src/lib/nativeProcessImages.ts`, `cli/src/lib/nativeProcessImages.spec.ts`, `cli/src/lib/nativeProcessControl.ts`, `cli/src/lib/nativeProcessControl.spec.ts` | 1 | high | `nativeProcessImages.spec.ts`, `nativeProcessControl.spec.ts` (new cases) |
| 3 The core logs a hold once | `cli/src/core/agents/bind.ts`, `cli/src/core/agents/bind.spec.ts` | none | high | `bind.spec.ts` (new case) |
| 4 The client knows a held state | `cli/src/agentClient/model.ts`, `cli/src/agentClient/model.spec.ts` | 1 | medium | `model.spec.ts` (new cases) |
| 5 `harness wait` ends on a held one | `cli/src/agentClient/commands.ts`, `cli/src/agentClient/commands.spec.ts` | 4 | high | `commands.spec.ts` (new cases) |
| 6 `harness show` says held | `cli/src/agentClient/commands.ts`, `cli/src/agentClient/commands.spec.ts` | 5 | high | `commands.spec.ts` (new cases) |
| 7 `harness watch` says held | `cli/src/agentClient/commands.ts`, `cli/src/agentClient/commands.spec.ts` | 6 | high | `commands.spec.ts` (new cases) |
| 8 End to end on macOS: a daemon without the helper | `cli/e2e/identityHoldVisible.e2e.ts` (new), `cli/e2e/harness/daemon.ts` | 2, 3, 5; external: after `fix/agentclient-trust-macos` merges and the branch is rebased | high | none on the branch: it pins Tasks 2, 3 and 5; its run on the base (`main` after that merge, without this branch's changes), red, is the report's evidence. One commit |
| 9 Agent-facing copy names `held` | `cli/src/agentClient/help.ts`, `cli/src/agentClient/help.spec.ts`, `plugins/harness/skills/harness/SKILL.md` | none | medium | none: copy only, one commit |

Longest chain: 1 → 4 → 5 → 6 → 7 (five tasks). Tasks 1, 3 and 9 start at once; 2 and 4 start when 1 is done and run beside each other. Task 8 also waits for the external merge and rebase.

## Global Constraints

- Exact copy (approved; copy it byte for byte, the apostrophe is U+0027):
  - no helper in the build: `This Harness install is incomplete. Reinstall Harness.`
  - program replaced: `This agent's program was updated while it ran. Restart the agent.`
  - `harness wait`, held: `<name>: held · <sentence> Only the person can fix this.`
  - `WAIT_USAGE` exit 3: `3 one needs the person (a question, a permission, or a problem only they can fix)`
  - `harness wait` timeout on a recovering state: `<name>: timeout · <sentence> Wait again or read it: <show step>`
  - next step for a held one (wait and show): `{ tell: 'tell the person: <sentence>' }`
  - `WATCH_USAGE` event: `held (what only the person can fix)`, after `needs_person (its last words),`
  - `help.ts` States: `States: working, idle, needs the person, held, installing, starting, stopped, gone, closed, failed.`
  - `SKILL.md` exit 3: `3 when it needs the person (a question, a permission, or a problem only they can fix: only the person answers those, so tell them)`
  - `SKILL.md` new bullet, exactly: `- An agent Harness cannot follow until the person acts shows as \`held\`, with what to do: tell the person.`
- Handoff: the missing-helper hold gets the generic `IDENTITY_UNAVAILABLE` with no `hold` code; `PROGRAM_REPLACED` stays for the replaced-program hold only. No new handoff code.
- JSON field is `namedState` in every verb. A held one also carries `state: "held"` and `needsPerson: true`.
- Held (ends `wait` with exit 3): `OPENCLAW_STATES` values, `isOpenclawLocalStopped(...)`, the two new sentences. Every other `namedState` is recovering: printed, never ends `wait`, never exit 3.
- Held takes precedence over what the screen shows. A stopped, offline or cloud harness is never held.
- The core changes only `hold()` in `cli/src/core/agents/bind.ts`. No new push from `core/toolWatches.ts`; a hold set during a wait is seen at the next look (at most 60 s).
- No change to when a hold is set or released, to identity checks, or to the transient reasons (`the native control helper is unavailable`, `the native control probe did not complete`).
- No Dart change, no new Flutter test, no design-doc or gallery change.
- No new setting, no dev-only copy. The only change to how e2e daemons start is Task 8's `IsolatedDaemon` option, which turns the helper off for the daemon that sets it; every other daemon starts as before.

## Decided here, where the spec was silent

- **One function decides:** `namedStateOf(frame)` in `model.ts`; `stateOf` is unchanged, so `reply`, `route`, `tell` and `close` behave as today. `rowsOf` uses `namedStateOf` for `ps`.
- **`ps` order:** a held row ranks with `working` and `needs-input` (rank 0), and `forAgent` counts it busy: it needs the person, as a question does. `psNext` is unchanged (its `wait` step then exits 3 with the sentence).
- **`ps` JSON** gets `state: "held"` only, as the spec says; no `namedState` on rows.
- **`wait` timeout with background commands and a recovering sentence:** the background words win, as today; the sentence replaces only `still working`.
- **`watch` while held** counts as "the next change is pushed" (60 s backstop), so a hold that lasts hours costs one look a minute, not one every 3 s.
- **The missing-helper check is memoized per bundled source string** (the define never changes in a process), so the 5 s pass hashes the artifact once, not each time.
- **A broken artifact is "no helper" for discovery too:** `bundledProcessImageHelper` returns `null` without a preparation attempt; discovery falls back to `lsof` as it does today after the failed preparation.

## Review Focus

1. A `namedState` the client does not know (a newer daemon on another machine) must not end `wait` or say "needs the person" (call 3). Tests: Task 4 `namedStateOf` unknown case; Task 5 "does not end on a recovering state".
2. A `namedState` that is not a non-empty string (malformed or older frame) is ignored, never printed as `undefined`. Test: Task 4.
3. A held agent whose screen says working still ends `wait` at the first look, and `show` says held, not working. Tests: Task 5 and Task 6 "held over a working screen".
4. The hold's reason changing (A then B) is logged again; the same reason on a later pass is not; a release then the same hold again is logged again. Test: Task 3.
5. A valid bundled artifact whose preparation fails (unwritable cache, timeout) stays the transient `the native control helper is unavailable`, never the "Reinstall" sentence (anti-goal). Test: Task 2.

---

### Task 1: The two sentences, and the replaced-program hold is one

**Files:**
- Modify: `cli/src/engines/kit/identityScan.ts:9-11` (constants)
- Modify: `cli/src/lib/agentFrame.ts:237` (`NAMED_STATES`)
- Modify: `cli/src/lib/nativeProcessControl.ts:253-255` (the replaced-program throw)
- Modify: `cli/src/lib/agentHandoff.ts:612` (`PROGRAM_REPLACED` check)
- Test: `cli/src/lib/agentFrame.spec.ts`, `cli/src/lib/nativeProcessControl.spec.ts`, `cli/src/lib/agentHandoff.spec.ts`

**Interfaces:**
- Produces, in `identityScan.ts`: `export const MISSING_HELPER = 'This Harness install is incomplete. Reinstall Harness.'` and `export const REPLACED_PROGRAM = "This agent's program was updated while it ran. Restart the agent."` (the old wording goes; keep the doc comment, saying the string is the named state the person reads).
- A hold whose words are the sentence is thrown as `new IdentityReadUnavailable('', SENTENCE)` (the existing `message` parameter, as `ObservedConversationUnavailable` does), so `error.message === SENTENCE` and `identityHold === SENTENCE`.

- [ ] **Step 0:** `cd cli && npm ci`.
- [ ] **Step 1: Write the failing tests**
  - `agentFrame.spec.ts`, new `it('names a build without its helper and a replaced program as named states')`: a row with `identityHold: MISSING_HELPER` gives `namedState: MISSING_HELPER`; the same for `REPLACED_PROGRAM`; a row with `identityHold: 'Conversation identity is held: the native control helper is unavailable.'` has no `namedState`.
  - `nativeProcessControl.spec.ts`, the existing `it('names a live process whose program was replaced on disk, …')` (line 113): for the live pid, `rejects.toMatchObject({ message: REPLACED_PROGRAM })` and `rejects.toBeInstanceOf(IdentityReadUnavailable)`; the gone pid keeps `'probe did not complete'`.
  - `agentHandoff.spec.ts`, the existing `it('names a held binding whose program was replaced, and only that one')` (line 500): `replaced` becomes `REPLACED_PROGRAM` (imported); add a hold of `MISSING_HELPER`, which rejects with `{ code: 'IDENTITY_UNAVAILABLE' }` and `hold` undefined (decided: the generic code; `PROGRAM_REPLACED` is for the replaced program only).
- [ ] **Step 2:** `npx vitest run src/lib/agentFrame.spec.ts src/lib/nativeProcessControl.spec.ts src/lib/agentHandoff.spec.ts` — FAIL (no `MISSING_HELPER` export; message mismatch). Commit red.
- [ ] **Step 3: Implement**: the constants above; `NAMED_STATES` gains `MISSING_HELPER` and `REPLACED_PROGRAM`; `nativeProcessControl.ts` throws `new IdentityReadUnavailable('', REPLACED_PROGRAM)`; `agentHandoff.ts` checks `session.identityHold === REPLACED_PROGRAM`.
- [ ] **Step 4:** the same run passes; `npm run typecheck` passes; `grep -rn "replaced on disk while it was running" cli/src cli/e2e` finds nothing.
- [ ] **Step 5: Commit** `The replaced-program hold says what to do, as a named state`.

### Task 2: A build with no usable helper is held with its sentence

**Files:**
- Modify: `cli/src/lib/nativeProcessImages.ts:176-188` (`bundledProcessImageHelper`'s artifact read)
- Modify: `cli/src/lib/nativeProcessControl.ts:229-237` (darwin path start)
- Test: `cli/src/lib/nativeProcessImages.spec.ts`, `cli/src/lib/nativeProcessControl.spec.ts`

**Interfaces:**
- Consumes: `MISSING_HELPER` (Task 1).
- Produces, in `nativeProcessImages.ts`: `export function processImageHelperBundled(): boolean` — true only when `__DARWIN_PROCESS_IMAGES__` is a string that parses to an artifact passing every `artifactBytes` check (schema 1, `sha256` hex, size bounds, base64 round trip, checksum). The parse and the check are memoized per source string, and `bundledProcessImageHelper` reads the artifact through the same private function (one way to read it), returning `null` at once when it is not usable.
- `nativeProcessControl`, on darwin, before the helper race: `if (!processImageHelperBundled()) throw new IdentityReadUnavailable('', MISSING_HELPER)` — no spawn, no preparation. Linux and other platforms unchanged.

- [ ] **Step 1: Write the failing tests**
  - `nativeProcessImages.spec.ts`, `it.each` over: no global, `'not json'`, `{}` (no `sha256`), schema 2, size mismatch, base64 not round-tripping, checksum mismatch → `processImageHelperBundled()` is `false`, and `bundledProcessImageHelper()` resolves `null` without creating `<runtime>/process-images`; a valid artifact (`Buffer.alloc(64, 7)`, as the existing tests build it) → `true`.
  - `nativeProcessControl.spec.ts`, new `it('holds a build with no usable helper with the person\'s sentence, at once')`: no `__DARWIN_PROCESS_IMAGES__` stubbed → rejects with `{ message: MISSING_HELPER }`, `host.helper` and `host.exec` not called.
  - `nativeProcessControl.spec.ts`, new `it('keeps a valid helper that could not be prepared as the transient reason')`: a valid artifact stubbed, `host.helper.mockResolvedValueOnce(null)` → rejects with `'the native control helper is unavailable'` and the message is not `MISSING_HELPER`. The existing `it('uses the remaining deadline and stops a missing, late or failed helper …')` (line 125; its `helper.mockResolvedValueOnce(null)` at line 131) and any other test that expects the transient reason stub a valid artifact the same way.
- [ ] **Step 2:** `npx vitest run src/lib/nativeProcessImages.spec.ts src/lib/nativeProcessControl.spec.ts` — FAIL (no export). Commit red.
- [ ] **Step 3: Implement** as in Interfaces. Comment why: a build with no helper never recovers until reinstalled, so its hold says so; a helper that failed to prepare may recover on a later pass.
- [ ] **Step 4:** the same run passes, on this Mac (the "macOS process images" row of `docs/validation-and-release.md`); `npm run typecheck` passes.
- [ ] **Step 5: Commit** `A build without the native helper holds its agents with a sentence that says to reinstall`.

### Task 3: The core logs a hold once

**Files:**
- Modify: `cli/src/core/agents/bind.ts:384-392` (`hold`)
- Test: `cli/src/core/agents/bind.spec.ts`

**Interfaces:** none new. `hold(error)` keeps its return value (`set`); it logs `[discovery] <id> binding held · <reason>` only when `set` is true. The release line (line 427) and the revalidate path (line 372) are unchanged.

- [ ] **Step 1: Write the failing test**, in `describe('binding a running process to its session')`: `it('logs a hold once, and again only when its words change or it comes back after a release')`. Three passes whose native read throws `IdentityReadUnavailable('', MISSING_HELPER)` → `binding held · This Harness install is incomplete. Reinstall Harness.` logged exactly once; a fourth pass throwing another reason → that reason logged once more; a pass that reads completely → `binding released`; a pass throwing `MISSING_HELPER` again → logged again. Use the spec's existing pass fixtures (lines 537-630 show how a read is made to throw).
- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts` — the new case FAILS (three lines). Existing cases that expect the line on a repeated, unchanged hold are updated to expect it once; list them in the report. Commit red.
- [ ] **Step 3: Implement**: move the `console.log` inside `if (set)`.
- [ ] **Step 4:** `npx vitest run src/core/agents/bind.spec.ts` passes; `npm run test:core` passes with `bind.ts` at 100% (lines, branches, functions, statements).
- [ ] **Step 5: Commit** `The daemon logs an identity hold once, not on every 5 s pass`.

### Task 4: The client knows a held state

**Files:**
- Modify: `cli/src/agentClient/model.ts` (`Frame`, `State`, new `namedStateOf`, `rowsOf`, `forAgent`)
- Test: `cli/src/agentClient/model.spec.ts`

**Interfaces:**
- Consumes: `MISSING_HELPER`, `REPLACED_PROGRAM` (`../engines/kit/identityScan.js`); `OPENCLAW_STATES`, `isOpenclawLocalStopped` (`../engines/openclaw/contract.js`).
- Produces:
  - `Frame.namedState?: string` (doc: the daemon's sentence, `lib/agentFrame.ts`).
  - `State` gains `'held'`.
  - `export function namedStateOf(frame: Frame): { sentence: string; held: boolean } | null` — `null` when the frame is stopped, offline or cloud, or `namedState` is not a non-empty string; `held` true only for the list in Global Constraints.
  - `rowsOf`: `state` is `'held'` when `namedStateOf(frame)?.held`, else `stateOf(frame)`; `rank` and `forAgent`'s `busy` treat `held` as `needs-input`.

- [ ] **Step 1: Write the failing tests** in `describe('a harness as the agent verbs show it')`:
  - `it('knows a held named state by the list, and any other sentence as recovering')`: each of `MISSING_HELPER`, `REPLACED_PROGRAM`, `OPENCLAW_STATES.noGateway`, `"OpenClaw's local run stopped: boom"` → `{ held: true }`; `OTHER_ENGINE_STATES.lost` and `'A state from a newer Harness.'` → `{ held: false }`; `namedState` of `''`, `42`, absent → `null`; a held sentence on a `status: 'stopped'`, `'offline'` or `location: 'cloud'` frame → `null`.
  - `it('lists a held harness as held, with the ones needing the person')`: `rowsOf` gives `state: 'held'` for an active frame with `namedState: MISSING_HELPER` and `activity: { state: 'working' }`; it sorts before an idle row; `forAgent` counts it busy; a recovering sentence leaves the row's state as `stateOf` says.
- [ ] **Step 2:** `npx vitest run src/agentClient/model.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4:** `npx vitest run src/agentClient/model.spec.ts` passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `The agent verbs know a state only the person can fix`.

### Task 5: `harness wait` ends on a held one

**Files:**
- Modify: `cli/src/agentClient/commands.ts`: `WAIT_USAGE` (line 112), `Settled` (1393), `waitNext` (1440), `look` in `waitCommand` (1520-1576), results, JSON and text output, exit (1622-1661)
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Consumes: `namedStateOf`, `State` `'held'` (Task 4).
- Produces: `Settled` gains `'held'`; `waitNext(state: string, run: {...}, sentence?: string)` returns `[{ tell: \`tell the person: ${sentence}\` }]` for `held`. Each result carries `namedState` when the frame it ended on has one (held or recovering).
- `look`: right after the `frame.status === 'stopped'` check, `if (namedStateOf(frame)?.held) return 'held'` (before any screen read).
- Text: held → `${name}: held · ${sentence} Only the person can fix this.`; timeout with a recovering sentence and no background commands → `${name}: timeout · ${sentence} Wait again or read it: ${read}`.
- JSON: held → `needsPerson: true`, `namedState`, `next` as above.
- Exit: `states.includes('needs-input') || states.includes('held')` → `EXIT.needsInput`, in the same place in the chain as today.
- `WAIT_USAGE` exit line: `Exit status: 0 idle or closed by you, 3 one needs the person (a question, a permission, or a problem only they can fix), 4 one stopped or is gone,` then `124 timed out.` on the next line, as today.

- [ ] **Step 1: Write the failing tests**, a new `describe('a harness held for the person')` next to `describe('refusals and the person')`, with `FakeDaemon` frames carrying `namedState`:
  - `it('wait ends on a held one with exit 3 and its sentence, in text and JSON')`: frame `kid` with `namedState: MISSING_HELPER` → `EXIT.needsInput`; `out[0] === 'kid: held · This Harness install is incomplete. Reinstall Harness. Only the person can fix this.'`; JSON `harnesses[0]` matches `{ state: 'held', namedState: MISSING_HELPER, needsPerson: true, next: [{ tell: 'tell the person: This Harness install is incomplete. Reinstall Harness.' }] }`.
  - `it('wait ends on a held one over a working screen, at the first look')`: `activity: { state: 'working' }`, `namedState: REPLACED_PROGRAM` → `EXIT.needsInput`, and no `agent_close` inspect request was made.
  - `it('wait does not end on a recovering state, and says it when the time is up')`: `namedState: OTHER_ENGINE_STATES.lost`, screen working, `--timeout 1s` → `EXIT.timeout`; `out[0]` is `kid: timeout · Live view fell behind. Rebuilding from history; check its history for missed events. Wait again or read it: harness show kid`; JSON has `namedState` and no `needsPerson`. The same with `'A state from a newer Harness.'`.
  - `it('wait with --any returns on the held one')`: two targets, one held → `EXIT.needsInput`.
  - The usage test, if any asserts `WAIT_USAGE`, updated to the new exit line.
- [ ] **Step 2:** `npx vitest run src/agentClient/commands.spec.ts -t "held for the person"` — FAIL. Commit red.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4:** `npx vitest run src/agentClient/commands.spec.ts src/agentClient/mcp.spec.ts src/agentClient/help.spec.ts` passes (mcp already answers exit 3 as an answer); `npm run typecheck` passes.
- [ ] **Step 5: Commit** `harness wait ends with exit 3 on a harness only the person can fix, and says why`.

### Task 6: `harness show` says held

**Files:**
- Modify: `cli/src/agentClient/commands.ts`: `showCommand` (965-1055), `showNext` (877)
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Consumes: `namedStateOf` (Task 4); the `describe('a harness held for the person')` block (Task 5).
- `showCommand`: `const named = namedStateOf(t.frame)`; `listed` is `'held'` when `named?.held`; a held one reads no screen (`inspect` skipped, as for stopped); `state` stays `'held'`. `next` is `[{ tell: \`tell the person: ${sentence}\` }]` for held, ahead of the other branches. JSON adds `namedState` (held or recovering) and `needsPerson: true` for held. Text, right after the header line: `held: <sentence>` for held, `<sentence>` for recovering. Exit 0. `--work` prints `held` in its header as `stateSaid` does.

- [ ] **Step 1: Write the failing tests** in the same `describe`:
  - `it('show says held, the sentence and to tell the person, reading no screen')`: header `kid on studio: held · Codex · started by you`, line 2 `held: This Harness install is incomplete. Reinstall Harness.`, `Next:` tells the person the sentence; no inspect request; JSON `{ state: 'held', namedState: MISSING_HELPER, needsPerson: true, next: [{ tell: 'tell the person: This Harness install is incomplete. Reinstall Harness.' }] }`; exit `EXIT.ok`.
  - `it('show gives a recovering state as the screen says, with its sentence')`: screen idle, `namedState: OTHER_ENGINE_STATES.unavailable` → header says `idle`, line 2 is the sentence, JSON `namedState` set, no `needsPerson`.
- [ ] **Step 2:** `npx vitest run src/agentClient/commands.spec.ts -t "held for the person"` — the new cases FAIL. Commit red.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4:** `npx vitest run src/agentClient/commands.spec.ts` passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `harness show says when a harness is held, and why`.

### Task 7: `harness watch` says held

**Files:**
- Modify: `cli/src/agentClient/commands.ts`: `WATCH_USAGE` (120), `WatchEvent` (1672), `EVENT_STATES` (1681), `follower` (1702-1776), `printWatch` (1895-1918)
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Consumes: `namedStateOf` (Task 4).
- `WatchEvent` gains `'held'`; `EVENT_STATES.held = 'held'`.
- `follower.look`: after the stopped checks, `if (named?.held) { idle = null; pushedNext = true; return 'held' }`. `round` reads no turn for `held` and keys the line on the sentence, so a new sentence is a new line and the same one is said once.
- `printWatch`: `held` words are `{ namedState: sentence }`; text `HH:MM:SSZ <name>: held: <sentence>`. `watch --mine` gets it through the same follower.
- `WATCH_USAGE`: the events list gains `held (what only the person can fix)` after `needs_person (its last words),` (approved copy).
- Exit codes unchanged.

- [ ] **Step 1: Write the failing tests** in `describe('harness watch')`:
  - `it('says held once with its sentence, and working again once the hold is gone')`: looks: working → held (`namedState: MISSING_HELPER`) → held (same) → working without `namedState`. Lines: `working`, `held` with `namedState: MISSING_HELPER` and `state: 'held'` in JSON, `working`. The held line appears once.
  - `it('waits a minute between looks while held, as while working')`, in `describe('wait and watch on pushed events')`: with push on, a held look sleeps `PUSHED_BACKSTOP_MS`.
- [ ] **Step 2:** `npx vitest run src/agentClient/commands.spec.ts -t "held"` — FAIL. Commit red.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4:** `npx vitest run src/agentClient` passes; `npm run typecheck` passes.
- [ ] **Step 5: Commit** `harness watch says when a harness becomes held`.

### Task 8: End to end on macOS: a daemon without the helper

**Starts only after `fix/agentclient-trust-macos` has merged into `main` and this branch is rebased onto it** (the main session does the rebase), besides Tasks 2, 3 and 5.

**Files:**
- Create: `cli/e2e/identityHoldVisible.e2e.ts`
- Modify: `cli/e2e/harness/daemon.ts` (`DaemonOptions`; the `script` choice in `start`, around line 555 after the merge). No spec pins the spawn arguments at `f360b64a2f..bb7e6c657b` (checked: `cli/src/testing/processImages.spec.ts` tests the setup, not `start`); if the rebased `main` has one, it is in this task's files.

**Interfaces:**
- Consumes: `IsolatedDaemon`, `LocalClient`, `until` (`e2e/harness/`); the `harness()` runner shape of `e2e/agentClient.e2e.ts` (spawn `node --import tsx src/cli.ts` with `d.env`); `MISSING_HELPER`.
- Produces, in `DaemonOptions`: `withoutProcessImages?: boolean`, doc: start from the sources with no process-image helper, even under `E2E_BUNDLE` (whose build embeds it): a build that ships without the helper (`identityHoldVisible.e2e.ts`). With it set, `start` uses `['--import', 'tsx', 'src/cli.ts']`: no `E2E_PROCESS_IMAGES_PRELOAD` import, and `E2E_BUNDLE_PATH` ignored. `scriptPath` together with it throws `withoutProcessImages runs the sources; it cannot run a given bundle` (an installed bundle may embed a helper). Every daemon that does not set it starts exactly as before. Decided here: an option, not the existing `launch`, so the test does not copy the daemon's start line (heap, entry).
- The file is `describe.runIf(process.platform === 'darwin')`: the helper is macOS only. Its daemon sets `withoutProcessImages: true`; it does not rely on tsx having no helper.

- [ ] **Step 1: Write the option and the test** `it('a build without its helper holds its agent with a sentence, logs it once, and wait ends with exit 3')`:
  - `IsolatedDaemon.create({ withoutProcessImages: true })`, `start()`, `onTestFailed` prints the log's last 150 lines.
  - Start a fake Codex harness: `harness new codex <projectsDir>/held --name held -- hello`.
  - `until` the agent's `agents_list` row has `namedState === MISSING_HELPER` (60 s).
  - `harness wait held --timeout 2m` → code 3, stdout `held: held · This Harness install is incomplete. Reinstall Harness. Only the person can fix this.`
  - `harness show held --json` → `{ state: 'held', namedState: MISSING_HELPER, needsPerson: true }`; `harness ps --json` row `state: 'held'`.
  - The log holds `binding held · This Harness install is incomplete. Reinstall Harness.` exactly once after at least two more bind passes: wait on a per-pass signal the daemon already logs or the fake engine already records (find one; no fixed sleep). If none exists, report it instead of adding a sleep.
- [ ] **Step 2: Evidence it would fail without the change:** in a throwaway worktree at the base, `main` after the `fix/agentclient-trust-macos` merge, without this branch's changes (`git worktree add <scratchpad>/base <that main commit>`, the new e2e file and the `daemon.ts` option copied in, `npm ci`), the test FAILS: with the option set, the agent is held but shows no `namedState`. Remove that worktree afterwards (only the one this step made). If on the base the agent is not held at all (no `binding held` line), stop and report to the main session: the e2e then needs a different way to reach a missing helper.
- [ ] **Step 3:** on the branch, on this Mac, `npx vitest run --config vitest.e2e.config.ts e2e/identityHoldVisible.e2e.ts` passes, and passes again with `E2E_BUNDLE=1` (the option runs the sources even then). `npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts` still passes (its daemons keep the helper).
- [ ] **Step 4: Commit** `E2E: a daemon without its native helper says so, once, and wait ends on it (macOS)`.

### Task 9: Agent-facing copy names `held`

**Files:**
- Modify: `cli/src/agentClient/help.ts:39`, `cli/src/agentClient/help.spec.ts` (if it pins the line), `plugins/harness/skills/harness/SKILL.md:89-90,98`

Approved copy, byte for byte:
- `help.ts` States: `States: working, idle, needs the person, held, installing, starting, stopped, gone, closed, failed.`
- `SKILL.md` line 89: `3 when it needs the person (a question, a permission, or a problem only they can fix: only the person answers those, so tell them)`.
- `SKILL.md` after line 98, exactly: `- An agent Harness cannot follow until the person acts shows as \`held\`, with what to do: tell the person.`

- [ ] **Step 1:** edit; `npx vitest run src/agentClient/help.spec.ts` passes.
- [ ] **Step 2: Commit** `Agents read held among the states, and what exit 3 now covers`.

## Verification

**Unit tests, per layer (each task's Step 4; all on this Mac, nothing outside the worktree):**
- Daemon: `npx vitest run src/lib/nativeProcessImages.spec.ts src/lib/nativeProcessControl.spec.ts src/lib/agentFrame.spec.ts src/lib/agentHandoff.spec.ts`.
- Core: `npx vitest run src/core/agents/bind.spec.ts`.
- Clients: `npx vitest run src/agentClient`.
- `npm run typecheck`.

**Local gates PR CI does not run (record the receipts in the PR body):**
- `npm run test:core` at 100% per file, since `cli/src/core/agents/bind.ts` changes: run `python3 scripts/local-checks.py --run` from a clean tree at the final commit; it plans `cli-core` for these paths and prints the receipt to paste.
- macOS process images (`docs/validation-and-release.md`, "CLI serial, PTY and login-shell specs; macOS process images"), since `nativeProcessImages.ts` and `nativeProcessControl.ts` change, on this Mac:
  `python3 cli/scripts/build-process-images.py --output "$TMPDIR/process-images.json"` then, in `cli/`, `HARNESS_PROCESS_IMAGES_ARTIFACT="$TMPDIR/process-images.json" node scripts/test-process-images-bundled.mjs` — expected last line `Bundled native query, discovery, control and cache recovery passed on arm64`. This proves a real bundled helper is still "usable" and its removed cache file is still the transient hold.

**End to end on this Mac (Task 8):** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/identityHoldVisible.e2e.ts`, then the same with `E2E_BUNDLE=1`. Isolation is `IsolatedDaemon`'s own: a private root, home, data, auth and runtime folders, its own port and socket, its own tmux server, fake Codex, signed out with the backend at `ws://127.0.0.1:9` (nothing leaves the machine), no real account; its daemon sets `withoutProcessImages: true`, so the helper is off for it alone. A person sees nothing; the test asserts `namedState`, `harness wait` exit 3 with the held line, and `binding held` once.

**Regression check on this Mac:** `npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts` still passes after the change.

**CLI end to end on GitHub, once, by hand:** Actions → CLI end to end → Run workflow on `fix/identity-hold-visible` (`gh workflow run cli-e2e.yml --ref fix/identity-hold-visible`), after the final review. It runs on Linux, where the helper state cannot occur, and checks the core's log change and the verbs against the e2e suite that greps `binding held` (`eagerIdentity`, `enginehomes`, `hermesTerminalRecord`). Report the run link.

**Desktop pane note:** no screenshot check: it would touch the person's installed Desktop app; `desktop/test/pane_named_state_test.dart` already proves `PaneNote` shows any `namedState`.

No temporary workflow: the long check (CLI end to end) has its own workflow, and the macOS checks need this Mac.
