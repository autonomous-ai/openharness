# The dial reaches agents in Cursor (Diego's roadmap, Đợt 3, 2026-11-18)

Roadmap row: "Cursor: status; open the window by folder, about a day". Cursor is a VS Code fork, and most of what the dial
does in VS Code (docs/plans/2026-11-17-dial-vscode-extension-design.md, -follow-design.md,
2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md) carries over by naming Cursor's app, bundle, link scheme,
CLI and extensions record. Cursor's own agent has no public way in: the dial lists it and a tap opens its folder's
window.

## Why

Cursor users see their agents on the dial's Cursor page today, but a tap only brings Cursor forward: no terminal, panel
or window is chosen, and swipe and scroll do nothing. The VS Code work already has every piece Cursor needs.

## What was found on this Mac (read-only, 2026-11-18)

- Cursor 3.20.21, built on VS Code 1.128.0. Bundle id `com.todesktop.230313mzl4w4u92` (already in `hostDetect.ts`), URL
  scheme `cursor`, data folder `~/.cursor`.
- Cursor's own CLI is inside the app: `Cursor.app/Contents/Resources/app/bin/cursor`. A `cursor` on `PATH` may instead
  be cursor-agent's shim (`~/.local/bin/cursor`), which only forwards to another `cursor` it finds on `PATH`, else
  fails unless its first word is `agent`.
- Harness's VS Code extension (0.6.69) installs into Cursor with `cursor --install-extension <vsix> --force` (tried into
  a throwaway `--user-data-dir` and `--extensions-dir`, exit 0, listed by `--list-extensions`); Cursor's preferences
  plist, `~/.cursor/extensions/extensions.json`, `argv.json`, `settings.json` and `~/Library/Application Support/Cursor`
  did not change. Cursor's record of its extensions is `~/.cursor/extensions/extensions.json`, in VS Code's format.
  Every API the extension uses is VS Code's own and older than 1.128 (`workbench.action.focusWindow` is 1.128's).
- Claude Code's extension (2.1.274) is installed in Cursor and opens a session through `registerUriHandler` at
  `/open?session=<id>`: in Cursor the link is `cursor://anthropic.claude-code/open?session=<id>`.
- Cursor's own agent: Harness already installs Cursor's hooks (`~/.cursor/hooks.json`: sessionStart,
  beforeSubmitPrompt, preToolUse, stop, sessionEnd), which carry Cursor's bundle id, so its sessions are on the Cursor
  page with their state. Its hook's `cwd` is the window's first workspace root (`hook/notify.mjs`). A deeplink
  `cursor://anysphere.cursor-deeplink/agent?id=<id>` opens an agent in Cursor's separate Agents window, but it is not
  documented and shows an error when the id is not one it knows; `/prompt` starts a new chat. Neither is used.

## Decided (PM for Diego, 2026-11-18)

1. A tap on Cursor's own agent opens Cursor's window for the agent's folder (Q1). Not its chat.
2. Harness's extension is set up in Cursor as in VS Code: once a computer, after a dial has attached here, through
   Cursor's own CLI; `harness device cursor enable|disable`; a removal by the person is respected (Q2).
3. A local real-app gate on a throwaway copy of Cursor.app with its own bundle id, user data and extensions; Cursor's
   preferences plist checked before and after; the copy's own preferences removed after (Q3).
4. cursor-agent in a terminal: tap, swipe and scroll; no page keys (Q4).
5. No change in the core; paths under `~/.harness` only through `cli/src/config/harnessHome.ts`.
6. Q3 reversed (PM, 2026-11-19): no real-app gate in this work (§7).

## What a person sees

In Cursor, once a dial has attached on this computer (Harness's extension installs itself into Cursor's default
profile):

- **Claude Code, Codex or cursor-agent in Cursor's integrated terminal:** a tap brings Cursor forward with the window
  that holds that terminal, and shows it; a swipe and rest on it while Cursor is in front shows that terminal; a scroll
  while Cursor is in front scrolls it, and moves Claude Code's fullscreen view a page per 8 lines, as in VS Code.
- **Claude Code in its own panel in Cursor:** a tap, and a rest while Cursor is in front, opens that session's tab by the
  `cursor://` link, as in VS Code.
- **Cursor's own agent (its chat, and any agent the above cannot reach):** listed with its state; a tap opens Cursor's
  window for its folder: the one already open on it comes forward, else Cursor opens one. A rest does nothing more than
  today, and no voice reaches it.

Voice is unchanged: it reaches Claude Code through Harness's Claude Code plugin and Codex through its queue, whatever
app they run in; Cursor's own agent has no such path, so the dial offers no voice for it.

## How it works

### 1. One adapter for VS Code and Cursor (`cli/src/cable/hosts/vscode.ts`)

`createVscodeAdapter` takes which editor it is from a fixed table in the file, never from a hook:

| editor | adapter id | bundle | link scheme | front app |
| --- | --- | --- | --- | --- |
| VS Code | `vscode` | `APP_BUNDLES.vscode` | `vscode` | `vscode` |
| Cursor | `cursor` | `APP_BUNDLES.cursor` | `cursor` | `cursor` |

Everything else stays as it is, read for that editor: `paneOf` takes `place.app === <its id>` and the tab's bundle check
against its own bundle; the tab's link is `<scheme>://anthropic.claude-code/open?session=<id>` sent to its bundle; a
terminal tap's `open -b` names its bundle; `inFront` is `latestFront() === <its id>`. The terminal pane is given to an
agent whose engine is `claude` or `codex`, or `cursor` with a `TERM_PROGRAM` hint (cursor-agent in a terminal; Q4), in
both editors, since cursor-agent in VS Code's terminal is the same case. Cursor's own agent sends no `TERM_PROGRAM`, so
it gets no terminal pane and costs no `ps` read (PM, plan question 1). Page keys stay Claude Code's alone (the caller asks `pageKeys` only for such an engine).

`services/devices.ts` makes two adapters on the same `vscodeStreams` pool: the extension in a Cursor window opens the
same `vscode` stream (it cannot tell the apps apart and needs not: a terminal is found by its shell's pid). The
observed source's change handler (`devices.ts`, `observed.paneOf(id, 'vscode')`) tells the pool the pids of both
adapters' terminal panes.

An agent whose terminal no window reports (the extension off) has `canFocus`, `canShow` and `canScroll` false, and each
verb goes to the agent's next pane (adapter rule 4).

### 2. Cursor's folder window (`cli/src/cable/hosts/cursorFolder.ts`, new)

A second Cursor adapter, id `cursor-folder`, after the `cursor` adapter in the devices' list:

- `paneOf`: `place.app === 'cursor'` and the place's folder (`place.cwd`, new on `Place`) is an absolute path of at most
  4096 characters with no control character. Pane id: that path. `observed.ts` `locate()` runs before `agent.cwd` is
  updated in `ingest()`, so the cwd update moves above `locate()` (else a moved session is one hook behind); the scan's
  sessions place their row's `cwd`.
- A multi-root window (`.code-workspace`) is opened by its first root, so a tap may open a second window on that folder
  instead of raising the workspace's: accepted, said in the README.
- `canFocus`: macOS, and the pane's path is an existing folder (checked at each look).
- `focus`: checks the path again, then runs `open -b com.todesktop.230313mzl4w4u92 <path>` (no shell, the path one
  argument, the devices' `open`, `RUN_TIMEOUT_MS`). `tap: 'instead'`: the `open` brings Cursor itself.
- No `canShow`/`show` (a rest never opens a window), no scroll, no type.

Any agent in Cursor whose terminal or tab cannot be reached falls to this pane: Cursor's own agent always; a terminal
agent while the extension is off.

The folder path never appears in a log line, a count or anything sent to the dial: `open` logs name the adapter alone,
as today.

### 3. Setting the extension up in Cursor (`cli/src/devices/vscodeExtension.ts`, `cli/src/cable/vscodeExtensionSetup.ts`)

`vscodeExtension.ts` takes the editor from a fixed table:

| editor | macOS app | its CLI in the app | Linux CLI on `PATH` | record | test bin |
| --- | --- | --- | --- | --- | --- |
| `vscode` | `Visual Studio Code.app` | `bin/code` | `code` | `~/.vscode/extensions/extensions.json` | `HARNESS_VSCODE_BIN` |
| `cursor` | `Cursor.app` | `bin/cursor` | `cursor`, skipping `~/.local/bin/cursor` (cursor-agent's shim) | `~/.cursor/extensions/extensions.json` | `HARNESS_CURSOR_BIN` |

`vscodeStatus`, `vscodeEnable`, `vscodeDisable` take the editor and answer one editor-neutral state
(`absent`/`off`/`on` with a version); only the command's printing puts it under the editor's key:
`{"cursor":"absent"|"off"|"on",...}` for Cursor, `{"vscode":...}` for VS Code as today. `vscodeExtensionDeps(editor,
bin?)` makes the real deps; `cli.ts` and `devices.ts` pass the editor. On Linux a `PATH` entry whose real path is
`~/.local/bin/cursor` is skipped. The `.vsix` is the same file.

The setup (`createVscodeExtensionSetup`) takes the editor and runs as two instances in the devices process, each with
its own record key, removal key and pass, by the same seven steps (VS Code spec §5). `DevicesDeps` gains
`cursorExtension` beside `vscodeExtension`, so no unit test's devices find this computer's Cursor. Records:

- `dial-setup.json` gains `cursor`: the CLI version that last set the extension up in Cursor or found it there; written
  only by the devices service through the dial setup's record, as `vscode` (`dialHomeSetup.ts` `cursor()` and
  `recordCursor`, `dialSetup.ts`, `dialSkillFiles.ts` `setupOf` and `writeSetup`'s version check).
- `dial-skill.json`'s `removed` gains `cursor`, written only by `harness device cursor enable|disable`
  (`dialSkillFiles.ts` `removedOf`, the write that keeps `removed` only when a key is set, and `writeRemoved`'s
  skills-folder exception, which `cursor` shares with `vscode`).

The tally `[device] vscode extension` counts per editor (`vscode`, `cursor`). The support bundle
(`lib/logBundleFacts.ts`) adds `device cursor status --json` beside VS Code's.

### 4. `harness device cursor` (`cli/src/deviceClaude/command.ts`)

`enable`, `disable` (in the usage text) and `status` (left out, as `vscode status`), the same as `vscode`'s for Cursor.
No `cursor link`: the extension asks `harness device vscode link` in either editor. The usage header's "VS Code" line
names Cursor too.

### 5. The extension (`plugins/harness-device-vscode/`)

No code change. Its README says it runs in Cursor too (installed there the same way, `harness device cursor disable`
to turn it off); its manifest description stays editor-neutral.

### 6. The e2e daemon

`cli/e2e/harness/daemon.ts` sets `HARNESS_CURSOR_BIN` to a missing path under its own root, as `HARNESS_VSCODE_BIN`, so
no e2e daemon on a Mac with Cursor in `/Applications` finds it; `developerState.e2e.ts` checks it as it checks VS Code's.
Every script that sets `HARNESS_VSCODE_BIN` for a local stack sets `HARNESS_CURSOR_BIN` beside it
(`scripts/remote-viewers-stack.ts`, `scripts/local-stack-peer.ts`, `scripts/remote-viewer-peer.ts`).
`cli/src/services/AGENTS.md`'s `vscode` stream paragraph says Cursor's windows use it too.

### 7. No real-app gate in this work (PM, 2026-11-19)

A throwaway Cursor (a rebranded, re-signed APFS clone of `/Applications/Cursor.app`, run under `@vscode/test-electron`
with its own `--user-data-dir`, extensions and `HOME`) did run the extension and its driver, but its crash reporting
(Crashpad and Sentry) wrote into the person's own `~/Library/Application Support/Cursor/` (`Crashpad/settings.dat`,
`sentry/session.json`, `sentry/scope_v3.json`): it follows the app's name, not the user data folder or `HOME`, and the
plist check does not see it. The gate is dropped from this branch and `npm run test:cursor` does not exist. A Cursor
gate is later work, on a VM or a machine with no person's Cursor on it. Cursor is checked here by unit tests, the e2e
and Diego's own check in the morning (Verification).

## Measures (rule 8)

The setup tally per editor (`set up`, `updated`, `failed`, `left removed`). The `open` line names `cursor` or
`cursor-folder` and the outcome, as for every adapter. The stream's counts are the pool's, shared by both editors. Never
a pid, a window id, a path or a name.

## Failure

| What fails | Who notices | What the person sees | Recovery |
| --- | --- | --- | --- |
| Extension not in Cursor (removed by the person) | `harness device cursor status` says `off` | a tap opens the agent's folder window; no swipe or scroll | `harness device cursor enable` |
| Cursor not found | status `absent` | nothing installed | the next start or attach looks again |
| The setup's `enable` fails | devices log, `failed` with a reason word | as with the extension off | tried again an hour later; or `enable` |
| The agent's folder no longer exists | `canFocus` false | a tap brings Cursor forward (the opener's `open -b`) | none needed |
| `open` fails or times out | the open line's outcome | as above | the next tap |
| Claude Code's link changes in a later release | a tap opens Cursor without the tab | as above | an update of the link |

## Design (docs/feature-design-rules.md)

1. **Growth:** two fields in files that exist: `dial-setup.json` `cursor` (a version, at most 64 characters) and
   `dial-skill.json` `removed.cursor` (true or absent). In memory: the folder of each Cursor agent, already held as
   `agent.cwd`. The windows' pool is shared: at most 8 windows across both editors.
2. **Concurrency:** the devices' single event loop. One pass at a time per editor; the two editors' passes are
   independent (different CLIs and records) and may run together. The record's one writer is the dial setup, which
   saves the whole record, so the two passes' saves go through it one at a time.
3. **Read cost:** a stat of the folder per look at a Cursor agent with no reachable terminal; one `ps` read per new
   Cursor agent with a terminal pane, as VS Code's. Cursor's own agent has no terminal pane (its hook pid may be a
   short-lived process, which `CHAIN_RETRY_MS` would read again every 5 s), so it costs no `ps` read.
4. **Scale:** unchanged limits (8 windows × 32 terminals). First warning sign: the per-minute `ps` read count.
5. **Compatibility:** an older CLI ignores `cursor` in both files and leaves the extension in Cursor as it is. An
   extension installed in Cursor by this CLI talks to an older daemon as it does from VS Code (`notRunning`).
6. **Migration and rollback:** none. An older CLI that rewrites `dial-setup.json` drops `cursor`: after rolling forward,
   an extension removed in between is installed once more, as accepted for VS Code.
7. **Audience:** nothing new leaves the computer; the folder path goes only to `open` on this computer.
8. **Identity:** everything runs as the person, on their computer, through Cursor's own CLI and macOS's `open`.
9. **Failure:** above.
10. **Platforms:** macOS: all of it. Linux: the extension is set up when Cursor's `cursor` is on `PATH`; a tap shows a
    Cursor terminal without raising; swipe and scroll do not work in Cursor on Linux (its front app is not read as
    Cursor there; accepted, PM plan question 5, said in the README and the PR); no folder window (no `open -b`). Windows: nothing (no devices listener), as VS Code's.

## Verification

- Unit tests where each behavior lives: the adapter for Cursor's terminal, tab link and front app; cursor-agent's
  terminal pane in both editors; the folder adapter (form checks, `open` arguments, missing folder, off macOS); the
  editor table in `vscodeExtension.ts` (status, enable, disable, the shim skipped on Linux); the setup's two instances
  and their records; `harness device cursor`; `Place.cwd`; the voice capability false for Cursor's own agent.
- e2e (`cli/e2e/`; not on PR CI: the touched e2e files run locally in phase 4, and one `cli-e2e.yml` run at the final
  head on the PM's go, which the merge does not wait for unless the PM says so; PM plan question 4): a Claude Code agent whose hook carries Cursor's bundle id, in a reported terminal, is shown,
  tapped and scrolled through the listener as `dialVscode.e2e.ts` does for VS Code, with the fake `open` recording
  Cursor's bundle; with no reported terminal, a tap's fake `open` records Cursor's bundle and its folder; the panel
  tab's link is `cursor://` as `dialVscodeFollow.e2e.ts` checks `vscode://`. The e2e harness's `FakeApp` gains
  `cursor`; its engines stay `claude` and `codex` (cursor-agent's terminal pane is unit-tested).
- No real-app gate (§7). Diego's morning check, in the PR body, not holding the merge, in his own Cursor once the
  extension installs itself there: Claude Code or cursor-agent in Cursor's terminal (tap, swipe, scroll, Claude Code's
  fullscreen pages); a Claude Code panel session (tap); Cursor's own agent (tap opens its folder's window); with two
  Cursor windows, a tap on a terminal agent in the one behind brings that window forward.
- Local gates: `npx tsc --noEmit -p .` and the touched Vitest files in `cli/`; the extension's Vitest. The VS Code gate
  (`npm run test:vscode`) is untouched by this branch.

## Docs changed in the same pull request

- `plugins/harness-device-vscode/README.md`: runs in Cursor; `harness device cursor disable`.
- `docs/cli.md`: one row for `harness device vscode enable|disable` and `harness device cursor enable|disable` (the
  table has `claude` and `codex` rows and none for `vscode` yet).
- `cli/src/services/AGENTS.md`: the `vscode` stream serves Cursor's windows too.
- `cli/AGENTS.md`: the devices row names Cursor (PM plan question 3).
- `docs/plans/2026-11-17-dial-vscode-extension-design.md` "Platforms": Cursor now covered, by this spec.

## Not in this work

- Opening a specific Cursor chat (no documented link) and voice into Cursor's own agent.
- A folder window for VS Code agents with no reachable terminal.
- VS Code Insiders, VSCodium, Cursor's non-default profiles, Windsurf.
- Any change in the core, the firmware, Harness Desktop or Harness Device's menu.
