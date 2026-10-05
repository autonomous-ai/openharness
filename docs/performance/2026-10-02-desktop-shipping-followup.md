# Desktop testing and shipping follow-up

Scope: code ready through required validation, merge, publication and verification.
Design, implementation time and user review are not targets for shortening.

## Evidence from Desktop 1.2.51

[Release run 36995613336](https://github.com/autonomous-ai/openharness/actions/runs/36995613336)
completed first attempt. The release workflow took 12m29s. On its critical macOS
Apple Silicon job, the Flutter SDK and pub cache both missed. Setup took 73s;
Flutter compilation took about 4m14s; app and DMG notarization took about 61s and
52s respectively. After uploads finished, post-job cache saving took another 81s.
The Intel job also missed and spent 33s saving caches.

The caches were associated with release tags, with no corresponding Flutter cache
on `main`. [GitHub's cache access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)
allow a tag to restore the default branch's cache but not another tag's cache.
Saving multi-gigabyte SDK copies after each release therefore delayed publication
without helping the next release. [flutter-action's implementation](https://github.com/subosito/flutter-action/blob/v2/action.yaml)
uses automatic post-job saves when its cache option is enabled.

The user-visible shipping interval for 1.2.51 was 30m10s from "pr merge" to the
completion message. That included user review. Merge to live publication was
13m29s; live to final report was 4m18s. All six downloads were verified within
that last interval, but orchestrating the checks and reporting added waiting.
These are distinct from the Actions duration; they are not all build time.

## Changes

- Prepare SDK/pub caches on `main` when their inputs change. Reuse upstream keys
  so existing logging, internal and web workflows can restore them too. Release
  jobs restore only; misses still install the pinned toolchain. The preparation
  workflow also tests changes to this setup on PRs, without release credentials.
- Verify all six public downloads immediately after publication, parallel with
  GitHub release-page creation. Check expected versions, full SHA-256 and sizes
  with the updater's Dart user agent. Stream three downloads at a time and impose
  total transfer deadlines. Preserve a JSON receipt on success or failure.
- Add `--wait` to the Desktop release command. Follow the exact tag and SHA,
  require the public verification job to pass, and finish promptly. The previous
  printed command watched the latest run of the CLI workflow instead.
- Add `scope=process` to manual CI for repository tooling changes. Application
  changes still select their component checks; cache hits do not skip tests.

No signing, notarization, application test gate or artifact integrity check was
removed. The public manifest writer and uploaded bytes are unchanged.

## Validation and expected effect

Local process suite: 31 tests passed in 11.47s. HTTP fixtures exercise all six
downloads, concurrency limits, Dart user agent, corrupt hashes/sizes, missing or
mixed-version entries, HTTP failures and bounded timeouts. Watcher fixtures cover
exact source selection, pending runs, failures and absent verification.
`actionlint`, shell syntax and whitespace checks passed.

The new read-only verifier checked the existing public 1.2.51 manifest and all
six CDN artifacts in **9.814s**, with every hash and size matching. This is a
measurement on this Mac/network, not a prediction of every CI run.
The [JSON receipt](2026-10-02-desktop-download-verification.json) records the
manifest digest, each artifact's expected/actual hash and byte count, and UTC times.

On implementation commit `e3c38c4b8bca7a35b9a989fe03aaf368131770c2`,
[process CI](https://github.com/autonomous-ai/openharness/actions/runs/37014248010)
passed all 31 tests in a **25s workflow** (18s job), without component builds.
[Cold preparation](https://github.com/autonomous-ai/openharness/actions/runs/37014247634)
passed on both release runner types: macOS 2m46s, Linux 1m46s, including cache
creation. This job runs separately from the release, so its cache saves do not
delay publication.

Removing release cache saves eliminates the observed 81s post-build cache phase.
Warm restores should also reduce setup time, subject to restore throughput and
cache eviction. Automated verification should replace most of the prior manual
4m18s after-publication interval with runner startup, downloads and a concise
report. Measure the next actual release before claiming an end-to-end speedup;
Apple notarization and runner queues remain variable.
