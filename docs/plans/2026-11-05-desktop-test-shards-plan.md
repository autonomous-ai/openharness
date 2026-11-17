# Desktop test shards by measured time Implementation Plan

> **For agentic workers:** implemented task by task, each failing test
> committed before the code that passes it; one review on the pull request.

**Goal:** Every Desktop CI shard finishes with at least 25% of its 10-minute limit left, and a shard that runs out of time
names the files it did not reach.

**Architecture:** `scripts/test-desktop.py` splits the VM test inventory by measured per-file durations kept in
`scripts/desktop-test-durations.json` (longest first, each file to the least-loaded shard; unknown files get the median),
instead of round-robin by name. Equal durations give the old round-robin split, so the shard verifier and its tests keep
working. CI runs 5 shards instead of 4. `scripts/desktop-test-durations.py` refreshes the durations file from CI runs'
shard artifacts. A timed-out attempt lists the files it did not finish, in the log, as a GitHub error annotation and in
the receipt.

**Tech Stack:** Python 3 (stdlib), GitHub Actions.

**Spec:** Task #3458's brief (River, 11-05): shard 3 hit its 10-minute limit three times on 11-05 with tests passing.

## Global Constraints

- PR body first line: "Requested by Ken through Harness."
- CI workflow and test scripts only, no app code. Owns `.github/workflows/`, `desktop/tool/`, `scripts/`.
- Headroom: a shard's estimated time (its files' summed durations / 4 workers + startup) at most 75% of 600 s.
- Job names stay `desktop-tests (ubuntu-22.04, N)`; adding shard 5 adds a job main's merge helper accepts (#2817).

## Review Focus

- A new test file with no measured duration: gets the median, never all piled on one shard.
- The durations file missing or unreadable: falls back to equal weights (round-robin), never fails the run.
- Every file in exactly one shard, the same split on every shard's runner (deterministic on inventory + durations).
- A timed-out run whose last file was mid-way: that file is named as not finished.
- The suite outgrowing 5 shards: a test fails before CI does.

---

### Task 1: Split by measured durations
**Files:** `scripts/test-desktop.py` (partition, durations), `scripts/desktop-test-durations.json`,
`scripts/tests/test_desktop_tests.py`.
- [ ] Failing tests: weighted split balances heavy files; unknown files get the median; equal weights keep round-robin;
  the committed durations + current inventory leave every one of 5 shards at most 75% of 600 s.
- [ ] Code; tests pass; commit.

### Task 2: Name the files a timed-out shard did not reach
**Files:** `scripts/test-desktop.py`, `scripts/tests/desktop_vm_fixture.py` (a "partial" scenario),
`scripts/tests/test_desktop_tests.py`.
- [ ] Failing test: a run that times out after the first file names the second, in stdout and `unreached_files`.
- [ ] Code; tests pass; commit.

### Task 3: Refresh tool and 5 shards in CI
**Files:** `scripts/desktop-test-durations.py`, `.github/workflows/ci.yml`, tests.
- [ ] Failing test: the refresh tool computes per-file durations from a shard log and averages runs.
- [ ] Code; CI matrix to 5 shards; three green runs with per-shard times in the PR.
