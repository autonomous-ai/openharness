# A discovery pass leaves the other engines' reader hold alone (#4362): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. Two tasks, one after the other: Task 2 waits for
> Task 1. Task 1 is one commit, a test that fails on today's core. Task 2 is test-first: a red commit, then the code
> commit that turns both green. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn typed in a Pi pane (or any of the other fourteen engines' panes that keeps a transcript) while their
worker is down arrives live and once when the worker is back, whatever discovery pass runs meanwhile.

**Architecture:** `bindObservedAgent` (`cli/src/core/agents/bind.ts`) skips its saved-binding retry for a row whose
`identityHold` is one of `OTHER_ENGINE_STATES`. That hold stays `otherStreams`' to set and to clear. The core gains one
import of a file its process already loads, one set and one condition. The end-to-end test holds each outage open with
the service process's existing connect gate and puts one whole discovery pass inside it.

**Tech Stack:** TypeScript, Node 22.15 or later (rehearsed on v22.23.5 arm64 on macOS and v24.22.2 in a Linux
container), Vitest 4.1.10, tmux. No new dependency.

**Spec:** [docs/plans/2026-11-16-4362-otherengines-sigkill-design.md](2026-11-16-4362-otherengines-sigkill-design.md).
Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/core/AGENTS.md`.

## Decisions

Made by the orchestrator, not reopened here.

1. The fix is in `bindObservedAgent`: a row whose `identityHold` is one of `Object.values(OTHER_ENGINE_STATES)`
   (`cli/src/engines/otherEngines.ts`) gets no `revalidateBinding` and no recovered follow. The rest of the pass runs
   as today.
2. The unit test is red first, in `cli/src/core/agents/bind.spec.ts`.
3. The end-to-end test fails on today's core every time, with no test-only hook added to the core.
4. The end-to-end file is repeated on Linux in a local container (Docker runs on this Mac); the repo's
   `cli-e2e.yml` is the fallback.

## Global Constraints

- The reader's holds are exactly `Object.values(OTHER_ENGINE_STATES)`: three texts. No other hold is skipped.
- Only the saved-binding retry is skipped. Nothing else in the pass changes.
- The core gains no file, rule, record or log line. `cli/src/architecture.coreFiles.txt` stays as it is (it lists
  `engines/otherEngines.ts` already).
- Not touched: `core/engines/otherStreams.ts`, `core/main.ts`, `lib/registry.ts`, `core/transcripts/attach.ts`,
  `core/terminals/requests.ts`, `services/process.ts`.
- 100% coverage per file for `src/core/` (`npm run test:core`).
- No fixed sleeps. Tests use throwaway folders only: never `~/.claude`, `~/.codex`, the daemon on port 18473 or the
  developer's tmux server.
- Comments say why, in plain sentences, and name #4362.
- A task runs only the commands it names. A commit adds its files by name. The two documents under `docs/plans/` are
  no task's.
- Platforms: the daemon core on macOS, Linux and Windows (the changed code has no platform branch). The end-to-end
  test runs on macOS and Linux (it uses tmux and SIGSTOP). One pull request; its body names the platforms and carries
  each task's red and green output and the receipt from Verification.

## Found while reading the code

Checked at `5b64066cd1` on an Apple Silicon Mac (Node v22.23.5, tmux 3.6b). Every change in this plan was rehearsed
there and put back.

- **A triggered pass reaches the row.** `TerminalAgentReconciler.trigger()` runs `reconcileOnce`, which calls
  `onObserved` for every row whose process it saw (`lib/terminalAgentReconciler.ts:464`); `onObserved` awaits
  `bindObservedAgent` (`core/agents/discovery.ts:237`); that finds the Pi's row by its process and enters the branch
  at `bind.ts:331`, because the row has a hold, a session and a transcript.
- **`theme_set` cannot be fenced.** It answers `{ applied: true }` before its pass starts (`core/terminals/requests.ts`
  returns at once, `core/main.ts:1284` is `void agentReconciler.trigger()`), and nothing tells a client when that pass
  ended. A test could not know the pass ran inside the outage.
- **A hook's resolution awaits a whole pass.** `resolveHookAgent` awaits `agentReconciler.triggerHint`
  (`core/engines/hooks.ts:161`) before it matches the caller. A `session-start` hook that names the Pi's pane but
  comes from the test's own process is answered `{ ignored: true, reason: 'no_matching_engine_process' }` after that
  pass, and changes nothing. That reply is the fence. Measured: 200 to 370 ms.
- **The outage can be held open without touching the core.** `HARNESSD_TEST_HOLD_CONNECT=<service>:<file>`
  (`services/process.ts:179`, used by `usageProcess.e2e.ts` and `adopt.e2e.ts`) keeps a starting service process off
  the core while the file exists, looking again every 200 ms, still beating to its master. The worker runs through
  `runServiceProcess` under the name `engine-others`. So the test, not a backoff, decides when the worker is back.
- **The windows without the gate are too short.** After SIGKILL the worker is back in about 0.8 s (200 ms backoff
  plus its start). After SIGSTOP the hold appears only when the master kills the frozen worker, 5.3 s later with the
  test's 4 s heartbeat timeout, and the worker is back 0.9 s after that. The bystander's turn alone takes about 2 s
  on the Mac.
- **Rehearsed, today's core:** the test of Task 1 fails in both rows on every run with
  `timed out after 30000ms waiting for turn during-SIGKILL`; narrowed to SIGSTOP alone it fails the same way on
  `during-SIGSTOP`. The daemon's log shows the spec's chain each time: the resume's `tail pi … @467`, a second
  `tail pi … @764` from the transcript's end, then `[recap] … caught up a turn that ended unseen`.
- **Rehearsed, with Task 2's code:** the test passes three times in three on macOS (31 to 37 s), the whole file and
  `readerClose.e2e.ts` pass, `npm run test:core` reports 251 files, 4603 tests and 100% four times in 76 s, and
  `npm run typecheck` exits 0.
- **Rehearsed in a Linux container** (Node v24.22.2, tmux 3.3a, arm64, the recipe under Verification): today's core
  fails the test in both rows, twice in two, the same way; with Task 2's code the two files pass three times in three
  (`7 passed | 1 skipped`, 48 s a run: the bundle adds the protocol-1 row). A pass takes 20 to 30 ms there.
- **The fake Pi needs a long command line on Linux.** It names its session in its process title, and Linux cuts a
  title to the bytes of the command line the process started with (measured: 29 bytes gave
  `pi --session-id aaaaaaaa-2222`). The title needs 52. In the Docker image Node is `/usr/local/bin/node`, and with
  `TMPDIR=/tmp` the command line is about 44 bytes: every Pi row of the file then timed out at "Pi bound to its
  preallocated id", with or without this change. A longer `TMPDIR` in the container gives the room. The runner has
  it already (the file's Pi rows pass in the nightly), most likely through setup-node's longer Node path. The fixture
  is left as it is.
- **A plain attach opens no second stream.** `attachSession` without `reset` on a followed session only asks its
  stream to tail (`core/transcripts/attach.ts:259`), which an orphaned handle ignores. Only a reset attach opens one,
  and every reset attach stops at a row that carries an `identityHold` (`attach.ts:687`, `bind.ts:174`).

## The same cause elsewhere

The spec asks for this list to be confirmed. Every place that clears an `identityHold`, outside tests:

| Where | What it does | Whose hold |
| --- | --- | --- |
| `core/agents/bind.ts:334` `revalidateBinding` | clears any hold | **not its own: the bug, fixed in Task 2** |
| `core/main.ts:1304` (`otherStreams` `held`) | sets and clears | its own: returns at a hold in other words (`:1303`) |
| `core/transcripts/ingest.ts:139` | sets and clears | its own: only over `OPENCLAW_STORE_HOLDS` or no hold |
| `core/agents/bind.ts:396` read-hold release | clears | its own: same words and same `evidenceRevision` (`readHeld`) |
| `core/agents/bind.ts:444` OpenClaw screen | clears | its own (`ours`) |
| `core/agents/bind.ts:510` Hermes sandbox | clears | its own: only `HERMES_SANDBOX_HOLD` |
| `lib/registry.ts:2384` `register` | clears | its own: only `BINDING_RECOVERY_HOLD` |
| `lib/registry.ts:1358`, `:2181`, `:2282`, `:3379` | drops the hold | with the binding it was about: unbound, taken by another agent, or another session or transcript |

No other place clears a hold it did not set. `revalidateBinding` has one caller.

Some places **set** a hold over whatever is there, the reader's included. The registry does when it reads a row
from disk (`registry.ts:1481` at load, `:3145` after another writer changed the binding): that binding is then
rightly checked again. Three are in the pass: `bind.ts:342` (the retry's own failure, no longer reached for a reader
hold), `bind.ts:358` (`hold`: a native read that failed or a register refused in this pass) and `bind.ts:503` (a
Hermes sandbox with no path here). They are not this bug: none of them attaches, and the reader then leaves the row
alone. They are open question 1.

## File map

| File | Task | Change |
| --- | --- | --- |
| `cli/e2e/otherEngines.e2e.ts` | 1 | the connect gate in `fresh`, two helpers, the outage loop reordered around one fenced pass |
| `cli/src/core/agents/bind.spec.ts` | 2 | one `it.each` over the three reader holds |
| `cli/src/core/agents/bind.ts` | 2 | one import, one set, one condition, one comment |

## Review Focus

What the spec implies and a person would meet, each pinned by a test in the task that owns it.

1. **All three reader states, not only "waiting".** A row that says "fell behind" or "transcript changed" is being
   rebuilt by its reader and must not be revalidated either. Task 2's test runs once per value.
2. **A long outage.** Passes repeat every few seconds and at every hook while a worker is parked. The second pass
   must leave the row as the first did. Task 2's test runs the pass twice.
3. **The pass still does its work for a held row.** A Copilot `/resume` during the outage is still looked for. Task
   2's test uses a Copilot row and expects its process to be asked on both passes.
4. **A hold in other words is still revalidated**, the bare word `unavailable` included. The existing tests at
   `bind.spec.ts:374`, `:392` and `:401` pin it; Task 2 leaves them as they are and runs them.
5. **A frozen worker, not only a killed one.** Its outage starts seconds later, when the master kills it. Task 1 runs
   the fenced pass in both halves of the loop.

---

### Task 1: The end-to-end test puts a whole discovery pass inside each outage

**Files:**
- Modify: `cli/e2e/otherEngines.e2e.ts` (`fresh` at 38-67, `live` at 103-107, the loop at 213-250)

**Depends on:** nothing. **Effort:** high.

**Red:** this test itself, on today's core. The task changes no product code and is one commit; Task 2's code commit
turns it green.

**Interfaces:**
- Produces: the test Task 2 runs by name, `-t "answers at once"`.

- [ ] **Step 1: `fresh` sets the gate and returns its path**

After `d.env.PI_HOME`:

```ts
const gate = join(d.root, 'others-connect-hold')
d.env.HARNESSD_TEST_HOLD_CONNECT = `engine-others:${gate}`
```

and `return { d, c, gate }`. While the file is absent nothing waits, so the other rows of the file are unchanged. The
comment says what the gate is (`services/process.ts` `heldOffFile`) and that the test decides how long an outage lasts.

- [ ] **Step 2: Two helpers beside `live`**

```ts
const turnEnded = (c: LocalClient, agent: { id: string }, text: string) =>
  c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id && !frame.replay, 30_000, `turn ${text}`)

const discoveryPass = async (d: IsolatedDaemon, agent: { pane: string }) => {
  const reply = await fetch(`http://127.0.0.1:${d.port}/api/hook/session-start`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential() },
    body: JSON.stringify({ engine: 'pi', tmuxPane: agent.pane, callerPid: process.pid,
      runtimeHints: [{ backend: 'tmux', paneId: agent.pane }] }) })
  expect(await reply.json()).toEqual({ ignored: true, reason: 'no_matching_engine_process' })
}
```

`live` uses `turnEnded` in place of its own `c.next`. The comment on `discoveryPass` says why a refused hook: a hook's
resolution waits for a whole discovery pass (`core/engines/hooks.ts` `resolveHookAgent`), no client request does, and
this one comes from the test's process, not the Pi's, so it is ignored after the pass.

- [ ] **Step 3: The loop, in this order**

Destructure `gate` from `fresh(...)`. Inside `for (const signal of ['SIGKILL', 'SIGSTOP'] as const)`:

```ts
const framesBeforeFault = c.frames.length
writeFileSync(gate, '')                       // new: the worker that replaces this one waits at the gate
process.kill(before, signal)
// unchanged: at, pending, the bystander's turn, the SIGSTOP check on worker(d)
const ended = turnEnded(c, agent, `during-${signal}`)
await type(d, agent.pane, `during-${signal}`)
await until('the turn typed meanwhile on disk', () => readFileSync(agent.fake.file, 'utf8').includes(`pi says during-${signal}`) || null, 15_000, 50)
await c.waitFor(/* the outage frame, same test as today */, 15_000, 'the visible reader outage', framesBeforeFault)
expect(d.log()).toContain("the other engines' worker is gone · 1 conversation(s) held")
await discoveryPass(d, agent)
expect(linked(d)).toBe(connections)           // still out: the pass ended inside the outage
rmSync(gate)
await ended
// unchanged from here: starts has length 1, answer = await pending, 'the worker back', and the rest
```

The outage frame's wait grows from 5 s to 15 s: it is now awaited before the worker is back, and a frozen worker's
outage shows only after its heartbeat timeout. The comment above the pass names #4362: a discovery pass in the outage
took the reader's hold for a broken binding, and the turn typed meanwhile came as history.

- [ ] **Step 4: Run it three times on today's core: red each time**

Run in `cli/` (a short `TMPDIR` keeps the daemons' socket paths within their limit):

```bash
for run in 1 2 3; do TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/otherEngines.e2e.ts -t "answers at once"; done
```

Expected, each run, in about 77 s: `Tests  2 failed | 5 skipped (7)`, both rows with
`Error: timed out after 30000ms waiting for turn during-SIGKILL`. A run that passes, or fails another way, is a
finding to report, not a result to accept.

- [ ] **Step 5: The other rows are unchanged**

```bash
TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/otherEngines.e2e.ts -t "starts|inline mode"
```

Expected: `Tests  3 passed | 4 skipped (7)`.

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/otherEngines.e2e.ts
git commit -m "Other engines e2e: a whole discovery pass inside each reader outage (#4362)"
```

---

### Task 2: A discovery pass leaves the reader's hold to its reader

**Files:**
- Modify: `cli/src/core/agents/bind.ts` (import at 13, the set at 41, the branch at 331)
- Test: `cli/src/core/agents/bind.spec.ts` (import at 8, a new test before the one at 421)

**Depends on:** Task 1. Its red must be recorded on a core without this change, and both tasks run the daemon from
the same source tree. **Effort:** high.

**Interfaces:**
- Consumes: Task 1's test, `-t "answers at once"`.

- [ ] **Step 1: Write the failing test**

Import `OTHER_ENGINE_STATES` from `'../../engines/otherEngines.js'`. In `describe('binding a running process to its
session')`:

```ts
it.each(Object.values(OTHER_ENGINE_STATES))('leaves the other engines\' reader hold to its reader, pass after pass, and goes on with the pass: %s', async hold => {
  const run = setup(), row = agent({ engine: 'copilot', transcriptPath: '/t/s1.jsonl', identityHold: hold })
  run.byAgent.set(row.agentId, row)
  vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
  await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
  await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
  expect(run.deps.registry.revalidateBinding).not.toHaveBeenCalled()
  expect(run.deps.registry.setIdentityHold).not.toHaveBeenCalled()
  expect(run.deps.attachSession).not.toHaveBeenCalled()
  expect(run.deps.forgetSession).not.toHaveBeenCalled()
  expect(run.deps.announceSession).not.toHaveBeenCalled()
  expect(row).toMatchObject({ sessionId: 's1', transcriptPath: '/t/s1.jsonl', identityHold: hold })
  expect(processSessionOf).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run it: red**

Run: `npx vitest run src/core/agents/bind.spec.ts -t "reader hold"`
Expected: `Tests  3 failed | 146 skipped (149)`, each at the `revalidateBinding` line with
`expected "vi.fn()" to not be called at all, but actually been called 1 times`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/core/agents/bind.spec.ts
git commit -m "A discovery pass leaves the other engines' reader hold to its reader: the failing test (#4362)"
```

- [ ] **Step 4: The condition in `bindObservedAgent`**

Import `OTHER_ENGINE_STATES` from `'../../engines/otherEngines.js'`. Beside `OPENCLAW_HOLDS`, with a one-line comment
as that one has (what the other engines' reader says while it is out or rebuilding):

```ts
const OTHER_ENGINE_HOLDS = new Set<string>(Object.values(OTHER_ENGINE_STATES))
```

The branch at 331 becomes:

```ts
if (agent.identityHold && !OTHER_ENGINE_HOLDS.has(agent.identityHold) && agent.sessionId && agent.transcriptPath) {
```

The comment above it says why, with these facts: the reader's outage hold is `otherStreams`' to set and to clear, with
its resume from the byte the core held; revalidated here it was cleared, the session was attached again with the
worker down, and on the worker's return a second stream opened from the transcript's end, so the turn typed meanwhile
came as history (#4362, CLI end to end shard 5, `e2e/otherEngines.e2e.ts`).

- [ ] **Step 5: The unit specs: green**

Run: `npx vitest run src/core/agents/bind.spec.ts src/architecture.spec.ts`
Expected: `Test Files  2 passed (2)`, `Tests  173 passed (173)`.

- [ ] **Step 6: The coverage gate and the types**

Run: `npm run test:core`, then `npm run typecheck`
Expected: about `Test Files  251 passed (251)`, `Tests  4603 passed (4603)` and `100%` for statements, branches,
functions and lines, in about 76 s; `tsc --noEmit` exits 0.

- [ ] **Step 7: Task 1's test: green three times**

```bash
for run in 1 2 3; do TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/otherEngines.e2e.ts -t "answers at once" || { echo "run $run failed"; break; }; done
```

Expected: three times `Tests  2 passed | 5 skipped (7)`, 31 to 37 s each, and no `run N failed` line.

- [ ] **Step 8: Commit the code**

```bash
git add cli/src/core/agents/bind.ts
git commit -m "A discovery pass leaves the other engines' reader hold to its reader (#4362)"
```

---

## Left out

- `otherStreams.connected()` still resumes an orphaned handle and reattaches an unopened session in the same call.
  With the hold left in place a discovery pass no longer puts a followed session among the unopened. The sessions the
  reader itself puts there (a stream it gave up, a transcript rewritten) are rebuilt from history by design. Changing
  `connected()` is not this task.
- The three places that set a hold over the reader's (open question 1).
- `theme_set`: not used, for the reason under "Found".
- No log line or measure is added: the spec needs none.

## Open questions

1. **Three places set their own hold over the reader's** (`bind.ts:342`, `:358`, `:503`: a retry that failed, a native
   read that failed or a register refused in the pass, a Hermes sandbox with no path here). None clears the reader's
   hold or attaches, so none is #4362. But the row then shows their words instead of the reader's, and once their own
   reason clears, the row carries no hold while the worker is still out: a reset attach in that moment (a
   `SessionStart` hook) would meet the second stream again. It needs a second failure inside the outage. Leave them
   as they are in this pull request (recommended, and proposed to the maintainers as a follow-up), or cover them here?
   **Answered (orchestrator):** leave them as they are; they are listed under Follow-ups in the spec and the pull
   request body.

## Verification

All on the final head, after the review. Nothing here needs an account, a sign-in, a device or the user, and nothing
touches production, the developer's daemon (port 18473), tmux server, `~/.claude` or `~/.codex`. Every end-to-end
daemon is an `IsolatedDaemon` (`cli/e2e/harness/daemon.ts`, `cli/AGENTS.md` rules 5 and 6): a throwaway root with its
own home, data and runtime folders, a free port, a private tmux server, fake engines, and not signed in.

**On GitHub by itself.** Marking the pull request ready runs `cli-typecheck` and `cli-tests`, which run
`bind.spec.ts` and `src/architecture.spec.ts` on Linux. Nothing is started by hand.

1. **The coverage gate PR CI does not run, with its receipt.** On the Mac, from the repository root, on a clean tree
   at the final commit (the script refuses untracked files, so after the two documents under `docs/plans/` are
   committed), before that commit is pushed or the pull request is marked ready:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   It runs `npm run test:core` in `cli/`, the one check these paths need. To see: one `harness-local-checks` fence
   with `"check": "cli-core"` and `"status": "passed"`. Paste the fence into the pull request body as it is; it must
   be there when the tested commit is pushed, because `process-checks` reads the body from that event.

2. **The types.** On the Mac, in `cli/`: `npm run typecheck`. To see: no output after `tsc --noEmit`, exit 0.

3. **The file and its neighbour on macOS, five times.** On the Mac, in `cli/`, about 60 s a run. Nothing to build:
   the daemon starts from source.

   ```bash
   for run in 1 2 3 4 5; do TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/otherEngines.e2e.ts e2e/readerClose.e2e.ts || { echo "run $run failed"; break; }; done
   ```

   To see: five times `Test Files  2 passed (2)` and `Tests  6 passed | 2 skipped (8)`, and no `run N failed` line.
   One failure in five is not a pass: report the run, the row and its error, and stop.

4. **The same two files on Linux, ten times, in a local container.** On the Mac, with Docker running, from the
   repository root. The image holds what `cli-e2e.yml` installs (tmux, zsh, tcsh, dash, lsof) on the workflow's Node,
   and runs the tests as a plain user. The committed tree goes in whole through `git archive` (the bundle reads
   `store/`, `pty/` and `plugins/` beside `cli/`); nothing of the Mac is mounted, and the container is removed when
   it ends.

   ```bash
   printf '%s\n' 'FROM node:24.22.2-bookworm' 'RUN apt-get update && apt-get install -y --no-install-recommends tmux zsh tcsh dash lsof procps util-linux git && rm -rf /var/lib/apt/lists/*' 'ENV LANG=C.UTF-8 SHELL=/bin/zsh' 'RUN useradd -m -s /bin/zsh tester' 'USER tester' 'WORKDIR /home/tester' | docker build -t harness-e2e-linux -
   ```

   ```bash
   git archive HEAD | docker run --rm -i --init harness-e2e-linux bash -c 'set -e; mkdir work /tmp/harness-e2e-4362-linux && tar -xf - -C work && cd work/cli && npm ci --no-audit --no-fund >/tmp/npm-ci.log 2>&1 || { tail -30 /tmp/npm-ci.log; exit 1; }; for run in 1 2 3 4 5 6 7 8 9 10; do E2E_BUNDLE=1 TMPDIR=/tmp/harness-e2e-4362-linux npx vitest run --config vitest.e2e.config.ts e2e/otherEngines.e2e.ts e2e/readerClose.e2e.ts >/tmp/run.log 2>&1 && echo "run $run passed: $(grep -a "Tests " /tmp/run.log)" || { echo "run $run failed"; grep -a -n " × \|FAIL\|Error\|timed out\|Tests " /tmp/run.log | head -30; exit 1; }; done; echo ALL-PASSED'
   ```

   To see, after about 3 minutes of `npm ci` and 48 s a run: ten lines `run N passed:` each with
   `Tests  7 passed | 1 skipped (8)`, then `ALL-PASSED`. The `TMPDIR` is long on purpose (the fake Pi's title, under
   "Found"). One failure in ten is not a pass: report the run, the row and its error, and stop.

   The container is Linux on arm64; the failure was seen on an x86_64 runner. The cause has no part that depends on
   the processor, and the nightly CLI end to end runs the file on x86_64 after the merge.

   **If Docker is not running:** the repo's own workflow, once, by hand (it needs the orchestrator's runner turn):
   `gh workflow run cli-e2e.yml --ref fix/4362-otherengines-sigkill`, ten runners for about 25 minutes, never beside
   another heavy workflow. It runs the file once, not ten times. To see: `e2e (1)` to `e2e (8)` and `e2e-summary`
   green; put the run's link in the pull request body.

**Temporary workflow:** none. The repeat runs in a local container, and the fallback is the repo's own workflow.

**Checks that keep running:** nothing new. `bind.spec.ts` runs in `cli-tests` on every pull request; the end-to-end
file runs in the nightly CLI end to end, as before.

**Checks PR CI does not run:** `cli-core` is the only one these paths need (`scripts/local-checks.py --list` on the
three files and the two documents names it alone).
