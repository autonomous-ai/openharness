# Harness Device: the dial skill in every agent home

Status: approved (Ken and the orchestrator, 2026-11-16). Branch `feat/dial-skill-every-home`, from main at 266e814cde
(after #4379). Replaces the second pull request of the Release order in
`docs/plans/2026-11-16-dial-agent-notify-design.md` (a skill inside the Claude Code plugin, #4386, closed).

## What and why

#4379 gave agents `harness device notify` and a `dial` skill that says when to use it, written into Codex's home by
`harness device codex enable`. Claude Code was to get the same skill through the `harness-device` plugin. Tried on
2026-11-16, that path falls short:

- A plugin skill does not reach a Claude Code session that is already running, and the `openharness` marketplace is a
  third-party one, so Claude Code does not update it on its own. People who already have the plugin would not get the
  skill until they run `claude plugin update`.
- An Orca profile is a Claude Code config dir of its own (`CLAUDE_CONFIG_DIR`) with its own `settings.json`, so a
  plugin turned on in `~/.claude` is not on there. Orca links the profile's `skills/` (and `projects/`, `plugins/`) to
  `~/.claude`'s (checked on this Mac: every profile under `orca/claude-profiles/*/home`), so a skill in
  `~/.claude/skills` is there.
- A skill file in a home's `skills/` folder reaches a running session at once: Claude Code 2.1.325 reloads `skills/`
  in a running session, and a running Codex 0.167.1 listed a new skill at once (`$dial-probe`).

So Harness writes `skills/dial/SKILL.md` itself into every Claude Code and Codex home the person's agents use, while
that engine is On in the Harness Device menu, and removes it from all of them when it is turned off. The plugin keeps
its hook and gets no skill.

The menu-bar app's first-run offer windows for Claude Code and Codex go: **Turn on** in the menu turns the engine on
directly.

Done when, on a Mac with a dial and the Harness Device menu-bar app:
1. Claude Code: Off · **Turn on** in the menu installs the plugin as today and writes the dial skill into `~/.claude`,
   with no window. A Claude Code session already running in Orca (its own profile) or in a terminal lists the
   `dial` skill without a restart. The same for Codex and `~/.codex`, and for a running Codex in another `CODEX_HOME`
   once the devices service's scan has seen it (Where it is written).
2. **Turn off** removes every skill file Harness wrote, in every home, and nothing else.
3. A person's own `skills/dial/SKILL.md` is never changed or removed.
4. The Claude Code row shows when Claude Code is on this computer, also before the plugin is installed.

## Goals, non-goals, anti-goals

- Goal: the skill reaches every Claude Code and Codex home in use, including running sessions and Orca profiles,
  with no restart and no plugin update.
- Goal: one source for the skill text (`DIAL_SKILL`) for both engines.
- Non-goal: the core changes nothing. The devices service (its own process) does the daemon-side writing.
- Non-goal: the plugin's hook, mod and README do not change. Desktop, mobile, the website, the Orca plugin and the
  firmware do not change.
- Non-goal: no new poll. The writes ride on moments that already happen (Turn on, the devices service's start, its
  open scan while a dial is attached).
- Anti-goal: reading another process's environment. The hard rule in
  `docs/specs/2026-11-14-dial-app-filter.md` (Never read another process's environment) stands. A home is found from a
  file path the scan or a hook already has, never from `ps -E`, `/proc/<pid>/environ` or the like.
- Anti-goal: touching a skill the person wrote, or anything else in their home.
- Anti-goal: a window, a prompt or a second consent for this. **Turn on** is the consent.

## Approaches

- **A. Harness writes the skill into each home it knows or finds (chosen).** Reaches running sessions and, through
  `~/.claude/skills`, every Orca profile. Cost: a Codex home is learned only once the scan sees it, and a Claude config
  dir that neither Harness knows nor links to `~/.claude/skills` gets nothing (Known gaps).
- B. The plugin carries the skill (#4386). Simple, one file, but no running session, no Orca profile and no
  existing install gets it without an update. Dropped.
- C. Read `CLAUDE_CONFIG_DIR` / `CODEX_HOME` from each agent process's environment. Finds every home at once, but
  breaks the hard rule above (an environment holds secrets). Dropped.

## The skill

- `cli/src/devices/codexSkill.ts` becomes `cli/src/devices/dialSkill.ts`: the skill text and the write, check and
  remove of one home's `skills/dial/SKILL.md`, the same for both engines (both read `<home>/skills/<name>/SKILL.md`).
  Both the `harness device` command and the devices service import it. It loads nothing of the core or of
  `deviceClaude/`.
- The text is `DIAL_SKILL` from #4379 with one line added in its frontmatter, a YAML comment that marks it as
  Harness's:

  ```
  ---
  name: dial
  description: "…"
  # Written by Harness. Turn off the agent in Harness Device to remove it.
  ---
  ```

  A YAML comment is ignored by both engines' frontmatter parsers. The builder check and the testers confirm that
  Claude Code 2.1.325 and Codex 0.167.1 still list the skill with it.
- **Ours** is a regular file, not a link, at most 4 KiB, whose frontmatter holds that exact marker line. Anything else
  at the path, including a missing marker, is the person's: never written over or removed. Reading uses
  `O_NOFOLLOW | O_NONBLOCK` and a size bound, as #4379's `held()` does.
- Writing: when the path holds nothing, or holds ours with other bytes (an older text), the folder is made (0700) and
  the file goes to a temp file (0600) renamed into place. When it already holds exactly `DIAL_SKILL`, nothing is
  written.
- Removing: only ours. Then the `dial` folder only if it is empty. `skills/` and the home stay.
- No released CLI carries #4379 (no tag contains 266e814cde), so no installed copy holds the old exact bytes without
  the marker. Exact-byte matching is replaced, not kept beside the marker.

## On and off

- `<dataDir>/dial-skill.json`: `{"claude":true|false,"codex":true|false}`. Its one writer is the `harness device`
  command. Read with a 1 KiB bound. A missing or bad file reads as no answer for each engine, as below. Written via a
  0600 temp file and a rename, like `dial-notify.json` (`cable/notifyMode.ts`).
- `harness device claude enable`: the plugin, as today (`claudeEnable`). On success, `claude: true` in the file and the
  skill into the default Claude home.
- `harness device claude disable`, in this order:
  1. `claude: false` in the file.
  2. The plugin uninstalled, as today.
  3. The skill removed from the default home and from every home in the homes list (below).

  A step that fails does not stop the ones after it. The command exits 1 with the first error.
- `harness device codex enable` / `disable`: the same for Codex, with no plugin.
- A person's own `dial` skill already in the default home: enable skips that home, still sets On, prints one line to
  stderr (`Codex already has a skill named dial that Harness did not write; it stays.`) and exits 0. Today
  `codexEnable` refuses instead; that refusal goes.
- Status:
  - `codex status` reports `enabled` from the file.
  - `claude status` reports `enabled` when the plugin is on (as today) and the file does not say `claude: false`.
- The default home:
  - For the command: its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else `~/.claude` / `~/.codex`. That is today's
    `codexHome` rule, and `claudeSettingsPath()`'s for Claude. The menu-bar app runs the command with neither set, so
    it is `~/.claude` / `~/.codex`.
  - For the devices service: the daemon's own, `dirname(env.CLAUDE_PROJECTS_DIR)` and `env.CODEX_HOME`.
- **What the devices service counts as On:**
  - Claude: the file does not say `claude: false`, and Claude Code's own record says the plugin is on. The record is
    `enabledPlugins["harness-device@openharness"] === true` in the default home's `settings.json`, read strictly with a
    1 MiB bound: a missing or bad file is Off, unlike `claudePluginOn`. The reader lives in `devices/dialSkill.ts`, not
    `deviceClaude/`.
  - This way people who turned the plugin on before this change get the skill at the devices service's next start.
    A plugin uninstalled through `/plugin` turns the skills off at the service's next moment too.
  - Codex: the file says `codex: true`. With no answer, Off.

## Where it is written

While an engine is On, the devices service writes the skill into each of these homes it has not handled yet in this
process's run:

| Moment | Homes |
|---|---|
| The devices service starts (a dial or a paired Wi-Fi device; the master starts it, `core/devicesWake.ts`) | Claude and Codex: the default home, every adopted home in `engine-homes.json` (`movedEngineHomes()`), every home in the homes list |
| The open scan (`cable/hosts/observed.ts` `scanOnce`, at a dial's attach and every 60 s while attached; absent when `HARNESS_DEVICE_OBSERVED=off`) | Codex only: the home of each session owner's rollout path the scan read, with or without a row. `lsof` already sees every open rollout, whatever its home. Codex 0.167.1 holds a terminal session's rollout in its managed `app-server`, so server owners count too. |

Claude gets no home from the scan or from hooks. The scan's Claude records are read only under the default and adopted
homes (`engines/kit/adoption.ts`), and the hooks that carry a `transcriptPath` (Harness's own `notify.mjs`) are
installed only there. An Orca profile shares `~/.claude/skills` through its link, so the default home covers it.

When the engine is Off at one of these moments, the devices service removes the skill from every home in the homes
list (only ours), and empties the list for that engine. The command's removal is the Turn off itself; the service only
catches up.

`harness device … enable` also writes the default home itself, so Turn on works with no dial attached and no devices
service running.

**A Codex home from a rollout path.** The path comes from `lsof`, and it is the file of another process, so a home is
taken from it only when all of these hold:
- Any owner the scan read, with or without a row, server owners included (orchestrator, 2026-11-16: a home in another
  `CODEX_HOME` never has a row, and Codex 0.167.1's managed `app-server` holds the rollout). Not a Harness-run owner
  (`harness`), and not one placed from its arguments (`fromArgs`, which has no path).
- The path is absolute, normalised, with no `..` and no control character, and at most 1024 bytes. It is not under
  the daemon's data dir.
- The path is exactly `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (four digits, two, two), and the home is five
  levels up. It is never found by searching for the first `sessions`.
- The home is an existing directory owned by the daemon's uid (stat).

A path that fails a check is dropped, and the path is not logged.

**Where the file goes.** `<home>/skills/dial/SKILL.md`:
- The skill folder is resolved with `realpath(<home>/skills)` when `skills/` exists. A link is followed (an Orca
  profile's `skills/` points at `~/.claude/skills`), and its target must be a directory owned by this user.
- Homes are deduplicated by that resolved skills folder, so `~/.claude` and every profile linked to it is one write.
- When `skills/` does not exist it is made (0700).

**The homes list.** `<dataDir>/dial-skill-homes.json` is `{"claude":[…],"codex":[…]}`: the resolved skills folders
the devices service wrote into, so Turn off finds them.
- Its one writer is the devices service. The command only reads it.
- At most 64 per engine. When it is full, a new home gets no skill, and the service logs one line with a count and
  no path. So every file Harness wrote stays in the list.
- Written through a temp file and a rename.
- Each pass drops from the list the homes whose skills folder no longer exists (a throwaway test home, say), so they
  do not fill the 64.

**Turn on again while the service runs.** Each scan `stat`s `dial-skill.json` once. When it changed, the service reads
it again, forgets the homes it handled, and runs the start pass again. So Turn off then Turn on brings the skill back
to every home without a restart.

**The race with Turn off.**
- The command writes Off first, then removes.
- The service reads `dial-skill.json` right before each write. After writing a new home and listing it, it reads the
  file again. If the engine is Off by then, it removes what it just wrote.
- So a skill left by a write in flight goes at the service's next check at the latest.

**Bounds.** The service keeps a set of the rollout homes it handled in this run (at most 64 per engine, like the
list; full, it handles no new one), so a scan every 60 s costs a set lookup per owner and no file work once a home is
done. One write or check per new home. No new timer.

## Windows

The devices listener does not exist on Windows (`devices/listenerPath.ts`), so `harness device notify` always prints
`no dial` there. Claude enable (`supported`) and Codex enable are macOS and Linux only today, and the open scan has no
Windows branch. A skill on Windows would tell the agent to call a command that cannot ring. So on Windows nothing is
written: enable keeps refusing as today, and the devices service writes no skill. A follow-up comes when the listener
reaches Windows.

## The menu-bar app (`device-app/`)

- The first-run offer windows for Claude Code and Codex go. `Screen::Claude` and `Screen::Codex`, their faces in
  `ui/src/screens.ts` (offer, working, failed), their gallery states (`ui/src/gallery.ts`), `Action::TurnOn` and
  `Action::NotNow` (Sign in uses neither; `ui/src/api.ts` too), the `due()` arms and the `first_answers` wait on Claude
  and Codex all go. Sign in's `offer` phase stays. `device-app/AGENTS.md` says four action names, not six.
- `askedClaude` and `askedCodex` leave `Saved`. Old state files still load: `Saved` ignores unknown keys (the
  `a_newer_key_is_ignored` test). A test loads a state file that has both keys.
- Menu, two rows per engine as today:
  - Off: `Claude Code: Off` then **Turn on**, with no "…" since no window opens. **Turn on** runs `harness device claude enable`
    directly, one change at a time as `set_claude` does today.
  - While a change runs: `Claude Code: Turning on…` (or `Turning off…`), with no action row. The fetch can take up
    to a minute.
  - On: `Claude Code: On` then **Turn off**, as today.
  - The same for Codex.
- The Claude Code rows show when `supported` (Claude Code 2.1.287 or later on macOS or Linux), also when the plugin is
  not installed: Off then. `available()` in `model.rs` becomes `supported`. They are absent when not supported.
  Codex keeps showing when Codex is installed.
- An enable or disable that fails: the status row reads `Claude Code: Could not turn on` (or `Codex: Could not turn
  on`, `Could not turn off`), with the action row under it to try again. The runner logs the CLI's reason as today
  (`claude: …`). No window. A new `AppState` field holds it. Every change, failed or not, is followed by a status read,
  and the row clears at the next change.

## Data (the checklist)

- **What is stored:** `dial-skill.json` (two booleans) and `dial-skill-homes.json` (folder paths of the person's own
  agent homes), in the daemon's data dir, mode 0600. Plus the skill file in each home, which is Harness's text, not
  the person's data.
- **Who reads and writes:** the `harness device` command writes the first file. The devices service writes the
  second. Both run as the person.
- **Synced or sent:** nothing. Neither file leaves the computer. No path goes to a log, a metric, the relay or the
  dial.
- **Retention:** each path stays until Turn off. The devices service empties the list at its next moment that sees
  Off.
- **Deletion:** Turn off removes every skill file Harness wrote (the command), and the service then empties the list. Uninstalling Harness leaves the
  data dir as today.
- **Access:** local files of the person's own account. A path from outside text is checked before use (A home from a
  path).

## Measures

One log line per devices-service pass that changed something: `dial skill: claude wrote 2 removed 0, codex wrote 1
removed 0`. Counts only: no path and no home name. One line when a path is refused, with the reason
(`shape`, `owner`, `missing`), no path. One line when the list is full, with the count. The command logs nothing new, and prints errors as today.

## Docs to change

- `docs/plans/2026-11-13-device-menubar-design.md`: Goal 3, the four screens, the Claude Code voice section, the Menu
  table, Window and UI, the State file and Testing.
- `desktop/design/desktop-design-system.md`, Harness Device. The gallery is `device-app/ui/gallery.html`, built from
  `ui/src/gallery.ts`.
- `device-app/AGENTS.md` (the offers and the screens), `docs/cli.md` (`harness device claude/codex enable` now write the
  skill into the default home, and the devices service writes it into other homes).
- `cli/src/deviceClaude/command.ts` `DEVICE_USAGE`.
- `docs/plans/2026-11-16-dial-agent-notify-design.md`, Release order: one line saying the second pull request was
  replaced by this design.

## Testing (red first)

- `dialSkill`:
  - writes into an empty home, 0700/0600.
  - writes over ours with older bytes.
  - leaves the person's file (no marker, a link, a FIFO, over 4 KiB) untouched.
  - removes only ours.
  - removes the empty `dial` folder and keeps `skills/`.
- Codex home from a rollout path:
  - Accepted: the `sessions/YYYY/MM/DD` shape, with the fixed levels, from a terminal owner or an `app-server` owner.
    A home path that itself holds a `sessions` folder name still resolves right.
  - Rejected: a relative path, `..`, the wrong shape (`archived_sessions/` included), a home owned by another user, a
    path under the data dir, and an owner that is a Harness one or placed from arguments.
  - A listed home whose skills folder is gone is dropped from the list.
  - A changed `dial-skill.json` makes the next scan run the start pass again.
- Where the file goes: a linked `skills/` is followed, and a profile linked to `~/.claude/skills` dedupes to one write.
- On and off:
  - `dial-skill.json` is read and written.
  - Claude On needs the strict plugin entry. A missing file falls back to that entry for Claude and to Off for Codex.
  - A plugin entry gone reads Off.
- The command:
  - Claude enable writes the skill into a throwaway `CLAUDE_CONFIG_DIR` and sets On.
  - Enable over a person's skill sets On, skips that home and exits 0.
  - Disable writes Off first, then removes from the default home and every listed home, and keeps a person's skill.
  - A failing step still runs the rest.
  - The same for Codex.
- The devices service, with throwaway homes and a fake scan:
  - At start it writes the default, adopted and listed homes.
  - A Codex owner in a new `CODEX_HOME` gets the skill, and its home is listed.
  - Off at a moment removes the listed ones and empties the list.
  - The race: Off set between write and recheck removes the new one.
  - A known home costs no file work on the next scan.
  - A full list writes no new home.
- Windows: enable refuses and the service writes nothing (platform injected).
- The menu-bar app (Rust unit tests and UI tests):
  - no offer screen at first run.
  - Turn on in the menu emits the enable effect with no window, and the row reads Turning on… until it ends.
  - The Claude row shows when supported and not installed.
  - "Turn on" has no "…".
  - A failed enable shows the row's error.
  - A state file with `askedClaude`/`askedCodex` loads.
- End to end (Verification in the plan): on this Mac, with throwaway homes only and never the person's real
  `~/.claude`, `~/.codex`, live daemon or Harness.app:
  - a running Claude Code in a throwaway `CLAUDE_CONFIG_DIR`, and a running Codex in a throwaway `CODEX_HOME`, list
    the `dial` skill after the write, with the marker line present.
  - Turn off removes it.

## Known gaps

- A Claude Code config dir that is neither `~/.claude`, nor adopted in `engine-homes.json`, nor linked to
  `~/.claude/skills` (as Orca's profiles are) gets no skill. Finding it would mean reading the process's environment,
  which the hard rule forbids.
- A Codex home is learned only once a session there has an open rollout during a scan while a dial is attached.
- A person's own copy of the skill that keeps Harness's marker line reads as Harness's and is written over.
- Homes are learned only while the devices service runs. On macOS and Linux that is while a dial or a paired Wi-Fi
  device is present, which is when the skill matters.
- Windows: no skill until the devices listener reaches Windows.
