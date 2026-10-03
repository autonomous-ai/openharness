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
  changes do. See the validation guide for recording that evidence.
- Time-bound tests and baseline diagnosis. An unchanged, already documented failure
  does not need another full baseline run for every release. New failures and failures
  in changed behavior still need investigation. Never describe an incomplete or failed
  suite as passing, and never silently skip a required check to meet a time target.
- Once required checks pass, carry out the authorized merge/release without another
  validation cycle. Verify published versions and checksums, then report completion.
  Desktop's `--wait` follows the exact tag/SHA through the workflow's six-artifact
  verification; reuse that receipt instead of repeating the downloads manually.
