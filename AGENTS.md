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
- Prepare the PR and review while checks run. For an authorized merge after review
  and required non-CI checks, use `make merge-pr` with the reviewed head/main SHAs,
  CI run/scope, and `--merge` (see the validation guide). It collects CI evidence,
  rechecks the source, merges, and verifies the resulting tree. For evidence only,
  use `scripts/record-ci-validation.py RUN_ID --scope SCOPE --pr PR_NUMBER --wait`.
  Retain routine results in the ignored receipt and PR body instead of another
  documentation commit. Resolve source differences explicitly before reusing evidence.
  Process and Desktop VM CI can retain the original run across unrelated changes
  when their verified source-input contracts match; pass that run to the same
  collector/merge helper. Check its changed-path list and validate other affected
  scopes separately. Changes to included tests, dependencies or workflows require
  new evidence; see the validation guide for the complete input boundaries.
- For an authorized Desktop release, start `make release-desktop ARGS="--prepare"`
  from the final pushed PR branch alongside validation and review. It prepares
  verified packages without publishing; merge and release only after checks pass.
  Avoid starting candidates while implementation is still changing. The release
  automatically reuses matching Desktop build inputs/version and otherwise builds
  normally; unrelated CLI, firmware or documentation merges do not force a rebuild.
