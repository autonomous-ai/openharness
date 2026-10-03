# Compile the universal macOS app once

Desktop releases compiled the same universal application twice. Only the renderer
selection in Info.plist differed. In [1.2.52](https://github.com/autonomous-ai/openharness/actions/runs/37017329208),
those compilations took approximately 2m10s and 4m45s on separate macOS runners.
Both had to finish before publication.

The release and internal-build workflows now call one coordinator. It compiles once,
copies independent bundles, verifies both architectures and versions, pins each
renderer, and runs both publication paths concurrently. Each retains app and DMG
notarization, stapling, Gatekeeper checks, and separate immutable artifact paths.
The final release still requires both Linux builds, guarded manifest publication,
and all six public download checks.

## Native validation

[Run 37028979450](https://github.com/autonomous-ai/openharness/actions/runs/37028979450)
passed on candidate `9de45237607423989a679044164642b292ebb7a7`, using Flutter 3.47.2
on macos-15. This was a disposable internal build, with self-update disabled. Its
version label was 1.2.55; it did not publish a product release or update live metadata.

| Phase | Measured time |
| --- | ---: |
| One universal build and initial signature checks | 4m11.722s |
| Two copies, concurrently | 7.085s elapsed |
| Renderer/signature checks, concurrently | 7.584s elapsed |
| Both package/notarize/upload paths, concurrently | 2m56.314s elapsed |
| Four full download checks, after manifest reads | 6.136s elapsed |
| Coordinator, including manifest reads and overhead | 7m29.572s |
| Complete macOS job, including setup and cleanup | 9m19s |
| Complete internal workflow | 9m54s |

Both app bundles and DMGs received Apple's Accepted verdict and passed Gatekeeper.
All four public downloads matched version, SHA-256 and size. The cleanup step then
removed the four archives and two scratch manifests under only this run's random
prefix. The [raw timing record](2026-10-02-single-macos-build.json) retains these
results; its internal download URLs have intentionally been deleted.

The first native trial failed before uploading because the new `lipo -verify_arch`
call put the file after the architecture list. The corrected argument order passed
against a local universal object and then in the complete native workflow above.

The process suite passed all 56 tests locally and in
[CI 37028026483](https://github.com/autonomous-ai/openharness/actions/runs/37028026483).
That CI ran at `3977fc0c8`; the only executable change afterward was the lipo argument
correction, exercised by the successful native run. Workflow lint and shell syntax
passed. The later fixture-only change in #627 does not alter application or build
inputs. These evidence documents were added after validation.

## What the timing establishes

One compilation now supplies both variants, and their packaging overlaps. The new
macOS job was 1m11s shorter than 1.2.54's 10m30s critical Mac job, 24s shorter than
1.2.52's 9m43s, and 55s longer than 1.2.53's 8m24s. These runs used different source
revisions and runner/notary conditions; this is not a controlled end-to-end benchmark.
The internal workflow also excludes Linux builds and live release publication.
Do not subtract its total directly from a product release or promise a fixed saving.

Duplicate compilation and a second macOS runner are removed. The observed compilation
variance remains a larger uncertainty than the roughly 15 seconds needed to copy and
check both derived bundles. Measure the next real releases before claiming a stable
wall-clock improvement. The separately merged [fixture setup fix](2026-10-02-desktop-fixture-stalls.md)
addresses four pre-merge test stalls; it does not depend on this build change.
