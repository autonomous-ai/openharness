# Dial voice: how long 2, 5 and 10 minutes take after Done

For the pull request of [the ten-minutes plan](2026-11-19-dial-voice-ten-minutes-plan.md) (Task 7). Every number is
marked **measured** (run on this Mac) or **estimated** (worked out, or taken from Deepgram's published figures).

The dial streams its 16 kHz, 16-bit mono PCM to the daemon while the person speaks, so at Done the daemon holds the
whole recording. From Done the dial waits 65 s for the daemon's reply (`REPLY_WAIT_MS` in
`devices/harness-pro/firmware/main/audio/pro_voice.c`, `voice_wait_until` in
`devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`). In that window: the daemon wraps and uploads the
audio, the backend transcribes it, and the host delivers the text to the agent.

## 1. Sizes (measured)

WAV = 44 + 32,000 × seconds bytes. The multipart body around it adds 142-144 bytes (the boundary's length varies).

| Recording | WAV bytes | Upload body bytes |
|---|---|---|
| 2 min (120 s) | 3,840,044 | 3,840,188 |
| 5 min (300 s) | 9,600,044 | 9,600,188 |
| 10 min (600 s) | 19,200,044 | 19,200,188 |

## 2. The daemon's share (measured)

`DaemonCableHost.transcribe(pcm, 16_000, 'en')` against a `node:http` stub on `127.0.0.1` that reads the whole body
and answers an empty transcript: building the WAV and the multipart, and the loopback upload. Three runs of five rounds
each, after one warm-up. Node v22.23.5, MacBook Pro (MacBookPro18,1, Apple M1 Pro). Throwaway home and data folders, no
account, no network but loopback.

| Recording | Median per run (ms) | Largest per run (ms) |
|---|---|---|
| 2 min | 6.8, 6.8, 7.1 | 10.3, 17.5, 9.1 |
| 5 min | 11.8, 26.1, 21.4 | 12.0, 28.7, 25.0 |
| 10 min | 15.6, 21.9, 25.9 | 19.7, 42.5, 32.9 |

The daemon's share is under 50 ms even for 10 minutes: nothing to gain there.

## 3. Upload to the backend (estimated)

Body bytes × 8 / uplink rate, ignoring TLS and TCP ramp-up (which only add).

| Recording | 1 Mbps | 3 Mbps | 10 Mbps | 50 Mbps |
|---|---|---|---|---|
| 2 min | 30.7 s | 10.2 s | 3.1 s | 0.6 s |
| 5 min | 76.8 s | 25.6 s | 7.7 s | 1.5 s |
| 10 min | 153.6 s | 51.2 s | 15.4 s | 3.1 s |

The person's uplink dominates the whole wait.

## 4. The backend's share (estimated)

`backend/src/routes/voice.ts` takes the whole upload first (`file.toBuffer()`, 25 MB cap), checks it is PCM WAV,
reserves the clip's seconds, then makes one call to Deepgram (`backend/src/lib/deepgramWav.ts`: nova-3 for English,
nova-2 for Vietnamese) under `AbortSignal.timeout(STT_TIMEOUT_MS)`. Store and forward: the backend-to-Deepgram
transfer starts only after the person's upload ends.

Deepgram's published figures, read 2026-11-19:

- "Transcribe in real-time, or an hour of pre-recorded audio in <12 seconds."
  ([deepgram.com/the-top-rated-speech-to-text-api](https://deepgram.com/the-top-rated-speech-to-text-api)). A
  marketing claim with no method given.
- A pre-recorded file is ready "often after only a few seconds"; "Requests exceeding 10 minutes (Nova/Base/Enhanced)
  or 20 minutes (Whisper) return a 504: Gateway Timeout error" (processing time, not audio length)
  ([developers.deepgram.com/docs/pre-recorded-audio](https://developers.deepgram.com/docs/pre-recorded-audio)).

| Recording | Deepgram processing (scaled from <12 s an hour) | Backend to Deepgram at 100 Mbps / 20 Mbps | Planning figure, with a few seconds of request overhead |
|---|---|---|---|
| 2 min | < 0.4 s | 0.3 s / 1.5 s | 4 s |
| 5 min | < 1 s | 0.8 s / 3.8 s | 5 s |
| 10 min | < 2 s | 1.5 s / 7.7 s | 7 s |

The backend's own egress rate is not known here; 100 and 20 Mbps bracket a data-centre link.

## 5. `STT_TIMEOUT_MS = 60_000` (estimated)

The 60 s covers the backend's transfer of 19.2 MB to Deepgram and Deepgram's processing. At the figures above,
10 minutes needs about 4-10 s: it fits with about 50 s to spare. It fails only if the backend's egress to Deepgram
falls below about 2.7 Mbps (153.6 Mbit in 58 s), or Deepgram runs far slower than it publishes (its own ceiling is
10 minutes of processing).

If it fails: the fetch aborts, the route hands the reserved seconds back (`voiceQuotaService.release`) and answers
502 `STT_FAILED`; the daemon tells the dial "Voice service unavailable. Try again"; the recording's words are lost;
nothing retries. The timeout is not changed here.

## 6. The dial's 65 s after Done (estimated)

65 s = daemon (under 0.05 s) + upload (section 3) + backend (section 4) + delivery. Delivery: up to 10 s for Orca
(`--wait-submit 5` inside a 10 s run) and `codex queue` (10 s); up to 5 s for Claude Code's mod, whose inbox waits
for its next poll.

| Recording | Upload budget, Orca or Codex | Missed below | Upload budget, the mod | Missed below |
|---|---|---|---|---|
| 2 min | 51 s | 0.6 Mbps | 56 s | 0.55 Mbps |
| 5 min | 50 s | 1.5 Mbps | 55 s | 1.4 Mbps |
| 10 min | 48 s | 3.2 Mbps | 53 s | 2.9 Mbps |

Past 65 s the dial stops waiting and the words are dropped, even if the transcript arrives later.

## 7. Follow-up proposal for the PM

Either:

- **The firmware waits in proportion to the recording's length** (both dials): for example 65 s plus a second for every
  ten seconds recorded. Firmware only; the daemon and backend stay as they are.
- **The daemon compresses the audio before upload.** A speech codec cuts 19.2 MB to well under 2 MB, which brings a
  10-minute recording within the 65 s on a 1 Mbps uplink. It also needs the backend: it takes only PCM WAV today,
  because it counts a clip's seconds for the daily quota from its PCM length, and refuses anything else with
  `UNSUPPORTED_AUDIO` (415).

## 8. Unverified (named in the pull request)

- The real Claude Code's `$.prompt.submit` with 20,000 characters.
- herdr's and Herdr Core's line limits.
- Whether Orca (`--wait-submit 5` in a 10 s run) and `codex queue` (10 s) take 20,000 characters in time.
- Windows: a command line is limited to 32,767 characters. An argument of 20,000 characters made almost wholly of
  quotes, once escaped, is refused by the spawn and the dial says the agent did not answer; the text is never cut.
