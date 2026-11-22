# Dial: the focus echo guard only for firmware that echoes: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn of a dial on firmware 0.0.59 or later (or a Harness Pro, or a greeting with no `fw`) is never dropped as
an echo, so `a/linux/C11/focusKept` turns 1; a round dial older than 0.0.59 keeps the 750 ms window exactly as today.

**Architecture:** All in the devices process's cable session (`cli/src/cable/cableSession.ts`). One pure, exported
predicate `echoesCodeMoves(fw, board)` reads the greeting the session already keeps (`greetedFw`, `greetedBoard`). The
three places that open the 750 ms window (the re-assert after a ring push, the landing of a machine list that follows
none, `follow()`) go through one private method that opens it only for a dial that echoes. The `focus` case is not
changed: with the window's fields never set, its guard is never active.

**Tech Stack:** TypeScript (Node 24), Vitest with fake `Date`/`performance`, the dial eval (`npm run eval:dial-apps`).

**Spec:** `docs/plans/2026-11-22-dial-focus-guard-echo-design.md` (approved by the PM). Base: `main` at `52f0dd69f5`,
branch `fix/dial-focus-guard-echo`.

Paths: `CS` is `cli/src/cable/cableSession.ts`, `CSS` is `cli/src/cable/cableSession.spec.ts`. Line numbers are on
`52f0dd69f5`.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | The window only for a dial that echoes | `CS`, `CSS` | none | high | `CSS` new cases (C11 sequence x3, re-greet, threshold table) |
| 2 | The eval rerun and its baseline | `cli/src/testing/dialAppEval/baseline.json` | 1 | medium | none: data only, one commit (after Task 1, `dialAppEval.spec.ts` "matches the baseline" fails as stale; this task turns it green) |

**Longest chain:** 1 → 2 (two tasks). Nothing runs side by side: Task 2 measures Task 1's code.

## Global Constraints

- Nothing in `cli/src/core/`, `cli/src/services/`, `cli/src/architecture.coreFiles.txt`, `devices/` (firmware),
  `desktop/`, `device-app/`: `git diff --stat 52f0dd69f5 -- cli/src/core cli/src/services cli/src/architecture.coreFiles.txt devices desktop device-app`
  prints nothing.
- The eval and its checks are not changed: `git diff --stat 52f0dd69f5 -- cli/src/testing cli/e2e` lists only
  `cli/src/testing/dialAppEval/baseline.json`. Never open `cli/src/testing/dialAppEval/heldOut.ts`,
  `cli/e2e/dialAppEvalHeldOut.e2e.ts` or any held-out result (the report's "Held out" table and its rows).
- The rule, exact: a dial **echoes** when `board !== 'pro'` and `fw` is not null and `semverGt('0.0.59', fw)` (from
  `cli/src/lib/selfUpdate.ts`, which reads `X.Y.Z` and ignores a suffix such as `-dev`/`-pod`, and is false for what does
  not parse, `'?'` included). For a dial that does not echo, `expectedAppFocusEcho`/`expectedAppFocusEchoUntil` are not
  set at all.
- Unchanged: `APP_FOCUS_SETTLE_MS` (750), `APP_SWITCH_REPAINT_MS` (1 s) and its guard, the Linux second ring push, the
  ring key (`agentsKey`), the re-assert itself (the `focus` frame still goes out after every push), and no re-send of a
  turn's agent to the dial.
- Comments say why and name the firmware and the commits: round firmware `0.0.59` (`80f4bc84c4`, 2026-09-14,
  `device/esp32-circle/main/ui/ui_screens.c` "muted: code moved it, not a hand"), the fix itself (`7348a91187` names it,
  2026-09-08, in the retired repo), and the Harness Pro's own firmware, which never sends `focus` (`d93bf11386`,
  2026-10-11, `pro_cable.c`). No eval id in a product comment (as #4539's last commit did).
- Platforms: macOS, Linux, Windows. The code has no OS branch; tier A runs C11 on all three by injected platform.

## Review Focus

1. **A dial updated in place** (0.0.58 greets, takes an OTA, greets again on the same port with 0.0.94): the rule must
   read the latest greeting, not the first; a cached answer would keep dropping its turns. Pinned in Task 1 (re-greet
   case).
2. **The Pro numbered like an old round** (`board: 'pro'`, `fw: '0.0.1'` or `0.0.99-pod`): never guarded. Pinned in
   Task 1 (C11 sequence, Pro row; threshold table).
3. **A turn that crosses a daemon focus on the cable** (left out on purpose): the two screens may differ for one round
   trip; the next push must re-assert the turn's agent, not the old one. Pinned in Task 1 (the C11 sequence's last push
   re-asserts `b1`).
4. **Tier B and every e2e file keep the guard:** their fake dial greets `fw: '0.0.0-e2e'`
   (`cli/e2e/harness/fakeDial.ts:137`), which parses as 0.0.0 and so echoes by this rule; only tier A's loopback dial
   (no `fw`) exercises the new path. Open question 1.
5. **A turn inside the 1 s switch repaint guard** while `follow()` drives the dial is still dropped on every firmware (by
   design, spec section 2). Existing case "a switch's repaint after its echo timed out does not tell the host" (`CSS`
   7769) keeps passing unchanged and pins it.

---

### Task 1: The window only for a dial that echoes

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (the `APP_FOCUS_SETTLE_MS` docblock and constant, 127-139; the three window
  openings at 2980-2981, 2992-2993, 3761-3762; one new import)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces: `export function echoesCodeMoves(fw: string | null, board: string | undefined): boolean` in `CS`, beside
  `APP_FOCUS_SETTLE_MS`; `const FIRST_QUIET_FW = '0.0.59'` (module-private) there; `private armFocusEcho(agentId: string): void`
  on `CableSession`.
- Consumes: `semverGt(a: string, b: string): boolean` from `../lib/selfUpdate.js` (open question 2).

- [ ] **Step 1: Write the failing tests (red commit)**

In `CSS`:

(a) Near the top, before `function makeHost` (119), one constant every retargeted test uses:

```ts
/** The last round firmware that reports a move code made (0.0.59 is the first that does not): the old dial the 750 ms
 *  echo guard is kept for. */
const ECHOING = { fw: '0.0.58' }
```

Add `echoesCodeMoves` to the import from `./cableSession.js` (17).

(b) Retarget the existing tests that rely on the guard, so they keep testing the old firmware they are about. Found by
running `CSS` against the change (a probe on `52f0dd69f5`: exactly these 9 fail without `ECHOING`, all 502 pass with it):

| Test (line) | How it greets | Edit |
|---|---|---|
| "says again where the window is looking after the list is re-sorted" (1546) | inline hello, 1553 | add `...ECHOING` to the hello |
| "a swipe made DURING a slow machine switch still reaches the window" (1600) | inline hello, 1614 | add `...ECHOING` |
| "ignores stale dial focus while the app switches to a remote machine" (1660) | inline hello, 1673 | add `...ECHOING` |
| "does not bounce a local app selection back to the previous remote agent" (1728) | inline hello, 1741 | add `...ECHOING` |
| "in the 750 ms after the landing a swipe is dropped, and the first swipe after them moves the dial" (5742) | `landed` (5505), twice | `landed(() => machine(RING), {}, ECHOING)` and `landed(() => machine(RING), { turned: vi.fn() }, ECHOING)` |
| "the shown app's ring sent again in another order: …" (6931) | `greeted` (6213, has `fields`) | `greeted(host, true, ECHOING)` |
| "a hand's turn tells the host at once, whatever the agent; a follow's echo does not" (7753) | `resting` (7679) → `greeted` (7229) | `resting({ turned }, ECHOING)` |
| "a focus the echo guard drops starts nothing" (7799) | `resting` | `resting({}, ECHOING)` |
| "the move's echo starts no Orca switch" (8013) | `greeted` (7984) | `greeted({ swipeSwitches, swipeEnded: vi.fn(), markSeen }, ECHOING)` |

Helper signatures this needs (each new parameter spread last into that helper's hello):
`landed(snapshot, over = {}, hello: Record<string, unknown> = {})` passing `hello` to `greet(c.port, hello)` (5507);
`greeted(host: CableHost, hello: Record<string, unknown> = {})` (7229); `resting(over = {}, hello: Record<string, unknown> = {})`
passing it to that `greeted` (7682); `greeted(over = {}, hello: Record<string, unknown> = {})` (7984).

Read and left unchanged (they pass with the change and do not rely on the echo window): "leaves a pick running when
the window echoes a turn of the dial" (2971: the window follows the dial's own turn, `follow()` returns before opening
any window), "a switch's repaint after its echo timed out does not tell the host" (7769: past 750 ms, the switch repaint
guard drops it on any firmware), the `HELLO` constants (5497, 8172) and the overflow describe's `greet` (5801): no test
through them fails. See open question 3 for the passing tests whose clock advances or comments name the window.

(c) New cases at the end of the describe "a machine list lands a dial that holds no agent" (after 5742's test), from the
failing eval scenario (red today for the three non-echoing greetings, verified):

```ts
  // The Linux sequence: the first ring goes out as `sf`, xdg-mime's answer turns it `svf` a tick later, and each push
  // re-asserts the record. A turn 400 ms after the second push was dropped while the session waited for an echo.
  const SAME_RING = (caps: string) => [row('a1', 'ghostty', caps), row('b1', 'ghostty', caps)]
  it.each([
    ['current firmware', { fw: '0.0.94' }],
    ['a greeting with no fw', {}],
    ['a Harness Pro on an old-looking fw', { board: 'pro', fw: '0.0.1' }],
  ])('a turn 400 ms after the same ring re-pushed with new caps is taken: %s', async (_, hello) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    let caps = 'sf'
    const { session, port, host } = await landed(() => machine(SAME_RING(caps)), { turned: vi.fn(), log: vi.fn() }, hello)
    try {
      vi.advanceTimersByTime(1_100)
      caps = 'svf'
      await session.syncAgents()
      expect(focuses(port)).toEqual([{ t: 'focus', agentId: 'a1' }, { t: 'focus', agentId: 'a1' }])
      vi.advanceTimersByTime(400)
      port.say({ t: 'focus', agentId: 'b1' })
      await settle()
      expect(host.focus).toHaveBeenCalledWith('b1')
      expect(host.turned).toHaveBeenCalledTimes(1)
      expect(said(host).filter((l) => l.includes('dropped dial focus'))).toEqual([])
      port.sent.length = 0
      vi.advanceTimersByTime(1_100)
      caps = 's'
      await session.syncAgents()
      expect(focuses(port)).toEqual([{ t: 'focus', agentId: 'b1' }])
    } finally { await session.stop(); vi.useRealTimers() }
  })
```

(`said(host)`: the log lines, `(host.log as Mock).mock.calls.map(([line]) => line as string)`; define it in this
describe if it has none.)

- `'on firmware older than 0.0.59 the same turn is still dropped as an echo'`: the same sequence with `ECHOING` up to
  the turn; then `host.focus` and `host.turned` not called, and `said(host)` contains
  `'cable: dropped dial focus b1 — waiting for a1'`. (Passes on base too: it pins that the old firmware keeps today's
  behavior.)
- `'a dial that greets again on 0.0.94 after 0.0.58 has its turns taken from then on'` (Review Focus 1): `landed` with
  `ECHOING`; advance 1 100 ms; `port.say({ ...HELLO, fw: '0.0.94' })` (same mac) and wait, as `greet` does, for the
  forced push it starts (`pushAgents` → `syncAgents(true)`); a `focus a1` is among the frames sent after the second
  greeting (the record re-asserted, which opened the window on base); advance 400 ms; `focus b1` →
  `host.focus` called with `'b1'`, and no `dropped dial focus` line after the second greeting.

(d) A new top-level describe after that one, `'which dial echoes a move code made'`:

```ts
  it.each([
    ['0.0.58', undefined, true], ['0.0.1', undefined, true], ['0.0.58-dev', undefined, true],
    ['0.0.59', undefined, false], ['0.0.94', undefined, false], ['0.1.0-dev', undefined, false], ['1.0.0', undefined, false],
    ['?', undefined, false], [null, undefined, false],
    ['0.0.1', 'pro', false], ['0.0.99-pod', 'pro', false], ['0.1.16', 'pro', false],
  ] as const)('fw %s, board %s: %s', (fw, board, echoes) => {
    expect(echoesCodeMoves(fw, board)).toBe(echoes)
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts`
Expected: FAIL: the three C11-sequence rows (`expected "vi.fn()" to be called with arguments: [ 'b1' ]`), the re-greet
case, and every threshold row (`echoesCodeMoves` is not a function). Every retargeted test and the old-firmware case
pass. Commit: `git add cli/src/cable/cableSession.spec.ts && git commit -m "Dial session test: a turn after a re-push is taken on firmware that does not echo; old firmware keeps the guard (red)"`

- [ ] **Step 3: Implement**

In `CS`:
- `export function echoesCodeMoves(fw: string | null, board: string | undefined): boolean`: false for `board === 'pro'`
  or `fw === null`, else `semverGt(FIRST_QUIET_FW, fw)`. Docblock: the round firmware's fix and 0.0.59 (commits in
  Global Constraints), every version before it counts as echoing because which got the fix is in the retired repo; the
  Pro's own firmware never sends `focus` whatever its `fw`; a greeting with no `fw` (`'?'`) is from no shipped firmware.
- `private armFocusEcho(agentId: string): void`: returns at once unless
  `echoesCodeMoves(this.greetedFw, this.greetedBoard)`; otherwise sets `expectedAppFocusEcho = agentId` and
  `expectedAppFocusEchoUntil = Date.now() + APP_FOCUS_SETTLE_MS`. It replaces each of the three pairs (2980-2981,
  2992-2993, 3761-3762).
- The `APP_FOCUS_SETTLE_MS` docblock gains one sentence: the window opens only for a dial that echoes
  (`echoesCodeMoves`); for every other a turn inside it is a hand's, which the Linux voice-caps re-push swallowed.
- The `focus` case (1654-1676) and the field comment at 897 stay as they are.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd cli && npm run typecheck && npx vitest run src/cable src/architecture.spec.ts src/architecture.failureLogs.spec.ts src/leanEntry.spec.ts`
Expected: typecheck clean; all pass (the probe, before the re-greet case was added: `CSS` 502 of 502; the three
architecture specs 175 of 175 with the `selfUpdate` import). `src/testing/dialAppEval/dialAppEval.spec.ts` "matches the baseline" now fails as stale
(`a/linux/C11/focusKept` rose): expected, Task 2 updates the baseline; do not run it with `--update-baseline` here.

- [ ] **Step 5: Commit**

`git add cli/src/cable/cableSession.ts && git commit -m "Dial: the focus echo guard only for firmware that echoes (round dials below 0.0.59)"`

---

### Task 2: The eval rerun and its baseline

**Files:**
- Modify: `cli/src/testing/dialAppEval/baseline.json` (written by the eval, never by hand)

**Interfaces:**
- Consumes: Task 1's code on the branch head.

The ratchet (`run.ts`, design "What fails a run in CI"): tier A's results must equal the baseline exactly; tier B fails
only on a wrong-session send or a pass/fail check its platform's baseline passes. `--update-baseline` refuses to write
on a wrong-session send, a tier whose vitest failed, or a results file not written. Held-out results are in the run's
output and the baseline: read only what the steps name.

- [ ] **Step 1: Record the current scores**

Run: `cd cli && jq '.apps' src/testing/dialAppEval/baseline.json` (today: `a` claude 99.415…, chatgpt 97.894…;
`b/darwin` 100 and 100).

- [ ] **Step 2: Run both tiers on the Mac, kept awake**

Run (one folder for the run, its output to a file, not the terminal):
`cd cli && DIAL_EVAL_OUT=<scratch>/dial-eval caffeinate -i npm run eval:dial-apps > <scratch>/dial-eval.log 2>&1; echo $?`
Then read only: `jq '{apps, gate}' <scratch>/dial-eval/report.json` and
`grep -E 'vitest exited|wrote no results|was not written|ratchet' <scratch>/dial-eval.log`.
Expected: exit 0 or exit 0 with `tier A ratchet: off its baseline` (the rise); gate passed, no wrong-session send;
the Claude app's main-set score above Step 1's, the ChatGPT app's not below it. A wrong-session send: stop and report
to the PM (design rule), write nothing.

- [ ] **Step 3: Write the baseline**

Run: `cd cli && DIAL_EVAL_OUT=<scratch>/dial-eval caffeinate -i npm run eval:dial-apps -- --update-baseline > <scratch>/dial-eval-update.log 2>&1; echo $?`
Expected: exit 0 and `baseline written` in the log.

- [ ] **Step 4: Check what was written**

Run: `cd cli && jq '.apps' src/testing/dialAppEval/baseline.json && jq '.checks | with_entries(select(.key | test("^a/(darwin|linux|win32)/C11/")))' src/testing/dialAppEval/baseline.json`
Expected: `a/linux/C11/focusKept` is 1, and the C11 keys on darwin and win32 still 1; `apps.a.claude` above Step 1's;
`apps.a.chatgpt` and `apps["b/darwin"].chatgpt` not below Step 1's; `apps["b/darwin"].claude` not below. Any of these
off: `git checkout -- src/testing/dialAppEval/baseline.json` and report the numbers instead of committing.

Then: `npx vitest run src/testing/dialAppEval/` → all pass ("matches the baseline" green again).

- [ ] **Step 5: Commit**

`git add cli/src/testing/dialAppEval/baseline.json && git commit -m "Dial eval baseline: a turn after the Linux voice-caps re-push is kept (C11 on Linux, the Claude app)"`
The pull request carries the two runs' app scores (before, after) and the gate line as its evidence, and says the
baseline file is the command's output.

---

## Verification

All local and isolated by the eval's own design: throwaway homes and folders, the in-memory fake backend, fake apps and
a loopback or fake dial, no real Claude or ChatGPT app, no account, no `open`/`xdg-open`, no proxy (the runner strips
proxy variables and the network guard refuses any host past this machine). No production, no real person's data.

1. **Unit, on the branch head (macOS here):** `cd cli && npm run typecheck && npx vitest run src/cable src/testing/dialAppEval src/architecture.spec.ts src/architecture.failureLogs.spec.ts src/leanEntry.spec.ts`
   → all pass. The cable unit specs are the gate for `cli/src/cable`; `npm run test:core` does not apply (nothing in
   `src/core` or `src/services`; the Global Constraints' `git diff --stat` proves it).
2. **The eval, both tiers, on the Mac:** Task 2's runs. Tier A covers macOS, Linux and Windows by injected platform
   (C11 on each); tier B runs on macOS here. What a person reads: the Claude app's score up, the ChatGPT app's not down,
   the gate passed, `a/linux/C11/focusKept` 1.
3. **On GitHub (PR CI, no workflow to start by hand):**
   - `cli-typecheck` and `cli-tests` (Linux, the default Vitest suite in four shards): `cableSession.spec.ts`, the tier A
     spec `dialAppEval.spec.ts` with its exact ratchet, the architecture and lean-bundle specs.
   - `linux-e2e`: selected because `cli/src/testing/dialAppEval/` changed (`baseline.json`); runs the eval's three tier B
     files on `ubuntu-24.04` (Linux tier B is gate-only in the baseline).
   - `windows-e2e` (x64 only): selected because `cli/src/cable/` changed; runs `windows.yml` (the Windows CLI specs and
     the dial end to end on a stand-in dial). `cableSession.spec.ts` itself is not in `WINDOWS_SPECS`, so on Windows it is
     covered by tier A's win32 rows (on Linux) and this dial e2e, whose fake dial greets `0.0.0-e2e` and so keeps the
     guard (open question 1).
4. **The real dial (the user's own eye, optional):** a round dial on current firmware (0.0.94) on a Linux desk with the
   Claude app's sessions: plug in, turn to b within a second of the ring arriving, unplug, plug back in → the dial comes
   back on b. Needs the user's own desk and app; no account beyond theirs. Not required for merge; tier A pins the same
   sequence.

## Open questions

1. **Tier B's fake dial counts as old firmware.** `cli/e2e/harness/fakeDial.ts:137` greets `fw: '0.0.0-e2e'`, which
   `semverGt` reads as 0.0.0, below 0.0.59: under the spec's rule tier B and every e2e file (Windows' dial e2e too) keep
   the 750 ms guard, and only tier A (loopback dial, no `fw`) runs the new path. Leave the fake as it is (this draft: no
   change to the eval's harness, and tier B's numbers are unaffected), or change its `fw` to a current version (for
   example `0.0.94-e2e`) in this branch, which touches the tier B driver's dial and every e2e file that uses it?
   Recommendation: leave it; report it as a follow-up item.
2. **Importing `semverGt` from `lib/selfUpdate.ts`** (as the spec says) brings five of the updater's files into the
   devices process: `lib/selfUpdate.ts`, `lib/windows/cliVersions.ts`, `lib/windows/installLayout.ts`,
   `lib/nodeMigration.ts`, `lib/daemonSpawnLock.ts`; on Windows, where the devices run in the core's process through
   the inline door, into the core's process too (the core walk does not follow that door, and the architecture and
   lean-bundle specs pass). Keep the import (this draft), or move `semverGt` to a small `lib/` file of its own and point
   its callers (`cli.ts`, `tui/install.ts`, `lib/windows/ptyPayload.ts`, `selfUpdate.ts`) at it in this branch?
   Recommendation: keep it, as the spec and PM chose.
3. **Passing tests that now wait out a window that no longer opens.** With no `fw` in their greeting these pass with
   and without the change, but advance the clock 751 ms "past the landing's echo" or say a frame is "the dial's echo":
   the `vi.advanceTimersByTime(751)` at `CSS` 5593 ("a record in the list is re-asserted, not the first agent"), 5609
   (`turnedThenReplugged`), 5714 and 5731 ("a dial that asks agents.list while its port stays open …"), 5845 ("a ring that
   keeps some of a full dial's agents …"), 6131 ("a second split inside the hold …"), 6613 (`asking`), 6803 ("a window
   focus off the ring of a dial on an app's ring does not move it"), 7668 ("focus marks a done harness agent seen"), and
   the echo frame in "the dial moved by the app before 400 ms: superseded" (7812). Leave them as they are (this draft,
   as the spec changes only tests that fail), or in Task 1 drop the dead advances and their comments and greet 7812 with
   `ECHOING`? Recommendation: leave them; the advances are harmless and the spec scoped the edits.

## Answers (PM, 2026-11-22)

1. Leave the fake dial as it is in this branch. Follow-up (PM's backlog): the e2e / tier B fake dial greets with a
   current firmware version, so tier B runs the new path.
2. Keep the `semverGt` import from `lib/selfUpdate.ts`.
3. Leave the 751 ms advances. Task 1 also greets "the dial moved by the app before 400 ms: superseded" (7812) with
   `ECHOING` (`fw: '0.0.58'`), so the frame it calls the dial's echo is one.
