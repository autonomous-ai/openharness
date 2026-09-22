# Harness playtest handoff — September 22, 2026

The user paused this pass and requested documentation and separate PRs before resuming later.
All eight featured harnesses received real prompts through Harness and have individual review
branches. This is an improvement pass with unfinished native acceptance checks, not a claim that
every harness is perfect. Nothing was merged. The README visual showcase branch is separate.

## Review map

| Harness | PR | Changes | Evidence completed | Resume with |
| --- | --- | --- | --- | --- |
| Jev Sheets | [#218](https://github.com/autonomous-ai/openharness/pull/218) | Persist adopted questions; explicit offline practice; truthful provider errors | Real app prompts; Chrome compare, preference, note, keep, adopt, server restart and reopen; patched native prompt fills 24/24 practice cells | Native Question Lab interaction, agent revision and reopen |
| Godogen | [#225](https://github.com/autonomous-ai/openharness/pull/225) | Restore game keyboard focus, including first Play from a native terminal; reset follow camera with rider | Original Maple Run prompt; native play, restart, rewind, resume and saved feedback; revision submitted | Inspect and play Version 17; saved Version 10 feedback remains intact |
| Blender | [#227](https://github.com/autonomous-ai/openharness/pull/227) | Space activates Shape Lab controls | Chrome lamp build, keep, adopt, export, rebuild and reopen; fresh native prompt produced a 300 mm ribbon lamp | Native controls on the new lamp, preserved revision and reopen |
| MuJoCo | [#228](https://github.com/autonomous-ai/openharness/pull/228) | Preserve Tab navigation, actuator keys and transport activation | Chrome robot experiment and independently reproduced native export; fresh native prompt produced a stable 14 s Go2 bob | Native experiment controls, kept comparison, revision and reopen |
| CircuitJS | [#229](https://github.com/autonomous-ai/openharness/pull/229) | Keep cursors and zoom when reopening or keeping the same capture | Real app RC prompt; native slider, two kept solver captures, comparison, cursor persistence and reload/reopen | Submit the currently unsent revision request, then inspect the explanation and preserved packets |
| RDKit | [#230](https://github.com/autonomous-ai/openharness/pull/230) | Encode special-character structure/thumbnail URLs and Unicode attachment names | Chrome conformers, native torsion scan, kept study, reproduction and actual SDF download; fresh native paraben-series prompt | Native molecule controls, kept scan, agent revision and reopen |
| Strudel | [#231](https://github.com/autonomous-ai/openharness/pull/231) | Loop exact captured marker passages; expose mixer state; warn about measured recording overload | Real app prompt; Chrome actual recording, mix, markers, keep/reopen and exact audio loops; patched native prompt authored a new track | Native performance, kept-take revision, reopen and measured headroom |
| Typst | [#234](https://github.com/autonomous-ai/openharness/pull/234) | Correct singular saved-note copy | Chrome three-page document, anchored note, immutable PDF, source revision, comparison and reopen; fresh native engineering-brief prompt | Native anchored review, targeted revision and preserved PDF/note |

The shared [Store update fix #223](https://github.com/autonomous-ai/openharness/pull/223) restores
updates for official packages installed before the repository rename. It retains fork/path
isolation. Its 28 tests and typecheck passed; the installed desktop/adapter has not been replaced
with that branch, so the full native update flow still needs verification.

The harness PRs record their focused tests, screenshots where published and exact limitations.
All 72 catalog agent packages passed the package conformance command during this pass. That is
a manifest/package-contract check, not 72 runtime or user-experience passes.

## Preserved native projects

These generated test projects remain under the test machine's normal `harnesses/` directory.
Do not replace them with the starter templates when resuming.

| Harness | Project directory | Useful state |
| --- | --- | --- |
| Jev Sheets | `jev-sheets-2026-09-22-13-20` | Twelve fictional hosting tickets; explicit offline mode; original two questions |
| Godogen | `godogen-2026-09-22-12-57` | Maple Run; two saved Version 10 Change moments; Version 17 revision authored but native rendering/review pending |
| Blender | `blender-2026-09-22-13-14` | Ivory/brass ribbon lamp, four controls, still and turntable |
| MuJoCo | `mujoco-2026-09-22-13-16` | Go2 model, position-servo bob, poses and 421-frame rollout |
| CircuitJS | `circuitjs-2026-09-22-13-00` | Original RC circuit and two kept capture packets; follow-up is still unsent in the composer |
| RDKit | `rdkit-2026-09-22-13-10` | Original example artifacts plus three authored paraben candidates |
| Strudel | `strudel-2026-09-22-13-22` | New offline Harbor Lights track with five named voices |
| Typst | `typst-2026-09-22-13-07` | Three-page field-notes engineering brief |

Separate scratch projects retain the completed browser evidence. Jev's kept trial is
`6987de23-0862-45c4-b187-c8b1daa1b241` in `jev-app-practice-jkuvp4w5`; Strudel's real take is
`1a325927-0b8c-4d63-baad-a853c6c093fd` in `strudel-app-review-9oe1fv6l`.
Do not mistake Strudel's explicitly named end-marker regression copy for another live performance.

## Resume procedure

1. Read the relevant PR and branch handoff first. Check the current branch/package revision and
   inspect the existing project before changing anything. Linked review packages should have
   real local dependency directories: `npm ci` can follow a `node_modules` symlink and wipe
   another installed package's dependencies.
2. Give one test operator exclusive control of both the native app and Chrome. Parallel browser
   activity can steal native focus. Tell the embedded coding agent that the test operator owns
   preview/desktop controls; it should author files and inspect artifacts.
3. Continue the saved user journey: use the actual output, keep a choice, request a targeted
   revision, verify approved material is preserved, reopen and inspect exported files with an
   independent reader. A prompt typed into a terminal is not proof it was submitted.
4. Keep one PR per harness. Update evidence with what actually ran; preserve existing screenshots.
   The user already authorized publishing generated test screenshots and results. No merges
   were authorized for this pass.

Native window discovery failed earlier but recovered after reselecting `/Applications/Harness.app`.
Two app processes existed, so do not terminate Harness wholesale or close unrelated user tabs.
Native `typeText` worked; paste was unreliable. A browser download event wait once hung for a
long time; use bounded UI operations and verify the resulting file instead of an indefinite wait.

Jev's configured live provider was out of credit. Its offline evidence establishes interaction
and persistence only. Strudel signal measurements establish captured audio and overload, not
subjective music quality. RDKit's native typing dropped a Greek character; Unicode coverage came
from the separate Chrome test. Geometry or simulation checks are not physical-safety claims.

## Next wave — preparation only

No new original-brief native project was launched for these before the user paused the work.
There are no product changes to merge for them.

| Harness | Prepared work | Intended next brief |
| --- | --- | --- |
| Voxel Worlds | `codex/voxel-worlds-user-playtest`; installed package matches source, conformance/doctor pass | Editable lantern-lit canal night market; move/recolor a stall, revise the bridge while preserving the layout, export GLB/VOX/source/offline studio |
| Generative Art | `codex/generative-art-user-playtest`; official install, setup/doctor, conformance and 13 existing tests pass | Moonseed botanical packet, square graphic and wide banner; save a control edit, revise only the wide composition, export SVG/PNG/project/ZIP |
| Music Studio | Planned; no new original-brief native prompt | Original 30–45 s cue; edit notes/mix, preserve a section through revision, export WAV/stems/MIDI/project |
| Creative Direction | `codex/creative-direction-user-playtest`; package conformance passes, not yet installed | Fictional Loopworks bicycle cooperative identity; edit a shared price, preserve approved branding through a poster revision, export brand kit/site |

Local isolated worktrees use `/private/tmp/openharness-<harness>-user-playtest`, except Jev
(`openharness-harness-next-pass`) and Strudel (`openharness-strudel-take-loops`). Their scratch
notes and generated test projects are useful resume aids; they are not portable committed fixtures.
