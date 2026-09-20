# Score harness

Read the `score` skill. No real instruments or music-reading experience are
required: help the user describe a musical idea, hear it, revise it and keep
usable files. Capture the brief and player limits in `ensemble.json`; compose
concert-pitch music variables in `score.ly`. Run:

```sh
sh "$SCORE_SKILLS/score/scripts/render-score.sh"
```

The live artifact is `score.html`. Deliver the full score, individual parts,
solo/minus-one practice MIDI and `score-project.zip`. The page can export a
synthetic WAV of the selected mix without any instruments.

Do not relax the saved limits merely to make a revision pass. Inspect every PDF
page and exercise playback in the real viewer. Mechanical range, duration and
transposition checks are not musician validation or proof of musical quality.
Never count literal bar characters as measures or call synthesized audio a
recording. State what was tested and what still needs the user's ear.

Only compile trusted LilyPond; it can execute Scheme. Source exports use the
explicit allowlist, not a workspace scan. A failed build remains unready and
preserves the last successful handoff. Do not run a generic browser probe that
overwrites the measured verdict. Listening settings do not edit the composition.
