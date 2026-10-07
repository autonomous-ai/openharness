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
- Prepare the PR and complete code/native review while automatic CI runs. For an
  agent implementation in progress, push to a draft PR: CI runs cheap workflow
  and process checks. Mark ready after targeted local checks to start complete
  affected suites, and keep the revision stable while CI and review finish.
  The integration gate remains blocked on drafts. For an authorized merge, use
  `make merge-pr` with the reviewed head/base SHAs and
  `--queue --merge`; it enqueues the exact reviewed head, follows the queue and
  verifies the merged tree against successful merge-group CI. Main advancing
  does not invalidate the review base; the queue checks the combined candidate.
  GitHub approval requirements remain as configured; this does not introduce
  an additional human approval count. Keep review independent of implementation.
  Existing `--run/--scope` commands automatically select queue mode when the
  target's merge-queue rule is enabled; direct mode remains for rollout only.
  For evidence outside the queue, use `scripts/record-ci-validation.py` and the
  existing verified Process/Desktop source-input contracts. Other affected
  native, browser, engine and hardware checks remain explicit review requirements.
  Never replay an uncertain enqueue/merge mutation; inspect the same PR first.
- For an authorized Desktop release, start `make release-desktop ARGS="--prepare"`
  from the final pushed PR branch alongside validation and review. It prepares
  verified packages without publishing; merge and release only after checks pass.
  Avoid starting candidates while implementation is still changing. The release
  automatically reuses matching Desktop build inputs/version and otherwise builds
  normally; unrelated CLI, firmware or documentation merges do not force a rebuild.
