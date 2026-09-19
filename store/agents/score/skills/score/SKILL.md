---
name: score
description: Compose trusted LilyPond source, engrave real PDF/SVG pages, inspect MIDI timing and audition notes in the Folio preview. Use for Score harness work.
---

# Compose, engrave, audition

1. Read `score.ly`. Keep key, meter, tempo, voices, dynamics and instrument names
   explicit. The original piano study is a starting point, not a musical constraint.
2. Keep both `\layout { }` and `\midi { }` blocks. Run:

   ```sh
   sh "$SCORE_SKILLS/score/scripts/render-score.sh"
   ```

3. LilyPond runs with warnings treated as errors. Correct bar checks, syntax and
   collisions rather than suppressing warnings. A `|` checks bar position; it
   does not end a bar. Count musical durations, not literal characters.
4. Inspect all PDF pages for spacing, collisions, page turns, staff labels and
   legibility. The fresh receipt reports engraved pages and MIDI notes, not a
   fabricated measure count.
5. Use Folio play/pause, seeking, slowdown and the pitch timeline to inspect the
   actual exported notes. Make compositional edits in source and rebuild.
6. Hand off `score.pdf`, `score.midi` and `score.ly`. State which checks ran.

## Boundaries

Requires LilyPond (tested 2.26.0) and Node 20+. `LILYPOND_BIN` overrides the
binary. This workflow does not implement MuseScore export. Only trusted input:
LilyPond can execute Scheme and read local files.

Fresh staged builds preserve old artifacts on compilation failure and set
`ready: false`. See `.harness/render.log`. Do not treat previous output as a
successful new render. Ready means engraving plus MIDI parsing, not proof of
musical correctness, performability or playback fidelity.

The browser uses a deliberately simple local synth. Pedal/controllers,
instrument timbres and human expression are not reproduced. Listening controls
do not persist. The parser supports type 0/1 PPQ MIDI, not SMPTE timing; preview
limits are 10,000 notes, one hour and 40 SVG pages.
