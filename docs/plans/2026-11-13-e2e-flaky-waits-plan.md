# Three flaky CLI end-to-end tests (harnessWatch, the full-disk fill, the browser's pane): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task is test-first: a red commit (the
> spec alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three flaky tests that fail the nightly CLI end to end workflow wait and set up correctly, and the
helpers they use make the same mistake fail by name or impossible to repeat.

**Architecture:** Test code only. `LocalClient` (`cli/e2e/harness/client.ts`) refuses a `since` that is not an index
and gets one `turn()` that waits for its own message's turn; one `fillVolume()` in `cli/e2e/harness/` replaces the two
drifted copies of `fill()`. Each helper has a unit spec in `cli/src/testing/`, run by the default suite, and the five
end-to-end files move onto the helpers.

**Tech Stack:** TypeScript, Vitest 4.1, `ws` 8.21 (both already in `cli/package.json`). No new dependency.

**Spec:** [docs/plans/2026-11-13-e2e-flaky-waits-design.md](2026-11-13-e2e-flaky-waits-design.md). Read it with this
plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- No product code changes: under `cli/src/` only the two new specs in `cli/src/testing/`; nothing else outside `cli/e2e/`.
- No retries, no longer timeouts, no skips. Every wait keeps the bound it has today: 45 000 ms for each
  `harness_event` wait and for each wait of a turn. `turn()` bounds each of its two waits by `ms`, as `endOf` in
  `cli/e2e/windows.e2e.ts:49-53` does.
- Every case of the same cause: both `Date.now()` marks in `harnessWatch.e2e.ts`, both copies of `fill()`, all four
  waits for the first `turn_ended` after a browser is ready. Nothing wider: the other end-to-end files' own `turn`
  helpers, `RelayPhone.waitFor` and `FakeDial.next` stay as they are.
- Comments say why, in plain sentences, and name the incident (nightly run 43247147594; runs 43400659690 and
  43254356483).
- Never run or list `e2e/agentBrowserPodman.e2e.ts` on a developer's Mac: it acts on the machine's real Podman. Never
  run the whole end-to-end suite locally for the same reason. Its proof is the workflow run in Verification.
- Each checkout a task runs in needs `cli/node_modules`, and this worktree has none (checked 2026-11-13). Install once
  per checkout before the first test command, never two installs at once in one checkout:
  `cd cli && npm ci --no-audit --no-fund`.
- Platforms: none of the product's. The specs run on Linux (PR CI `cli-tests`) and macOS; the end-to-end files on
  Linux (nightly shards) and macOS (the full disk).
- One pull request for the three; its body carries each task's red and green output and the Verification results.

## Found while reading the code

Checked at `4961894fbc`:

- **Frame shapes.** `turn_started` and `turn_ended` carry the agent at the top level (`frame.agentId`) and the text in
  `frame.payload.userMessage` (`e2e/turns.e2e.ts:30, 80-81`, `e2e/windows.e2e.ts:46-53`). `harness_event` carries
  `payload.agentId` and `payload.state`.
- **The guard breaks no caller.** Of the 40 calls of a `waitFor` or `waitForBinary` with a fourth argument under
  `cli/` (found by syntax tree, not grep), 39 pass `<list>.length`, `<list>.indexOf(frame)` or that plus one, of the
  client they wait on. The one that does not is `harnessWatch.e2e.ts:17`, fed the timestamps of lines 51 and 64.
- **Two other helpers take the same `since`** with no check and no misuse today: `RelayPhone.waitFor`
  (`e2e/harness/relayPhone.ts:179`) and `FakeDial.next` (`e2e/harness/fakeDial.ts:83`). The spec guards
  `LocalClient` only, and so does this plan.
- **A spec in `src/` cannot import `e2e/` statically:** `tsconfig.json` has `rootDir: src`, so `tsc` refuses it
  (TS6059). `src/testing/releaseFixtures.spec.ts:4` loads `e2e/harness/release.js` with
  `await import('…' as string) as { … }`; the new specs do the same and declare the shapes they use.
- **Only `cli/e2e/harness/` may be imported from `src/`.** `scripts/ci-plan.py` lists `cli/e2e/` as not read by the
  CLI's PR jobs (`NOT_READ`) except `cli/e2e/harness/` (`DEPENDS`, `PR_READS`), and its cross-read test fails on a
  reference to any other `cli/e2e/` path. So the fill helper lives in `cli/e2e/harness/`, and a change there runs the
  CLI's PR jobs.
- **End-to-end files are not typechecked** (`tsconfig.json` includes `src/` only), so a leftover name shows only when
  the file runs: each task ends its edits with a grep.
- **`ws` delivers every frame of one socket read in one synchronous loop** (`allowSynchronousEvents`, on by default
  for a client in 8.21): a frame can be in `frames` before the code that waits for it runs.
- **The fake engine exits only on a prompt that is exactly `!exit`** (`e2e/harness/fakeEngine.mjs:1252`).
- **Local gates.** `python3 scripts/local-checks.py --list <the nine paths below>` prints `{}`: no coverage gate
  covers these paths (`npm run test:core` covers `src/core/` and `src/services/` only).

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/e2e/harness/client.ts` | `checkSince`, called by `waitFor` and `waitForBinary`; `LocalClient.turn` | 1, 2 |
| `cli/src/testing/localClient.spec.ts` | new: a stub of the daemon's local socket, and the specs of both | 1, 2 |
| `cli/e2e/harnessWatch.e2e.ts` | marks by index; `idle` waited from the `working` event's index | 1 |
| `cli/e2e/agentBrowser.e2e.ts`, `cli/e2e/agentBrowserPodman.e2e.ts` | the four waits use `turn()` | 2 |
| `cli/e2e/harness/fullDisk.ts` | new: `fillVolume` | 3 |
| `cli/src/testing/fullDisk.spec.ts` | new: its spec, `node:fs` stubbed | 3 |
| `cli/e2e/updateHostile.e2e.ts`, `cli/e2e/diskfull.e2e.ts` | their own `fill` removed; they call `fillVolume` | 3 |

## Review Focus

Each line is pinned by a test in the task that owns the code.

- `since` at its edges: 0 and exactly the list's length (what `next()` passes) are still taken; `-1`, which
  `frames.indexOf` answers for a frame of another client, is refused by name instead of meaning "the last frame".
  Task 1, both tests.
- A turn's `turn_ended` in the same socket read as its `turn_started`: it is in `frames` before anyone waits for it,
  and `turn()` finds it by index. Task 2, first test (the stub sends all six frames in one go).
- The same words twice, or another agent's turn with the same words: neither an earlier turn nor another agent's
  counts. Task 2, first and second tests.
- A volume already full when `fillVolume` is called (updateHostile's third scenario calls it in a loop): the filler's
  own open may be refused, and that is full, not an error. Task 3, third test.
- An error that is not ENOSPC on the tail (today's bare `catch` swallows it): thrown, with the file closed. Task 3,
  fourth test.

---

### Task 1: `since` is an index (F)

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/testing/localClient.spec.ts`
- Modify: `cli/e2e/harness/client.ts` (`waitForBinary` at 79, `waitFor` at 93)
- Modify: `cli/e2e/harnessWatch.e2e.ts` (16-18, 51-55, 64-67)

**Interfaces:**
- Produces, for Task 2: in the spec, `stubDaemon(heard?)` returning `{ client, send }`, the `Frame` and `Client`
  types, and the untyped `LocalClient` import, all below.

- [ ] **Step 1: Write the failing spec**

`cli/src/testing/localClient.spec.ts`:

```ts
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

type Frame = { type: string; agentId?: string; payload?: Record<string, unknown> }
interface Client {
  readonly frames: Frame[]
  waitFor(test: (frame: Frame) => boolean, ms?: number, what?: string, since?: number): Promise<Frame>
  waitForBinary(test: (frame: unknown) => boolean, ms?: number, what?: string, since?: number): Promise<unknown>
  close(): void
}
// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as releaseFixtures.spec.ts
// loads release.ts.
const { LocalClient } = await import('../../e2e/harness/client.js' as string) as {
  LocalClient: {
    connect(daemon: { port: number; computerId: string; localHeaders(): Record<string, string> }, options: { tcp: true }): Promise<Client>
  }
}

const opened: Array<{ close(): void }> = []
afterEach(() => { for (const one of opened.splice(0).reverse()) one.close() })

/** The daemon's local socket, as far as LocalClient needs one: `connected` after `machine_select`, and every other
 *  frame the client sends handed to `heard` with a way to answer. `send` pushes a frame at any time. */
async function stubDaemon(heard: (frame: Frame, send: (frame: Frame) => void) => void = () => {}): Promise<{ client: Client; send(frame: Frame): void }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  opened.push(server)
  await new Promise((resolve) => server.once('listening', resolve))
  let socket: WebSocket | undefined
  const send = (frame: Frame) => socket!.send(JSON.stringify(frame))
  server.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.type === 'machine_select') send({ type: 'connected' })
      else heard(frame, send)
    })
  })
  const client = await LocalClient.connect({ port: (server.address() as AddressInfo).port, computerId: 'spec', localHeaders: () => ({}) }, { tcp: true })
  opened.push(client)
  return { client, send }
}

describe('LocalClient.waitFor and waitForBinary take since as an index', () => {
  it('refuses a since that is not an index of the list, and names it', async () => {
    const { client } = await stubDaemon()
    const stamp = Date.now()
    // `frames` holds `connected` alone, and no terminal frame came.
    expect(() => client.waitFor(() => true, 50, 'a frame', stamp)).toThrow(`waitFor: since must be an index into frames (0 to 1), not ${stamp}`)
    expect(() => client.waitForBinary(() => true, 50, 'a terminal frame', stamp)).toThrow(`waitForBinary: since must be an index into binaries (0 to 0), not ${stamp}`)
    // -1 is what `frames.indexOf` answers for a frame that is not in the list.
    for (const since of [-1, 2, 0.5, Number.NaN]) expect(() => client.waitFor(() => true, 50, 'a frame', since)).toThrow(`not ${since}`)
  })

  it('takes every index of the list, its length included: the frames still to come', async () => {
    const { client, send } = await stubDaemon()
    expect(await client.waitFor((frame) => frame.type === 'connected', 50, 'connected', 0)).toEqual({ type: 'connected' })
    const later = client.waitFor((frame) => frame.type === 'later', 2_000, 'later', client.frames.length)
    send({ type: 'later' })
    expect(await later).toEqual({ type: 'later' })
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/testing/localClient.spec.ts`
Expected: the first test FAILS (nothing is thrown: the check does not exist); the second passes.

- [ ] **Step 3: Commit the red spec**

```bash
git add cli/src/testing/localClient.spec.ts
git commit -m "e2e: a spec that LocalClient refuses a since that is not an index (red)"
```

- [ ] **Step 4: Add `checkSince` to `cli/e2e/harness/client.ts`**

A module-level
`function checkSince(method: 'waitFor' | 'waitForBinary', list: 'frames' | 'binaries', length: number, since: number): void`
that throws `` new Error(`${method}: since must be an index into ${list} (0 to ${length}), not ${since}`) `` unless
`Number.isInteger(since) && since >= 0 && since <= length`. It is the first statement of `waitFor` and of
`waitForBinary`: a synchronous throw at the call, before any promise. Its comment says why: a `Date.now()` passed as
`since` made the look back always empty, so a frame that came before its waiter was never seen
(`e2e/harnessWatch.e2e.ts`, nightly run 43247147594).

- [ ] **Step 5: Mark `cli/e2e/harnessWatch.e2e.ts` by index**

From the moment Step 4 is in, this file fails by name at its first wait (line 54). Replace `harnessEvents` (16-18) with:

```ts
const harnessEvent = (agentId: string, state: string) => (frame: Frame) =>
  frame.type === 'harness_event' && frame.payload?.agentId === agentId && frame.payload?.state === state
/** One round as the tool is told it: `working` from `since` on, an index into its frames, then the `idle` after that
 *  event. By index, because both can come in one socket read: an `idle` that came before anyone waited for it was
 *  never seen (nightly run 43247147594), and the `idle` of the round before must not count. */
async function workedThenIdle(client: LocalClient, agentId: string, since: number): Promise<void> {
  const working = await client.waitFor(harnessEvent(agentId, 'working'), 45_000, 'harness_event working', since)
  await client.waitFor(harnessEvent(agentId, 'idle'), 45_000, 'harness_event idle', client.frames.indexOf(working))
}
```

Lines 51-55 become `const since = tool.frames.length`, the `onB.send` as it is, then
`await workedThenIdle(tool, agentId, since)`. Lines 64-67 become `const again = tool.frames.length`, the `onB.send` as
it is, then `await workedThenIdle(tool, agentId, again)`.

- [ ] **Step 6: Run the checks**

```bash
cd cli
npx vitest run src/testing/localClient.spec.ts                               # 2 passed
npm run typecheck                                                            # no error
grep -n "Date.now()" e2e/harnessWatch.e2e.ts                                 # prints nothing
npx vitest run --config vitest.e2e.config.ts e2e/harnessWatch.e2e.ts         # 1 passed (one run; the ten are Verification's)
```

- [ ] **Step 7: Commit**

```bash
git add cli/e2e/harness/client.ts cli/e2e/harnessWatch.e2e.ts
git commit -m "e2e: harnessWatch marks its waits by index, and LocalClient refuses a since that is not one"
```

---

### Task 2: A turn that waits for its own message (H)

**Depends on:** Task 1 (the same `client.ts` and spec file; uses its `stubDaemon`). **Effort:** high.

**Files:**
- Modify: `cli/src/testing/localClient.spec.ts`
- Modify: `cli/e2e/harness/client.ts` (a method after `next`, line 109)
- Modify: `cli/e2e/agentBrowser.e2e.ts` (273-275, 311-313, 360-362)
- Modify: `cli/e2e/agentBrowserPodman.e2e.ts` (911-913)

**Interfaces:**
- Consumes: `stubDaemon`, `Frame`, `Client` from Task 1's spec.
- Produces: `LocalClient.turn(agentId: string, content: string, ms = 45_000): Promise<Frame>`.

- [ ] **Step 1: Write the failing spec**

In `cli/src/testing/localClient.spec.ts`, add `turn(agentId: string, content: string, ms?: number): Promise<Frame>` to
`Client`, and append:

```ts
describe('LocalClient.turn', () => {
  const said = (frame: Frame) => frame.payload as { agentId: string; content: string }

  it('resolves with the end of its own message\'s turn, not of a turn that was under way', async () => {
    const { client } = await stubDaemon((frame, send) => {
      if (frame.type !== 'message') return
      const { agentId, content } = said(frame)
      // In one go, so they reach the client in one socket read: each wait has to find its frame by index.
      send({ type: 'turn_started', agentId, payload: { userMessage: 'a line the daemon typed' } })
      send({ type: 'turn_started', agentId: 'another-agent', payload: { userMessage: content } })
      send({ type: 'turn_ended', agentId, payload: { n: 1 } })
      send({ type: 'turn_started', agentId, payload: { userMessage: content } })
      send({ type: 'turn_ended', agentId: 'another-agent', payload: { n: 2 } })
      send({ type: 'turn_ended', agentId, payload: { n: 3 } })
    })
    expect(await client.turn('agent-1', 'One turn before the exit', 2_000)).toEqual({ type: 'turn_ended', agentId: 'agent-1', payload: { n: 3 } })
  })

  it('does not take an earlier turn of the same words for its own', async () => {
    let n = 0
    const { client } = await stubDaemon((frame, send) => {
      if (frame.type !== 'message') return
      const { agentId, content } = said(frame)
      send({ type: 'turn_started', agentId, payload: { userMessage: content } })
      send({ type: 'turn_ended', agentId, payload: { n: ++n } })
    })
    expect((await client.turn('agent-1', 'again', 2_000)).payload).toEqual({ n: 1 })
    expect((await client.turn('agent-1', 'again', 2_000)).payload).toEqual({ n: 2 })
  })

  it('names the wait that ran out', async () => {
    const { client } = await stubDaemon((frame, send) => {
      if (frame.type === 'message' && said(frame).content === 'starts, never ends') send({ type: 'turn_started', agentId: 'agent-1', payload: { userMessage: 'starts, never ends' } })
    })
    await expect(client.turn('agent-1', 'never typed', 100)).rejects.toThrow('turn_started (never typed)')
    await expect(client.turn('agent-1', 'starts, never ends', 100)).rejects.toThrow('turn_ended (starts, never ends)')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/testing/localClient.spec.ts`
Expected: the three new tests FAIL with `client.turn is not a function`; Task 1's two pass.

- [ ] **Step 3: Commit the red spec**

```bash
git add cli/src/testing/localClient.spec.ts
git commit -m "e2e: a spec that LocalClient.turn waits for its own message's turn (red)"
```

- [ ] **Step 4: Add `async turn(agentId: string, content: string, ms = 45_000): Promise<Frame>` to `LocalClient`**

It marks `this.frames.length`, sends `message` with `{ agentId, content }`, waits from that mark for the
`turn_started` with `frame.agentId === agentId` and `frame.payload?.userMessage === content` (what:
`` `turn_started (${content})` ``), then from that frame's index plus one for the `turn_ended` with
`frame.agentId === agentId` (what: `` `turn_ended (${content})` ``), and returns that `turn_ended`. Both waits are
`this.waitFor`, each bounded by `ms`. Its comment says why: the daemon types lines of its own into an agent as turns
(the browser's ready line), and a test that took that turn's end for its own typed `!exit` while its message was still
on its way, so the engine got both as one prompt and never exited (`e2e/agentBrowser.e2e.ts`, runs 43400659690 and
43254356483).

- [ ] **Step 5: Move the four waits onto it**

Each of these three-line blocks (`const ended = client.next(… 'turn_ended')`, `client.send('message', …)`,
`await ended`) becomes one line; the comment above each stays:

| Where | Becomes |
| --- | --- |
| `e2e/agentBrowser.e2e.ts:273-275` | `await client.turn(agent.id, 'One turn before the purge')` |
| `e2e/agentBrowser.e2e.ts:311-313` | `await client.turn(agent.id, 'One turn before the stop')` |
| `e2e/agentBrowser.e2e.ts:360-362` | `await client.turn(agent.id, 'One turn before the exit')` |
| `e2e/agentBrowserPodman.e2e.ts:911-913` | `await client!.turn(agent!.id, 'Keep this conversation across the stop')` |

- [ ] **Step 6: Run the checks**

```bash
cd cli
npx vitest run src/testing/localClient.spec.ts                               # 5 passed
npm run typecheck                                                            # no error
grep -n "'turn_ended'" e2e/agentBrowser.e2e.ts e2e/agentBrowserPodman.e2e.ts # prints nothing
npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts         # 6 passed (one run; fake Podman)
```

`e2e/agentBrowserPodman.e2e.ts` is not run here (Global Constraints): read its diff, three lines for one.

- [ ] **Step 7: Commit**

```bash
git add cli/e2e/harness/client.ts cli/e2e/agentBrowser.e2e.ts cli/e2e/agentBrowserPodman.e2e.ts
git commit -m "e2e: the agent browser's tests wait for their own message's turn, not the first to end"
```

---

### Task 3: One `fillVolume` for a full disk (G)

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/testing/fullDisk.spec.ts`
- Create: `cli/e2e/harness/fullDisk.ts`
- Modify: `cli/e2e/updateHostile.e2e.ts` (19, 508-516, 572, 590, 614, 623, 641)
- Modify: `cli/e2e/diskfull.e2e.ts` (12, 34-53, 110, 179)

**Interfaces:**
- Produces: `export function fillVolume(volume: string): string`, which returns `join(volume, 'filler')`.

- [ ] **Step 1: Write the failing spec**

`cli/src/testing/fullDisk.spec.ts`:

```ts
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ open: vi.fn(), write: vi.fn(), close: vi.fn() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), openSync: io.open, writeSync: io.write, closeSync: io.close }))
// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as releaseFixtures.spec.ts
// loads release.ts.
const { fillVolume } = await import('../../e2e/harness/fullDisk.js' as string) as { fillVolume: (volume: string) => string }

const refused = (code: string) => Object.assign(new Error(code), { code })
const filler = join('/v', 'filler')
const tail = join('/v', 'filler-tail')
/** A volume: what each file opens as (a descriptor, or the error its open throws), and how many writes each
 *  descriptor takes before the volume refuses. */
function volume(opens: Record<string, number | Error>, room: Record<number, number> = {}): void {
  io.open.mockImplementation((path: string) => { const fd = opens[path]; if (fd instanceof Error) throw fd; return fd })
  io.write.mockImplementation((fd: number, chunk: Buffer) => { if ((room[fd] ?? 0) <= 0) throw refused('ENOSPC'); room[fd]--; return chunk.length })
}
beforeEach(() => { for (const fn of Object.values(io)) fn.mockReset() })

describe('fillVolume', () => {
  it('appends to the filler until the volume refuses, then to the tail, and returns the filler', () => {
    volume({ [filler]: 3, [tail]: 4 }, { 3: 2, 4: 1 })
    expect(fillVolume('/v')).toBe(filler)
    expect(io.open.mock.calls).toEqual([[filler, 'a'], [tail, 'a']])
    expect(io.write.mock.calls.map(([fd, chunk]) => [fd, chunk.length])).toEqual([[3, 1048576], [3, 1048576], [3, 1048576], [4, 4096], [4, 4096]])
    expect(io.close.mock.calls).toEqual([[3], [4]])
  })

  it('a volume too full to create the tail is full: it returns', () => {
    volume({ [filler]: 3, [tail]: refused('ENOSPC') })
    expect(fillVolume('/v')).toBe(filler)
    expect(io.close.mock.calls).toEqual([[3]])
  })

  it('a volume too full to open the filler is full: it returns', () => {
    volume({ [filler]: refused('ENOSPC'), [tail]: refused('ENOSPC') })
    expect(fillVolume('/v')).toBe(filler)
    expect(io.close).not.toHaveBeenCalled()
  })

  it('throws an error that is not ENOSPC, from an open or a write, and closes what it opened', () => {
    volume({ [filler]: 3, [tail]: refused('EACCES') })
    expect(() => fillVolume('/v')).toThrow('EACCES')
    expect(io.close.mock.calls).toEqual([[3]])
    io.close.mockClear()
    volume({ [filler]: 3, [tail]: 4 })
    io.write.mockImplementation((fd: number) => { throw refused(fd === 4 ? 'EIO' : 'ENOSPC') })
    expect(() => fillVolume('/v')).toThrow('EIO')
    expect(io.close.mock.calls).toEqual([[3], [4]])
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/testing/fullDisk.spec.ts`
Expected: FAIL, the file cannot load `../../e2e/harness/fullDisk.js`: the helper does not exist.

- [ ] **Step 3: Commit the red spec**

```bash
git add cli/src/testing/fullDisk.spec.ts
git commit -m "e2e: a spec of one fill for a full disk, whose tail's open may be refused (red)"
```

- [ ] **Step 4: Write `cli/e2e/harness/fullDisk.ts`**

`export function fillVolume(volume: string): string`, with `closeSync`, `openSync`, `writeSync` as named imports from
`node:fs`. For `filler` with chunks of `Buffer.alloc(1024 * 1024, 7)`, then for `filler-tail` (the last blocks a
metadata write may still find) with chunks of `Buffer.alloc(4096, 7)`: open with `'a'`, write until it throws, with
the open and every write inside one `try`; ENOSPC ends that file quietly, any other error is thrown; a file that
opened is closed in `finally`. One private function does this for a path and a chunk, called twice. The file's
comment says why: a full volume can refuse to create the tail (nightly run 43247147594,
`updateHostile.e2e.ts`), the two tests' copies had drifted, and appending lets a caller top the volume up.

- [ ] **Step 5: Run the spec**

Run: `cd cli && npx vitest run src/testing/fullDisk.spec.ts`
Expected: 4 passed.

- [ ] **Step 6: Replace both copies**

Both files import `{ fillVolume }` from `./harness/fullDisk.js`, beside their other harness imports, and drop
`closeSync`, `openSync` and `writeSync` from their `node:fs` import (lines 19 and 12).

- `e2e/updateHostile.e2e.ts`: delete the `fill` closure and its comment (508-516). `fill()` becomes
  `fillVolume(volume)` at 572, 590, 614, 641 and inside the `until` callback at 623. `filler`, `room`, `unfill` stay.
- `e2e/diskfull.e2e.ts`: delete `function fill` and its comment (34-53). `fill(volume)` becomes `fillVolume(volume)`
  at 110 and 179; both still take the returned path to remove it.

- [ ] **Step 7: Run the checks**

```bash
cd cli
npm run typecheck                                                                                    # no error
grep -nE "\b(openSync|closeSync|writeSync)\b|\bfill\(" e2e/updateHostile.e2e.ts e2e/diskfull.e2e.ts  # prints nothing
npx vitest list --config vitest.e2e.config.ts e2e/diskfull.e2e.ts e2e/updateHostile.e2e.ts           # lists both files' tests
```

The run on real volumes is Verification's third check: it mounts disk images and takes about ten minutes, so it is
run once, on the final head.

- [ ] **Step 8: Commit**

```bash
git add cli/e2e/harness/fullDisk.ts cli/e2e/updateHostile.e2e.ts cli/e2e/diskfull.e2e.ts
git commit -m "e2e: one fillVolume for the full-disk tests, whose every open and write may be refused"
```

---

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every file boots
its own daemons under throwaway homes and data folders, a private tmux server, ports of its own and fake engines
(`e2e/harness/daemon.ts`, `fakeEngine.mjs`). No sign-in, no account, no production, and nothing of the developer's
daemon (port 18473), `~/.harness`, `~/.claude` or `~/.codex`. None of these checks needs Ken himself.

Local checks run on this Mac (macOS, tmux, `hdiutil`), in `cli/` with `node_modules` installed, one at a time and with
no other suite running: their timing must be the daemon's, not the machine's contention.

1. **harnessWatch, ten times.** Two daemons on one account and the in-process fake backend (`e2e/harness/fleet.ts`,
   `fakeBackend.ts`).

   ```bash
   cd cli && for i in $(seq 1 10); do npx vitest run --config vitest.e2e.config.ts e2e/harnessWatch.e2e.ts || { echo "run $i failed"; break; }; done
   ```

   To see: ten runs, each `1 passed`, and no `run N failed` line.

2. **agentBrowser, ten times.** One daemon with a fake `podman` first on the fixture's PATH; the real Podman is never
   run.

   ```bash
   cd cli && for i in $(seq 1 10); do npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts || { echo "run $i failed"; break; }; done
   ```

   To see: ten runs, each `6 passed`, and no `run N failed` line.

3. **The full disk, once,** as the workflow's `e2e (macOS, full disk)` job runs it: daemons on two HFS+ disk images of
   their own (64 MB and 96 MB, mounted under the temporary folder) and a local update server.

   ```bash
   cd cli && DISKFULL=1 E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/diskfull.e2e.ts e2e/updateHostile.e2e.ts -t 'a full disk|an update on a disk that fills'
   ```

   To see: 6 passed (two of `a full disk`, four of `an update on a disk that fills`), the rest skipped, no ENOSPC from
   `fillVolume`; afterwards `mount | grep -E '/h[ud]-'` prints nothing (both volumes detached).

On GitHub, by hand, only with the orchestrator's go, after the branch is pushed (shared runners,
`docs/validation-and-release.md`). Report the run's link.

4. **agentBrowserPodman on real Podman, once:** the existing workflow, one Linux runner, up to 50 minutes.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-flaky-waits -f agent_browser_podman=true
   ```

   To see: the job `e2e (agent browser, real Podman)` green, its step `Require every case to pass without skipping`
   included.

No full CLI end to end run from the branch (orchestrator, 2026-11-13): checks 1 to 3 cover F, G and H locally, and
the nightly's other causes would keep that run red.

**Temporary workflow:** none. The long checks have a workflow already (`.github/workflows/cli-e2e.yml`), and the local
ones need this Mac's disk images or are the spec's own ten runs.

**Checks PR CI does not run:** none required. `python3 scripts/local-checks.py --list` on the nine changed paths
prints `{}`; `npm run test:core` does not apply (nothing under `cli/src/core/` or `cli/src/services/`). PR CI's
`cli-typecheck` and `cli-tests` run the two new specs.
