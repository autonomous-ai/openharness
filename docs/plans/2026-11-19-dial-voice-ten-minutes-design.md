# Dial voice: ten minutes of speech reach the agent, and Free gets 30 minutes a day

Date: 2026-11-19. Branch `fix/dial-voice-ten-minutes`. Components: CLI (`cli/`) and backend (`backend/`).

## Why

A customer running Claude Code in VS Code's terminal answered a series of Claude's questions at the dial three times
and got "Too long. Say it shorter." each time. The dial records up to 10 minutes, but every path that delivers the
transcript to an agent outside Harness refuses more than 2,000 characters. Diego (2026-11-19): the only limit should be
the 10-minute recording cap. In the same item he raised the Free plan's daily voice from 10 to 30 minutes.

## Done when

- A transcript of any recording within the 10-minute cap is delivered to the agent outside Harness, on every host path,
  in one piece, and the dial shows it as sent.
- Text over the new cap is still refused with "Too long. Say it shorter." (a stuck dial streaming forever).
- The Free plan allows 30 minutes of voice a day, in every place that names the Free allowance.
- The PM has the answers to the two backend questions below (how production's plans change; how the USB dial is
  charged).

## Part A: CLI, the transcript cap

Characters are UTF-16 units, `text.length`, as every check counts them today.

### What bounds a recording today

- Firmware: both dials stop recording at 600 s (round `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`
  `second >= 600`; Pro `age/1000 >= 600`) and finalize as a tap on Done. No firmware change.
- Daemon: `VOICE_MAX_BYTES = 10 * 60 * 32_000` (`cli/src/cable/cableSession.ts`), exactly 600 s of 16 kHz audio. The
  dial stops on a tick, after 600 s have passed, so a recording that runs to the auto-stop can pass the cap by a tick,
  and the daemon then drops the whole recording (`onPcm`). It becomes `(10 * 60 + 15) * 32_000`: still a bound for a
  stuck dial, with room for the dial's own stop. Tests: 600 s and 600 s + 1 s of audio are transcribed; over the new
  bound is dropped as today.
- STT: 10 minutes of 16 kHz PCM is 19.2 MB, under the backend's 25 MB `MAX_AUDIO_BYTES` (`backend/src/routes/voice.ts`).
  Unchanged.

### The cap

10 minutes of fast speech is about 200 words a minute x 10 x ~6.5 characters, about 13,000 characters. A carried
passage or a window selection rides along with the transcript (`withCarriedPassage`, `withSelectedPassage`): up to
4,096 bytes, each line quoted with `> `, under a one-line header. The cap is **20,000 characters**: 13,000 + a full
passage + margin. Over it, the text is refused as today.

One constant, `MAX_TEXT` in `cli/src/cable/hosts/orca.ts`, already imported by every host path, changes from 2,000 to
20,000, and its comment says what sizes it. Every host path keeps reading it: `observed.ts` (the Claude Code mod,
Codex's queue, Orca, herdr, the Herdr app, cmux), `herdrSource.ts`, `hcSource.ts`, `cmuxSource.ts`,
`opencodeSource.ts`, and their clients (`orca.ts` send, `herdrClient.ts`, `hcClient.ts`, `cmuxApp.ts`,
`opencodeClient.ts`, `codexQueue.ts`).

The core's own bound in `cli/src/core/deviceHookCalls.ts` (`MAX_TEXT = 2000`, the mod's inbox answer) becomes 20,000.
The core imports nothing from `cable/`, so it keeps its own constant, with a comment naming the one it matches. This is
a number in an existing bound, not a new rule, list or record: no core exception is needed (core rule 7). Without it the
mod path drops the text silently: the core answers the poll with `{}` and the inbox counts it taken.

The review draft (`cli/src/cable/voiceDraft.ts`) bounds the whole text by `MAX_BYTES = 16_000` bytes, which refuses
a fast 10-minute English transcript ("Record a shorter message to review."). `MAX_BYTES` goes; `valid()` checks
`text.length <= MAX_TEXT`, imported from `hosts/orca.js`. Its 480-byte parts (what the dial is sent) and its Latin-1
check at Send stay as they are. A passage added at submit is counted by the host's own check, as on the direct path.

### Every write takes the text in one go

| Path | How the text is written | Limit met |
|---|---|---|
| Claude Code mod (any terminal, VS Code's included) | the devices' inbox, the core's poll answer, the mod's `$.prompt.submit` | the core answer cap (above); the mod adds none |
| Codex queue | `codex queue --message=...` argument | Linux 128 KiB per argument, macOS ~1 MB total; 20,000 units are at most ~60 KB |
| Orca | `orca terminal send --text=...` argument | as Codex |
| herdr | one JSON line on herdr's socket | herdr's own limit unknown |
| Herdr app (Herdr Core) | one JSON line on its socket | Herdr Core's own limit unknown |
| cmux | `cmux paste ... -`, the text on stdin | none below 20,000 |
| opencode | HTTP POST to its local server | none below 20,000 |
| VS Code terminal, Terminal, iTerm2, Ghostty, tmux | type nothing: Claude Code there takes the dial's words through its mod | n/a |

So no path chunks. The plan's tests prove each path delivers a 20,000-character text whole to its fake. Not testable
here (no real apps on this Mac), and named in the PR as unverified: the real Claude Code's `$.prompt.submit`,
herdr's and Herdr Core's line limits, and whether Orca (`--wait-submit 5` in a 10 s run) and `codex queue` (10 s)
take 20,000 characters inside their timeouts.

### The dial's "sent" frame

After a delivery the daemon tells the dial `voice.transcript` with the whole transcript in `text`. A frame over
`CABLE_MAX_PAYLOAD` (8,192 bytes) is dropped (`cableSession.send`), so after a transcript of about 8,000 characters
the agent has the words but the dial never hears they were sent. Neither firmware reads `text` (round:
`cable_client.c` `voice.transcript`; Pro: `pro_cable.c` `handle_voice_transcript`). Fix: `withinCap` (today it drops a summary's
`full`) also drops `text` from a `voice.transcript` whose message passes `CABLE_MAX_PAYLOAD - 256` (the margin covers
the `uploadId` that `reply` adds and the `seq` that `send` adds). Both sends of it in `finishVoice` (the window's route
and the direct send) go through it.

### Logs

Ids and counts only (#4458). A failure is logged by `errorKind(err)` (`cli/src/lib/log.ts`), never its message, path or
stack: main's guard test (#4488) holds every new line to it.

## Part B: backend, Free = 30 minutes a day

- `backend/src/lib/db/seed.ts` `CAMPAIGN_TIERS.free.dailyVoiceLimitSeconds`: `10 * 60` to `30 * 60`.
- `backend/src/lib/voiceQuota.ts` `FALLBACK_USER_LIMIT_SECONDS` ("the Free tier's allowance" for an account whose
  plans cannot be read): `10 * 60` to `30 * 60`. The same cause, fixed where it also occurs.
- Tests red first: `seed.test.ts` (the Free row upserted with 1,800) and `routes/voice.test.ts` "holds even with no
  plan rows" (the fallback, now 30 minutes). `voice.test.ts`'s `FREE` fixture and the tests that assume 600 s move to
  1,800.
- Pro stays `30 * 60`, so Free and Pro now allow the same voice (PM to confirm).
- The Wi-Fi device on a Free machine (`limitForMachine`) gets 30 minutes too: it reads the same row.

### Data

- Stored: one field, `dailyVoiceLimitSeconds`, of the existing `SubscriptionPlan` row named Free, in each environment.
  No new field, collection or index. Nothing new synced or exposed: `routes/plans.ts` already shows the value.
- How production changes: the worker runs `ensurePlans()` at every start (`backend/src/worker.ts`), and
  `seedLocalPlans` upserts `dailyVoiceLimitSeconds` on each campaign tier's row, whether or not the upstream catalog
  answers. So the next backend release updates production's Free row as it starts. No migration and no script. Until
  that release, production stays at 10 minutes. A failed `ensurePlans` logs `ensurePlansForEnvironment failed
  (continuing)` and leaves the row as it was.
- Release and deploy only when Diego says. The PR can merge.

### How the USB dial is charged (answer for the PM)

`POST /api/voice/stt` (the cabled dial: the daemon uploads the audio under the person's SSO token) charges the
**account**, the `user:<userId>` bucket (`voiceQuotaService.reserveForUser`). Its daily limit
(`limitForUser`) is:

1. the most generous plan among the account's live machines whose billing lets them run (0, unlimited, beats any
   number);
2. else the environment's default plan (`isDefault`, which is Free while billing is on; Remote while billing is off);
3. else, when no plan can be read, `FALLBACK_USER_LIMIT_SECONDS` (Free's allowance: 30 minutes after this change).

An account is never unlimited by having no plan. The Wi-Fi device (`lib/deviceWs.ts`) is charged by machine instead
(`limitForMachine`): a machine with no plan, or a missing plan row, is unlimited, kept for older bindings.

## Tests

- Unit, red first, per path with fakes: a 10,000-character transcript is refused today and delivered after;
  20,000 delivered; 20,001 refused with the same message. `2001` in today's specs becomes `MAX_TEXT + 1`.
- E2E: a new test in `cli/e2e/deviceWithoutApp.e2e.ts` (Claude Code's mod in a plain terminal, the customer's path;
  throwaway HOME, data folder and port, fake hosts): the fake dial records (`voice.begin`, audio, `voice.end`), the
  fake backend's speech answers a 10,000-character transcript (as `speak` in `deviceCmux.e2e.ts`), the mod's poll
  gets it whole, and the dial gets `voice.transcript`. Red today: the text is refused, and the frame is dropped.
- Local gates: `npm run test:core` (the core file and services), the backend's tests.
- Never Diego's apps or terminals; no real-app gate on this Mac.

## Platforms

macOS, Linux and Windows for the CLI. On Windows a command line holds 32,767 characters: 20,000 characters through an
argument fit, except text made almost wholly of quotes, which the spawn refuses and the dial says did not answer. It
is never cut. The backend runs on Linux.

## Out of scope

- Chunking: no path needs it.
- The ⌘K router service's `MAX_TEXT` (16,000).
- A spoken answer to a Harness agent's question (`questionInbox.ts`, 1,200 bytes): outside agents never take that
  path.
- Firmware, including the dial's 65 s wait after Done (both dials). In that window the computer uploads the WAV
  (19.2 MB for 10 minutes), the backend transcribes (60 s timeout), and the host delivers. On an uplink under about
  3 Mbps a 10-minute recording misses it: the dial aborts and the words are dropped. Reported to the PM as a
  follow-up.
- A passage made mostly of newlines with a near-10-minute transcript can pass 20,000; it is refused, never cut.

## Decisions (PM, 2026-11-19)

- The cap is 20,000 characters: a fast 10-minute transcript plus a carried passage.
- Free = Pro = 30 minutes a day. The PM tells Diego.
- The dial's 65 s wait after Done stays out of scope; no firmware change. The PR records:
  - the time to upload and transcribe 2, 5 and 10 minutes of audio: measured where a fake backend can measure it,
    else estimated (upload at stated uplink speeds, Deepgram's processing time), saying which;
  - whether the backend's `STT_TIMEOUT_MS = 60_000` (`backend/src/lib/sttTimeout.ts`) is enough for Deepgram with
    10 minutes of audio, and the risk if not. It is not changed here;
  - the proposed follow-up: the firmware waits in proportion to the recording's length, or the daemon compresses the
    audio before it goes to the backend.
