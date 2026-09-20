# Music Studio — Afterhours

Install **Music Studio** from the Harness Store, then create a new workspace to try the rebuild.
See [the product review](../../../work/SUPERPOWERS.md) for validation progress.

![Music Studio logo](brand/logo.svg)

Describe a piece you want to make. The agent composes an original arrangement, then you can edit
notes, timing, sections, instruments and the mix. Bring your own MIDI or recordings. Deliver a
stereo WAV, separate tracks for a DAW, editable MIDI and a complete project you can reopen.

The example is a 48-second documentary cue with five sections. It is a starting piece, not a
limit on genre or a fixed loop. For a new brief the agent writes a new score.

## What you can do

- Edit pitches, note lengths, starts and velocities in the piano roll; drag notes and undo/redo.
- Add instruments, repeat sections, transpose tracks, change tempo, mute/solo and shape the mix.
- Open MIDI notes and tempo maps, add your own recordings, trim/place clips, or play a recording
  as a pitched sample. MIDI automation and pitch bends are reported as unsupported on import.
- Export 48 kHz stereo 16-bit WAV, aligned stems, MIDI, the editable project and portable HTML.

Browser edits autosave locally and stay recoverable when the agent changes the source. Save the
project to move it between sessions or attach it to the agent; local drafts do not write into the
source score automatically. The production ZIP contains the exact notes, mix and embedded audio.

## Authoring and verification

The source score is `piece/session.json`. Build with `node tools/build.mjs`; check source/preview
agreement with `node tools/check.mjs`; export the actual files with `node tools/export.mjs`.
`node tools/import-project.mjs FILE` imports a saved project or MIDI and keeps a source backup.

Setup installs pinned browser/MIDI tools locally. Node.js 20+ and npm are required for authoring;
the exported studio needs only a browser. The harness uses the coding-engine account already
configured in Harness and no additional remote music-generation service.

The renderer measures headroom and timing; the exporter verifies playback and repeatability.
These checks do not establish musical quality. The complete piece still needs a listening review.
Synthesized voices are not recorded acoustic instruments or generated singing. MIDI patches may
sound different in a DAW; use stems for the actual sound. Work is bounded to four minutes, 16
tracks, 16,000 notes and 28 MB of embedded project data; longer projects can continue in a DAW.

## Credit and stewardship

Original studio and identity by OpenHarness contributors, maintained by Autonomous under the
[MIT license](LICENSE). MIDI I/O uses [@tonejs/midi](https://github.com/Tonejs/Midi), midi-file and
array-flatten; their MIT licenses are retained in `template/studio/vendor/`. Playwright is a
separate Apache-2.0 dependency by Microsoft. Report issues in the OpenHarness repository.
