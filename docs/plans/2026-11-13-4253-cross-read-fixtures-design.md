# CLI Super Tab path fixtures are data, not cross-reads (#4253)

## Why

`scripts/tests/test_ci_plan.py` `CrossReadTests.test_every_cross_read_in_this_repository_is_declared` fails on a full
checkout of main (`d80ed139fc`). Its `cli` subtest reports four reads that are not declared:

| Source | Target |
|---|---|
| `cli/src/superTabs/githubMerge.spec.ts` | `backend/src/superTabs/`, `backend/src/superTabs/commands.ts` |
| `cli/src/superTabs/plainPath.spec.ts` | `docs/` |
| `cli/src/superTabs/pmNumbers.spec.ts` | `backend/src/superTabs/commands.ts` |

None of these specs opens those files: they hold repository paths as test data (a pull request's files, a path to
make plain, a hot file's name). They came in with #4177.

CI stays green because `process-checks` runs in a sparse checkout, where the test skips. The merge helper runs the
same scan (`undeclared_reads` in `scripts/ci-plan.py`) on a full checkout before it accepts reused results. Once main
changes anything under `docs/` or `backend/src/superTabs/` after a PR's CLI run, it refuses to reuse the `cli` suite
and asks for another push, for no reason.

## What changes

`NOT_READS` in `scripts/ci-plan.py` declares the paths these three specs hold as test data:

- `cli/src/superTabs/githubMerge.spec.ts`: today `{"docs/"}`; it also names `backend/src/superTabs/`.
- `cli/src/superTabs/plainPath.spec.ts`: `{"docs/"}`.
- `cli/src/superTabs/pmNumbers.spec.ts`: `{"backend/src/superTabs/"}`.

Each entry carries a short reason, as the existing ones do. A data folder covers the paths under it, so
`backend/src/superTabs/` also covers `commands.ts`; a relative read (`new URL('../..', import.meta.url)`) is still
reported (`test_a_data_folder_covers_the_paths_under_it_but_never_a_relative_read`).

## Constraints

- `DEPENDS` does not change: listing these would rerun the CLI suite on every `docs/` or backend Super Tab change.
- The specs themselves do not change.
- Only `scripts/ci-plan.py`. The test that proves it already exists and fails today on a full checkout.

## Done when

`python3 -m unittest scripts.tests.test_ci_plan` passes on a full checkout of the branch, and the whole
`scripts/tests` suite passes.

## Design

N/A because no data is stored, synced or exposed: a CI planner table changes.
