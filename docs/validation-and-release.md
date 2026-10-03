# Validation and release

The release clock starts at the user's request, not at the tag. The October 2
[audit](performance/2026-10-02-release-process-audit.md) found repeated full suites,
baseline investigations, local environment failures, and waiting before publishing.
Keep a short validation plan and reuse its evidence through merge and release.

## Select the checks once

| Change | Required scope |
| --- | --- |
| Documentation or static artwork | Relevant links/schema/assets, visual inspection when the result is visual |
| Isolated CLI behavior | Typecheck, affected unit tests, relevant integration/real-engine tests |
| Isolated desktop behavior | Analyze changed Dart code, affected widget/unit tests, native/browser check for the surfaces changed |
| Shared state, authentication, protocol, dependencies, or unclear impact | Full suite for each affected component, plus relevant integration/platform checks |
| Packaging, signing, updater, or release workflow | Script/workflow checks and artifact/manifest contract checks; use a test publication when publication behavior changes |

This is an impact assessment, not a file-extension bypass. A small deletion change
can require real disposable worktrees and lifecycle tests. A resource label change
does not require retesting every unrelated engine. Keep required coverage gates.
An unavailable native engine or platform is an unverified row, never a passing one.

Use the pinned toolchain and lockfile. Check free disk space before installing,
compiling, or starting a broad suite. Do not clean other sessions' files to make room.
Run independent checks concurrently, with enough capacity for their workers;
two commands each spawning every CPU is not useful parallelism.

Manual **CI → Run workflow** accepts `scope`: `cli`, `tui`, `backend`, `desktop`, or `full`
(the default). `cli` includes typecheck, all CLI tests, updater coverage, release
bundle checks, and the serial/login-shell OS/Node matrix. `tui` includes its native
CLI integration tests. Select `full` for cross-component changes or uncertain impact.
The workflow remains on demand; this change does not introduce new required gates.

`desktop` runs all Desktop VM files on both macOS and Linux, split into four
isolated runners per platform. It uses the release's pinned Flutter SDK and shared
dependency caches. Each shard has four test workers and the bounded runner's
ten-minute budget; startup recovery retains the same narrow rules below. `full`
includes this matrix alongside the existing component checks. Changed Dart
analysis and browser/native integration checks remain separate where relevant.

The Desktop aggregate reads each raw test log, verifies its hash and complete-file
result, and compares every shard's inventory with the checked-out test files.
Every file must finish exactly once per platform. Failed jobs, missing or duplicate
files, changed source/environment, malformed reports and incomplete tests fail it.
Platform-specific skips and any pre-test loader recovery remain explicit in the
summary. Logs, receipts and the summary are retained for seven days. Collect the
result with `scripts/record-ci-validation.py RUN_ID --scope desktop --pr PR_NUMBER`.

CLI's default Vitest suite runs as four file shards on separate runners, retaining
its worker cap and isolation. Typecheck, lockfile checks, guard fuzz, registry and
release-bundle integration, and updater coverage run alongside them. Guard fuzz
keeps its own process and timing budget. The existing `typecheck-test` job is the
aggregate: it requires passing shard/contract jobs and verifies that their JSON
reports cover every discovered file exactly once. Missing, duplicated, failed or
unfinished results fail it. Review the complete workflow result, including the
serial/login-shell matrix, rather than one early finishing job. Shard reports,
inventories and the combined summary are retained as artifacts for seven days.

CI's `vitest.ci.config.ts` uses the slow-file timing hints in `cli/ci-test-durations.json`
to distribute estimated work across the same four runners. The complete discovered
file list remains authoritative: new files receive a default cost, and obsolete
timing entries cannot select removed files. Hints are recorded from a passing CI
run and can be refreshed from its per-file JSON durations if later runs become
uneven; stale estimates affect scheduling, never coverage. Vitest keeps its normal
ordering within each shard; the normal local configuration, including file
shuffling, is unchanged. Use `--config vitest.ci.config.ts --shard=N/4` to reproduce
the CI assignment locally. The aggregate still requires every discovered file
exactly once, independent of these estimates.

For repository process tooling only, `scope=process` runs its Python regression
tests without installing or building unrelated components. It does not validate
application changes. Workflow edits also need `actionlint` and a run exercising
the changed workflow behavior, such as the desktop cache preparation checks.

Desktop SDK and pub caches are prepared on `main` when their inputs change by
**Prepare desktop caches**. Run that workflow on `main` after cache eviction if
needed; it does not publish anything. Release tags restore those caches without
saving another tag-specific copy. Cache misses still install the pinned SDK and
resolve dependencies normally. macOS enables Swift Package Manager before pub get.
The shared keys include SDK version/commit, OS/architecture, and the dependency
lockfiles for pub. Desktop SDK caches omit Android/iOS engine artifacts and use
their own key, with the full SDK for the exact same version as a fallback. Cache
preparation covers macOS and both Linux architectures. Signing, notarization and
artifact checks remain required.

Desktop build jobs check out the complete `desktop/` component, their local
actions and shared packaging helpers. Keep these sparse checkout inputs current
if a build starts using another component. The existing pub-cache key also reads
`mobile/pubspec.lock`, which remains included so sparse and full checkouts restore
the same dependency cache. Linux builders reuse a working Google Cloud CLI at or
above the validated version, with the normal install path as a fallback.
When installation is needed, hosted jobs use the extracted SDK directly instead
of copying it into the runner's discarded local tool cache. Authentication still
runs normally; self-hosted runners retain the upstream tool-cache behavior.

Closing a PR removes caches scoped to that PR's merge ref. Deleting a branch
removes caches scoped to that absent branch. These finished-work caches cannot
warm future releases from `main`; retaining them crowds the repository's cache
storage. Cleanup uses default-branch code, checks the PR/branch state before and
after listing, and deletes only IDs returned for that exact ref. The default
branch, tags, open PRs and existing branches are preserved. For a read-only preview,
run `python3 scripts/prune-finished-caches.py --repo OWNER/REPO --pull-request N`
or use `--deleted-branch NAME`; `--apply` performs the selected cleanup.

### Package Desktop while final checks run

When the final implementation is pushed, start `make release-desktop ARGS="--prepare"`
on that PR branch alongside its required tests and review. This chooses the next
version using the same tags/live-manifest rules as a release, then dispatches a
candidate build. Use an explicit version with `--prepare` when preparing a minor
bump. The candidate uses the release's normal macOS and Linux build, signing and
notarization steps and production updater settings. It writes only to a random
candidate prefix, verifies all six downloads, and retains a small receipt in
GitHub Actions. It neither tags nor updates the product manifest or Release page.

After validation and review pass, merge and release that version normally. The
workflow automatically looks for a candidate with the same version and Desktop
build inputs. It compares Git objects for the whole `desktop/` and `scripts/`
trees, `.github/actions/`, the release workflow (including its SDK/runner pins),
`mobile/pubspec.lock` when present, and root `.gitattributes`, `.gitignore` and
`.gitmodules` files. File contents, additions, removals and executable modes are
covered. Extend this input contract before a build starts reading another component;
the process suite checks that it covers every native builder's sparse checkout.

Unrelated CLI, firmware and documentation merges, or a clean squash, can preserve
those inputs even when the full repository tree changes. Any Desktop source, asset,
dependency, native code, packaging helper, toolchain-pin or workflow change requires
another build. The receipt still identifies the producer's actual commit/full tree;
reuse records both source identities and the matching input fingerprint. GitHub's
immutable tree objects must independently confirm the producer's inputs. Truncated
or malformed responses cannot authorize reuse. The workflow checks the
producer run's successful completion, repository, workflow, source, attempt and
immutable receipt digest. Promotion copies only the exact object generations
whose sizes and SHA-256 hashes were verified, with atomic no-overwrite conditions.
The normal version check, serialized manifest publication and six public-download
checks still apply. Candidate packaging never substitutes for application tests
or authorizes a merge or release.

A matching in-progress candidate may finish while release preflight waits, bounded
by twenty minutes from the candidate's creation. An absent, failed, expired or changed
candidate falls back to the normal build. If a matching candidate is still live at
that deadline, preflight stops with its run link; follow that same build, then rerun
the existing release workflow (all jobs, so per-attempt paths are refreshed) after
it passes. A deadline or failed status poll does not start another
copy of a known live build.
Once any promotion copy starts, failure
stops the release rather than rebuilding over partially copied immutable objects.
Do not launch repeated candidates while implementation is still changing. A new
version published in the meantime also invalidates the planned version; prepare
the newly selected version instead.

Unused candidates expire after seven days; a daily job deletes only recognized
old candidate objects at their listed generations. Failed candidates and consumed
candidates are removed by their owning workflow. For process maintenance, dispatch
`test_candidate_reuse=true` for the same branch/version after its candidate passes:
it requires reuse, promotes to disposable paths, verifies all six downloads, then
removes those objects and the consumed candidate. It cannot publish a product.

Native TUI CI tests and builds the shipped musl target in the same Cargo output
directory. Dependency caches are keyed by target, Rust toolchain, and Cargo inputs;
cache hits still run every test. The ten native TUI fixtures run two at a time,
using their own homes, socket names, and mock ports. CI retains each fixture's log
and validation receipt as an artifact. To run the same set locally after building:

```bash
python3 scripts/validate-tui-native.py tui/target/release/harness-tui
```

This needs tmux, the pinned Node runtime, and the CLI's installed dependencies.
Do not run another copy on the same host at the same time: each fixture has a
separate port, but separate invocations use the same reserved fixture ports.
TUI release platform builds run alongside unit tests. Native release checks run
against the actual Linux artifact, and publication waits for both unit tests and
all platform builds/native checks. A build-only run uses `publish=false`.

## Bound checks and preserve the result

`make validate ARGS=".harness/validation-plan.json"` runs an explicit plan, at most
two checks at once, without installing tools or retrying tests. Create a local plan
with only the checks relevant to the diff, for example:

```json
{
  "reason": "DSH doctor/materialize shell isolation: typecheck and affected behavior",
  "minimum_free_gib": 2,
  "checks": [
    {
      "name": "cli-types",
      "cwd": "cli",
      "argv": ["node", "node_modules/typescript/bin/tsc", "--noEmit"],
      "timeout_seconds": 180
    },
    {
      "name": "cli-dsh",
      "cwd": "cli",
      "argv": ["node", "node_modules/vitest/vitest.mjs", "run", "src/dsh/command.spec.ts", "src/dsh/materialize.spec.ts", "--maxWorkers=2"],
      "timeout_seconds": 180
    }
  ]
}
```

Commands use argv arrays; use separate checks for independent work. CLI and desktop
checks can run together if memory/disk allow it. Put dependent operations in separate
plans. A scoped desktop test command should name its affected files and start with
`flutter test --no-pub --concurrency=2 --timeout=60s ...`. Two workers are a starting
point, not a fixed cap for a full suite. Choose and record a worker count that fits
the host and other running checks. The full-suite command below selects more
workers on larger hosts; use an explicit lower count when other checks are active.
Chrome and native integration tests ignore Flutter's concurrency option.
Use `make desktop-test ARGS="--shard 1/4 --workers 4"` to reproduce one CI
assignment locally. A shard alone does not validate the complete suite.
Tests legitimately needing longer can declare that explicitly. Start a necessary
broad desktop run early, with
an outer limit (initial budget: 15 minutes); investigate a timeout instead of waiting
through multiple ten-minute stalled fixtures. Budgets are diagnostic deadlines,
not permission to turn failures into success.

For Desktop VM tests, `make desktop-test` provides a bounded full-suite command.
Use `make desktop-test ARGS="test/affected_test.dart --workers 2"` for named files,
or add `--flutter /path/to/flutter` when the pinned SDK is not on `PATH`.
It runs the selected files once. Hosts with at least 16 logical CPUs use three
quarters of them, capped at 12 workers; smaller hosts use half their logical CPUs
(at least one worker). Lower `--workers` when memory or other running checks need it.
Its `--timeout 900` budget includes the initial test process and any recovery.
Dependencies must already be installed. Browser files under `test/web/` and native
integration checks remain separate; this command does not validate those platforms.

The Desktop command records every attempt, its log hash, registered/completed case
counts, existing skips, worker count, source and toolchain/environment identities
in `.harness/validation/*-desktop-*/receipt.json`. A file counts as verified only
when all its registered cases and setup/teardown work finish successfully.
Only Flutter's exact pre-test `Invalid WebSocket upgrade request` loader error
can trigger recovery: no cases or root group may have registered in that file,
every other file must be complete, and the source/environment must still match.
Those files run once more with one worker, within the original budget. Assertions,
unknown errors, missing files/cases, timeouts and cleanup failures cannot trigger
recovery. A second startup failure still fails the command. Successful recovery
is explicitly `passed_after_startup_retry`, with the failed attempt preserved;
it must not be described as an uninterrupted passing run. Use `--no-loader-retry`
when diagnosing the startup failure itself. This bounds its cost; it does not fix
the external trigger, which remains unproven.

The runner writes logs and `receipt.json` under ignored `.harness/validation/`.
It records source commit/tree, dirty-source fingerprint, start/end times, exit codes,
timeouts, and disk preflight. A source edit during validation invalidates the receipt.
Timeout or Ctrl-C terminates only process groups started by that invocation. Tests
remain responsible for any deliberately detached daemons. macOS/Linux are supported.
Choose a lower disk minimum only for a plan whose known requirements justify it;
the default is 2 GiB, not an estimate of a full Flutter build's needs.

## Reuse evidence without hiding regressions

Record the tested SHA/tree, toolchain, dependency lock, selected checks, results,
and links in the PR. A clean squash with the same tree preserves evidence. After a
rebase, examine the diff and rerun checks covering new interactions or conflict
resolutions. Do not reuse results across dependency/toolchain changes. A dirty
receipt identifies the tested working copy, not HEAD alone.

A passing CI run satisfies the equivalent full local check; don't repeat both
before merge and then again on the merged commit. Check the merged source identity
and rerun only validation invalidated by the merge. Native checks absent from CI
still need their own evidence.

Prepare the PR description and review the diff while CI is running. Once it passes,
collect its record with one read-only command:

```sh
python3 scripts/record-ci-validation.py RUN_ID --scope cli --pr PR_NUMBER
```

For a run still in progress, add `--wait` and start the collector alongside review.
It observes that run every ten seconds and collects its evidence as soon as the
attempt passes. The default wait budget is 900s (`--wait-timeout`); collection gets
its own 90s budget (`--timeout`). Both durations are recorded separately. A failed
or cancelled run, changed source/attempt, or expired observation budget stops the
command. A timeout or lookup failure does not establish that CI stopped: inspect
and follow the same run ID. The collector never dispatches, cancels or retries CI,
and waiting does not bypass the required job, artifact, source or PR checks below.

Use the required CI scope (`cli`, `tui`, `backend`, `desktop`, `process`, or `full`). The command
writes a short `validation.md` and machine-readable `receipt.json` under ignored
`.harness/validation/`; use the paragraph/table in the PR's verification section.
It checks the exact run/repository/workflow, required jobs, completed steps, source
trees, and an optional PR's head/base stability. For CLI it also downloads the
coverage summary by immutable artifact ID and verifies its archive checksum and
file/case totals. Desktop scope similarly verifies the summary for both platforms
and preserves explicit startup-recovery counts. Network calls are bounded; the
default collection budget is 90s.

Exit 0 means the requested CI scope passed and covers the selected target (`HEAD`
by default): either the full source tree matches or the verified input contract
below matches. Exit 3 still saves the record but flags uncovered source changes,
a dirty working tree or a PR head mismatch for review. A clean squash with the
same tree is accepted. The receipt always retains both actual commits/trees.
`--target COMMIT` supports historical audits and labels them as covering that
commit rather than the current working copy. Missing objects need a fetch before
comparison; failed/pending runs, missing/skipped required jobs, corrupt/expired
artifacts, and changing run/PR state cannot become a successful record.

For `process` and `desktop`, CI records a `ci-source-inputs` artifact and verifies
each required job's sparse checkout before running its checks. The collector
checks that artifact's immutable digest, run/source/attempt identity and recorded
Git objects, then independently compares the selected inputs with the target:

| CI scope | Complete input boundary |
| --- | --- |
| `process` | `.github/`, `scripts/`, `desktop/scripts/`, root Git configuration files and `Makefile` |
| `desktop` | `.github/`, `scripts/`, `desktop/`, `cli/`, `tests/`, `daemons/`, `store/`, `docs/images/`, `mobile/pubspec.lock`, root Git configuration files and `Makefile` |

The root Git files are `.gitattributes`, `.gitignore` and `.gitmodules`. Directory
objects include every tracked descendant; file modes, additions and removals are
covered. Desktop's tests read CLI protocol definitions, shared layout fixtures,
daemon metadata and catalog artwork, so those are inputs too. The workflow/action
trees include toolchain pins and cache recipes. Extend both the checkout and
`SOURCE_INPUTS` in `scripts/record-ci-validation.py` before using a new dependency.
CI verifies that the checkout agrees with that contract and exposes no tracked
files outside it; the Desktop aggregate uses a smaller subset of the same inputs.

A documentation edit outside those boundaries or an unrelated firmware merge can
therefore preserve a completed run. Pass its original run ID to the collector or
merge helper; no extra option or replacement CI run is needed. The resulting
receipt says which scope was reused, records the matching fingerprint and lists
changed paths outside that scope. Review those changes and run any checks they
require separately. This is a source-input comparison, not a file-extension rule:
Desktop documentation inside `desktop/` and artwork inside `docs/images/` remain
inputs. Other CI scopes and older runs without an input receipt still require
whole-tree equality. A malformed receipt cannot authorize reuse. Rerun all jobs
when rerunning a workflow so its input receipt belongs to the current attempt.

Keep routine validation evidence in these receipts, CI artifacts and the PR body.
Do not add a documentation commit or recreate all raw logs just to record another
ordinary check. Commit a performance report when the comparison itself is useful
repository documentation. The collector records CI time separately; request,
implementation, review/merge and publication timestamps still need their own record.

For deterministic local checks, the runner can do that comparison and reuse the
original logs. Add an explicit `reuse` contract to each eligible check:

```json
{
  "name": "desktop-toolbar",
  "cwd": "desktop",
  "argv": ["flutter", "test", "--no-pub", "--concurrency=2", "--timeout=60s", "test/native_toolbar_sync_test.dart", "test/status_menu_test.dart"],
  "timeout_seconds": 180,
  "reuse": {
    "inputs": ["desktop"],
    "toolchain": [["flutter", "--version", "--machine"]]
  }
}
```

Run the plan normally first. After a documentation edit, rebase or squash, pass
its receipt to `make validate ARGS=".harness/validation-plan.json --reuse
.harness/validation/RUN/receipt.json"` (on one line). Unchanged eligible checks
are labeled `reused`, with the original timestamps, log and duration; changed or
failed checks run. A mixed failed run can contribute its independent passing
checks. There are no automatic retries and no test selection inferred from paths.

Inputs are literal checkout-relative files/directories and include tracked and
untracked source, deletions and file modes. Declare every relevant component,
fixture, configuration and dependency lock; prefer a whole component to an
incomplete hand-picked file list. Supply version commands for every tool involved.
The runner also compares the check command, executable, checkout, OS, inherited
environment and its own implementation. Tool/environment values are hashed, not
written to receipts. Missing/modified logs, changing source, failed cleanup and
an unavailable toolchain cannot satisfy reuse. Install dependencies from the
declared lock; generated or ignored build/dependency directories are not source
inputs. Reinstalling or manually modifying them requires a fresh run.

Leave out `reuse` for real engines, mutable services/hardware, native visual or
physical input checks, and performance measurements affected by host load. Their
external state needs fresh evidence. A reuse contract documents a reviewed scope;
it cannot prove that the author included every dependency. The
[October 2 pre-merge audit](performance/2026-10-02-premerge-validation.md) records
the motivating failures and the measured effect.

For a failure, isolate the failing test once. If its code, fixtures, dependencies,
or environment changed, investigate it as a possible regression. Otherwise check
existing baseline evidence before starting another baseline run. Link the exact
failure, baseline SHA, and relevant file/lockfile comparison. If no valid evidence
exists, perform one bounded baseline reproduction of the affected test. Preserve
the failure as a maintenance item; a baseline failure is not a passing full suite.
Do not repeatedly run thousands of tests to rediscover it. The October 2 desktop
[baseline record](performance/2026-10-02-buffered-diagnostic-validation.json) is
historical evidence, not an allowlist: changes to those paths need fresh checks.

If a broad run is interrupted, retain completed-file evidence only when every
registered case in that file finished and its source/environment still match.
Run every incomplete file again. A tester startup/loader error leaves that file
unverified; isolate it once and retain the original error beside the new result.
Report the combined coverage and any retries explicitly. This is not an
uninterrupted passing suite, and it is not permission to retry assertion failures
until they disappear.

## Merge an already-reviewed PR

Once code review and required non-CI checks are complete and merging is authorized,
start this command while the selected CI run is still running:

```bash
make merge-pr ARGS="PR_NUMBER --run RUN_ID --scope SCOPE --reviewed-head HEAD_SHA --reviewed-base MAIN_SHA --merge"
```

Use full commit SHAs. The clean local checkout must be the reviewed head and include
that reviewed `main` commit. Prepare the PR description with its check scope and CI
run link first. The command waits for that attempt, verifies the same jobs/artifacts
as the evidence collector, then rechecks the PR and the live `main` ref before one
squash-merge request. GitHub must report the PR ready; the request includes the exact
reviewed head and does not bypass branch rules or enable auto-merge/queueing.

Omit `--merge` for a read-only preview. Logs, CI evidence, per-phase timings and the
merge outcome are saved under `.harness/validation/*-merge-*/`. `--wait-timeout`
defaults to 900s; `--timeout` gives preflight and post-CI operations 90s each. The
command records its intended mutation before sending it. If a response is lost, it
inspects the same PR without replaying the merge request.

A changed head, dirty checkout, moved main, failed CI or blocked merge stops the
command. Review new source differences and reuse only applicable evidence, as above;
the command does not decide that impact or replace native checks and code review.
After a merge, it verifies the actual Git tree against the reviewed target tree.
The receipt separately reports whether the full tested tree matches; scoped CI
reuse may preserve test inputs while other reviewed files differ. A merge tree
different from the reviewed target is recorded as `merged_source_review_required`
(exit 3), so resolve that source review before release. An unconfirmed write is
recorded as `merge_not_confirmed`; inspect the same PR before further action. This
command does not create release tags or dispatch release workflows.

## Complete the authorized release

Once required checks pass, merge, verify the resulting source, and tag that source
using the existing release scripts. Do not introduce an additional full-suite phase.
For a client/server change, publish required server support before exposing clients
that need it. Independent product releases may build concurrently; preserve their
source/version compatibility and manifest publication safeguards.

Check the live version and artifact checksum, and give the user the release link
promptly. Broader maintenance testing must not silently turn into another release
gate after shipping. Record these UTC timestamps in the PR or release task:

- Request received; implementation ready; required validation started/completed.
- Merge; each product's release trigger and live publication; completion reported.
- Pauses and waiting, with their known reason. Mark missing data unknown.

For Desktop, use the existing release command with `--wait` to follow the exact
tag and source through completion:

```bash
make release-desktop ARGS="--notes-file /path/to/reviewed-notes.md --wait"
```

The workflow's `publish` job downloads all six public artifacts three at a time,
using the updater's Dart user agent, and checks every version, full SHA-256, and
size. It starts immediately after publication on the same runner.
Each transfer has a total deadline; any failure makes the workflow fail and keeps
the JSON receipt in the `desktop-release-verification` artifact. A successful
verification satisfies that release's download checks: report completion instead
of downloading everything again locally. The watcher requires this job to pass
and checks the tag's full SHA, so another release's success cannot satisfy it.

Different Desktop versions may build concurrently. The shared release lock covers
publication and its public verification, so a second workflow cannot change the
live version midway through that check. Versions are checked before building and
again immediately before publication. A late older version fails as superseded;
do not retry it over a newer live release. All four platform manifests must contain
exactly the six expected entries for one version. Artifact writes are create-only,
and the final manifest write requires the GCS generation read by the publisher.
Concurrent external changes therefore cause a failure instead of being lost.

For publication changes, run the local process suite and the disposable GCS
contract check on the candidate branch:

```bash
gh workflow run release-desktop.yml --ref BRANCH -f version=0.0.0 -f test_publication=true
```

This mode skips all product build/release jobs. It uses tiny public fixture objects
under `harness/desktop/.publication-check/<run>-<attempt>/`, checks actual GCS
preconditions and downloads, and removes only that run's prefix. It exercises
normal publication, duplicate/older versions, incomplete platform sets, concurrent
manifest writes, and immutable artifact collisions. It cannot publish an app.

For a release made before that job existed, or to investigate a download failure:

```bash
python3 scripts/verify-desktop-release.py 1.2.51
```

This is read-only. A failed verification after publication means the release may
already be live; inspect the receipt and fix the cause rather than blindly
retagging or retrying immutable artifact uploads.

Report both total elapsed time and its stages. For small changes, aim to return to
the team's previous 10–15 minute merge/release overhead; publishing duration alone
does not demonstrate that target. At ten minutes without progress, identify the
blocked phase and its next action instead of silently extending testing. Compare
the next ten tasks using request-to-completion data before claiming an improvement.
