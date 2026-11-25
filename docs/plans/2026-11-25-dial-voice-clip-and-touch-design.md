# Round dial voice: clipped recordings and accidental talk touches

Status: proposal, investigation only. No behaviour changes until the orchestrator gives the go. The gesture change and
any firmware release need Diego.

## Problem

Most voice attempts on the round dial fail, for two causes that show in the voice counts (#4561, #4605):

1. **Loud speech is clipped.** The recording hits full scale (peak 32767) and the transcriber returns nothing.
2. **Accidental touches start a recording.** On Focus a touch anywhere on the face below the name talks, including
   contacts too short to count as a tap. A brush starts listening. The person then taps to stop, and that tap sends a
   silent clip (on the voice screen a tap can only send). The dial says "Didn't catch that".

### Evidence

Levels only: peak, RMS, gate, length. No audio and no transcript text was read.

- Ken, Mac log of 17/11: 2 of 4 loud clips CLIPPED (peak 32767, RMS about 4200 to 5000), and Deepgram returned nothing.
- Production 24/11, outside the team: 44 clips, 21 `no_speech`, 4 delivered.
- This Mac, 17/11 to 23/11, from the daemon's `voice turn` lines (`~/.harness/cli/data/harness.log`): 38 clips.
  - 30 of 38 reach peak 31743 or more. All but one clip with speech in it reaches full scale.
  - Clips with text: RMS 1135 to 4347. Typical speech is RMS 2500 to 3100 with peak at full scale.
  - Loud clips with no text: RMS 2656, 2763, 2847, 3012, **3379, 5458** (and **4182**: 2 characters). Above RMS 3300,
    3 of 5 clips failed.
  - 9 clips are silence or noise: RMS 183 to 788. Four of them still peak between 12416 and 32767, which is the thump of
    the finger on the glass at full gain.
- This Mac, dial firmware log (`voice_ms=… energy_gate=…`): 37 clips, **17 with `energy_gate=0` (46 %)**. Every gated
  clip but one lasted 2.8 s or less (0.68 to 2.8 s; one of 13.8 s). Every heard clip lasted 3.2 s or more. Short and
  silent is what an accidental start ended by a second touch looks like.

## 1. The microphone chain

### What it does today

| Stage | Where | Setting |
|---|---|---|
| Mic bias | `es7210.c` (esp_codec_dev 1.6.2) | 2.87 V, MIC1 + MIC2 (the driver's default selection) |
| Analog PGA | `audio_capture.c:audio_capture_start` | `esp_codec_dev_set_in_gain(s_mic, 37.5)`: **37.5 dB, the ES7210's maximum**. The driver's own default is 30 dB. Unchanged since the firmware moved into the repo (80f4bc84c4), commented only "higher analog mic gain". `esp_codec_dev` passes `(int)db` to the codec, so 37.5 reaches the top step only by `get_db`'s rounding. 30 and 27 map exactly. |
| ADC + HPF | ES7210 | HPF on (regs 0x20/0x22 = 0x0a), no ALC or limiter configured |
| I2S | `audio_capture_init` | 16 kHz, 16-bit, mono, Philips, 10 ms DMA frames, 12 descriptors |
| Firmware | `audio_client_habitat.c` | Raw PCM straight into the 32 KB ring. No digital gain, AGC or limiter. `voice_gate_feed` (mean \|x\| > 600 per 10 ms block for 320 ms unbroken) sets `heard`, which is logged and never acted on. |
| Host | `cli/src/cable/cableSession.ts`, `voiceSegments.ts`, `voiceLevel.ts` | Cuts 60 s segments and uploads them unchanged. `VoiceLevel` logs peak, RMS and `heard` (a copy of the firmware gate). It neither flags nor drops clipped audio, and it does not normalize. |
| Backend | `backend/src/lib/deepgramWav.ts` | WAV to Deepgram, nova-3 (nova-2 for `vi`), `punctuate=true` |

The Harness Pro firmware (`devices/harness-pro/firmware/main/audio/audio_capture.c:223`) also sets 37.5 dB. It is out of
scope here: another board and other mics, with no level data yet.

### Why loud speech clips

The gain is the highest the chip has. At 37.5 dB, normal speech at a desk is already RMS 2500 to 3100, about −21 dBFS.
Speech peaks run 15 to 20 dB above its RMS, so normal speech just touches full scale and loud speech (RMS 4000 or more)
saturates for many samples. Saturation happens in the PGA and ADC, before any code sees the samples, so **nothing done
after the ADC can repair it**. A digital limiter or AGC in firmware, or normalization on the host, only reshapes a
waveform that is already flat-topped. The fix has to lower the gain before the ADC.

### Options

| Option | Fixes clipping | Cost | Verdict |
|---|---|---|---|
| **A. Fixed PGA 30 dB** (−7.5 dB, the driver's default) | Yes, 7.5 dB of headroom | One constant. The gate threshold scales with it (below). | **Recommended** |
| B. Fixed PGA 27 dB (−10.5 dB) | Yes, 10.5 dB of headroom | As A. Quiet speech lands near −32 dBFS. | Fallback if A still clips (measured with the clip count below) |
| C. Firmware soft limiter | No: the clip is analog | Code on the capture path | No |
| D. AGC (firmware or ES7210) | Partly, and it pumps on pauses | The esp_codec_dev driver configures no ALC. A software AGC sits on the 10 ms hot path. | No: speech recognition prefers a fixed gain |
| E. Host normalize before upload | No | Host CPU per segment | No (see the host section) |

Numbers for A and B, from a synthetic speech-like signal (a Laplacian carrier under a 4 Hz syllable envelope with
pauses, 4 s, hard-clipped at 16 bits). Clipped samples per mille:

| RMS at 37.5 dB | 37.5 dB: peak / RMS / clipped ‰ | 30 dB (A): peak / RMS / ‰ | 27 dB (B): peak / RMS / ‰ |
|---|---|---|---|
| 2800 (typical) | 32768 / 2790 / 0.16 | 19375 / 1181 / 0 | 13717 / 836 / 0 |
| 4200 (Ken's loud) | 32768 / 4096 / 1.45 | 29063 / 1771 / 0 | 20575 / 1254 / 0 |
| 5000 | 32768 / 4775 / 3.2 | 32767 / 2108 / 0.02 | 24494 / 1493 / 0 |
| 5458 (loudest seen) | 32768 / 5140 / 4.22 | 32768 / 2300 / 0.05 | 26737 / 1629 / 0 |

With A, normal speech sits around −29 dBFS. Deepgram handles that level well; clipping is what it cannot handle. The
self-noise of the silent clips falls from RMS about 200 to about 85, and the touch thump falls by the same 7.5 dB.

### The gate has to follow the gain

`voice_gate_feed` (firmware) and `VoiceLevel` (host) call a 10 ms block loud above a mean |x| of 600. That threshold was
set at 37.5 dB. At 30 dB the same speech reads 2.37 times lower, so quiet speech would drop under 600 and be counted
`no_speech`. The threshold must scale with the gain: 600 × 10^(−7.5/20) = 253, so **250** at 30 dB.

The host sees dials on old and new firmware, so it cannot assume either gain. Following the rule that "the rate travels
with the audio": **`voice.begin` carries `micGain` (dB) beside `sr`** (not `gain`, which the turn line already uses for the host's raise). The host scales its gate from it, and a dial that
sends none is read as 37.5 dB. `micGain` is range-checked the way `sr` is (`cableSession.ts` voice.begin), and its value
reaches `VoiceLevel` through the `VoiceSegments` options.

On the firmware side:

- **One constant.** The gain becomes `AUDIO_MIC_GAIN_DB` in `audio_capture.h`, beside `AUDIO_SAMPLE_RATE`. It is read by
  `audio_capture_start`, by `voice_gate_feed` (today a literal 600 in `voice_buffer.c:62`), and by
  `cable_client_voice_begin`, which reads the constant itself. Its signature, the `audio_probe.h` macro and
  `test_cable_outbound.py` stay as they are.
- **The level meter follows the gain too.** `voice_level_feed`'s steps (64/180/500/1600, `voice_buffer.c:79`) were set at
  37.5 dB as well. Scaled by the same factor, the listening animation keeps its look. `test_voice_buffer.c:60-71` pins
  those steps.
- **Harness Pro** has its own byte-identical `voice_buffer.c`, not a shared file, and sends no `micGain` (`pro_cable.c:325`).
  It keeps 37.5 dB and 600. Its copy changes only so it builds, with `test_pro_recorder.py` unchanged in behaviour.
- **No twin test exists today.** The host pins 600/601 (`voiceLevel.spec.ts:60-62`), and the C test uses a block of
  constant 2000 (`test_voice_buffer.c:41-58`). The build adds one: a vector file generated once (as
  `gen_cable_vectors.py` does for the cable framing), with PCM and the `heard` each gate must reach at 37.5 and 30 dB,
  read by both tests.
- **The cable protocol needs no version bump.** The field is optional, `CABLE_PROTO_VERSION` stays at 3.

**Mixed versions.** The CLI and the firmware update apart. A new firmware under an old CLI keeps the host's gate at 600,
which would count quiet speech as `no_speech` (`product-measurement.md:150` defines it by the firmware gate). So the
host side of 2 ships in a CLI release **before** the firmware's OTA.

### The host

- **Flag clipping. No rejection.** `VoiceLevel` counts samples at 32767 or −32768 (it reads −32768 as peak 32768), and
  the `voice turn` line gains
  `clip=<per mille>`: a number only, measured on hosts already in the field before any firmware ships. Clipped clips
  are still sent: 26 of the 30 clipped clips here came back with text.
- **Quiet voice is already raised (#4606, `voiceGain.ts`, merged 2026-11-25).** Per segment, the host reads the 20 ms
  frames. A voice whose 90th-percentile frame RMS is under 2000 (about −24 dBFS) is raised by up to +18 dB before upload,
  and the turn line logs `voice=`, `floor=` and `gain=` (that host gain, in dB). #4606 also found that the touch that
  starts a recording and the tap that ends it clip at full scale, so **a peak of 32767 is often the tap, not the voice**.
  The `clip` share separates them: a tap is a few samples, while flat-topped speech is many.
  - With A, typical speech's voice of about 2000 to 2500 at 37.5 dB becomes about 850 to 1050. #4606 then raises it
    about 6 to 7 dB digitally, and loud speech no longer clips in the analog stage. That is the split we want: headroom
    in the analog stage, level in the host.
  - No other normalization is needed, since a raise cannot undo a clip.
- **Measures.** `clip` per mille in the turn line. The daily integration report reads `no_speech`, `no_words` and the
  clip rate before and after.

### Verify without a person

- **Host TS (`voiceLevel.spec.ts`)**, on PCM the test generates (a deterministic speech-like generator, like the table's;
  no recorded voice goes into the repo):
  - a hard-clipped fixture reports the expected `clip` per mille, and a clean one reports 0;
  - the gate at `gain: 30` hears speech scaled −7.5 dB from a clip the 37.5 dB gate hears, and not the noise floor
    scaled the same way;
  - a `voice.begin` with no `gain` keeps the threshold at 600.
- **Firmware host test (`test/test_voice_buffer.c`, `run.sh`)**, on the shared vector file: `voice_gate_feed` at the new
  threshold reaches the same `heard` as the host gate, and the level meter's steps scale with the gain. The generator
  that wrote the vectors, and the table's synthetic signal, go into `test/` so the numbers can be checked again.
- **Firmware source test** (in the style of `test_audio_init.py`): `audio_capture_start` sets the one gain constant, and
  `voice.begin` sends it. The `voice.begin` check in `test_cable_outbound.py` needs `IDF_PATH` only for cJSON's sources,
  with no `idf.py` and no board.
- **Only the field can show** whether 30 dB still clips on real speech and how Deepgram does at −29 dBFS.
- **In the field, after an OTA Diego approves**: the turn lines' `clip` per mille and RMS distribution, and the counts
  `no_words` and `no_speech`, from normal use. No bench test with a speaker: that needs the real dial.

## 2. Accidental talk

### What a touch on the Focus face does today

`ui_habitat.c` (`render_focus` hits, `habitat_touch`, `surface_tick`). Every item below must keep working:

| Contact | Where | Does |
|---|---|---|
| Press and release inside the target within 1800 ms (a footer button) | Name, the arc at the top (y < 66). Not there while `[return]` or `[drop]` shows. | Opens the pane list (`A_AGENTS`) |
| Contact released before 650 ms, never more than 24 px from where it went down, no scroll. **Any length, even under the 25 ms a tap needs.** | Anywhere else on the face | **Starts voice** to the agent on the face, carrying the text when carry is active (`make_action`). An agent without V shows "See it in <app>" for 2 s. |
| Same, while connected but loading, or disconnected | Face | Nothing |
| Any contact within 450 ms of a voice start or abort (the guard) | Face | Nothing |
| Contact during a fling (the brake) | Face | Stops the fling. A real tap is swallowed, but a brake held 350 to 650 ms starts voice today. |
| Hold ≥ 650 ms, still | Face | Opens the tab list, or the app list on a machine view (`hold_open`). Needs a connection. |
| Vertical drag | Face | Scrolls the recap or terminal |
| Downward drag > 55 px with unread notices | Anywhere on the face | Opens the inbox |
| Horizontal swipe > 60 px | Face | Next or previous agent |
| Press and release, as a footer button | Bell badge or the pet's bell bubble | Opens the inbox (its target wins over the face) |
| Press and release | Footer controls `[return]`, `[drop]` | Their action |
| First touch on a sleeping screen | Anywhere | Wakes the screen and is swallowed (`touch_habitat.c`) |
| Selection view: a real tap (25 to 350 ms, < 12 px) | The excerpt | Starts voice about the selection |
| Voice screen: a real tap (25 to 350 ms, < 12 px, outside the 450 ms guard) | Whole glass | Ends the recording and sends it |
| Voice screen: hold 650 to 1800 ms | Whole glass | Ends it into a draft review |
| Voice screen: any other contact | Whole glass | Nothing |
| Physical button | — | Discards a recording (`ui_boot_pressed`), stops a busy agent, or goes home |

A touch can end a recording only by sending it, or by turning it into a draft. The only discard is the physical button.
So an accidental start, ended by the tap a person makes to dismiss it, sends silence.

G1 changes the face's start rule only. It leaves the selection view's tap (already 25 ms or more) and the voice screen
alone. Its build also fixes the stale `home_footer` comment (`ui_habitat.c:956-958`), which still says A_PET talks on a
650 ms hold, and moves `tap()` in `test_touch_ui.py` (75 ms, about 150 uses) inside the new window (120 to 350 ms).

### Options

| Option | Stops accidental starts | Breaks or changes | Verdict |
|---|---|---|---|
| **G1. Deliberate press**: voice starts only from a contact held at least 120 ms (still ≤ 24 px, < 650 ms) | Brushes and grazes, which are shorter | Nothing in the table above; a quick flick-tap no longer talks | **Recommended**, with the touch measure below to set N from data |
| G2. Hold to talk (push and hold ≥ 300 ms, release sends) | Most | Hold opens tabs today, and the voice-screen hold opens review: both move. A long dictation means holding the finger down. | No: too much moves |
| G3. A zone (only the mark or the lower half talks) | Some | Reverses the owner's 2026-10-01 rule "a touch anywhere talks" | No |
| G4. Double tap | Most | Slower, hard to discover, and its 300 ms wait delays every tap on the face | No |

### Silent clips before upload

Today a silent clip is uploaded, transcribed and answered "Didn't catch that". The firmware says the energy gate
"must never discard" a person's words (`audio_client.h`, `ui_habitat.c` voice tick), because quiet speech can miss it.
So any drop by level is Diego's decision.

**Recommended, host only: a clip under 1.0 s that the gate did not hear is not uploaded.** It is still counted
`no_speech`, and the dial still says "Didn't catch that". Here this covers 8 of the 17 gated clips (0.68 to 1.1 s).
The risk is a one-word answer ("yes") under 1 s that the gate missed: a word shorter than the gate's 320 ms of unbroken
loud blocks, or a whisper, would be lost. No data says how often that happens yet.

Building it:

- **It lives in `VoiceSegments`.** `finish()` uploads the tail as soon as it arrives, and the level is complete only then
  (`voiceSegments.ts:80-89`), so `cableSession` cannot decide first.
- **The host fixtures change.** Each one sends 0.1 s of unheard PCM (`Buffer.alloc(3200)` in about 54 `port.pcm` calls
  in `cableSession.spec.ts` and `cableVoice.spec.ts`, `Buffer.alloc(3_200, 1)` in the e2e tests, tierA's
  `loopbackDial`). Under the rule all of them would be dropped. They move to a shared helper that sends a heard clip.
- **A measure shifts.** `voice_dial_clips` (`product-measurement.md:151`) counts only uploaded clips, so it falls. The
  doc says so in the same pull request.

### Measures

- Firmware, numbers only: the `focus touch: start voice` line gains `down_ms` and `drift_px`, so N in G1 is set from
  real contacts paired with the clip's `energy_gate`.
- Host: the `voice turn` line gains `sent=0|1`. A dropped clip shows `sent=0` and a `no_speech` count, with no upload.
- Effect to watch: the `no_speech` share of clips (46 % here, 48 % in production) and Deepgram calls for clips under
  1 s, both falling.

### Verify without a person

`test/test_touch_ui.py` drives `ui_habitat.c` on the host with simulated touches:

- a 40 ms contact does not start voice, a 150 ms one does, and 600 ms with 10 px drift still does;
- every row of the table above still holds (name tap, hold to tabs and apps, scroll, swipe, pull down, bell, footer,
  voice-screen tap and hold);
- the existing "a tap ANYWHERE on the face talks" cases keep their positions, at the new press length.

Host TS (`cableSession.spec.ts`): a 0.8 s unheard clip makes no transcribe call and counts `no_speech`. A 0.8 s heard
clip and a 1.2 s unheard clip are both sent.

## Decisions needed

1. **Gain**: 37.5 → 30 dB (A). Fallback 27 dB (B) if `clip` stays above 0 after A. *Firmware, OTA: Diego.*
2. **Gate follows the gain**: `voice.begin` carries `micGain`; threshold 250 at 30 dB, 600 when absent; the level meter's
   steps scale the same. *The host side ships in a CLI release before the firmware's OTA.*
3. **Host clip measure** (`clip` ‰ in the turn line): host only, ships with the CLI before any firmware. *Orchestrator.*
4. **Gesture**: G1, a deliberate press of at least 120 ms, plus the touch measure. *Firmware: Diego.*
5. **Silent short clip**: the host does not upload a clip under 1.0 s that the gate did not hear. This overrides the
   rule that the gate never discards. *Diego.*

Suggested order: 3 first (host, no release); then 1, 2 and 4 in one firmware build, OTA on Diego's go; 5 on its own
answer.

Platforms: the dial firmware (ESP32-S3 round dial; Harness Pro unchanged) and the host CLI on macOS, Linux and Windows
(the gate, the measure and the drop are platform-free TypeScript).
