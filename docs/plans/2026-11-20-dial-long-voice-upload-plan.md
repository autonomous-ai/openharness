# Dial voice: a long recording is not lost on a slow uplink — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** A recording of up to 10 minutes is transcribed in segments of about 60 s while the person still talks, so at Done only the last segment (at most one more in flight) is left to upload, and a 10-minute recording fits the dial's 65 s wait at about 0.5 Mbps instead of 3 Mbps.

**Architecture:**
- **`VoiceSegments`** (new, `cli/src/cable/voiceSegments.ts`): one per recording. Fed PCM chunks, it cuts a segment at the quietest 20 ms frame in `[55 s, 60 s)` of its pending audio, uploads segments one at a time in order (120 s per attempt, one retry before `finish()`), and `finish()` gives the joined transcript. Its running level comes from a `VoiceLevel` accumulator in `cli/src/cable/voiceLevel.ts`.
- **`DaemonCableHost.transcribe`** (`cli/src/cable/cableHost.ts`) takes an optional `signal` and hands it to both `fetch` calls.
- **`CableSession`** (`cli/src/cable/cableSession.ts`) makes the segments at `voice.begin`, pushes each chunk in `onPcm`, awaits `finish()` in `finishVoice` where it called `host.transcribe`, and aborts them wherever the voice generation moves on.
- Devices process only. No backend, firmware or core change.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`. No new dependency.

**Spec:** `docs/plans/2026-11-20-dial-long-voice-upload-design.md`. Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md` (Protect the core; Rules 3 to 6).

## Base

- Branch `fix/dial-long-voice-upload` at `7687138398` (= its merge base with `origin/main`), worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-long-voice`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (the worktree has no `node_modules`). One `npm` process at a time.
- Names at the base (tasks name functions, never lines):
  - `cableSession.ts`: `CableHost.transcribe`, `VOICE_MAX_BYTES`, `DEFAULT_VOICE_RATE`, the `voice` field (its `chunks`, `bytes`, `rate`, `lang`, `carry`, `draft`, `question`, `search`, `form`, `selection`), `voiceGeneration`, `voiceUploadId`, `voiceCarryId`, `voiceRefusal`, `onClosed`, `onMessage` cases `carry.cancel`, `voice.begin`, `voice.abort`, `voice.end`, `onPcm`, `finishVoice` (its `current`, `reply`, `heard`), `withinCap`, `log`.
  - `cableSession.spec.ts`: `LoopbackPort` (`say`, `pcm`, `sent`, `types`, `close`), `makeHost`, `connect`, `settle`, `AGENTS`; `describe('a long recording and its long transcript')` with `record`, `listening`, `SECOND`, its 600/601 s and 615 s tests; `dropping carried text during transcription prevents later delivery` (the carry setup to copy); `logs one line per voice turn…` (the `voice turn` line with `peak` and `rms`).
  - `cableHost.ts`: `DaemonCableHost.transcribe` (its `post`, the 401 retry). `cableVoice.spec.ts`: `setup`, `ok`, `rejected`, `pcm`, `auth`.
  - `voiceLevel.ts`: `voiceLevel`. `voiceLevel.spec.ts`: `pcm`.
  - `cableFleet.spec.ts`: `fixture`, `Peer.pcm` (unchanged; a regression gate).
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 `VoiceSegments`: cut, upload one at a time, join | `cli/src/cable/voiceSegments.ts` (new), `voiceSegments.spec.ts` (new), `voiceLevel.ts`, `voiceLevel.spec.ts` | none | xhigh | `voiceSegments.spec.ts`, `voiceLevel.spec.ts` |
| 2 `transcribe` takes an abort signal | `cli/src/cable/cableHost.ts`, `cableVoice.spec.ts` | none | medium | `cableVoice.spec.ts` |
| 3 The session transcribes through the segments | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts`, `voiceLevel.ts`, `voiceLevel.spec.ts` | 1 | xhigh | `cableSession.spec.ts` |

Longest chain: two tasks (1 → 3).

- Tasks 1 and 2 start at once. Task 3 after 1.
- **Task 3 does not depend on Task 2.** The `CableHost` interface lives in `cableSession.ts`; Task 3 adds `signal?` there, and `DaemonCableHost` conforms with or without it (a method with fewer parameters is assignable). Task 3's tests use fake hosts that capture the signal. The feature needs both before Verification, not before Task 3.
- Tasks 1 and 3 share `voiceLevel.ts` and its spec; the dependency already orders them.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/voiceSegments.ts`, `voiceLevel.ts`, `cableSession.ts`, `cableHost.ts` | **Devices service process** | their specs (PR CI `cli-tests`, Linux; locally on this Mac) |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/services/`, `cli/src/architecture.coreFiles.txt`, `cli/e2e/`, `backend/`, `devices/` (firmware), `cli/src/cable/cableFleet.ts`, `cli/src/cable/cableFleet.spec.ts`.

## Global Constraints

- **Rate:** `R = Math.floor(Math.min(48_000, Math.max(8_000, sr)))` for cutting only; the transcriber is still handed the turn's own `rate`, as today. A segment is `60 × R` samples; a frame is `Math.floor(R / 50)` samples.
- **Cut:** once pending holds `≥ 60 × R` samples, the cut is at the start of the frame with the lowest sum of squares among frames `k` (start `k × frame` samples from the pending start) with `k × frame ≥ 55 × R` and `(k + 1) × frame ≤ 60 × R`; on a tie the latest. The rest stays pending.
- **Uploads:** one in flight per recording, in order. `ATTEMPT_TIMEOUT_MS = 120_000` through the injected timer and an `AbortController`, raced against the transcriber's promise; a timeout fails with `Voice upload timed out. Try again`. One retry, at once, at the head of the queue, only for a first attempt that fails before `finish()` and was not aborted. A failure not retried stops all uploads of the recording.
- **Join:** each transcript trimmed, empty ones dropped, joined with `' '`, or `''` when `lang === 'ja'` (the backend's languages are exactly `en`, `vi`, `es`, `fr`, `ja`, `it`).
- **At most 12 segments** for a recording under `VOICE_MAX_BYTES` at 16 kHz (unchanged: `(10 * 60 + 15) * 32_000`).
- **Log:** one new line per turn that reaches `finish()`, numbers only: `cable: voice segments=<n> early=<n> retries=<n> tail=<ms>ms`. The `cable: voice <s>s (<KB> KB) → stt` and `cable: voice turn …` lines stay as they are. No audio, words, token or error message in any line (`cli/src/architecture.failureLogs.spec.ts` stays green).
- **Cost, named in the PR:** a recording over 60 s that is cancelled or refused at Done has spent the voice seconds of its segments already uploaded; each segment is one request against the backend's 10 clips a minute.
- **Never the person's own:** no test or check runs Diego's daemon (port 18473), dial, terminals, apps, `~/.claude` or `~/.codex`, any real backend or account, or production.
- **Repo rules:** test first at the layer where the behavior lives; no fixed sleeps in tests; comments say why; no dead code (a replaced function goes in the same branch).

## Review Focus

1. **A long recording of silence.** Every segment comes back empty. Expected: `finish()` resolves `''` and the dial says `Didn't catch that`, as for a short silent one. Task 1, `drops empty transcripts…` (all three empty → `''`).
2. **A transcriber that ignores the signal** (the access token is awaited before `fetch`) and resolves after `abort()` or after its timeout. Expected: its late answer is never used, `finish()` has already rejected, and nothing more is sent. Task 1, `abort()…` and `a timed-out attempt…` cases.
3. **Done arriving while a retry is queued.** Expected: the retry still runs (it was decided before `finish()`), the tail waits behind it, and `finish()` resolves with every segment in order. Task 1, `a retry queued before finish() still runs…`.
4. **A stuck dial past the byte cap.** Its first ten segments were uploaded while it streamed; the over-cap chunk aborts the rest. Expected: `Didn't catch that`, the cap logged once, no upload after the drop. Task 3, the rewritten 615 s test.
5. **A dial at 8 kHz or 48 kHz.** Expected: segments of 60 s of its own audio, never a cut inside a sample. Task 1, the rate cases (8 kHz, 48 kHz, `sr` 1 and 96,000).

## Decided (the PM, 2026-11-20)

Daemon only; ~60 s segments cut at the quietest 20 ms frame in `[55 s, 60 s)` as the spec defines; one upload in flight; one retry only for a segment failing before `finish()`; 120 s per attempt through an injected timer; a cancelled long recording still spends quota for the segments already sent (named in the PR); at most 12 requests for a 10-minute recording; the new log line carries only `segments`, `early`, `retries`, `tail`.

Answers to the plan's questions (the PM, 2026-11-20):
- `VoiceSegments` reads no time: its constructor takes the rate, the language, the transcriber and the timer only. The session times `tail` with `performance.now()`.
- A turn known at `voice.begin` to fail at Done keeps no audio and uploads nothing: a carry that is not `ok`, a draft or question turn without a pin, a search or form turn with no command, and a selection turn with no agent or a host without `selectPassage` (Task 3).
- The loopback timing check runs on this Mac with a script in the session scratchpad, never committed, and no temporary workflow; its numbers go in the PR body (Verification, check 1).

## Decided here, where the spec was silent

- **The level is an accumulator.** `voiceLevel.ts` gains `class VoiceLevel` (`add`, `read`); `VoiceSegments` adds each segment as it is cut and the tail at `finish()`. Every cut segment has an even length and only the tail may end in half a sample, so the result equals the old `voiceLevel()` over the whole recording. The `voiceLevel()` function goes in Task 3, once its one caller is gone.
- **Pending audio is a list of chunks and a byte count**, concatenated once per cut, not once per chunk (8 KB chunks against a 1.92 MB segment would copy about 230 MB a minute). The remainder after a cut is copied (`Buffer.from`) so the segment's buffer is freed once its upload settles.
- **`segments`** counts segments whose first attempt started; **`early`** those started before `finish()`; **`retries`** retry attempts started.
- **After a failure that stops the uploads, after `abort()` and after `finish()`**, `push()` keeps nothing. `abort()` after `finish()` has settled does nothing (so `finishVoice` can abort in a `finally` on every path). `finish()` with nothing pushed resolves `''`.
- **The timeout's timer is unref'd** in the real timer, so a pending upload never holds the process open.
- **The abort error** is a `DOMException` named `AbortError` with message `Voice recording cancelled`; the session's generation check drops any reply it would cause, so the dial never sees it.
- **The new log line** is written once `finish()` settles, resolved or rejected, before any reply; `tail` is `Math.round(performance.now() − <voice.end's arrival>)`.

---

### Task 1: `VoiceSegments`: cut, upload one at a time, join

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (a queue, retries, timeouts and aborts racing a transcriber that may ignore its signal).

**Red tests:** `cli/src/cable/voiceSegments.spec.ts` (new), `cli/src/cable/voiceLevel.spec.ts`.

**Files:**
- Create: `cli/src/cable/voiceSegments.ts`, `cli/src/cable/voiceSegments.spec.ts`
- Modify: `cli/src/cable/voiceLevel.ts` (add `VoiceLevel`; `voiceLevel()` stays until Task 3), `cli/src/cable/voiceLevel.spec.ts`

**Interfaces (Produces, for Task 3):**

```ts
// voiceLevel.ts
export class VoiceLevel {
  /** 16-bit LE mono; whole samples, but the last call may end in half a sample, which is ignored. */
  add(pcm: Buffer): void
  read(): { peak: number; rms: number }   // as voiceLevel(): rms = Math.round(Math.sqrt(squares / samples)), 0/0 when empty
}

// voiceSegments.ts
export const ATTEMPT_TIMEOUT_MS = 120_000
export type SegmentTranscriber = (pcm: Buffer, signal: AbortSignal) => Promise<string>
export interface SegmentTimer { set(fire: () => void, ms: number): unknown; clear(handle: unknown): void }
/** setTimeout (unref'd) and clearTimeout, read at call time. */
export const realTimer: SegmentTimer
export interface SegmentCounts { segments: number; early: number; retries: number }
export class VoiceSegments {
  constructor(options: { rate: number; lang: string; transcribe: SegmentTranscriber; timer: SegmentTimer })
  push(chunk: Buffer): void
  finish(): Promise<string>   // called once
  abort(): void
  level(): { peak: number; rms: number }   // complete once finish() has been called
  counts(): SegmentCounts
}
```

The class comment says why it exists: the dial waits 65 s after Done, and a 10-minute WAV is 19.2 MB.

- [ ] **Step 1: Write the failing tests.** Helpers in the spec: `tone(seconds, rate, amplitude)` (every sample `amplitude`), `frameAt(pcm, sample, frameSamples, amplitude)` (overwrites one frame at a sample offset), a `deferred` transcriber (`vi.fn` returning promises the test settles, recording `pcm.length` and `signal`), and a fake `SegmentTimer` (`set` records `{ fire, ms }`, `clear` removes it, `fire()` runs the pending ones). `const flush = () => new Promise(r => setImmediate(r))`.
  - `voiceLevel.spec.ts`, new `describe('VoiceLevel')`: the three existing cases through `new VoiceLevel()` with one `add`; and `add(pcm(3, -4))` then `add(pcm(100))` reads the same as one `add(pcm(3, -4, 100))`.
  - `cuts at the quietest 20 ms frame in [55 s, 60 s)`: 16 kHz, 60 s of `tone(…, 1000)`, amplitude 10 at frame 2,800 (sample 896,000), and zeros at frame 2,749 (samples 879,680 to 880,000, wholly before 55 s, so outside the window though quieter): one `push`; the transcriber is called once with `1_792_000` bytes; after `finish()`, once more with the `128_000`-byte rest.
  - `takes the latest of equally quiet frames`: zeros at frames 2,800 and 2,900 of a 60 s tone → first segment `1_856_000` bytes; a constant tone with no quiet frame → `1_919_360` bytes (frame 2,999).
  - `cuts the same whatever the chunk sizes, never inside a sample`: the same 130 s pushed once and pushed as alternating chunks of 7,999 and 1 bytes hand the transcriber the same segments (`equals`), every segment but the last of even length, their concatenation equal to the input.
  - `holds the rate to 8,000…48,000 and floors it`: `rate: 1` and 70 s at 8 kHz (1,120,000 bytes) → first segment `959_680` bytes; `rate: 96_000` and `rate: 48_000.7` each with 61 s at 48 kHz (5,856,000 bytes) → first segment `5_758_080` bytes (frame 960, last start 2,879,040 samples).
  - `makes at most 12 segments under the byte cap`: 615 s of tone at 16 kHz with a zero frame at every multiple of 55 s (sample 880,000 × n), each pushed in 8,000-byte chunks and every call resolved at once → 12 transcriber calls by the end of `finish()`, the first eleven `1_760_000` bytes, all summing to `19_680_000`.
  - `keeps one upload in flight and the order`: 130 s pushed; one call until the first is resolved, then the second; `finish()` adds the third; answers `'one'`, `'two'`, `'three'` → `'one two three'`; `counts()` is `{ segments: 3, early: 2, retries: 0 }`.
  - `drops empty transcripts and joins with a space, or nothing for ja`: answers `[' one ', '', 'two']` → `'one two'`; `lang: 'ja'`, `['こんにちは', '世界']` → `'こんにちは世界'`; all three `''` → `''`.
  - `a recording under 60 s is one request at finish()`: 59 s pushed → no call; `finish()` → one call with all 1,888,000 bytes; `counts()` `{ segments: 1, early: 0, retries: 0 }`.
  - `a failure before finish() is retried once, at once; a second stops the recording`: 130 s of tone pushed in 8,000-byte chunks with a `flush()` after each; segment 0 rejects `Error('Voice service unavailable')` then resolves `'one'`; segment 1 rejects twice; then 70 s more pushed: no further call; `finish()` rejects with `'Voice service unavailable'`; calls total 4; `counts().retries` is 2.
  - `a retry queued before finish() still runs, and the tail waits behind it`: segment 0's first attempt rejects, `finish()` is called before the retry settles, the retry resolves `'one'`, the tail `'two'` → `'one two'`.
  - `a failure after finish() is not retried`: 59 s, `finish()`, the one call rejects → `finish()` rejects with its message, one call.
  - `a timed-out attempt fails with its message, and its late answer is ignored`: 59 s, `finish()`; the fake timer holds one entry with `ms === 120_000`; `fire()` → the captured signal is aborted, `finish()` rejects with `'Voice upload timed out. Try again'`; the transcriber's promise resolving afterwards changes nothing. Before `finish()`, a timed-out first attempt is retried (one more call).
  - `abort() aborts the attempt in flight and sends nothing more`: 61 s pushed (one call in flight), `abort()` → its signal is aborted; 70 s more pushed → no call; `finish()` rejects with `name === 'AbortError'`. Again with `finish()` already waiting when `abort()` is called: it rejects the same. The transcriber resolving late changes nothing. `abort()` after `finish()` resolved: no throw, and the resolved value stands.
  - `leaves no rejection unhandled`: with `process.on('unhandledRejection', spy)` for the test's length (removed in `finally`), a failure before `finish()` that stops the uploads, then `abort()` with an attempt in flight whose transcriber later rejects; after `flush()` twice, `spy` was not called.
  - `the level matches the whole recording`: a 130 s recording of varied samples pushed in odd chunks plus a trailing half sample; after `finish()`, `level()` equals `new VoiceLevel()` fed the whole input in one `add`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/voiceSegments.spec.ts src/cable/voiceLevel.spec.ts`. Expected: FAIL (`voiceSegments.js` not found; `VoiceLevel` is not exported). Commit `test(dial): a long recording is cut into segments and uploaded one at a time (red)`.
- [ ] **Step 3: Implement** `VoiceLevel` and `VoiceSegments` as the Interfaces block and Global Constraints say. Each attempt: a new `AbortController`; `timer.set(…, ATTEMPT_TIMEOUT_MS)` that aborts it and rejects the race with `Error('Voice upload timed out. Try again')`; `Promise.race` of that and `transcribe(pcm, controller.signal)`; the timer cleared when either settles; the attempt's own promise always handled inside the class.
- [ ] **Step 4: Run** the same command and `cd cli && npm run typecheck`. Expected: PASS, no type error.
- [ ] **Step 5: Commit** `dial: a long recording is transcribed in segments of about a minute while the person talks`.

### Task 2: `transcribe` takes an abort signal

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/cableVoice.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`DaemonCableHost.transcribe` and its comment only)
- Test: `cli/src/cable/cableVoice.spec.ts`

**Interfaces:**
- Produces: `async transcribe(pcm: Buffer, sampleRate: number, lang: string, signal?: AbortSignal): Promise<string>`; `post` passes `signal` to `fetch` for the first post and the 401 retry. The comment says why: a recording the person cancelled stops uploading.

- [ ] **Step 1: Write the failing tests.**
  - `hands the abort signal to the post and to the 401 retry`: `const c = new AbortController()`; `fetchMock` answers `rejected(401, 'UNAUTHORIZED')` then `ok()`; `transcribe(pcm, 16000, 'en', c.signal)` resolves `'a test sentence'`; both `fetchMock.mock.calls[i]![1]?.signal` are `c.signal`.
  - `an aborted signal rejects the upload`: `fetchMock` returns a promise that rejects with `signal.reason` when its `options.signal` aborts; `c.abort()` after the call → `transcribe` rejects with `name === 'AbortError'`; `fetchMock` called once.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableVoice.spec.ts`. Expected: FAIL (`signal` is `undefined`; the second test times out at vitest's limit or never rejects). Commit `test(dial): a cancelled voice upload stops (red)`.
- [ ] **Step 3: Add** the parameter and pass it in `post`.
- [ ] **Step 4: Run** the same command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a voice upload can be cancelled`.

### Task 3: The session transcribes through the segments

**Layer:** devices service process. **Depends on:** 1. **Effort:** `xhigh` (every path that ends or replaces a recording, while uploads run during it).

**Red test:** `cli/src/cable/cableSession.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts`, `cli/src/cable/voiceLevel.ts` (remove `voiceLevel()`), `cli/src/cable/voiceLevel.spec.ts` (remove its `describe('voiceLevel')`)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `VoiceSegments` (`push`, `finish`, `abort`, `level`, `counts`) and `realTimer` (Task 1).
- `CableHost.transcribe(pcm: Buffer, sampleRate: number, lang: string, signal?: AbortSignal): Promise<string>`; its comment says the signal aborts an upload whose recording ended, and that a host may ignore it.
- `private voiceSegments?: VoiceSegments`, from `voice.begin` until `finishVoice` ends; `private abortVoiceSegments(): void` (aborts the field and clears it).
- The `voice` field loses `chunks`; it keeps `bytes`.

- [ ] **Step 1: Write the failing tests.** A new `describe('a long recording is transcribed while the person talks')`, beside `a long recording and its long transcript`, with its own `record`-style helper `stream(port, bytes, { settleEvery })` that sends PCM in frames of 8,000 bytes of zeros and, when asked, `await settle()` after each frame.
  - `a 130 s recording makes two requests before voice.end and one after, and the dial gets the joined words`: `transcribe` a `vi.fn` answering `'one'`, `'two'`, `'three'` and capturing `(pcm.length, signal)`; `voice.begin` `{ uploadId: 'long', agentId: 'a1', sr: 16000, lang: 'en' }`, 130 × 32,000 bytes with a settle after each frame; before `voice.end`, two calls with `1_919_360` bytes each; after it, a third with `321_280`; every call's fourth argument is an `AbortSignal`; `host.sendTurn` called with `('a1', 'one two three')`; the dial gets `voice.transcript` with `uploadId: 'long'`; the log holds one line matching `/^cable: voice segments=3 early=2 retries=0 tail=\d+ms$/`.
  - `a long recording whose upload fails twice before Done says why at Done, and sends nothing more`: the first call rejects twice with `Error('Voice service unavailable')`; 130 s streamed; `voice.end` → `voice.error` `Voice service unavailable` for its `uploadId`; `transcribe` called twice in all; the log line says `segments=1 early=1 retries=1`.
  - `it.each` over `voice.abort`, a new `voice.begin`, `carry.cancel` and the port closing, `describe.each` over `during the recording` and `after voice.end`: the fake `transcribe` captures its signal; its first call's promise is held and resolved by the test last; later calls answer `'fix the login screen'`.
    - During: 61 s streamed (one call in flight), the trigger; the captured signal is aborted; for `voice.abort` and `carry.cancel`, 70 s more and `voice.end` make no second call.
    - After: 3,200 bytes, `voice.end`, one call in flight, the trigger; the signal is aborted; resolving the fake then sends no `voice.transcript` for that `uploadId` and no `sendTurn`.
    - `voice.abort` names the turn's `uploadId`. `carry.cancel` uses a carry turn set up as in `dropping carried text during transcription prevents later delivery`. The new `voice.begin` is followed by 3,200 bytes and `voice.end`, which answer `voice.transcript` from a second call of 3,200 bytes. The port closing is `port.close()`.
  - `a turn already refused at voice.begin uploads nothing`, an `it.each`: each 61 s streamed with a settle after each frame, then `voice.end`; `transcribe` never called, no `segments=` line, and the dial gets today's `voice.error` for its `uploadId`:
    - a draft turn whose `draftId` names no draft: `That draft changed. Review it again.`;
    - a question turn with no pinned question: `This question changed. Open it again.`;
    - a carry turn with no prepared carry: `Choose the carried text and its recipient again.`;
    - a search turn with no command (`{ searchId: 's1', agentId: 'a1' }`, no `searchRevision`): `Choose a passage before searching.`;
    - a form turn with no command (`{ formId: 'f1' }`, no `formRevision`): `Open a field and say its name again.`;
    - a selection turn with no agent (`{ selectionId: 'p1' }`): `Choose the text again.`;
    - a selection turn on a host without `selectPassage` (`{ selectionId: 'p1', agentId: 'a1' }`, `makeHost()` as it is, which has none): `Choose the text again.`.
  - Rewritten in `a long recording and its long transcript` (the segments change what `handed` sees): the 600/601 s test expects 11 calls a recording whose lengths sum to `600 * SECOND` and `601 * SECOND`; the 615 s test expects 11 calls summing to `615 * SECOND` for `last`; for `stuck`, only the call already in flight when the over-cap chunk arrives (`record` sends without yielding, so the other cut segments were still queued and are dropped): `handed` gains one `1_919_360` and nothing after, the dial gets `Didn't catch that`, and the cap is logged once.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL: no call before `voice.end`, one call of the whole recording after it, no signal, no `segments=` line. `a turn already refused at voice.begin uploads nothing` passes at the base too (today nothing is transcribed for those turns either and nothing is uploaded before `voice.end`): it guards against uploading their segments, and Step 4 shows it bites. Commit `test(dial): a long recording is uploaded while the person talks (red)`.
- [ ] **Step 3: Change** `cableSession.ts`:
  - `voice.begin`: `this.abortVoiceSegments()` first, before anything that can return. Once `this.voice` is set, unless the turn is known to fail at Done (`carry && !carry.ok`, `draft && !draft.pin`, `question && !question.pin`, `search && !search.command`, `form && !form.command`, or `this.voice.selectionId && (!this.voice.agentId || !this.host.selectPassage)`; one named predicate whose comment says why: their audio would be uploaded for an answer the dial never gets), `this.voiceSegments = new VoiceSegments({ rate, lang, transcribe: (pcm, signal) => this.host.transcribe(pcm, rate, lang, signal), timer: realTimer })` with the `voice` field's own `rate` and `lang`.
  - `voice.abort`, `carry.cancel` (for the turn's carry) and `onClosed`: `this.abortVoiceSegments()` where each moves `voiceGeneration` on.
  - `onPcm`: counts `bytes` as today; over the cap, also `abortVoiceSegments()`; else `this.voiceSegments?.push(chunk)`.
  - `finishVoice`: takes `const segments = this.voiceSegments` and the arrival time at its start; the body runs in `try`, and `finally` does `segments?.abort()` and clears the field only if it still holds `segments`. `!turn || turn.bytes === 0 || !segments` says `Didn't catch that`. `segments.finish()` replaces `Buffer.concat` and `host.transcribe`; `peak` and `rms` come from `segments.level()`, read right after `finish()` is called; the `segments=` line is logged once `finish()` settles, either way. Everything after the transcript is unchanged.
  - Remove `voiceLevel()` from `voiceLevel.ts` and its `describe` from `voiceLevel.spec.ts`; the file's comment stays with `VoiceLevel`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable src/architecture.spec.ts src/architecture.failureLogs.spec.ts` and `cd cli && npm run typecheck`. Expected: PASS, `cableFleet.spec.ts` and `cableVoice.spec.ts` included, no type error; `grep -rn "voiceLevel(" cli/src` prints nothing. Then, not committed: make the predicate always false and run `npx vitest run src/cable/cableSession.spec.ts -t "a turn already refused at voice.begin uploads nothing"`; expected: all seven cases FAIL (`transcribe` called before `voice.end`). Restore it (`git diff` shows only the task's change) and say so in the report.
- [ ] **Step 5: Commit** `dial: a long recording is uploaded while the person talks, so Done waits for a minute of audio at most`.

## Verification

**Platforms the pull request names:** the CLI on macOS, Linux and Windows; no platform-specific code. Tested: the unit specs on this Mac and on Linux in PR CI; check 1 and check 3 on this Mac. Windows: named in the PR as platform-neutral code not run on a Windows machine.

**Never touched by a tester or a check:** Diego's daemon (port 18473), dial, terminals and apps; any real backend, account or production. No test account is needed: every backend here is a local stand-in.

**Temporary workflow:** none. The PM decided (2026-11-20) that check 1 runs on this Mac from a scratchpad script. `cli-e2e.yml` is not needed (check 3).

**Required local gates**, on this Mac at the final head, recorded in the pull request:
- `cd cli && npm run typecheck && npx vitest run src/cable src/architecture.spec.ts src/architecture.failureLogs.spec.ts`.
- `npm run test:core` **does not apply**: it covers `src/core/` and `src/services/` at 100% per file, and no file there changes (`git diff --stat <base> -- cli/src/core cli/src/services` prints nothing); no spec under them drives a voice turn. Not run; the PR says why.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipt goes in the pull request's body before the tested commit is pushed.
- `git diff --stat <base> -- cli/src/core cli/src/services cli/src/architecture.coreFiles.txt backend devices` prints nothing.

**1. Loopback: the wait after Done for a 10-minute recording, before and after** (the PM, 2026-11-20)
- Where: this Mac, Node of `cli/`, at the base and at the final head. No device, sign-in or account; a stand-in backend on loopback. No temporary workflow: the script lives in the session scratchpad and is never committed.
- The script, `<scratchpad>/long-voice-loopback.ts`, written by the tester. Arguments: the `cli/` root to load, `--speed <x>` (how many times faster than real time the dial streams; default 1) and `--mbps <n>` (the stand-in's read rate; default 1).
  1. Sets `HOME`, `USERPROFILE`, `ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR`, `HARNESS_AUTH_DIR` to fresh folders under the scratchpad, starts the stand-in, sets `BACKEND_WS_URL=ws://127.0.0.1:<its port>`, then dynamic-imports `<root>/src/cable/cableSession.ts`, `cableHost.ts`, `cableFrame.ts`, `dialLog.ts`.
  2. **The stand-in backend:** `node:http` on `127.0.0.1:0`. `POST /api/voice/stt` reads the body at no more than `mbps × 125,000` bytes a second (on each `data` chunk, if the bytes read so far are ahead of `elapsed × mbps × 125,000`, `req.pause()`, and `resume()` when they are due), then answers `{ success: true, data: { transcript: 'part<n>' } }`, `n` counting requests from 1. Anything else is 404.
  3. **The host:** `new DaemonCableHost({ log, accessToken: async () => 'loopback-token', signedIn: () => true, environment: () => 'local', sessions: () => [], displayName: () => '' })` as `cableVoice.spec.ts`'s `setup()` builds it, and a `CableHost` in the shape of `cableSession.spec.ts`'s `makeHost` whose `transcribe` calls that host's real `transcribe` with every argument it is given, `sendTurn: async () => ({ ok: true })`, `log` printing `cable:` lines.
  4. **The dial:** a port in the shape of `LoopbackPort` handed to `new CableSession(host, new DialLog(<scratch>), opener)`. It says `hello`, a `pong` every 5 s of real time whatever the speed (the session reopens a port silent for 20 s), `voice.begin` `{ uploadId: 'loop', agentId: 'a1', sr: 16000, lang: 'en' }`, then 600 s of PCM in 8,000-byte frames, one due every `250 / speed` ms (each frame's due time from the start, not a fixed interval), speech-like and deterministic: a 200 Hz tone at amplitude 8,000 for 1.7 s, then 0.3 s at amplitude 50, repeated. Then `voice.end`, and the time to the first `voice.transcript` or `voice.error` with `uploadId: 'loop'`.
  5. Prints one JSON line: `{ tree: 'base' | 'head', speed, mbps, answer, tailMs, requests, node: process.version }`, and `sysctl -n hw.model`.
- The base tree: `git worktree add --detach <scratchpad>/base <base>`; `git diff --quiet <base> HEAD -- cli/package-lock.json` must pass, then `ln -s <worktree>/cli/node_modules <scratchpad>/base/cli/node_modules`. Removed after with `git worktree remove <scratchpad>/base`.
- Runs, from each `cli/` root as `cd <root> && node --import tsx <scratchpad>/long-voice-loopback.ts <root> --speed <x> --mbps <n>`:
  1. **Sped up, base:** `--speed 10 --mbps 10` (the dial's 32,000 bytes a second against the uplink in the same ratio as at 1 Mbps). About 3 minutes.
  2. **Sped up, head:** the same arguments. About 3 minutes. Runs 1 and 2 one after the other, never at once.
  3. **Real time, head:** `--speed 1 --mbps 1`, in the background, after run 2. About 12 minutes. The base is not run in real time: run 1 gives its number at a tenth of the scale.
- A person sees:
  - **Run 1 (base):** one request; `answer` `voice.transcript`; `tailMs` about 15,400 (19.2 MB at 10 Mbps), past 6,500 (the dial's 65 s at a tenth of the scale).
  - **Run 2 (head):** at most 12 requests (11 expected); `answer` `voice.transcript`, with `part1 … partN` joined in order through `sendTurn`; `tailMs` under 6,500 (expected about 1,000 to 3,200); one `cable: voice segments=<n> early=<n−1> retries=0 tail=<ms>ms` line.
  - **Run 3 (head, real time):** as run 2, with `tailMs` under 65,000 (expected about 10,000 to 32,000: what is left of one segment of at most 1.92 MB in flight, and the tail).
- The three JSON lines, the `segments=` lines and the Mac's model go in the PR body. A run that did not finish is reported as not verified.

**2. In PR CI, by itself:** `cli-typecheck`, `cli-tests` (and whatever else a `cli/src/cable` change selects), `process-checks`. Nothing started by hand.

**3. End to end: `cli/e2e/deviceWithoutApp.e2e.ts`, once, on this Mac at the final head.** It is the one suite that speaks to a dial through the real daemon, the real `DaemonCableHost.transcribe` and a real `fetch` (to `FakeBackend`), so it shows the signal does not break a short turn's upload in the bundle. Its recordings are under 60 s, so each is one request at Done, as today.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts --reporter=default`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`): a throwaway home, data folder and port, a private tmux server, a fake dial on a pseudo-terminal, `FakeBackend` on loopback, the suite's fake Claude Code.
- A person sees: every test of the file pass, none skipped. Skipped or not run: reported as not verified.
- `cli-e2e.yml` (Actions → CLI end to end) is not needed: no other e2e file reaches code this branch changes in a way the unit specs do not cover, and it needs the PM's go.

**4. Diego's own check, after a CLI release he decides on** (his dial, his account, his eye; no tester or agent runs it): a five-minute recording on a slow network reaches the agent whole. Not a merge gate.

**5. Against production:** none.

