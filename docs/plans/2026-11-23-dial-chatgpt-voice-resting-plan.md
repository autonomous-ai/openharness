# Voice to a resting ChatGPT app thread opens it, then queues the words: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Words spoken (or a voice draft sent) to a ChatGPT app row with no process open exactly that thread in the
ChatGPT app, then go to Codex's durable queue of exactly that thread, or the dial says why.

**Architecture:** All in the devices process. The one `AppWake` (`cable/hosts/appWake.ts`) gets a second target kind,
`{ app: 'codex', threadId, agentId, name }`: after the too-long and one-at-a-time checks it runs the thread's link
alone through the noted ChatGPT adapter (`codexNoted.show`, which notes the dial's own switch), and only on `'ok'`
calls `codexQueue.send(threadId, text, true)`, whose answer is the wake's. `CodexAppSource` gives a listed row voice
when its link can open, a `codex queue` can run and Harness's `CODEX_HOME` is the app's home, and hands its words to
the wake.

**Tech Stack:** TypeScript (Node 24), Vitest with injected fakes and fake timers, the CLI's e2e harness (real daemon,
recording `open`/`xdg-open`, fake `xdg-mime`, the app CLI's fake and its queue ledger, in-memory `FakeBackend`, fake
dial).

**Spec:** `docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md` (approved; the PM's decisions of 2026-11-23 are
final: no wait for a hook, link then queue through the same `AppWake`, one wake at a time across both apps, no
`--resume`, no voice when `CODEX_HOME` is not the app's home, no real engine on this machine, X12 last and small).
Base: `fix/dial-chatgpt-voice-resting-thread` at `135c5e99fa`.

Paths: `HO/` is `cli/src/cable/hosts/`.

## Decisions (PM, 2026-11-23)

1. **Q1, X12's tier: option (c).** A tier-A-only world setting says Harness's `CODEX_HOME` is the app's Codex folder;
   X12 runs in tier A only; the real daemon is proven by Task 4's e2e. Task 5 is final as drafted.
2. **Q2, a `codex queue` send that throws:** answered as the Claude target answers its send's rejection,
   `<name> did not answer.`, `[codex-app] wake · refused`, `codex-wake-refused`. Task 1 is final as drafted.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | `AppWake`'s ChatGPT target | `HO/appWake.ts`, `HO/appWake.spec.ts`, `HO/claudeAppSource.ts`, `HO/claudeAppSource.spec.ts`, `cli/src/cable/cableSession.spec.ts`, `cli/src/services/devices.ts` | none | xhigh | `appWake.spec.ts` ChatGPT cases; `claudeAppSource.spec.ts` target and stop cases |
| 2 | The resting row takes voice; the devices wire it | `HO/codexAppSource.ts`, `HO/codexAppSource.spec.ts`, `HO/codexApp.ts`, `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts` | 1 | xhigh | `codexAppSource.spec.ts` and `devices.spec.ts` new cases |
| 3 | The refusals on the dial | `cli/src/cable/cableSession.spec.ts` | 1, 2 | high | none: tests only, pins at the dial's layer what 1 and 2 land; one commit |
| 4 | End to end | `cli/e2e/deviceCodexAppWake.e2e.ts` (new) | 2 | high | none: test tooling, one commit |
| 5 | Eval X12 | `cli/src/testing/dialAppEval/catalog.ts`, `catalog.spec.ts`, `baseline.json`, `types.ts`, `tierA/world.ts`, `tierA/world.spec.ts` | 2, 3, 4 | high | `catalog.spec.ts` ids `X1-X12`; `world.spec.ts` new case |
| 6 | The devices row | `cli/AGENTS.md` | none | medium | none: docs, one commit |

**Longest chain:** 1 → 2 → 4 → 5 (four tasks; 1 → 2 → 3 → 5 is as long). Tasks 1 and 6 start at once. Tasks 3 and 4
share no file and run side by side after 2. Task 5 waits for 3 and 4 only on the PM's word that the eval goes last, so
its rebase onto `feat/dial-eval-iterm2` (which edits `catalog.spec.ts` and `types.ts` now) is the branch's last commit.

## Global Constraints

- Nothing in `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `devices/` (firmware), `desktop/` or `device-app/`:
  `git diff --stat 135c5e99fa -- cli/src/core cli/src/architecture.coreFiles.txt devices desktop device-app` prints
  nothing. `src/architecture.spec.ts`, `src/architecture.failureLogs.spec.ts` and `src/leanEntry.spec.ts` stay green.
- Platforms: macOS, Windows, Linux. A row takes voice where `codexApp.canLink` says yes (macOS; Windows through its
  raise; Linux once `xdg-mime` named a `.desktop` file for `codex`), `codexQueue.can(true)` says yes, and
  `env.CODEX_HOME` resolves to the app's home.
- **One class, one instance** (Decision 1): `AppWake` is not forked; `devices.ts` builds one, `appWake`, for both apps.
  One wake at a time across both apps (Decision 3).
- **Link first, then queue** (Decision 2): the link only through `codexNoted.show(codexPane(threadId), agentId)`
  (never `noteLink`, never the adapter's `forward`); `'failed'` or `'busy'` queues nothing. Nothing but the target's
  `threadId` chooses the thread.
- `codex queue`'s arguments unchanged (`['queue', '--thread', id, '--message=<text>']`, no `--resume`, Decision 4).
- Bounds: `WAKE_MS = 30_000` over the link only; the queue's own `QUEUE_TIMEOUT_MS = 10_000`; `MAX_TEXT`.
- Copy, exact (`<name>` is the target's name; for another wake running, the name of the one opening):

  | Case | Reason | Log line | Count |
  |---|---|---|---|
  | link failed (`'failed'`, or `openThread` rejected) | `<name> did not open in ChatGPT.` | `[codex-app] wake · open failed` | `codex-wake-open-failed` |
  | another wake runs, or the link answered `'busy'` | `Still opening <name>. Try again in a moment.` | `[codex-app] wake · busy` | `codex-wake-busy` |
  | too long | `Too long. Say it shorter.` | `[codex-app] wake · too long` | `codex-wake-too-long` |
  | stopped while the link runs | `<name> did not answer.` | `[codex-app] wake · stopped` | `codex-wake-stopped` |
  | 30 s while the link runs | `<name> did not open in ChatGPT. Try again.` | `[codex-app] wake · timeout` | `codex-wake-timeout` |
  | queued | (the usual transcript) | `[codex-app] wake · sent · <ms> ms` | `codex-wake-sent` |
  | queue `busy` | `<name> has not taken your last words yet.` | `[codex-app] wake · pending` | `codex-wake-pending` |
  | queue `timeout` | `<name> did not answer.` | `[codex-app] wake · queue timeout` | `codex-wake-queue-timeout` |
  | queue `failed` (`exit N`, `no binary`) | `Update ChatGPT, then try again.` | `[codex-app] wake · queue failed` | `codex-wake-queue-failed` |
  | queue `failed`, `refused`; or its send rejected (Q2) | `<name> did not answer.` | `[codex-app] wake · refused` | `codex-wake-refused` |
  | row no longer listed (source) | `<agent.name> did not answer.` | none | none |

  `<ms>` is `Math.round(monotonic() - opened)`. Counts go to the devices' `voiced` (`[device] voice · <word>`). The
  Claude target's lines and counts (`[claude-app] wake · …`, `wake-…`) do not change.
- Logs: fixed words and counts only; no name, id, folder, path or text.
- Tests: fakes and throwaway homes only. **No real engine runs on this machine** (Decision 6): not npm `codex`, not the
  ChatGPT app's CLI, not even `--help`. Never the real ChatGPT app, `~/.codex`, `/usr/bin/open` or `xdg-open`.
- `cli/src/services/` is held at 100% per file (`npm run test:core`): every new line of `devices.ts` has its case.
- Comments say why. No switch, option or setting.

## Review Focus

1. **Words to the same thread again once the first wake answered, before any hook lists it:** a second wake runs the
   link again and queues behind the first, in order; never refused busy by a wake that is over. Test: Task 1.
2. **A hook lists the thread while its first words are still being queued, and the person speaks again:** the live
   copy's own `codex queue` path answers `<name> has not taken your last words yet.` and nothing goes ahead of the
   first. Test: Task 2.
3. **The dial reattaches with the ChatGPT app gone while a Claude wake runs** (`CodexAppSource.stop`): the Claude wake
   goes on and delivers. Test: Tasks 1 and 2.
4. **`CODEX_HOME` spelled another way for the same folder** (a trailing separator, a `..` segment) keeps voice, another
   folder takes it off, and with the home flag false neither the link nor the queue look is asked on the list's tick.
   Test: Task 2.
5. **A queue send that rejects** (Q2): the wake ends with its answer and its slot, so the next words are not refused
   busy forever. Test: Task 1.

---

### Task 1: `AppWake`'s ChatGPT target

**Files:**
- Modify: `HO/appWake.ts`, `HO/claudeAppSource.ts`, `cli/src/services/devices.ts`
- Test: `HO/appWake.spec.ts`, `HO/claudeAppSource.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `PaneSwitch`, `SendResult` (`HO/types.ts`); `CodexQueue`, `CodexQueueResult` (`HO/codexQueue.ts`).
- Produces (`HO/appWake.ts`):
  ```ts
  export type WakeApp = 'claude' | 'codex'
  export type WakeTarget =
    | { app: 'claude'; localId: string; sessionId: string; agentId: string; name: string }
    | { app: 'codex'; threadId: string; agentId: string; name: string }
  // AppWakeDeps keeps open, observed, onPoll, after, monotonic, log, count, and gains:
  openThread(threadId: string, agentId: string): Promise<PaneSwitch>
  queue: Pick<CodexQueue, 'send'>
  // AppWake: send(target: WakeTarget, text: string): Promise<SendResult>; waitsFor(sessionId: string): boolean;
  //          stop(app: WakeApp): void
  ```

- [ ] **Step 1: Write the failing tests.**
  - `appWake.spec.ts` fixture: `TARGET` and `SECOND_TARGET` gain `app: 'claude'`; `t.wake.stop()` becomes
    `t.wake.stop('claude')`; `setup()` gains `openThread` (held: each call recorded with its args and answered by the
    test, `'ok' | 'failed' | 'busy'` or a rejection) and `queue.send` (held the same way, recording
    `{ threadId, text, isApp }`; `t.threads()` = the thread ids that received words, in order: the wrong-session gate).
    The Claude cases' assertions do not change.
  - A new describe `"the ChatGPT app's wake (docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md, § 3)"`, with
    `THREAD = '7d3e9a10-2b4c-4d5e-8f60-1a2b3c4d5e6f'`, `CODEX = { app: 'codex', threadId: THREAD, agentId:
    observedAgentId('codex', THREAD), name: 'Fix the tests' }` and a second thread `CODEX_SECOND`; its `afterEach`
    accepts each line and count of either app's fixed set (the table above and the Claude file's `LOG`/`COUNT`) and
    finds no name, id or words in any:
    - `'the link, then one queue call to the target's thread with the exact words; its answer is the wake's'`:
      `openThread` called with `[THREAD, CODEX.agentId]`; nothing queued until it answers `'ok'`; then
      `t.threads()` is `[THREAD]` with `text: WORDS`, `isApp: true`; advance 250, answer `{ outcome: 'queued' }` →
      `{ ok: true }`, line `[codex-app] wake · sent · 250 ms`, count `codex-wake-sent`; `left()` is `NONE` and
      `everListened()` is false (no observed listener, no poll listener).
    - `'a failed link queues nothing: did not open in ChatGPT'`: `'failed'`, and a rejected `openThread` → `{ ok:
      false, reason: 'Fix the tests did not open in ChatGPT.' }`, `threads()` `[]`, `open failed`.
    - `'its rest still opening the link (busy) queues nothing'`: `'busy'` → `Still opening Fix the tests. Try again in a
      moment.`, `threads()` `[]`, `busy`.
    - `'words over MAX_TEXT open nothing'`: no `openThread`, no timer, `too long`.
    - `'one wake at a time across both apps'`: while a ChatGPT wake links, words to the same row, to `CODEX_SECOND` and
      to the Claude `TARGET` each get `Still opening Fix the tests. Try again in a moment.` (the Claude refusal logged
      `[claude-app] wake · busy`); while a Claude wake waits, a ChatGPT target gets `Still opening Fix the build. Try
      again in a moment.` logged `[codex-app] wake · busy`; only one `openThread` and only the first's thread queued.
    - `'stopped or 30 s while the link runs: nothing is queued, the link's late answer neither'`: `stop('codex')` →
      `Fix the tests did not answer.` (`stopped`), then the link answers `'ok'` → `threads()` `[]`; separately
      `advance(30_000)` → `Fix the tests did not open in ChatGPT. Try again.` (`timeout`), late `'ok'` → `[]`.
    - `'once queueing, stop and the 30 s timer change nothing'`: link `'ok'`, `stop('codex')`, `advance(30_000)`, queue
      answers `queued` → `{ ok: true }`; the 30 s timer was cancelled when queueing began.
    - `it.each` over the queue's answers → reason and line: `{ outcome: 'busy' }` → `Fix the tests has not taken your
      last words yet.` (`pending`); `{ outcome: 'timeout' }` → `Fix the tests did not answer.` (`queue timeout`);
      `{ outcome: 'failed', reason: 'refused' }` → `Fix the tests did not answer.` (`refused`); `{ outcome: 'failed',
      reason: 'exit 1', ran: 'app' }` and `{ …, reason: 'no binary', ran: 'path' }` → `Update ChatGPT, then try again.`
      (`queue failed`).
    - Review Focus 5 (Q2): `'a queue send that rejects ends the wake, and the next words open again'`: → `Fix the tests
      did not answer.` (`refused`); a second `send` runs `openThread` again.
    - `'waitsFor is false for a ChatGPT wake'`: `waitsFor(THREAD)` false while it links and while it queues.
    - Review Focus 3: `'stop("codex") leaves a Claude wake running, and stop("claude") a ChatGPT one'`: the Claude wake
      still delivers after its copy and poll; the ChatGPT one still queues after `'ok'`.
    - Review Focus 1: `'words again once the first answered: a second wake links again and queues behind'`:
      `openThread` twice, `threads()` `[THREAD, THREAD]`, texts `['first', 'second']`, both `{ ok: true }`.
  - `claudeAppSource.spec.ts`: the send case expects `[{ app: 'claude', localId: LOCAL, sessionId: SESSION, agentId:
    ID, name: 'Ship it' }, 'run the tests']`; the stop case expects `wake.stop` called once with `'claude'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appWake.spec.ts src/cable/hosts/claudeAppSource.spec.ts`.
  Expected: the new cases FAIL (no ChatGPT target, no `app` in the Claude target, `stop` takes none). Commit the red
  tests: `test(cli): the wake's ChatGPT target, link then queue, one wake across both apps (red)`.
- [ ] **Step 3: Implement.**
  - `appWake.ts`: the target union and `WakeApp`; `Word` gains `'pending' | 'queue timeout' | 'queue failed'`;
    `running` gains its `app`; `say(app, word, line?)` writes `[${app}-app] wake · <line>` and counts `wake-<word>` for
    Claude, `codex-wake-<word>` for ChatGPT (spaces as `-`). The too-long and busy checks stay shared and come first;
    then one private method per app (Claude's body unchanged). The ChatGPT one: phases `linking → queueing → over`;
    `after(WAKE_MS)` set before the link and cancelled as queueing begins; the link's answer and `stop` act only while
    `linking`; on `'ok'` it calls `deps.queue.send(target.threadId, text, true)` with no await before it and maps the
    answer by the table; it listens to nothing else. `stop(app)` stops `running` only when its `app` is that app.
    `waitsFor` answers only for a Claude wake. The header comment says both targets and why the ChatGPT one waits for
    nothing (Codex fact 1: no hook until a turn runs; fact 3: the app's server takes a queued message it did not write).
  - `claudeAppSource.ts`: `send` passes `app: 'claude'`; `stop()` calls `this.deps.wake.stop('claude')`.
  - `devices.ts`: `claudeWake` becomes `appWake` (its declaration, the observed source's `toMod`, the Claude source);
    its comment says it is one for both apps; it gains `openThread: (threadId, agentId) =>
    codexNoted.show!(codexPane(threadId), agentId)` (comment: the link alone, never the forward; the noted adapter notes
    the dial's own switch, so the title the app then shows is its echo) and `queue: codexQueue`. Task 2's
    `devices.spec.ts` cases cover these two lines.
  - `cableSession.spec.ts`: the Claude block's `new AppWake({…})` gains `openThread` and `queue` fakes that are never
    called (typecheck only; its cases do not change).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/appWake.spec.ts src/cable/hosts/claudeAppSource.spec.ts
  src/cable/cableSession.spec.ts src/services/devices.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): the dial's wake takes a ChatGPT thread: its link, then Codex's queue of that thread`.

---

### Task 2: The resting row takes voice; the devices wire it

**Files:**
- Modify: `HO/codexAppSource.ts`, `HO/codexApp.ts`, `cli/src/services/devices.ts`
- Test: `HO/codexAppSource.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: Task 1's `AppWake` (`send`, `stop('codex')`) and the `{ app: 'codex', … }` target.
- Produces: `CodexAppSourceDeps` gains `canLink(threadId: string): boolean`, `canQueue(): boolean`, `inAppHome:
  boolean`, `wake: Pick<AppWake, 'send' | 'stop'>`; `CodexAppSource.capabilities(agent: HostAgent): Caps` and
  `send(agent: HostAgent, text: string): Promise<SendResult>`; `createCodexAppAdapter`'s return type adds
  `Pick<AppLinkVerbs, 'canLink'>` (the object already has it from `createAppLink`).

- [ ] **Step 1: Write the failing tests.**
  - `codexAppSource.spec.ts`: `setup()` gains `canLink`, `canQueue` (both `vi.fn`, true unless set), `inAppHome` (true
    unless set) and `wake = { send: vi.fn(async () => ({ ok: true })), stop: vi.fn() }`. The first row case no longer
    says "no voice and no send". New cases:
    - `'a listed row takes voice exactly when its link opens, a codex queue can run and Harness's Codex home is the
      app's'`: each of the eight combinations, `capsLetters` `'svf'` only for all three true, `'sf'` otherwise;
      `canLink` asked with the row's thread id; an agent not listed has no voice.
    - Review Focus 4: `'with Harness's Codex home not the app's, neither the link nor the queue look is asked'`.
    - `'its words go to the wake with the row's values as they arrive, and the wake's answer is its answer'`:
      `wake.send.mock.calls` is `[[{ app: 'codex', threadId: one.id, agentId: agentOf(one), name: 'Task 1' }, 'run the
      tests']]`; a refusal from the wake is returned as it is.
    - `'a row no longer listed answers did not answer and opens nothing'`: `{ ok: false, reason: '<agent.name> did not
      answer.' }`, `wake.send` not called.
    - Review Focus 3: `'stop() stops the ChatGPT wake once, never the Claude one'`: `wake.stop.mock.calls` `[['codex']]`
      after two stops.
  - `devices.spec.ts`, in `"the ChatGPT app's threads, from its metadata"`: `ROW.caps` becomes `'svf'` on macOS (the
    suite's `env.CODEX_HOME` is its throwaway home's `.codex`, the app's home there). A nested describe `'words to a
    resting thread (docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md)'`, the dial's words through
    `host().sendTurn(ID, …)`, `refused(reason)` as the Claude block's:
    - `'voice runs the thread's link alone, then one codex queue to that thread'`: the link's run held → no
      `codexRuns` while held; let go → `orcaRuns` is `[opened(THREAD)]` only (no `['/usr/bin/open', ['-b', BUNDLE],
      …]`), `codexRuns` is one `['queue', '--thread', THREAD, '--message=run the tests']` with `CODEX_HOME:
      env.CODEX_HOME`; answer `{ ok: true }`; no run names `SECOND`; logs hold `[device] voice · codex-wake-sent` and
      one `/^\[codex-app\] wake · sent · \d+ ms$/`, and no line holds `THREAD`, `SECOND`, `Fix the build` or the words.
    - `'a link that fails queues nothing: no fallback, and the dial is told it did not open in ChatGPT'`:
      `fake.failing = 1` → `refused('Fix the build did not open in ChatGPT.')`, `orcaRuns` `[opened(THREAD)]`,
      `codexRuns` `[]`, logs hold `[codex-app] wake · open failed` and `[device] voice · codex-wake-open-failed`.
    - In the follow describe, with its `following()`: `'the words' link is the dial's own switch: that thread's title
      right after is its echo, and a late title of the thread shown before does not move the dial'`: the app in front,
      `SECOND` named `Ship it`; words to `ID`; `report(TITLE)` within 2 s and `report('Ship it')` each give `[device]
      thread · skipped · echo`, `asked()` stays `[]`.
    - `it.each([['names an app', 'chatgpt.desktop\n', 'svf'], ['names none', '', 'sf']])('on Linux the row takes voice
      once xdg-mime %s')`: the app found as the Linux tap case finds it (`linuxApps('file')`); the first list `'sf'`,
      after the read the row's caps.
    - `'with CODEX_HOME not the app's home the row has no voice'`: `env.CODEX_HOME` set (and restored with
      `onTestFinished`) to `join(homedir(), 'elsewhere')` before `start` → `'sf'`; Review Focus 4: `CODEX_HOME + sep`
      and `join(CODEX_HOME, 'x', '..')` → `'svf'`.
    - `'with no codex, the app's or a launch's, the row has no voice'`: `codex: { ...codex, binary: () => null,
      appBinary: () => null }` → `'sf'`.
    - `'on Windows the link goes through the Windows raise, never its bare raise, then the queue'`: `windows.links`
      `[[`codex://threads/${THREAD}`, BUNDLE]]`, `windows.apps` `[]`, `orcaRuns` `[]`, one queue run to `THREAD`.
    - `'detached while the link runs: did not answer, and nothing is queued'`: the link held, `seen.host.watching!(false)`
      → `refused('Fix the build did not answer.')`; let go → `codexRuns` `[]`; logs hold `[codex-app] wake · stopped`
      and `[device] voice · codex-wake-stopped`.
    - Review Focus 2: `'a hook lists the thread while its first words are being queued: the next words wait their
      turn'`: the first queue run held; `port.observed(hook('session-start'))` with a `transcriptPath` under
      `join(env.CODEX_HOME, 'sessions')`; second words → `refused('Fix the build has not taken your last words yet.')`;
      let go → first `{ ok: true }`; one queue run.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/codexAppSource.spec.ts src/services/devices.spec.ts`.
  Expected: the new cases FAIL (`voice: false`, no `send`). Commit the red tests.
- [ ] **Step 3: Implement.**
  - `codexAppSource.ts`: the deps above; `capabilities(agent)` → `voice: !!row && this.deps.inAppHome &&
    this.deps.canLink(row.threadId) && this.deps.canQueue()`, in that order so a wrong home asks nothing on the list's
    1 s tick; `send` as `ClaudeAppSource.send`, with the codex target; `stop()` calls `this.deps.wake.stop('codex')`
    after its running check, with the comment that it runs at every attach where the app is not found and must not stop
    a Claude wake. The header comment loses "no voice" and says where its voice comes from.
  - `codexApp.ts`: the return type above.
  - `devices.ts`: right after `codexAppHome`, `const codexHomeIsApps = relative(resolve(env.CODEX_HOME),
    resolve(codexAppHome)) === ''` with its why (`codex queue` runs under `CODEX_HOME`, `codexQueue.ts`: under another
    home every queue answers thread not found, so the row does not offer voice it cannot give; path text as
    `observed.ts` `queueable` reads it, and on Windows `relative` ignores case). `codexAppSource` is built when
    `appWake` is, with `canLink: (threadId) => codexApp.canLink(codexPane(threadId))`, `canQueue: () =>
    codexQueue.can(true)`, `inAppHome: codexHomeIsApps`, `wake: appWake`.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts src/services/devices.spec.ts` and `npm run typecheck`. Expected:
  PASS.
- [ ] **Step 5: Commit** `feat(cli): a resting ChatGPT thread takes voice where its link opens and Codex's queue runs`.

---

### Task 3: The refusals on the dial

**Files:**
- Test: `cli/src/cable/cableSession.spec.ts`

Tests only, one commit: they pin at the dial's own layer what Tasks 1 and 2 land. A new describe `"a resting ChatGPT
row's words (docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md)"` beside the Claude one, built as it is: the
registry holds `host.harness` and a real `CodexAppSource` started on a fake reader listing one thread `Fix the build`
(`canLink`, `canQueue` true, `inAppHome: true`), whose `wake` is a real `AppWake` with an `openThread` that never
answers, a `queue` that records, and an `after` the test fires; `host.transcribe` mocked.

- [ ] **Step 1: Write the tests.**
  - `'a resting ChatGPT row takes voice; words while it opens are refused on the dial in plain words'`: voice `u1` (no
    `voice.error` at `voice.begin`), then `u2` → `{ t: 'voice.error', uploadId: 'u2', message: 'Still opening Fix the
    build. Try again in a moment.' }`; nothing queued.
  - `'30 s with the link not answered: the voice error says it did not open in ChatGPT'`: fire the `30_000` timer →
    `message: 'Fix the build did not open in ChatGPT. Try again.'`.
  - `'a voice draft\'s send while it opens resolves with the wake\'s refusal'`: a reviewed draft's `send` →
    `draft.state` with `error: 'Still opening Fix the build. Try again in a moment.'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: PASS on Task 2's head (on
  Task 1's head they fail at `voice.begin`, the row having no voice).
- [ ] **Step 3: Commit** `test(cli): the ChatGPT wake's refusals reach the dial's voice error and the draft's`.

---

### Task 4: End to end

**Files:**
- Create: `cli/e2e/deviceCodexAppWake.e2e.ts`

Test tooling, one commit; `cli/e2e/harness/` untouched (a change there runs PR CI's real-backend canary). macOS and
Linux (`describe.skipIf(process.platform === 'win32')`). Isolation is the harness's own (`cli/AGENTS.md` rule 6,
`e2e/harness/daemon.ts`): an `IsolatedDaemon` with a throwaway root and home; the app's Codex home a
`codexAppFixture` in `$HOME/.codex`; **`d.env.CODEX_HOME` set to that same folder before `d.start()`**, as on a
computer that never set it (Decision 5; `deviceCodexAppThreads.e2e.ts` keeps them apart and its rows stay `sf`), and
checked inside the root; the app installed as that file installs it (macOS: a fake `Info.plist` under
`$HOME/Applications/ChatGPT.app`; Linux: a file at `chatGptPlaces('linux', …)[0]`); `writeSchemeApps` on Linux; the
recording open of `harness/appEvalDriver.ts` at `HARNESS_OPEN_BIN` (`writeRecordingOpen`, `linksFail` for the failing
case), read from its runs file; the queue: on macOS the app's CLI fake (`writeAppCodex`, read by `appQueued`), on Linux
the PATH `codex` fake (its `codex-queue` ledger under the root; `codexQueue.ts` uses the app's CLI on macOS and Windows
only); speech through an in-memory `FakeBackend` signed in as a fixture machine, as `deviceClaudeAppSessions.e2e.ts`'s
`fresh` does; fake dials on a `Desk`. Two threads: `t1` named `Fixture Wake`, `t2`. `t1`'s rollout is in the app's home
before the words, as a real app thread's is, written by a `CodexOutside(d, 'e2e-wake', children, hints, { sessionId:
t1, own: LINUX ? { title: 'ChatGPT' } : undefined })` constructed after `CODEX_HOME` is set (the fake `codex queue`
refuses a thread with no rollout in its `CODEX_HOME`, `fakeEngine.mjs`); hints `{ __CFBundleIdentifier:
'com.openai.codex' }` on macOS, none on Linux (as `appEvalChatgpt.ts`); the fixture's `t1` cwd is `codex.cwd`.

- [ ] **Step 1: Write** `'words to a resting ChatGPT thread open it, then reach its Codex queue alone; its hooks then
  make it a live row with voice'`:
  1. A round dial (`{ appFilter: 'v1' }`) on the ChatGPT page lists `[t1, t2]` at `'svf'` (on Linux a list that still
     says `'sf'` is asked again, as the Claude file's `voiced` does).
  2. `relay.speech = 'run the wake tests'`; voice to `t1` → `voice.transcript` for `t1`'s row with those words.
  3. The open's runs: exactly one, `t1`'s link (`['-b', 'com.openai.codex', url]` on macOS, `[url]` on Linux); none
     names `t2`, none is `-b com.openai.codex` alone.
  4. The ledger: exactly one entry, `{ args: ['queue', '--thread', t1, '--message=run the wake tests'], codexHome:
     $HOME/.codex }`; the other ledger empty; the open's runs file was written no later than the ledger (`mtimeMs`).
  5. The log: `[codex-app] wake · sent · <n> ms` (printed with `console.log` for the pull request), `[device] voice ·
     codex-wake-sent`; every `[codex-app] wake` line matches `^\[codex-app\] wake · (too long|open failed|timeout|busy|
     stopped|refused|pending|queue timeout|queue failed|sent · \d+ ms)$`; neither id, `Fixture Wake` nor the words.
  6. `codex.hook('SessionStart', { source: 'resume' })`, then `codex.hook('UserPromptSubmit')`: the ChatGPT page's row
     for `t1` is one row, same id, `state: 'working'`, its caps holding `v`.
- [ ] **Step 2: Write** `'a link that fails queues nothing, and the dial is told it did not open in ChatGPT'` (a daemon
  of its own): `linksFail(open, ['chatgpt'])` → `voice.error` `Fixture Wake did not open in ChatGPT.`; both ledgers
  empty; the log holds `[codex-app] wake · open failed` and `[device] voice · codex-wake-open-failed`.
- [ ] **Step 3: Run** on this Mac `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceCodexAppWake.e2e.ts`
  (prefix `TMPDIR=/tmp` if the run stops on the socket's length) and `npm run typecheck`. Expected: both cases PASS.
- [ ] **Step 4: Commit** `test(cli): end to end, words to a resting ChatGPT thread open it and reach its queue alone`.

---

### Task 5: Eval X12 (Q1 (c), final)

**Files:**
- Modify: `cli/src/testing/dialAppEval/catalog.ts`, `types.ts`, `tierA/world.ts`, `baseline.json`
- Test: `cli/src/testing/dialAppEval/catalog.spec.ts`, `tierA/world.spec.ts`

Kept small for the rebase onto `feat/dial-eval-iterm2` (it edits `catalog.spec.ts` and `types.ts` now). No new step or
check kind.

- [ ] **Step 1: Write the failing tests.**
  - `catalog.spec.ts`: main ids `C1-C12, X1-X12, …`; `ALL` has 87; `X12` joins the tier A only list (`onlyA`).
  - `world.spec.ts`: `'a world whose codexHome is the app\'s runs the devices with CODEX_HOME at the app\'s Codex home,
    and puts it back at close'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/testing/dialAppEval/catalog.spec.ts
  src/testing/dialAppEval/tierA/world.spec.ts`. Expected: FAIL. Commit the red tests.
- [ ] **Step 3: Implement.**
  - `types.ts`: `Scenario.world` gains `codexHome?: 'app'` (doc: Harness's `CODEX_HOME` is the ChatGPT app's Codex home,
    as on a computer that never set it).
  - `tierA/world.ts`: with it, `env.CODEX_HOME` is the world's app home (`join(root, '.codex')`) before the folders are
    made and the devices start, and is put back at `close`.
  - `catalog.ts`, after X11: `scenario({ id: 'X12', app: 'chatgpt', title: 'Voice on a resting thread: it opens, then
    the exact words are queued to it once', dims: ['D3', 'D5'], tiers: ['a'], world: { codexHome: 'app' }, sessions:
    [...threads(['t1']), chatgptGhost], steps: [{ kind: 'codex.write', sessions: ['t1'] }, ...listed('chatgpt',
    ['t1']), { label: 'voice', kind: 'voice', transcript: 'Eval words for one.', target: 't1' }], checks: [{ id: 'open',
    kind: 'open', dim: 'D3', session: 't1', link: true, after: 'voice' }, { id: 'voice', kind: 'voice', dim: 'D5',
    session: 't1', text: 'Eval words for one.', path: 'codex', after: 'voice' }], probes: [{ id: 'voice', kind: 'voice',
    dim: 'D5', session: 'z', text: 'Eval words for one.', after: 'voice' }] })`. No hook: the thread is in the metadata
    alone.
  - `baseline.json`: `npm run eval:dial-apps -- --tier a --update-baseline`; the diff adds only `a/<platform>/X12/…`
    keys. Every X12 part is expected at 1 on darwin, linux and win32: a 0 or a wrong-session send is a finding to
    report, never written into the baseline.
- [ ] **Step 4: Run** `npx vitest run src/testing/dialAppEval` (the tier A ratchet included). Expected: PASS.
- [ ] **Step 5: Commit** `test(cli): dial eval X12, voice on a resting ChatGPT thread opens it and queues the words once`.

---

### Task 6: The devices row

**Files:**
- Modify: `cli/AGENTS.md`

Docs, one commit, no test. In the `devices` row:
- `one opening at a time for every dial (\`cable/hosts/appWake.ts\`)` becomes `one opening at a time for every dial and
  both apps (\`cable/hosts/appWake.ts\`)`;
- after `and opened by the ChatGPT app's link (\`cable/hosts/codexApp.ts\`)` add `, and spoken to where that link opens,
  a \`codex queue\` can run and Harness's \`CODEX_HOME\` is the app's home: the words open the thread by its link alone,
  then go to that very thread's Codex queue (\`codex queue --thread <id>\`), through the same wake`.

- [ ] **Step 1: Edit**, then **Commit** `docs(cli): the devices row says the ChatGPT app's threads are spoken to
  through the wake`.

---

## Verification

Platforms the pull request names: macOS, Windows, Linux. Nothing runs against production, a real account, the real
ChatGPT app, `~/.codex`, or a real Codex engine (Decision 6).

1. **Unit, per changed file** (`cd cli`, this Mac, final head):
   - `npx vitest run src/cable/hosts/appWake.spec.ts src/cable/hosts/claudeAppSource.spec.ts
     src/cable/hosts/codexAppSource.spec.ts src/cable/hosts/codexApp.spec.ts`
   - `npx vitest run src/cable/cableSession.spec.ts src/services/devices.spec.ts`
   - `npx vitest run src/testing/dialAppEval` (X12 and the tier A ratchet)
   - `npx vitest run src/architecture.spec.ts src/architecture.failureLogs.spec.ts src/leanEntry.spec.ts`
   - `npm run typecheck`
2. **`npm run test:core` applies**: `services/devices.ts` is in `src/services`, held at 100% statements, branches,
   functions and lines per file. Its new lines (the wake's `openThread` and `queue`, `codexHomeIsApps`, the source's
   `canLink`, `canQueue`, `inAppHome`, `wake`) are run by Task 2's `devices.spec.ts` cases. PR CI does not run it: run
   `python3 scripts/local-checks.py --run` from a clean tree at the final commit (it runs `cli-core`) and paste its
   output into the pull request body.
3. **Core untouched:** `git diff --stat 135c5e99fa -- cli/src/core cli/src/architecture.coreFiles.txt devices desktop
   device-app` prints nothing (against `origin/main` after a rebase).
4. **End to end on macOS** (PR CI runs no macOS e2e), fakes only: `cd cli && npx vitest run --config
   vitest.e2e.config.ts e2e/deviceCodexAppWake.e2e.ts e2e/deviceCodexAppThreads.e2e.ts
   e2e/deviceClaudeAppSessions.e2e.ts e2e/deviceCodex.e2e.ts` (arm64 Node; Xcode's command line tools for the process
   images; `TMPDIR=/tmp` if the socket's path is too long). A person reading the output sees every case pass; in the new
   file one recorded link, one ledger entry for `t1` with the words, the console line `wake · sent · <n> ms` (its `<n>`
   goes into the body: a new path, no before), and the failing link's `did not open in ChatGPT`. The three others are
   the paths this branch touches (the ChatGPT rows, the Claude wake, a live thread's queue) and stay green unchanged.
5. **PR CI, selected by the paths** (no extra run): `cli-typecheck`, `cli-tests`, `process-checks`; `linux-e2e` on
   `ubuntu-24.04` runs the new `deviceCodexAppWake.e2e.ts` (the Linux link through the fake `xdg-mime` and `xdg-open`,
   the PATH `codex` fake's queue) and the dial eval's six files (a `cli/src/cable/hosts/` change); `dial-hosts`;
   `windows-e2e` x64 (a `cli/src/cable/` change), where `dialWindowsAppSessions.e2e.ts` keeps the ChatGPT rows at `'sf'`:
   its sealed daemon has no `codex` (`CODEX_PATH` missing, no Store package on the runner). A `'svf'` there means it
   found an installed ChatGPT package: stop and report.
6. **Eval:** `npm run eval:dial-apps -- --tier a` on this Mac; X12's scores and the gate go into the body. Tier B is
   not run for X12 (Q1 (c)).
   The body also says: on Diego's Mac Harness's `CODEX_HOME` and the ChatGPT app's Codex folder are the same folder
   (the default `~/.codex`), so the real case is covered; a person whose `CODEX_HOME` is another folder still gets no
   voice on resting ChatGPT rows, because `codex queue` runs under `CODEX_HOME` and would answer "thread not found" for
   every app thread (the same rule live app threads already follow through `queueable`'s path check), so the dial does
   not offer voice it cannot deliver.
7. **No by-hand workflow:** the full **CLI end to end** run is not needed: the flows this touches are the four files in
   4, run here, and PR CI runs the new one on Linux.
8. **After the merge, a person's check** (needs Ken or Diego: their own ChatGPT app and login, and their eye), written
   in the pull request body as numbered steps from the spec: 1. quit nothing; on the dial's ChatGPT page pick a thread
   not opened since the app started; 2. speak a short sentence; 3. the app opens that thread, and within about 10 s its
   turn starts with those words; 4. no other thread gets them; 5. with the ChatGPT app quit, speak to a resting thread:
   the app starts on that thread and runs the words. Windows: the same steps on the Windows VM. Not a tester check.
9. **Proposal for the final report:** a Windows end to end of this path (`windowsDaemon.ts` has no speech stand-in),
   as its own item.
