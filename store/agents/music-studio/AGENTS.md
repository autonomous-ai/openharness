# Music Studio — compose work the person can use

Turn the person's musical brief into a complete, editable composition. They should not need to
write code, know notation, or accept the example's genre. The preview is an authoring studio,
not a seed picker or a spectator visualizer. Read `skills/studio/SKILL.md`.

Start by reading `piece/session.json`. It is the actual composition: arbitrary notes, tracks,
tempo changes, sections, mix settings and embedded recordings. `piece/compose.mjs` is the example's
original generator; running it overwrites the score. Do not rerun it over approved edits.

## Complete the real task

1. Establish the purpose, duration, mood, musical material and required outputs. Use supplied MIDI,
   melody and recordings. If the request already gives enough information, start composing.
2. Write an original beginning, development and ending. Compose the notes and arrangement in
   `piece/session.json`, directly or with a new generator appropriate to the brief. Never merely
   reseed Blue Hour or rename its instruments and present that as the requested music.
3. Respect useful structure: a voiceover needs space, a loop needs a clean seam, a title cue needs
   a timed ending. Use note velocities, register, voicing, silence and instrumentation deliberately.
4. Run `node tools/build.mjs`. The pane exposes the actual arrangement, editable piano roll,
   track mixer, instrument envelopes and audio-clip controls. The user can revise individual notes,
   rearrange sections, import recordings and keep going without a code editor.
5. Run `node tools/export.mjs`. The `delivery/` folder contains stereo WAV, aligned WAV stems,
   standard MIDI, the editable project and a portable HTML studio. Open the real files with an
   independent reader, check timing and note content, and listen through the complete piece.
6. Revise what fails the brief. A playable buffer or technically valid MIDI is not musical quality.
   Record exactly what you inspected and heard, then update `.harness/verdict.json` honestly.

## Preserve the person's work

Keep approved notes, timing, recordings, mix choices and sections when making a targeted revision.
The browser saves drafts locally, supports undo/redo, and explicitly handles a conflict with a new
agent revision. Those local edits are not automatically written into the source score. Import a
saved `.afterhours.json` with `node tools/import-project.mjs FILE` before editing it. This keeps a
backup. Never claim to have read a browser edit you cannot access.

Use `node tools/import-project.mjs melody.mid` to start from a real MIDI composition. Notes, tempo
changes, initial volume/pan and one meter are imported. Controller automation, sustain and pitch
bends are not reproduced; the importer reports them. Preserve the original MIDI and use an audio
render of it when that performance data matters. Never silently call it a lossless MIDI roundtrip.

## Production truth

- This is local instrumental synthesis, composition and sampling. It does not generate a singer
  from lyrics or pretend that oscillators are an orchestral recording.
- The person can supply audio, use it as a track or pitched instrument, and export real audio.
- WAV is 48 kHz stereo 16-bit PCM. Stems share timeline, length and mix gain and follow mute/solo.
  MIDI contains all notes and tempo, not audio clips or effects; another DAW's patches may differ.
- Limits: four minutes, 16 tracks, 16,000 notes and 28 MB of embedded project data. For longer work,
  compose movements or continue in a DAW. A larger stem bundle can be exported in soloed groups.
- Do not promise a mastered commercial release from headroom measurements. Listening, musical
  judgment and the intended use decide readiness. Keep `ready:false` until that review is real.

The authoring rebuild is listed in the Store for user testing; listening review remains required.
The original simpler sequencer source is preserved under `store/tools/experiences/` in the
repository, along with the other parked harnesses.
