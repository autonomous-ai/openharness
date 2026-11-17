# Harness Device: a new user's first run

Status: approved (the orchestrator, 2026-11-17). Branch `fix/new-user-onboarding`, from main at b9a7280863.
Four pull requests (below).

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
- is asked once, after Sign in, to turn on Claude Code (and Codex, when Codex is on this computer);
- with Claude Code on, sees the Claude Code sessions Orca runs under its own accounts on the dial, and their waiting
  prompts;
- has an app log with step lines and results only;
- after removing `~/.harness` and installing again, gets a new machine named as the Mac is in System Settings.

## Decisions (orchestrator, 2026-11-17)

1. The Claude Code and Codex first-run screens come back (1A). This reverses #4389's "no offer screen" for a first run
   only. The menu's Turn on stays as it is.
2. On a Mac without tmux, the managed tmux always: Homebrew is never run (2A). A tmux Homebrew already installed is
   still found and used. Every command the script runs that can read stdin gets `</dev/null`.
3. Orca: the open scan reads Orca's Claude Code and Codex account homes. `harness device claude enable` and `disable`
   turn the plugin on and off in each Orca Claude Code home too. Out of scope, as follow-ups: Harness's session and turn
   hooks in Orca homes (installing them means the core's home adoption, so it is a core change), and the plugin for an
   Orca account added after Turn on (it gets the plugin at the next Turn on).
4. The step line is fixed copy chosen by the app from the script's step lines. A line of the script's output is never
   shown as it is.
5. The app logs step lines (`▸`, `✓`, `✗`) and each run's result. On a failure it also logs the last lines, which are
   the ones the screen shows.
6. Four pull requests, by component and topic. The work is built on this branch. At PR time each component's commits are
   cherry-picked onto `origin/main` in a branch of its own:
   - **A. Installer:** `cli/scripts/install.sh`, its spec, and the desktop app's copy about how tmux is obtained (the
     same cause: the desktop runs this script's `--host`). It carries this spec and the plan.
   - **B. Device app:** `device-app/`: items 1, 3 and 5.
   - **C. Orca homes:** `cli/src/` (devices process and `harness device` command): item 2.
   - **D. Machine name:** `cli/src/lib/computerName.ts` and the four places that send a new machine's label (below).
7. Added 2026-11-17: a new machine is named by macOS's ComputerName when there is one, with the hostname as the
   fallback (PR D). The Desktop's suggestion to move from an offline machine to its replacement is a follow-up.
8. Answers to the plan's questions (2026-11-17): an Orca home is turned off with `claude plugin disable`, and only the
   default home uninstalls; the app's 60 s deadline for Turn on stays; a turn-on failure shows the last non-empty line,
   as `engine::reason` picks it today, cleaned as an install line and cut at 120 characters; a successful Turn on from
   the menu records `askedClaude` / `askedCodex` too; a Codex session in an Orca Codex home gets its last answer from
   the same roots the scan uses; the managed tmux check uses a local `file://` manifest, never the published download.

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

### First run: Claude Code, then Codex

`Screen::Claude` and `Screen::Codex` come back with their offer, working and failed phases, built on what #4389
removed (`git show e1f84bdfde^`), and fitted to today's app:
- **Due:** once the CLI is found and Sign in has been answered (signed in, Later, or the window closed on it), Claude
  Code's screen when `harness device claude status --json` says `supported && !enabled` (`supported` already means a
  Claude Code new enough is on this computer; `installed` there is the plugin's, so a new user has it false) and
  `state.json` has no `askedClaude: true`. Then Codex's screen when `harness device codex status --json` says
  `supported && installed && !enabled` (Codex's `installed` is Codex itself) and there is no `askedCodex: true`.
  Neither shows when its engine is not on this computer, or is on already.
- **Saved:** `askedClaude` and `askedCodex` are `#[serde(default)]` fields of `Saved`, so a 0.1.1 `state.json` (which
  has neither) still reads as itself rather than being reset. A test reads Diego's shape of file (no `askedClaude`).
- **Turn on** runs the same enable effect as the menu's Turn on, with the window on the working phase. Success records
  the answer and moves on to the next screen due, or closes the window. A failure shows its message with **Retry**:
  `Event::ClaudeSet` and `Event::CodexSet` carry `Result<(), String>` again (the last non-empty line, as `engine::reason`
  picks it, cleaned as an install line is and cut at 120 characters), where #4389 made them a bool. The menu's row keeps
  reading as it does now.
- **Not now**, or closing the window on an offer or a failure, records the answer (`askedClaude` / `askedCodex`) and is
  never asked again. The menu's Turn on stays for later, and a successful Turn on from the menu records the answer too.
- Someone who upgrades from 0.1.1 has no `askedClaude`: with Claude Code installed and off, they are asked once. That
  is intended. Someone who turned it on from the menu is not asked.

Copy (the dial approves nothing any more, so the old "asks its approvals" goes):

| Screen | Heading | Body | Buttons |
|---|---|---|---|
| Claude offer | Claude Code | The dial shows when Claude Code needs you, and takes a prompt you say. | Not now · **Turn on** |
| Claude working | Claude Code | spinner | none |
| Claude failed | Claude Code | the error line | **Retry** |
| Codex offer | Codex | Codex can ring the dial when it needs you. | Not now · **Turn on** |
| Codex working / failed | Codex | spinner / the error line | none / **Retry** |

The webview's action names grow from four to six again (`turn_on`, `not_now`). `device-app/AGENTS.md` says so. Each
is fixed in Rust, as today.

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
order across stdout and stderr), `app.rs` (the screens due, each answer recorded, closing as Not now, Turn on's
effect, a failure's Retry, the step shown), `ui/src/screens.test.ts` (each new face, the step under the spinner), the
gallery with every new state in both themes.

### Docs

`docs/plans/2026-11-13-device-menubar-design.md` (the screens and the first run) and the "no offer" lines of
`docs/plans/2026-11-16-dial-skill-every-home-design.md`, each with a line naming this decision. `device-app/AGENTS.md`.

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

The dial skill writer's `adopted()` returns the adopted homes plus the Orca homes from the last read (synchronous: it
reads the cached list). The service awaits the first Orca read (at most its 5 s deadline) before the writer's start
pass, and runs the start pass again when a later read changes the list. So Orca's Codex homes get the dial skill while
Codex is On, and Claude Code's homes do too where `skills/` is not already linked (a linked one is one folder, written
once, as today).

### The plugin

`ClaudeRun` becomes `(args, timeoutMs, env?)`, where `env` is added to the child's environment alone.
`harness device claude enable` turns the plugin on in the default home first, as today. Then, for each Orca Claude Code
home, it runs the same `claudeEnable` steps with `{ CLAUDE_CONFIG_DIR: <home> }`. The marketplace and the plugin's
files are in `plugins/`, which Orca links to `~/.claude/plugins`, so after the first home each one is mostly a settings
write. A home that fails prints one line, `Could not turn on Claude Code in one Orca account.`, and the command still
exits 0 when the default home succeeded.

`disable` runs `claude plugin disable` in each Orca home first, then uninstalls in the default home as today. Since
`plugins/` is shared, an uninstall in one home removes the files every home names, and the other homes' own uninstall
would then find nothing and leave their entry on. Disabled first, each Orca home's entry reads off. A home that fails
prints `Could not turn off Claude Code in one Orca account.`, and the command exits 1, so the menu says "Could not turn
off" and offers it again. `status` is unchanged (the default home's).

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
places: today's providers), `dialSkillWriter.spec.ts` (an
Orca Codex home gets the skill), `deviceClaude/command.spec.ts` (enable runs the plugin steps once per Orca home with
`CLAUDE_CONFIG_DIR` set on that child alone, a failed home's line, disable in each home). Every test uses throwaway
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
- The plugin for an Orca account added after Turn on.
- **The Desktop: move from an offline machine to its replacement.** When a machine's tab is offline and the same
  account has a newer online machine with the same name, the Desktop could suggest moving to it. Matching by the same
  hardware needs a hardware id the backend does not keep (a backend change). Matching by the same name works without
  one once D lands. Open product question: what Switch does with the old machine's tabs, whose agents are gone with
  `~/.harness`. It could move them to the new machine and start new agents there, open the new machine's own tabs and
  offer to remove the old machine, or something else.

## Design (docs/feature-design-rules.md)

Reviewed revision: this draft. Reviewer: the orchestrator.

1. Growth: two new state fields, `askedClaude` and `askedCodex` in `state.json` (one boolean each, set once, never
   deleted, as `askedSignIn`). Orca homes are in memory only. The dial skill's homes list keeps its bound (`MAX_HOMES`).
2. Concurrency: the step is written only by the install's runner thread through the app's event queue. The Orca homes
   cache is one value replaced whole. The `claude plugin` runs are one at a time.
3. Read cost: one `orca account list` (about 5 KB for 5 accounts) at start and at most every 5 min. The scan reads one
   more `sessions/` folder per Orca home (a few small JSON files each).
4. Scale: at 10x accounts (50), still one call and 50 small folders per scan. `MAX_HOMES` (64) bounds it.
5. Compatibility: `state.json` stays version 1, and an older app ignores the new fields. A CLI without this change
   still works with the new app. A new app's install log no longer has the full output.
6. Migration and rollback: none. Rolling back the app keeps the answers it does not read. Rolling back the CLI drops
   the Orca homes.
7. Audience: local only. The Orca answer carries emails: only `home` is kept, and nothing of it is logged.
8. Identity: every command runs as the person, in their own session. `CLAUDE_CONFIG_DIR` is set on our own child only.
9. Failure: an install failure shows its last lines with Retry, as today. An Orca failure logs one line and lists the
   default home's sessions as today. A failed plugin home prints one line.
10. Platforms: macOS for everything. Linux gets the apt `</dev/null` and the scan (Orca on Linux lists accounts the same
    way). Windows: no change (the app installs nothing there, and the scan has no records folder change).

## Measures

- `[observed] orca homes · <n> claude · <n> codex` once per read, counts only.
- The install's step lines already name each step, and the result line its exit code and time.

## Verification

- A: the installer spec (Linux CI and a Mac), and on this Mac `install.sh --host` in a throwaway HOME with a PATH that
  has no tmux and a recording `brew`: the managed tmux lands in that HOME and `brew` is never called.
- B: `cargo test --lib`, `npm test`, `npm run typecheck`, the gallery. Then a debug build on this Mac with
  `HARNESS_DEVICE_CLI` pointing at a fake CLI (a throwaway data dir): first run shows the step lines, then Sign in,
  Claude Code and Codex. Checked by a person for the look.
- C: the unit tests, plus an end-to-end run of the devices service with a throwaway HOME, a fake `orca` naming a
  throwaway home and a fake Claude Code record in it. The scan finds it.
- C, before the disable task: a real `claude` in two throwaway homes sharing one `plugins/` folder (Orca's layout),
  pointed at a local copy of the marketplace. Turn on, then Turn off: every home's entry reads off.
- D: the unit tests. On this Mac, `computerName()` gives the Mac's ComputerName (read, never changed).
- Checked by the person (it needs real Orca): with this branch's CLI, Orca's Claude Code sessions show on the dial
  after Turn on.
- Not checked here: whether `orca account list` launches Orca when it is not running. This Mac's Orca is running and
  is where this work runs. The call's 5 s deadline bounds it either way.
