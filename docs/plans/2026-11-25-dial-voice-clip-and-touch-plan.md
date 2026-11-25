# Dial voice clip, decisions 1 and 2: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round dial records at 30 dB instead of 37.5 dB, so loud speech no longer clips in the ADC, and the dial's
voice gate, its level meter and the daemon's copy of the gate follow that gain. The dial states its gain in
`voice.begin` as `micGain`, and a dial that sends none is read as 37.5 dB.

**Architecture:** One constant, `AUDIO_MIC_GAIN_DB` (`audio_capture.h`), sets the ES7210's PGA (`audio_capture_start`),
goes out in `voice.begin` beside `sr` (`cable_client_voice_begin`), and is passed by the capture loop to
`voice_gate_feed` and `voice_level_feed`, as `rate` already is. Both sides hold the same two-row table of levels
(37.5 dB: gate 600, meter 64/180/500/1600; 30 dB: gate 250, meter 27/76/211/675). The daemon reads `micGain` through
`micGainOf` (`voiceLevel.ts`) and passes it via the `VoiceSegments` options to `VoiceLevel`. A shared vector file of
synthetic speech-like PCM, written by a generator in the firmware's `test/`, pins the `heard` each gate must reach at
each gain, and both the C test and the TypeScript spec read it.

**Tech Stack:** C11 firmware (ESP-IDF 5.5, ESP32-S3), host-tested with `cc` and Python 3 drivers
(`devices/harness-device/firmware/test/`). TypeScript CLI (Node 24, Vitest).

**Spec:** `docs/plans/2026-11-25-dial-voice-clip-and-touch-design.md`, decisions 1 and 2 only (gain 37.5 → 30 dB; the
gate follows the gain). Not decision 3 (PR #4608), 4 (the gesture) or 5 (dropping short silent clips). Branch
`fix/dial-voice-clip-and-touch`. Firmware line numbers are on `e8ff3be075`. Host files are named by landmarks,
because their lines move with the rebase onto `#4606` and `#4608`.

Paths: `FW` = `devices/harness-device/firmware`, `CB` = `cli/src/cable`.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | The shared voice vectors | `FW/test/voice_signal.py`, `FW/test/gen_voice_vectors.py`, `FW/test/vectors/voice_gate.txt`, `FW/test/vectors/voice_gate.pcm` | none | high | `gen_voice_vectors.py --check` (file missing) |
| 2 | One mic gain: the PGA and `voice.begin` | `FW/main/audio_capture.h`, `FW/main/audio_capture.c`, `FW/main/cable_client.c`, `FW/main/cable_client.h`, `FW/test/test_audio_gain.py`, `FW/test/test_cable_outbound.py`, `FW/test/run.sh` | none | high | `test_audio_gain.py`; `test_cable_outbound.py` (no `micGain`) |
| 3 | The dial's gate and meter follow the gain | `FW/main/voice_buffer.h`, `FW/main/voice_buffer.c`, `FW/main/audio_client_habitat.c`, `FW/test/test_voice_buffer.c`, `FW/test/test_voice_buffer.py`, `FW/test/run.sh`, `FW/test/test_audio_stream.py`, `FW/test/test_audio_threads.py` | 1, 2 | high | `test_voice_buffer.py` |
| R | Rebase onto `main` after #4608 | every file on the branch | #4608 merged (outside this plan) | medium | none: a rebase |
| 4 | The daemon's gate follows `micGain` | `CB/voiceLevel.ts`, `CB/voiceLevel.spec.ts`, `CB/__fixtures__/voiceVectors.ts`, `CB/voiceSegments.ts`, `CB/voiceSegments.spec.ts`, `CB/cableSession.ts`, `CB/cableVoice.spec.ts` | 1, R | high | `voiceLevel.spec.ts` twin cases; `voiceSegments.spec.ts` mic gain cases; `cableVoice.spec.ts` `micGain` case |

**Shared files** (devcrew runs these one at a time): `FW/test/run.sh` (2, 3). Task R shares every file, so it waits
for any running task and none starts while it runs.

**Longest chain:** two tasks: 1 → 3, 2 → 3, 1 → 4 and R → 4. Ready at once: 1 and 2. R is ready once #4608 merges.

## Global Constraints

- **Firmware is built and tested on the host only.** Use `cc` and `python3` (`FW/test/run.sh`, the `test_*.py`
  drivers). Never `idf.py flash`, `idf.py monitor`, `esptool`, a serial port or a dial. `test_cable_outbound.py` needs
  `IDF_PATH` only for cJSON's sources (`run.sh:203-218`): `IDF_PATH=$HOME/esp/esp-idf-5.5.4`. The one `idf.py build` is
  Verification's build check, into a scratch build folder, and is never flashed.
- **The Mac is shared.** Before `run.sh` (about 2.5 minutes) or the build check, ask the session that started you
  whether the Mac is free. Never list or scan other processes to find out.
- **Sequencing.** Tasks 1-3 start now. Task 4 starts only after PR #4608 (branch `fix/dial-voice-clip-measure`,
  `clip=`) has merged into `main` and Task R has rebased this branch onto that `main`. That `main` also carries #4606
  (`35c3a97389`, `CB/voiceGain.ts`).
- **The field is `micGain`** (a number, in dB), sent beside `sr`. It is not `gain` as the spec says, so it cannot be
  confused with the host's `gain=` in the turn line (coordinator, 2026-11-25). `CABLE_PROTO_VERSION` stays 3
  (`CB/cableSession.ts:46`).
- **Two gains have levels: 37.5 and 30.** The rows are exactly: 37.5 dB, gate 600, meter 64/180/500/1600; 30 dB,
  gate 250, meter 27/76/211/675. A gain without a row, or no gain at all, reads as 37.5 dB on both sides.
- **The daemon's gate reads the PCM as the dial sent it**, before `raised()` (`CB/voiceSegments.ts` `add()`:
  `runningLevel.add(pcm)` comes before `raised(pcm, gain)`). The host's raise never changes `heard`.
- **`voiceGain.ts` is unchanged** (`VOICE_TARGET` 2000, `MAX_GAIN` 8): see Decision 9.
- **Harness Pro is unchanged.** `git diff --stat origin/main -- devices/harness-pro` prints nothing. It stays at
  37.5 dB and 600 and sends no `micGain`, so the daemon reads its clips at 37.5 dB.
- **No recorded voice in the repo.** The vectors are synthetic (`FW/test/voice_signal.py`), 182,400 bytes of PCM.
- **No core change.** Nothing under `cli/src/core/` or `cli/src/services/` changes.
- **Release order.** A CLI release carrying Task 4 goes out before any firmware upload of this change. That upload
  (`make upload-circle`) is Diego's call. This PR does not touch `FW/version.txt`.
- **Docs.** The spec and this plan go in unchanged. `docs/product-measurement.md` is unchanged (Decision 10).
- **Platforms:** the round dial's firmware (ESP32-S3). The host CLI on macOS, Linux and Windows: the change is
  platform-free TypeScript.

## Review Focus

1. **A `micGain` the dial should never send** (a string, 27, a negative, 1e9, `null`, an array). It reads as
   37.5 dB: no throw, no `NaN` threshold, no `undefined` level. Pinned in Task 4 (`micGainOf` cases, and the
   `cableVoice.spec.ts` case with `'30'` and `27`). The C side does the same for a gain with no row (Task 3).
2. **A firmware change that ships a gain with no row.** The dial's gate would silently fall back to 600. Pinned in
   Task 3: the test asserts `AUDIO_MIC_GAIN_DB` is one of the vector file's gains.
3. **The host's raise re-clipping speech the lower gain freed.** `raised()` clamps, and `clip=` counts the dial's PCM,
   so a clip the host made would go unseen. Pinned in Task 4: at 30 dB, typical speech is raised by about 6.5 dB and
   no uploaded sample sits at full scale.
4. **A later change moving the gate after the raise.** `heard` would then read the host's gain, not the dial's
   speech. Pinned in Task 4: speech recorded at 30 dB but read as 37.5 dB is raised and still not heard, while a gate
   fed the raised bytes would hear it.
5. **A recording cut into segments or adds at odd sample offsets at 30 dB.** The 10 ms block carries across `add()`
   calls at the new threshold. Pinned in Task 4: each shared clip is read whole and split at an odd sample.

---

### Task 1: The shared voice vectors

**Files:** Create `FW/test/voice_signal.py`, `FW/test/gen_voice_vectors.py`, `FW/test/vectors/voice_gate.txt`,
`FW/test/vectors/voice_gate.pcm`. Depends on nothing. Effort high: data both halves trust.

**Interfaces (produces):**
- `voice_signal.py`: `RATE = 16000`; `scale(gain_db) -> float` (the factor from 37.5 dB to `gain_db`);
  `laplacian(rng, n)`; `adc(x, k=1.0) -> list[int]` (rounded and hard-clipped to 16 bits); `table_signal()`;
  `table() -> list[tuple[int, float, int, int, float]]` (`(rms_at_37_5, gain_db, peak, rms, clipped_per_mille)`);
  `TABLE`, the spec's 12 rows; `sources()`; `clips() -> dict[str, list[int]]`. Run as a script, it prints `table()`
  and exits non-zero unless it equals `TABLE`.
- `gen_voice_vectors.py [--check]` writes both vector files, or with `--check` fails on a missing or stale one (as
  `FW/scripts/gen_cable_vectors.py` does). It holds a third gate, written from the description and from nothing else:
  10 ms blocks of `rate // 100` samples, a block loud when its integer mean |sample| is over `loud`, heard once
  `rate * 320 // 1000` samples of loud blocks run unbroken.
- `voice_gate.txt` (tab-separated, `#` comments and blank lines ignored). Once the code below is in, its data lines
  are exactly these:

```
rate	16000
gain	37.5	600	64	180	500	1600
gain	30	250	27	76	211	675
clip	speech37	0	19200	1	1
clip	speech30	19200	19200	0	1
clip	loud37	38400	19200	1	1
clip	loud30	57600	19200	1	1
clip	noise37	76800	4800	0	0
clip	noise30	81600	4800	0	0
clip	tap37	86400	4800	0	0
```

  `gain <dB> <loud> <step1..4>`; `clip <name> <first sample> <samples> <heard at each gain, in the gain lines' order>`.
  The header comment says where the file comes from, that it holds no recorded voice, and that both
  `FW/main/voice_buffer.c` and `CB/voiceLevel.ts` are held to it.
- `voice_gate.pcm`: the clips back to back, 16-bit little-endian mono, 91,200 samples.

The signal is the algorithm no test determines, so here it is. `table_signal()` must stay exactly as written: it is
the spec's own script, and with it `table()` reproduces the spec's table to the digit (checked on Python 3.13).

```python
def scale(gain_db): return 10 ** ((gain_db - 37.5) / 20)
def laplacian(rng, n): return [rng.choice((-1, 1)) * rng.expovariate(1.0) for _ in range(n)]  # E|x| = 1
def adc(x, k=1.0): return [max(-32768, min(32767, round(v * k))) for v in x]

def table_signal():  # 4 s, a 4 Hz syllable envelope, a pause each 2 s
    n = RATE * 4
    env = [max(0.0, math.sin(2 * math.pi * 4 * i / RATE)) ** 2 * (0 if (i // (RATE // 2)) % 4 == 3 else 1) for i in range(n)]
    return [e * v for e, v in zip(env, laplacian(random.Random(7), n))]
# table(): for t in (2800, 4200, 5000, 5458), g in (37.5, 30, 27): y = adc(x, t / rms(x) * scale(g)), then
# (t, g, max |y|, round(rms(y)), round(1000 * samples at 32767 or -32768 / len(y), 2)).

FLOOR, VOICE = 141, 1750  # the dial's self-noise, RMS about 200 at 37.5 dB; speech whose 20 ms frames' 90th percentile is about 2400
def sources():  # float samples at 37.5 dB, before the ADC
    rng = random.Random(2511); s = lambda sec: round(sec * RATE)
    floor = lambda n: [FLOOR * v for v in laplacian(rng, n)]
    voice = lambda n: [VOICE * (0.6 + 0.4 * math.sin(math.pi * 4 * i / RATE) ** 2) * v for i, v in enumerate(laplacian(rng, n))]
    words = [0.0] * s(0.15) + voice(s(0.4)) + [0.0] * s(0.1) + voice(s(0.4)) + [0.0] * s(0.15)
    room = floor(len(words))
    tap = floor(s(0.3))
    for i, v in enumerate(laplacian(rng, s(0.03))): tap[s(0.1) + i] += 12000 * math.exp(-i / s(0.005)) * v
    noise = floor(s(0.3))
    return {'speech': [r + w for r, w in zip(room, words)], 'loud': [r + 2.5 * w for r, w in zip(room, words)],
            'noise': noise, 'tap': tap}
# clips(): speech37 = adc(speech), speech30 = adc(speech, scale(30)), loud37, loud30, noise37, noise30 the same way,
# tap37 = adc(tap). The 30 dB clips scale the signal before the ADC, as the PGA does: loud30 is not loud37 scaled.
```

- [ ] **Step 1: Write both scripts.** `gen_voice_vectors.py` asserts the story each clip tells before it writes
  anything, and fails with the clip's name if one does not hold:

| clip | heard at 37.5 | heard at 30 | samples at full scale |
|---|---|---|---|
| speech37 | 1 | 1 | none |
| speech30 | 0 (the 600 gate misses quiet speech at 30 dB) | 1 (the 250 gate hears it) | none |
| loud37, loud30 | 1 | 1 | loud37 some, loud30 none |
| noise37, noise30 | 0 | 0 | none |
| tap37 | 0 | 0 | some |

- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/gen_voice_vectors.py --check`. Expected: FAIL,
  `missing: …/vectors/voice_gate.txt`.
- [ ] **Step 3: Generate** with `python3 devices/harness-device/firmware/test/gen_voice_vectors.py`. Expected:
  `wrote …voice_gate.txt` and `…voice_gate.pcm (182400 bytes)`.
- [ ] **Step 4: Run** `--check` again, and `python3 devices/harness-device/firmware/test/voice_signal.py`.
  Expected: `up to date`, then the 12 rows, ending `matches the design doc's table`.
- [ ] **Step 5: Commit** (`test(firmware): shared voice gate vectors from a synthetic speech-like signal`).

### Task 2: One mic gain: the PGA and `voice.begin`

**Files:** Modify `FW/main/audio_capture.h` (beside `AUDIO_SAMPLE_RATE`, 21), `FW/main/audio_capture.c` (274),
`FW/main/cable_client.c` (`cable_client_voice_begin`, 528-574: after `"sr"`, 537), `FW/main/cable_client.h`
(the voice comment, 274-283), `FW/test/test_cable_outbound.py` (77, 143-147), `FW/test/run.sh` (after 197). Create
`FW/test/test_audio_gain.py`. Depends on nothing. Effort high.

**Interfaces (produces):** `#define AUDIO_MIC_GAIN_DB 30.0f` in `audio_capture.h`. Its comment says why: 37.5 dB is
the ES7210's top step, where normal desk speech already touches full scale and the clip happens before any code sees
the samples; 30 dB is the driver's own default and maps to the chip exactly; the gain travels with the audio as
`micGain`, as the rate does as `sr`, because the daemon's copy of the gate scales with it. `voice.begin` carries
`"micGain": 30`. The signature of `cable_client_voice_begin`, the `audio_probe.h` macro and every
`cable_client_voice_begin(…, 16000)` call stay as they are: the function reads the constant itself.

- [ ] **Step 1: Write the failing tests.**
  - `test_audio_gain.py`, in the style of `test_audio_init.py`: extract `audio_capture_start` from `audio_capture.c`,
    include `audio_capture.h`, and stub what it calls, with a stub `esp_codec_dev_set_in_gain` that records each
    gain. Assert `AUDIO_MIC_GAIN_DB == 30.0f`, then `audio_capture_start()` returns true, sets the gain exactly once,
    to `AUDIO_MIC_GAIN_DB`, and a second call while open sets nothing. Print `Audio gain: the PGA is set once, from
    AUDIO_MIC_GAIN_DB (30 dB) PASS (offline)`.
  - `test_cable_outbound.py`: `code += defines('AUDIO_MIC_GAIN_DB', source=(MAIN / 'audio_capture.h').read_text())`.
    In the `which==0` block, and in a new `which==24` block, parse `expected`: `micGain` is a number equal to
    `AUDIO_MIC_GAIN_DB`, and `sr` is still 16000.
  - `run.sh`: `python3 "$here/test_audio_gain.py"` after `test_audio_init.py`.
- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_audio_gain.py` and
  `IDF_PATH=$HOME/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_cable_outbound.py`.
  Expected: FAIL both (`AUDIO_MIC_GAIN_DB` undeclared, or not found by `defines`).
- [ ] **Step 3: Implement.** Add the constant; `audio_capture_start` sets `esp_codec_dev_set_in_gain(s_mic,
  AUDIO_MIC_GAIN_DB)` and loses its "higher analog mic gain" comment; `msg_number(&root, "micGain",
  AUDIO_MIC_GAIN_DB)` follows `"sr"`; `cable_client.h` says in one line that `micGain` travels beside `sample_rate`
  for the same reason and is read from the constant, not passed.
- [ ] **Step 4: Run** the two tests, then `IDF_PATH=$HOME/esp/esp-idf-5.5.4 bash devices/harness-device/firmware/test/run.sh`.
  Expected: PASS; `run.sh` exits 0.
- [ ] **Step 5: Commit**: the red commit with the tests, then the code (`firmware: record at 30 dB, one constant,
  sent as micGain`).

### Task 3: The dial's gate and level meter follow the gain

**Files:** Modify `FW/main/voice_buffer.h` (19-27), `FW/main/voice_buffer.c` (`voice_gate_feed` 51-66, its literal
600 at 60; `voice_level_feed` 68-82, its steps at 81), `FW/main/audio_client_habitat.c` (`capture`, 84-85),
`FW/test/test_voice_buffer.c` (41-74), `FW/test/run.sh` (109-111), `FW/test/test_audio_stream.py` (25),
`FW/test/test_audio_threads.py` (28). Create `FW/test/test_voice_buffer.py`. Depends on Task 1 (the vectors) and
Task 2 (`AUDIO_MIC_GAIN_DB`, and `run.sh`). Effort high.

**Interfaces:** Consumes `AUDIO_MIC_GAIN_DB` (Task 2), `voice_gate.txt` and `voice_gate.pcm` (Task 1). Produces:

```c
// mic_gain_db: the PGA gain the PCM was captured at. The gate's loud level and the meter's steps were set by ear at
// 37.5 dB and scale with it; a gain with no levels of its own reads as 37.5 dB, as the daemon reads one.
void voice_gate_feed(voice_gate_t *gate, const int16_t *pcm, size_t samples, unsigned rate, float mic_gain_db);
unsigned voice_level_feed(voice_level_t *meter, const int16_t *pcm, size_t samples, float mic_gain_db);
```

The table is `static` in `voice_buffer.c`, with the two rows of Global Constraints and a comment on how the 30 dB row
was made (Decision 2). The meter's level is the number of steps the envelope has reached, as the old ternary was.

- [ ] **Step 1: Write the failing tests.**
  - `test_voice_buffer.c` becomes `main(int argc, char **argv)` with the vector files as `argv[1]` and `argv[2]`. It
    includes `../main/audio_capture.h`. The ring and wraparound cases stay. The constant-2000 gate cases pass
    `AUDIO_MIC_GAIN_DB`, and the meter's existing cases pass `37.5f`. New cases, with the PCM fed `rate / 100`
    samples a call as the dial feeds it:

```c
for (each gain line g: loud L, steps S[0..3]) {
    assert(!heard_tone(L, g) && heard_tone(L + 1, g));      // 400 ms of alternating ±L, then ±(L + 1)
    for (int i = 0; i < 4; i++)                              // a fresh meter, one block {0, span}
        assert(level_of_span(S[i] - 1, g) == i && level_of_span(S[i], g) == i + 1);
}
for (each clip c, each gain line g) assert(clip_heard(c, g) == c.heard[g]);
assert(has_gain_line(AUDIO_MIC_GAIN_DB));                    // the shipped gain has levels of its own
assert(!heard_tone(600, 27.0f) && heard_tone(601, 27.0f));   // a gain with no row reads as 37.5 dB
assert(level_of_span(63, 27.0f) == 0 && level_of_span(64, 27.0f) == 1);
```

    Its last line names what passed, with the clip count: `…the gate and meter at each mic gain, and the daemon's
    gate on 7 shared clips passed`.
  - `test_voice_buffer.py` runs `voice_signal.py`, then `gen_voice_vectors.py --check`, then compiles
    `test_voice_buffer.c` with `main/voice_buffer.c` as `run.sh` did (`-std=c11 -Wall -Wextra -Werror -O1 -g
    -fsanitize=${SANITIZERS:-undefined,bounds}`, `-I main`) in a temporary folder and runs it on the two vector
    files. `firmware-checks` runs every `test_*.py`, so the twin's C half runs on PR CI too; the old `cc` lines in
    `run.sh` never did.
  - `run.sh` 109-111 become `python3 "$here/test_voice_buffer.py"`.
- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_voice_buffer.py`. Expected: FAIL (too many
  arguments to `voice_gate_feed`).
- [ ] **Step 3: Implement** the table and both functions, and pass `AUDIO_MIC_GAIN_DB` at both calls in `capture`.
  `test_audio_stream.py` and `test_audio_threads.py` take the constant from the header beside their
  `AUDIO_SAMPLE_RATE`: `defines('AUDIO_MIC_GAIN_DB', source=(main / 'audio_capture.h').read_text())` (`native_shapes`).
- [ ] **Step 4: Run** `test_voice_buffer.py`, `test_audio_stream.py` and `test_audio_threads.py`, then
  `IDF_PATH=$HOME/esp/esp-idf-5.5.4 bash devices/harness-device/firmware/test/run.sh`. Expected: PASS; exit 0.
  `git diff --stat origin/main -- devices/harness-pro` prints nothing.
- [ ] **Step 5: Commit**: the red commit, then the code (`firmware: the voice gate and meter follow the mic gain`).

### Task R: Rebase onto `main` after #4608

**Files:** every file on the branch. Depends on PR #4608 having merged into `main` (outside this plan). Effort
medium. No failing test: a rebase changes no behaviour.

- [ ] **Step 1:** Check `gh pr view 4608 --json state` reads `MERGED`. Then `git fetch origin main` and
  `git rebase origin/main`. The firmware commits touch no file #4606 or #4608 changed.
- [ ] **Step 2: Run** `git log --oneline origin/main -1 -- cli/src/cable/voiceGain.ts` (it shows #4606), then
  `grep -n 'clip=' cli/src/cable/cableSession.ts` (the turn line has `clip=`), then
  `cd cli && npx vitest run src/cable/voiceLevel.spec.ts src/cable/voiceSegments.spec.ts src/cable/voiceGain.spec.ts`,
  then `python3 devices/harness-device/firmware/test/test_voice_buffer.py`. Expected: all pass.
- [ ] **Step 3:** Report the new head SHA. Push only if the session that started you asks.

### Task 4: The daemon's gate follows `micGain`

**Files:** Modify `CB/voiceLevel.ts` (the class comment, the constructor, `gate()`), `CB/voiceLevel.spec.ts`,
`CB/voiceSegments.ts` (the options type, `new VoiceLevel(rate)` in the constructor, the comment in `add()`),
`CB/voiceSegments.spec.ts` (`setup()`, "the level matches the whole recording", a new describe),
`CB/cableSession.ts` (beside `DEFAULT_VOICE_RATE`; `type VoiceTurn`; in `case 'voice.begin'` the `rate:` line and
`new VoiceSegments`), `CB/cableVoice.spec.ts`. Create `CB/__fixtures__/voiceVectors.ts`. Depends on Task 1 and
Task R. Effort high.

**Interfaces:** Consumes `FW/test/vectors/voice_gate.txt` and `.pcm`, read from the firmware's tree as
`CB/pets/pack.spec.ts` reads `pet_min.hpet` (`new URL('../../../../devices/harness-device/firmware/test/vectors/…',
import.meta.url)`). It also consumes `level()` as #4606 and #4608 leave it (`peak`, `rms`, `clip`, `heard`, `voice`,
`floor`, `gain`). Produces:

```ts
// voiceLevel.ts
export type MicGain = 37.5 | 30
export const DEFAULT_MIC_GAIN: MicGain = 37.5
/** The dial's `micGain`, or 37.5 dB for none or one this side has no levels for: firmware from before it was sent, and the Pro. */
export function micGainOf(value: unknown): MicGain
constructor(rate: number, micGain: MicGain)                  // VoiceLevel
// voiceSegments.ts
constructor(options: { rate: number; micGain: MicGain; lang: string; transcribe: SegmentTranscriber; timer: SegmentTimer })
// cableSession.ts: VoiceTurn gains `micGain: MicGain`, read once at voice.begin as `micGainOf(msg.micGain)`, beside `rate`
// __fixtures__/voiceVectors.ts
export interface VoiceVectors {
  gains: Array<{ gain: MicGain; loud: number; steps: number[] }>
  clips: Map<string, { pcm: Buffer; heard: Map<MicGain, boolean> }>
}
export function voiceVectors(): VoiceVectors   // read once, cached; rate 16000 asserted
```

The gate's level comes from one record, `{ 37.5: 600, 30: 250 }`. The class comment says the gate follows the dial's
mic gain, and reads the PCM the dial sent, before `voiceGain.ts` raises it.

- [ ] **Step 1: Write the failing tests.**
  - `voiceLevel.spec.ts`: every `new VoiceLevel(rate)` passes `DEFAULT_MIC_GAIN`. The case "a block is loud only when
    its mean is over 600" is replaced by these. `heardAt(gain, ...parts)` is `new VoiceLevel(16_000, gain)` fed each
    part, then `read().heard`, and `tone` is the file's own alternating ±amplitude helper:

```ts
const { gains, clips } = voiceVectors()
it('has levels for the gains the dial firmware has, and no other', () =>
  expect(gains.map(g => g.gain)).toEqual([37.5, 30]))
it.each(gains)('at $gain dB a block is loud only over $loud, as on the dial', ({ gain, loud }) => {
  expect(heardAt(gain, tone(400, loud))).toBe(false)
  expect(heardAt(gain, tone(400, loud + 1))).toBe(true)
})
it('hears each shared clip as the dial does, at each mic gain, whole or split at an odd sample', () => {
  for (const [name, clip] of clips) for (const { gain } of gains) {
    expect([name, gain, heardAt(gain, clip.pcm)]).toEqual([name, gain, clip.heard.get(gain)])
    expect([name, gain, heardAt(gain, clip.pcm.subarray(0, 2 * 4001), clip.pcm.subarray(2 * 4001))])
      .toEqual([name, gain, clip.heard.get(gain)])
  }
})
it('micGainOf takes 37.5 and 30, and reads anything else as 37.5 dB', () => {
  expect(micGainOf(30)).toBe(30); expect(micGainOf(37.5)).toBe(37.5)
  for (const value of [undefined, null, '30', 27, 0, -30, 1e9, true, [30], {}]) expect(micGainOf(value)).toBe(37.5)
})
```

  - `voiceSegments.spec.ts`: `setup()` takes `micGain?: MicGain` (default `DEFAULT_MIC_GAIN`); "the level matches the
    whole recording" builds `new VoiceLevel(16_000, DEFAULT_MIC_GAIN)`. A new describe, `"the dial's mic gain and the
    raise"`, uses the vectors' clips, with transcripts answered:
    - `'the gate follows the dial\'s mic gain'`: speech30 at `micGain: 30` → `level().heard` true; at 37.5 → false.
    - `'the gate reads the audio as the dial sent it, before the raise'`: speech30 at 37.5 → `level().gain`
      ≥ 5 and `heard` false, while `new VoiceLevel(16_000, 37.5)` fed the uploaded bytes hears it.
    - `'speech at 30 dB goes up raised back by about the 7.5 dB the mic lost, and the raise clips nothing'`: speech30
      at 30 → `level().gain` between 5 and 8 (6.5 dB on these vectors, logged as 7), and no uploaded sample is 32767
      or -32768. speech37 at 37.5 goes up byte for byte (`toEqual` the clip), with `gain` 0.
    - `'loud speech at 30 dB goes up as it came and unclipped, where at 37.5 dB the mic clipped it'`: loud30 at 30 →
      uploaded `toEqual` the clip, `gain` 0, `clip` 0; loud37 at 37.5 → `clip` above 0.
  - `cableVoice.spec.ts`, beside the `no_speech` and `no_words` cases:
    `'each voice turn reports one end: the gate reads the dial\'s micGain, 37.5 dB for none or one without levels'`.
    For each `[micGain, code]` of `[30, 'no_words']`, `[undefined, 'no_speech']`, `['30', 'no_speech']`,
    `[27, 'no_speech']`: `talk({ transcribe: async () => '' })`, a `voice.begin` with `agentId: 'a1'` and that
    `micGain` (left out when `undefined`), speech30 in frames of 8,000 bytes, `voice.end`; expect
    `[[{ outcome: 'failed', code, agentId: 'a1' }]]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/voiceLevel.spec.ts src/cable/voiceSegments.spec.ts src/cable/cableVoice.spec.ts`.
  Expected: FAIL. `micGainOf` is not exported; speech30 is not heard at 30 dB (the gate is still 600); the
  `micGain: 30` turn reads `no_speech`.
- [ ] **Step 3: Implement** the interfaces above. `cableSession.ts`: `micGain: micGainOf(msg.micGain)` beside `rate`
  in the `VoiceTurn`, with a comment that, like the rate, it is the dial's own statement about its audio; then
  `const { rate, micGain, lang } = this.voice` into `new VoiceSegments`. `voiceSegments.ts` passes `options.micGain`
  to `VoiceLevel`. Its `add()` comment notes that the gate reads `pcm` before `raised()`.
- [ ] **Step 4: Run** `npm run typecheck`, then `npx vitest run src/cable`. Expected: PASS. The turn-line cases in
  `cableSession.spec.ts` are unchanged and pass: no `micGain` is read as 37.5 dB, as before.
- [ ] **Step 5: Commit**: the red commit, then the code (`cli: the dial's voice gate follows the micGain it states`).

---

## Verification

**Local gates**, from a clean tree at the final commit, on the Mac (ask first whether it is free). Paste the outputs
in the PR body.
1. **Firmware host suite** (`make device-test`, with the SDK's cJSON):
   `IDF_PATH=$HOME/esp/esp-idf-5.5.4 bash devices/harness-device/firmware/test/run.sh`. Expected: exit 0 in about
   2.5 minutes. The output includes the voice_buffer line naming 7 shared clips, `Audio gain: … PASS` and the
   `Outbound JSON: … PASS` line.
2. **Firmware build, host only.** `FW/README.md` documents it, and ESP-IDF 5.5.4 is at `~/esp/esp-idf-5.5.4`, so it
   is a check here. No PR CI job builds the round dial (only the Pro's `pro-firmware-build`):
   `. ~/esp/esp-idf-5.5.4/export.sh && idf.py -C devices/harness-device/firmware -B "$SCRATCH/round-build" build`,
   with `$SCRATCH` a scratch folder outside the repo. Expected: `Project build complete` and the app-size check
   passes. Then `git status --porcelain devices/harness-device/firmware` lists no tracked file (`dependencies.lock`
   unchanged). Delete the scratch folder after. Never flash, monitor, run `esptool` or open a serial port. If
   `export.sh` cannot set up its tools, report the check as not run, with the reason.
3. **CLI:** `cd cli && npm run typecheck && npx vitest run src/cable`. Expected: PASS.
4. **Required local checks:** `python3 scripts/local-checks.py --run`. Expected: `No local check is required.` (no
   path under `cli/src/core`, `cli/src/services` or the serial and PTY sets).
5. **Harness Pro untouched:** `git diff --stat origin/main -- devices/harness-pro` prints nothing. Its suite runs in
   `firmware-checks`.

**PR CI** (selected by `scripts/ci-plan.py`, nothing dispatched by hand): `cli-typecheck` and `cli-tests` (which read
`FW/test/vectors/`, `PR_READS["cli"]`), `windows-e2e` x64 (any `cli/src/cable/` path), `firmware-checks` (every
`FW/test/test_*.py` with `IDF_PATH`: the new `test_voice_buffer.py` and `test_audio_gain.py`, and
`test_cable_outbound.py`; then the Pro's suite) and `process-checks`.

**End-to-end checks:** none automated, by design. The dial-to-daemon path is covered at both ends with no person and
no backend. `test_cable_outbound.py` checks the bytes the dial writes, and `cableVoice.spec.ts` checks what the
daemon does with them, over the loopback port with a stub transcriber. No account or backend is involved. A true end
to end needs a dial running the 30 dB image, which only a flash or an OTA can give it, and implementers never flash.
- **The field check is Diego's.** After the CLI release carrying Task 4, an OTA he approves, his dial and his eye. On
  his Mac, from normal use, the `cable: voice turn` lines in `~/.harness/cli/data/harness.log` should show `clip`
  near 0 on speech, RMS about 7.5 dB lower than before, the host's `gain=` about 6 to 7 dB on typical speech, and
  `heard=1` on speech. The daily integration report shows the `no_speech` and `no_words` shares before and after.
  His eye checks that the listening animation looks as it did. Only the field shows whether 30 dB still clips on real
  speech; fallback B (27 dB) is decided from these numbers.

**Proposals, not added here:**
- A round-dial `idf.py build` job in `ci.yml` like `pro-firmware-build`. Until then, check 2 is local.
- `firmware-checks` running the round dial's other `run.sh` C tests. Only `test_*.py` run on CI today; this plan
  moves just `test_voice_buffer.c` behind a driver.

**PR-body notes:** decisions 1 and 2 of the spec. `micGain` is optional, so the protocol version stays 3. The host
side must reach a CLI release before the firmware upload: any CLI pushes the newest published image
(`CB/fwPush.ts`), so a computer whose CLI has not updated reads that dial's quiet speech at 600 and counts it
`no_speech` until it updates. Platforms: the ESP32-S3 round dial; the CLI on macOS, Linux and Windows. Evidence: the
red-then-green commits, the outputs of checks 1-5.

## Decisions

Made while planning, from the spec, the code and the coordinator's message of 2026-11-25:

1. **A table, not a formula.** Two rows of integers are identical in C and TypeScript by construction, and the
   vector file pins them for both. The firmware's capture loop gains no `pow()`. The rows hold the spec's own 250
   (the formula gives 253, a 0.1 dB difference). The cost: a new gain needs a row on both sides, with the CLI's row
   released first, which is the order this change already needs.
2. **The 30 dB row:** gate 250 (spec, decision 2). Meter steps are each 37.5 dB step × 10^(−7.5/20), rounded:
   27/76/211/675 (the spec: "scaled by the same factor").
3. **The gain reaches the gate as an argument** (`mic_gain_db`), from the one caller that already passes `rate`. One
   test binary can then run both gains. The spec's "read by `voice_gate_feed`" holds through that caller, and the
   constant is still read in three places only: `audio_capture_start`, `cable_client_voice_begin` and the capture
   loop.
4. **A gain without levels reads as 37.5 dB** on both sides: `micGainOf` on the host, the table lookup on the dial.
   It is the same rule as "a dial that sends none".
5. **Harness Pro's copy of `voice_buffer.c` is not touched.** It is a separate file with its own callers, so nothing
   needs changing for it to build. The two copies stop being byte-identical, and no test or tool relies on that.
6. **The vectors live in `FW/test/vectors/`**: binary PCM plus a text index, read in place by both sides, with no
   copy and no sync script. The CLI's CI already reads that folder.
7. **The C twin runs on PR CI** through `test_voice_buffer.py`.
8. **`micGain`, not `gain`** (coordinator), so the dial's analog gain cannot be read as the host's `gain=` (#4606).
9. **`voiceGain.ts` needs no change.** At 30 dB, speech whose 20 ms frames' 90th percentile falls under
   `VOICE_TARGET` (2000) is raised back. Typical speech (2000 to 2500 at 37.5 dB, so 850 to 1050) comes up 6 to 7 dB,
   well within `MAX_GAIN` (+18 dB). The transcriber gets about the old level without the ADC's clip. A raise reaches
   full scale only for a peak more than about 24 dB over that percentile (32767 / 2000), beyond the 15 to 20 dB the
   spec gives for speech peaks over RMS. Loud speech (at or over 2000 at 30 dB) goes up as it came. Task 4 pins both
   cases.
10. **`docs/product-measurement.md` is unchanged.** Its `no_speech` ("the dial firmware's voice gate hears no 320 ms
    of loud 10 ms blocks in a row") names no threshold, so it stays true at any gain.
11. **The round firmware's `idf.py build` is a Verification check** (local, never flashed).
