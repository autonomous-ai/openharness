# Handoff: Windows native, sub-projects B (CLI) and C (desktop)

Date: 2026-10-18. Written for the agent that executes the sub-project C plan (Codex). Read all of it before you
start.

## TL;DR

- **Windows ships to users as one piece: A + B + C together, in one merge, when C is done.** The owner's rule: a
  sub-project a user cannot use on its own is never merged or released separately. Do not propose merging B (or A)
  first.
- **A** (terminal host) and **B** (the Harness CLI on native Windows) are finished, reviewed and green on CI. They live
  on `feat/windows-native-cli`, and `feat/windows-desktop` is built on top of it.
- **C** (the Harness desktop app on native Windows) has an approved spec and a stitched plan of 28 tasks. Nothing of C
  is implemented yet. Your job is to execute the C plan, task by task, on `feat/windows-desktop`. That branch becomes
  the one PR that ships Windows.

## Where things are

| | B: CLI on Windows | C: desktop on Windows |
|---|---|---|
| Branch | `feat/windows-native-cli`, pushed | `feat/windows-desktop`, created from B's head `338e589bc`, not pushed |
| Worktree | `~/harnesses/worktrees/openharness/bold-finch` | `~/harnesses/worktrees/openharness/amber-heron` |
| Spec | `docs/superpowers/specs/2026-10-16-windows-native-cli-design.md` | `docs/superpowers/specs/2026-10-18-windows-desktop-design.md` (untracked) |
| Plan | `docs/superpowers/plans/2026-10-16-windows-native-cli.md` | `docs/superpowers/plans/2026-10-18-windows-desktop.md` (untracked, 28 tasks) |
| Other | E2E results `docs/testing/windows-cli-e2e.md` | Reconcile report `docs/superpowers/plans/2026-10-18-windows-desktop-reconcile-report.md` (seams, rulings, spec coverage map) |

C's spec and plan are **not committed**. Commit them as the first commit on `feat/windows-desktop` (`docs: Windows
desktop spec and plan`), together with this handoff and the reconcile report, before Task C1.1.

## How to execute the C plan

**Order.**
- Run the tasks in plan order: C1.1–C1.6, C2.1–C2.4, C3.1–C3.7, C4.1–C4.8, C5.1–C5.3.
- C4.8 (install by one command, `irm …/desktop/install.ps1 | iex`) was added after stitching, at the owner's
  request. It changes B's `install.ps1` and `upload-install-ps1.sh`, so B's own `installPs1` cases must stay green.
- Each task is TDD, with full code in the plan: write the failing test, see it fail, implement, see it pass, commit.
- Every task's requirements include the plan's **Global Constraints**.
- Read the plan's **Review Focus** before each phase. Each item names the task whose test pins it.

**Where the code is wrong.** The plan argues from the spec, and the spec is binding. Where the plan's code does not
match the real repo (a renamed helper, a moved file):
- adapt the code to the repo while keeping the task's behaviour and tests;
- record it in the commit message body.

**Commits.**
- One task is one commit, or a few, with conventional messages like the branch's (`feat(desktop): …`, `fix(windows): …`).
- Branch commits are authorized.
- Never commit to `main`, and never force-push.

**Windows-only code** cannot run on the Mac. Unit-test it with the platform injected, as the plan shows, then prove it
on Windows CI:
- C1.4 creates `.github/workflows/windows-desktop.yml` with a TEMPORARY `push:` trigger on `feat/windows-desktop`.
- Pushing the branch runs it on `windows-latest` (x64) and `windows-11-arm` (arm64).
- Pushes of `feat/windows-desktop` are authorized.

CI discipline (repo `AGENTS.md`):
- Read a red job's log, fix it, then push once.
- Do not push repeatedly to retrigger.
- Do not start a manual run while an automatic one exists.
- Rerun a job only for a recorded flaky test.
- The account runs at most 20 jobs at once, 5 on macOS.

**Commands.**
- Desktop: `cd desktop && flutter test test/<file>_test.dart`, and `flutter analyze <paths>`. Requires Flutter ≥ 3.47 / Dart ≥ 3.13.
- CLI: `cd cli && npx vitest run <spec>`.
- Rust: `cd pty && cargo test …`.
- The desktop full suite on macOS has known base failures, about 26 on 2026-09-25. Compare test by test against a
  clean worktree of the base, never by count.

## Hard safety rules (incidents happened; do not relearn them)

**This Mac.**
- Never test against the developer's own machine:
  - the real `~/.harness`;
  - the real daemon on port **18473**;
  - the real engine homes (`~/.claude`, `~/.codex`, …);
  - the real tmux server.
- Tests use throwaway homes and data folders.
- **Never run `harness service install` or any launchd step on this Mac.** In B5.14 a launchd test daemon ran
  against the real `~/.harness` and rewrote 16 real engine hook files (finding G7; the plist carries no `HOME`).

**The Windows VM.** It is `ssh admin@192.168.65.3`: UTM Win11 ARM64, key auth, firewall rule `-Profile Any`.
- **Never touch `C:\work\e2e`**, which holds a signed-in daemon.
- Never change the admin profile's engine settings without a backup and a restore.
- Use a throwaway user (B used `hxe2e`) or a throwaway folder, and clean up after.
- The HKLM Winlogon autologon exception is for tests only (B preflight ruling 48).

**Publishing.**
- **No production publish.** Production manifests and versioned production paths are the owner's step, after merge.
- **Staging publishes need the owner's OK first.** C5.2 Steps 1 and 6 publish to staging by pushing a
  `ci(windows): desktop staging release <v>` commit. C5.2 Step 8b runs `upload-install-ps1.sh --app`. A published version is immutable. Ask before the first one.
- The GCS bucket is `s3-autonomous-upgrade-3`, and the CDN is `https://cdn.autonomous.ai`.

**Git.**
- Never use bare `git stash`. The stash is shared across worktrees; use a WIP commit instead.
- Never `git clean -fdx`. It deletes the git-ignored `.superpowers/` workspace.

**Public repo.**
- The repo is **public**, including its Actions run pages.
- Security notes stay terse, with no exploit steps.
- No secrets, emails or full ids in committed evidence; shorten ids.

**Docs and copy.**
- Docs, code comments and commit messages are in English.
- Visible copy follows `docs/naming-system.md`. It is plain words a first-time user understands, with no internal
  jargon on screen.

## Open decisions for the owner (ask; do not decide)

1. **Staging publishes in C5.2** (Steps 1, 6 and 8b). See above.
2. **`kMinimumWindowsHarnessCliVersion = '0.4.20'`** (C1.3) assumes B ships as CLI 0.4.20. Production is 0.4.18
   today, and B's staging build is `0.4.18-dev.win1`. Raise it to B's real first release before C ships.
3. **arm64.** If C1.4 Step 6 finds a plugin that cannot build for arm64, the fallback is x64-only with the publish
   script's third argument optional. The plan rules this, but its code is not written in advance.

## Things to watch (from the reconcile report)

- The whole-scalar quoted `cancel-in-progress: "${{ … }}"` in `windows-desktop.yml`: a release run must not be
  cancelled. Check it on the first release-mode run (C4.7 Step 6).
- **Known copy gaps:**
  - `daemon_slot.dart`'s chord tooltip still shows Linux text on Windows;
  - `box_chrome.dart`'s lower-case chord form still shows Linux text on Windows.
- **Optional, not planned:** time a busy terminal over the pipe against TCP
  (`cli/scripts/benchmark-terminal-latency.mts`).
- **Daemon port.** On a shared PC the second user's daemon is not on 18473. C2.3 Steps 7–9 make the app use the port
  recorded in `daemon-18473.json`. Do not "simplify" it back to a hard-wired 18473.

## B: state (finished, not merged on purpose)

**Done.**
- All tasks were reviewed and fixed. The final whole-branch review (4 opus reviewers by area), its fix wave and two
  re-reviews all passed.
- `main` was merged in (`eb7c5c9bb`).
- Windows CI on the merged head is **all green**: run 39099428447 covers the windows-pty jobs and the install →
  uninstall jobs on x64 and arm64.
- Full CLI suite on macOS: about 17,080 pass. The remaining 66 red tests are the same names on `main` and on the
  branch.

**Staging is published** (CLI only).
- `0.4.18-dev.win1`, installed with `irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex`.
- Production manifests are unchanged.

**Follow-ups recorded in B's spec, Known limits.** The main ones:
- agent commands on loopback TCP on Windows: another local account can reach them; move them to the
  authenticated pipe;
- no daemon at boot with nobody signed in;
- the full CLI unit suite on Windows;
- `harness-launch --exec`.

**Tell the owner** that on their Mac, after the G7 repair, one `harness stop; harness start` rewrites the hooks in
0.4.17's own format. It was suggested and not yet confirmed done.

## Shipping Windows (after C5.3, owner's go at each step)

1. **Bring `main` in** while C runs whenever it drifts far, and once more before the PR. B already merged `main`
   once; expect conflicts in the terminal and messages layers. Re-run the affected checks after every merge.
   Reuse earlier evidence only where the merge did not touch its inputs.
2. **Remove both TEMPORARY `push:` triggers:** B's in `.github/workflows/windows.yml` (`feat/windows-native-cli`) and
   C's in `.github/workflows/windows-desktop.yml` (C5.3 removes C's).
3. **Final whole-branch review** of everything A + B + C adds over `main`. B's parts were reviewed, so weigh C and the
   A/B ↔ C seams.
4. **One PR** from `feat/windows-desktop`: let `ci/required` run, then merge with
   `make merge-pr ARGS="N --reviewed-head SHA --reviewed-base SHA --merge"`. No `--queue`.
5. **After the merge, production, asking before each step.**
   - **CLI side:**
     1. the Windows Node runtime manifest, through the Node workflow with the production `metadata_path`;
     2. `cli/scripts/promote-pty-payload.sh`, which uploads nothing and verifies sha256 and size;
     3. `upload-install-ps1.sh --production`;
     4. the CLI release.
   - **Desktop side:** the Windows desktop artifacts go to production in sub-project D (signing). Until D lands, ask
     the owner whether the unsigned build ships to production or waits for D. If it ships, it is the production
     manifest's Windows keys, then `upload-install-ps1.sh --app --production`, so the website can give
     `irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex`.

## Working with the owner

- They chat in **Vietnamese**, including questions and option lists. Keep technical terms in English.
- They prefer a recommendation and execution over a menu of options. Ask only for decisions that are theirs: the
  open decisions above, publishing, and merging.
- They ship complete features to users, never a partial sub-project merge.
- Report progress as short tables when asked ("tien do sao roi", "table tien do di").
- Never describe a failed or incomplete check as passing. Say what ran and what did not.
- Remove dead code, leave no inert stubs or debug output, and keep changes KISS.
