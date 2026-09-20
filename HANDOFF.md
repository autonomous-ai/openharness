# Harness rebuild release handoff

Worktree: `/private/tmp/harness-store-voxel`, branch `codex/harness-store-voxel`.
The main checkout is shared with other sessions; leave it alone.

## Current state — all seven published for user testing

The user asked for tools that enable original, useful work, then asked to rebuild the remaining
five one by one and publish each to the Harness Store. That sequence is complete. The public
catalog lists all seven. Original logos/icons and the older implementations under
`store/tools/experiences/` remain in the repository. Current builders use each package's own
`template/studio/` sources. Do not restore the old preset/spectator products or delete their code.

| Harness | Released capability | Evidence |
| --- | --- | --- |
| Generative Art / Fieldwork | Original editable art projects and production exports | [Art/Music rebuild](work/AUTHORING-REBUILD.md) |
| Music Studio / Afterhours | Editable composition/arrangement, own material, audio and MIDI delivery | [Art/Music rebuild](work/AUTHORING-REBUILD.md) |
| Creative Direction / Forme | Editable identity, coordinated launch assets, website and brand guide | [#141 and delivery review](work/FORME-REBUILD.md) |
| Voxel Worlds / Tidelands | Source-backed 3D editing, walking, VOX import and GLB/VOX/offline delivery | [#146 acceptance](store/agents/voxel-worlds/test/ACCEPTANCE.md) |
| Drone Pilot / Vector | Survey planning, real flight-evidence import and portable field/GIS kit | [#151 release](work/DRONE-REBUILD.md) |
| Game Master / Relay | Original tabletop rules, human play, component editing, reproducible playtests and printable kit | [#153 release](work/GAME-REBUILD.md) |
| Lab Bench / Signal | Planned experiments, actual CSV measurements, uncertainty/diagnostics, held-out confirmation and reproducible reports | [#155 release](work/LAB-REBUILD.md) |

Lab Bench is the latest release: merge `119c5b69ac1d585a649658a5aeb5f1a52376361e`, package revision
`ec6642b1ae73fbef5b19d1d0cc792be7573f94ae`. Exact-head CI `35512306940` and Store publisher
`35512724426` passed. Public catalog, actual studio and all three screenshot bytes match the
reviewed release. Normal Store-ID installation passes setup/doctor on this Mac, and a fresh
framework-materialized workspace builds, checks, exports PDFs, opens the installed viewer,
saves an actual browser edit to source/history and reopens it without errors.

The first immediate post-publication CLI lookup missed Lab Bench; a forced catalog refresh
resolved it and the Store-ID install then passed. Do not describe this as a diagnosed/fixed
resolver bug. The direct repository/path install also passed. Evidence is under
`/private/tmp/signal-{public-bytes,installed-workspace,installed-viewer}.json`; the final measured
fixtures and print review are under `/private/tmp/signal-acceptance-release/` and
`/private/tmp/signal-print-release/`.

## Score installation screenshot — fixed and published

PR #145 (`b74d3f2b253d3addb150cb06552de5b547ea326e`) installs official checksum-pinned LilyPond
2.26.0 when needed. Real Intel Mac and Linux CI installation/engraving passed. The published
package is installed at `~/.harness/dsh/autonomous/score`, and its doctor passes. The user was
told to click **Retry**. Do not restart that work or claim the GUI button was clicked.

## What remains unproven

Passing software checks does not establish the user's subjective “wow” bar. Music listening,
customer briefs completed through installed agents, physical experiments/flight/printing and
real customer feedback remain distinct from authored fixtures and browser automation. Lab's
response fixtures are explicitly synthetic. Drone Pilot does not control a drone or authorize
a flight. Game simulations do not establish fun or human balance. Read the package acceptance
documents before describing capabilities or readiness.

The historical reset and original withdrawal are in [SUPERPOWERS.md](work/SUPERPOWERS.md).
The sequential release record is in [FIVE-REBUILDS.md](work/FIVE-REBUILDS.md). The earlier
verification/performance/audit reports cover the older starter implementations and must not be
presented as proof of the rebuilt products or customer outcomes.

## Verification and future publication

Run each package's acceptance checks and the appropriate shared checks in
`store/tools/experience-tests/README.md`. Run `node store/tools/build-experiences.mjs --check`
and `node store/tools/build-experience-branding.mjs --check` after relevant edits. Acceptance
documents state actual browser, independent-reader, print and installed-workspace evidence.
Builders keep artifact verdicts `ready:false` pending appropriate review.

The shared web viewer's sibling-fetch/storage/module regression is fixed and tested. Trusted
workspace apps receive same-origin capabilities; this is not a hostile-code isolation boundary.
Host, path, hidden-file, symlink and method restrictions remain. New source-editing studios have
their own bounded local bridges with source-conflict handling.

Publication is authorized: review the concrete diff, pass checks for the exact PR head, merge
normally, await **Publish Store catalog**, and verify public catalog/package/screenshot bytes
and normal installation before saying a release is live. No additional permission is required.
Updating a package does not overwrite already materialized user workspaces.
