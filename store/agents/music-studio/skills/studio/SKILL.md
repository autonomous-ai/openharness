---
name: studio
description: Compose and revise complete original music from a brief or the user's MIDI and recordings, with editable notes, arrangements and real WAV/stem/MIDI/project delivery.
---

# Make the composition, not another loop demo

Read the current `piece/session.json` and the person's brief. Blue Hour is an example of one
48-second cue, not a template genre. Write a different score and structure for a different task.
The agent does the programming and musical construction; the person speaks in Harness chat and
uses a normal piano roll and mixer.

## Score format

`spec: "afterhours/1"`, stable lowercase `id`, `title`, `brief`, `seed`, `tempo` (30–240),
`meter: [numerator, denominator]`, `beats` (quarter-note units), `tail` (0–6 seconds), `master` (0–1).
Optional `tempos` is an ordered array of `{beat,bpm}` beginning at zero. With no map, `tempo` is
constant. The timeline must fit four minutes; `tail: 0` gives an exact cut when the brief requires it.

Each of at most 16 tracks has `id`, `name`, `instrument`, `notes` and optional `clips`. Notes are:

```json
{"beat": 4, "duration": 1.5, "midi": 66, "velocity": 0.72}
```

A MIDI pitch of 60 is C4. Import `noteNumber`, `secondsAt` and `beatAt` from `studio/session.mjs`
when writing a generator. These are scheduling utilities, not a restricted style vocabulary.
Use arbitrary voicings, motifs, rhythms, tempo changes and forms. Separate the roles of melody,
harmony, bass and rhythm. Use negative space and deliberate dynamics instead of filling every cell.

Note velocity must be 1/127–1 so MIDI can represent it as a note-on. For silence, remove the note
or mute its track. Section markers and the intended end are included in MIDI, preserving a quiet
ending after the last note.

Instruments: `felt`, `pluck`, `pad`, `bass`, `bell`, `lead`, `drums`, `sampler`, `audio`.
They are synthesized voices or supplied recordings, not claims of sampled acoustic instruments.
A track's `gain`, `pan`, `attack`, `release`, `tone` (filter Hz), `space` and `delay` shape its sound.
The drum voice uses GM pitches (36 kick, 38 snare, 42 closed hat, 46 open hat). A sampler adds
`sampleId` and `sampleRoot` (original MIDI pitch). A standard MIDI program number can be retained
as `midiProgram` for the DAW handoff; a plugin's sound is not encoded in the MIDI file.

Sections are `{name, beat, length}` and describe actual spans in the score. They are not a fixed
verse/chorus template. The UI can repeat a selected eight-bar window, edit note start/pitch/length/
velocity, move notes, transpose tracks, add instruments and edit the mix.

## The user's own material

Audio assets: `{id, name, file}` with `file` relative to `piece/`, or an embedded `data` audio URL.
The build embeds WAV, MP3, M4A or OGG. Use WAV/MP3 for broad decoder support. A track's clips are
`{assetId, beat, offset, duration, gain, fadeIn, fadeOut}`; offsets and durations are in seconds,
position is in beats. Recording import in the pane creates a real audio track, not a visual proxy.

`node tools/import-project.mjs FILE` opens an editable project or MIDI and backs up the source.
MIDI import handles notes, tempo changes, one time signature and initial volume/pan. It reports
unsupported controllers and pitch bends. A performance that depends on sustain, expression or
pitch bends needs its original audio or further tool integration; do not discard that silently.
Keep the supplied originals. Never invent that you heard, extracted or transcribed a melody.

## Build and handoff

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs
```

`MUSIC_DSH_DIR` locates the installed tools. Setup pins Playwright and MIDI libraries locally and
uses Chrome or installs local Chromium. The emitted studio works offline; it has no CDN or paid
music-generation dependency. The engine account already configured in Harness does the authoring.

The production ZIP contains aligned WAV stems, the mix, MIDI and project. The stems use one common
gain and include each audible track's effects, so align them all at time zero. MIDI does not carry
recordings or effects, and preview patches are not the same as every DAW's instruments. Deliver
both forms. Preserve the project so revision is possible without reverse engineering a WAV.

## Review the actual music

The export command opens the browser, exercises playback and writes the real deliverables. It
measures duration, peak, RMS and repeatability, and deliberately leaves `ready:false`.

Inspect exported WAV with an independent decoder and exported MIDI with an independent reader.
Verify the requested duration, notes, meter, tempo changes, audible tracks, recording positions
and stem alignment. Then listen from start to finish: transitions, timing, voicing, loudness,
tails, intended space, clicks and the ending. Revise and listen again when a change affects sound.
Do not substitute a waveform screenshot or a green test for this judgment. Record exact evidence
and limitations in `piece/DESIGN.md` and the verdict. Never invent listening evidence.
