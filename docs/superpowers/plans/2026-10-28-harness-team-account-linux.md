# Harness Team account on Linux: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Linux computer, `harness team setup` and Desktop's offer make the same Harness Team account a Mac gets:
a separate standard user, `harnessteam`, whose own daemon runs teammates' Swarm agents and cannot read the owner's files.

**Architecture:** The Mac code is the design. Every step of `buildSetupScript` / `buildRemoveScript`
(`cli/src/team/script.ts`) gets a Linux branch built from tools Harness already uses on Linux:
- `useradd` and `setfacl`, as the guest helper does (`cli/assets/guest-helper/guest-helper.sh`).
- `pkexec`, or else `sudo`, for the admin prompt (`lib/guestHelperInstall.ts`).
- systemd, which already supervises the daemon on Linux (`harnessd/platform.ts` `SYSTEMD_UNIT`).

Everything above the script stays shared: the config, the privacy observer, the relay, the engines report, the sign-in
handoff (`team __handoff` / `team __start`), `TeamAutoSetup`, the Desktop dialog and the backend. Platform facts move
into one place, `teamLayout(platform)` in `layout.ts`. Every caller reads paths from it instead of from macOS constants.

**Tech stack:** TypeScript (cli, vitest), POSIX sh, Dart/Flutter (desktop).

**Spec:** `docs/plans/2026-10-24-swarm-team-account.md`, the Mac design this extends. Its line 166 had "team accounts on
Windows and Linux" out of scope. The owner chose (2026-10-28) the same logic on Linux, then Windows. Windows has its own
plan: `docs/superpowers/plans/2026-10-28-harness-team-account-windows.md`.

## Global constraints

- A Mac behaves exactly as today. Every existing `cli/src/team/*.spec.ts` and Desktop team test passes unchanged, with
  macOS values. The Mac constants keep their names as the darwin entries of `teamLayout`.
- Same account: name `harnessteam`, real name `Harness Team`, standard user (never in `sudo`, `wheel` or `admin`),
  listed (UID ≥ 1000, in the login list), password locked (`passwd -l`). On Linux a listed account needs no password,
  so no random password is made.
- Same rules for every script line (`script.ts` header): every value is checked first (`layout.ts` checks) and
  single-quoted. Root never writes inside the team home: the team account copies its own files (`as_team`). Every step
  checks what is there, so a second run repairs a first one.
- Same copy: the dialog keeps the Mac's three paragraphs. Only "macOS" and "osascript" become the Linux words
  (Task 7).
- The team daemon port stays `18493`.
- The owner's daemon never runs the script without a person at the computer (`asker.local`, as today).

## Linux layout (`teamLayout('linux')`)

| What | macOS (today) | Linux |
|---|---|---|
| Team home | `/Users/harnessteam` | `/home/harnessteam` |
| Shared root (root's) | `/Library/Application Support/Harness` | `/etc/harness` |
| Config | `…/team.json` | `/etc/harness/team.json` (root, 0644) |
| Status dir (team account's) | `…/Team` | `/var/lib/harness/team` (`harnessteam`, 0755) |
| Service | LaunchDaemon `ai.autonomous.harness.team`, `/Library/LaunchDaemons/….plist` | systemd system unit `harness-team.service`, `/etc/systemd/system/harness-team.service` |
| Relay folder | `/Users/Shared/.harness-team-relay-<owner>` + `chmod +a` | `/var/lib/harness/team-relay-<owner>` (owner, 0700) + `setfacl -m u:harnessteam:rx` |
| Group of the team user | `staff` (20) | its own group `harnessteam` |
| Admin prompt | `osascript … with administrator privileges`, or `sudo` | `pkexec /bin/sh <script>` with a desktop session, else `sudo` in the terminal |
| tmux | managed tmux (darwin builds only) | the system's `tmux` (`/usr/bin/tmux`, readable by every user). Setup refuses with `NO_TMUX` and names `apt install tmux` / `dnf install tmux` when none runs |
| gh | GitHub's macOS zip, pinned | GitHub's `linux_amd64` / `linux_arm64` tar.gz, pinned the same way |

## Review focus

1. **An owner home that is 755** (Debian and Ubuntu before 21.04 make homes world-readable): setup must make it 0700,
   and the privacy check must fail `home-listing` before that and pass after.
2. **No desktop session** (SSH into a Linux box): `pkexec` is not usable, so the prompt falls back to `sudo` in the
   terminal. In Desktop (no terminal), the answer is `NO_PROMPT` with the command to run, never a hang.
3. **systemd missing or not PID 1** (containers, WSL1): setup refuses with `NO_SYSTEMD` before it creates the user.
   Nothing is left half-made.
4. **An existing `harnessteam` user that setup did not make** (another home): refused with exit 4, as on a Mac.
5. **Removal while teammates' agents run**: `systemctl stop`, then `pkill -u`, then `userdel -r`. A user that
   `userdel` keeps (in use) restarts the service and changes nothing, as `REMOVE_REFUSED` does on a Mac.

---

### Task 1: One layout per platform (`cli/src/team/layout.ts`)

**Files:**
- Modify: `cli/src/team/layout.ts`
- Test: `cli/src/team/layout.spec.ts` (new)

**Interfaces:**
- Produces: `export type TeamPlatform = 'darwin' | 'linux'`
- Produces: `export interface TeamLayout { platform: TeamPlatform; home: string; sharedDir: string; sharedMark: string; configFile: string; statusDir: string; statusFile: string; service: { kind: 'launchd' | 'systemd'; label: string; file: string }; relayDir(owner: string): string; group: string }`
- Produces: `export function teamLayout(platform: NodeJS.Platform): TeamLayout | null` (null for any other platform)
- Keeps: `TEAM_HOME`, `TEAM_PLIST`, `TEAM_SHARED_DIR`, `TEAM_CONFIG_FILE`, `TEAM_STATUS_DIR`, `TEAM_STATUS_FILE`,
  `TEAM_LABEL` and `TEAM_SHARED_MARK` as the darwin values (`teamLayout('darwin')!.…`), so no Mac caller changes.

- [ ] **Step 1: Write the failing tests**
  - `teamLayout('darwin') holds today's macOS values` (each field equals the constant it replaces).
  - `teamLayout('linux') holds the Linux table above` (each field, exact strings).
  - `teamLayout('win32') and teamLayout('freebsd') are null` (Windows has its own plan).
  - `checkPath accepts /home/harnessteam and /etc/harness/team.json` (already true, pinned).
- [ ] **Step 2:** Run `npx vitest run src/team/layout.spec.ts`. Expected: FAIL, `teamLayout` is not exported.
- [ ] **Step 3:** Implement `teamLayout` as a lookup of the two tables. Redefine the constants from the darwin entry.
- [ ] **Step 4:** Run `npx vitest run src/team`. Expected: PASS, every existing team spec unchanged.
- [ ] **Step 5:** Commit `refactor(team): the Harness Team account's paths by platform`.

### Task 2: The Linux setup and remove scripts (`cli/src/team/script.ts`)

**Files:**
- Modify: `cli/src/team/script.ts` (add `buildLinuxSetupScript`, `buildLinuxRemoveScript`, `teamSystemdUnit`; keep the
  macOS builders as they are)
- Test: `cli/src/team/script.spec.ts`

**Interfaces:**
- Consumes: `teamLayout('linux')` (Task 1). `TEAM_COPY`, `TEAM_ENGINES_INSTALL`, `WRITE_PRIVATE`, `WRITE_PUBLIC`,
  `SENTINEL_TEXT` and `TEAM_JOB_WRAPPER` are reused unchanged: they are POSIX and already take their paths as arguments.
- Produces: `buildLinuxSetupScript(input: SetupScriptInput): string`, `buildLinuxRemoveScript(input: RemoveScriptInput): string`,
  `teamSystemdUnit(input: TeamPlistInput): string`. Same input types as the macOS builders.

The Linux setup script's steps, in the macOS script's order:

| Step | Linux |
|---|---|
| Preflight | `[ "$(id -u)" = 0 ]`, `[ "$(uname -s)" = Linux ]`. `[ -d /run/systemd/system ]` else `die … 3` (`NO_SYSTEMD`). `command -v setfacl useradd userdel` else `die … 3`. `tmux -V` runs as `nobody`, else `die "no tmux every account can run: install it (apt install tmux / dnf install tmux)" 3` (`NO_TMUX`). `owned_by_root` for `/ /home /etc /var/lib /etc/systemd/system`, using `stat -c %u` and `stat -c %a` (GNU) in place of `stat -f`. |
| 1. Account | `getent passwd "$TEAM"`. When it exists, its home must be `$TEAM_HOME`, else `die … 4`. When it does not: `groupadd -f harnessteam`, then `useradd -m -d "$TEAM_HOME" -g harnessteam -s /bin/bash -c "$TEAM_NAME" "$TEAM"`. Then `passwd -l "$TEAM"`, and `gpasswd -d "$TEAM" <g>` for each of `sudo wheel admin` it is in. |
| 2. Its home | `chown "$TEAM:harnessteam"`, `chmod 700`, and refuse a link, as on a Mac. |
| 3. Owner's home private | `chmod 700 "$OWNER_HOME"`, and the sentinel written by `as_owner` (`WRITE_PUBLIC`), as on a Mac. |
| 4. Stop | `systemctl stop harness-team.service 2>/dev/null \|\| true`. |
| 5. Runtime | Same staging (`mktemp -d /var/tmp/harness-team.XXXXXX`) and `as_team … TEAM_COPY` with an empty tmux name. |
| 5b. Engines | `as_team … TEAM_ENGINES_INSTALL`, unchanged. |
| 6. Shared files | `/etc/harness` (0755, root's, with the mark when made). `install -o 0 -g 0 -m 0644 team.json`. Status dir `/var/lib/harness/team` (`$TEAM:harnessteam`, 0755). |
| 7. Sign-in | Unchanged: `as_owner … team __handoff`, the shell check of the code, `as_team … WRITE_PRIVATE "$HANDOFF"`. |
| 8. Service | `install -o 0 -g 0 -m 0644 team.service /etc/systemd/system/harness-team.service`, `systemctl daemon-reload`, `systemctl enable --now harness-team.service`. Retry 5 times, as `launchctl bootstrap` is. |

`as_team` / `as_owner` become `runuser -u "$TEAM" -- "$@"` (util-linux, present wherever systemd is), because `sudo -n`
may not be installed.

The unit (`teamSystemdUnit`): `User=harnessteam`, `Group=harnessteam`, `WorkingDirectory=$home`,
`Environment=` for the same variables as the plist (`HOME USER LOGNAME SHELL=/bin/bash LANG PATH ADAPTER_DATA_DIR PORT`
plus the carried backend env), `ExecStart=/bin/sh -c '<TEAM_JOB_WRAPPER>' harness-team <node> <cli> <handoff> <log>`,
`Restart=on-failure` (not after a clean exit, as `SuccessfulExit false`), `RestartSec=10`, `KillMode=process` (agents in
tmux outlive the daemon, as `AbandonProcessGroup`), `TimeoutStopSec=10`, `[Install] WantedBy=multi-user.target`.

The remove script: `systemctl disable --now`, then `pkill -KILL -u`, then `userdel -r "$TEAM"`. When that fails, the
service starts again and the script exits `REMOVE_REFUSED` (9) with the reason. Then it removes the unit, `/etc/harness`
(only when marked and empty), the status dir, the relay folder and the sentinel, and prints `team computer <id>` as the
macOS script does.

- [ ] **Step 1: Write the failing tests** (strings, as the macOS ones are; nothing runs):
  - `the Linux setup script makes a standard listed user and never a sudoer` (contains `useradd -m -d '/home/harnessteam'`,
    `passwd -l`, the `gpasswd -d` loop. Never `usermod -aG sudo`).
  - `it refuses an existing harnessteam with another home, exit 4`.
  - `it makes the owner's home 0700 and writes the sentinel as the owner`.
  - `root never writes in the team home: every write there is as_team` (no `>` or `cp` with a `$TEAM_HOME` target outside `as_team`).
  - `it refuses without systemd (exit 3) before useradd` (the `/run/systemd/system` check comes before `useradd` in the text).
  - `it refuses without a tmux every account can run (exit 3)`.
  - `the unit runs the job wrapper as harnessteam, restarts on failure only, and keeps tmux alive` (`User=harnessteam`,
    `Restart=on-failure`, `KillMode=process`, ExecStart equals the plist's arguments).
  - `the remove script deletes the user after stopping it, and starts it again when userdel keeps it (exit 9)`.
  - `every interpolated value is single-quoted` (the macOS spec's check, run on both Linux scripts).
- [ ] **Step 2:** Run `npx vitest run src/team/script.spec.ts`. Expected: the new tests FAIL, the macOS ones pass.
- [ ] **Step 3:** Implement the three builders from the tables above.
- [ ] **Step 4:** Run the same command, then `sh -n` on each built script (a spec step: `spawnSync('sh', ['-n'], { input })`). Expected: PASS.
- [ ] **Step 5:** Commit `feat(team): the Harness Team account's setup and removal scripts for Linux`.

### Task 3: The admin prompt on Linux (`cli/src/team/admin.ts`)

**Files:** Modify `cli/src/team/admin.ts`. Test `cli/src/team/admin.spec.ts`.

**Interfaces:**
- Produces: `AdminVia = 'prompt' | 'sudo'` unchanged. `adminRunner(deps & { platform?: NodeJS.Platform; graphical?: boolean })`.
  On linux, `'prompt'` runs `pkexec /bin/sh <run.sh>` when `graphical`, else it answers
  `{ ok: false, code: 'FAILED', message: 'No administrator prompt here: run harness team setup in a terminal.' }`.
  `'sudo'` is the existing branch.
- Cancel: `pkexec` exit 126 or 127 → `CANCELLED`, as `guestHelperInstall.ts` reads it.

- [ ] **Step 1: Write the failing tests:** `linux prompt runs pkexec with the staged script`, `pkexec 126 is CANCELLED`,
  `no desktop session answers the terminal sentence and runs nothing`, `darwin is unchanged (osascript)`.
- [ ] **Step 2:** Run `npx vitest run src/team/admin.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `graphical` defaults to `existsSync('/usr/bin/pkexec') && !!(DISPLAY || WAYLAND_DISPLAY)`,
  copied from `guestHelperInstall.ts`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(team): ask for the administrator through pkexec on Linux`.

### Task 4: `harness team setup | status | remove` on Linux (`cli/src/team/command.ts`, `deps.ts`)

**Files:** Modify `cli/src/team/command.ts` (`setup`, `status`, `remove`, `madeLines`, `byHandLines`), `cli/src/team/deps.ts`
(`accountExists` through `getent passwd`, `jobState` through `systemctl show -p ActiveState,MainPID harness-team.service`).
Test `cli/src/team/command.spec.ts`.

**Interfaces:**
- Consumes: `teamLayout` (Task 1), `buildLinuxSetupScript` / `buildLinuxRemoveScript` / `teamSystemdUnit` (Task 2),
  `adminRunner` (Task 3).
- Behaviour: the `platform !== 'darwin'` refusals become `!teamLayout(platform)`. The script and the service file come
  from the platform's builders. `madeLines` / `byHandLines` read the layout (Linux by hand: `sudo systemctl disable --now
  harness-team.service; sudo userdel -r harnessteam; sudo rm /etc/systemd/system/harness-team.service; …`). The
  `TEAM_ACCOUNT` refusal in `teamOn` holds on Linux too (a computer with the account runs team work there).
- New refusal codes passed through as setup failures: `NO_SYSTEMD`, `NO_TMUX` (script exit 3 with that reason),
  `NO_PROMPT` (Task 3's sentence). `MADE_NOTHING` in `autoSetup.ts` gains them.

- [ ] **Step 1: Write the failing tests:** `linux setup runs the Linux script through the admin runner and waits for the
  status file`, `linux status reads systemctl and prints the Linux "what setup made"`, `linux remove runs the Linux remove
  script and signs the team computer out`, `team on refuses on a Linux computer that has the account`,
  `the macOS setup, status and remove specs are unchanged`.
- [ ] **Step 2:** Run `npx vitest run src/team/command.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/team`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(team): harness team setup, status and remove on Linux`.

### Task 5: The team daemon's side on Linux (privacy, relay, engines, gh, tmux)

**Files:** Modify `cli/src/team/privacy.ts` (`privacyProbes(config, platform)`), `cli/src/team/relay.ts` (relay folder
and ACL through `teamLayout().relayDir` and `setfacl`), `cli/src/team/engines.ts:130` (config off darwin),
`cli/src/team/gh.ts` (`GH_BUILDS` keyed `platform-arch`), `cli/src/team/tmux.ts` (Linux answers `present` from the
system tmux, never installs). Tests: the matching `*.spec.ts`.

**Interfaces:**
- `privacyProbes(config, platform)`: on linux, `keychain` → `~/.local/share/keyrings`, `chrome` → `~/.config/google-chrome`,
  `safari` → `firefox` (`~/.mozilla`). `sentinel`, `home-listing`, `gitconfig`, `ssh` and `projects` are unchanged.
  `PrivacyItem` gains `'firefox'`. The `standard-user` check reads the groups `sudo`, `wheel` and `admin` by name
  (`getent group`) in place of macOS's group 80.
- Relay on linux: the folder is `teamLayout('linux').relayDir(owner)`, created by the owner 0700, then
  `setfacl -m u:harnessteam:rx` on it and `u:harnessteam:r` on `relay.json`. The team side keeps its ownership checks
  (the folder and the file belong to the configured owner).
- gh on linux: `gh_<v>_linux_amd64.tar.gz` / `_linux_arm64.tar.gz`. Their sha256 and size are copied from the release's
  `gh_2.103.3_checksums.txt` while implementing. Unpacked with `tar -xzf`.

- [ ] **Step 1: Write the failing tests:** `linux probes name the Linux places` (exact list), `a 755 owner home fails
  home-listing, a 700 one passes` (with fake `list`/`open` throwing EACCES), `linux relay sets the ACL with setfacl for
  harnessteam only`, `the team side refuses a relay folder another user owns on linux`, `linux gh build is the pinned
  tar.gz for x64 and arm64`, `linux tmux is present from /usr/bin/tmux and nothing is downloaded`.
- [ ] **Step 2:** Run `npx vitest run src/team`. Expected: FAIL on the new tests.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(team): the team daemon's privacy check, relay, gh and tmux on Linux`.

### Task 6: Desktop's offer on Linux (`cli/src/team/autoSetup.ts`, `desktop/lib/state/app_state.dart`)

**Files:** Modify `cli/src/team/autoSetup.ts` (`decide`: `teamLayout(platform)` in place of `=== 'darwin'`;
`accountExists` through the platform's check), and `desktop/lib/state/app_state.dart` (`_teamAccountHere`,
`_offerTeamAccountAtStart`: `Platform.isMacOS || Platform.isLinux`; `macOSForTest` renamed `teamAccountHereForTest`).
Tests: `cli/src/team/autoSetup.spec.ts`, the Desktop team offer tests.

- [ ] **Step 1: Write the failing tests:** `linux: a join with no account answers wanted, then started`,
  `linux: an existing account answers exists`, `win32 stays unsupported` (its own plan), Desktop
  `on Linux a join asks this computer's daemon teamSetupCheck`, `the start offer runs on Linux`.
- [ ] **Step 2:** Run `npx vitest run src/team/autoSetup.spec.ts` and `flutter test <the offer tests>`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS, the Mac tests unchanged.
- [ ] **Step 5:** Commit `feat(team): Desktop offers the Harness Team account on Linux as on a Mac`.

### Task 7: The dialog's words on Linux (`desktop/lib/super_tabs/team_account_setup.dart`)

The same three paragraphs and buttons as the Mac dialog. Only these strings change on Linux:
- Title: `Set up Harness Team on this computer`
- Paragraph 1: "this Mac" → "this computer", "a separate macOS account" → "a separate account". The rest is unchanged:
  they cannot read your files or use your GitHub login, and they use this computer's Claude Code and Codex subscriptions.
- Paragraph 2: `Your system asks for your password once.`
- Paragraph 3: unchanged.
- Outcome `started`: `Your system is asking for your password. Setup then takes a minute or two. This computer's row
  updates when it is ready.` `NO_PROMPT`: `Run harness team setup in a terminal on this computer.`

- [ ] **Step 1: Write the failing widget tests:** the Linux title and paragraphs exactly, and the Mac dialog unchanged.
- [ ] **Step 2:** Run `flutter test …team_account_setup_test.dart`. Expected: FAIL.
- [ ] **Step 3:** Implement by platform, with the same widget and keys.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): the Harness Team dialog on Linux`.

### Task 8: Verify on real Linux

**Files:** none (evidence in the PR). Use a Linux VM through the repo's VM rig, or a Linux machine.

- [ ] On Ubuntu 24.04 with a desktop, signed in to Harness: Desktop → join a Swarm. Expected: the dialog with the Linux
  words, then pkexec's password prompt. Then:
  - `harness team status` shows account exists, daemon running (systemd), signed in, privacy Private ✓, home 700 ✓.
  - `/api/machines` has a row `<host> · Team` with `sessionKind: team` and `hostMachineId` set to this computer.
- [ ] As `harnessteam`: `cat ~owner/.harness-team-privacy` and `ls ~owner` are refused (EACCES).
- [ ] A teammate's Lead routes a Builder to this computer. Expected: the agent starts under `harnessteam` and runs a
  Claude Code task through the owner's relay.
- [ ] `harness team remove`: the user, unit, home, `/etc/harness` and sentinel are gone. `/api/machines` no longer
  lists the team row.
- [ ] Over SSH with no desktop: `harness team setup` asks for sudo in the terminal and succeeds. Desktop's offer
  answers `NO_PROMPT`.
- [ ] Debian 12 with a 755 home: the privacy check fails before setup and passes after.
- [ ] Run `npm run test:core` and the full `npx vitest run src/team src/superTabs`. Record the results in the PR.

## Not in this plan

- Windows: `docs/superpowers/plans/2026-10-28-harness-team-account-windows.md`. It starts after the Windows launchers
  are code-signed.
- A Desktop button for `team remove` (a Mac has none either).
- A managed tmux build for Linux (the system's is used).
