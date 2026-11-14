# installPs1.spec allows its unsigned terminal host in every install case: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. One task, one commit: the spec file is both
> the test and the change, and its red is already on record. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cli/src/scripts/installPs1.spec.ts` is green on both Windows jobs again: the two cases that install an
unsigned terminal host without the allowance get it the way the rest of the file does.

**Architecture:** Test code only, one file. One helper, `installEnv`, builds the environment of every whole install
run (`install()` and the two `irm | iex` cases), always with `HARNESS_ALLOW_UNSIGNED=1` in it. The probation case's
two `ps()` calls pass the same variable. `install()` loses its unused `signed` parameter. `install.ps1` is not
touched, so a real install is refused exactly as before.

**Tech Stack:** TypeScript, Vitest, Windows PowerShell 5.1 on the Windows jobs. No new dependency.

**Spec:** [docs/plans/2026-11-14-windows-install-unsigned-host-design.md](2026-11-14-windows-install-unsigned-host-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- The only file changed is `cli/src/scripts/installPs1.spec.ts`. `cli/scripts/install.ps1`, the updater and every
  workflow stay byte for byte as they are.
- No new switch, environment variable or flag: the door is the existing `HARNESS_ALLOW_UNSIGNED=1`
  (`docs/windows-code-signing.md`), set in a child's environment. One way: no function override.
- No assertion changes, no skip, no retry, no longer timeout. The case "names each terminal host file that is unsigned
  or signed by someone else, also under PowerShell 7's modules" is not touched and still runs: it is the one case
  that asserts the refusal without the door, and the condition for dropping `signed`.
- Platforms: Windows x64 and arm64, test only. The three `describe.runIf(windows)` blocks skip on macOS and Linux.
- Comments say why and name the incident (#4018). Run IDs go in the commit message and the pull request body, which
  carries the red run, the green run's link, the local check's output and the platforms.

## Found while reading the code

Checked at `905fb180ec` on 2026-11-14:

- **The red is on this exact file.** Run [43560364769](https://github.com/autonomous-ai/openharness/actions/runs/43560364769)
  ran at `a657c762da`, where `installPs1.spec.ts`, `install.ps1` and `windows.yml` are identical to this base. Both
  `windows-pty` jobs, step `Two real builds: the pty host rollover and the payload install`:
  `Test Files 1 failed | 3 passed (4)`, `Tests 2 failed | 83 passed (85)`, at `installPs1.spec.ts:562:83` (`after 0`)
  and `:666:40` (`moved.status`). The `install` job was skipped.
- **Where the code is.** `install()` (line 365), the failure case's spawn (503) and the Restricted case's (560) are
  all in the block `install.ps1, installing for real from a local manifest`. The probation case is in the next block
  and calls the module-level `ps()` (665 and 670). Lines move once the helper is added: find each case by its title.
- **No case passes `signed: true`.** `install()` is local to its `describe` block and has nine calls (lines 406 to
  511), each on one line, with at most five arguments; #4018 added the sixth parameter with no caller, and its
  comment names "the case that refuses one", which is not in the file. Decided: the parameter and that comment go,
  and `installEnv` gets no such parameter. The refusal keeps its own case, the signature one (line 273).
- **How windows.yml starts.** `workflow_dispatch` and `workflow_call` only, so PR CI never runs these cases. A second
  start on the same branch cancels the first (`concurrency`).
- **This checkout.** No `cli/node_modules`; the branch is not on `origin` yet.
  `python3 scripts/local-checks.py --list` on the spec file and the two `docs/plans/` files prints `{}`.

## Review Focus

- A real install stays refused: `install.ps1` is not in the diff (Step 4), and the signature case, which asserts the
  refusal without the door and the pass with it, is untouched and shows `✓` in Verification 1.
- `env` is spread last in `installEnv`, so a caller adds to the base and loses none of it: the Restricted case, which
  adds `HARNESS_INSTALL_MANIFEST`, reaching `after 0` pins it (Verification 1).
- The failure case still fails where it did, now with the allowance in its environment (`Reading the release
  manifests`, `after 1`): its own two assertions (Verification 1).
- `signed` is gone from `install()` and no comment names a refusing install case: no call passed it (Step 4), and
  the refusal is still asserted, by the signature case.
- Not this spec's: no case runs the signature check under `-ExecutionPolicy Restricted`, as a real signed `irm | iex`
  install does. The Restricted case passes by the door, and CI has no signed host. A proposal, not a task.

---

### Task 1: One environment for a whole install, and the probation case's allowance

**Depends on:** nothing. **Effort:** medium (mechanical, one file).

**Files:**
- Modify: `cli/src/scripts/installPs1.spec.ts`
- Test: the same file.

**The test that fails before the change:** two existing cases, red on the base on both Windows jobs in run
[43560364769](https://github.com/autonomous-ai/openharness/actions/runs/43560364769): "installs by irm | iex under the
Restricted execution policy, and harness then runs from a Restricted PowerShell" and "removes a terminal host
probation marker when it moves current-pty, and keeps it when the pointer stays". No red commit: both run only on
`win32`, so nothing can be seen to fail on this Mac. One commit.

- [ ] **Step 1: Add `installEnv` above `install()`, and have `install()` use it**

The helper's comment replaces the two-line comment now on `install()`:

```ts
  /**
   * The environment of a whole install run in this block: the throwaway profile and PATH key, then [env]. These
   * builds' payload files are not signed (`build`), so every run allows that, as only a test may. In one place
   * because the two `irm | iex` cases built their own, and when install.ps1 began to refuse an unsigned terminal
   * host (#4018, 2026-11-11) the Restricted one was refused.
   */
  function installEnv(home: string, subkey: string, env: NodeJS.ProcessEnv = {}, modulePath: ModulePath = 'default'): NodeJS.ProcessEnv {
    return powershellEnv(modulePath, { USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey, HARNESS_ALLOW_UNSIGNED: '1', ...env })
  }
```

First check no call passes a sixth argument to `install()`. Expected: no output (checked on the base: nine calls,
none with a sixth). A line printed is read; a real sixth argument stops the task and is reported. Step 5's
typecheck would refuse one too.

```bash
grep -n "\binstall(" cli/src/scripts/installPs1.spec.ts | grep -v "function install(" | grep -E "signed|(,[^,]*){5}\)"
```

Then `install()` drops its `signed` parameter and keeps the other five and its arguments to `powershell.exe`:

```ts
  function install(home: string, manifest: string, subkey: string, extra: string[] = ['-NoService'], modulePath: ModulePath = 'default') {
```

Its `env:` becomes `installEnv(home, subkey, {}, modulePath)`. No call site changes.

- [ ] **Step 2: The two `irm | iex` cases use it**

Only the `env:` of each spawn changes; script text, execution policy, timeouts and assertions stay.

- "reports the failure and leaves the PowerShell it was iex-ed into running": `env: installEnv(profile(), subkey)`.
- "installs by irm | iex under the Restricted execution policy, …":
  `env: installEnv(home, subkey, { HARNESS_INSTALL_MANIFEST: manifest })`.

- [ ] **Step 3: The probation case allows its placeholder host**

In "removes a terminal host probation marker when it moves current-pty, and keeps it when the pointer stays", both
`ps()` calls (`moved` and `same`) take `{ HARNESS_ALLOW_UNSIGNED: '1' }` as their second argument. Above the first:

```ts
    // The version folders hold placeholder text, not signed programs: allowed as a developer's build is, the door the
    // signature case uses. Without it Install-HarnessPty refuses a version folder already there (#4018).
```

- [ ] **Step 4: Check the diff is that and nothing else**

From the repo root:

```bash
git status --short
grep -c "HARNESS_ALLOW_UNSIGNED: '1'" cli/src/scripts/installPs1.spec.ts
grep -n "powershellEnv(" cli/src/scripts/installPs1.spec.ts
grep -cE "signed = false|signed \?|signed: true" cli/src/scripts/installPs1.spec.ts
git diff -U0 cli/src/scripts/installPs1.spec.ts | grep -c "names each terminal host file"
```

Expected: one modified file (the two `docs/plans/` files are untracked and not this task's); `4` (the signature
case, `installEnv`, the probation case's two); four `powershellEnv(` lines: its definition, `ps()`, `installEnv`, and
the library-mode `Restart-HarnessDaemon` spawn in "goes on once `harness start` has started the daemon" (not an
install: left as it is); `0` (no `signed` parameter, no comment naming a refusing case); `0` (the signature case is
not in the diff; read the diff to see none of its lines, 271 to 289 on the base, changed).

- [ ] **Step 5: Local check**

```bash
cd cli && npm ci        # only when cli/node_modules is missing, as it is in this checkout
npx vitest run src/scripts/installPs1.spec.ts
npm run typecheck
```

Expected: `Test Files 1 passed (1)`, `Tests 13 passed | 31 skipped (44)` (counted from the file's four blocks, not
run for this plan); `tsc --noEmit` exits 0. This shows the file loads and typechecks; it is not the green.

- [ ] **Step 6: Commit**

Add the one file by name.

```bash
git add cli/src/scripts/installPs1.spec.ts
git commit -m "Windows: installPs1.spec allows its unsigned terminal host in every install case" \
  -m "Red on windows.yml run 43560364769, x64 and arm64: the Restricted irm | iex case and the probation case were refused by #4018's signature check. Test only; install.ps1 is unchanged."
```

---

## Verification

On the final head, after the review. No sign-in, account, backend, production or secret: the workflow has
`permissions: contents: read`, builds the terminal host in the run, and the cases use temporary profiles and throwaway
registry keys on the runner. Nothing here needs a person's own login or eye.

1. **The Windows workflow on the branch head, once** (`.github/workflows/windows.yml`; GitHub runners `windows-latest`
   for x64 and `windows-11-arm` for arm64). In run 43560364769 the `windows-pty` jobs reached the end of this step in
   15 minutes (x64) and 38 (arm64); the `install` job then has a 30-minute limit. It is heavy and starts only by hand:
   **only with the orchestrator's go**, after the branch is pushed, with no other heavy workflow running
   (`docs/validation-and-release.md`). Start it once.

   ```bash
   gh workflow run windows.yml --ref fix/windows-install-unsigned-host
   gh run list --workflow=windows.yml --branch fix/windows-install-unsigned-host --limit 1 --json databaseId,headSha,url
   gh run watch <databaseId> --exit-status
   ```

   No inputs: `release` defaults to `false`, so the tests run. Check `headSha` is the branch head.

   To see, in both `windows-pty` jobs: the step `Two real builds: the pty host rollover and the payload install`
   green, with `Test Files  4 passed (4)` and `Tests  85 passed (85)`, and in its verbose log a `✓` on each of four
   cases: the Restricted `irm | iex` one, the probation one, "reports the failure and leaves the PowerShell it was
   iex-ed into running", and "names each terminal host file that is unsigned or signed by someone else, …". Then the
   `install` job starts on both architectures instead of being skipped. Report the run's link.

   The pass, and the merge gate, is that step green on both jobs with the four `✓`; the signature case's `✓` on x64
   and arm64 is what shows the refusal is still asserted now that `signed` is gone. The steps after it and the
   `install` job run for the first time since 2026-11-02: a red there for a reason of its own is reported with its
   job, step and log line, does not block the merge, and is separate work, not fixed on this branch. A job that
   times out or is cancelled before the step ends is not a pass.

`windows-desktop.yml` runs the same spec file and is fixed by the same change; it is not started for this branch
(decided: one `windows.yml` run, no other end-to-end check).

**Temporary workflow:** none. The long check has its workflow already, and it starts by hand on any branch.

**Checks PR CI does not run:** none required. `python3 scripts/local-checks.py --list` on the branch's paths prints
`{}`, and no coverage gate covers `cli/src/scripts/`. PR CI's `cli-typecheck` and `cli-tests` typecheck and load the
file; its Windows cases are skipped there.
