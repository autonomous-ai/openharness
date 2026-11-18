# Connect Orca from the Harness menu-bar app (Diego, 2026-11-18)

On top of [the dial's swipe stays in the worktree on screen](2026-11-18-dial-orca-tab-scope-design.md) (#4434, CLI
0.6.66), which needs the Harness Device plugin for Orca (`plugins/harness-device-orca` 0.2.0, capability
`workspace:read`, event `workspace.changed`), and on the VS Code extension the CLI already carries
(`cli/src/devices/vscodeExtension.ts`, `cli/scripts/lib/vscodeExtensionBundle.mjs`).

## Why

Today a person must run two Orca commands by hand to get the plugin: `orca plugin install <dir>`, which stops with
`approval_required` and prints a fingerprint, then the same command with `--approve <fingerprint>`. The `<dir>` is a
folder of a git checkout of this repository, which no person who installed Harness has. Orca's own words on approval:
"Confirm with your user first unless they already asked for exactly this plugin and access." So Harness may install it,
but only after the person has seen what Orca lists and said yes.

## Decided (Diego and the PM, 2026-11-18)

1. **The plugin ships with the CLI**, the way the VS Code extension does: `cli.js` carries the plugin's files, and the
   build stamps the CLI's version on its manifest, so the plugin's version always matches the CLI's. The plugin has no
   release of its own.
2. **The CLI does all of the work with Orca** (`harness device orca status|connect`), in the `harness` command's own
   process. The core and the devices process run none of it. The Harness app stays thin: it runs those two commands with
   fixed arguments and reads one JSON line from each.
3. **A one-time menu row, `Connect Orca…`,** appears only when Orca is installed and running, its version is at least
   the plugin's `engines.orca`, and the plugin is not installed. Clicking it shows the access Orca lists for the plugin,
   in Orca's words (taken from Orca's `approval_required` answer, never hard-coded), with **Cancel** and **Connect**.
   Only Connect installs, with the fingerprint taken only from that answer. The screen then shows done, or the error,
   in one line.
4. **Never approve without that click.** A command run without the person's click never passes `--approve`.
5. **Never install again after the person removed or disabled it.** A successful connect is recorded. Once it is
   recorded, a plugin that is missing or disabled is the person's choice, and Harness offers nothing again.
6. **Updates.** When the plugin is installed and enabled but not the one the CLI carries, the Harness app runs
   `harness device orca connect` (without `--approve`). Orca keeps the approval of an update that asks for no new access,
   so the update goes through without a click. If Orca asks for approval again (`approval_required` or
   `approval_stale`), the row comes back as `Update Orca connection…`, and its click works as Connect does.
7. **When the app checks:** once the CLI is found, when the CLI's version changes, and when the menu opens (at most once
   every 5 minutes). With Orca not running, or too old, there is no row.
8. **Cancel keeps the row** in the menu. It is not a pop-up and asks nothing of the person until they open the menu.

## What Orca answers (read from Orca 1.4.262's own code, 2026-11-18)

- `orca plugin install <dir> --json` without `--approve`, for a plugin that runs code, writes nothing and exits 3 with
  `{"ok":false,"error":{"code":"approval_required","message":…,"data":{…}}}`. `data` holds `pluginKey`, `name`,
  `version`, `approvalFingerprint` (`ap1-` and 32 hex digits) and `grants`: `executionDescription` (one sentence),
  `capabilities[]` (`{kind, description}`), `contributions[]` and, for some plugins, `replacements[]`. For an installed
  plugin, `data.update` says what grew.
- The same command with `--approve <fingerprint>` installs. A fingerprint that no longer matches (the files or access
  changed since it was shown) exits 3 with `approval_stale` and a fresh `data` of the same shape.
- `orca plugin update <plugin-key> --json`: "folder installs re-copy the folder", the folder the plugin was first
  installed from. An update that asks for no new access keeps its approval; one that grows access exits 3 with
  `approval_required` and leaves the running version as it was. Installing the same plugin from another folder counts
  as a moved source and asks for approval.
- `orca plugin enable <plugin-key> [--approve <fp>] --json`: approves a plugin that is `pending`, with the same answers.
- `orca plugin list --json`: `result.plugins[]` with `pluginKey`, `version`, `status` (`running`, `idle`, `pending`,
  `disabled`, `errored`, `invalid`), `needsReconsent`, `isDev` and `source` (`kind`, `reference`).
- `orca plugin inspect <dir> --json` gives a folder's `pluginKey` (`local.harness-device` today) without asking Orca's
  app, so the key is read, never hard-coded. Orca loads `.ts` and `.tsx` with no build and reads no `tsconfig.json`.
- `orca status --json`: `result.app.running`, `result.runtime.reachable` and `result.runtime.appVersion`. Every other
  plugin command needs a reachable Orca; without one it retries for about 30 seconds, so `status` is asked first.

## Design

### The plugin's files in the CLI (`cli/scripts/lib/`, `cli/build.mjs`, `cli/build-bundle.mjs`)

- The build puts the plugin's runtime files in `cli.js` as one JSON constant (as `__VSCODE_EXTENSION__`): its
  `orca-plugin.json` with `version` set to the build's version through `extensionVersion()` (Orca's version pattern takes
  it), and its `src/` `.ts` and `.tsx` files that are not tests, each as text, by its path relative to the plugin. The
  plugin's tests, other files, `tsconfig.json` and the README stay out. A name the plugin's folder would not take (other
  than letters, digits, `.`, `_` and `-`) fails the build.
- A run from the sources carries no files: `status` answers `absent` and `connect` fails with `no-plugin`.
- `scripts/ci-plan.py` maps `plugins/harness-device-orca/` to the CLI's suite too, as it does the VS Code extension.

### The plugin's folder

- `orca-plugin/` in Harness's data root (`~/.harness` on macOS; on Linux the XDG data root,
  [2026-11-18-linux-xdg-paths-design.md](2026-11-18-linux-xdg-paths-design.md)): the `orca-plugin` entry of the paths
  module's table (`cli/src/config/harnessHome.ts`, label `data`; ken-pm, 2026-11-18), built by
  `harnessPath('orca-plugin', deps.home)` from the home the `harness device` command is handed (`DeviceDeps.home`), so a
  test with a throwaway home stays in it. A data root not made yet is made (0700). The Harness app never names the
  folder, so its crate's paths helper gains no entry. It is this account's alone (0700 folders, 0600 files). It is the
  folder Orca installs from, and the folder Orca re-copies at each update. When Harness's files move on Linux, Orca's
  entry names its old place, and is installed from the folder again (`status` rule 5).
- `status` and `connect` both make sure it holds what `cli.js` carries before they ask Orca about it, writing only when
  its content differs: the new files go into a staging folder of the run's own, `orca-plugin.new.<pid>/`, the old folder is renamed to `orca-plugin.old/`, the
  new one renamed into place, and the old one removed. A run that finds `orca-plugin.old/` with no `orca-plugin/` puts
  it back first; a staging folder whose process no longer runs is removed, so two commands at once never touch each
  other's. Orca never reads half a folder.
- A folder that cannot be written: `status` answers `absent` and `connect` fails with `failed` (not `not-running`), and
  each prints `orca plugin folder: <code>` on stderr: the error's code (`EACCES`), never its message, which names a
  path.

### The record

- `dial-skill.json` (the device's settings record, `cli/src/devices/dialSkillFiles.ts`) gains `orcaConnected: true`.
  It is part of `DialSetting`, read and written with the rest, so another command's rewrite of the file keeps it. It is
  written after a connect that ends `done`, and never cleared by Harness.

### `harness device orca status --json`

One JSON line. It writes only the plugin's folder. It asks Orca at most `status` (5 s), `inspect` (10 s) and `list`
(10 s). The first rule that holds decides:

1. **`absent`** (no row): Windows; a CLI from the sources; no `orca` (on Linux, none on `PATH`; on a Mac, also the app
   in `/Applications`); `runtime.reachable` is not true; `appVersion` below the plugin's `engines.orca`; any answer that
   cannot be read or a deadline passed; or the plugin's entry is a development folder (`isDev`).
2. **`offer`** (`Connect Orca…`): no entry with the folder's `pluginKey`, and not recorded.
3. **`off`** (no row, ever): no entry and recorded; or the entry is `disabled`.
4. **`approve`** (`Update Orca connection…`): the entry is `pending` or `needsReconsent`.
5. **`behind`** (silent update): the entry's version is not the one the CLI carries, or its `source.reference` is not
   the plugin's folder's real path, which is what Orca records (a person installed it by hand from a checkout, or Orca
   recorded the folder's place before Harness's files moved on Linux, now a link to it). Orca updates from the path it
   recorded and counts any other as a moved source, so such an entry is installed from the folder itself.
6. **`absent`**: the entry is `errored` or `invalid`.
7. **`current`** (no row): anything else.

### `harness device orca connect [--approve <fingerprint>] --json`

- `--approve` takes the next word as its value, read before the words that start with `-` are dropped, and only
  `^ap1-[0-9a-f]{32}$`. Anything else fails with `failed` before Orca is run.
- It works out the state as `status` does, then:
  - `off` or `absent`: `failed` (`off`, or `not-running`; `failed` for a folder that cannot be written), so no stale
    click can install again;
  - `offer`, or `behind` from another folder: `orca plugin install <folder>`;
  - `behind` from the plugin's folder: `orca plugin update <key>`;
  - `approve`: `orca plugin enable <key>`;
  - `current`: `done`;
  each with `--approve <fingerprint>` only when given, and a deadline of 60 s. Orca may finish past it: `connect` then
  asks `list` once (10 s), and is `done` when the entry is at the version `cli.js` carries, from the plugin's folder,
  and neither `pending` nor `needsReconsent`; else `timeout`. With `status`, `inspect` and `list` before, 95 s at most,
  within the app's 120 s.
- One JSON line:
  - `{"connect":"done"}`: Orca answered `ok`, or listed the plugin as asked past the deadline. It writes the record.
  - `{"connect":"approve","name":…,"version":…,"fingerprint":…,"grants":[…],"update":true|false}`, from Orca's
    `approval_required` or `approval_stale` `data`. `grants` is Orca's `executionDescription`, each capability's
    `description` and each replacement as Orca's own message words it (`Runs "<command>" instead of Orca's own
    <action>`), in Orca's order: the access, not the panels it adds. `update` is true when the plugin is installed. A
    string that holds a control, format, line separator or paragraph separator character (Unicode categories Cc, Cf,
    Zl, Zp: a line break, a tab, a bidi override or a zero-width space too) or a lone surrogate, or is longer than 300
    characters, more than 10 of them, or a fingerprint that is not `ap1-` and 32 hex digits makes the whole answer
    `failed`, with nothing of it passed on: nothing is cut. The app holds an `approve` line to the same bounds.
  - `{"connect":"failed","error":"<code>"}`: one of `not-running`, `no-plugin`, `off`, `timeout`, `failed`. Never Orca's
    message, which can hold a path.
- Exit 0 on `done` and `approve`, 1 on `failed`.
- Logs nothing of what Orca lists.

### The Harness app (`device-app/`)

- **State.** `AppState` gains `orca: OrcaState` (`None`, `Offer`, `Update`), from the last `status` and from a silent
  `connect`. It runs `status` once the CLI is found, after the CLI's version changes, and on `MenuOpened` when the last
  run was 5 minutes ago or more. One Orca run at a time: a request while one runs waits for it, and the screen's
  `connect` goes before a waiting `status`. Deadlines: 30 s for `status`, 120 s for `connect`.
- **Silent update.** On `behind`, it runs `connect` without `--approve`, once per CLI version while the app runs (an app
  restart may run it once more, which asks nothing). `done` sets `None`; `approve` sets `Update`; `failed` leaves `None`
  and logs the code. A `not-running` or `timeout` failure is tried again at the next `status` that says `behind`, still
  without `--approve`.
- **The menu.** `Connect Orca…` (`Offer`) or `Update Orca connection…` (`Update`), one action each, below the sign-in
  row and above Sound. Each click opens the window on the new screen.
- **The screen, `Screen::Orca`.** The view carries the phase, the grants and whether it is an update. On open it runs
  `connect` without `--approve`:
  - `Asking`: the spinner and `Asking Orca…`;
  - `Approve`: the heading `Connect Orca` (or `Update Orca connection`), the body `Orca will let Harness Device:`, then
    the grants, one per line as Orca words them, in a list that scrolls when it does not fit, and **Cancel** and
    **Connect** (**Update** for an update). No button is focused, so a Return pressed in another app's habit approves
    nothing; the person clicks or tabs to it;
  - `Done`: `Orca connected.` and **Done**;
  - `Failed`: one line in danger ink and **Close**; the row stays:
    - `not-running`: `Orca isn't running.`
    - anything else: `Couldn't connect Orca.`
- **Connect.** The fingerprint stays in Rust, from the last `approve` answer; the webview sends only the new action
  `connect_orca`, never a fingerprint. Rust runs `connect --approve <fingerprint>`. `done` shows `Done`, and the row is
  gone. `approve` again (`approval_stale`: the files changed meanwhile) shows the new grants and waits for a new click.
- **Cancel, Done and Close** send the existing `cancel`, which closes the window. Cancel installs nothing and the row
  stays.
- **A closed window.** Closing it never stops a run; its answer still sets the state and the menu, and the window stays
  closed.
- **Fixed arguments.** The app runs `harness device orca status --json` and `harness device orca connect --json`, with
  `--approve <fingerprint>` only for the click, where the fingerprint is the CLI's answer held to `^ap1-[0-9a-f]{32}$`
  in Rust. The run's name in the log leaves the fingerprint out.
- **Logs.** `orca: <state>` on each change of state and `orca connect: <done|approve|failed code>`. Never a grant, a
  name or a fingerprint.

### Docs that change in the same pull request

- `desktop/design/desktop-design-system.md`, the Harness Device section: three screens, the two menu rows, the Orca
  screen with no focused button (an exception to "the primary button focused"), and the gallery
  (`device-app/ui/gallery.html`) showing the screen in each phase in both themes.
- `device-app/AGENTS.md`: three screens; the webview's action names; the one argument that is not fixed text (the
  fingerprint, from the CLI's answer, held to its pattern).
- `plugins/harness-device-orca/README.md`: Install says the Harness app offers `Connect Orca…`; the commands stay for
  people without it.

### What does not change

The core: nothing. The devices process: nothing. The plugin's code: nothing (only how it ships and its stamped version).
`harness device orca link`.

## Data

- **Stored.** `orcaConnected: true` in `dial-skill.json`, and the plugin's own files in the data root's `orca-plugin/`. Neither
  holds a name, path of the person's, token or content.
- **Exposed.** Nothing new leaves the computer. Orca's grant lines go from the CLI to the Harness app's window and
  nowhere else (not logged).
- **Trust.** Orca's answer is outside text: the CLI parses it with bounds (an answer over 256 KiB is not read; a grant
  past the bounds above makes it `failed`, never cut) and passes on only the fields above. The window shows the grants
  as text, never markup. The fingerprint is held to its pattern twice, in the CLI and in Rust, and goes back only to
  Orca.
- **Consent.** `--approve` is given only from the Connect click, with the fingerprint of the access shown on that
  screen. Orca checks it is bound to exactly those files and that access.

## Measures

The log lines above (states and codes only). Cost: at most one `status` every 5 minutes while the menu is used, three
Orca CLI runs of about 0.3 s each; while Orca is not running, `orca status` alone.

## Testing

- **CLI** (`cli/src/devices/orcaPlugin.spec.ts`, with a fake `orca` the test writes): each `status` rule in order;
  `connect` from `approval_required` with a fingerprint, success with `--approve`, `approval_stale`, Orca's errors, a
  timeout, a bad fingerprint, `off`, an update that needs no approval and one that does, a hand install from another
  folder, `pending` through `enable`; the folder written only when it differs, and a half-done swap recovered; the
  record written only after `done` and kept by a `harness device vscode disable`; the grants' bounds. No test runs a
  real `orca`.
- **Build** (`cli/scripts/lib/*.spec`): the bundle carries the manifest with the stamped version and the non-test `src/`
  `.ts` and `.tsx` files only, and fails on a name the plugin's folder would not take.
- **Harness app** (`cargo test --lib`): the menu's rows for each `OrcaState` (`model.rs`); when `status` runs (CLI
  found, CLI version change, menu open after 5 minutes, never two at a time, the screen's connect first); the silent
  update without `--approve`; Connect runs `--approve` with the fingerprint of the last `approve` answer only; a
  fingerprint not matching the pattern is never run; the log leaves it out; the screen's phases; a closed window. With a
  fake `harness` CLI (`HARNESS_DEVICE_CLI`) that answers each JSON line.
- **Window** (`ui/`, vitest): the screen in each phase; Connect sends only `connect_orca`; no button is focused; the
  grants are shown as text.
- **End to end, by hand** (Verification): Diego installs the build and clicks Connect against his real Orca. Tests
  never run `orca plugin install` against a real Orca.

## Platforms

macOS (the Harness app and the CLI). Linux: the CLI commands work where `orca` is on `PATH`; the Harness app's Linux
build gets the same row, but Tauri sends no tray click there, so `status` runs only when the CLI is found and on a CLI
version change seen at start, never on a menu open. The Harness app ships no Linux build today
([device-app/RELEASE.md](../../device-app/RELEASE.md)). Windows: `status` is `absent`.

## Release

Ship the CLI first, then the Harness app (it needs the CLI's two commands). The PM asks Diego before either.
