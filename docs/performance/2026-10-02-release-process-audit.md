# Release process audit — 48 hours ending 2026-10-02

Audit window: **2026-09-30 09:24:25 to 2026-10-02 09:24:25 UTC**
(16:24:25 Vietnam time at both ends). Repository snapshot: `125afc179`.

## What was slow

The user's hours describe request-to-completion time. Build job duration excludes
implementation, local validation, baseline diagnosis, merge, review, idle time, and
the final reply. It cannot establish that a release task was fast.

The snapshot contains **56 GitHub releases: 17 desktop, 27 CLI, 12 web**, plus
**10 TUI release attempts** (8 successful, including a duplicate version) and
**4 backend deployment workflows**. I reviewed their jobs, all failed/retried CI
jobs, and 104 PRs merged in the window. Of 48 CI runs, 10 ended failed and four
successful runs needed a second attempt. TUI also had two failed runs and a
successful run requiring a retry. Desktop 1.2.36 was cancelled and has no published
GitHub release. Backend workflow success alone does not prove ArgoCD rollout.

Every release, release/deployment attempt, inspected job, failed step, and merged
PR is in the [machine-readable audit](2026-10-02-release-process-audit.json).
Other machines' task histories were unavailable; the requester approved proceeding
with these records. Missing request/completion times remain null.

## End-to-end timelines available locally

| Task | Request → completion | Distinct release/merge milestones |
| --- | --- | --- |
| Desktop 1.2.50, Monitor/storage cleanup | 05:25:47 → 08:56:39 Oct 2: **3h30m52s**, including a pause; final resumed stretch **93m01s** | Resumed 07:23:38; PR #593 merged 08:26:54; live release page 08:50:19 |
| Desktop 1.2.49, Devices artwork | 04:57:34 → 07:50:01 Oct 2: **2h52m27s** | Merged 05:43:48; separate release request 07:06:56; work resumed 07:35:56 after another user message; release request → completion **43m05s** |
| Desktop 1.2.38, notification refinement | 00:27:30 → 04:07:50 Oct 1: **3h40m20s** | Explicit merge request 03:21:26; release requested 03:59:40 after review; release request → completion **8m10s** |
| CLI 0.3.41, machine connections | Investigation request 08:08:51 → 09:56:39 Oct 1: **1h47m48s** | Fix requested 09:13:07; merge requested 09:40:59; release requested 09:50:55; release request → completion **5m44s** |

Times are UTC. These include implementation and user review; they are not all
avoidable overhead. The unexplained 29-minute gap after the 1.2.49 release request
has no visible assistant/tool work. Its scheduler/interruption cause is unknown;
it must not be attributed to GitHub or claimed fixed by a repository patch.

## Recurring issues and changes

| Issue and evidence | Remediation |
| --- | --- |
| **Repeated broad validation.** PR #524 records two successful integrated full CI runs and another merged-source run; the latter retried auth startup. PR #579 ran a full local CLI suite and full remote CI. PR #593 started a broad desktop suite at 08:13 after focused desktop checks and full CI were already green. It continued through merge/release. | Root agent instructions, contribution guidance, and a validation/release guide require impact-based checks, reuse by tested source/tree/toolchain, early independent checks, and no automatic second full-suite phase at merge/release. Broad/high-risk changes still need broad validation. |
| **Repeated baseline investigations.** PR #587 documents 23 desktop assertion failures on unchanged source and two stalls; #593 rediscovered the same 23, plus changed-footer assertions later fixed in #596/#598. The full suite was incomplete, not green. | Reuse valid baseline evidence after checking affected source/dependencies. Isolate new failures once with a deadline. Existing baseline records remain historical evidence, not an exclusion list. No assertion is silently ignored. |
| **Unbounded waits and resource failures.** 1.2.50 hit full disk at 07:39; desktop fixtures reached the ten-minute default timeout. The broad CLI attempt took 11m26s and the late desktop attempt about 24 minutes before additional retries. This audit also observed under 0.4 GiB free. | A stdlib validation runner checks disk first, runs independent checks with explicit deadlines, captures results/timing/source fingerprints, detects source edits, and terminates only its own process groups. No automatic reinstall or baseline retry loop. |
| **Developer shell configuration contaminated tests.** Three local doctor/materialize failures included nvm's inherited npm-prefix warning. Reproduction in the sandbox also exposed Oh My Zsh cache/update messages. | Test setup clears inherited npm prefix values and gives zsh a test-owned startup directory. Explicit shell-startup fixtures still supply their own profiles. |
| **Unrelated CI components blocked changes.** Native TUI “respawn death” failed in runs 36753554214, 36949101625 and 36951457360, then passed on rerun, including CLI/desktop work. | Manual/reusable CI now supports explicit component scopes; full remains the default. CLI still includes its complete suite, typecheck, bundle/updater checks, and OS/Node shell/serial matrix. Cross-component work requires all affected scopes. |
| **Restart completion can clear a newer exit.** The local restart RPC callback unconditionally cleared `pane.dead`; an already received replacement exit could then be replayed as new, duplicating its hook. The historical logs discarded the actual hn/tmux mismatch. | Preserve an exit whose identity differs from the pre-restart process. Regression exercises death-before-reply and reply-before-death, including stream replay. Native waits retain recent comparisons/errors. This race is consistent with the historical flake; the old logs cannot prove those runs had this ordering. |
| **An unchanged TUI version was republished.** [Run 36850661290](https://github.com/autonomous-ai/openharness/actions/runs/36850661290) published 0.1.10 on Oct 1; [36980993263](https://github.com/autonomous-ai/openharness/actions/runs/36980993263) replaced all four binaries on Oct 2. The x64 Mac SHA changed from `f2785de2…` to `41944e58…` at the same immutable URL; 0.1.11 followed. | Fail before tests/builds if Cargo's version is already published; recheck at publication, serialize only the manifest job, create artifacts conditionally, and use a generation-conditional manifest write. Existing versions cannot be replaced or rolled back by a late build. |
| **Avoidable full-history checkout.** Desktop 1.2.41 spent 108 seconds checking out history in the GitHub notes job. | Annotated releases fetch only the tagged commit and annotation. Full history is fetched only when a legacy tag lacks notes and needs the commit-list fallback. |
| **Insufficient end-to-end observability.** Most tasks have only PR/Actions timestamps here; those hide pre-PR work and idle gaps. | Validation receipts plus PR/release instructions record request, validation, merge, live publication, completion, and explained waits separately. Unknown stays unknown. |

The TUI storage guard uses [Cloud Storage generation preconditions](https://cloud.google.com/storage/docs/request-preconditions)
to reject collisions and concurrent manifest changes. It does not disable signing,
checksums, updater coverage, native checks, or release integrity checks.

## Historical failures already repaired before this audit

These were real findings, not reasons to suppress tests. Their successful follow-up
runs and fixes are retained in the audit data.

- **#521:** pnpm lockfile missing the new QR dependency; synchronized before final CI.
- **#524:** portable CLI help fixture, realistic deadlines for bulk durable writes
  and repeated password handshakes; behavior/cryptographic assertions retained.
- **#538:** combined signed-in/out auth startup exceeded five seconds; split into
  independent cases rather than rerunning the whole suite.
- **#539 and #584:** obsolete daemon timer/source-wiring assertions updated.
- **#548:** stale per-window model-list expectation repaired.
- **#564:** TUI default option expectation followed the intentional launch-contract change.
- **#565:** Node 20 could acknowledge a cancelled serial write; the native matrix
  caught a real bug and the implementation was repaired.
- **#514:** indexed-color selection/theme checks repaired after the first 0.1.6 attempt.
- **#537:** focused-pane Models behavior repaired after the failed 0.1.10 attempt.

One earlier take-control/reconnect CI failure passed its unchanged rerun. Its
historical output does not identify a root cause; native checks remain enabled.
The two tiny-window native failures and the existing desktop baseline failures
also remain visible in the evidence. This patch does not claim every historical
test assertion or every product bug has been repaired.

## Desktop release coverage

All 17 published versions were included: **1.2.33–1.2.35 and 1.2.37–1.2.50**.
Attempt **1.2.36** was cancelled. This includes all ten releases initially requested
(1.2.41–1.2.50), not just the latest example.

The confirmed 4m35s concurrency wait for 1.2.47 was behind 1.2.46. At the initial
audit, Desktop's whole-workflow lock was retained because its manifest merge lacked
a generation guard; removing that lock alone would risk mixed/older platform
entries. The [publication follow-up](2026-10-02-desktop-release-overlap.md) adds
those guards and narrows the lock to publication and verification. Queueing was a
secondary cost, not an explanation for the hours before tagging.

CLI coverage is **0.3.31–0.3.57**; web coverage is **1.3.14–1.3.25**. TUI logs
cover **0.1.5–0.1.11**, the failed attempts, and the duplicate 0.1.10 publication.
The JSON inventory links each source SHA, workflow, and PR where a merge SHA
matches exactly. A null direct PR does not imply there were no included PRs.

## Validation and follow-through

- 59 affected CLI tests passed with inherited npm prefix values deliberately set;
  CLI TypeScript checking passed on managed Node 22.23.2.
- All 20 process regression tests pass locally. The real TUI
  publisher shell is exercised against a disposable object store for fresh upload,
  duplicate version, immutable-object collision, corrupt manifest, and concurrent
  manifest update. Desktop notes are exercised with annotated and lightweight tags.
- Changed workflow files pass actionlint 1.7.12.
- The Rust restart regression passes with the fix and fails with the old unconditional
  exit clearing (two death hooks instead of one).
- [Full CI](https://github.com/autonomous-ai/openharness/actions/runs/36992127857)
  passed all nine applicable jobs on `c748f0a203f8c022c2c3693a6fc9fdbdbaf4c235`,
  including both native TUI platforms, four serial-platform jobs, CLI, backend, and
  process checks. The final follow-up adds only seven locally passing workflow
  regression tests and this result; production code and workflow inputs are unchanged.
  See [PR #602](https://github.com/autonomous-ai/openharness/pull/602).
- No production release is claimed as validation of this process patch.

The target is to restore the team's previous 10–15 minute **merge/release overhead
for small changes**, without counting only the build. Request-to-completion time
also includes implementation and review. Measure the next ten tasks end to end
before claiming the target is achieved.

## Follow-up: reducing the remaining validation/build path

[PR #605](https://github.com/autonomous-ai/openharness/pull/605) adds dependency
caching, tests/builds the same musl target, runs all ten isolated native fixtures
two at a time, and builds TUI platforms alongside unit tests. Release native tests
exercise the actual Linux artifact. Publication still requires unit tests and all
platform/native checks. The cache action is pinned to its v2.9.2 commit; its
[documented keys](https://github.com/Swatinem/rust-cache#cache-details) include the
Rust toolchain and Cargo inputs, with a separate key for each target.

| Measured phase | Before | First optimized run | With restored caches |
| --- | --- | --- | --- |
| CI dispatch through both native architectures completing | 7m44s | 5m42s | 4m53s |
| Ten native fixtures, x64 | 3m01s | 1m30s | 1m31s |
| TUI release dispatch through tests/builds ready to publish | 6m27s | 3m43s | 3m11s |

The complete build-only release workflows finished in 3m44s and 3m12s. No production
publication was performed for these measurements. Both optimized CI runs passed
the complete native fixture set on x64 and ARM; all four release platforms passed
twice. Cache restoration was confirmed in the logs. All 20 process/publication
regressions and actionlint passed. The implementation tested was
`3874d7c07bcd498a202952abc0936e8503ade472`; the subsequent commit adds comments and
this documentation only.

The [timing records](2026-10-02-native-validation-timings.json) link all six runs.
The old full CI was dominated by native checks; the optimized runs selected the
TUI scope because the other jobs were unchanged. The TUI source, fixtures, Cargo
inputs, and CLI lockfile match the previous CI baseline. These are observed
workflow improvements, not a measured reduction in total request-to-completion
time, and runner/queue variation still applies. A small change ready to ship has
a planning target of roughly 5–10 minutes for PR validation/merge and 15–20 minutes
including a Desktop release; implementation, review, and actual failures must
still be recorded in the total. The earlier 45–65 minute task estimate is not an
acceptable target for routine shipping overhead.
