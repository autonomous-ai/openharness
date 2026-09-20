---
name: score
description: Turn a musical brief into editable concert-pitch music, checked instrument parts and a listenable practice pack in the Score harness. Use for composing, arranging and revising trusted LilyPond projects.
---

# From a musical idea to something the user can keep

The user does not need instruments or notation vocabulary. If they want to
listen, start with mood, purpose, duration and a useful instrumentation; state
assumptions and offer an audible first version. If they have real players,
capture each player's instrument, written range and experience. Do not turn the
starter trio or any particular difficulty limit into a universal requirement.

Read [the ensemble contract](references/ensemble.md) before changing player
setup, timing, difficulty or source exports.

## Compose and revise

- Save the actual brief, assumptions, timing, instrument transpositions and
  difficulty limits in `ensemble.json`. These are requirements, not values to
  infer from whatever the generated notes happen to contain.
- Compose reusable **concert-pitch** variables in `score.ly`; the builder adds
  the initial key, meter, tempo, printed score, parts and MIDI proofs. Do not
  transpose the source again for a B-flat part or override staff transposition.
- Give the music a deliberate shape: phrases, breathing space, contrast,
  accompaniment and an ending appropriate to the request. A successful compiler
  does not supply those decisions.
- Run:

  ```sh
  sh "$SCORE_SKILLS/score/scripts/render-score.sh"
  ```

- Inspect `.harness/score.json` and every printed PDF page, including individual
  parts. Check collisions, readability, instrument labels and sensible breaks.
  LilyPond warnings are errors. Correct the music or layout, not the warning policy.
- On a failed requirement, read `.harness/failed-score.json`. Fix the music while
  retaining the user's limits. Change a requirement only when the request
  genuinely changes; explain a conflict instead of quietly widening a range.
- For a targeted revision, verify the requested change and compare unaffected
  parts. Keep a useful previous version; generated handoffs are retained under
  `.harness/history/`.

## Hear and hand off

Use `score.html` in the actual viewer. Exercise play/pause, seeking into a held
note, player mute/solo, slowdown, bar loops and part selection. No instrument
is needed. The browser can save a WAV of the current mix/loop (up to 3 minutes).
Save/restore listening setup as JSON; no local storage is required.

The source-backed delivery is `score-project.zip`: full PDF/MIDI, individual
parts, slower solo/minus-one MIDI, the saved brief, allowlisted sources and
standalone rebuild tools. Test important downloads. Browser controls and WAV
exports do not change `score.ly` or the prebuilt practice MIDIs. To change the
composition, edit the sources and rebuild.

Report the version, checks and listening/visual review actually performed.
Offer concrete revisions in the user's language (“make the ending warmer,”
“remove the busy line”), not a requirement to learn notation first.

## Boundaries

Setup installs LilyPond 2.26.0 when needed on supported Macs/Linux x86-64; the builder
finds that managed runtime automatically. Node 20+ comes from the runtime helper.
`LILYPOND_BIN` overrides the binary. Only compile trusted input: LilyPond can execute Scheme and read local
files. The source allowlist makes delivery explicit; it is not a Scheme sandbox.
Do not add unrelated files, credentials or recordings to the portable project.

Ready means fresh engraving and the saved **mechanical** requirements passed,
not proof of musical quality, comfort, breath control, fingering, physical
playability or permission to use an arrangement. A synthesized sketch is not
a recording or sampled performance. No real-player testing is implied.

This checked workflow supports constant meter/tempo, complete bars and pitched
staves. See the contract for limits and excluded cases. Original native MIDI
is retained; practice exports and browser audio ignore pedal, bends and other
expressive controllers. The browser uses simple oscillators, not a sound library.

Legacy `score.ly` projects containing full layout/MIDI blocks still engrave
without an ensemble contract, but remain unready for checked delivery. Preserve
their source and extract music variables deliberately when upgrading. Do not
blindly replace a user's composition with the template.
