---
name: produce-an-episode
description: Turn a raw recording into a levelled master — intake and measurement, cutting dead air, repairing a noisy or clipped track, matching two speakers, placing theme music, and hitting the loudness target. Read this before touching a recording, and again whenever the measurement comes out wrong.
---

# Produce an episode

Every command here was run against this package's pinned ffmpeg 9.0.2 and the numbers quoted are
what came back. Run them from the workspace; `ep` finds `episode.json` by walking up from wherever
you are. `"$EPISODE_FFMPEG"` and `"$EPISODE_FFPROBE"` are that same pinned build, for when you want
to look at a file yourself; everything that changes the episode goes through `ep`.

## The shape of the work

```
raw/*.wav          episode.json         work/session.wav      work/master.wav      dist/
the person's  →    the plan        →    repaired, matched, → cut, music,     →    what they
recording          (you write this)     one timeline         levelled              upload
```

`episode.json` is the plan and rendering is a pure function of it. You never edit audio; you edit
the plan and re-render. That is what makes a revision cheap and what stops you losing anything the
person approved.

## 1. Intake: find out what you are actually dealing with

```bash
"$EPISODE_TOOLCHAIN/ep" intake
```

It reads everything in `raw/`, decides which files are voice and which are music (a file with
`theme`, `music` or `sting` in its name is music; `--music FILE` forces it), and measures each one.
The first time it sees a recording that is not part of the shipped example, it puts the example
away in `.harness/history/example/` and starts a blank episode, so nothing of it can leak into
the person's:

```
ok   raw/guest.wav — 0:44 · -35.8 LUFS · peak -14.1 dBTP · floor -50 dBFS · 1ch 48000 Hz
     ⚠ speech sits only 19 dB above this track's room tone (-32 against -50 dBFS). Set
       clean.denoise=26 and clean.gateDb=-40 for it, then listen to the ends of words before
       going further.
ok   raw/host.wav — 0:44 · -18.0 LUFS · peak -3.4 dBTP · floor -60 dBFS · 1ch 48000 Hz
ok   treating 2 voice tracks as parallel (one conversation, mixed together)
```

**Read every line before you do anything else.** It has already written its recommendations into
`episode.json`, and it tells you what kind of job this is:

| What you see | What it means | What to do |
|---|---|---|
| two tracks of similar length | a remote interview, one file per speaker | leave it parallel; they are mixed onto one timeline |
| tracks of very different lengths | separate takes | `ep intake --layout sequential`, or set each source's `offsetSec` |
| `speech sits only N dB above…` | a noisy mic | take the `clean.denoise` and `clean.gateDb` it suggests |
| `clipped samples` | the mic was driven too hard | set that source's `clean.declip: true`; it will still be audible, say so |
| a voice at `-35 LUFS` next to one at `-18` | normal; they get matched automatically | nothing |
| `floor -120 dBFS` | a synthesised or gated file, usually the music | nothing |

**The two timelines.** *Session* time is the recording as it happened: every voice source at its
`offsetSec`, mixed. *Output* time is the finished episode: the kept session ranges joined, shifted
by `voiceOffset` to leave room for a cold open, with the music over the top. Cuts are session
ranges, so a cut removes the gap from every speaker at once. Chapters and the transcript are
output time.

## 2. Set the frame

```bash
"$EPISODE_TOOLCHAIN/ep" set \
  title="What broke in year two" show="Shipping Notes" author="Ada Rowe" \
  episode.number=14 target.preset=apple \
  transcript.vocabulary='["Mara Oyelaran","nucleo","Shipping Notes"]'
```

Keys are dotted paths into `episode.json`; a value that parses as JSON is stored as JSON. You can
also just edit the file. **Set the vocabulary now**, before transcription: it is the single biggest
thing that decides whether names come out right (see `publish-the-episode`).

### The targets

```bash
"$EPISODE_TOOLCHAIN/ep" targets
```

| Preset | Integrated | Tolerance | True peak | Use it when |
|---|---|---|---|---|
| `apple` | -16 LUFS | ±1 LU | -1 dBTP | the default; Apple Podcasts' own published figure |
| `aes-speech` | -18 LUFS | +1 LU | -1 dBTP | AESTD1008 Table 1 for speech; a talk show with music |
| `spotify` | -14 LUFS | ±1 LU | -1 dBTP | the person wants no gain applied on Spotify |
| `ebu-r128` | -23 LUFS | ±0.5 LU | -1 dBTP | it is going to a broadcaster |

Set `target.lufs` directly for anything else. Say which one you used and why, once.

## 3. Cut

```bash
"$EPISODE_TOOLCHAIN/ep" cuts                      # the default: gaps over 1.2 s shortened
"$EPISODE_TOOLCHAIN/ep" cuts --max-gap 2.0 --keep 0.5   # a slower, more conversational show
"$EPISODE_TOOLCHAIN/ep" cuts --no-head-trim       # keep the silence at the front
"$EPISODE_TOOLCHAIN/ep" cuts --restore 3          # put removed range 3 back
```

```
     room tone -38 dBFS, speech -16 dBFS, so silence is quieter than -32.5 dBFS
     4 gap(s), 0:08 of dead air out; 0:36 kept in 3 range(s)
```

It finds silence from RMS windows with a threshold derived from *this* recording's room tone, not
from a constant. (ffmpeg's own `silencedetect` measures instantaneous amplitude, and hiss peaks
sit 10–12 dB above its RMS: on a track with a -43 dBFS room tone it found **zero** gaps where
there were six. That is why this is measured here instead.)

Gaps are **shortened to `--keep` seconds of air, not removed**. A join with no air left in it is
how a listener hears that a machine did the edit.

### Cutting something specific

`ep cuts` only knows about silence. When the person says "drop the bit where the dog barks around
4:10" or "cut the first eight minutes", edit `voice` in `episode.json` yourself. It is a list of
kept session ranges, in order:

```json
"voice": [
  { "in": 0.0,   "out": 250.0 },
  { "in": 262.5, "out": 1840.0 }
]
```

and record what you took out in `removed`, so the pane can show it and offer it back:

```json
"removed": [ { "start": 250.0, "end": 262.5, "reason": "dog barking" } ]
```

To find the moment, look in `transcript.json` if you have one, or in the source's `probe.silences`
in `episode.json`. Cut **into the silence on both sides**, never mid-breath — the person will hear
a splice that lands on a consonant.

## 4. Repair

`clean` in `episode.json` is the default chain for every voice; `sources[].clean` overrides it for
one track, which is what you want on a multitrack where only one mic was bad.

```json
"clean": {
  "highpassHz": 80,
  "denoise": 12,
  "declick": true,
  "declip": false,
  "deesser": 0.3,
  "gateDb": null,
  "compressor": { "thresholdDb": -20, "ratio": 3, "attackMs": 15, "releaseMs": 250, "makeupDb": 2 }
}
```

| Setting | What it does | When to move it |
|---|---|---|
| `highpassHz` | cuts rumble, handling noise, desk thumps | 80 is right for most voices; 100 for a boomy room; 60 for a deep voice |
| `denoise` | `afftdn`, thins steady hiss **under** the voice | from the SNR intake reported: under 20 dB → 26, under 26 → 20, under 32 → 15 |
| `gateDb` | silences a track **between** words | only when SNR is under 30 dB, and then at about halfway up from the floor |
| `declick` | removes mouth clicks and tiny dropouts | leave on |
| `declip` | `adeclip`, reconstructs a clipped waveform | when intake reported clipped samples; it helps, it does not cure |
| `deesser` | tames sibilance | 0.3 default; up to 0.5 on a bright mic. Over 0.6 and the voice lisps |
| `compressor` | evens out someone leaning in and out | ratio 3 is conversational; ratio 5 for a very uneven speaker |

**Denoise and gate do different jobs and a bad track needs both.** Measured on a 19 dB-SNR track:
denoise alone got the session to 25 dB; denoise plus a gate at -40 dB got it to **37 dB**.

Two facts about the denoiser that only show up if you measure it, and which the toolchain now
handles for you: its noise-floor parameter is set from each source's own measured floor (with
`nf=-35` on a track whose floor is -50 dBFS it reached -52.8 dBFS; with `nf=-50`, -56.6), and its
noise-*tracking* mode is left off, because tracking adapts to steady room tone and under-reduces.
Set `"trackNoise": true` on a source only when the noise genuinely changes through the recording.

**Go gently and check by ear.** Over-processing is the usual failure of an automated podcast tool.
After raising anything, run `ep review` and read the clips it writes.

### One range at a time

A kept range may carry corrections that apply to that stretch and nothing else. This is what a
single room microphone with three people around it needs, because `clean` is per *source* and the
source is the same microphone for all of them.

```json
"voice": [
  { "in": 95.8, "out": 103.1, "gainDb": -4.0, "note": "moderator — question 1" },
  { "in": 154.8, "out": 163.7, "gainDb": 6.5, "presenceDb": 5.0, "note": "the panellist at the far end" }
]
```

| field | what it does |
|---|---|
| `gainDb` | level for this range alone |
| `presenceDb` | a peaking lift at 4.5 kHz — what a distant microphone is missing |
| `warmthDb` | a peaking lift at 220 Hz — for a thin voice; go gently, it muddies fast |
| `note` | who or what this range is; it shows in the pane and in the review evidence |

**Level and presence are different problems.** A microphone further away loses presence before it
loses level, so matching the level of a distant speaker leaves them sounding duller than everyone
else — and no amount of gain fixes it. Measured on the panel fixture: three stretches at the same
-16 dB speech level, the near speakers at -9 dB presence and the far one at **-15.5 dB**. A
`presenceDb` of 5 moved it to -12.5. Expect a little over half the dB you ask for, because the
band the measurement uses is wider than the filter. Check it in `ep review`'s table.

### Matching two speakers

Nothing to do: each cleaned voice is measured and given **plain gain** to bring it to an internal
working level, capped so the loudest peak keeps a decibel of room. Plain gain, not compression, so
nobody's dynamics get squashed twice. `ep render` prints how far apart they were, and the applied
figure lands in `sources[].matchGainDb`. Nudge one speaker with `sources[].gainDb`, which is added
on top.

## 5. Music

`music` in `episode.json` places cues on the **output** timeline. Set `voiceOffset` to leave room
for them at the top.

```json
"voiceOffset": 6,
"music": [
  { "source": "theme", "in": 0, "out": 14, "at": 0, "gainDb": 14,
    "fadeIn": 0.5, "fadeOut": 4, "duck": true }
]
```

- `at` is where the cue starts in the finished episode; `in`/`out` are the part of the music file.
- `duck: true` ducks it under the voices with `sidechaincompress` — the standard radio move.
  `duckThresholdDb` (-30) and `duckRatio` (8) tune it.
- **`gainDb` is relative to the file, so look at what intake measured.** A theme that measures
  -33.7 LUFS needs about +14 dB to sit properly under a voice bed. Too quiet and `ep check` says
  so: *"the music from 00:00 measures below the silence floor for 6 s — raise its gainDb"*.
- An outro is the same cue with `at` near the end and a long `fadeIn`.

## 6. Level

```bash
"$EPISODE_TOOLCHAIN/ep" render
```

```
     cleaning guest (guest.wav)
     matching 2 voices (up to 8.3 dB apart) and mixing the session
     assembling 3 range(s) and 1 music cue(s)
     measuring for apple (-16 LUFS, true peak -1 dBTP)
     levelling
ok   0:42 · -16.0 LUFS (on target, apple wants -16.0 ± 1.0) · true peak -1.0 dBTP · LRA 7.6 LU
```

Levelling is **two passes of `loudnorm`** — measure, then normalise with the measured values and
`linear=true`. One pass lands about 1.5 LU off and must never be used for a deliverable. Peak
control comes after the filtering, because filtering adds overshoot (AESTD1008 §7B).

Cleaning is cached per source against its settings and the file's timestamp, so a second render
after a chapter change costs seconds.

**If `render` says OFF TARGET**, the plan is wrong, not the levelling: an empty edit, a music cue
louder than the voices, or a source that is nearly silent. Look at `ep check`.

**Loudness range (LRA).** Speech wants roughly 4–12 LU. Above that the quiet parts vanish in a car;
below about 2 LU it is squashed flat and `ep check` tells you to ease the compressor.

## 7. Listen before you believe the numbers

```bash
"$EPISODE_TOOLCHAIN/ep" review
```

Writes `work/review/REVIEW.md` and a six-second clip around every splice and every chapter start,
with what the transcript says there. Read it. Two things no measurement catches: a splice that
lands mid-breath, and a voice the denoiser has made metallic. If either is there, change the plan
and render again.

## When something goes wrong

| What you see | Why | Fix |
|---|---|---|
| `miss episode.json names no voice source` | nothing in `raw/`, or intake not run | put the file in `raw/`, `ep intake` |
| `0 gap(s)` on an obviously gappy recording | the room tone is very high | that is the diagnosis: fix `clean.denoise`/`gateDb`, re-run `ep cuts` |
| `miss a music cue names a source that is not in episode.json` | the `source` id does not match | ids come from the filename; check `sources[].id` |
| `miss ffmpeg failed: … Could not open encoder` | a filter refused a setting | the last lines of ffmpeg's own output are printed; usually a setting out of range |
| the edit is much shorter than expected | `--max-gap` too small for a slow speaker | `ep cuts --max-gap 2.0 --keep 0.5` |
| `render` is slow on a long episode | cleaning every source | it is cached; only the first render pays |

Then go to `publish-the-episode`.
