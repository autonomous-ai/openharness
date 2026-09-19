# Score · Folio

Compose in text; read and hear the result. Folio combines LilyPond's real
engraving with a local MIDI sketch: play/pause, seek, change playback speed,
adjust volume and zoom the score. Download the printable PDF or the MIDI.

The starter, **Lighthouse at Dusk**, is an original 16-bar piano study in E minor,
6/8. It engraves to one page and 142 MIDI notes (about 35.6 seconds).

## First run

Install `autonomous/score` from the Harness Store and install
[LilyPond](https://lilypond.org/download.html) separately. Tested with 2.26.0;
the source targets 2.24.3 or later. Set `LILYPOND_BIN` if it is not on PATH.
The managed helper finds Node 20+ without a global npm installation.

```sh
sh "$SCORE_SKILLS/score/scripts/render-score.sh"
```

Ask: “Turn the opening into a gentle duet, keep the 6/8 pulse, and render a
score I can print and listen through.” Edit `score.ly`, then rebuild. The pane
shows `score.html`; the durable outputs are `score.pdf`, `score.midi` and the
editable source. Browser tempo/volume/position changes are listening controls,
not saved changes to the composition.

## Verification and limits

Each build starts unready, invokes LilyPond twice for fresh PDF and SVG pages,
treats warnings as errors, and parses MIDI note timing. Missing output or bad
source fails without claiming an old score is new. Inspect `.harness/render.log`
and `.harness/score.json`. Actual engraving and desktop/mobile browser controls
were checked; unit fixtures also cover note timing and failure handling.

Playback is a simple triangle-wave sketch, not a sampled piano or a human
performance. It ignores sustain pedal, instrument changes and expressive
controllers. MIDI type 0/1 with PPQ timing is supported; maximum preview is
10,000 notes, one hour and 40 engraved pages. It does not prove a piece is
playable, musically correct or licensed for use. A `|` in LilyPond is a bar
**check**, not an instruction that ends a bar; no literal-character measure
count is reported.

This workflow supports LilyPond sources with layout and MIDI blocks.
MuseScore conversion is not implemented. LilyPond source can execute Scheme;
only render trusted sources.

## Credit and stewardship

LilyPond is the LilyPond project's separately installed GPL notation engine.
The MIT-licensed Folio wrapper, viewer, MIDI inspector and starter composition
are original OpenHarness work. No LilyPond binary or source is vendored.
