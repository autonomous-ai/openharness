# Harness Device: a new user's first run

Status: approved (the orchestrator, 2026-11-17). Branch `fix/new-user-onboarding`, from main at b9a7280863, rebased
onto main after #4399. Four pull requests (below).

Revised 2026-11-17 after #4399 ("Claude Code and Codex reach the dial with no setting", merged 06:32 UTC): the devices
process now sets up Claude Code's plugin and Codex's skill by itself once a dial has attached, and the menu has no agent
rows. Item 1's first-run screens are dropped (decision 1), and the plugin in Orca homes joins #4399's automatic setup
(decision 9).

## What and why

On 2026-11-17 Diego installed Harness Device 0.1.1, which installed CLI 0.6.58, as a brand-new user on his Mac. Read
from the app's log (`~/Library/Logs/ai.autonomous.harness.device/app-20261117.log`) and the daemon's
(`~/.harness/cli/data/harness.log`):

1. **No Claude Code step.** After sign-in the menu stayed `Claude Code: Off | Turn on`, and `state.json` had no
   `askedClaude`. #4389 (2026-11-16) removed the first-run offer screens on purpose ("Turn on is the consent"). A new
   user never finds the row, so the harness-device plugin never gets installed and no hook reaches the dial. Once Diego
   pressed Turn on, the Claude app's sessions showed on the dial with their names and states. So this is the main cause.
2. **Orca's agents never appear.** Orca runs Claude Code under its own managed accounts, each a config dir of its own
   (`CLAUDE_CONFIG_DIR` = `~/Library/Application Support/orca/claude-profiles/<id>/home`). The open scan reads process
   records only in `~/.claude/sessions` (`[observed] scan · 6 found · 4 app known · 0 named`), and
   `harness device claude enable` turns the plugin on only in `~/.claude`. Checked on this Mac: each profile home has
   its own `sessions/` and `settings.json`, and links `projects/`, `plugins/` and `skills/` to `~/.claude`'s.
3. **The "Setting up Harness" screen is only a spinner** for 1-2 minutes while the install script runs.
4. **`brew install tmux` changed the person's Homebrew.** It auto-updated Homebrew, ran `brew cleanup` (it deleted
   unrelated caches, a 1.4 GB kicad dmg among them), and pulled openssl@4, which unlinked openssl@3. The log also
   shows the root cause of a worse bug: under `curl … | /bin/sh -s`, the script is sh's stdin, and `brew` read from that
   stdin. It swallowed part of the script (the log has the script's own comments as "output"). Here the lost part
   came after `--host` had already exited. A step that lost a line it needed would have done half an install.
5. **The app's log holds the install's whole output:** the script source that brew swallowed and echoed, and brew's
   hundreds of lines.

Done when, on a Mac with a dial, a brand-new user who installs Harness Device:
- sees a step line on Setting up Harness ("Installing tmux…", then "Downloading Harness…") instead of a spinner alone;
- gets tmux without Homebrew running (no update, no cleanup, no formula installed) when the Mac has no tmux;
- with a dial attached once, sees the Claude Code sessions Orca runs under its own accounts on the dial, and their waiting
  prompts;
- has an app log with step lines and results only;
- after removing `~/.harness` and installing again, gets a new machine named as the Mac is in System Settings.

## Decisions (orchestrator, 2026-11-17)

1. ~~The Claude Code and Codex first-run screens come back (1A).~~ Dropped after #4399, which sets both agents up with no
   click once a dial attaches. Item 1 is fixed there.
2. On a Mac without tmux, the managed tmux always: Homebrew is never run (2A). A tmux Homebrew already installed is
   still found and used. Every command the script runs that can read stdin gets `</dev/null`.
3. Orca: the open scan reads Orca's Claude Code and Codex account homes. The plugin reaches each Orca Claude Code home
   (decision 9). Out of scope, as a follow-up: Harness's session and turn hooks in Orca homes (installing them means the
   core's home adoption, so it is a core change).
4. The step line is fixed copy chosen by the app from the script's step lines. A line of the script's output is never
   shown as it is.
5. The app logs step lines (`▸`, `✓`, `✗`) and each run's result. On a failure it also logs the last lines, which are
   the ones the screen shows.
6. Four pull requests, by component and topic. The work is built on this branch. At PR time each component's commits are
   cherry-picked onto `origin/main` in a branch of its own:
   - **A. Installer:** `cli/scripts/install.sh`, its spec, and the desktop app's copy about how tmux is obtained (the
     same cause: the desktop runs this script's `--host`). It carries this spec and the plan.
   - **B. Device app:** `device-app/`: items 3 and 5.
   - **C. Orca homes:** `cli/src/` (devices process and `harness device` command): item 2.
   - **D. Machine name:** `cli/src/lib/computerName.ts` and the four places that send a new machine's label (below).
7. Added 2026-11-17: a new machine is named by macOS's ComputerName when there is one, with the hostname as the
   fallback (PR D). The Desktop's suggestion to move from an offline machine to its replacement is a follow-up.
8. Answers to the plan's questions (2026-11-17): an Orca home is turned off with `claude plugin disable`, and only the
   default home uninstalls; a Codex session in an Orca Codex home gets its last answer from the same roots the scan
   uses; the managed tmux check uses a local `file://` manifest, never the published download. (The answers about the
   first-run screens went with decision 1.)
9. After #4399 (orchestrator, 2026-11-17): Orca Claude Code homes join #4399's automatic setup, each with its own
   record; a home where the person turned the plugin off stays off; `harness device claude enable` and `disable` cover
   the Orca homes; an Orca home needs only `claude plugin enable`, since `plugins/` is shared with `~/.claude`.
10. Answers to the plan's questions after #4399 (orchestrator, 2026-11-17): `harness device claude enable` records the
   Orca homes it turned on in its own file, `dial-skill.json` (`pluginHomes`), and the devices process in
   `dial-setup.json`: each file has one writer, and a home in either list counts as recorded. Orca homes are turned on
   only while the default home's plugin reads on: a person who turned it off or removed it there said no, and a removal
   takes the shared `plugins/` files every home names.

## Goals, non-goals, anti-goals

- Goal: each of the five items above, on macOS, tested red then green.
- Non-goal: Windows (the app installs nothing there yet) and Linux behaviour beyond `</dev/null` on apt.
- Non-goal: Harness's session and turn hooks in Orca homes (decision 3).
- Anti-goal: reading another process's environment to find a home. Homes come from Orca's own CLI only.
- Anti-goal: any new field read from a session record. The scan reads the same fields it reads in `~/.claude/sessions`.
- Anti-goal: an Orca account's email, id or path in a log line, an error or a measure. Counts only.

## A. Installer (`cli/scripts/install.sh`)

**tmux on a Mac.** The app's `/bin/sh` has the bare PATH of a Finder launch, so today the `brew shellenv` eval is what
finds a Homebrew tmux that is already there. The new ladder:
1. `tmux_runs` on PATH: done.
2. Else, for each prefix in `${HARNESS_HOMEBREW_PREFIXES:-/opt/homebrew /usr/local}` whose `bin/tmux` is executable:
   that `bin` goes on PATH (no `brew` is run, not even `shellenv`), and `tmux_runs` is asked again. Found: done. So a
   Homebrew tmux is used, never hidden by a managed link.
3. Else `install_managed_tmux`.

`brew install --force-bottle tmux`, the `command -v brew` lookup, the `brew shellenv` eval and the "Installing tmux via
Homebrew" line go. The header comment says the new ladder.

**No child reads the script.** Each call of a program that is not one of the POSIX tools the script uses to download
and unpack gets `</dev/null`: `apt-get` in `apt_as_root` (both arms), the Node runtime's `-e` calls, `dsh builtins`,
`"$LAUNCHER" version`, `"$TUI_BIN" --version`, grid's `--version`, and the managed tmux's `-V`. The plan checks that
list against the script line by line. `sudo` asks for a password on the tty, not stdin, so it still works.

**Desktop copy.** `desktop/lib/bootstrap/environment_provisioner.dart` says tmux comes "with Homebrew" when Homebrew is
there (`tmuxViaHomebrew`, `homebrewInstallsTmux`, `_hasHomebrew`, "Installing tmux via Homebrew…", "tmux will be
installed with Homebrew."). Once the script never runs Homebrew, those sentences are wrong. They go, together with the
probe that only chose them, so the plan always says the managed download. The PATH the desktop's shell gets with the
Homebrew prefixes (`environment_provisioner.dart:1856`) stays: it finds a tmux that is already there. Its Flutter tests
change with it, and the plan checks `desktop/design/desktop-design-system.md` and its gallery for the old copy.

Tests (red first), in `cli/src/scripts/install.spec.ts`:
- A Mac with no tmux and a `brew` on PATH and in a fake prefix (a fake that records any call): the managed tmux is
  installed from a fake manifest, and `brew` is never called.
- A Mac whose only tmux is in a fake Homebrew prefix's `bin` (not on PATH): that tmux is used, nothing is downloaded,
  no `~/.local/bin/tmux` link is made, and `brew` is never called.
- The tests that assumed `brew install` change with it: "asks about Homebrew only without tmux…" (`:378`), "installs
  tmux with an existing Homebrew…" (`:423`), "finds Homebrew tmux and creates the first pane…" (`:460`, which keeps its
  point with a tmux in the prefix), "falls back to the managed build when Homebrew cannot install tmux" (`:621`, goes).
- The script piped into `/bin/sh -s -- --host` (and `--desktop` where the call is in that mode) with a fake that drains
  stdin (`cat >/dev/null`) in place of each program given `</dev/null`: the script still prints its last step. Red
  today for each such call, green with it.

## B. Device app (`device-app/`)

### First run

No change. #4399 removed the agent rows and sets Claude Code and Codex up from the devices process, so the first-run
screens this spec first brought back (decision 1) are not built.

### Setting up Harness shows its step

The install runs as today: the two fixed lines, each within `INSTALL_DEADLINE`, in their own process group. What
changes is that its output is read as it arrives rather than whole at the end. `Shell::run` takes a line sink. The
system shell reads stdout and stderr on one thread each, and each splits on `\n` and hands each line to one channel.
Lines are handled in the order the channel receives them, which keeps each stream's order and interleaves the two
about as a terminal would. The fixed lines stay word for word (no `2>&1` is added). `Output` still holds both streams
for the failure's last lines.
- Each clean line (the same `clean_lines` rules: last `\r` frame, no control character, trimmed) is matched against a
  fixed table in Rust. A match moves the Install screen's step to that entry's copy:

  | Script step line starts with (after `▸`) | Step shown |
  |---|---|
  | `Installing the managed tmux`, `downloading tmux` | Installing tmux… |
  | `Installing the Harness Node runtime`, `downloading Node`, `Installing harness` | Downloading Harness… |

  A line the table does not know changes nothing, so a new script line shows the step before it. Before the first
  match the screen shows "Getting ready…".
- The view carries the step as `lines[0]` of `install.working`, which draws the spinner and the step under it, muted.
  The step is the table's fixed copy, never the script's text.
- A failure is as today: the last `LAST_LINES` lines, cut to `LINE_CHARS`, and Retry.

### The log

Each run logs only:
- its step lines (a clean line that starts with `▸`, `✓` or `✗`), as they come;
- its result (`install: --host exit 0`, timed out, killed, could not start);
- on a failure (an exit other than 0, a timeout, a kill, or no CLI found after both runs), the lines the screen shows.

Every line still passes `log::redact`. brew's output, a script's source text, and the rest of what a run prints are
never logged.

Tests (red first): `install.rs` (the steps a streamed run yields, the log of a long run, the failure's lines, arrival
order across stdout and stderr), `app.rs` (the step shown, kept across a retry), `ui/src/screens.test.ts` (the step
under the spinner), the gallery with the step in both themes.

### Docs

`docs/plans/2026-11-13-device-menubar-design.md` (the install's step and its log), `device-app/AGENTS.md` (the log
holds step lines and results only), and the design doc's Harness Device section with its gallery.

## C. Orca homes (`cli/src/`)

### Where the homes come from

Orca's own CLI: `orca account list --json` (checked on Orca 1.4.256: `{"ok":true,"result":{"claude":{"accounts":
[{"id","email","home",…}],…},"codex":{…},…}}`). The command lists the managed accounts on this computer. A new module
`src/devices/orcaHomes.ts` runs it with a 5 s deadline, output bounded to 256 KB, and reads
`result.claude.accounts[].home` and `result.codex.accounts[].home`. Only `home` is kept. A home counts when it is an
absolute path to a directory the person owns. At most `MAX_HOMES` per engine are kept. No Orca, an Orca too old to
have `account list`, a failed run or an unreadable answer gives no homes, with one log line naming the failure kind
only (no output, no path). The binary lookup (`orcaBinary`, `cable/hosts/orca.ts:112`: `orca` on PATH, else the app
bundle's) moves into this module, and `orca.ts` imports it from there, so both use one lookup.

### The open scan (devices process)

`externalProviders(paths, places?)` gains an optional second argument, `{ claude?: AdoptionPlaces; codex?:
AdoptionPlaces }`, which replaces that engine's places. With none, as the search service calls it, nothing changes. In
`services/devices.ts` `observedSource`, the devices pass their own:
- Claude Code `roots()`: today's `claudeProjectsRoots(...)`, plus each Orca home's `projects` whose real path is not
  already a root's, so a linked `projects/` (Orca links it to `~/.claude/projects`) is read once.
- Claude Code `records()`: `sessions` beside each of today's roots (today's records), plus `<home>/sessions` for each
  Orca Claude Code home.
- Codex `roots()`: today's `codexHomeRoots(...)` plus each Orca Codex home.
- `readLastAnswer` gets the same Claude Code roots (it compares real paths, so the linked folder needs nothing more),
  and for Codex the same homes as Codex `roots()`.
- `readRecordName` today accepts only `<root>/../sessions/<pid>.json`. It takes the records folders instead (the same
  list as `records()`), and accepts a record only directly inside one of them.
- The homes are read at the devices service's start, then again at a scan once the last read is 5 minutes old (no new
  timer). Each read replaces the whole list.
- The session record reader is unchanged: the same fields, from more folders.

### The dial skill

#4399's `cable/dialHomeSetup.ts` writes the skill in each home it knows once a dial has attached, records each folder it
wrote in `dial-setup.json`, and leaves a recorded folder the person emptied alone. Its `adopted()` returns the adopted
homes plus the Orca homes from the last read (synchronous: it reads the cached list). The service awaits the first Orca
read (at most its 5 s deadline) before the setup's start pass; a later read that changes the list is used at the next
scan. So each Orca Codex home gets the skill once, as any adopted Codex home does, and an Orca Claude Code home's
`skills/`, linked to `~/.claude/skills`, is the same folder, written once.

### The plugin

**Automatic (devices process).** #4399's `cable/dialPluginSetup.ts` installs and turns on the plugin in the default home
once, records the CLI version that did, and brings it current once per CLI update. Orca homes join it:
- Once the default home's plugin is recorded as set up and its settings read it on, each Orca Claude Code home not yet
  in either record gets
  `claude plugin enable harness-device@openharness --scope user`, run with `CLAUDE_CONFIG_DIR=<home>` on that child
  alone. The files are already there: `plugins/` is linked to `~/.claude/plugins` (check 8). Success records the home
  (its real path) in `dial-setup.json`. While the default home's plugin reads off or absent, no Orca home is touched.
- A recorded home is never enabled again: one where the person turned the plugin off through `/plugin` stays off, and a
  home Orca no longer lists is dropped from the record at the next read.
- An Orca account added later is set up at the next scan once the Orca read names it.
- The default home's update (shared `plugins/`) brings every home's files current: no per-home update.
- A home that fails is counted (`failed`, a fixed step word) and tried again no sooner than an hour, as #4399's
  default home is. Counts only, never a path.
- When `disable` has removed Claude Code (the record says not wanted), the pass runs nothing in Orca homes: the command
  did it.

**The commands.** `harness device claude enable` sets up the default home as today, then runs `claude plugin enable` in
each Orca home and records it in `dial-skill.json`'s `pluginHomes`. A home that fails prints `Could not turn on Claude Code in one Orca account.`, and the
command still exits 0 when the default home succeeded. `disable` runs `claude plugin disable` in each Orca home first,
then removes the default home's plugin as today and records the removal. Since `plugins/` is shared, an uninstall in one
home removes the files every home names, and the other homes' own uninstall would then find nothing and leave their
entry on; disabled first, each Orca home's entry reads off (check 8). A home that fails prints `Could not turn off
Claude Code in one Orca account.`, and the command exits 1. `status` is unchanged (the default home's).

The hook (`asked`) and the mod's `link` already check the plugin in the settings of their own `CLAUDE_CONFIG_DIR`, so
an Orca session's hook reaches the dial with no change.

### What Orca's sessions do not get (follow-up)

Harness's session and turn hooks (SessionStart, Stop, …) are installed by the core into `~/.claude` and the homes the
core adopted. Orca homes are not adopted, so a session there is found by the scan and followed through its record
(idle or busy), and its waiting prompts reach the dial through the plugin, but its hook events do not. Adopting Orca's
homes is a core change: a follow-up proposal, not this branch.

Tests (red first): `orcaHomes.spec.ts` (a fake `orca` printing a fixed answer: homes kept, emails and ids dropped, a
relative or missing home refused, the bound, a failed run, a timeout), `observed`/devices tests with a temporary HOME
holding an Orca-like home whose `sessions/` has a record (the scan finds it, `1 found`), `recordName.spec.ts` (a record
in an Orca home's `sessions/` is named; one outside every records folder is refused), `externals/index.spec.ts` (no
places: today's providers), `dialHomeSetup.spec.ts` (an Orca Codex home gets the skill once), `dialPluginSetup.spec.ts`
(each Orca home enabled once with `CLAUDE_CONFIG_DIR` on that child alone and recorded; a recorded home turned off is
left off; a new Orca home at the next scan; a failure waits an hour; nothing while removed), `deviceClaude/command.spec.ts`
(enable and disable in each Orca home, a failed home's line). Every test uses throwaway
homes and a fake `orca` and `claude`: never Diego's real `~/.claude` or Orca profiles.

## D. Machine name (`cli/src/`)

After Diego removed `~/.harness` and installed again, the CLI registered a new machine named `MacBook-Pro.local` (the
hostname), where his first one had been "Diego's Mac". The Desktop kept its tab on the old machine and said only
"Harness is offline". A new machine is made because the computer id is a random file in `~/.harness`
(`lib/computerIdentity.ts`), which went with the folder. That stays as designed.

The backend uses a machine's `label` only when it creates the machine (`MachineService.resolveOrCreateForComputer`,
from `/api/machines/resolve-computer` and the adapter-ws upgrade). An existing machine keeps its name, so the change
reaches new machines only, and the backend does not change.

A new module `cli/src/lib/computerName.ts` exports `computerName()`. On macOS it runs `scutil --get ComputerName` once
per process (a 2 s deadline, trimmed, cut to 80 characters, with no control characters), and caches the answer. Empty,
failed, or another platform: `os.hostname()`. The four places that send a new machine's label use it:
- `cli.ts` `resolveComputerMachine` (`label` of `resolve-computer`);
- `cli.ts` `qrSignInCommand` (`label`);
- `lib/authRefresh.ts` `harnessSessionRequest` (`label`);
- `gateway/upstream.ts`, the adapter-ws `?label=`.

None of these files is in the core's process (`src/architecture.coreFiles.txt`). The core's own uses of `hostname()`
(`thisDeviceLabel`, the terminal hint's fallback) are display only, and they stay. `computerName.ts` must not be
imported by any core-loaded file. `architecture.spec.ts` keeps the list as it is, and a test says so.

Tests (red first): `computerName.spec.ts` (an answer is used and cached: a fake runner is called once for two calls; an
empty answer, a failure, a timeout and a non-macOS platform give the hostname; control characters are stripped and
the cut is at 80), and one test per caller that its label is `computerName()`'s (a fake), never `hostname()` when they
differ.

## Follow-ups (not this branch)

- Harness's session and turn hooks in Orca homes (a core change: home adoption).
- **The Desktop: move from an offline machine to its replacement.** When a machine's tab is offline and the same
  account has a newer online machine with the same name, the Desktop could suggest moving to it. Matching by the same
  hardware needs a hardware id the backend does not keep (a backend change). Matching by the same name works without
  one once D lands. Open product question: what Switch does with the old machine's tabs, whose agents are gone with
  `~/.harness`. It could move them to the new machine and start new agents there, open the new machine's own tabs and
  offer to remove the old machine, or something else.

## Design (docs/feature-design-rules.md)

Reviewed revision: this draft. Reviewer: the orchestrator.

1. Growth: `dial-setup.json` (the devices) and `dial-skill.json` (the command) each gain `pluginHomes`, the Orca Claude
   Code homes the plugin was turned on in (real paths, at most `MAX_HOMES`, a home Orca no longer lists dropped). The Orca homes list itself is in memory only. The dial skill's homes
   list keeps its bound (`MAX_HOMES`).
2. Concurrency: the step is written only by the install's runner thread through the app's event queue. The Orca homes
   cache is one value replaced whole. The `claude plugin` runs are one at a time.
3. Read cost: one `orca account list` (about 5 KB for 5 accounts) at start and at most every 5 min. The scan reads one
   more `sessions/` folder per Orca home (a few small JSON files each).
4. Scale: at 10x accounts (50), still one call and 50 small folders per scan. `MAX_HOMES` (64) bounds it.
5. Compatibility: `dial-setup.json` from #4399 (no Orca field) reads as no Orca home set up, so each is enabled once. An
   older CLI ignores the field. A new app's install log no longer has the full output.
6. Migration and rollback: none. Rolling back the CLI drops the Orca homes; their plugin entries stay as they were.
7. Audience: local only. The Orca answer carries emails: only `home` is kept, and nothing of it is logged.
8. Identity: every command runs as the person, in their own session. `CLAUDE_CONFIG_DIR` is set on our own child only.
9. Failure: an install failure shows its last lines with Retry, as today. An Orca failure logs one line and lists the
   default home's sessions as today. A failed plugin home is counted and retried after an hour; from the command, it
   prints one line.
10. Platforms: macOS for everything. Linux gets the apt `</dev/null` and the scan (Orca on Linux lists accounts the same
    way). Windows: no change (the app installs nothing there, and the scan has no records folder change).

## Measures

- `[observed] orca homes · <n> claude · <n> codex` once per read, counts only.
- The install's step lines already name each step, and the result line its exit code and time.

## Verification

- A: the installer spec (Linux CI and a Mac), and on this Mac `install.sh --host` in a throwaway HOME with a PATH that
  has no tmux and a recording `brew`: the managed tmux lands in that HOME and `brew` is never called.
- B: `cargo test --lib`, `npm test`, `npm run typecheck`, the gallery. Then a debug build on this Mac with
  `HARNESS_DEVICE_CLI` pointing at a fake CLI (a throwaway data dir): first run shows the step lines, then Sign in.
  Checked by a person for the look.
- C: the unit tests, plus an end-to-end run of the devices service with a throwaway HOME, a fake `orca` naming a
  throwaway home and a fake Claude Code record in it. The scan finds it.
- C, before the disable task: a real `claude` in two throwaway homes sharing one `plugins/` folder (Orca's layout),
  pointed at a local copy of the marketplace. Turn on, then Turn off: every home's entry reads off.
- D: the unit tests. On this Mac, `computerName()` gives the Mac's ComputerName (read, never changed).
- Checked by the person (it needs real Orca): with this branch's CLI and a dial attached, Orca's Claude Code sessions
  show on the dial with nothing pressed.
- Not checked here: whether `orca account list` launches Orca when it is not running. This Mac's Orca is running and
  is where this work runs. The call's 5 s deadline bounds it either way.
