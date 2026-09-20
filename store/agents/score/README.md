# Score · Folio

Describe a musical idea. Hear it, change it and keep the result. You do not need
an instrument or music-reading experience: Score turns your brief into editable
music, an audible sketch, printable parts and a portable practice pack.

Try: “Make a gentle, hopeful piece with a flute melody, clarinet reply and warm
cello. Let me hear each voice. Then make the ending quieter.”

## What you can do

- Compose and revise original music in plain language through the agent.
- Listen, isolate a player, mute a line, slow down or loop complete bars.
- Save the current mix as a **WAV sketch** you can play outside Harness.
- Get a full score and individual PDF/MIDI parts, including written transposition.
- Download slower solo and minus-one practice MIDI with a count-in.
- Keep the saved brief, editable music and standalone rebuild tools in one ZIP.

The original starter, **After the Rain**, is a 16-bar flute, B-flat clarinet and
cello miniature in 6/8. It is a starting point, not a required instrument setup.
Independent acceptance also covers an eight-bar flute/piano duet and an easier
flute revision that leaves the piano MIDI unchanged.

## First run

Install `autonomous/score` from the Harness Store and install
[LilyPond](https://lilypond.org/download.html) separately (tested 2.26.0).
Set `LILYPOND_BIN` if it is not on PATH. The managed helper finds Node 20+;
no global npm packages or audio service are needed.

Describe the music you want. The agent edits `ensemble.json` (brief and limits)
and `score.ly` (concert-pitch music), then runs:

```sh
sh "$SCORE_SKILLS/score/scripts/render-score.sh"
```

Open `score.html`. Listening needs no instruments. The synth is intentionally a
note sketch, not a sampled instrument or human performance. If you just want to
explore, start with Listen, Solo and the speed slider; you do not need to
understand the notation.

## Keep and share the result

`score-project.zip` includes:

- Full PDF and original native MIDI.
- Individual PDF/MIDI parts and slower solo/minus-one practice MIDI.
- The brief, allowlisted editable sources, and measured checks with source hashes.
- Standalone rebuild scripts and their license.

Extract it and run `node rebuild/build.mjs .` with Node and LilyPond installed.
No Harness account, npm dependency or Python installation is needed to rebuild.
The delivered HTML opens in a modern browser outside Harness.

Browser WAV exports use the **current** loop, speed, mix and optional count-in.
The prebuilt practice MIDIs use `practice` in `ensemble.json`. Neither changes
the composition. Save/restore a listening setup as JSON; it is tied to the source
revision and rejected after the source changes.

## What gets checked

The saved brief is independent of generated notes. The native build measures:

- Every staff's duration, including rests, against the requested complete bars.
- Constant meter/tempo, actual written range and maximum simultaneous notes.
- Optional limits on successive-note leaps and attacks per bar.
- Written versus concert-pitch transposition, and agreement between the full
  score, individual parts and independent concert-pitch proofs.
- Re-parsed practice exports, source hashes and identical MIDI across PDF/SVG passes.

A failed revision clears readiness and preserves the last successful handoff.
Previous generated files remain under `.harness/history/`; logs and receipts are
in `.harness/`. A literal LilyPond bar character is not used as a measure count.
See [acceptance evidence](test/ACCEPTANCE.md) and the
[contract reference](skills/score/references/ensemble.md).

## Limits

Mechanical checks do not certify musical quality, comfort, fingering, breathing
or physical playability. There has been no real-player validation. The original
native MIDI is retained, but browser audio and practice exports ignore pedal,
bends and other expressive controllers and use fixed synthetic timbres.

The checked workflow supports 1–8 players, at most 15 pitched staves, 1–128
complete bars, constant meter/tempo and 10,000 notes within an hour. No pickup,
meter/tempo changes, unexpanded repeats, unpitched percussion or zero-time grace
notes. Up to 40 engraved pages per document; WAV export up to 3 minutes;
portable ZIP up to 32 MiB. MuseScore conversion is not implemented.

Only compile trusted LilyPond: it can execute Scheme and read local files.
The explicit source allowlist is for portable delivery, not a Scheme sandbox.
Do not export secrets or unrelated workspace files.

Existing full-score LilyPond sources can still engrave without `ensemble.json`,
but remain unready for checked delivery. Upgrading requires preserving the music
and extracting its concert-pitch variables, not overwriting it with the starter.

## Credit and stewardship

LilyPond is the LilyPond project's separately installed GPL notation engine.
The MIT-licensed Folio wrapper, viewer, MIDI tooling and original starter/test
compositions are OpenHarness work. No LilyPond binary, font or sound library is
vendored. See [LICENSE](LICENSE) and [PROVENANCE](PROVENANCE.md).
