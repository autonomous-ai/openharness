# Import agent on the person's own computer; machine menu without Team-account options (#4289)

> Written by the Engineer, implemented by the Engineer task by task, test first (project instructions, Roles › Engineer).

**Goal:** Import agent starts the imported agent on the person's own computer, as them, now that Swarm v3 refuses
every start in a Team account (#4120). The machine row's menu no longer offers "Run teammates' work only in the Team
account" / "Let teammates' work run in my account", and rows no longer say "Teammates' agents paused: not set up".

**Architecture:** Desktop's Import agent (`desktop/lib/super_tabs/import_agent.dart`) sends `agent.start` for the
Mac's Team-account entry (`teamPoolOf`), which `admitMachineStart` now refuses with `TEAM_ACCOUNTS_REMOVED`. It sends
it for this computer's own entry instead, in that entry's project folder (`projectFolder` rule). The machine menu's
own-account item reads `ownAccountChoice` from the pool; Desktop drops the item and the backend stops sending the
field. The row line maps `TEAM_ACCOUNT_REQUIRED` to "not set up"; Desktop drops that mapping. The backend's own
`TEAM_ACCOUNT_REQUIRED` for ordinary computers is removed by #3472 (#4218), and Add your computers' "not set up" tag
by #3474 (#4221); this plan does not repeat them.

**Tech Stack:** Flutter (Desktop), TypeScript (backend), vitest, flutter_test.

**Spec:** task #4289 brief.

## Global Constraints

- Team code that still reads existing Team entries stays until the Team daemons are stopped (#4280, #4290): privacy
  readings, Team pools, `teamWorkRefusal`, the `machine.ownAccountWork` command (older Desktops may still send it).
- Backend ships first; Desktop from the last 30 days keeps working: a missing `ownAccountChoice` reads as "off".
- No new UI. Light and dark screenshots of the machine menu.

## Review Focus

- The import start lands on this computer's own entry, never a Team entry, in the right folder.
- Nothing in Desktop still reads `ownAccountChoice` or shows "not set up".

## Task 1: Import agent starts on this computer

**Files:** `desktop/lib/super_tabs/import_agent.dart`, `desktop/lib/super_tabs/import_agent_dialog.dart`,
`desktop/test/super_tab_import_agent_test.dart`.

**Interfaces:** `importUnavailable` needs only this computer in the Swarm; `kImportNeedsTeamAccount` goes.
`importAgent` starts on `mac.machine.machineId` with `cwd` from that pool.

- [ ] Test: the start names this computer (`m`) and its Swarm folder, with a Team entry listed beside it; a computer
      with no Team entry is offered Import; Import from the dialog does not offer "Set up Harness Team". Watch it fail.
- [ ] Code: start on this computer; copy without Team accounts; remove the Set up offer. Watch it pass.

## Task 2: the machine menu and rows drop Team-account options

**Files:** `desktop/lib/super_tabs/machines.dart`, `desktop/test/super_tab_machine_own_account_test.dart` (rewritten
as the v3 menu test), tests that pin "not set up".

- [ ] Test: the owner's menu on their own Mac lists Details and Remove from Swarm only, even with an own-account choice
      stored; a row whose pool reads `TEAM_ACCOUNT_REQUIRED` or carries an own-account note shows no teammates line.
      Light and dark screenshots. Watch it fail.
- [ ] Code: remove `_canChooseOwnAccount`, `_ownAccountOn`, `_setOwnAccount` and its warning, the menu item, the
      own-account row line and the `TEAM_ACCOUNT_REQUIRED` mapping. Watch it pass.

## Task 3: the backend stops sending the menu's field

**Files:** `backend/src/superTabs/model.ts` (`visibleState`), a unit test beside it.

- [ ] Test: a Swarm read of a machine with a stored `ownAccountChoice` carries none. Watch it fail.
- [ ] Code: `visibleState` deletes `ownAccountChoice` from each pool. Watch it pass.
