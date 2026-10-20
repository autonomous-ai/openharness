# Handoff: Windows shortcuts (Ctrl where the Mac has ⌘)

Date: 2026-10-20. For the agent that implements it. Read this first, then the spec and the plan.

- Spec: `docs/superpowers/specs/2026-10-20-windows-shortcuts-design.md`. It is the binding authority.
- Plan: `docs/superpowers/plans/2026-10-20-windows-shortcuts.md`, with nine tasks, TDD.

Both are uncommitted in this worktree when you start.

## What it is

On the Harness desktop for Windows:
- Ctrl+T, Ctrl+W, Ctrl+N, Ctrl+F and every other Mac ⌘ shortcut work with Ctrl when focus is outside a terminal.
- The current Windows keys (Ctrl+Shift+T, Alt+Shift+T…) keep working everywhere.
- Inside a terminal, plain Ctrl+letter stays the program's, but Ctrl+C copies a selection and Ctrl+V pastes, as in
  Windows Terminal.
- Smaller fixes:
  - the Edit menu gains Cut, Copy, Paste and Select All;
  - tab-number hints appear on Ctrl;
  - the keybindings file moves to `%APPDATA%\harness\`.

It is part of C (the desktop on Windows) and ships in the Windows PR (A+B+C+F). Mac, Linux and web do not change.

## Where things are

| | |
|---|---|
| Worktree | `~/harnesses/worktrees/openharness/amber-heron` |
| Branch | `feat/windows-desktop`, at `87779178e` or later (pull it first: `git pull --ff-only`) |
| Merges into | `main` through the Windows PR, later, by the owner |

Do not touch these other worktrees: `windows-installer` (F), `windows-dial` (E, another agent is active there) and
`windows-pty-rollover` (G, parked).

## First steps

1. `cd ~/harnesses/worktrees/openharness/amber-heron && git pull --ff-only`.
2. `cd desktop && flutter pub get`. Do not symlink another worktree's packages.
3. Commit the spec, the plan and this handoff as the first commit:
   `docs(windows): Windows shortcuts spec, plan and handoff`.
4. Run the plan with superpowers:subagent-driven-development or superpowers:executing-plans. The ledger goes in
   `.superpowers/sdd/2026-10-20-windows-shortcuts/progress.md`.
5. Work through Tasks 1–9 in order. In each task: write the failing test, see it fail, implement, see it pass,
   commit.

## Notes checked on 2026-10-20

- **The key code.**
  - The Windows table and the platform mapping: `desktop/lib/shortcuts/app_shortcuts.dart`
    (`ctrlWorkspacePrefix`, `_windowsShortcuts`, `windowsCommandKeys`, `platformActivator`,
    `platformWorkspaceBinding`).
  - Default bindings: `keymap_commands.dart` (`harnessDefaultBindings`, `HarnessCommand.keys`).
  - Resolution: `keymap.dart` (`ResolvedKeymap`, which lets the terminal context inherit workspace defaults).
  - Dispatch: `keymap_dispatch.dart`, and `keymap_host.dart` (an early key handler that runs before the terminal).
  - The terminal pane: `widgets/terminal_panel.dart` wraps the whole pane, header, terminal and composer, in
    `KeymapRegion(contextKind: KeymapContext.terminal)`. That is why Task 2 tells the terminal view apart from the
    text fields inside the region.
- **Command ids** in the plan's Task 1 test were read from `keymap_commands.dart`. If a diff in the plan no longer
  applies, apply it by its intent and record a `Ruling:` line in the ledger.
- **The baseline.** Desktop's Mac suite has known reds; compare against the plan's base. "Failed to load …
  flutter_tester" under load is not a test failure: rerun that file alone.
- **CI.** `windows-desktop.yml` runs only when started by hand (Task 9 Step 2). Start it once. Never push again just
  to retrigger a red run: read the failure, fix it, push once.

## Pushes, releases and machines

- **Commits** to `feat/windows-desktop` are authorized.
- **Pushes:**
  - Push only at Task 9 Step 2, unless the owner says otherwise.
  - Never force-push.
  - Never push `main`.
- **Releases.** No staging release without the owner's OK first, and no production release.
- **The x64 test PC (Task 9 Step 3).**
  - Take its address and login from the owner, and never write them into the repo.
  - Ask the owner whether it is free.
  - Change and remove only what you installed.
- **The developer's Mac.** Never use its real `~/.harness`, the daemon on port 18473, its engine homes, tmux,
  `harness service install` or launchd.
- **Git.** Never bare `git stash`, never `git clean -fdx`.
- **Writing.**
  - Docs, comments and commit messages are in English. Comments say why.
  - Use conventional commits, each ending with the `Co-Authored-By` line of the engine that wrote it.
  - The repo is public: no addresses, account names, ids or passwords in committed evidence.

## Done means

- Tasks 1–9 each have a `complete` line in the ledger.
- The final whole-branch review has run, and its Critical and Important findings are fixed.
- `docs/testing/windows-desktop-e2e.md` records the live check, item by item.
- The report to the owner lists:
  - the head SHA and the `windows-desktop.yml` run link;
  - what ran where (Mac, CI x64 and arm64, the PC);
  - every `Ruling:` line with what it costs if wrong;
  - every deferred minor;
  - what is still open.
