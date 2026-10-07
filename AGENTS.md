# Development and release work

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and the component's instructions. For
validation and shipping, use [docs/validation-and-release.md](docs/validation-and-release.md).

For product names, terminology, and visible copy, follow the
[Naming System](docs/naming-system.md).

- Measure the user's request through completion. Record implementation, validation,
  merge, publication, and waiting separately; an Actions duration is not the total.
- Choose the necessary checks before starting them. Run affected tests and relevant
  integration checks; use full suites for broad changes. Start independent checks
  together within the machine's capacity. Do not add a second full local suite after
  equivalent CI has passed just because it is time to merge or release.
- Reuse evidence only for the source and environment it covers. A squash with the same
  tree does not invalidate it; conflict resolutions, dependencies, or relevant code
  changes do. For deterministic checks, declare complete input/toolchain scopes in
  the validation plan and pass the prior receipt with `--reuse`; inspect the diff
  for new interactions. See the validation guide for recording that evidence.
- Time-bound tests and baseline diagnosis. An unchanged, already documented failure
  does not need another full baseline run for every release. New failures and failures
  in changed behavior still need investigation. Never describe an incomplete or failed
  suite as passing, and never silently skip a required check to meet a time target.
- Once required checks pass, carry out the authorized merge/release without another
  validation cycle. Verify published versions and checksums, then report completion.
  Desktop's `--wait` follows the exact tag/SHA through the workflow's six-artifact
  verification; reuse that receipt instead of repeating the downloads manually.
- CI rules (details in [docs/validation-and-release.md](docs/validation-and-release.md#pr-ci)):
  - PR CI is fast on purpose. It runs only the Linux unit checks of the components
    the PR changes; docs, workflow and script changes run process checks only. The
    one required check is `ci/required`.
  - Push work in progress to a draft PR (process checks only). Mark it ready to run
    the component checks, then keep the head stable while CI and review finish.
    Do the code review while CI runs, and keep review independent of implementation.
  - Base the branch on current `main`. A branch older than #991 runs the old
    planner and fails `ci/required`; use **Update branch** or rebase first.
  - Merge with `make merge-pr ARGS="N --reviewed-head SHA --reviewed-base SHA --merge"`.
    It verifies automatic `ci/required` evidence and directly squash-merges the
    reviewed head. A merge queue is not a prerequisite for merging or releasing;
    do not add `--queue` or ask for queue setup. The helper respects a queue only
    if GitHub actually requires it. Do not use `--run/--scope` for ordinary merges
    (legacy manual evidence). Never replay an uncertain merge; inspect the PR.
    If another merge advances `main`, fetch and integrate it, review the combined
    change, reuse unchanged validation and run only newly affected checks. Then
    continue the authorized merge without another permission question. Do not
    toggle repository rules based on how many PRs or CI jobs are running.
  - Do not start extra runs for a PR: no manual **CI → Run workflow** while its
    automatic run exists, no repeated pushes to retrigger a red check. Read the
    failure, fix it, push once. Rerun a job only for a recorded flaky test.
  - Checks PR CI no longer runs are yours to run locally when you touch their area:
    CLI coverage gates (`npm run test:core`, `test:harnessd`, `test:resume`,
    `test:orchestrator`, `test:sharing`, `test:remote-viewers`, `test:portability`,
    `test:local-models`), serial and PTY specs, and Desktop tests on macOS for
    macOS-specific code. Record what you ran in the PR.
  - Heavy workflows run only when started by hand: OS images and VM tests
    (**Harness OS** and the other OS workflows) and CLI end to end (nightly too).
    Start one only when the change needs it, once, and report its run link.
  - The account runs at most 20 jobs at once, 5 on macOS. Do not run several
    heavy manual workflows at the same time.
  - Release workflows are not a full test suite (CLI release runs typecheck, Desktop
    release builds and signs). A release failure is still a code failure: fix it
    and cut the next version; never move a published tag.
- For an authorized Desktop release, start `make release-desktop ARGS="--prepare"`
  from the final pushed PR branch alongside validation and review. It prepares
  verified packages without publishing; merge and release only after checks pass.
  Avoid starting candidates while implementation is still changing. The release
  automatically reuses matching Desktop build inputs/version and otherwise builds
  normally; unrelated CLI, firmware or documentation merges do not force a rebuild.
