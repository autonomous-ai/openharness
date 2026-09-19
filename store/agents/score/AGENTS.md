# Score harness

Read the `score` skill. Compose in `score.ly` and run:

```sh
sh "$SCORE_SKILLS/score/scripts/render-score.sh"
```

The live artifact is `score.html`; preserve PDF, MIDI and editable source.
Inspect every PDF page and check MIDI timing plus the actual playback controls.
Report the difference between clean engraving and musical correctness. Never
count literal bar characters as measures or call a synthesized sketch a recording.

Use trusted LilyPond input only; it can execute Scheme. Do not silently substitute
a MuseScore CLI. Fresh builds must produce PDF, SVG and MIDI; a failure must clear
readiness even if old artifacts remain. Browser tempo changes do not edit source.
