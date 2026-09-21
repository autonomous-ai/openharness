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
