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

## Science and engineering review, then RDKit bond studies

Reviewed the science/data packages and the shared Studio Viewer bridges, with selected source paths
and authoring contracts checked in addition to their READMEs. This is source review unless native
verification is listed below:

- **Data Studio** already supports original CSV input, SQLite joins and queries, traceable source,
  browser recomputation and a portable report/database/source bundle. **Lab Bench** already supports
  authored experimental designs, editable protocols, real observations, fit diagnostics and separate
  confirmation runs with frozen forecasts. Preserve those complete loops.
- **marimo** uses the upstream reactive notebook editor and runner; it can author arbitrary Python
  notebooks. **Quantum Studio** is an unlisted 1–8-qubit statevector editor; **GIS** is an unlisted,
  bounded local GeoJSON explorer. Their existing interactive capabilities and limits matter more
  than adding a new preset chooser.
- Reviewed **autoresearch-mlx**, **Foam-Agent**, **SimSkill**, **DimOS**, **Comfy MCP** and **Bonsai MCP**
  with the shared **Studio Viewer**. Several bridges have useful native paths but narrow starter
  models: the four-way SUMO intersection, coarse 2D LBM flow and office navigation are not arbitrary
  general simulators. The CPU character-transition experiment is not an MLX transformer training
  run, and the procedural SVG path is not diffusion image generation. Preserve those distinctions;
  this review does not claim native acceptance of every optional runtime. Foam-Agent and SimSkill
  are not installed in this environment.
- Reviewed the **Home Assistant**, **KiCad**, **Yosys** and **Orca Slicer** package contracts. Home
  Assistant's actual Core automation tests and trace export, and Orca's native slicing and portable
  rerun files, are substantial existing workflows. Avoid replacing those with superficial demos.

Selected **RDKit** next: its existing viewer exposes conformers and measurements, but a person
could not directly turn a chosen bond into a computed experiment and a reusable result.

Implemented:

- A native **Bond scan** from the current 3D conformer. Choose an eligible chain or pick four atoms
  directly in 2D/3D and use the measured dihedral. The unmodified RDKit rotates a non-ring single
  bond and computes MMFF94 energy at 13, 25 or 37 angles. This is a rigid scan, with the other
  internal coordinates fixed; the UI and exports say so explicitly.
- Drag the energy curve or scrub its keyboard-accessible slider to inspect the actual calculated
  3D coordinates. Play the scan, jump to its lowest sampled point and overlay the starting pose.
  Invalid chains, rings, missing hydrogens or unavailable force-field parameters leave the last
  valid study available. Scans accept one connected 3D MOL/SDF molecule with 4–200 explicit atoms;
  no model templates or synthetic energies substitute for the input molecule.
- **Keep study** preserves a title, note, exact input conformer, selected SDF, every pose, energy
  CSV and full-precision coordinates in `out/torsions/<id>/`. The server recomputes and checks the
  calculation fingerprint before publishing an atomic save. Its ZIP includes a standalone Python
  reproducer, calculation source and license. The original molecule stays unchanged.
- Studies reopen after changes, server restart or removal of the original molecule. Incoming agent
  output waits while an experiment is open; returning loads the revised source. Failed saves retain
  the current browser study for retry, including refreshing a restarted server's token. Write
  endpoints require the pane token and same origin, bound request sizes, and reject escaping output
  symlinks. Incomplete saves are not published in the study library. Kept structures do not enter
  the live molecule picker or the verdict's newest-artifact search. Pose controls are locked while
  saving the selected point.
- Updated the package description, README and authoring guidance so an agent can continue from the
  user's chosen SDF and note while preserving the original study. Added an authored butane and
  phenethyl-acetate example script; the calculation accepts other compatible molecules too.

Verified:

- 27 Node checks pass, covering existing viewer behavior, atomic persistence, native failure
  cleanup, concurrent request rejection, symlink boundaries, token/origin checks and both declared
  and chunked upload bounds. Native chemistry checks validate independently reconstructed MMFF94
  energies, bond-length preservation, measured angles, periodic endpoints, V3000 input, rejected
  rings/multiple bonds and a stale calculation fingerprint that writes nothing.
- All 138 Python checks passed across the full suite and targeted follow-ups. The two optional
  native setup/initialization checks were run separately with `RDKIT_PYTHON` enabled; the final
  verdict test also confirms a saved scan cannot become the live artifact.
- Seven real Chrome workflows use RDKit 2026.03.6 and unmodified 3Dmol 2.5.5: curve/play/ghost/save;
  deferred changes; failed-save/restart retry; saved/mobile reopen; an independently authored
  aromatic ester; real four-atom picking and ring rejection; and a library with no original files.
  No browser page errors. Screenshots were visually checked at 1280×960 and 390×844; these are
  Chrome layout checks, not a claim of testing every mobile browser.
- A downloaded/extracted study recomputes in a separate directory using only its bundled source
  and RDKit. Maximum energy difference is **0 kcal/mol** and coordinate difference is **0 Å** in
  the tested environment. Displayed MOL coordinates agree with calculation coordinates within
  **0.000047 Å**, the expected four-decimal MOL rounding; full precision remains in JSON.
- The separately recorded walkthrough uses an authored ester, turns its chosen chain through the
  energy curve, and keeps a 60° pose with a note. The portable study and raw video remain under
  `/private/tmp/openharness-harness-improvements-evidence/rdkit-demo/`; the repeatable acceptance
  script and JSON results are under `store/agents/rdkit/test/torsion-browser.mjs` and the evidence
  `rdkit-final/` directory. Package conformance and generated catalog checks pass.

Evidence: [desktop](../docs/images/rdkit-bond-scan.png),
[mobile](../docs/images/rdkit-bond-scan-mobile.png), and
[16.84-second native walkthrough](../docs/images/rdkit-bond-scan-demo.mp4).

Scientific limits: compare relative energies only within the same rigid scan. These are not relaxed
barriers, free energies, solution populations, kinetics or activity predictions. Unsaved studies
live in the current tab; a reload discards them. No installed package or existing user molecule was
changed. The full catalog goal remains active; remaining detailed review includes productivity,
research/browser, monitoring, local AI and the unlisted Jev experiments.

## Sixth improvement: keep a document review attached to its actual draft

Expanded the source review across productivity, research, monitoring and local AI before choosing
the shared Doc Viewer:

- **Marp** already combines arbitrary Markdown authoring, native Marp exports, slide notes,
  presenter timing, filmstrip/grid navigation and live changed-slide feedback. **Typst** and
  **Doc Viewer** already have native compilation, genuine pdf.js search/selection/outline/zoom,
  stable reader position across recompiles and useful compiler diagnostics. Those paths remain.
- **Sheet & Docs Studio** coordinates native DOCX, formula-driven XLSX and LibreOffice PDF output
  from an editable shared source. Its generic literal table and regional-comparison schema are
  bounded; it does not implement arbitrary spreadsheet formulas or PPTX. The shared PDF review
  improvement now applies to it too.
- **Jev Sheets** has row-plus-context classification, per-cell distributions, confidence filtering,
  file import, original-column CSV export and source attribution. **Jev Browser** has an actual
  Chrome crawler and source selection. **Roundtable** preserves a motion, separate model responses,
  a moderator's claim map and exports. These received source/README review here, not fresh paid
  API calls, a panel run or a claim that every judgment is correct.
- **Harness Monitor** uses daemon, process, tmux and transcript observations with guarded runtime
  controls. **Machine Monitor** exposes paired-machine observations with explicit stale/unknown
  states. **Grid** reuses CLI-backed workers. **Ollama, MLX-LM and vLLM** have native local-runtime,
  model and job paths, with a shared implementation for the local AI packages. No actual user
  workers, remote machines, downloaded models or monitoring controls were changed in this review.
- Read the complete README contracts of all 17 unlisted **Jev experiments**. Archer/Catcher/Slalom
  are synthetic tracking/intercept problems; Arena supplies path counts to the decision model;
  Duel's rules engine supplies legal Reversi moves; Blocks models decision time against the fall;
  FPS is an independently authored software-raycast arena; Lander/Pendulum/Pong are toy control
  loops. Conductor's notes become browser audio; Compactor can analyze a bounded imported transcript
  without changing its live session; Firehose can triage a user's bounded data file and export CSV.
  Launcher launches only on paper; Shopper and Trader use synthetic prices; Guard is a demo,
  not a security boundary. Their reported mock measurements and earlier live-model samples were
  read as historical evidence, not rerun or promoted into new performance claims. Further detailed
  implementation review of these experiments remains, especially preserving useful decisions
  beyond transient controls. They remain unlisted.
- **Firmware Studio** compiles through PlatformIO and reports native memory/build output without
  claiming device verification. **Godot Studio** retains native Godot export and arbitrary source
  authoring. **Web Studio** retains arbitrary web authoring and an original interactive starter.

The selected gap: someone could read an excellent live PDF, but their judgment was not anchored
to the exact draft they had read. Added **Review → Hold this draft**:

- Capture the already parsed PDF's actual bytes, not whatever may have just overwritten the file.
  Select native PDF text, drag a page region, or leave a page note. Label it **Change**, **Keep** or
  **Question**. Numbered pins reopen and reveal the corresponding feedback. Area picking supports
  pointer cancellation and Escape; ordinary button activation works from the keyboard.
- Keep a title, quoted text, page numbers and normalized rectangles with the exact PDF and SHA-256.
  Each immutable `.harness/doc-reviews/<id>/` packet has `reference.pdf`, `review.md`, `review.json`
  and a portable ZIP with an explanation. It does not rewrite the source or embed PDF annotations.
  Editable source and assets stay in the workspace, as the UI documentation and archive explain.
- Agent recompiles wait while the review is held. **Compare latest** opens the actual latest PDF;
  quoted notes locate exact normalized wording across changed pagination. A missing or repeated
  quotation is reported explicitly. Page/area anchors always describe the old PDF. Returning to
  the reviewed draft restores its bytes and highlights; **Back to live** resumes workspace output.
- Native PDF download and browser printing use the displayed bytes. In-flight live loads cannot
  replace a held draft. A delayed reader-position callback was fixed when returning to an empty
  workspace, and empty workspaces can still reopen their kept reviews.
- Saves publish atomically with strict metadata, coordinate, PDF signature/hash and size checks;
  the browser's native pdf.js parses the document. Server validation is not a second full PDF
  parser. Write requests require a per-process page token, same Origin and loopback Host. Uploads
  are bounded even without Content-Length; archive paths reject symlinks. A failed save retains
  browser notes, a lost acknowledgement retries the same ID, and a restarted server refreshes its
  token without discarding the draft. Unsaved work survives Back to live but not a tab reload.
- Reviews support 30 MB / 500 pages, 100 notes and 2,000 characters per note. Narrow windows put
  the PDF above a scrollable review panel. Typst and Sheet & Docs Studio guidance now teaches the
  agent how to read the packet and revise the original source while preserving the review.

Verified:

- **83 Node checks** pass: existing reader/server/workspace/shell behavior plus packet identity,
  byte preservation, independent ZIP extraction, immutable retry, failure cleanup, symlink bounds,
  token/Host/Origin checks, declared/chunked upload bounds and interrupted requests. Archived PDFs
  cannot become the live artifact. **15 Typst checks** pass with the native compiler enabled.
- **Nine native Chrome journeys** pass with no page errors. They cover actual mouse text selection,
  rectangle/page notes, pin navigation and Escape; browser ZIP and displayed-PDF downloads;
  deferred updates; a quote moving from page 1 to page 2; missing and ambiguous wording;
  lost-acknowledgement retry and process restart; removal of the original PDF; 390 px layout and
  scaled highlights; unsaved-draft return and deliberate discard; a pending-load race; and a real
  failed native compile followed by recovery. The core nine journeys were also run with the forced
  legacy pdf.js build. This is Chrome verification, not independent Safari/iOS/WKWebView testing.
- Authored a fictional portable-light brief in Typst, compiled the three-page original and four-page
  revision with **Typst 0.15.1**, rendered all seven pages with Poppler and visually inspected them.
  The downloaded review ZIP was read independently with Python's `zipfile`: the stored PDF SHA-256
  matched the exact original and all four notes were present. The original editable source remains
  editable and is not limited to this fixture.
- Visually checked desktop, narrow layout and revision-comparison screenshots. Recorded a paced
  **13.72-second native walkthrough**, H.264 1280×960, from actual pointer interactions and native
  recompilation. No simulated PDF renderer or generated screenshots. The three affected packages
  pass conformance; generated presentation metadata and the 59-entry catalog validate.

Evidence: [desktop](../docs/images/doc-review.png),
[latest revision](../docs/images/doc-review-latest.png),
[narrow layout](../docs/images/doc-review-mobile.png), and
[native walkthrough](../docs/images/doc-review-demo.mp4).
Repeatable acceptance: `store/viewers/doc-viewer/test/review-browser.mjs`. JSON results, raw video,
the separate demo script and portable packets are under
`/private/tmp/openharness-harness-improvements-evidence/doc-review-{final,legacy,demo}/`.

The full catalog objective remains active. No installed harness, original user workspace, paid
model account, remote service or published catalog was modified. Remaining work includes deeper
implementation review of the unlisted experiments and selecting the next high-value interaction.

## Seventh improvement: compare a question before asking the whole sheet

Reviewed Jev Sheets' native client, row/context construction, header grammar, cache identity,
source-file handling, in-pane edits, existing file chooser/export and tests. Also inspected the CAD
Viewer contract: its pinned upstream viewer already has native measurement, section planes,
explosion and rendering controls, so replacing those controls would not address a missing workflow.

Jev Sheets already advised an agent to test wording on ten hard rows, but this required writing a
one-off script. Added **Question Lab**, directly beside the sheet controls:

- Preview 10/20/40 rows selected from low confidence plus a spread, a spread alone, or the current
  sorted/filtered view. Pin a selected sheet row. Freeze the actual row text, metadata and context;
  exclude sample truth labels and group labels from the model input.
- Write any supported yes/no, choice or score header. Re-ask both versions together using the same
  native client and shared question builder, one paired call per frozen row, with four in flight.
  Read full probability distributions and exact wire questions. Filter changed labels, record a
  human preference and write a note without turning that preference into a truth label.
- Keep an immutable `.harness/question-trials/<id>/` packet with the exact sample, question wire
  payloads, raw answers, returned provider/model/usage, human notes, CSV, readable review, reusable
  sample `sheet.json`, candidate `column.json`, file checksums and a portable ZIP. Kept packets
  reopen after viewer restart or source deletion. They include sampled data, never credentials.
- Try the candidate across the whole sheet as a separate column. Reuse the trial rows only when
  context/data and the currently connected route/requested model match. Preserve the original
  column; reject a changed source/context/question. As with existing pane-added columns, the
  extra column is runtime state. Updated guidance tells the agent to retain an accepted header in
  the original `sheet.json`, never replace the original dataset with the trial's small sample.
- Trials are bounded to 40 rows, 4,000-character headers, a 512 KB preview, 24 KB per paired result,
  2 MB result JSON, eight open trials and 100 kept trials. Cancellation stops scheduling; in-flight
  calls may finish using the client's normal transient-error retries. Authentication/credit errors
  stop further rows after the in-flight batch. Failed/cancelled packets retain their status.
- New commands require a per-process page token on the existing loopback/Origin-guarded server.
  Archives reject symlink directories/files, stage writes atomically, validate result checksums on
  reopening and clean up failed saves. Start, keep and apply tolerate lost acknowledgements without
  duplicating a trial, archive or column. A restarted server refreshes the page token.
- A real browser sequence caught a note being overwritten when the result filter changed during
  its save. Separate note drafts and partial note/preference updates now preserve typing across
  polling and filtering; the selected preference also updates while the note retains focus.

Verified **57 package checks**, including the existing sheet/import/Excel/counting behavior, sample
selection, frozen context, result validation, cancellation, partial failures, note/preference
updates, archive integrity/immutability, write-failure retry, path/token checks, cached whole-sheet
application and staleness. A local HTTP protocol fixture uses the production Jev client with an
explicit dummy key and isolated empty credential file: it verifies actual paired requests and
returned probabilities/model/usage without calling an external provider.

**Seven native Chrome journeys** pass with no page errors: import the original fictional CSV,
select/pin a real sheet cell, compare, filter and review; retain a note while switching filters;
retry a lost keep response and independently extract/check the downloaded ZIP with Python;
apply without duplicating the column; reject stale data while retaining the frozen preview;
recover a lost start response without a second trial; restart the server, refresh the token and
reopen after deleting the source; and use the 390px layout, Escape and reopening. These native
browser runs explicitly use the offline client. They do **not** establish live Jev accuracy,
latency, calibration or superiority of one wording. The UI, packet and guidance say so.

Visually checked the desktop preview, reviewed comparison and narrow view. Recorded and inspected
a separate paced **12.84-second H.264 walkthrough**, 1440×1040, from actual browser interactions.
Package conformance and the doctor pass; shared Jev kit copies remain unchanged and in sync.

Evidence: [comparison](../docs/images/question-lab.png),
[frozen preview](../docs/images/question-lab-preview.png),
[narrow layout](../docs/images/question-lab-mobile.png),
[native walkthrough](../docs/images/question-lab-demo.mp4).
Repeatable acceptance: `store/agents/jev-sheets/test/question-lab-browser.mjs`. Test logs, JSON
results, downloaded ZIP, raw recording, separate demo script and workspaces are under
`/private/tmp/openharness-harness-improvements-evidence/question-lab*`.

The full catalog objective remains active. Continue the detailed source review of the unlisted
experiments, then prioritize the next interaction or correctness gap supported by that evidence.
