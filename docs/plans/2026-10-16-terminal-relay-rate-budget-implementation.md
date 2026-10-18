# Terminal Relay Rate Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the backend's per-socket terminal rate guard from rejecting legitimate traffic when several panes of one machine stream over the ws relay.

**Architecture:** One `TerminalRateGuard` serves a whole socket, but its `terminal_ack` and `terminal_output` limits were sized for one stream. Size them for `RELAY_BUSY_STREAMS = 16` busy streams per socket by multiplying the per-stream rates. Change only `limits()` in `backend/src/lib/terminalRelay.ts`; rejection semantics stay as they are.

**Tech Stack:** TypeScript, Node, vitest (backend).

**Spec:** `docs/plans/2026-10-16-terminal-relay-rate-budget.md`

## Global Constraints

- Backend only: no change under `cli/`, `desktop/`, `mobile/`, or `desktop/lib/web/`.
- `RELAY_BUSY_STREAMS = 16`.
- `terminal_ack`: 16 × 3,750 = **60,000 frames/min**, bytes **16 MiB**.
- `terminal_output`: 16 × 7,500 = **120,000 frames/min**, bytes stay **128 MiB**.
- Every other bucket is unchanged.
- Rejection semantics are unchanged. Down rejections still answer `TERMINAL_FRAME_REJECTED`; up rejections still drop silently.
- Do not commit. Leave the change in the working tree; the owner commits.
- Repo docs and comments in English. Comments say why, and name the incident or measurement.

## Review Focus

1. **Byte cap binding before frame cap for acks.** A worst-case encrypted ack (`lastSeq` = `Number.MAX_SAFE_INTEGER`, `n` = `Number.MAX_SAFE_INTEGER`) is 216 B. 60,000 of them must fit in 16 MiB. Task 1's ack test runs at that exact size.
2. **The 60,001st ack / 120,001st output frame is still refused.** The guard must not become unlimited. Task 1's tests assert the next frame fails.
3. **Window reset still works at the new sizes.** After 60 s the bucket refills. The existing test covers `terminal_open`, and Task 1 adds the same check for `terminal_ack`.
4. **Other buckets did not move.** The existing test "lets a busy renderer ack…" still asserts `terminal_alive` trips at 1,200; keep it passing unchanged.
5. **Legacy key path and web path share `limits()`.** `webWs.ts:131` and `:589` both construct `TerminalRateGuard`, so no change is needed there. `webWs.test.ts` must still pass.

---

### Task 1: Size the ack and output buckets for 16 busy streams per socket

**Files:**
- Modify: `backend/src/lib/terminalRelay.ts` (the `limits()` function and the comment above `terminal_ack`, lines ~44–63)
- Test: `backend/src/lib/terminalRelay.test.ts`

**Interfaces:**
- Consumes: `TerminalRateGuard`, `terminalFrameBytes` (existing exports of `terminalRelay.ts`); `Frame` type from `backend/src/lib/tunnel.ts` (`Record<string, unknown>`).
- Produces: `export const RELAY_BUSY_STREAMS = 16` in `terminalRelay.ts`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/lib/terminalRelay.test.ts`, extend the import and add a helper plus three tests inside the existing `describe('terminal opaque relay contract', …)` block, right after the test "lets a busy renderer ack for a whole window without losing its stream":

```ts
import { describe, expect, it } from 'vitest'
import type { Frame } from './tunnel.js'
import {
  isEncryptedTerminalFrame,
  RELAY_BUSY_STREAMS,
  TERMINAL_DOWN_TYPES,
  TERMINAL_UP_TYPES,
  terminalFrameBytes,
  terminalFrameNeedsWake,
  TerminalRateGuard,
} from './terminalRelay.js'

/** The largest `terminal_ack` a client can send, shaped exactly as the relay wraps it: the plaintext
 *  payload sealed with a 16-byte AEAD tag, base64'd into an `__e2e` envelope. */
function worstCaseAck(): Frame {
  const plaintext = JSON.stringify({
    streamId: '00000000-0000-4000-8000-000000000000',
    lastSeq: Number.MAX_SAFE_INTEGER,
  })
  const ct = Buffer.alloc(Buffer.byteLength(plaintext) + 16).toString('base64')
  return { type: 'terminal_ack', payload: { __e2e: { v: 1, k: 'p', n: Number.MAX_SAFE_INTEGER, ct } } }
}
```

```ts
  it('lets RELAY_BUSY_STREAMS renderers ack on one socket for a whole minute', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    // One guard serves the socket, and every pane of the machine shares it. Each busy pane acks once
    // per 16 ms render window; the worst-case frame size makes the byte cap part of the check.
    const acks = RELAY_BUSY_STREAMS * Math.ceil(60_000 / 16)
    const bytes = terminalFrameBytes(worstCaseAck())
    let allowed = 0
    for (let i = 0; i < acks; i++) if (guard.allow('terminal_ack', bytes)) allowed++
    expect(allowed).toBe(acks)
    expect(guard.allow('terminal_ack', bytes)).toBe(false)
    now += 60_000
    expect(guard.allow('terminal_ack', bytes)).toBe(true)
  })

  it('lets RELAY_BUSY_STREAMS streams flush output every 8 ms through one adapter for a whole minute', () => {
    const guard = new TerminalRateGuard(() => 1_000)
    const frames = RELAY_BUSY_STREAMS * (60_000 / 8)
    let allowed = 0
    for (let i = 0; i < frames; i++) if (guard.allow('terminal_output', 256)) allowed++
    expect(allowed).toBe(frames)
    expect(guard.allow('terminal_output', 256)).toBe(false)
  })

  it('keeps a worst-case encrypted ack small enough for the ack byte budget', () => {
    // Pins the size the ack budget was derived from (216 B). A frame that grows past
    // 16 MiB / 60,000 = 279 B would make the byte cap trip before the frame cap.
    expect(terminalFrameBytes(worstCaseAck())).toBeLessThanOrEqual(Math.floor((16 * 1024 * 1024) / 60_000))
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npm test -- src/lib/terminalRelay.test.ts`
Expected: FAIL. `RELAY_BUSY_STREAMS` is not exported, so it is `undefined`: the ack test's `acks` is `NaN` and `expect(allowed).toBe(acks)` fails. After Step 3 adds only the constant and not the limits, it would instead fail with `expected 10000 to be 60000`.

- [ ] **Step 3: Implement the limits**

In `backend/src/lib/terminalRelay.ts`, add these constants directly above `interface Bucket`:

```ts
/**
 * One TerminalRateGuard serves a whole socket (a web client's connection, or a machine's adapter), so
 * every stream on it shares each bucket below. The backend cannot split them: terminal frames are
 * E2EE and the stream id is inside the ciphertext. The ack and output buckets were once sized for a
 * single busy stream, and three panes of one machine streaming over the relay tripped them. A rejected
 * ack answers TERMINAL_FRAME_REJECTED, which every pane on the socket reads as transport loss and shows
 * as Reconnect (2026-10-16). They are now sized for this many busy streams per socket.
 */
export const RELAY_BUSY_STREAMS = 16
/** A renderer acks once per 16 ms render window, plus once per 64 KiB rendered, while output flows. */
const ACKS_PER_STREAM_PER_MINUTE = 3_750
/** The daemon flushes a remote stream's output at most every 8 ms (`OUTPUT_FLUSH_MS` in the CLI). */
const OUTPUT_FRAMES_PER_STREAM_PER_MINUTE = 7_500
```

Then, in `limits()`, replace the `terminal_output` line:

```ts
  if (type === 'terminal_output') return { frames: 20_000, bytes: 128 * 1024 * 1024 }
```

with:

```ts
  // Bytes, not frames, bound the volume; the frame count only has to clear legitimate flush cadence.
  if (type === 'terminal_output') {
    return { frames: RELAY_BUSY_STREAMS * OUTPUT_FRAMES_PER_STREAM_PER_MINUTE, bytes: 128 * 1024 * 1024 }
  }
```

and replace the ack comment and line:

```ts
  // Acks are renderer flow control, not user actions. The client emits one per 16ms render window
  // (plus one per 64 KiB rendered), so roughly 3,750/min while output is flowing. Sharing the
  // human-paced 1,200 below meant a pane streaming a build log exhausted the window in about 19
  // seconds, and a rejected ack is not dropped quietly — it answers TERMINAL_FRAME_REJECTED, which
  // the client reads as transport loss and freezes the pane mid-output. Sized ~2.7x the client's
  // own ceiling; the byte cap still bounds actual volume.
  if (type === 'terminal_ack') return { frames: 10_000, bytes: 8 * 1024 * 1024 }
```

with:

```ts
  // Acks are renderer flow control, not user actions, and cannot be dropped quietly: the host pauses
  // output at 384 KiB unacknowledged and closes the stream (TERMINAL_RENDER_STALLED) if the ack that
  // would resume it never arrives. Sharing the human-paced 1,200 below once let a single pane
  // streaming a build log exhaust the window in about 19 seconds. A worst-case encrypted ack is
  // 216 B (pinned in terminalRelay.test.ts), so 60,000 of them fit in 16 MiB.
  if (type === 'terminal_ack') {
    return { frames: RELAY_BUSY_STREAMS * ACKS_PER_STREAM_PER_MINUTE, bytes: 16 * 1024 * 1024 }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npm test -- src/lib/terminalRelay.test.ts`
Expected: PASS. All tests pass, including the unchanged "rate-limits per type in a bounded one-minute window" and "lets a busy renderer ack for a whole window without losing its stream".

- [ ] **Step 5: Run the neighbouring suites and the typecheck**

Run: `cd backend && npm test -- src/lib/webWs.test.ts src/lib/terminalRelay.test.ts && npm run typecheck`
Expected: PASS and no type errors.

- [ ] **Step 6: Leave uncommitted**

Do not commit (owner preference). Report `git status --short` and `git diff --stat`. Expected: two files changed, `backend/src/lib/terminalRelay.ts` and `backend/src/lib/terminalRelay.test.ts`. The spec and this plan under `docs/plans/` are also untracked.

---

## After the task (owner's call, not part of execution)

- PR with `ci/required` (backend component checks), then `make merge-pr`, then `make release-backend`.
- Post-deploy check from the spec: put a remote machine on the ws relay (p2p off or failed) and run steady output in four panes for two minutes. No pane should show Reconnect or flap through Restoring.
