# Store pipe spec reads node --test's TAP result: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. One task, one commit: the spec file is both
> the test and the change, and its red is already on record. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cli/src/lib/windows/storePackagesPipe.windows.spec.ts` is green on both Windows jobs when the Store
packages' 19 pipe cases pass, on any Node, and still red when one fails.

**Architecture:** Test code only, one line. The spec's `node --test` spawn names its reporter
(`--test-reporter=tap`) instead of taking Node's default, which changed in Node 23. The two assertions do not change.

**Tech Stack:** TypeScript, Vitest, Node's own test runner (`node --test`). Node 24.22.2 on the Windows jobs
(`.github/workflows/windows.yml:71`). No new dependency.

**Spec:** [docs/plans/2026-11-14-windows-store-pipe-spec-design.md](2026-11-14-windows-store-pipe-spec-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- The check stays as strict: `expect(run.status).toBe(0)` and `expect(run.stdout).toMatch(/^# fail 0$/m)`, both
  untouched (lines 14 and 15).
- No skip, no loosened match, no retry, no longer timeout, no other file. The repo scan in the spec found no other
  code that parses `node --test` output (checked again 2026-11-14 at `b79d017c41`: the only other spawns,
  `store/tools/test-folders.test.mjs:19` and `os/tests/dsh/exercise.mjs:90`, read the exit status or save the output).
- Platforms: Windows x64 and arm64 only. The case is `it.runIf(process.platform === 'win32')`; on macOS and Linux it
  is skipped, so a local `vitest run` of the spec proves nothing and is not evidence.
- The comment at the changed line says why and names the incident (runs 43158661612 and 43557665371).
- One pull request. Its body carries the two red runs, the local proof's output, the green run's link, and the
  platforms.

## Found while reading the code

Checked at `b79d017c41`:

- **The red is this spec alone.** Run 43557665371, both jobs: `Test Files 1 failed | 87 passed | 1 skipped (89)`,
  `Tests 1 failed | 1166 passed | 73 skipped (1240)`. The failure is at `storePackagesPipe.windows.spec.ts:15:24`,
  the `# fail 0` match: the status check on line 14 passed, and the child printed `ℹ tests 19`, `ℹ pass 19`,
  `ℹ fail 0`.
- **How windows.yml starts.** `workflow_dispatch` and `workflow_call` only (`windows.yml:10-35`): no `push`, no
  `pull_request`. `release.yml` calls it with `release: true`, which skips every test step. So PR CI never runs this
  spec, and a run on the branch is started by hand.
- **The red step hides what follows it.** In runs 43158661612 and 43557665371 the steps after it
  (`Two real builds: the pty host rollover and the payload install`, `Collect the payload`,
  `Flasher: without a board`) were skipped, and so was the `install` job (`needs: windows-pty`). The Node pin moved to
  24.22.2 on 2026-11-11 (`ae9ed62ce5`); the last run that got past this step on both jobs is 41506957961
  (2026-11-02). Those parts run again once this step is green.
- **Local gates.** `python3 scripts/local-checks.py --list cli/src/lib/windows/storePackagesPipe.windows.spec.ts`
  prints `{}`; with the two `docs/plans/` files added, `{}` too.
- **No install needed.** This checkout has no `cli/node_modules` (checked 2026-11-14) and the task needs none: its
  proof runs on `node` alone.

## Review Focus

Each line is pinned by a step or a check below. Nothing else was found: the two assertions and the timeout are
untouched.

- A failing case under the TAP reporter: the spec must go red. `node --test` exits 1 and prints `# fail 1`, never
  `# fail 0`. Task 1, Step 1 (the fixture).
- Where the reporter writes: one `--test-reporter` with no `--test-reporter-destination` writes to stdout, which is
  what the spec reads. Task 1, Step 1 (the proof reads stdout only).
- The real thing: Node 24.22.2, real named pipes, both architectures. Nothing off Windows runs the case.
  Verification 1.

---

### Task 1: The spawn asks for TAP

**Depends on:** nothing. **Effort:** medium (mechanical, one file).

**Files:**
- Modify: `cli/src/lib/windows/storePackagesPipe.windows.spec.ts:13`
- Test: the same file.

**The test that fails before the change:** the spec itself, on the base, on both Windows jobs: runs
[43158661612](https://github.com/autonomous-ai/openharness/actions/runs/43158661612) (2026-11-12) and
[43557665371](https://github.com/autonomous-ai/openharness/actions/runs/43557665371) (2026-11-14), step
`Contract suite against the real host, and the Windows CLI specs`,
`expected '✔ harness-monitor: …' to match /^# fail 0$/m`. No red commit: the case runs only on `win32`, so there is
nothing to see fail here.

- [ ] **Step 1: Show the cause on this Mac**

Needs Node 23 or later (this Mac: v23.11.0); on Node 22 the default reporter off a terminal is still TAP and the
first line would not show. Off Windows the cases use sockets in a temporary folder of their own
(`store/tools/test-folders.mjs`) and nothing of the developer's daemon. Run as one shell command, from the repo
root; the two helper files live outside the repo and are never committed.

```bash
proof=$(mktemp -d)
cat > "$proof/proof.mjs" <<'EOF'
// The spec's own command shape: spawnSync, stdout not a terminal, utf8.
import { spawnSync } from 'node:child_process'
for (const reporter of [[], ['--test-reporter=tap']]) {
  const run = spawnSync(process.execPath, ['--test', ...reporter, process.argv[2]], { encoding: 'utf8', timeout: 120_000 })
  console.log(`${reporter[0] ?? 'default reporter'}: status ${run.status}, ${run.stdout.match(/^# fail \d+$/m)?.[0] ?? 'no "# fail" line'}`)
}
EOF
cat > "$proof/failing.test.mjs" <<'EOF'
import assert from 'node:assert/strict'
import { test } from 'node:test'
test('passes', () => {})
test('fails', () => { assert.equal(1, 2) })
EOF
(cd cli && node --version && node "$proof/proof.mjs" ../store/tools/windows-pipe.test.mjs && node "$proof/proof.mjs" "$proof/failing.test.mjs")
rm -r "$proof"
```

Expected (recorded here on 2026-11-14), the pipe cases first, then the fixture:

```
v23.11.0
default reporter: status 0, no "# fail" line
--test-reporter=tap: status 0, # fail 0
default reporter: status 1, no "# fail" line
--test-reporter=tap: status 1, # fail 1
```

Keep the output for the pull request body.

- [ ] **Step 2: Name the reporter in the spawn**

Line 13 becomes, with its comment:

```ts
    // TAP by name: since Node 23 `node --test` reports in `spec` even when stdout is not a terminal, and prints `ℹ fail 0`.
    // On Node 24.22.2 this spec was red with all 19 cases passing (windows.yml runs 43158661612 and 43557665371).
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join('..', 'store', 'tools', 'windows-pipe.test.mjs')], { encoding: 'utf8', timeout: 120_000 })
```

- [ ] **Step 3: Check the diff is that and nothing else**

Run: `git diff --stat && git diff -U0 -- cli/src/lib/windows/storePackagesPipe.windows.spec.ts`
Expected: one file; one line replaced by three (the two comment lines and the spawn); no `-` or `+` line holds
`run.status` or `# fail 0`.

- [ ] **Step 4: Commit**

Add the one file by name: the two documents under `docs/plans/` are untracked here and are not this task's.

```bash
git add cli/src/lib/windows/storePackagesPipe.windows.spec.ts
git commit -m "Windows: the Store pipe spec asks node --test for TAP"
```

---

## Verification

On the final head, after the review. No sign-in, no account, no backend, no production, no secret: the workflow has
`permissions: contents: read`, builds the terminal host in the run, and the cases use named pipes and temporary
folders on the runner. None needs a person's own login or eye.

1. **The Windows workflow on the branch head, once** (`.github/workflows/windows.yml`; GitHub runners
   `windows-latest` for x64 and `windows-11-arm` for arm64; about 40 minutes, going by run 41506957961). It is
   heavy and starts only by hand: only with the orchestrator's go, after the branch is pushed, with no other heavy
   workflow running (`docs/validation-and-release.md`). Start it once: a second start on the same branch cancels the
   first (`concurrency`, `cancel-in-progress`).

   ```bash
   gh workflow run windows.yml --ref fix/windows-store-pipe-spec
   gh run list --workflow=windows.yml --branch fix/windows-store-pipe-spec --limit 1 --json databaseId,headSha,url
   gh run watch <databaseId> --exit-status
   ```

   No inputs: `release` defaults to `false`, so the tests run. The same from the site: Actions, Windows, Run
   workflow, the branch. Check `headSha` is the branch head.

   To see, in both `windows-pty` jobs (x64 and arm64): the step
   `Contract suite against the real host, and the Windows CLI specs` green; in its log no `FAIL` line, and a
   `Test Files` summary with no `failed` count (the base printed `1 failed | 87 passed | 1 skipped (89)`). That step
   green on both jobs is the pass. Report the run's link.

   The later steps and the `install` job run again for the first time since this step went red (above). A red there
   is not this spec: report its job, step and log line with the link, and stop. It becomes a task of its own, not
   part of this branch (decided 2026-11-14), and this branch merges on the contract step green on both jobs. A job
   that times out or is cancelled before that step ends is not a pass.

**Temporary workflow:** none. The long check has its workflow already, and it starts by hand on any branch.

**Checks PR CI does not run:** none required. `python3 scripts/local-checks.py --list` on the branch's paths prints
`{}`, and `npm run test:core` does not apply (nothing under `cli/src/core/` or `cli/src/services/`). PR CI runs what
a `cli/` change selects by itself (`cli-typecheck`, `cli-tests` and the checks that read `cli/`); there the file is
typechecked and loaded, and its one case is skipped.
