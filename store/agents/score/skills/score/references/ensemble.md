# Ensemble contract

`ensemble.json` is the saved musical brief; `score.ly` defines reusable music
variables in concert pitch. Do not derive or loosen requested constraints merely
to match a generated score.

## Fields

| Field | Meaning |
| --- | --- |
| `spec` | `1` |
| `title`, `composer` | Printed title and composition/arrangement credit |
| `brief`, `assumptions` | User intent and explicit assumptions; assumptions may be `[]` |
| `meter` | `[numerator, denominator]`; numerator 1–12, denominator 2/4/8/16 |
| `quarterBpm`, `bars` | Constant quarter-note tempo 20–240; 1–128 complete bars |
| `key` | Initial **concert** key: `{"tonic":"c","mode":"major"}` |
| `sourceFiles` | Explicit relative paths, including `score.ly` and `ensemble.json` |
| `practice` | `{"speed":0.75,"countInBars":1}`; speed .25–1.5, count-in 0–2 bars |
| `players` | 1–8 players; 1–2 staves per player, at most 15 staves total |

Key tonics use LilyPond's default Dutch spelling: c/cis/des/d/dis/ees/e/f/fis/
ges/g/gis/aes/a/ais/bes/b; mode is major or minor. The contract sets an initial
key signature, not a test that every note belongs to a scale.

A player:

```json
{
  "id": "clarinet",
  "label": "B-flat clarinet",
  "instrument": "B-flat clarinet",
  "midiInstrument": "clarinet",
  "soundingC": "Bb3",
  "staves": [
    {
      "id": "clarinet-line",
      "music": "clarinetMusic",
      "clef": "treble",
      "writtenRange": ["C4", "G5"],
      "maxPolyphony": 1,
      "maxLeapSemitones": 7,
      "maxAttacksPerBar": 4
    }
  ]
}
```

`soundingC` means **the concert pitch heard when this instrument reads C4**.
C instruments use C4; B-flat clarinet uses Bb3. Scientific pitch C4 is MIDI 60.
Transposition may be within two octaves. Confirm unusual instrument/register
choices rather than guessing. `midiInstrument` must be a LilyPond-recognized
pitched General MIDI instrument. Percussion, octave clefs and unpitched notation
are outside this checked workflow.

Player and staff IDs are unique lowercase names with letters/digits/hyphens;
`score` is reserved for the full-score selection. Music-variable names contain
letters only and are unique. Supported clefs: treble/bass/alto/tenor. A two-staff
player prints with a PianoStaff bracket.

Each staff has a required **written** range and maximum simultaneous notes
(1–10). Optional `maxLeapSemitones` (1–24) requires monophony and measures
successive notes, including across rests; it does not assess fingering.
Optional `maxAttacksPerBar` (1–64) counts distinct MIDI onsets, not tied notes or
individual notes within a chord. These are editable limits, not skill ratings.

## Source and timing

The builder places the initial key/meter/tempo before each variable. Do not put
book/score blocks in a new checked source, pretranspose written parts, change
MIDI instrument within a staff, or override `\transposition`. Dynamics, slurs,
rests, chord voicings and breaks belong in the music variables.

The supported time grid is constant: no pickup, mid-piece meter/tempo change,
unexpanded repeat structure, cadenza or zero-duration grace notes. If needed,
write an explicitly expanded complete-bar version and explain the change, or
keep it as legacy engraving without claiming checked readiness.

The builder measures end-of-track duration including rests against
`bars × numerator × 4/denominator` quarter notes. A literal `|` is a LilyPond
bar check, not a bar counter. Each staff gets independent concert and written
MIDI proofs; actual written pitches are range-checked. Each sounding part and
the full MIDI are compared with the concert proofs. A second native pass must
produce identical MIDI before the SVG preview is accepted.

## Portable files and failure handling

List every local `\include` dependency. Use relative paths, no symlinks, at most
32 sources of 1 MiB each; allowed source extensions are `.ly`, `.ily`, `.json`,
`.txt`, `.md`. `score-assets/`, `rebuild/` and `REBUILD.md` are reserved. The
portable ZIP is bounded to 32 MiB. Trusted Scheme can still read arbitrary
files; the allowlist is not isolation.

Fresh builds snapshot sources, hash-check them before publication, and acquire
`.harness/score-build.lock`. Do not remove a lock until its owner has stopped.
Staged output is installed with rollback; previous generated files are retained
under `.harness/history/`. Compilation or failed requirements keep the last
successful handoff and clear readiness. See `.harness/render.log`,
`.harness/failed-score.json` and the successful `.harness/score.json`.

The practice pack keeps one program per staff, reserves MIDI channel 10 for
count-in percussion, and checks the exported pitched notes after re-parsing.
Count-in uses denominator beats, or dotted-quarter pulses in compound 6/8,
9/8 and 12/8. Browser count-in follows the same pulse convention.

Preview limits: 10,000 notes, one hour, 40 pages per document. WAV export is a
mono 22.05 kHz PCM synthetic sketch, limited to 3 minutes including count-in.
It uses the current loop/speed/mix; the prebuilt MIDI practice pack uses
`practice` in the saved contract. Listening setup JSON is tied to the exact
source revision, so a stale setup is rejected after a composition change.
