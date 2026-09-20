# Harness experience release handoff

Work in `/private/tmp/harness-store-voxel`, branch `codex/harness-store-voxel`.
The main checkout is shared with other sessions; leave it alone.

**Current sequential rebuild:** the user asked to improve the remaining five one by one.
See [FIVE-REBUILDS.md](work/FIVE-REBUILDS.md). Creative Direction now has an editable brand
studio, source save bridge and complete launch exports; [FORME-REBUILD.md](work/FORME-REBUILD.md)
records the actual tests and limits. It is published for Store testing (#141). Voxel Worlds now has a source-backed 3D studio,
standard exports and six independently reopened deliveries; published in #146 at `88250305`,
with public catalog/artifact/screenshots verified and a normal Store install on this Mac. Read
[its acceptance evidence](store/agents/voxel-worlds/test/ACCEPTANCE.md). Drone Pilot is in progress;
Game Master and Lab Bench also remain unlisted. The older “focus only on Art/Music”
instruction below is historical and has been superseded by this user request.

**Score installation regression fixed and published (#145):** setup now installs official
checksum-pinned LilyPond 2.26.0 when needed. Real Intel Mac and Linux CI installation/engraving
passed. The published package was installed normally at `~/.harness/dsh/autonomous/score` on
this Mac, and `dsh doctor autonomous/score` passed; the user was told to click Retry.
The public catalog and actual resolver bytes were verified at `b74d3f2b`.

**Current authoring rebuild:** read [AUTHORING-REBUILD.md](work/AUTHORING-REBUILD.md). Art and Music
now use source under their own `template/studio/` directories, with real editable projects and
production exports. `build-experiences.mjs` delegates to their builders. Their original preset
sources remain under `store/tools/experiences/` for history; they no longer generate these two
packages. Setup now installs pinned package-local browser tools. Both are listed for user testing,
as explicitly requested after the user found them missing from the Store. Musical listening and
real-user/installed-engine authoring trials are outstanding. The earlier
seven-starter description below is historical and must not be presented as the new product bar.

**Product reset, 2026-09-20:** the user rejected preset and spectator experiences as the wrong
product. All seven below were initially withdrawn with `listed:false`; the five outside Art and
Music remain unlisted. Read [the review and remaining product validation](work/SUPERPOWERS.md)
before continuing. Focus only on
Generative Art and Music Studio. The earlier release evidence below describes working controls;
it does not establish that these tools meet the new product bar.

The branch now contains seven original, offline, editable experiences and an updated shared web
viewer. These replace the earlier placeholder artifacts. See [verification](work/VERIFICATION.md),
[performance](work/PERFORMANCE.md) and the [audit](work/REVIEW.md) for the evidence and its limits.

| Store harness | Starter | User capability |
|---|---|---|
| `autonomous/voxel-worlds` | Tidelands | Walk, build, explore, change daylight, save and restore an island |
| `autonomous/generative-art` | Fieldwork | Explore reproducible print editions and export large PNGs |
| `autonomous/music-studio` | Afterhours | Edit five tracks, arrange finite music and export a WAV |
| `autonomous/creative-direction` | Forme | Shape a coordinated identity and export SVG art and design tokens |
| `autonomous/drone-pilot` | Vector | Fly a canyon course, study the autopilot and export telemetry |
| `autonomous/game-master` | Relay | Compare strategies, replay matches and run a 32-map tournament |
| `autonomous/lab-bench` | Signal | Change a synthetic experiment, inspect statistics and export observations |

## Source and verification

Reviewable sources live in `store/tools/experiences/`. Run
`node store/tools/build-experiences.mjs` after source edits and `--check` to detect drift.
Generated template artifacts are self-contained HTML. Each installed workspace also has
`node tools/check.mjs --seeds 100`, which tests the model extracted from its actual edited HTML.
No runtime package install, remote model API, CDN or paid service is required for the starter.

Use `store/tools/experience-tests/README.md` for the model, browser, performance and running-daemon
checks. The old scripts in `work/` delegate to these portable checks. Raw screenshots/downloads
are ignored under `work/experience-evidence`; reviewed Store images live under `store/showcase`.

The iframe bug is fixed in `store/viewers/web-viewer/preview.html`: trusted workspace apps get
same-origin APIs, forms, downloads and pointer lock. The shell also preserves seeds, supports
paused automatic refresh, reports errors and recovers from a missing artifact. Scripts plus
same-origin access are **not an isolation boundary**; the viewer README states this explicitly.
The server still restricts hosts, paths, hidden files, symlinks and request methods.

## Installation and publishing

All seven agents and the viewer were installed with absolute `--link` paths to this worktree for
real daemon integration tests. New local workspaces use those files. Existing workspaces keep
what was already materialized; updating a package does not overwrite a person's artifact.

The user explicitly requested publication to the Harness Store. Publish through a reviewed
source diff/PR to `main`; the **Publish Store catalog** workflow writes the `store-catalog`
branch. Verify the live catalog's package refs, actual artifact bytes and screenshot URLs before
reporting publication complete. No additional user confirmation is required for this release.

Never repeat the earlier “100% browser coverage” or “106 ms painted preview” claims. The first
measured Node helpers; the second observed a URL change. Current checks cover finite samples and
actual browser controls, with measured save-to-ready-and-paint timings in the performance report.
