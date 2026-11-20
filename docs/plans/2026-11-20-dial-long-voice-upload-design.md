# Dial voice: a long recording is not lost on a slow uplink

## Problem

Since #4495 the dial records up to 10 minutes. After the person taps Done (or the dial stops at 600 s), both firmwares
wait 65 s for the daemon's answer (`ui_habitat.c` `voice_wait_until`, `pro_voice.c` `REPLY_WAIT_MS`), then give up and
the words are lost. In that window the daemon posts the whole recording to `/api/voice/stt` as one WAV
(`cableHost.ts` `transcribe`, called from `cableSession.ts` `finishVoice`): 16 kHz mono 16-bit is 32,000 bytes a second,
19.2 MB for 10 minutes. Deepgram and the backend take a few seconds; the upload is the rest. A 10-minute recording
misses the window below about 3 Mbps uplink (5 minutes: about 1.5 Mbps; 2 minutes: about 0.6 Mbps;
`docs/plans/2026-11-19-dial-voice-ten-minutes-timing.md`).

## What the code shows

- Both dials stream the PCM over the cable while the person talks (`audio_client_habitat.c` `send_audio`,
  `pro_recorder.c` `pro_cable_voice_pcm`). The daemon receives it chunk by chunk (`cableSession.ts` `onPcm`) and holds
  it until `voice.end`.
- No frame either firmware understands moves its 65 s deadline: it is set only at Done and at the 600 s cap.
- The backend takes PCM WAV only (`wavDurationMs`, else 415) and charges the clip's length from its bytes, so a
  compressed upload needs a backend change and release; FLAC would only halve the bytes.
- The transcriber runs in the devices process (`cli/src/cable`); the core only lends the sign-in token.

## Design

The daemon transcribes a long recording in segments of about 60 s **while the person is still talking**, so at Done
only the last segment is left to upload. Daemon only: no backend, firmware or core change.

### `VoiceSegments` (`cli/src/cable/voiceSegments.ts`)

One per recording. Fed the PCM chunks; gives back the whole transcript. Its constructor takes the rate, the language,
the transcriber `(pcm, signal) => Promise<string>` and a timer (injected, so tests use fake timers). It reads no clock: the session times the wait after Done.

**Cutting.**
- `R` is the turn's rate clamped to `[8000, 48000]` and floored to an integer (the backend's accepted WAV range;
  it bounds the segment count whatever rate the dial states). A segment is `60 × R` samples; a frame is
  `floor(R / 50)` samples (20 ms).
- `push(chunk)` appends to the pending bytes. While the pending bytes hold at least `60 × R` samples, it cuts one
  segment: of the frames that lie wholly inside samples `[55 × R, 60 × R)` of the pending audio, counted from its start
  in steps of one frame, it takes the one with the lowest sum of squares (on a tie, the latest), and cuts at that
  frame's start. The cut is a whole number of samples, so every segment but the last has an even length. The audio
  after the cut stays pending.
- Under the byte cap (`VOICE_MAX_BYTES`, 615 s at 16 kHz) a recording makes at most 12 segments (11 cuts of at least
  55 s and a tail).

**Uploading.**
- One upload in flight per recording, in order; each transcript is kept by index. A segment cut while one is in
  flight waits in the queue. Below the 256 kbps that keeps up with live speech the queue grows, bounded by the byte
  cap.
- Each attempt has a timeout of 120 s, made with the injected timer and an `AbortController` (not
  `AbortSignal.timeout`, which fake timers do not reach), and raced against the transcriber's promise, since the
  transcriber may ignore the signal (the access token is awaited before `fetch`). A timeout fails the attempt with the
  message `Voice upload timed out. Try again`.
- A segment whose first attempt fails **before `finish()`** is retried once, at once, at the head of the queue, for
  any failure but an abort. After `finish()` no attempt is retried, so a recording under 60 s makes exactly one
  request after Done, as today. A failure that is not retried stops the recording's uploads: nothing more is sent.
- No promise it makes is left without a handler: failures are held internally until `finish()` reads them.

**Finishing.**
- `finish()` (called once) makes the pending audio, when it holds any byte, the last segment; waits for every
  segment; and resolves with their transcripts, each trimmed, empty ones dropped, joined with one space, or with no
  separator for `ja`. If an upload failed it rejects with that failure's message, which the dial shows as today.
- A recording that never reaches 60 s is one segment uploaded at `finish()`.
- `abort()` aborts the attempt in flight (its signal), drops the queue and the pending audio, and sends nothing more.
  A `finish()` already waiting, or called after, rejects with an `AbortError`; the session's generation check already
  drops its reply.
- A segment's PCM is released once it is transcribed, so a long recording holds less memory than today.

**Counts**, for the log line: `segments` (how many were uploaded), `early` (how many started uploading before
`finish()`), `retries`.

### `CableHost.transcribe`

Gains an optional last parameter `signal?: AbortSignal`, passed to `fetch` for both the first post and the 401 retry.
Test fakes may ignore it.

### `cableSession.ts`

- The session keeps the current recording's segments in its own field (`voiceSegments`) from `voice.begin` until
  `finishVoice` ends, not only on `this.voice`, which `finishVoice` clears at once. Every place the voice generation
  moves on aborts that field first: the port closing (around line 1263), `carry.cancel` of the turn's carry (1743),
  `voice.begin` at the top of its case, before its refusal path returns (1853), and `voice.abort` (1961).
- `onPcm` counts `turn.bytes` as today and pushes the chunk to the segments; over `VOICE_MAX_BYTES` it aborts them and
  drops the turn, as today.
- A turn already known at `voice.begin` to fail at Done keeps no audio and uploads nothing: a carry that is not `ok`, a
  draft turn without a pin, a question turn without a pin, a search or form turn whose request is invalid at
  `voice.begin` (no command), or a selection turn with no agent or no passage support (PM, 2026-11-20). A turn refused
  because its agent lacks `v` keeps none, as today.
- `finishVoice` awaits `segments.finish()` where it called `host.transcribe(Buffer.concat(...))`. Every path out of
  `finishVoice` that does not use the transcript (a pin, draft, question, carry or selection failure, an empty turn,
  and each `!current()` return) aborts the segments, in a `finally`. Everything after the transcript (search, form,
  draft, question, routing, delivery, `voice.transcript`) is unchanged.
- The existing lines stay (`cable: voice <s>s (<KB> KB) → stt`, the `voice turn` line with `peak`, `rms` and the
  transcript's length). `peak` and `rms` come from the segments' running level, which matches `voiceLevel` over the
  whole recording. One line is added for each turn that reaches `finish()`, numbers only:
  `cable: voice segments=<n> early=<n> retries=<n> tail=<ms>ms`, where `tail` is the time from `voice.end`'s arrival
  to `finish()` settling, pin waits included: what the person waits.

### Every purpose

Segments apply to every recording that keeps audio: dictation, search, form, draft, question, carry and selection
turns all transcribe through `finish()`. Their pins are still checked at Done, before the transcript is used.

### Cost (PM, 2026-11-20)

A recording over 60 s that is cancelled (Cancel on the dial, a new recording, unplugging) or refused at Done has
already spent the daily voice seconds of the segments uploaded before it. Today a cancelled recording costs nothing.
Accepted; the PR names it. Each segment is one request against the backend's 10 clips a minute per account: a
10-minute recording makes at most 12 requests over 10 minutes, plus a retry each.

## Effect (estimated; measured on loopback in the plan's checks)

At Done the daemon has at most one segment in flight and the pending tail, at most 60 s of audio (1.92 MB) each.

| Recording | Uplink needed today | Uplink needed after |
|---|---|---|
| 2 minutes | about 0.6 Mbps | about 0.5 Mbps |
| 5 minutes | about 1.5 Mbps | about 0.5 Mbps |
| 10 minutes | about 3 Mbps | about 0.5 Mbps |

"After" assumes the worst case at Done: one 60 s segment just started and a 60 s tail, 3.84 MB in about 60 s.

## Data

Nothing new is stored, synced or exposed. The same audio goes to the same endpoint under the same account, in pieces;
the daemon holds it in memory only until each piece is transcribed. Logs carry counts and times only, never audio or
words (#4458, #4488).

## Not in this branch

- Firmware that waits in proportion to the recording's length, or a frame that extends the wait (PM: a separate
  follow-up).
- Compressed upload (needs the backend).

## Testing

- `voiceSegments.spec.ts`, red first: the cut lands on the quietest frame in `[55 s, 60 s)`, the latest on a tie;
  odd-length chunks and a sample split across two chunks; a rate of 1 is held to 8000; one upload in flight and order
  kept; the join (space, and none for `ja`); a recording under 60 s is one request at `finish()`; a failure before
  `finish()` is retried once and then `finish()` rejects and nothing more is sent; a failure after `finish()` is not
  retried; a timeout (fake timers) fails the attempt with its message; `abort()` aborts the signal, sends nothing more
  and `finish()` rejects; no unhandled rejection after `abort()` or a failure before `finish()`; the level matches
  `voiceLevel` over the whole recording.
- `cableSession.spec.ts`: a 130 s recording streamed in chunks, with a fake `transcribe` that settles between chunks,
  makes two requests before `voice.end` and one after, and the dial gets `voice.transcript` with the joined words.
  `voice.abort`, a new `voice.begin`, `carry.cancel` and the port closing abort the request in flight, both during the
  recording and after `voice.end`; the fake captures the signal. A turn invalid at `voice.begin` uploads nothing.
- `cableVoice.spec.ts`: the signal reaches `fetch` for the first post and the 401 retry, and aborting it rejects the
  upload.
- Loopback: the time from `voice.end` to `voice.transcript` for a 10-minute recording against a local stand-in backend
  whose upload is held to 1 Mbps, before and after.

Platforms: the CLI on macOS, Linux and Windows; no platform-specific code. Tested on macOS and in PR CI on Linux.
