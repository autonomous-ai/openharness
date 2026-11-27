# Export logs from the Harness menu-bar app

Date: 2026-11-18. Branch: `feat/device-app-export-logs`. Components: `cli/` (not `cli/src/core/`) and `device-app/`.

## Why

Getting logs from a person whose dial misbehaves is hard: today we ask them to paste a grep command. The Harness
desktop app has Help ▸ Export Logs…, which runs `harness logs export --json`; the CLI builds the zip
(`cli/src/lib/logBundle.ts`). The Harness menu-bar app (`device-app/`, `Harness Device.app`) has no such row, and the
bundle leaves out what a dial report needs most from that app: its own log, the versions of the apps the dial follows,
and the state of the dial's plugins.

Diego (2026-11-18): the same export as the desktop app, in the menu-bar app, in one click. No upload anywhere.

## Decisions (PM, 2026-11-18)

1. **One CLI command for both apps.** `harness logs export` grows; the menu-bar app runs it as the desktop app does.
   No second bundler in Rust.
2. **Emails are blanked in the bundle** (`<email>`), as the menu-bar app's own log already does. This is a step of the
   bundle only: the shared `redactSecretsInText` (also used for prompt records and search) is unchanged.
3. **One line in the menu.** While it runs the row reads `Exporting logs…`, disabled. Then Finder shows the zip, and
   a disabled line under the row reads `Saved to ~/Desktop/harness-logs-YYYYMMDD-HHMM.zip`, or
   `Export failed: <reason>`. The line stays until the next export or the app quits.
4. **No firmware command.** The dial's firmware version is already in `harness.log` (the cable's line for each dial
   greeting, its `fw`); the README says where to find it.
5. **Copy:** `Export logs` (no `…`: it acts at once, per the design doc's menu rule); `Exporting logs…` while it runs.

## What the bundle holds

Unchanged from today (`logBundle.ts`): `README.txt`; `logs/{app,cli,dial}-YYYYMMDD.log` from `~/.harness/logs` for the
last 7 days; `logs/usb-<serial>/dial-YYYYMMDD.log` within the shared 20 MB cap; the last 5 MB of
`~/.harness/cli/data/harness.log`; `sign-in-removals.log`. Name `harness-logs-YYYYMMDD-HHMM.zip`, saved to `~/Desktop`
(else the working directory), `--to <dir>` and `--days <n>` as today.

New:

- **The menu-bar app's log:** `logs/harness-device/app-YYYYMMDD.log`, the same 7-day window, read from the folder
  Tauri's `app_log_dir` gives the bundle id `ai.autonomous.harness.device`:
  - macOS: `~/Library/Logs/ai.autonomous.harness.device/`
  - Linux: `${XDG_DATA_HOME:-~/.local/share}/ai.autonomous.harness.device/logs/`
  - Windows: `%LOCALAPPDATA%\ai.autonomous.harness.device\logs\`

  Only files named `app-YYYYMMDD.log` are read from it; nothing else in that folder.
- **`status.txt`:** what four commands of this same CLI print, each under its own heading, each with a 10 s timeout,
  run at the same time: `harness status`, `harness device claude status --json`, `harness device codex status --json`,
  `harness device vscode status --json`. A command that fails or times out is one line saying so
  (`(no answer: timed out after 10 s)`, `(exit 1)`), never its stderr.
- **Versions in `README.txt`:** the CLI (today), Node, the OS (`sw_vers -productVersion` on macOS, `os.release()`
  elsewhere), and on macOS the `CFBundleShortVersionString` of each of these apps found in `/Applications` or
  `~/Applications`: Harness, Harness Device, Orca, Visual Studio Code, ChatGPT, Claude, Herdr. An app not found is not
  listed. Read with `plutil -extract CFBundleShortVersionString raw -o - <Info.plist>`, 2 s timeout each.
- **README text** says what was blanked and what is never included (below), and that the dial's firmware version is
  in `harness.log`, on the `cable:` line of each dial greeting (`fw`).

## Privacy rules

**Never included** — the bundler reads only the paths named above, so these cannot enter it; the tests prove it with
fakes placed beside the logs:

- conversation or transcript content (Claude/Codex session files, `*.jsonl`), prompts, voice audio or transcripts;
- tokens, keys, passwords, auth files (`~/.harness/cli/auth*`, `~/.claude*`, `~/.codex/auth.json`);
- the environment of any process (no `env`, no `process.env` dump; the status commands print none);
- files of the person's projects.

**Blanked in every text file of the bundle** (log, `status.txt`), in this order:

1. `redactSecretsInText` (today's rule: bearer tokens, `sk-` keys, `token=`/`password:`-style values, signed URL
   query parameters);
2. emails → `<email>`;
3. the home directory → `~` (the exact `os.homedir()` string, so `/Users/<name>/…` reads `~/…`).

The README itself is built from fixed text and versions, and goes through 2 and 3 too.

The `--json` answer keeps the absolute `path` (both apps reveal it); the menu shows it with `~`.

## The menu-bar app

- **Row.** `Export logs` (`MenuAction::ExportLogs`), after the separator, above `About`, shown while the CLI is found
  (`CliState::Found`); without a CLI there is nothing to run, so no row.
- **Click.** `Effect::ExportLogs`. On a thread of its own, the runner runs `harness logs export --json` (fixed
  arguments, 60 s deadline), reads the last stdout line as JSON and keeps `path` only when it is absolute and its file
  name matches `harness-logs-\d{8}-\d{4}\.zip`. It answers `Event::LogsExported(Result<PathBuf, ExportFailure>)`.
- **While it runs** the row is the disabled `Exporting logs…`; a second click cannot happen.
- **Done.** `Effect::Reveal(path)`: `open -R <path>` on macOS (the `open` the app already runs, fixed flag; the path is
  the CLI's answer, checked above, never the webview's). Linux opens the zip's folder. The line under the row reads
  `Saved to ~/Desktop/harness-logs-….zip` (home shown as `~`).
- **Failed.** `Export failed: <reason>`, the reason one of a fixed set, never the CLI's text: `timed out`,
  `Harness did not answer` (nonzero exit or no JSON), `no file` (path missing or not a bundle name).
- **Log.** `logs: exported` or `logs: export failed: <fixed reason>`; never the path.
- No new window screen, plugin, entitlement or permission; the window's gallery is unchanged.

Older CLI: `harness logs export --json` exists in every CLI the app installs today; an older CLI writes today's bundle
without the new parts, and the app works the same.

## Design (docs/feature-design-rules.md)

1. Growth: one zip per click, on the person's Desktop; the person deletes it. Nothing stored by the app (the result
   line is memory only). No records. [answered]
2. Concurrency: one export at a time per app (row disabled while running). Two CLIs exporting in the same minute
   write the same file name; the later overwrites the earlier, both complete. [answered]
3. Read cost: bounded as today (7 days, 20 MB device logs, 5 MB `harness.log`); the menu-bar app's logs are 7 small
   daily files (14 kept); `status.txt` four short outputs. Off every hot path: runs on click only. [answered]
4. Scale: at 10x log volume the existing caps hold the zip size; the menu-bar app's folder is pruned to 14 days by the
   app itself. [answered]
5. Compatibility: the `--json` line keeps `path`, `included`, `bytes`; the desktop app reads only `path` and
   `included`. New entries only add names to `included`. [answered]
6. Migration and rollback: none; nothing persisted. [N/A]
7. Audience: the zip stays on the person's computer; only they choose to send it. Private data guards: the privacy
   rules above, tested. [answered]
8. Identity: runs as the person, their CLI, their files; no network. [answered]
9. Failure: a failed export is one menu line with a fixed reason and one log line; a missing log or a status command
   that times out is a line in `README.txt` / `status.txt`, never a failed export. [answered]
10. Platforms: CLI part on macOS, Linux, Windows (app versions macOS only). Menu-bar app: macOS (built and tested by
    hand) and Linux (PR CI compiles and tests). [answered]

## Tests (red first)

- `cli/src/lib/logBundle.spec.ts`, on fake folders: the menu-bar app's `app-*.log` in the window is included under
  `logs/harness-device/`, an older one is not; a token and an email in a log line are blanked and the home path reads
  `~`; a transcript (`*.jsonl`), an `auth.json` and a project file placed in the logs folders are never in the zip;
  `status.txt` holds the given outputs, blanked; the README lists versions given to it and the never-included text.
- The command's collectors (status commands, app versions) behind injected runners: a timed-out command gives one
  line, never stderr; an app not installed is not listed.
- `device-app` cargo tests: the menu row's place and its three states (`model.rs`); a click gives `ExportLogs`, a
  success gives `Reveal` and the saved line, a failure the failed line, and the row is disabled while running
  (`app.rs`); the runner's parse keeps only an absolute bundle-named path and maps each failure to its fixed reason,
  with the fake CLI (`runner.rs` / a new `logs.rs`); `open -R` arguments are fixed.

## Verification

- macOS, by hand on this Mac with the debug build against a fake `HARNESS_DEVICE_CLI` and with the real installed CLI:
  click `Export logs`, see Finder show the zip on the Desktop and the `Saved to` line; unzip and check every privacy
  rule above with `grep` (no `/Users/`, no `@`-email, no `Bearer x…`). A person's check is not needed for merge.
- `npm run test:core` is not required (no core file changes); the CLI's own tests and `cargo test --lib` cover it.

## Not in this branch

Upload of the bundle; a firmware version command; changes to the desktop app (it gets the new bundle parts for free).
