# Harness experience improvements · September 21

Branch: `codex/harness-improvements`, starting from `735471a1`.

## Product brief

Read the repository README, `docs/ideal-users.md`, the Store authoring guide, and the previous
experience rebuild reviews. Build for the curious engineer who wants to participate in the whole
idea: make, inspect, play, revise, and take the work away. Preserve the user's choices and editable
source. A themed preset or a green technical check alone is not evidence of a compelling product.

The full objective remains to review **every current harness**, prioritize the most promising
experiences, and improve the catalog. This log distinguishes source review, implemented changes,
runtime evidence, and remaining work. No subjective “10×” claim is inferred from tests.

## Review method and priorities

Inventory all package manifests, listing status, templates, viewers, domain instructions, and test
entry points. Review the actual interaction paths in the most promising packages first. Prefer
capabilities that connect immediate curiosity to an original, useful, editable result. Preserve
existing toolchains and authoring workflows; extend the place where people inspect and direct work.

1. **MuJoCo:** branch a real physics state, change the conditions, compare both futures, and retain
   the exact experiment. Existing live simulation is strong; repeatable user-directed comparison
   is the missing interaction. Implemented and verified below.
2. **Godogen / Phaser / Voxel Worlds / Game Master:** play, inspect a particular moment, and turn
   discoveries into precise revisions of an original game or world. Inspect existing version,
   input, and export paths before choosing implementation. Godogen/Game Viewer improvement
   implemented and verified below; the other three received source review in this pass.
3. **Blender / CAD / Generative Art / Creative Direction:** make direct exploration useful to
   the next authored revision; preserve approved versions and deliver usable assets.
4. **Music Studio / Strudel / Score / sound studios:** help people hear, shape and retain a musical
   idea; verify the listening and export paths as well as controls.
5. **Science, data, engineering, media, research, local AI, and unlisted experiments:** finish the
   individual review, prioritize findings by useful first result and ongoing human participation,
   then implement and verify the domain-appropriate improvements.

These are working priorities, not claims that the unreviewed runtime paths are deficient. The
existing `work/SUPERPOWERS.md` and subsequent rebuild reports contain useful historical evidence;
current files and fresh runtime checks decide the next action.

## Verification ledger

- Initial branch and worktree verified clean.
- Manifest/template/viewer/test inventory completed. Detailed domain and browser review ongoing.
- No installed package, running user session, published catalog, or existing project changed.
- New implementation and test results will be recorded below as they are verified.

## First improvement: MuJoCo's What if lab

Implemented a reusable physics experiment, available on any loaded model:

- Pin a complete integration state from live simulation or a recorded frame. Compare two futures
  from that state with gravity, friction and a timed body force as explicit inputs.
- Overlay the baseline as a wireframe, show both measured paths, scrub one shared timeline, inspect
  height and body separation, and return to the untouched live simulation.
- Preserve current experiments across agent saves. New work appears on return; the previous
  compiled model's source remains available even if an edit on disk becomes invalid.
- Save a self-contained experiment: exact source model and assets, compiled-model patch, full
  integration state, recorded control tape, changes and measured frames. Native Python can
  reproduce the file independently. A CSV contains actual sampled positions and contacts.
- Keep the simulation visible above a bottom panel at 390px; provide keyboard-operable comparison
  controls and actual cancellation. Original sim/replay/actuator controls remain available.
- Agent instructions explain the experiment-to-revision workflow and distinguish held/recorded
  controls from a feedback controller that must be rerun in Python.

Verified so far:

- Six real-WASM experiment tests: analytical free fall, analytical impulse, identical/repeated runs,
  real sliding friction with explicit contact pairs, cancellation/exception cleanup, input bounds
  and the recorded control interpolation contract.
- The full viewer suite passes: 29 tests plus WASM and server install smoke tests.
- Chrome 390px/1280px integration: actual controls and downloads, live-state preservation, deferred
  source changes, playback, cancellation and no page exceptions. Screenshots visually reviewed.
- A real servo-patched Menagerie Go2: 19 model/asset files bundled, 19 generalized positions,
  recorded control tape, 168 measured frames. Its 20 N shove changed maximum body separation by
  1.13 cm. The export reproduced using native MuJoCo 3.13.0 without the original workspace, with
  maximum qpos differences below `2.3e-15`. This is a successful reproduction of that finite
  experiment, not a policy robustness claim.
- The simpler pendulum experiment reproduced natively within `5e-16` metres of the browser.
- All 82 package manifests pass conformance. The README/catalog inventory was corrected from 48
  to the canonical 49 listed harnesses; generated presentation checks pass.

Local evidence is under `/private/tmp/openharness-harness-improvements-evidence/` (`mujoco/`,
`robot/`, `catalog-conformance.json`). The robot browser check is opt-in and has reproducible
environment parameters in `test/robot-experiments.browser.mjs`. It reads a scratch rollout and
installed tools; it does not change installed packages, user workspaces or running sessions.

Final source-bundle and keyboard/playback browser checks pass, and the added **Frame both futures**
control and a branch from an arbitrary replay frame were exercised on the real robot. A changed
gravity input correctly fails native reproduction against the saved measurements. The pendulum
export also reproduces without an external
model path. Visual evidence: [robot comparison](../docs/images/mujoco-what-if-robot.png) and
[narrow layout](../docs/images/mujoco-what-if-mobile.png).

No catalog publication or installed app update has been performed.

## Second improvement: rewind, retry, and keep a playtest moment

Reviewed Godogen/Game Viewer, Phaser, Voxel Worlds, and Game Master's current interaction paths.
Voxel Worlds already has direct object/voxel authoring, undo, source conflict handling, and useful
3D exports. Game Master already has authored tabletop rules and deterministic playtest replays.
Phaser retains scene context across edits, but that is not a complete game-state rewind. Game
Viewer's existing version isolation protects an ongoing run; a specific moment within that run
was the most useful missing feedback loop to implement first.

Implemented in Game Viewer and demonstrated by Godogen's Alpine Drift starter:

- **Rewind** the recent run, inspect a recorded frame, return to the exact live moment, or
  **Try from here** with a different move. The studio restores positions, velocity, jumps,
  collected gates, score, timer, and camera, instead of replaying keyboard events.
- **Pin moment** with Keep/Change/Explore feedback, a real canvas image, complete JSON state,
  and a frozen copy of the selected compiled game. Saved moments are ordinary workspace files
  in `out/playtests/` and reopen after later source edits and a complete viewer restart.
- Preserve Explore versus Play separately from game state. An agent build waits while the user
  is inspecting a rewind or writing a note, including in Explore mode.
- An optional, documented snapshot contract works for other games; games without it keep their
  existing controls. Bounded history, explicit state validation, atomic saved folders, original
  build retention, and archive isolation keep the current build verdict truthful.
- The completed run stops filling its history with duplicate finish-screen frames. Resuming
  waits for the game's acknowledgement before handing input back. The first Play frame now
  frames the rider immediately, so even the earliest rewind frame is useful.
- Agent instructions explain how to read moment notes and preserve Keep feedback. The original
  editable project remains the source; archived `game/` folders are compiled builds.

Verified:

- All 13 viewer tests pass, including original readiness/failure/retention/export behavior,
  snapshot bounds and legacy compatibility, rejected-state rollback, terminal-frame retention,
  persistent moments, traversal rejection, and saved-build/current-verdict isolation.
- The original Chrome suite passes all eight checks: keyboard/jump/pause/restart, live builds,
  syntax and runtime failures, version retention, a complete course, standalone export, and
  a narrow layout. TypeScript and both package conformance checks pass.
- Seven new real-browser scenarios pass: gates and score rewind, exact mid-jump return,
  alternate steering after resume, persisted note/image/state/build, saved games after source
  changes and restart, Explore capture across an agent edit, and legacy games. Invalid states
  leave the world unchanged. No uncaught browser exceptions were observed.
- Desktop and 390px screenshots were visually reviewed. The new timing checks exposed and
  corrected the input-resume race; visual review exposed the unusable early camera position.
- A 20-second demonstration was recorded in Chrome using the Apple M2 Max Metal renderer,
  showing play, rewind, a different move, a note, and reopening the saved moment.

Evidence: `/private/tmp/openharness-harness-improvements-evidence/game-moments-final/` and
`game-demo/`. The repeatable tests are `store/viewers/game-viewer/test/` and
`store/agents/godogen/test/playtest.e2e.mjs`. These are mechanical and visual checks of the
implemented workflow, not a claim of independent human playtesting or universal game determinism.
Snapshot hooks remain the game's responsibility; screenshots capture the canvas rather than its
HTML overlays, and externally hosted assets still depend on their URLs.

Checked-in evidence: [rewind](../docs/images/godogen-rewind.png),
[pin a moment](../docs/images/godogen-moment.png),
[390px saved moment](../docs/images/godogen-moments-mobile.png), and
[20-second demonstration](../docs/images/godogen-rewind-demo.mp4).

Next: continue the 3D/CAD authoring review, beginning with Blender, Autonomous Workshop, and their
shared viewers. Initial README review confirms Generative Art, Creative Direction, and Music
Studio already have substantial original authoring and export workflows; preserve those rather
than replacing them with cosmetic presets. The full catalog goal remains active.

## Third improvement: shape an authored Blender design and keep its source

Reviewed Blender, the shared 3D Viewer, Autonomous Workshop, FreeCAD, OpenSCAD and text-to-cad.
The CAD wrappers already emphasize editable native source, measured checks and useful exports;
Autonomous Workshop's upstream workflow adds an explicit physical-part critique. The generic
3D Viewer has strong inspection tools, but changing a Blender model previously always required
another agent turn. This made direct exploration of an original design the most useful addition.

Implemented **Shape Lab**, an optional protocol for any authored Blender scene:

- The scene declares its own numeric, integer, boolean and choice controls with `parameters()`.
  The values drive actual Python geometry and materials. The mug starter demonstrates the API;
  a separately authored ribbon lampshade proves the viewer has no mug-specific controls.
- Changing a control runs native Blender on a snapshot of explicitly declared source and assets.
  Material shading reveals finish choices; a changed model is fitted into the view while keeping
  its viewing direction. Existing measure, section, shading and orbit tools remain available.
- **Keep** preserves the exact source, helper modules/license, parameter values, measured glTF,
  report, canvas thumbnail, standalone rebuild script and project ZIP in `out/designs/`.
  Named directions reopen after source changes and after a viewer restart.
- **Use values on next build** writes only `design-values.json`, after matching source hashes.
  The next agent build reads the selected values and produces its normal exports and verdict.
  Main exports wait while the user is exploring; closing the lab returns to the latest one.
- Source and chosen-value revisions are distinct: revisiting a kept direction stays editable
  when only the current choice changed. An incompatible source requires reloading controls or
  having the agent adapt the older direction.
- One native worker and one replaceable queued request, bounded inputs/artifacts, failed-build
  recovery, cancellation and process-group cleanup. Snapshot/archive paths reject escaping links.
  HTTP writes require the page token and same-origin requests. Relative output isolation is a
  project convention, not a security sandbox for arbitrary Python.

Verified:

- All 33 model-viewer tests pass, including the original server/lifecycle/script checks and new
  snapshot, queue replacement, timeout/descendant cleanup, cancellation, archive persistence,
  revision checks, path confinement and write authorization cases.
- All 63 existing Blender tests pass with native bpy, including real small renders, glTF/STL
  exports and turntables. Four new parameter tests pass without bpy.
- Seven actual Chrome/native-Blender workflows pass with no browser errors: controlled geometry
  and material, independent ZIP verification and rebuild, saved directions and explicit values,
  deferred agent exports, persistence across restart, changed-source/failure recovery, and a
  different authored scene with a declared JSON asset.
- The 75 × 75 × 145 mm tumbler rebuilt from its downloaded ZIP in another directory with matching
  object names, measured dimensions, vertices, faces and material names. Original model and
  report hashes stayed unchanged until the test deliberately ran a new main build.
- The lampshade's 32 ribbons and foot produced 33 native mesh objects, 4,992 vertices and 4,834
  faces at 135.2 × 135.2 × 328.02 mm. Its ribbon count, twist and finish come from its source.
- Desktop and 390px screenshots were visually reviewed on Chrome's Apple M2 Max Metal renderer.
  Review fixed cropped tall variants, invalid timestamp display and transient change highlights
  in kept thumbnails. Source synchronization and late-created workspaces also have regression
  coverage. Both package conformance checks and generated catalog checks pass.

Evidence is in `/private/tmp/openharness-harness-improvements-evidence/blender-final/` and
`blender-demo/`. The repeatable native check is
`store/viewers/model-viewer/test/shape-lab-browser.mjs`. These checks establish the implemented
author/explore/keep/rebuild loop; they are not independent user research or an assertion that
every authored scene supports interactive build speeds. Additional source dependencies still
need to be installed, and expensive/custom render paths may need a geometry-only preview path.

The recorded lamp session keeps two different directions and reopens one; native preview builds
for the two kept designs took 0.518 and 0.578 seconds on this machine. Checked-in evidence:
[design shelf](../docs/images/blender-shape-lab.png),
[390px controls](../docs/images/blender-shape-lab-mobile.png), and
[native interaction recording](../docs/images/blender-shape-lab-demo.mp4).

The full catalog review and improvement goal remains active. No installed harness, user session,
store publication or main-worktree content was changed by this feature.

## Fourth improvement: keep an actual live Strudel performance

Reviewed Music Studio, Score, Generative Art, Creative Direction, Strudel, AbletonAI, JUCE Agent
Toolkit, Drone Pilot, Autonomous Circuit, CircuitJS, Manim, Remotion, OpenMontage, and their
relevant shared viewers. This round examined their source and authoring/export instructions;
only Strudel received new native runtime acceptance work in this round. Music Studio and Score
already support substantial original composition and useful source/audio exports. Fieldwork,
Forme and Vector already have real editable artifacts and portable handoffs. Preserve those.
The upstream media and PCB pipelines remain intact. AbletonAI's optional Live bridge is read-only;
its starter and JUCE's starter should not be described as complete native DAW/plugin workflows.

Strudel has a different strength: performing an authored program while it plays. The pane already
had live code, voice lanes, mute and solo, but no way to keep the actual performance. Added:

- **Record take → Finish take → Keep take** captures the real Superdough stereo output through
  an AudioWorklet. The recording branch emits silence, preserving the existing speaker route.
  Float WAV preserves the engine's samples, with no normalization or clipping.
- During performance, mix requests, successful code versions, cycle/tempo and named moments
  are journaled on the audio clock. A failed evaluation keeps the last successful source in the
  journal. Markers seek the saved audio; a stereo waveform displays the captured channels.
- A named take keeps WAV, source versions/hashes, measured audio properties, journal, README
  and a portable ZIP in `out/takes/`. Saved takes reopen after source changes and server restart.
  Playback stops the live instrument; restarting the instrument pauses playback.
- Incoming agent source waits during recording and while pane edits are unsaved. Loading the
  latest file is explicit. Reconnecting the event stream checks missed file changes too, and
  stale fetch responses cannot overwrite a newer one. Saved sources do not enter the live picker.
- Failed saves preserve the browser's take and WAV download. A capture identity makes a retry
  after a lost save acknowledgement idempotent. A restarted server's token refreshes without
  reloading the tab. Server writes are validated, bounded, token/origin protected and atomic;
  escaping symlinks are rejected. Audio files support range requests for native playback/seek.
- Capture is bounded to 120 seconds or six million frames. Transport stop, context suspension
  and output replacement finish capture. Interruption keeps complete chunks received so far;
  unsaved audio is held in the current tab. Journal limits are documented, and source is available
  for continued agent authoring without overwriting the original take.

Verified:

- All 24 Node tests and 51 existing Python tests pass. New checks cover exact sample/chunk
  boundaries, independent WAV properties, journal validation, write authentication, failed writes,
  path confinement, archive isolation, range serving and independent Python ZIP integrity.
- Seven real Chrome workflows use the installed, unmodified `@strudel/repl` and actual Web Audio:
  performance/mix/code/markers, native playback/seek, restart/mobile, failed evaluation plus lost
  save acknowledgement/restart retry, interrupted audio, deferred edits, and full-length capture.
  No browser page errors. Remote sample maps are empty in this offline synth test; DSP is real.
- Independent FFT/RMS analysis of a two-voice diagnostic found 220/440 Hz initially; muting the
  left voice reduced its RMS below 1e-6 while the right voice stayed at 0.0724. A code change
  produced the expected C4/E5 tones (262/660 Hz FFT bins at this analysis resolution).
- The full-length take ends at exactly 5,760,000 stereo frames: 120.000 seconds at 48 kHz.
  Its WAV is 46,080,056 bytes. FFprobe independently identifies stereo `pcm_f32le`; Python
  verifies the ZIP and the captured WAV hash. This exercises the largest normal upload too.
- A separately authored five-voice synth piece, **Lantern room**, was performed with four
  markers and two code versions, then kept and reopened at 390px. It captures 18.907 seconds,
  with peak 0.959 and RMS 0.0953. These are signal checks, not a claim of subjective listening
  quality. Desktop/mobile visual review fixed lane sizing when opening the recorder and made
  mobile voice names legible. Package conformance and generated catalog checks pass.

The repeatable browser check is `store/agents/strudel/test/performance-browser.mjs`; use
`LONG_CAPTURE=1` to include the two-minute test. Evidence and preserved workspaces are in
`/private/tmp/openharness-harness-improvements-evidence/strudel-final/` and `strudel-demo/`.
Checked-in evidence: [desktop](../docs/images/strudel-live-take.png),
[mobile](../docs/images/strudel-live-take-mobile.png), and
[performance walkthrough](../docs/images/strudel-live-take-demo.mp4). The MP4 pairs the screen
recording with the saved WAV, using AAC and approximate visual/audio alignment; the original
float WAV and source bundle remain in the evidence workspace.

The WAV is the captured performance. Scheduler lookahead, effect tails, random patterns and
external dependencies mean the journal is not a deterministic replay. Other applications, system
volume and external MIDI instruments are outside this recorder. Browser acceptance was on Chrome;
a 390px viewport is a layout check, not a claim of testing mobile Safari or every audio device.

The full catalog review and improvement goal remains active. All implementation, demo artifacts
and tests stayed in the improvement worktree and disposable evidence directories.
