# Handoff: sub-project E, the Harness dial on Windows

Date: 2026-10-20. For the agent that implements E. Read this first, then the spec and the plan.

## What E is

On a Windows 10/11 PC (x64 or arm64) with the Harness CLI installed, a Harness dial plugged in by USB works as it
does on a Mac: the daemon finds it and shows this computer's agents on it, the desktop's Devices tab lists and
changes it, its firmware updates over the cable, and `harness flash` (and Flash firmware in the app) re-flashes it.
Per user, with no administrator rights, no driver and no UAC prompt.

- Spec: `docs/superpowers/specs/2026-10-19-windows-dial-design.md`, the binding authority.
- Plan: `docs/superpowers/plans/2026-10-19-windows-dial.md`, 11 tasks, E1.1–E5.3, with full code and tests.

Both were written on 2026-10-19 and are not committed yet. The copies in this worktree are the current ones: they
name this branch. Older copies in `amber-heron` still say `feat/windows-desktop`; ignore them.

## Where things are

| | |
|---|---|
| Worktree | `~/harnesses/worktrees/openharness/windows-dial` |
| Branch | `feat/windows-dial`, cut from `feat/windows-desktop` at `8fb220f15`, not pushed yet |
| Merges into | `feat/windows-desktop`, when E5.3 is done and the owner agrees |
| Ships in | One PR with A, B, C and F (the owner ships Windows as one piece; never merge E alone to `main`) |

Other work on the same line, which you must not touch:

- **C** (desktop on Windows) is on `feat/windows-desktop` in the worktree `amber-heron`. Another agent is still running
  C5.2's last live checks there. Its tasks through C5.3 have landed. Do not edit, commit to or push
  `feat/windows-desktop`, and do not touch `amber-heron`.
- **F** (`harness-install.exe`, Windows in the desktop release) is in the worktree `windows-installer`, branch
  `feat/windows-installer`, uncommitted. It also edits `desktop/scripts/windows-e2e/README.md`,
  `desktop-e2e.sh` and `cli/src/scripts/windowsWorkflows.spec.ts`. In the README, E's `VM_ADMIN` paragraph comes
  first and F's `install-state.ps1` paragraph follows it; F rebases onto E, not the other way round.

## First steps

1. `cd ~/harnesses/worktrees/openharness/windows-dial`, then install dependencies (`cd cli && npm ci`, and the same in
   `website/` when E4.1 needs it). Do not symlink another worktree's `node_modules`.
2. Commit the spec, the plan and this handoff as the branch's first commit:
   `docs: Windows dial spec, plan and handoff`.
3. Run the plan with superpowers:subagent-driven-development (or superpowers:executing-plans). Its ledger goes in this
   worktree's `.superpowers/sdd/2026-10-19-windows-dial/progress.md`.
4. Order: E1.1, E1.2, E1.3, E2.1, E2.2, E3.1, E4.1, E4.2, E4.3, E5.1, E5.2, E5.3. Each task is TDD: write the
   failing test, see it fail, implement, see it pass, commit.

## Notes for the plan, checked on 2026-10-20

- **The plan's code was checked against `feat/windows-desktop` as of 2026-10-19, around noon.** Since then nothing
  has changed in the files E edits (`serial.ts`, `usbConsoleUser.ts`, `cableFleet.ts`, `flash.ts`, `flasher.dart`,
  `serial_port_lease.dart`, `install.ps1`, `windows.yml`). These did change:
  - `cli/src/scripts/windowsWorkflows.spec.ts`, by C5.3;
  - `website/next.config.js`, by #1414 from `main`;
  - `cli/src/cable/cableSession.ts`, by #1420 and #1422 from `main` (E does not edit it).

  If a diff in the plan no longer applies, apply it by its intent and record a `Ruling:` line in the ledger.
- **CI.** `windows.yml` is not on `main`, so it has no **Run workflow** button. It runs only through its TEMPORARY push
  trigger. E1.2 Step 3 adds `feat/windows-dial` to that trigger; keep `feat/windows-desktop` in the list too. Every
  push starts two heavy jobs (x64 and arm64), so push only where the plan says (E1.2, E2.2, E3.1, E4.1); E1.3 and E5.2 use those runs' artifacts.
  Never push again just to retrigger a red run: read the failure, fix it, push once. Removing the TEMPORARY trigger
  belongs to the final Windows PR (`2026-10-18-windows-desktop-handoff.md`, "Shipping Windows"), not to E.
- **E5.2 consumes C's staging desktop build.** That is now 1.0.3 (published during C5.2), not "N1". Use it as it is.
  Ask the owner before any new staging publish.
- **Pushes.** Committing to `feat/windows-dial` and pushing it are authorized. Never push `feat/windows-desktop` or
  `main`, and never force-push.

## Test machines

**The x64 test PC** is a real Dell Latitude 7440, Windows 11 build 26200, with a dial on COM3 (VID `303A`, PID `1001`,
`MI_00`). E1.3, E5.1 and E5.2 run on it.
- Take its address, account and password from the owner. Never write any of them into the repo, the ledger's
  committed evidence or a commit message.
- It accepts password ssh only, until E1.3 Step 3 sets up a key, which needs the owner's OK.
- Send PowerShell as `-EncodedCommand`: the `&` in `VID_303A&PID_1001` breaks cmd quoting.
- C5.2 has used this PC. It may have the Harness desktop, CLI, PTY hosts and a daemon installed, some running in
  session 0. Before each session:
  - ask the owner whether the PC is free;
  - record what is installed and running;
  - change and remove only what E itself installed;
  - never stop C's daemon or panes;
  - clean up after each run.

**The ARM64 VM** (UTM, Windows 11 ARM64) belongs to C's runs and the owner's checks.
- C5.2 left desktop 1.0.3 installed on it for the owner; leave it installed.
- Never touch `C:\work\e2e`.
- Never change the admin profile's engine settings without a backup and a restore.
- Use the VM only where the plan says, and only when the owner says it is free.

**Never on the developer's Mac:** the real `~/.harness`, the daemon on port 18473, the engine homes, tmux,
`harness service install`, launchd.

## Rules

- The repo is public. Committed evidence carries no full serial numbers, ids, addresses, account names or
  passwords. Shorten serials to `28:84:85:…`.
- There is no production publish in E. Each staging publish needs the owner's OK first.
- Docs, comments and commit messages are in English. Comments say why, naming the measurement or the incident.
- Never bare `git stash`, never `git clean -fdx`.
- Use conventional commits (`feat(windows): …`, `test(windows): …`, `ci(windows): …`), each ending with the
  `Co-Authored-By` line of the engine that wrote it.
- Some steps need a person (marked **Person:** in E5.2, such as the Google sign-in and plugging or unplugging the
  dial). Ask the owner, then wait for the answer.

## Done means

- All of E1.1–E5.3 have a `complete` line in the ledger, and the final whole-branch review has run, with its
  Critical and Important findings fixed.
- `docs/testing/windows-dial-e2e.md` records the eleven scenarios: passed, failed, or not run with the reason.
- The spec's status line and Known limits are updated (E5.3).
- The report to the owner lists:
  - the head SHA and the `windows.yml` run links;
  - what ran where (Mac, CI x64 and arm64, Dell);
  - every `Ruling:` line with its cost if wrong;
  - every deferred minor;
  - what is still open.
- E is not merged into `feat/windows-desktop` until the owner says so.
