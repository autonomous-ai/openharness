# Strudel, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[Strudel](https://strudel.cc) — TidalCycles in JavaScript: describe a track in the chat pane and
hear it in the Strudel pane as the agent writes the pattern. Runs on Claude Code.

[Recorded performance walkthrough](../../../docs/images/strudel-live-take-demo.mp4) ·
[Desktop](../../../docs/images/strudel-live-take.png) ·
[390px pane](../../../docs/images/strudel-live-take-mobile.png).
The walkthrough performs the original [Lantern room](test/fixtures/lantern-room.strudel) source;
its preview video pairs the screen recording with the captured take's audio.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` + `pane/` — the pane: Strudel's own REPL as a web component, from the package's own
  `node_modules`, no CDN, with what it takes to *see* the music. A transport (Play/Stop, tempo, bar
  and beat, the output's waveform and spectrum); one lane per voice — the arguments of the top-level
  `stack(...)` or the `$:` lines, named after the comment above each — scrolling under a playhead,
  zoomable from 1 to 32 bars, with activity lights, Mute and Solo (`1`–`9`, `⇧1`–`⇧9`) and a hover
  inspector; the code once, lit per voice as it plays. A save hot-swaps the pattern without stopping
  the transport, and a save that does not run shows its error and line while the last good version
  keeps playing. `pane/voices.mjs` is the voice parser (`node --test pane/voices.test.mjs`).
- **Perform and keep.** Click Play, then **Record take**. Mute, solo, run a code change, or mark a
  moment while the track plays. **Finish take** opens the actual stereo recording, with a waveform
  and seekable moment buttons. Select a moment and **Loop moment** to audition its captured audio
  through the next marker or the end of the take. The waveform highlights the passage; **Stop
  looping** returns to the full recording. Name it and **Keep take**: the WAV, every successfully played code
  version, a timed performance journal and an **Audio + source** ZIP live in `out/takes/`.
  Open them again from **Takes**, including after restarting the pane. Listening to a take stops
  the live instrument; playing the instrument pauses the take. Failed saves retain the recording
  for retry or direct WAV download. Retrying a lost save response keeps one copy.
- Agent file changes wait during capture or when the editor has unsaved changes. **Load new
  version** applies the latest file when the performer is ready. Saving a take leaves the live
  `.strudel` file untouched; the take's source files are available for the next agent revision.
- `toolchain/verdict.py` — the check: the file parses with the same parser the REPL uses, has a
  pattern in it, and says whether it plays offline. `setup.sh` is `npm ci`.
- `skills/strudel/` — the Strudel skill (ours): mini-notation, synths, effects, song structure.
  `template/` — a starter track, synths only, so it plays with no network.

```sh
harness dsh check .                              # conformance
harness dsh install "$PWD" --link                # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py    # the verdict
python3 -m unittest toolchain/test_scripts.py    # setup, doctor, init, viewer.sh, with stub commands
node --test pane/voices.test.mjs                 # the pane's voice parser
node --test test/viewer.test.mjs                 # the pane server, over HTTP, with a stand-in REPL
node --test test/recording.test.mjs              # exact PCM capture, WAV and journal validation
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/performance-browser.mjs
# The browser check uses a real installed REPL, real Web Audio and disposable workspace/ports.
# CHROME overrides the Chrome executable; EVIDENCE chooses the evidence directory.
# LONG_CAPTURE=1 also records through the full two-minute limit and saves the complete WAV.
```

## What a take contains

Audio comes from Superdough's output gain through a separate AudioWorklet branch that emits
silence; the existing speaker route is unchanged. The WAV is stereo, 32-bit float, at the audio
context's actual sample rate, without normalization or clipping. On multichannel devices this is
Web Audio's stereo downmix. System volume, external MIDI instruments and other applications are
outside this capture. Synths work offline; samples must already be available to the engine.

Capture ends after 120 seconds or six million stereo frames, whichever comes first. Stopping the
transport, suspending audio or replacing its output ends the take too. An interrupted context
keeps the complete chunks already received. Unsaved recordings live in the current tab; **Keep**
or download before closing it. The pane warns before leaving with an unsaved take.

`take.json` stores source hashes, sample count, measured peak/RMS, WAV hash, cycle/tempo, mute/solo
requests and named markers. Gesture times use the audio context clock. The scheduler's lookahead
and effect tails can delay their audible result. The journal helps inspect and revise a performance;
it does not promise deterministic replay of gestures or random patterns. The WAV preserves what
was captured. External samples, custom imports and other source dependencies are not bundled.
The journal is bounded to 128 source versions (64 KB each, 512 KB total) and 4,000 events; reaching
its limit ends capture. A final in-flight code change can land as capture is stopping.

Writes require the page token and same-origin requests. Uploads are bounded to 50 MB, validated
before writing, and saved through an atomic directory rename. Source filenames in archives are
generated by the server; escaping symlinks are rejected. Captured source is editable code, so
review unfamiliar code before running it.

## What cannot be checked here

Whether the track sounds good. The verdict checks parsing and the browser acceptance test checks
real capture and playback. Signal measurements can verify silence, pitch and levels; they do not
establish musical quality. Listening and creative judgment remain part of the user's review.

## Credit and stewardship

Strudel is Felix Roos's and the Strudel contributors' — [codeberg.org/uzu/strudel](https://codeberg.org/uzu/strudel),
mirrored at [tidalcycles/strudel](https://github.com/tidalcycles/strudel) — and it is licensed
**GNU AGPL-3.0-or-later** (`LICENSE-strudel`). None of it is in this package. `toolchain/setup.sh`
installs `@strudel/repl` from npm into this package's `node_modules`, exactly as the Strudel project
publishes it, unmodified, and the pane serves it from there. The wrapper in this package — the
manifest, the pane server, the skill, the template, the verdict — is MIT (`LICENSE`), written by
Autonomous to bring Strudel into Harness, on the project's behalf, to bootstrap the catalogue.

If you maintain Strudel and want to own its Harness package, it is yours: open an issue on
[OpenHarness](https://github.com/autonomous-ai/openharness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Strudel belong upstream, bugs in
the wrapper belong here, and a newer Strudel is a bump in `package.json`.
