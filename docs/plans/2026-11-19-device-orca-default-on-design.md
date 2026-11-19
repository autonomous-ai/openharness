# The Orca plugin is set up by default (Diego, 2026-11-19)

Replaces the `Connect Orca…` menu row of [Connect Orca](2026-11-18-connect-orca-design.md) (#4446). Its decisions 3, 4,
6 (the app's silent update), 7 and 8 end here; its plugin folder, its reads of Orca and its bounds on Orca's answers stay.

## Why

Diego (2026-11-19, on the menu-bar app): "bỏ cái option Connect Orca đi, mặc định turn on luôn": drop the option and
turn it on by default. The dial's Orca features need the Harness Device plugin for Orca
(`plugins/harness-device-orca`), and a menu row a person must find and click leaves most of them without it. VS Code's
and Cursor's extension (#4427, #4461) and Claude Code's plugin are already set up with no click.

## Decided (Diego and the PM, 2026-11-19)

1. **No menu row.** The Harness Device app shows nothing about Orca: no `Connect Orca…`, no `Update Orca connection…`,
   no Orca screen. The app runs no `harness device orca` command.
2. **The devices process sets the plugin up**, as it sets up the VS Code and Cursor extension
   (`cable/vscodeExtensionSetup.ts`): installed the first time a pass finds a running Orca after a dial has attached
   here, brought current after each CLI update, and never installed again once the person removed it. The person's
   removal wins: `harness device orca disable`, an uninstall in Orca, or a disable in Orca.
3. **Harness approves the plugin for the person, only for the access Diego agreed to today.** The plugin as it ships
   today asks Orca for: code run as a trusted worker, the capability `workspace:read`, and the contributions it has (its
   `Harness Device` panel, its `Dial` status bar item, the event `workspace.changed`). Harness passes `--approve` only
   when everything Orca lists in its `approval_required` answer is within that set. Orca's own guidance for a CLI
   approval is "Confirm with your user first unless they already asked for exactly this plugin and access". Diego asked
   for exactly this plugin and access. Anything more is a new decision for Diego, below.
4. **A plugin that asks for more access is held.** Harness never approves it. An installed plugin keeps its running
   version, since Orca leaves the running version in place when an update is refused. A plugin not yet installed stays
   out. Harness logs a count and a fixed reason, never Orca's words. A later CLI whose pinned set covers the new access
   (a reviewed code change, Diego's decision) sets it up.
5. **Words kept:** `harness device orca status [--json]`; new `enable` and `disable`, shown in `harness device` usage.
   `harness device orca connect` and its `--approve` are removed. `harness device orca link` (the plugin's own) stays.
6. **Another pass when Orca comes up.** Orca is often not running when the devices start or a dial attaches. A pass also
   runs when Orca settles in front, the moment the devices already notice for Orca's focus watch.
7. **Logs:** counts and fixed words only (#4458): no path, key, grant, fingerprint or Orca message. A caught error is
   logged by `errorKind(err)` (`cli/src/lib/log.ts`, #4488), never its message, `String(err)` or stack; #4488's guard
   test holds the branch to it.

## What Orca does (Orca 1.4.262, read from its CLI's help and its app's code, 2026-11-19)

- Every `orca plugin` command needs a running Orca. With none, it retries for about 30 s. So `orca status --json`
  (`runtime.reachable`, `runtime.appVersion`) is asked first, 5 s at most. This is unchanged from #4446.
- `orca plugin install <dir> --json`, `update <key>` and `enable <key>`, for a plugin that runs code, write nothing and
  exit 3 with `approval_required`. `data` holds `approvalFingerprint` and `grants`: `execution`, `capabilities[].kind`,
  `contributions[]` (`kind`, `name`, `detail`?) and, only when present, `replacements[]`. The same command with
  `--approve <fingerprint>` installs. The fingerprint is bound to that key, version, files, execution, capabilities and
  contributions.
- An update that asks for no new access keeps its approval and needs no `--approve`. An update that grows access (a
  capability, the execution level or a contribution) exits 3 and leaves the running version as it was.
- The running Orca loads an installed, approved plugin at once, with no restart. The person sees the plugin in Orca's
  plugin list, running, with its access. We found no notice in Orca for an approval given through the CLI.
- `orca plugin uninstall <key> --json` removes it. A disable or uninstall in Orca shows in `orca plugin list --json` as
  `status: disabled`, or as no entry.
- Orca not installed, older than the plugin's `engines.orca`, or on Windows: no Orca to ask, so nothing is done and
  nothing is counted.

## Design

### The approved access (`cli/src/devices/orcaPlugin.ts`)

- A constant pins the approved set: execution `trusted-worker`; capability kinds `workspace:read`; contributions
  `panels/Harness Device`, `statusBarItems/Dial` and `events/workspace.changed`; and no `replacements`.
- `withinApproved(data, key, version)` is true only when all of these hold:
  - `data.pluginKey` is the key `inspect` gave, and `data.version` is the version in the carried `orca-plugin.json`;
  - `grants.execution` is the pinned one;
  - every capability is an object with only `kind` and `description`, and its `kind` is pinned. Orca counts a
    capability by its whole object, scope fields included, so one with any other key is refused;
  - every contribution's `kind` and `name` pair is pinned;
  - there is no `replacements`.

  A field of another shape is not within it.
- Orca names a contribution as `pluginContributionSummary` does: a panel by its `title`, a status bar item by
  `text || id`, an event by its `on`. So a copy change to the panel's title or the status bar text also holds the
  plugin until the pin follows.
- A test builds the grants Orca would list from the shipped `orca-plugin.json` with those rules and checks that they
  are within the pinned set. So a manifest change that adds access fails CI until the pin changes too, and that pin
  change is the reviewed decision.
- The window-only bounds of #4446 are deleted: `grantLines`, `ORCA_GRANTS_MAX`, `ORCA_GRANT_MAX_CHARS`, `UNSHOWN` and
  `line`. What stays is the 256 KiB read, the fingerprint's pattern and `withinApproved`.

### Setting it up: `orcaSetUp(deps, { force })` (`orcaPlugin.ts`)

This replaces `orcaConnect`. It is one function for the devices' pass and for `enable`:

- `find()` as today, with one change. "Set up before" is now either record: the devices' `dial-setup.json` `orca`
  version (new) or the command's `dial-skill.json` `orcaConnected` (kept, so a person who connected with 0.1.9's click
  and then removed the plugin is not set up again). With `force` (`enable`), an earlier removal does not hold it back.
- By state. `enable <key>` runs only for an entry installed from the plugin's own folder (`fromFolder`), so Harness never
  approves code it did not put there, such as a pending install from a person's checkout:
  - `offer`, and `behind` from another folder: `install <folder>`.
  - `behind` from the plugin's folder: `update <key>`.
  - `approve` (`pending` or `needsReconsent`): `enable <key>` from our folder, `install <folder>` from any other.
  - `off` with `force`: for an entry disabled in Orca, `enable <key>` from our folder and `install <folder>` from any
    other; for one no longer listed, `install <folder>`.
- Orca's answer:
  - `ok`: the result is `on`.
  - `approval_required` or `approval_stale` whose fingerprint matches its pattern and whose `data` is
    `withinApproved`: the same command once more with `--approve <its fingerprint>`. A second refusal is `failed`.
  - Outside the pinned set: `held`, with nothing approved.
- A deadline passed: `finished()` as today (`on` or `timeout`).
- Results: `on`, `held`, `off` (removed, no `force`), `absent` with `not-running` or `old` (Orca not here, not reachable
  or too old, Windows, a run from the sources), or `failed` with a fixed code (`timeout`, `failed`, `folder`). An
  answer after a status that said Orca is reachable that cannot be read is `failed`, never `not-running`.
- `disable`'s uninstall is `orcaRemove(deps)`: `orca plugin uninstall <key> --json`, only for an entry with the plugin's
  key. Orca not running: `not-running`; an answer after its status that cannot be read: `failed`, so the devices' pass
  counts it and waits its hour rather than asking again at each settle.

### The devices' pass (`cli/src/cable/orcaPluginSetup.ts`, new, beside `vscodeExtensionSetup.ts`)

- Same shape as the editor setup: one pass at a time, and one asked while another runs runs once after it (Orca may
  come up while a pass waits for its `orca status`); it never rejects; nothing runs on Windows or in a run from the
  sources.
- A pass reads `dial-setup.json`'s record (held in memory) first, then `dial-skill.json` once: its removals, or
  `orcaConnected` alone where that decides the first set-up. Removed, unread, or the record not yet read: it returns.
  An uninstall the pass owes (below) is tried first, whatever the record says.
- "The version" everywhere below is the version in the carried `orca-plugin.json` (the build stamps
  `extensionVersion(VERSION)` there), as the editors record `buildVersion`.
- `recorded.orca` or `recorded.orcaHeld` equals the version: it returns with no Orca run and no file read (a removal
  since is `disable`'s to carry out). So a pass when Orca settles in front costs nothing once the plugin is set up or
  held. The carried version is parsed once a process.
- With no `orca` version recorded and no `orcaConnected`: it runs only when a dial has attached here (`recorded.dial`).
  A plugin set up before is still brought current.
- Each result:
  - `on`: record the version. The count is `set up`, or `updated` for a plugin that was installed. A
    `harness device orca disable` that landed while the install ran is honoured: `orcaRemove` then, as the editor
    setup's `undo` does. With Orca not running then, it stays owed, with nothing counted and no hour: the next attach or
    settle runs it (owed in memory, as the editors' is, so a restart before then forgets it).
  - `off`: record the version. The count is `left removed`, once per version.
  - `held`: record the version as `orcaHeld`, never as `orca`, so it is not asked again until the next CLI and never
    counts as "set up before" (a plugin held before it was ever installed is still installed by a later CLI that
    approves it). The count is `failed` with reason `access`.
  - `absent/not-running`: nothing recorded and nothing counted. The next start, attach or Orca settle passes again.
  - `absent/old`, and `absent/other` (an entry Orca lists as a development install, `errored` or `invalid`; PM,
    2026-11-19): nothing counted, and passes wait an hour with none at its end, so neither each settle nor each hour
    runs Orca's CLI again; the first one after the hour asks again.
  - `failed`: the count is `failed` with its reason, and the pass waits an hour, as the editor setup's failed pass
    does. An attach or a settle within that hour runs nothing. A `disable` that landed while Orca ran past its deadline
    is owed: the hour's pass uninstalls what Orca installed late, as the editors' setup does.
- **When:** at the devices' start (after Orca's homes are read, beside the editors' passes), at each attach, when Orca
  settles in front, and an hour after a failed pass. The settle runs the pass whenever the setup exists (as the
  editors' passes are gated on `skill`), not only with `observed`, and with or without a dial. Settles come from the
  Device app's `harness hardware watch`, which the app keeps running.
- **Its deps in the devices** (`services/devices.ts`): `deps.orcaPlugin` for tests, as `deps.vscodeExtension` is, so
  `devices.spec.ts` never runs this computer's `orca`. In production it uses `orcaPluginRun()`, with the folder
  `harnessPath('orca-plugin', homedir())` (as the command finds it) and `dataDir` `core.dataDir`. The plugin's files
  already reach the devices' lean bundle (`__ORCA_PLUGIN__` is in the shared build options). A folder that cannot be
  written is the reason `folder`, and its errno is not logged.
- **Records:**
  - `dial-setup.json` gains `orca?: string` and `orcaHeld?: string`, written only by the devices, through
    `dialHomeSetup`'s `orca()`, `recordOrca()` and `recordOrcaHeld()`, as `vscode` and `cursor` are. They are read and
    checked as the other versions are (`setupOf`, `writeSetup`).
  - `dial-skill.json` gains `removed.orca`, written only by the command (`removedOf`, `rewriteSetting`).
- **Log:** one tally line, `[device] orca plugin`, through the same tally as the editors (`SETUP_COUNTS`), with reasons
  as fixed words (`access`, `timeout`, `failed`, `folder`, `save`, `error`).

### `harness device orca …` (`cli/src/deviceClaude/command.ts`)

Each word prints one JSON line, as the editors' words do.

- `status [--json]`: `{"orca":"<state>"}`, exit 0 in every state (0.1.9's app reads any other exit as a failure). The
  state is:
  - `on`: installed, approved, at the carried version;
  - `off`: removed by the person (`removed.orca`, or `find()`'s `off`);
  - `held`: `dial-setup.json`'s `orcaHeld` is the carried version;
  - `setup`: not on yet. Harness sets it up once a dial has attached here and Orca runs, or brings it current;
  - `absent`: no Orca to ask (not here, not running, too old, Windows, a run from the sources), or an entry of
    another kind (`other` above).

  The first that holds (PM, 2026-11-19): `off` for `removed.orca` (Orca is not asked), `absent`, `off` for Orca's own
  removal, `on`, `held`, `setup`.

  Before asking Orca, the plugin's folder is written, as today. 0.1.9's app reads `on`, `setup` and `held` as nothing it
  knows, so it shows no row. Its `off` and `absent` also show none.
- `enable`: clears `removed.orca` first (a failed save installs nothing), then `orcaSetUp({ force: true })`. On `on` it
  writes `orcaConnected` (so a later removal in Orca is the person's) and exits 0. `held`, `absent` and `failed` print
  their word and exit 1. With Orca not running it exits 1 with `not-running`: the devices' record already holds this
  version, so nothing would install it later, and the person runs `enable` again with Orca open.
- `disable`: marks `removed.orca` first, then `orcaRemove`. With Orca not running, the removal is saved, nothing is
  installed again, and the line says `not-running` (exit 1), so the person can remove it in Orca or run `disable` again
  with Orca open.
- `connect` is gone and prints the usage, as any unknown word does.

### The Harness Device app (`device-app/`)

These are removed: `orca_cli.rs`; the Orca types (`OrcaStatus`, `OrcaAnswer`, `OrcaError`, `Fingerprint`); the
model's Orca state; the runner's Orca runs; the `connect_orca` action; the silent update; the menu rows; the Orca screen
and its strings in `ui/` (`screens.ts`, `gallery.ts`, `api.ts`) and their tests; and `cli.rs`'s log redaction of
`--approve`. Orca as an app in front (`tabs.rs` and its tests) has nothing to do with the plugin and stays.

### Docs

- `device-app/AGENTS.md`: the Orca lines go.
- `plugins/harness-device-orca/README.md`: how Harness sets the plugin up. It says, in these words or close: Harness
  approves the plugin in Orca for you: its own worker process and read-only access to your workspaces; remove it in
  Orca or run `harness device orca disable` and Harness will not install it again; an update that asks for more access
  is not approved.
- `cli/AGENTS.md`'s devices row: the Orca plugin's setup, beside the editors'.
- The header of `orcaPlugin.ts`: it now runs in the devices' process, never the core's.
- `harness device` usage gains the two lines.

## Data

- **Stored.** `dial-setup.json` gains `orca` and `orcaHeld` (plugin versions). `dial-skill.json` gains `removed.orca` (true or absent).
  `orcaConnected` stays as it is. No name, path, token or content.
- **Exposed.** Nothing leaves the computer. Orca's grants are read only to compare with the pinned set, and are never
  logged or passed on.
- **Trust.** Orca's answers are outside text, read with #4446's bounds (256 KiB, the fingerprint's pattern, only the
  named fields). A grant of an unexpected shape is not approved.
- **Consent.** The approval is Harness's, given for the person on Diego's decision. It covers only the pinned access,
  and the person's removal always wins.

## Measures and cost

- The tally line above, once a day, as the editors'.
- Cost:
  - Once set up for this CLI version: no Orca run at all, at a start, an attach or a settle.
  - Otherwise each pass runs `orca status` (about 0.3 s), plus `inspect`, `list` and at most two install-type runs
    while it sets up, each bounded (5 s, 10 s, 10 s, 60 s).
  - Orca not running: `orca status` alone, only at a start, an attach or a settle (and Orca settles only while it runs).

## Testing

All of it runs against the fake `orca` (`testing/fakeOrcaCli.ts`) in a throwaway home and data folder. The fake gains
`plugin uninstall`, and the state a daemon under test needs, since the test cannot change answers between the passes
inside the daemon: an install-type word without `--approve` answers exit 3 `approval_required`; with the fingerprint it
answers `ok`; and `plugin list` lists what was installed, uninstalled or disabled. It works through the launcher it
shares with `e2e/harness/fakeOrca.ts`, and `HARNESS_ORCA_APP_BIN` and the harness's stub keep a daemon under test off
this computer's Orca. None of it runs against this computer's Orca, its config or its
plugin list, and none of it is a real-app gate.

- `orcaPlugin.spec.ts`:
  - `withinApproved`: the shipped manifest's grants pass; each extra capability, execution, contribution or a
    replacement fails, and so does a field of another shape.
  - `orcaSetUp`: install, update and enable, each approved; a second refusal; `held` with nothing approved; `force`
    from `off`; `not-running`; `old`; a timeout finished or not.
  - `orcaRemove`.
- `orcaPluginSetup.spec.ts`, as `vscodeExtensionSetup.spec.ts`:
  - first setup only after a dial;
  - no Orca run once recorded;
  - updates after a CLI update;
  - the person's removal (disable, uninstall in Orca, disable in Orca) left alone;
  - a disable during the install undone;
  - `held` recorded once;
  - the failed hour;
  - Windows;
  - one pass at a time.
- `devices.spec.ts`: a pass at start, at attach and at Orca's settle.
- `dialHomeSetup.spec.ts`, `dialSkillFiles.spec.ts`: the new record fields.
- `command.spec.ts`: `orca status|enable|disable` and their lines and exit codes, `connect` gone, the usage.
- `device-app`: the Rust and UI tests lose Orca; a test that the menu has no Orca row in any state.
- End to end: `cli/e2e/deviceOrcaConnect.e2e.ts` becomes `deviceOrca.e2e.ts`. On the built `cli.js` against the fake
  `orca`, it checks `status`, `enable` (installs with the fingerprint, records), and `disable` (uninstalls, and a later
  `enable` is needed). A devices-process end-to-end check (a fake dial on a pseudo-terminal, as `devicesProcess.e2e.ts`,
  with the fake `orca` reachable) checks that a dial's attach installs and approves the plugin with no command, and
  that after a `disable` an attach installs nothing.

Platforms: macOS and Linux (the devices' listener the plugin talks to does not run on Windows, so nothing is set up
there). The device app on macOS.
