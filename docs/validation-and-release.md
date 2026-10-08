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

## PR CI

PR CI is deliberately fast. Each changed component runs only its own Linux suite:

| Changed directory | PR check | Typical time |
| --- | --- | --- |
| `cli/`, `tests/` | `cli-typecheck` and `cli-tests` (default Vitest suite, four shards) | 3–5 min |
| `desktop/` | `desktop-tests` (VM suite, four Linux shards) | 5–7 min |
| `tui/` | `tui-test` (`cargo test`) | a few minutes |
| `backend/`, `companions/`, `website/`, `os/`, `provider/`, `mobile/`, `daemons/` | that component's one check | 1–4 min |
| `devices/` | `firmware-checks` | 1–2 min |
| anything else (docs, workflows, scripts, store) | `process-checks` only | about 1.5 min |

`plan` (actionlint and suite selection), `process-checks` and `ci/required` always
run; `ci/required` is the only required check. On a draft PR only those three run
and `ci/required` stays blocked; marking the PR ready runs the component checks.
Normal merges directly squash the reviewed head after successful PR CI. If GitHub
requires a merge queue, its runs rerun only the three always-on jobs (about 2 minutes):
the PR run already tested the change. Queue setup is not required to merge or release.

The `plan` and `ci/required` jobs run `scripts/ci-plan.py` from the PR head. A branch
created before #991 still carries the old planner, which expects removed jobs and
fails `ci/required` for CLI, Desktop, workflow and script changes. Update the branch
from `main` before relying on its CI.

### What PR CI does not run

| Check | Where it runs now | When you must run it yourself |
| --- | --- | --- |
| CLI per-file coverage gates (`test:core`, `test:harnessd`, `test:resume`, `test:orchestrator`, `test:sharing`, `test:remote-viewers`, `test:portability`, `test:local-models`) | nowhere automatically | when you change files those gates cover (`src/core/`, `src/services/`, `src/harnessd/` and each gate's area) |
| CLI serial, PTY and login-shell specs; macOS process images | CLI release builds and verifies process images only | when you change `src/cable/` serial code, shell startup or process images; run the specs on macOS |
| CLI end to end (`cli/e2e`) | nightly and **Actions → CLI end to end → Run workflow** | for user-facing CLI flows; start one run on the branch |
| Desktop tests on macOS | nowhere automatically | when you change macOS-specific Desktop code; `make desktop-test` on a Mac |
| TUI native fixtures and connected shells | the TUI release (`release-tui.yml`) | optional locally: `scripts/validate-tui-native.py` |
| Experience, authoring, Home Assistant and Desktop logging browser checks | **Run workflow** on their own workflows | when you change their area |
| OS image builds, VM and hardware acceptance | **Actions → Harness OS** and the other OS workflows, by hand only | for installer, image or session changes; start once with the needed inputs |

Record what you ran, with run links, in the PR. Release workflows are not a full
test suite: the CLI release runs typecheck and bundle checks, and the Desktop release
builds, signs and verifies downloads. A release failure is still a code failure: fix
it and cut the next version.

Do not add CI runs to a PR. Don't start **CI → Run workflow** for a PR that already has
an automatic run, and don't push again just to retrigger a failed check. Read the
failure, fix it and push once. The account runs at most 20 jobs at once (5 on macOS),
and every extra run delays every other PR.

### Suite details

Manual **CI → Run workflow** accepts `scope`: `cli`, `tui`, `backend`, `desktop`,
`full` (the default, all five core components), `all`, or one extra component. It
runs the same fast jobs as PR CI.

`desktop-tests` uses the release's pinned Flutter SDK and shared dependency caches.
Each shard has four test workers and the bounded runner's ten-minute budget. Logs
and receipts are retained for seven days.

CLI's default Vitest suite runs as four file shards on separate runners, retaining
its worker cap and isolation. Shard reports and inventories are retained as
artifacts for seven days.

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

The CLI's end-to-end suite (`cli/e2e`) runs in its own workflow, **CLI end to end**
(`.github/workflows/cli-e2e.yml`): nightly and on demand from a branch
(Actions → CLI end to end → Run workflow).
Eight Linux runners each take a shard, planned from `cli/ci-e2e-durations.json` the same
way (`--config vitest.e2e.ci.config.ts --shard=N/8` reproduces one locally). Each shard
installs tmux, zsh, tcsh and dash, starts every daemon from one bundle (`E2E_BUNDLE=1`) and
runs its files one at a time. The full-disk tests, which need macOS disk images, run on one
macOS runner with `DISKFULL=1`. `e2e-summary` applies the default suite's rule: every
discovered file exactly once, every shard passing. Its summary records each file's duration
for refreshing the hints. A failing test's complete daemon logs and engine hook logs are
uploaded as `cli-e2e-daemon-logs-N`, by file and test (`E2E_ARTIFACTS_DIR`, which works
locally too). It is advisory, and so it does not run on pull requests: a failed check makes
GitHub report a PR unstable, which `make merge-pr` refuses to merge. Once it has stayed
green, run it on pull requests, make `e2e-summary` required and add it to the evidence
collector.

For changes to daemon lifetime or process boundaries, select an opt-in soak and chaos workload
(`cli/e2e/endurance.e2e.ts`). On a Mac, run `SOAK=1 E2E_BUNDLE=1 SOAK_OUT=<folder> npx vitest run
--config vitest.e2e.config.ts e2e/endurance.e2e.ts` in `cli/`. The defaults are 60 minutes of soak and
30 minutes of chaos with six agents; `SOAK_MINUTES`, `CHAOS_MINUTES` and `SOAK_AGENTS` select a
smaller validation workload. Runs of at least 15 chaos minutes require every fault kind and service.
Windows, terminal streams, all service processes and a fake dial are exercised. Every turn must be
seen once, in order; the core must never restart; failed services must answer promptly and recover.
`SOAK_OUT` keeps process samples and JSON reports. Memory/descriptor growth is reported, with null
for insufficient measurement windows. Set `SOAK_MAX_MIB_PER_HOUR` or `SOAK_MAX_FDS_PER_HOUR` only
with a measured baseline for the same workload; there is no invented default growth limit. Short
smoke runs test the harness and failure paths, not long-term memory stability.

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

PR CI runs the TUI unit tests only. The TUI release builds the shipped musl targets
and runs the native fixtures against them. The native TUI fixtures run two at a time,
using their own homes, socket names, and mock ports. CI retains each fixture's log
and validation receipt as an artifact. Native comparisons use tmux 3.7c at the pinned
commit in `.github/actions/reference-tmux`; Ubuntu's 3.4 loses the exit status in the
live-window respawn comparison. CLI's older-tmux integration checks keep the
distribution binary. To run the same set locally after building:

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

Prepare the PR description and review the diff while CI is running. For a normal
merge you need nothing more: `make merge-pr` collects and verifies the
`ci/required` receipt itself. The collector below is for manual runs only, and its
`cli` and `desktop` scopes still expect the job set from before #991, so they fail
on current runs; `process` still works. To collect a manual run's record:

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
whole-tree equality. A malformed receipt cannot authorize reuse. After a partial
rerun, the receipt must match the actual successful process job's attempt; a
stale receipt from a replaced process job is rejected.

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

After independent code review, required non-CI acceptance and merge authorization:

```bash
make merge-pr ARGS="PR_NUMBER --reviewed-head HEAD_SHA --reviewed-base REVIEW_BASE_SHA --merge --wait-timeout 1800"
```

The checkout must be clean at the exact reviewed head and include the reviewed
`main` commit. The helper follows the latest automatic PR CI for that head, verifies
its immutable `ci/required` receipt, rechecks the source and GitHub mergeability,
then directly squash-merges with the exact reviewed head. It verifies that the
merged full tree matches the reviewed and tested tree. It retains source, run,
attempt, artifact digest and phase timings under `.harness/validation/*-merge-*/`.
Omit `--merge` for a read-only preview.

A merge queue is not a prerequisite for merging or releasing. Do not add `--queue`
to ordinary commands or stop an authorized merge to request queue setup. If GitHub
actually enforces a queue, the helper detects its rule and uses it, verifying the
merged tree against successful candidate CI. Explicit `--queue` is only for an
intentionally configured queue, such as a disposable integration trial.

If `main` moved before a direct merge, inspect and integrate the new source, then
supply the updated reviewed head/base. Reuse validation only for unchanged inputs;
rerun checks affected by the integration. This is routine handling of concurrent
merges: continue the user's already-authorized merge without asking for permission
again. A quiet branch takes the direct path immediately after checks and review;
concurrent changes require only the additional review and validation they affect.
Do not enable or disable a queue based on the number of open PRs or running jobs.

A changed head/target, missing coverage,
failed/skipped required jobs or a lost response cannot report success. Inspect an
uncertain merge or enqueue without replaying the mutation. If a wait expires,
follow the same run or queued PR; do not start another validation or merge request.
Do not use `--run/--scope` for normal merges: that legacy manual-evidence mode
depends on the collector's pre-#991 job lists.

## Automatic CI and rollout

`ci.yml` runs on every PR revision and on `merge_group: checks_requested`.
`scripts/ci-plan.py` reads the complete immutable Git diff, including both sides
of renames, rather than GitHub's limited file list. PR runs check out the exact
head; queue runs check out the combined candidate. Each changed path selects only
its own component's suite ([PR CI](#pr-ci)); paths outside a component select no
suite. CI uses read-only repository permissions and executes no contributor code
with release credentials.

Cross-component effects are not tested on PRs. A CLI change does not run the
Desktop, TUI, companion or mobile suites even where they read CLI protocol files.
When a change alters a protocol, wire format or shared fixture another component
reads, say so in the PR and run that component's tests locally or with
**CI → Run workflow** (`scope=desktop`, `tui`, `companions` or `mobile`).

Separate PR groups prevent cross-cancellation, but still share available runner
capacity. Related branches validate independently. Keep PRs small, inspect changes
from `main` before direct integration, and coordinate edits to shared interfaces
and frequently changed files. Main background validation may coalesce pending
snapshots; any configured queue's distinct candidates must not share that group.

The stable `ci/required` job runs even after an upstream failure. It accepts only
successful selected jobs. Deliberately inapplicable jobs may be skipped; a required
skip, cancellation, failure or missing result fails integration. Manual `full`
selects the five core suites; `all` selects every suite. Manual dispatch is extra
evidence and cannot substitute for the automatic PR gate.

Do not enable or change repository protection rules as part of an ordinary merge
or release. Preserve configured PR, discussion, approval, deletion and force-push
rules. Optional queue rollout is separate repository administration, not a step
agents must complete before shipping a reviewed change.

New revisions replace active checks for the same PR, job and matrix row. Cancellation
locks belong to work jobs, leaving summaries and the always-running final gate independent: an obsolete
gate waiting for a runner cannot block the next revision. Checks no longer selected
by the new plan may finish, including when a ready PR returns to draft; they cannot
validate a newer head. Explicit runs and distinct candidates have independent
concurrency identities. CLI end to end runs nightly and on demand; it no longer
runs after each merge. A passing older run does not validate newer source. It
remains advisory, and missing required acceptance still prevents an authorized
release.

OS workflows run only when started by hand. Pushing to an `os/**`, `os-polish/*` or
`os-candidate/*` branch builds nothing. Start **Harness OS** (or the specific OS
workflow) on the branch once, with the inputs the change needs, and reuse its
`image_run_id` for follow-up assessments instead of building again.

Hourly **CI health** retains a bounded latest-100-run workload sample, execution
observed in cancelled runs and the age/source of completed main E2E. These are job
timestamps, not billed cost or a guarantee that current main passed. Use a week of
traffic to tune candidate concurrency from runner waiting, rebuilds and ready-to-merge
time. Investigate/revert confirmed main regressions promptly. Preserve explicit retry
and incomplete-suite reporting; do not retry assertions until they disappear.

Release publication and Desktop prepared-package reuse retain their existing
source/evidence, signing and artifact contracts. They do not depend on a merge
queue or queue rollout. After the authorized merge, follow the component's normal
release workflow and verify its published artifacts.
