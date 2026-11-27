# Voice to a resting Claude app session opens it, then sends: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Words spoken (or a voice draft sent) to a Claude app row with no process open exactly that session in the
Claude app, then reach exactly that Claude Code session's mod once its process runs, within 30 s, or the dial says why.

**Architecture:** All in the devices process. The Claude app's store row takes voice where its link opens
(`appLink.ts` `canLink`). Its `send` hands the row's values to one `AppWake` (`cable/hosts/appWake.ts`), which runs the
Claude adapter's link without the opener's fallback, then waits, pushed by `observed.onChange` and a new
`Inbox.onPoll`, for the bound observed copy (same agent id and Claude Code session id) and a poll of that session opened
after the open; it delivers through `observed.send`, inside the poll's listener when the poll comes last.

**Tech Stack:** TypeScript (Node 24), Vitest with injected fakes and fake timers, the CLI's e2e harness (real daemon,
fake `open`/`xdg-open`, in-memory `FakeBackend`).

**Spec:** `docs/plans/2026-11-21-dial-claude-app-wake-send-design.md` (approved; its Decisions section is the PM's,
2026-11-21). Base: `feat/dial-claude-app-wake-send` at `1ab0f11e49`.

Paths: `HO/` is `cli/src/cable/hosts/`.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | `canLink` | `HO/appLink.ts`, `HO/appLink.spec.ts`, `HO/claudeApp.ts` | none | high | `appLink.spec.ts` new case |
| 2 | `Inbox.onPoll` | `HO/inbox.ts`, `HO/inbox.spec.ts` | none | high | `inbox.spec.ts` new cases |
| 3 | `AppWake` | `HO/appWake.ts` (new), `HO/appWake.spec.ts` (new) | none | xhigh | `appWake.spec.ts` (all) |
| 4 | The row takes voice; the devices wire the wake | `HO/claudeAppSource.ts`, `HO/claudeAppSource.spec.ts`, `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/AGENTS.md` | 1, 2, 3 | xhigh | `claudeAppSource.spec.ts` and `devices.spec.ts` new cases |
| 5 | The refusal's words on the dial | `cli/src/cable/cableSession.spec.ts` | 3, 4 | high | none: pins at the dial's layer what 3 and 4 land; tests only, one commit |
| 6 | End to end | `cli/e2e/deviceClaudeAppSessions.e2e.ts`, `cli/e2e/dialWindowsAppSessions.e2e.ts` | 4 | high | none: test tooling, one commit; the Mac and PR CI's `linux-e2e` and `windows-e2e` run it |

**Longest chain:** 3 → 4 → 5 (three tasks; 3 → 4 → 6, 1 → 4 → 5 and 2 → 4 → 5 are as long). Tasks 1, 2 and 3 start at
once and share no file. `devices.ts` and `devices.spec.ts` are in Task 4 alone. Tasks 5 and 6 share no file and run
side by side after 4.

## Global Constraints

- Nothing in `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `devices/` (firmware), `desktop/` or `device-app/`:
  `git diff --stat 1ab0f11e49 -- cli/src/core cli/src/architecture.coreFiles.txt devices desktop device-app` prints
  nothing. The wake is a `cable/hosts` file, in the devices' import graph only (on Windows reached through the inline
  door's dynamic import, `services/inline.ts`); `src/architecture.spec.ts` and `src/leanEntry.spec.ts` stay green.
- Platforms: macOS, Windows, Linux. The row takes voice where `canLink` says yes: macOS; Windows (its raise); Linux
  only once `xdg-mime` named a `.desktop` file for `claude`.
- **Bound (Decision 1):** `WAKE_MS = 30_000`, from the words' arrival (`AppWake.send` called) to ready. The timer is
  set as `send` starts, before the link runs.
- **Strict binding (Decision 2):** the bound copy is the observed copy whose `id === target.agentId` and
  `sessionId === target.sessionId`, not `ended`; its `app`, the dial's current row, the app's front session and its
  last attach are never read. A poll counts only with `sessionId === target.sessionId`.
- **One wake at a time for the whole devices process (Decision 3):** a second `send` while one runs (opening, waiting
  or delivering) is refused at once, never queued.
- **No firmware change (Decision 4):** the dial's own sending state; failures reach its voice error view as text.
- The ChatGPT app (`codexAppSource.ts`) is not touched (Decision 5).
- Copy, exact (`<name>` is the target row's name; for busy, the name of the row being opened):

  | Case | Reason | Log line | Count |
  |---|---|---|---|
  | too long (over `MAX_TEXT`, Decision 6) | `Too long. Say it shorter.` | `[claude-app] wake · too long` | `wake-too-long` |
  | link failed | `<name> did not open in Claude.` | `[claude-app] wake · open failed` | `wake-open-failed` |
  | 30 s, not ready | `<name> did not open in Claude. Try again.` | `[claude-app] wake · timeout` | `wake-timeout` |
  | bound copy ended before ready | `<name> closed before it took your words.` | `[claude-app] wake · ended` | `wake-ended` |
  | another wake runs | `Still opening <name>. Try again in a moment.` | `[claude-app] wake · busy` | `wake-busy` |
  | stopped (dial detached) | `<name> did not answer.` | `[claude-app] wake · stopped` | `wake-stopped` |
  | delivered | (the usual transcript) | `[claude-app] wake · sent · <ms> ms` | `wake-sent` |
  | `observed.send` refused | its own reason | `[claude-app] wake · refused` | `wake-refused` |
  | row no longer listed (source) | `<name> did not answer.` | none | none |

  `<ms>` is `Math.round(monotonic() - opened)`. Counts go to the devices' `voiced` (`[device] voice · <word>`).
- Logs: fixed words and counts only; no name, id, folder, path or text (`src/architecture.failureLogs.spec.ts` reads
  every new log call).
- Push, not poll: the wake listens to `observed.onChange` and `Inbox.onPoll` only while it runs, with one timer; no
  interval, no fixed sleep anywhere, tests on injected `after` or `vi.useFakeTimers()`.
- Tests use fakes and throwaway homes only: never the real Claude app, `~/.claude`, `/usr/bin/open` or `xdg-open`.
- `cli/src/services/` is held at 100% per file (`npm run test:core`): every new line in `devices.ts` has its case.
- No switch, option or setting. `voiceDraft.ts` is not changed (a refused draft keeps its receipt, as today).

## Review Focus

1. **The mod polls while the link still runs** (`open -b` or `harness-pty open-link` slower than the app): that poll
   counts, and the words go once the link answered true, to the still-held poll, once. Test: Task 3.
2. **The person taps the row while it opens:** the tap runs the link again (two opens of one link do no harm), the wake
   is not refused, and the words still reach the session once. Test: Task 4.
3. **The dial is unplugged mid-wait, then plugged in and spoken to again:** the first answers `stopped` with its
   listeners and timer released, and the next words open the session again instead of being refused busy. Test: Task 3.
4. **The app opens the session but its mod never polls** (the plugin off in that home): the copy is live, nothing is
   delivered, and at 30 s the dial says it did not open. Test: Task 3.
5. **Two dials on one computer** (a Pro and a round): words from the second while the first's open runs are refused
   on the second dial in the busy text, and only the first's words reach the session. Test: Task 6 (two fake dials).

---

### Task 1: `canLink`

**Files:**
- Modify: `HO/appLink.ts` (`AppLinkVerbs`, the returned verbs)
- Modify: `HO/claudeApp.ts` (return type only)
- Test: `HO/appLink.spec.ts`

**Interfaces:**
- Produces: `AppLinkVerbs` gains `canLink(pane: Pane): boolean` = `canOpen(pane.id, false)`: whether the session's link
  can open on this computer, never asking the app in front; on Linux the first look starts the scheme's read and answers
  false. `createClaudeAppAdapter` returns `HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show' | 'paneKey'>> &
  Pick<AppLinkVerbs, 'canLink'>`.

- [ ] **Step 1: Write the failing test** in `appLink.spec.ts`, describe `'an app whose session opens by its link'`:

```ts
it('canLink: macOS and Windows with its raise; Linux only once xdg-mime named an app; never the app in front', async () => {
  expect(recorder({ inFront: () => false }).verbs.canLink(pane('s1'))).toBe(true)
  expect(onWindows([], FAKE, { inFront: () => false }).verbs.canLink(pane('s1'))).toBe(true)
  expect(recorder({ platform: 'win32' }).verbs.canLink(pane('s1'))).toBe(false)
  const linux = recorder({ platform: 'linux', inFront: () => false })
  expect(linux.verbs.canLink(pane('s1'))).toBe(false)   // starts the read
  await settled()
  expect(linux.verbs.canLink(pane('s1'))).toBe(true)
  expect(linux.calls).toEqual([asked])
  for (const none of [recorder({ platform: 'linux' }, [], FAKE, '\n'), recorder({ platform: 'linux', onPath: () => null })]) {
    none.verbs.canLink(pane('s1')); await settled()
    expect(none.verbs.canLink(pane('s1'))).toBe(false)
  }
})
```

(`onWindows` is the helper of `'a link on Windows'`; hoist it to the file's top so both describes use it.)

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appLink.spec.ts`. Expected: FAIL, `canLink is not a function`.
- [ ] **Step 3: Add `canLink` to `AppLinkVerbs` and the returned object**, and the claude adapter's return type. Comment
  why it is not `canFocus`: on Linux a tap's `canFocus` answers yes before the read so a first tap waits for it; voice
  must not be offered before the scheme is known to have an app.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/appLink.spec.ts src/cable/hosts/claudeApp.spec.ts src/cable/hosts/codexApp.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red then green: `test(cli): canLink answers where an app's link opens (red)`, then
  `Dial: an app link says where it can open, apart from a tap's look`.

---

### Task 2: `Inbox.onPoll`

**Files:**
- Modify: `HO/inbox.ts`
- Test: `HO/inbox.spec.ts`

**Interfaces:**
- Produces: `Inbox.onPoll(listener: (sessionId: string) => void): () => void` (the result removes it). Each listener is
  called synchronously inside `poll()`, right after the new poll is held (`this.polls.set`), once per held poll, with
  its session id, each in its own `try/catch`. A poll answered at once is not held and calls none: an early `gone`'s
  poll, and a poll that takes a waiting transcript.

- [ ] **Step 1: Write the failing tests** in `inbox.spec.ts` (its `setup`, `track`, `settle`):

```ts
it('onPoll hears each held poll once, with its session id, before poll() returns; its stop ends it', () => {
  const t = setup(); const heard: string[] = []
  const stop = t.inbox.onPoll((id) => heard.push(id))
  void t.inbox.poll('p1', 's1'); expect(heard).toEqual(['s1'])
  void t.inbox.poll('p2', 's1'); expect(heard).toEqual(['s1', 's1'])
  stop(); void t.inbox.poll('p3', 's2'); expect(heard).toEqual(['s1', 's1'])
})
it('a deliver inside the listener is taken by that very poll', async () => {
  const t = setup(); const taken: string[] = []
  t.inbox.onPoll((id) => { void t.inbox.deliver(id, 'hello').then((d) => taken.push(d)) })
  const poll = track(t.inbox.poll('p1', 's1')); await settle()
  expect(poll.value).toEqual({ text: 'hello' }); expect(taken).toEqual(['taken']); expect(t.pending()).toBe(0)
})
it('a listener that throws harms neither the poll nor the next listener', async () => {
  const t = setup(); const heard: string[] = []
  t.inbox.onPoll(() => { throw new Error('boom') }); t.inbox.onPoll((id) => heard.push(id))
  const poll = track(t.inbox.poll('p1', 's1'))
  expect(heard).toEqual(['s1']); expect(t.inbox.ready('s1')).toBe(true)
  t.advance(25_000); await settle(); expect(poll.value).toEqual({})
})
it('a poll answered at once is not heard: an early gone, a waiting transcript', async () => {
  const t = setup(); const heard: string[] = []
  t.inbox.onPoll((id) => heard.push(id))
  t.inbox.gone('p1'); void t.inbox.poll('p1', 's1')
  polledOnce(t, 's2'); heard.length = 0
  void t.inbox.deliver('s2', 'waiting'); void t.inbox.poll('p2', 's2')
  expect(heard).toEqual([])
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/inbox.spec.ts`. Expected: FAIL, `onPoll is not a function`.
- [ ] **Step 3: Implement** a `Set` of listeners and the call after `this.polls.set(sessionId, held)` inside the
  promise's executor. Comment why there: a `deliver` from the listener must find this poll held, so the Claude app's
  wake hands the first poll its words (the design, § 3.4).
- [ ] **Step 4: Run** the spec again. Expected: PASS, the file's older cases unchanged.
- [ ] **Step 5: Commit** `test(cli): the inbox tells each poll it holds, as it holds it (red)`, then
  `Dial: the mod's inbox tells a listener each poll it holds`.

---

### Task 3: `AppWake`

**Files:**
- Create: `HO/appWake.ts`
- Test: `HO/appWake.spec.ts` (new)

**Interfaces:**
- Consumes: `ObservedSource` (type, `HO/observed.ts`), `HostAgent`, `SendResult` (`HO/types.ts`), `MAX_TEXT`
  (`20_000`, `HO/orca.ts`: the very constant `observed.ts` imports and refuses by).
- Produces:

```ts
/** The bound from the words' arrival to ready (Decision 1): fits the dial's 65 s reply wait with transcription. */
export const WAKE_MS = 30_000
export interface WakeTarget { localId: string; sessionId: string; agentId: string; name: string }
export interface AppWakeDeps {
  open(localId: string, agentId: string): Promise<boolean>
  observed: Pick<ObservedSource, 'list' | 'onChange' | 'send'>
  onPoll(listener: (sessionId: string) => void): () => void
  after(ms: number, run: () => void): () => void
  monotonic(): number
  log(line: string): void
  count(what: string): void
}
export class AppWake {
  constructor(deps: AppWakeDeps)
  send(target: WakeTarget, text: string): Promise<SendResult>
  stop(): void
}
```

**The wake's steps** (the order matters; the tests pin each):
0. `text.length > MAX_TEXT` (Decision 6, the design's § 3 step 0): answer `{ ok: false, reason: 'Too long. Say it
   shorter.' }` at once, before anything opens: no `open`, no listener, no timer, no running wake marked; log `too
   long`, count `wake-too-long`.
1. A wake running (opening, waiting or delivering): answer busy at once, naming the running wake's target.
2. Else, as the words arrive: `opened = monotonic()`; subscribe `observed.onChange(check)` and `onPoll(heard)`; set
   `after(WAKE_MS, timeout)`; read the list once (a bound copy live now counts as live during this wake; one listed
   `ended` now does not). Only then run `open(localId, agentId)`, so a poll that opens while the link runs is heard.
   A rejected `open` counts as `false` (`.catch(() => false)`, no log inside it).
3. `open` false: fail `open failed` at once. True: mark the link answered and `check()`.
4. `heard(sessionId)`: ignore another session's; else mark polled and `check()`, synchronously in the listener.
5. `check()`: find the bound copy. Live: mark it seen live. Missing or `ended` after it was seen live: fail `ended` (at
   any time, also while the link runs). Ready, only once the link answered true: seen live now, and polled.
6. Ready: release both listeners and the timer, then call `observed.send(copy, text)` with no `await` before it (so
   from `heard` the first poll takes the words); the wake stays running until it answers: `ok` → `sent`; refused → its
   reason, `refused`; a rejection → `<name> did not answer.`, `refused`.
7. Every end releases the listeners and the timer once, clears the running wake, logs its line, counts its word.
8. `stop()`: a wake opening or waiting fails `stopped`; one delivering keeps the send's answer; none: nothing.

- [ ] **Step 1: Write the failing tests** in `appWake.spec.ts`. Fakes: an `open` the test answers by hand (a recorded
  deferred per call); an observed source whose `list()` returns the test's copies (`HostAgent` with `id`,
  `sessionId`, `engine: 'claude'`, optional `ended: true`) and whose `emit()` runs its listeners; a fake mod: `poll(id)`
  marks a poll of `id` open and fires the `onPoll` listeners while a flag `inPoll` is set; the fake `observed.send`
  records `{ sessionId: agent.sessionId, text, inPoll }` in `delivered` and answers `{ ok: true }` (or what the test sets);
  `after` records `{ ms, run, cancelled }`; the listener counts of both fakes are readable. Ids: target `SESSION`/`LOCAL`
  named `Fix the build`, `ID = observedAgentId('claude', SESSION)`; another row `SECOND`/`LOCAL_SECOND` named `Ship it`;
  `OTHER` a session of another row; `THIRD` a copy with `paneKeys: [claudePaneKey(LOCAL)]` and its own session id.
  `afterEach`: every log line matches
  `/^\[claude-app\] wake · (too long|open failed|timeout|ended|busy|stopped|refused|sent · \d+ ms)$/` and holds none of
  the names, ids or texts; every count is one of the eight words.

  Each case asserts `delivered.map(({ sessionId }) => sessionId)` (the hard gate):

  - `'words over MAX_TEXT are refused before anything opens: no link, no listener, no timer'`: `send(target,
    'x'.repeat(MAX_TEXT + 1))` answers `{ ok: false, reason: 'Too long. Say it shorter.' }` at once; `open` and `after`
    never called; neither fake ever had a listener; `delivered` `[]` (no session got words); log `too long`, count
    `wake-too-long`. Then `send(target, 'x'.repeat(MAX_TEXT))` is not busy and calls `open` once.
  - `it.each(['the copy, then the poll', 'the poll, then the copy'])('opens once, then delivers to the bound session alone once its copy is live and a poll opened after the open (%s)')`:
    `open` called once with `[LOCAL, ID]`; nothing delivered before both; `delivered` is `[{ sessionId: SESSION, text,
    inPoll: true }]` when the poll comes last (recorded before `poll()` returned) and `inPoll: false` when the copy
    comes last; answer `{ ok: true }`; log `sent · <ms> ms` with the fake clock's gap; `after` was called once with
    `30_000` before `open` was answered; no listener and no timer left.
  - `'a poll heard while the link still runs counts; the words go once the link answered'` (Review Focus 1): copy live
    and poll before `open` answers → nothing delivered; `open` answers true → `[SESSION]`, once.
  - `'stale state is not ready: the ended copy of its last run, and a poll from before the open'`: the list holds the
    target `ended` and a poll of `SESSION` opened before `send`; after `open` true and an emit → `[]`; a new poll with
    the copy still ended → `[]`, no `ended` failure; the copy live → `[SESSION]`. Also: an ended copy that leaves the
    list never fails `ended` (fire the timer → `timeout`).
  - `'two quick prompts to one row: the second is refused busy, the first delivered once'`: second answer `{ ok: false,
    reason: 'Still opening Fix the build. Try again in a moment.' }` before anything resolves; `open` called once;
    `delivered` `[{ sessionId: SESSION, text: 'first' }]` only.
  - `'two prompts to two rows: the second is refused naming the one opening; nothing reaches the second session'`: the
    reason names `Fix the build`; `SECOND`'s copy live and polled → `[]`; the target ready → `[SESSION]`.
  - `'the person switches rows while it opens: no other session gets the words'`: `OTHER` live and polled, `THIRD` live
    and polled → `[]`; then the target live and polled → `[SESSION]`.
  - `it.each(['listed ended', 'gone from the list'])('the app quits mid-open: %s → ended, nothing delivered')`: reason
    `Fix the build closed before it took your words.`; also when it ends while the link still runs.
  - `'no copy ever: timeout at 30 s, nothing delivered'`: the answer pending until the recorded `30_000` timer runs;
    then `Fix the build did not open in Claude. Try again.`; a later copy and poll deliver nothing.
  - `'its copy is live but its mod never polls: timeout, nothing delivered'` (Review Focus 4).
  - `'the link answers false: open failed at once, no wait, no timer left'`: reason `Fix the build did not open in
    Claude.`; the timer cancelled, no listener left; a later copy and poll deliver nothing. Same for a rejected `open`.
  - `'stopped mid-wait: stopped, listeners and timer released; the next words open again'` (Review Focus 3): reason
    `Fix the build did not answer.`; then a new `send` calls `open` again and is not busy. `stop()` with none running
    logs nothing.
  - `'observed.send refused: its own reason'`: the fake answers `{ ok: false, reason: 'api has not taken your last words
    yet.' }` → the same; log `refused`. A rejecting fake → `Fix the build did not answer.`, `refused`.
  - `'a prompt while the words are being delivered is still refused busy'`: the fake `observed.send` held unanswered.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appWake.spec.ts`. Expected: FAIL, cannot find
  `./appWake.js`.
- [ ] **Step 3: Implement `AppWake`** in `HO/appWake.ts` by the steps above. File comment: why the link runs without the
  opener's fallback (a fallback brings the app on whatever session it shows and turns a failed link into a 30 s wait),
  why nothing but the session id binds, why `Inbox.ready()` is not used (true for 35 s after the last run's poll).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/appWake.spec.ts src/architecture.failureLogs.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `test(cli): the Claude app's wake opens one session and hands its words to that session alone (red)`,
  then `Dial: a wake opens a resting Claude app session, waits for its process and mod, and sends`.

---

### Task 4: The row takes voice; the devices wire the wake

**Files:**
- Modify: `HO/claudeAppSource.ts`, `cli/src/services/devices.ts`, `cli/AGENTS.md`
- Test: `HO/claudeAppSource.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `canLink` (Task 1), `Inbox.onPoll` (Task 2), `AppWake`, `WakeTarget` (Task 3).
- Produces: `ClaudeAppSourceDeps` gains `canLink(localId: string): boolean` and `wake: Pick<AppWake, 'send' | 'stop'>`.
  `ClaudeAppSource.capabilities(agent: HostAgent): Caps` = `{ status: true, voice: <its row> ? canLink(row.localId) :
  false, focus: true, answer: false }`. `ClaudeAppSource.send(agent: HostAgent, text: string): Promise<SendResult>`:
  its row by `agent.id` → `wake.send({ localId, sessionId, agentId, name }, text)` from the row now; no row →
  `{ ok: false, reason: \`${agent.name} did not answer.\` }`, nothing opened. `stop()`, while running, also calls
  `wake.stop()`.
- Wiring in `devices.ts`, inside the `observed ?` branch that builds `claudeAppSource`:
  - `canLink: (localId) => claude.canLink(claudePane(localId))`
  - `wake: new AppWake({ open, observed: …, onPoll: (listener) => inbox.onPoll(listener), after: timerIn('claude-app'), monotonic, log, count: voiced })`
  - `open: async (localId, agentId) => { noteMove(); noteLink(agentId); return (await claude.focus(claudePane(localId))) === true }`:
    the raw adapter, not `claudeNoted` (which would note the move twice) and not `opener.open` (its fallback).
  - `observed: { list: () => observed.list(), send: (agent, text) => observed.send(agent, text), onChange: (listener) => observed.onChange(() => part.call('claude-app', listener)) }`:
    the observed source runs its listeners unguarded, so the wake's goes through the part guard.

- [ ] **Step 1: Write the failing tests.**

  `claudeAppSource.spec.ts` (its `setup` gains `canLink: vi.fn((_: string) => true)` and `wake: { send: vi.fn(async
  (): Promise<SendResult> => ({ ok: true })), stop: vi.fn() }`); replace `'it has status and a tap, no voice and no
  answer, and takes no words'` with:
  - `'voice exactly where its link opens, asked by the row\'s local id; another agent has none'`: `canLink` true →
    `'svf'`, false → `'sf'`; called with `LOCAL`; a stranger `HostAgent` → `'sf'`, `canLink` not called for it.
  - `'its words go to the wake with the row\'s values as they arrive, and the wake\'s answer is its answer'`: after a
    read retitles the row to `Ship it`, `wake.send` gets `[{ localId: LOCAL, sessionId: SESSION, agentId: ID, name:
    'Ship it' }, 'run the tests']`; a wake answer `{ ok: false, reason: 'x' }` comes back as is.
  - `'words for a row no longer listed: did not answer, nothing opened'`: `{ ok: false, reason: 'Fix the build did not
    answer.' }`; `wake.send` and `focus` not called.
  - `'stop() stops the wake once'`: `wake.stop` called once; a second `stop()` adds none.

  `devices.spec.ts`, describe `"the Claude app's Code sessions, from its store …"` (its `withStore`, `hook`, `wait`,
  `flush`, `continued`, `fakeWindowsRaise`). Every case reads which session's poll got words: `port.inboxPoll({ pollId,
  sessionId })` answers `{ text }` only for the session that took them.
  - `'voice to a resting row runs one continue link and reaches that session alone, once its process is listed and its mod polls'`:
    `await live()`; a poll of `SECOND` held; `const sent = host().sendTurn(ID, 'run the tests')`; `await flush()` →
    `orcaRuns` `[continued(LOCAL)]`; `port.observed(hook('session-start'))`; the poll of `SESSION` answers `{ text:
    'run the tests' }`; `await sent` is `{ ok: true }`; `wait(25_000)` → `SECOND`'s poll answers `{}`; logs hold
    `[device] voice · wake-sent` and one `[claude-app] wake · sent · <n> ms`, and no `LOCAL`, `SESSION` or words.
  - `'words while it opens are refused in plain words; once its copy is live they go its own path, after the first'`:
    the second `sendTurn` answers `{ ok: false, machine: '', reason: 'Still opening Fix the build. Try again in a
    moment.', message: 'Still opening Fix the build. Try again in a moment.' }`; after the hook and before the poll
    `listed()` shows `{ id: ID, name: 'api', caps: 'sf' }`; poll p1 takes `first`; a third `sendTurn` then waits for
    the mod's next poll and p2 takes `third`; `orcaRuns` is still one link.
  - `'a tap while it opens runs the link again and the words still go once'` (Review Focus 2): `host().openAgent(ID)`
    during the wait → `orcaRuns` `[continued(LOCAL), continued(LOCAL)]`; one poll takes the words, once.
  - `'a link that fails opens nothing more: no fallback, and the dial is told it did not open'`: `fake.failing = 1` →
    `orcaRuns` `[continued(LOCAL)]` only (no `open -b <bundle>`); answer `Fix the build did not open in Claude.`; log
    `[claude-app] wake · open failed`.
  - `'30 s with no process: the dial is told it did not open, and the log says why'`: `wait(30_000)` → `Fix the build
    did not open in Claude. Try again.`; `[claude-app] wake · timeout`, `[device] voice · wake-timeout`.
  - `it.each([['names an app', 'svf'], ['names none', 'sf']])('on Linux the row takes voice once xdg-mime %s')`: the
    run answers `claude-desktop.desktop\n` or `''` for `/usr/bin/xdg-mime` (as the Linux tap case does); after `live()`
    and a flush, `listed()` caps as given.
  - `'on Windows the words\' link goes through the Windows raise, and the words reach the session'`:
    `windows.links` `[[claude://code/continue?session=${LOCAL}, BUNDLE]]`, `orcaRuns` `[]`, the poll takes the words.
  - `'detached while it opens: did not answer, and nothing reaches the session'`: `seen.host.watching!(false)` →
    `Fix the build did not answer.`; a hook and poll after it get nothing.
  - Existing cases: each store row's `caps: 'sf'` on macOS becomes `'svf'` (the rows named `Fix the build` and
    `Ship it`; `'api'` rows are hooked copies and stay `'sf'`); the suite names every one.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeAppSource.spec.ts src/services/devices.spec.ts`.
  Expected: FAIL: caps `sf`, `send` missing, `sendTurn` answers `it runs outside Harness`.
- [ ] **Step 3: Implement** the source's caps, `send` and `stop`, and the wiring above. The source's file comment: a
  resting row takes voice where its link opens, and its words wake the session (the design). In `cli/AGENTS.md`'s
  devices row, after `opened by the Claude app's link (\`cable/hosts/claudeApp.ts\`)`, add: `, and spoken to where
  that link opens: the words open the session by it, then go to that very Claude Code session's mod once its process is
  listed and its mod polls, within 30 s, one opening at a time for every dial (\`cable/hosts/appWake.ts\`)`.
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck && npm run test:core`.
  Expected: PASS; `devices.ts` at 100%.
- [ ] **Step 5: Commit** `test(cli): voice to a resting Claude app row opens it and reaches that session alone (red)`,
  then `Dial: a resting Claude app session takes voice where its link opens, through the wake`.

---

### Task 5: The refusal's words on the dial

**Files:**
- Test: `cli/src/cable/cableSession.spec.ts`

Tests only, one commit: they pin at the dial's own layer (Decision 3) what Tasks 3 and 4 land. A new describe
`"a resting Claude app row's words (docs/plans/2026-11-21-dial-claude-app-wake-send-design.md)"`, beside the outside
agents' voice cases, using that file's `DaemonCableHost` construction, `connect` and `HostRegistry`: the registry holds
`host.harness` and a real `ClaudeAppSource` started on a fake store listing one session `Fix the build` (`canLink: () =>
true`), whose `wake` is a real `AppWake` with an `open` answering true, an observed fake listing nothing, an `onPoll`
that never fires and an `after` the test fires; `host.transcribe` mocked.

- [ ] **Step 1: Write the tests.**
  - `'a resting Claude app row takes voice; words while it opens are refused on the dial in plain words'`: after the
    first list, voice `u1` to the row (no refusal at `voice.begin`), then voice `u2` → `port.sent` holds `{ t:
    'voice.error', uploadId: 'u2', message: 'Still opening Fix the build. Try again in a moment.' }`.
  - `'30 s with no process: the dial\'s voice error says it did not open'`: voice `u1`, fire the `30_000` timer →
    `{ t: 'voice.error', uploadId: 'u1', message: 'Fix the build did not open in Claude. Try again.' }`.
  - `'a voice draft\'s send while it opens resolves with the wake\'s refusal'`: a wake opened by voice `u1`, then a
    reviewed draft (`review: true`) to the row and `draft.command` `send` → `draft.state` with `error: 'Still opening
    Fix the build. Try again in a moment.'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: PASS (on Task 4's head; on
  the base they fail with `This agent is in Claude. Talking to it from the device comes in an update.`).
- [ ] **Step 3: Commit** `test(cli): the wake's refusals reach the dial's voice error and the draft's in its words`.

---

### Task 6: End to end

**Files:**
- Modify: `cli/e2e/deviceClaudeAppSessions.e2e.ts`, `cli/e2e/dialWindowsAppSessions.e2e.ts`

Test tooling, one commit, no harness file changed (`cli/e2e/harness/` untouched: its change would run PR CI's
real-backend canary). Isolation is the suite's own: an `IsolatedDaemon` with a throwaway root and home, the fixture
store inside it, the fake `open` (`HARNESS_OPEN_BIN`) and on Linux the fake `xdg-mime` (`writeSchemeApps`), an
in-memory `FakeBackend` for the transcript (signed in as a fixture machine, as `deviceWithoutApp.e2e.ts` does), fake
dials on the desk. The Claude app's process is stood in by `InOrca` (`harness/inOrca.ts`) running the real hook with
the app's hints and `ORCA_AGENT_SESSION_ID: ''`; the mod by the test's own `POST /api/hook/inbox` on the daemon's
socket (a local `inboxPoll`, as `deviceWithoutApp.e2e.ts` and `deviceClaudeOrca.e2e.ts` each have).

- [ ] **Step 1: `deviceClaudeAppSessions.e2e.ts`:**
  - `LINE` gains `|wake · (too long|open failed|timeout|ended|busy|stopped|refused|sent · \d+ ms)`.
  - Case 1: the two store rows `caps: 'svf'`; its `showing` waits for both rows at `'svf'` (on Linux the first list can
    still say `'sf'` until `xdg-mime` answered). Case 2: the rested row `'svf'`.
  - `fresh(sessions, relay?)` signs in to `relay` as `deviceWithoutApp.e2e.ts`'s does; `afterEach` closes the backend
    and kills `InOrca`'s children.
  - New case `'words to a resting session open it in the Claude app, then reach that session alone once its process runs
    and its mod polls; another dial\'s words meanwhile are refused in plain words'`: `app = new InOrca(d, 'e2e-wake',
    children, { ORCA_AGENT_SESSION_ID: '', __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: LOCAL })`;
    the store row `{ localId: LOCAL, cliSessionId: app.sessionId, title: 'Fixture Wake', cwd: app.cwd }`; dials A and B
    (`FILTER`) show it at `'svf'`; `relay.speech = 'run the wake tests'`, A speaks to it; `d.opens()` becomes
    `[continued(LOCAL)]`; `relay.speech = 'words from the second dial'`, B speaks → B gets `voice.error` `Still opening
    Fixture Wake. Try again in a moment.`; `app.hook('SessionStart', { source: 'resume' })`; `inboxPoll(d,
    app.sessionId)` answers `{ status: 200, body: { text: 'run the wake tests' } }`; A gets `voice.transcript` for the
    row; `d.opens()` still one; the log has `[claude-app] wake · busy`, `[claude-app] wake · sent · <n> ms` (printed
    with `console.log` for the pull request's numbers), `[device] voice · wake-busy`, `[device] voice · wake-sent`, and
    neither title, ids, nor either dial's words; every `[claude-app]` line matches `LINE`.
- [ ] **Step 2: `dialWindowsAppSessions.e2e.ts`:** the Claude rows' `caps: 'sf'` (line 252) becomes `'svf'`; the
  ChatGPT rows stay `'sf'`.
- [ ] **Step 3: Run** on this Mac `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeAppSessions.e2e.ts`
  (three cases pass) and `npx tsc --noEmit -p .` (both files typecheck; the Windows file skips off Windows).
- [ ] **Step 4: Commit** `test(cli): end to end, words to a resting Claude app session open it and reach it alone`.

---

## Verification

Platforms the pull request names: macOS, Windows, Linux. Nothing runs against production, a real account, the real
Claude app, `~/.claude` or a person's own homes.

1. **Local gates on this Mac, on the final head** (the final tester; receipts into the pull request body before the
   push):
   - `cd cli && npm run typecheck`;
   - `npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/architecture.failureLogs.spec.ts src/leanEntry.spec.ts`;
   - `python3 scripts/local-checks.py --run` from a clean tree at the final commit (it runs `cli-core`, `npm run
     test:core`, for `services/devices.ts` at 100%); paste its fence into the body;
   - `git diff --stat 1ab0f11e49 -- cli/src/core cli/src/architecture.coreFiles.txt devices desktop device-app` prints
     nothing (against `origin/main` after a rebase);
   - end to end on macOS (PR CI does not run macOS e2e): `cd cli && npx vitest run --config vitest.e2e.config.ts
     e2e/deviceClaudeAppSessions.e2e.ts`. A person reading the output sees three cases pass, the console line
     `wake · sent · <n> ms`, and in the new case the one recorded link, the busy text on the second dial and the first
     dial's words in the poll. The `<n>` goes into the body (a new path: no before).
2. **PR CI, selected by the paths** (no extra run): `cli-typecheck`, `cli-tests`, `process-checks`; `linux-e2e` runs
   the modified `deviceClaudeAppSessions.e2e.ts` on `ubuntu-24.04` (the fake `xdg-mime` names the scheme's app, so the
   Linux open path and the late `v` run); `windows-e2e` x64 (a `cli/src/cable/` change) runs `windows.yml`, whose
   `vitest.e2e.windows.config.ts` step runs `dialWindowsAppSessions.e2e.ts` on `windows-latest` (the Claude rows at
   `'svf'` on a real Windows daemon); `dial-hosts` (a `cli/src/cable/hosts/` change) runs `cli-e2e-dial-hosts.yml`.
3. **No by-hand workflow:** the full `cli-e2e.yml` run is not needed: only the two e2e files above make Claude app store
   rows (`claudeAppFixture`'s only users), and PR CI runs both.
4. **Acceptance (Decision 7):** the eval's C8 run (tiers A/B), by the separate item `feat/dial-app-eval`. No real
   Claude app runs on Diego's Mac for this branch, and the merge does not wait for that run.
5. **Windows end to end not run (Decision 8):** voice → link → mod on a Windows daemon is not run, since
   `windowsDaemon.ts` has no speech-to-text stand-in. Covered by `devices.spec.ts`'s Windows case and `windows-e2e`
   showing the Claude rows at `'svf'`. A fake speech-to-text for `windowsDaemon.ts` is a proposal for the final report,
   as its own item.
