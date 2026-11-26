# Needs you, right, Part 7: a Codex session's waits outside a pane reach the dial

> **For agentic workers:** REQUIRED SUB-SKILL: devcrew phase 3 implements this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** a Codex session outside Harness's panes (a terminal, the ChatGPT app, Orca) whose turn waits on the person for
a permission ask or a Plan-mode question shows that wait on the dial and rings once, as an outside Claude Code session's
permission ask does today, and a command Codex's automatic review approves by itself rings nothing.

**Architecture:** Harness Device's plugin gains a Codex manifest whose hooks (`PermissionRequest`, every tool;
`PreToolUse`, `request_user_input`) run `harness device codex asked`. That command reads the turn's own setting from the
session's rollout (its `turn_context` line: `approvals_reviewer` and `collaboration_mode.mode`, nothing else) and posts
an `asked` event to `/api/hook/observed` only when a dialog follows, through the code `harness device claude asked`
already uses. The devices' dial setup installs the plugin into each Codex home it serves with `codex plugin`, from the
local marketplace folder #4648 writes from the copy cli.js carries, and writes the trust records into that home's
`config.toml` only when the installed folder's fingerprint equals that carried copy's; each pass re-checks every home by
a stat. A Codex home whose `openharness` marketplace is the person's own gets nothing. The core, `cli/hook/notify.mjs`
and the devices' wait path do not change.

**Tech Stack:** TypeScript (Node 24), Vitest (unit and `cli/e2e`), `smol-toml`, POSIX sh and Windows PowerShell for the
hook, the real Codex CLI 0.172.0 for the hand checks.

**Spec:** [docs/plans/2026-11-26-needs-you-right-design.md](2026-11-26-needs-you-right-design.md), section "Part 7. A
Codex session's waits outside a pane reach the dial" (with "Only content this CLI carries is trusted" and "Kept trusted
between CLI updates"), and "Part 7's own data", "Platforms", "Release order", "Tests (red first)". Where the spec and the
decisions below differ, the decisions win (the orchestrator, harness-pm, 2026-11-26): the spec's "A home whose
`openharness` marketplace is the person's own from GitHub gets the trust only while its folder matches" is replaced by
decision 13 (no install there at all).

## Decisions that bind this plan (harness-pm, 2026-11-26)

1. The route is Harness Device's own plugin, never the native hook: `cli/hook/notify.mjs` does not change, and no
   fallback goes there. `core/observedHook.ts` already takes `asked` from any engine; the core's process does not change.
2. `harness device codex asked` is the code `harness device claude asked` runs, made to take either engine
   (`engine: 'codex'`). In a Harness pane its post is dropped as Claude Code's is (`cable/hosts/observed.ts` `asked`
   holds no such session).
3. It posts only when a dialog follows, read from `input.transcript_path` alone: backwards from the end, at most
   `CODEX_REVIEWER_READ_BYTES` (16 MiB), the `turn_context` line whose `payload.turn_id` is `input.turn_id`, and from it
   only `approvals_reviewer` and `collaboration_mode.mode`. Only a regular file (no link, folder or FIFO) inside the
   session's Codex home (the `CODEX_HOME` the hook runs under, else `~/.codex`; real paths compared). `PermissionRequest`
   posts when the reviewer is `user`; `PreToolUse` (`request_user_input`) when the mode is `plan`. Anything else,
   unreadable, malformed, not found or past the bound: no post, silent. No settle anywhere; `services/devices.ts` gets
   none. Missed on purpose: an escalation `auto_review` hands to the person, and a Default-mode question with Codex's
   `default_mode_request_user_input` on.
4. The line: `Bash`, the command's first line; `apply_patch`, the path on its first `*** Add File:`,
   `*** Update File:` or `*** Delete File:` line; `request_user_input`, the first question's `question`; any other tool
   (`write_stdin`, `request_permissions`, MCP names), the tool's name. Cut as Claude Code's summaries are.
5. The dial setup installs the plugin as it installs Claude Code's, in each Codex home it serves, recorded in
   `dial-setup.json`, brought current after each CLI update, held by `harness device codex disable`.
6. No new count name, no backend change. 7. macOS, Linux, Windows.
8. **Trust only what this CLI carries** (replaces the draft's option C). Trust is written only when the installed
   folder's fingerprint equals the fingerprint of the plugin this CLI build carries; when it differs, nothing is
   written, the pass logs `untrusted · differs` once for that home, and Codex asks the person itself. Harness never
   trusts files someone edited by hand (and, by decision 13, never installs from a marketplace that is not its own
   folder, so no `main` Codex fetched by itself is ever in question). Every dial setup pass re-checks each
   recorded home it serves (option A): a stat of the installed folder and of `config.toml`, the fingerprint computed
   again only when one changed, and the records written again under the write rules (only the plugin's tables, links
   followed, atomic, recheck before write, at most 3 attempts, the failure's kind alone logged) when the folder matches
   the carried copy and the records do not.
9. **The install route is #4648's** (an open pull request, not merged, by another contributor). The CLI carries the
   plugin and installs it from the local marketplace folder #4648 writes for Claude Code (`claudePluginBundle.mjs`,
   `ensurePluginFolder`, `harnessPath('claude-marketplace', …)`, `ClaudePluginSource`), one mechanism, no second one.
   The tasks independent of the install route go first and may start now; the install-route tasks wait for #4648 to
   merge and the branch to be rebased onto it (gate **G** in the task graph), and build on its helpers, never on its
   unmerged branch.
10. `MIN_CODEX = '0.172.0'`. Below it: no plugin, no hooks, no trust, nothing counted or logged, as today. Pinned in
    Tasks 10, 11 and 12.
11. Task 8 (the two Windows-sensitive specs in `.github/workflows/windows.yml` and `WINDOWS_SPECS`) stays.
12. The periodic newest-Codex workflow stays a proposal (end of this plan); nothing is built.
13. **A home whose `openharness` marketplace is the person's own gets nothing** (harness-pm, 2026-11-26; replaces the
    draft's "install, no trust, `untrusted · differs`"). The person's own is any `[marketplaces.openharness]` in that
    home's `config.toml` other than Harness's folder: `source_type = "local"` with `source` (Codex writes the canonical
    path, `core-plugins/src/marketplace_add.rs`) equal, by real path, to `harnessPath('claude-marketplace', <home>)`.
    GitHub (`plugins/harness/README.md`'s Codex line), any other git source, or another local folder (a clone) is the
    person's own. There: no folder write for Codex, no `codex plugin` call after `--version`, nothing written to its
    `config.toml`, no trust, no record; the dial setup pass logs `[device] codex plugin · codex · skipped · own
    marketplace` once per home per process and stays silent after, as today; `disable` removes nothing there (a plugin
    there is the person's own install). Pinned in Tasks 10, 11 and 13.
14. **`dial-setup.json` holds four full lists** (harness-pm, 2026-11-26). Task 5 added `codexPlugin`, a fourth list of
    up to 64 paths, to a file whose bound (`MAX_FILE_BYTES`, 256 KiB, shared with `dial-skill.json`) was sized for
    three: four full lists of 1024-byte paths with 64-character versions come to about 268 KB, and the save fails with
    `EFBIG`. The bound becomes per file: `dial-setup.json` gets `MAX_SETUP_BYTES = 320 * 1024`; `dial-skill.json`, which
    still holds three lists, keeps 256 KiB. Every list keeps its bounds (64 entries, 1024-byte paths, 64-character
    versions); capping the record's path length instead would make a long Codex home path unrecordable, so it is
    reinstalled at every pass. And `recordCodexPlugin` refuses a 65th home (false, nothing written) instead of
    answering true for a save that drops it; Task 11 installs into no 65th home. Task 15.

## Context: the spike (Codex 0.172.0, 2026-11-26), #4648, and the code read for this plan

- A Codex plugin is installed by `codex plugin marketplace add <source>` then `codex plugin add <plugin>@<marketplace>`.
  Codex prefers `.codex-plugin/plugin.json` over `.claude-plugin/plugin.json` (`DISCOVERABLE_PLUGIN_MANIFEST_PATHS`),
  and a manifest `hooks` path replaces the default `hooks/hooks.json` (`core-plugins/src/loader.rs`
  `load_plugin_hooks`), so Claude Code's `hooks/hooks.json` and its `modules` stay Claude Code's.
- **Installed folder:** `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`, where `<version>` is the
  manifest's `version`, else `local`, for a git marketplace as for a local one (`core-plugins/src/store.rs`
  `plugin_version_for_install_manifest`, `DEFAULT_PLUGIN_VERSION = "local"`). The Codex manifest carries no `version`,
  so it is `<home>/plugins/cache/openharness/harness-device/local` (`installedRoot(home)`, Task 10); an install checks
  that `codex plugin add … --json`'s `installedPath` (`cli/src/plugin_cmd.rs` `JsonPluginAddOutput`) is that folder.
- Trust: `[hooks.state."<plugin>@<marketplace>:hooks/codex.json:<label>:<group>:<handler>"]` with `trusted_hash` (the
  `reviewHash` of `engines/kit/hookReview.ts`, the matcher included for both events) and `trusted_content_hash` (the
  bundle fingerprint of the installed folder, `hooks/src/engine/plugin_fingerprint.rs`). Codex checks the fingerprint at
  every hook run and refuses the hook when it differs ("plugin contents changed; hook approval required"), so a folder
  edited after trust was written is refused by Codex itself.
- The fingerprint hashes each entry's path relative to the root as the platform's path bytes: `/` on macOS and Linux,
  `\` on Windows. The key's path is always `hooks/codex.json` (Codex replaces `\` with `/` there).
- Codex hashes the command it runs: `commandWindows` when set on Windows, else `command`; unknown fields such as
  `onFailure` are ignored and not hashed (`protocol/src/hooks.rs`, `hooks/src/engine/discovery.rs`).
- Codex runs a hook with `<shell> -lc <command>` off Windows and `powershell.exe -NoProfile -Command <command>` on
  Windows (`engines/codex/hookContract.ts` `win32Runner`), with `PLUGIN_ROOT` in its environment, and ignores a broken
  pipe on the hook's stdin.
- Codex refreshes a configured git marketplace by itself at each start and reinstalls its plugins
  (`core-plugins/src/manager.rs` `maybe_start_plugin_startup_tasks_for_config`, `ForceReinstall`). From the local
  folder that refresh changes nothing; a home with a GitHub `openharness` is the person's own, where Harness sets
  nothing up (decision 13).
- `codex plugin marketplace add <folder>` records `[marketplaces.<name>] source_type = "local"` and `source = <the
  folder's canonical path>`, and refuses a second source under a name already added ("already added from a different
  source", `core-plugins/src/marketplace_add.rs`). A git one is `source_type = "git"`, `source = <url>`.
- **#4648** (`fix/dial-claude-plugin-install`, open): cli.js carries the `openharness` marketplace
  (`cli/scripts/lib/claudePluginBundle.mjs` `readClaudePluginBundle`, defined as `__CLAUDE_PLUGIN__` by `build.mjs` and
  `build-bundle.mjs`), each plugin's `.claude-plugin/plugin.json` stamped `<CLI version>+<hash>`; it writes it to
  `harnessPath('claude-marketplace', homedir())` with `ensurePluginFolder(folder, files, executable)`
  (`devices/pluginFolder.ts`, crash-safe, executable modes) and adds that folder by its absolute path. It exports
  `carriedClaudePlugin(): ClaudePluginFiles | null`, `ClaudePluginFiles { files; executable }`,
  `ClaudePluginSource { folder; files() }`, `failureReason`; `DialSetupDeps.claudePlugin` and `DevicesDeps.claudePlugin`
  hand the source down; `DeviceDeps.claudeFiles()` and `deps.home` serve `claude enable`. A home whose `openharness` is
  already from GitHub keeps it. Its bundle carries `plugins/harness-device`'s `hooks/` folder whole but leaves out
  `.codex-plugin/` ("never Codex's and Cursor's manifests"), and marks only `hooks/asked` executable: Task 9 adds Codex's
  two files.
- A Codex home whose `openharness` marketplace is the person's own (`plugins/harness/README.md` tells Codex users to add
  it from GitHub) would install a folder holding the unstamped `.claude-plugin/plugin.json` and `test/`, which never
  matches the carried copy. Decision 13: Harness installs nothing there, writes nothing, and logs `skipped · own
  marketplace` once.
- `dial-setup.json`'s size (decision 14): today `MAX_FILE_BYTES = 256 * 1024` bounds both files' reads and writes
  (`readJson`, `writeJson` in `devices/dialSkillFiles.ts`); `recordCodexPlugin` (`cable/dialHomeSetup.ts`) adds any
  home, and `writeSetup` writes `setupOf(record)`, which keeps the first 64, so a 65th is answered true and dropped.
- The rollout's `turn_context` line is written before the turn's `PermissionRequest` and `PreToolUse` hooks run, always
  holds `approvals_reviewer` (`user` or `auto_review`) and `collaboration_mode.mode` (`default` or `plan`). It lay 4-10 KB
  from the end in short turns and 3.16 MB after 40 commands with large output; 16 MiB backwards took 28 ms on this Mac.
- Architecture: `cable/` and `devices/` may import `engines/` (`cable/hosts/lastAnswer.ts` does); no rule of
  `src/architecture.spec.ts` forbids `engines/kit/hookReview.ts` or `engines/kit/folderTrust.ts` there. Both are already
  in the core's file list, and nothing the core loads imports the new files, so `architecture.coreFiles.txt` does not
  change. The devices run in the core's process on Windows only through the inline door (`services/inline.ts`), which
  the core's walk does not follow.
- The e2e fake engine (`cli/e2e/harness/fakeEngine.mjs`) runs only the hooks in `$CODEX_HOME/hooks.json`, never a
  plugin's: the end-to-end case runs the real `harness device codex asked` the way the plugin's hook would, beside the
  harness's `CodexOutside`, as `deviceClaudeOrca.e2e.ts` runs `device claude asked` (Task 7). The fake answers
  `codex --version` with `codex-cli 0.160.0`, below `MIN_CODEX`, so no e2e daemon runs `codex plugin`.

## Global Constraints

- Plugin id `harness-device@openharness` (reuse `DIAL_PLUGIN_ID`, `devices/dialSkill.ts`); marketplace `openharness`
  (reuse `MARKETPLACE`, `devices/claudePlugin.ts`); Codex hooks file `hooks/codex.json`; trust keys
  `harness-device@openharness:hooks/codex.json:permission_request:0:0` and `…:pre_tool_use:0:0`.
- The marketplace folder is #4648's, shared with Claude Code: `harnessPath('claude-marketplace', <home>)`, written only
  through `ensurePluginFolder` from the carried `ClaudePluginFiles`. No second bundle, folder or writer.
- The carried fingerprint is computed from the carried files in memory (the stamped map cli.js holds), never from a
  folder on disk; a run from the sources (`files()` null) sets nothing up and trusts nothing.
- `CODEX_REVIEWER_READ_BYTES = 16 * 1024 * 1024`. Nothing of the rollout but the two fields is kept, logged or sent.
- The hook: timeout 5, `onFailure` continue, prints nothing, always exits 0, decides nothing.
- The line: at most 200 bytes of UTF-8 cut between characters, control characters to spaces; `tool` at most 64
  characters; `cwd` sent only within 1024 characters and with no control character (the core's bounds).
- `MIN_CODEX = '0.172.0'`; an older Codex: nothing run after `--version`, nothing counted.
- A home whose `openharness` marketplace is not Harness's folder (decision 13): nothing run after `--version`, nothing
  written, no record; `skipped · own marketplace` once per home per process; `disable` leaves it alone.
- `dial-setup.json`: at most `MAX_SETUP_BYTES` (320 KiB); `dial-skill.json`: `MAX_FILE_BYTES` (256 KiB), as today.
  `codexPlugin` holds at most `MAX_HOMES` (64) homes, and no 65th is installed into.
- The trust write touches only the plugin's own `hooks.state` tables; writes nothing unless the installed folder's
  fingerprint equals the carried one; follows a linked `config.toml` to its target; writes atomically; never defines a
  table twice; compares what it read with what is on disk just before the write and starts over when they differ, at
  most 3 attempts; a failure logs its kind alone (no path, no content).
- Unchanged: `cli/hook/notify.mjs`, `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `core/api.ts`,
  `plugins/harness-device/hooks/hooks.json`, `plugins/harness-device/hooks/asked`, the backend, the dial firmware.
- `services/devices.ts` changes only to hand the dial setup its Codex lookup; its waits, rings and counts do not change.
  So `services/devices.spec.ts` gets no Codex `asked` case (the spec lists one; the orchestrator's rule, a devices spec
  only where the devices change, wins): neither `observed.ts` `asked` nor the devices' `waiting` reads the engine, so
  it would pass before any change. Task 7 shows a Codex wait waiting and ringing once through the real devices;
  `devices.spec.ts` changes only for the setup's Codex lookup (Task 12).
- Logs and errors carry fixed words only (`src/architecture.failureLogs.spec.ts`): never a path, a command line, a
  question or a tool input.
- Platforms: macOS, Linux, Windows. Docs in English. One pull request, released after Part 6 and after #4648.
- Part 6 (`fix/needs-you-right-asks`) also edits `asked.ts`, `asked.spec.ts`, `devices.spec.ts` and the plugin's
  README. If it is on `main` when Task 3, 12 or 14 starts, start from it: `askedLine` (Task 3) then wraps Part 6's
  `oneLine` instead of the inline replace. #4648 also edits `dialSetup.ts`, `services/devices.ts`, `devices.spec.ts`,
  `command.ts`, `cli.ts`, `cli/AGENTS.md`, `docs/cli.md`, `windows.yml` and `scripts/ci-plan.py`: the tasks before G
  that touch any of these (Tasks 6 and 8) keep their edits small, and the rebase at G resolves them. The Codex code
  stays in its own files so both rebases stay small.

## Design (docs/feature-design-rules.md), for Part 7's own data

The spec's "Part 7's own data" holds these lines; the plan builds them:

1. **Growth.** `dial-setup.json` gains `codexPlugin`, one CLI version per Codex home the setup installed into, at most
   `MAX_HOMES` (64); an entry leaves when its home folder is gone. `config.toml` gains two tables per home, replaced in
   place at each install, update or changed matching fingerprint, never added again; after `disable` they stay, inert
   (Codex ignores a record with no hook), and the next install replaces them. In memory, per served home, one stamp
   and one "differs logged" or "own marketplace logged" flag (at most 64). The file's bound becomes its own,
   `MAX_SETUP_BYTES` (320 KiB), for four full lists of 64 paths of 1024 bytes (about 268 KB with the longest versions);
   `dial-skill.json` keeps 256 KiB. A home whose marketplace is the person's own adds nothing anywhere.
2. **Concurrency.** `dial-setup.json`'s one writer stays the devices process (the command only reads `codexPlugin`).
   The marketplace folder's writers are #4648's (`ensurePluginFolder`, crash-safe, both processes). `config.toml` has
   other writers (Codex, `engines/kit/hookReview.ts`, the person): compare-before-write, 3 attempts.
3. **Read cost.** A pass with every home current runs no `codex` and does two stats per home; the fingerprint (at most
   1,000 entries, 8 MiB) is computed again only when a stat changed (Task 11 pins it). The hook reads at most 16 MiB
   backwards, typically under 10 KB.
4. **Scale.** 10x homes stops at 64; each install is one local `codex plugin add`, one home at a time, a failed home
   waits an hour. The `[device] codex plugin` tally's `failed` count warns first.
5. **Compatibility.** An older CLI rewriting `dial-setup.json` drops `codexPlugin` (its `setupOf`): the next pass
   installs again, which `codex plugin add` allows. An older CLI under the installed plugin answers `device codex asked`
   with its usage and exit 1, which the hook drops: nothing rings, as today. A Codex older than `MIN_CODEX` is set
   nothing up. Claude Code reads `.claude-plugin/` and `hooks/hooks.json`, unchanged; it ignores the Codex files the
   shared folder now holds. An older CLI reading a `dial-setup.json` between 256 and 320 KiB (only near-full lists of
   near-1024-byte paths) reads no record and sets up again, as when it drops `codexPlugin`.
6. **Migration and rollback.** None. A rollback leaves the plugin and its trust in place, silent (line 5); the person
   removes it with `codex plugin remove harness-device@openharness`.
7. **Audience.** Nothing leaves the computer: the post goes to this account's daemon socket or pipe, as Claude Code's.
8. **Identity.** `codex plugin` runs as the computer's own account in its own Codex home, from a local folder; no
   Codex or ChatGPT sign-in, no git, no network.
9. **Failure.** Install, update, trust and remove failures are counted by step and kind, and retried after an hour; a
   trust write that fails, or a folder that differs from the carried copy, leaves Codex asking the person to review the
   hook (accepted); a rollout not read rings nothing.
10. **Platforms.** macOS, Linux, Windows (the hook's PowerShell form; the fingerprint with `\` paths).

## Open questions (for the main session)

The draft's question 1 (a home with the person's own marketplace) is answered by decision 13. Two cases decision 13
leaves open; the plan builds the default named in each, and Tasks 11 and 13 change if the answer differs. Neither
blocks anything before G.

1. **A home Harness set up from its folder, whose `openharness` marketplace later becomes the person's own** (they
   removed Harness's and added GitHub's). Default built: from then on it is skipped as decision 13 says (no update, no
   trust written again, `skipped · own marketplace` once), and its entry leaves `codexPlugin`, so `disable` no longer
   runs `codex plugin remove` there (the plugin there is now from the person's marketplace). The other choice: keep the
   entry, so `disable` still removes the plugin there. (Task 11.)
2. **`harness device codex enable` in a home whose marketplace is the person's own.** Default built: it writes the
   skill, sets nothing up in that home, prints nothing more and exits 0 (silent, as the pass). The other choice: one
   line, for instance `Your own openharness marketplace is kept; Harness sets no Codex plugin up there.` (Task 13.)

## Review Focus

1. **Two `turn_context` lines for one turn** (Codex writes it again after a compaction): the later one is the turn's
   setting. Pinned in Task 2 (`the later of two lines for a turn wins`).
2. **An installed folder edited by hand after trust was written:** Harness never writes trust for it again, and logs
   `untrusted · differs` once. Pinned in Tasks 4 and 11. A home that switched to the person's own marketplace is
   skipped (open question 1), pinned in Task 11.
3. **The person turned our hook off in Codex** (`enabled = false` in our `hooks.state` table): kept when trust is
   written again. Pinned in Task 4.
4. **A rollback to an older CLI under the installed plugin:** its `device codex asked` prints usage on stderr and exits
   1; the hook still prints nothing and exits 0. Pinned in Task 1 (the launcher that prints and exits 1 and 2).
5. **A Codex session in a Harness pane:** its plugin hook posts too; the observed source holds no such session and drops
   it, so no second card beside the pane's own question. Pinned in Task 7 (a session no hook listed shows nothing).

---

## Before G (may start now)

### Task 1: the plugin's Codex manifest and hook

**Effort:** high. **Depends on:** none.

**Files:**
- Create: `plugins/harness-device/.codex-plugin/plugin.json`
- Create: `plugins/harness-device/hooks/codex.json`
- Create: `plugins/harness-device/hooks/codex-asked` (mode 755)
- Test: `cli/src/harnessDevicePlugin.spec.ts`

**Interfaces:**
- Produces: the hook command line (one string, used by both blocks) that Task 4's records hash as Codex does; the
  launcher words `device codex asked`, which Task 6 implements; the two files Task 9 adds to the carried bundle.

- [ ] **Step 1: Write the failing tests** in `harnessDevicePlugin.spec.ts`, beside the Claude Code ones (helpers
  `codexHook(root)` and `CODEX_INPUT`, Codex's `PermissionRequest` input: `session_id`, `turn_id`, `transcript_path`,
  `cwd`, `hook_event_name`, `model`, `permission_mode`, `tool_name: 'Bash'`, `tool_input: { command: 'ls' }`):
  - `'the Codex manifest is named harness-device, names hooks/codex.json, has no version, and promises no answer'`:
    `.codex-plugin/plugin.json` has `name: 'harness-device'`, `hooks: './hooks/codex.json'`, no `version` key; its
    `description` matches `/waiting/i` and not `/allow|deny|approv|answers/i`.
  - `'hooks/codex.json holds one PermissionRequest hook for every tool and one PreToolUse hook for request_user_input,
    the same command, 5 s, onFailure continue, and no mod'`: keys `['PermissionRequest', 'PreToolUse']`, matchers `['*']`
    and `['request_user_input']`, each block's hooks `[{ type: 'command', command: <same string>, onFailure: 'continue',
    timeout: 5 }]`, no `modules` key.
  - `posix.each(SHELLS)('the Codex hook runs hooks/codex-asked under %s, from a folder named with a space, a quote and a
    dollar sign')`: copy the plugin to `<tmp>/Harness "Device" $x`, run `<shell> -c <command>` with `PLUGIN_ROOT` set to
    that folder in the environment (Codex's own variable, not a text replace), a fake `~/.local/bin/harness` that prints
    the Claude allow JSON on stdout and exits 2: its argv file is `device\ncodex\nasked\n`, its stdin file is the input
    byte for byte, and the result is `{ status: 0, stdout: '', stderr: '' }`.
  - `'the Codex hook drops a launcher that prints its usage on stderr and exits 1 (an older CLI)'`: status 0, no output.
  - `'with no launcher, the Codex hook prints nothing and exits 0'`.
  - `'the Codex Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs device
    codex asked, and exits 0'`: as the Claude form's test, with `device codex asked *> $null` once, `; exit 0` last, and
    no `HARNESS_DEVICE_MOD_ASKS` (Codex has no mod).
  - In `describe.runIf(win32)`, a PowerShell runner as Codex runs it (`powershell.exe -NoProfile -Command <command>`,
    `PLUGIN_ROOT` in the environment): `'runs the profile's launcher with device codex asked and its stdin, prints
    nothing and exits 0'` for launcher exits 0 and 2 (argv `['codex', 'asked']`), and `'with no launcher, prints nothing
    and exits 0'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts`. Expected:
  FAIL, `ENOENT` on `.codex-plugin/plugin.json` and `hooks/codex.json`.
- [ ] **Step 3: Write the files.**
  - `plugin.json`: `name`, `description` ("Shows Codex's waiting permission asks and questions on the Harness round
    dial. Uses the Harness CLI."), `author`, `homepage`, `repository`, `license` as `.claude-plugin/plugin.json`,
    `"hooks": "./hooks/codex.json"`, and `interface` as `plugins/harness/.codex-plugin/plugin.json` has it
    (`displayName: "Harness Device"`). No `version`: Codex installs it as `local`.
  - `codex.json`'s command: the Claude form's two-shell line with `exec "$PLUGIN_ROOT/hooks/codex-asked"` as its POSIX
    first line (the shell's own expansion of Codex's variable, so a folder name with a quote or `$` cannot break the
    line) and, after `#>`, the same PowerShell lookup without the `HARNESS_DEVICE_MOD_ASKS` check, ending
    `if ($h) { & $h device codex asked *> $null }; exit 0`.
  - `codex-asked`: `hooks/asked` without the mod branch, running `device codex asked`, output dropped, `exit 0`; its
    comment says why (Codex reads stdout as a decision and exit 2 as a block; Codex runs it with `-lc`; Windows takes the
    PowerShell form).
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS (the win32 block skips off Windows).
- [ ] **Step 5: Commit.** Red, then code.

### Task 2: the turn's setting, read from the rollout

**Effort:** xhigh (reads a file a hook names: links, FIFOs, paths outside the home, a bound). **Depends on:** none.

**Files:**
- Create: `cli/src/deviceClaude/codexTurn.ts`
- Create: `cli/src/deviceClaude/__fixtures__/codex-turn-context.jsonl` (the spike's
  `spike-records/turn_context_lines.jsonl`, copied as is: six real lines from Codex 0.172.0, paths already
  `/home/person`)
- Test: `cli/src/deviceClaude/codexTurn.spec.ts`

**Interfaces:**
- Produces: `export const CODEX_REVIEWER_READ_BYTES = 16 * 1024 * 1024`;
  `export interface TurnSetting { reviewer: string | null; mode: string | null }`;
  `export function readTurnSetting(transcriptPath: string, turnId: string, codexHome: string): TurnSetting | null`
  (null: not found within the bound, or a file it may not read; never throws).

- [ ] **Step 1: Write the failing tests.** Each builds `<tmp>/codex` as the home and a rollout under
  `sessions/2026/11/26/` holding a `session_meta` line, filler `response_item` lines and fixture lines (split the
  fixture on `/\r?\n/`). Line 6 is turn `01a21862-356c-7481-bf3a-ea92e3fd707a` (`user`, `default`); line 2 is turn
  `01a21860-3b56-7292-b32b-e04f386c56d4` (`auto_review`); `plan` is line 6 with `collaboration_mode.mode` set to `"plan"`
  (no real plan-mode line was recorded).
  - `'user'`: line 6's turn → `toStrictEqual({ reviewer: 'user', mode: 'default' })`; `'auto_review'`: line 2's →
    `{ reviewer: 'auto_review', mode: 'default' }`; `'plan'` → `{ reviewer: 'user', mode: 'plan' }`.
  - `'no turn_context at all'` → null; `'only another turn's turn_context'` (line 2 alone, asked for line 6's turn) → null.
  - `'the later of two lines for a turn wins'`: line 6, filler, line 6 with `approvals_reviewer: 'auto_review'` →
    `auto_review`.
  - `'a line across a 64 KiB chunk edge'` (filler sized so the line starts 100 bytes before the edge counted from the
    end) and `'the last line without its newline'` → found.
  - `'malformed'`: a file of non-JSON text → null; the matching line cut short (a write in progress) → null; a
    `approvals_reviewer` that is a number → `{ reviewer: null, mode: 'default' }`; a line holding the text
    `"type":"turn_context"` inside a tool output string → not taken for one.
  - `'the bound'`: filler after the line so the line starts exactly `CODEX_REVIEWER_READ_BYTES` from the end → found;
    one byte further → null.
  - `'what it may read'`, each → null: a missing file; a relative path; a link to a valid rollout inside the home
    (skip on win32); a folder at the path; a FIFO at the path, and the call returns at once (skip on win32; `mkfifo`); a
    valid rollout in another folder; a path inside the home through `..` that leaves it. And found: a home given through
    a link whose target holds the rollout (real paths compared; skip on win32).
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/codexTurn.spec.ts`. Expected:
  FAIL, module not found.
- [ ] **Step 3: Implement `readTurnSetting`.** `lstat` must say a regular file; `relative(realpath(codexHome),
  realpath(transcriptPath))` must not leave the home; open read-only with `O_NOFOLLOW | O_NONBLOCK` where the platform
  has them (as `cable/hosts/claudeAppStore.ts` `textOf`), then `fstat` again (a regular file, the same inode as the
  `lstat`). Read backwards in 64 KiB chunks, carrying the partial head, never past `size - CODEX_REVIEWER_READ_BYTES`, and
  drop the window's first partial line unless it starts at 0. Only a line whose bytes contain `"type":"turn_context"` is
  parsed; it counts when `record.type === 'turn_context'` and `record.payload.turn_id === turnId`. Return only the two
  fields (a string, else null). Every failure returns null; nothing is logged.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 3: `harness device codex asked`'s body: the gate and the line

**Effort:** high. **Depends on:** Task 2.

**Files:**
- Modify: `cli/src/deviceClaude/asked.ts` (`AskedBody.engine`, the stdin read and the exit-0 wrapper shared, the cut
  exported)
- Create: `cli/src/deviceClaude/codexAsked.ts`
- Test: `cli/src/deviceClaude/codexAsked.spec.ts` (`asked.spec.ts` must pass unchanged)

**Interfaces:**
- Consumes: Task 2's `readTurnSetting`; the fixture file.
- Produces, in `asked.ts`: `AskedBody.engine: 'claude' | 'codex'`;
  `export async function tellAsked(stdin: AsyncIterable<Buffer | string>, post: (body: AskedBody) => Promise<void>,
  body: (input: Record<string, unknown>) => AskedBody | null): Promise<0>` (reads at most 256 KiB, parses, builds,
  posts once, always 0); `export function askedLine(shown: string, tool: string): string` (today's last line of
  `askedSummary`: control characters to spaces, the tool's name when blank, cut to 200 bytes); `export function
  cwdField(cwd: unknown): { cwd?: string }`; `export const MAX_TOOL_CHARS = 64`. `runAsked` keeps its signature and
  becomes `tellAsked(deps.stdin, deps.post, claudeBody)`.
- Produces, in `codexAsked.ts`: `export function codexAskedSummary(tool: string, input: unknown): string`;
  `export function codexAskedBody(input: Record<string, unknown>, codexHome: string): AskedBody | null`;
  `export function runCodexAsked(deps: { stdin: AsyncIterable<Buffer | string>; post(body: AskedBody): Promise<void>;
  codexHome: string }): Promise<0>`. Task 6 calls `runCodexAsked`.

- [ ] **Step 1: Write the failing tests** in `codexAsked.spec.ts`, with Codex's hook input (the spike's keys:
  `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `tool_name`,
  `tool_input`, and `tool_use_id` for `PreToolUse`) and a temp home whose rollout holds the fixture lines:
  - `codexAskedSummary`, `it.each`: `['Bash', { command: 'touch /tmp/probe' }, 'touch /tmp/probe']`;
    `['Bash', { command: '\ncd repo\nnpm test' }, 'cd repo …']`; `['apply_patch', { command: '*** Begin Patch\n*** Update
    File: src/app.ts\n@@\n-old\n+new\n*** End Patch' }, 'src/app.ts']`; the same with `Add File: a.ts` then `Delete File:
    b.ts` → `'a.ts'`; a patch with no file line → `'apply_patch'`; `['request_user_input', { questions: [{ id: 'q1',
    header: 'Probe', question: 'Which color?', options: [] }] }, 'Which color?']`; `questions: []` → `'request_user_input'`;
    `write_stdin`, `request_permissions` and `mcp__github__create_issue` → their own names, whole.
  - Bounds: `'日'.repeat(100)` as a question → `'日'.repeat(66)`; a tab and a newline in a path → spaces.
  - `runCodexAsked` posts, for a `PermissionRequest` of line 6's turn (`user`): exactly
    `{ engine: 'codex', sessionId, event: 'asked', tool: 'Bash', summary: 'touch /tmp/probe', cwd: '/repo' }`.
  - Posts nothing for: line 2's turn (`auto_review`); a turn with no `turn_context`; a `transcript_path` outside the
    home; `PreToolUse` `request_user_input` in `default`; `PreToolUse` for any other tool in `plan`; another
    `hook_event_name` (`Stop`); input that is not JSON, an array, or missing or non-string `session_id`, `turn_id`,
    `transcript_path` or `tool_name`; 256 KiB + 1 of stdin.
  - Posts `{ …, tool: 'request_user_input', summary: 'Which color?' }` for `PreToolUse` in `plan`.
  - `'nothing else of the input leaves'`: a Bash `description`, the patch's content lines and a question's options
    holding `sk-live-0123456789` are absent from `JSON.stringify(bodies)`.
  - `'the core takes every body it sends, at each bound'`: a 70-character MCP name, a 1023-character cwd, a 300-byte
    question; each `parseObservedHook(body)` equals the body.
  - `'always exits 0'`: a post that throws, stdin that fails.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/codexAsked.spec.ts`.
  Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** In `asked.ts`, move the stdin read and the try/catch into `tellAsked` and the line cut into
  `askedLine`, with no change to Claude Code's behavior. In `codexAsked.ts`: `Bash` takes `askedSummary('Bash', input)`
  (the same tool and input shape as Claude Code's); the rest as decision 4, each through `askedLine`. `codexAskedBody`
  checks the strings, then the event: `PermissionRequest` needs `readTurnSetting(...)?.reviewer === 'user'`;
  `PreToolUse` needs `tool_name === 'request_user_input'` and `mode === 'plan'`; nothing else posts. The file's header
  comment says what leaves the process (six fields) and why the rollout is read (no input field says a dialog follows;
  the hook runs before Codex's automatic review).
- [ ] **Step 4: Run them and see them pass.** `cd cli && npx vitest run src/deviceClaude/codexAsked.spec.ts
  src/deviceClaude/asked.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 4: the trust records, written into a Codex home's `config.toml` only for a matching folder

**Effort:** xhigh (another program's config, other writers, a trust decision). **Depends on:** none.

**Files:**
- Create: `cli/src/devices/codexPluginTrust.ts`
- Test: `cli/src/devices/codexPluginTrust.spec.ts`

**Interfaces:**
- Consumes: `reviewHash` and `withReviewRecords` (`engines/kit/hookReview.ts`), `hooks.settings.reviewed`
  (`engines/codex/hookContract.ts`), `replaceConfigFile` (`engines/kit/folderTrust.ts`), `settingsText`
  (`lib/settingsText.ts`), `DIAL_PLUGIN_ID`.
- Produces: `export const CODEX_HOOKS_FILE = 'hooks/codex.json'`;
  `export function pluginContentHash(root: string): string` (`sha256:<hex>` of a folder on disk; throws on a link or
  other entry, or past 1,000 entries or 8 MiB);
  `export function filesContentHash(files: Readonly<Record<string, string>>, platform: NodeJS.Platform): string` (the
  same fingerprint of a map of `/`-separated relative paths to UTF-8 text, as Codex would compute it for a folder
  holding exactly those files on that platform; Task 10 hands it the carried copy);
  `export interface PluginTrustRecord { key: string; trustedHash: string; contentHash: string }`;
  `export function pluginTrustRecords(root: string): PluginTrustRecord[]` (throws when the hooks file cannot be read
  or parsed);
  `export function readConfigText(file: string): string | null` (null: missing; throws: over 1 MiB, unreadable, not
  UTF-8);
  `export type TrustFailure = 'plugin' | 'differs' | 'missing' | 'unreadable' | 'unparsed' | 'unsafe' | 'changed' |
  'write'`;
  `export type TrustWrite = { ok: true; changed: boolean } | { ok: false; kind: TrustFailure }`;
  `export function writePluginTrust(codexHome: string, root: string, expected: string, io?: { read(file: string):
  string | null; replace(file: string, text: string): void }): TrustWrite` (io defaults to `readConfigText` and
  `replaceConfigFile`; `differs`: `pluginContentHash(root) !== expected`, checked before `config.toml` is read).

- [ ] **Step 1: Write the failing tests.** A helper writes the fixture plugin tree into a temp folder, byte for byte:
  `.codex-plugin/plugin.json` = `{"name":"harness-device","hooks":"./hooks/codex.json"}\n`; `hooks/codex.json` =
  `{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"command","command":"fixture permission","onFailure":"continue","timeout":5}]}],"PreToolUse":[{"matcher":"request_user_input","hooks":[{"type":"command","command":"fixture question","onFailure":"continue","timeout":5}]}]}}\n`;
  `hooks/codex-asked` = `#!/bin/sh\nexit 0\n`; `README.md` = `fixture\n`; `__pycache__/x.pyc` = `skipped\n`. The expected
  values below are the spike's `hashes.mjs` output for this tree (the script whose output matched Codex 0.172.0's
  `hooks/list` exactly); record them in the spec with that note. `FIXTURE` is the same tree as a map, without
  `__pycache__`.
  - `'the bundle fingerprint is Codex's'`: `pluginContentHash(tree)` is
    `sha256:5ed6c10e8c100df9d1eb4dbf5f45ad3ca00d51081931bb40538445ee64a32a05`, on Windows
    `sha256:f79e1bc6746ed69553226de4909e79404417b3cc5f1e13edc3f394b97300ecf2` (paths with `\`).
  - `'the fingerprint of the files in memory is the folder's'`: `filesContentHash(FIXTURE, 'darwin')` and `'linux'` are
    the first value, `'win32'` the second, on any host.
  - `'it skips __pycache__, .venv, *.pyc and *.egg-info, and changes with any other byte'`: adding `__pycache__/y.pyc` or
    `.venv/z` leaves it; a changed `README.md` changes it.
  - `'a link in the tree is refused'` (skip on win32): throws.
  - `'the records are Codex's'`: `pluginTrustRecords(tree)` equals
    `[{ key: 'harness-device@openharness:hooks/codex.json:permission_request:0:0', trustedHash:
    'sha256:617e7ac70aedcde8a745bdaa988454f2c32389d38f063bfa30d91619a5cdd359', contentHash: <the fingerprint> },
    { key: '…:pre_tool_use:0:0', trustedHash: 'sha256:6eb05987d4cd76c5a8db8417b05c315f7fd0e7ad5de4668803d7542134829c2d',
    contentHash: <the fingerprint> }]`.
  - `'a folder that differs from the expected fingerprint is never trusted'`: the tree with one byte of `README.md`
    changed (as by hand), and the tree with a `test/` file added (as a GitHub `main`), each with `expected` the
    fixture's fingerprint → `{ ok: false, kind: 'differs' }`, `io.read` and `io.replace` never called, `config.toml`
    byte-identical; and a `config.toml` already holding trust for the old fingerprint keeps it as it was.
  - `'only the plugin's tables change'`: a `config.toml` with a model, a `[projects."…"]` table, a `[hooks.state."…"]`
    record of Harness's native hooks and the person's comments: after the write, the text before the new tables is
    byte-identical, each key has one header with `trusted_hash` and `trusted_content_hash`, and `smol-toml` parses it.
  - `'written again after an update'`: old values in place → replaced in place, no second header for a key; a second
    write with nothing changed → `{ ok: true, changed: false }`, the file untouched (same mtime).
  - `'the person's enabled = false in our table is kept'`.
  - `'a linked config.toml is written at its target and stays a link'` (skip on win32).
  - `'a file changed mid-way is read again and redone, and the other writer's change survives'`: an `io.read` that
    returns the file plus `model = "other"` from its second call on: the result holds that line and both tables;
    `{ ok: true, changed: true }`.
  - `'a file changed at every attempt: 3 attempts, then changed, nothing written'`: `io.read` returns a new text each
    call; `io.replace` never called; `{ ok: false, kind: 'changed' }`; 6 reads.
  - Each failure leaves the file as it was: no `config.toml` → `missing`; not TOML → `unparsed`; `hooks.state` as an
    inline table → `unsafe`; a tree without `hooks/codex.json` → `plugin`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/codexPluginTrust.spec.ts`.
  Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** The fingerprint walk is the spike's (`hashes.mjs`): `codex-plugin-bundle-v1`, depth first,
  entries sorted by their names' UTF-8 bytes, each entry the u64-LE length of its relative path (`path.relative`, the
  platform's separator) and the path, then `directory`, or `file`, its u64-LE size and its bytes.
  `filesContentHash` builds the same entry list from the map (each folder a path names is a `directory` entry; sizes
  are UTF-8 byte lengths; the separator `\` for `win32`, else `/`), so both functions share one hasher over entries.
  The records: each command handler of each event of `hooks/codex.json` that `reviewed.events` names, hashed by
  `reviewHash` with `{ ...reviewed, matcherEvents: ['PermissionRequest', 'PreToolUse'] }` (a plugin's
  `PermissionRequest` matcher is hashed, unlike the native one). The write: the fingerprint first (differs: stop);
  read; parse; `withReviewRecords` with `reviewed` for `trusted_hash`, then with `{ ...reviewed, key:
  'trusted_content_hash' }` on its result; `'unsafe'` from either fails; both `'unchanged'` is done; parse the result;
  read again and compare with the first read (differs: next attempt); replace.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 5: the record: `codexPlugin` in `dial-setup.json`, and the Codex homes the setup serves

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts` (`DialSetupRecord`, `setupOf`, `writeSetup`)
- Modify: `cli/src/cable/dialHomeSetup.ts` (`DialHomeSetup`)
- Test: `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/cable/dialHomeSetup.spec.ts`

**Interfaces:**
- Produces: `DialSetupRecord.codexPlugin?: Record<string, string>` (a home's real path → the CLI version that last set
  the plugin up there; omitted when empty); on `DialHomeSetup`: `codexHomes(): readonly string[]` (the Codex homes its
  last pass handled while Codex was on: the default, the adopted and Orca's, and each a scan found; empty while Codex
  is removed), `codexPlugin(): Readonly<Record<string, string>>`, `recordCodexPlugin(home: string, version: string |
  null): boolean` (null removes the entry; false when not saved, the record as before).

- [ ] **Step 1: Write the failing tests.**
  - `dialSkillFiles.spec.ts`: `'codexPlugin round-trips'`; `'a codexPlugin entry with a path a list may not hold or a
    version that is not one is dropped'`; `'at most 64 entries are kept'`; `'writeSetup refuses a codexPlugin version that
    is not one (EINVAL)'`; `'a record without codexPlugin reads and writes as before'`.
  - `dialHomeSetup.spec.ts`: `'codexHomes lists the default, adopted and scanned Codex homes handled while Codex is on'`;
    `'codexHomes is empty once Codex is removed'`; `'recordCodexPlugin saves the whole record, and a new setup reads it
    back'`; `'recordCodexPlugin(home, null) removes the entry'`; `'a record that could not be saved leaves codexPlugin as
    it was'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts
  src/cable/dialHomeSetup.spec.ts`. Expected: FAIL (no such field or methods).
- [ ] **Step 3: Implement.** `setupOf` keeps entries whose key passes `listable` and whose value passes `VERSION`, first
  64. `codexHomes()` is `handled.codex` as a list.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 6: `harness device codex asked`

**Effort:** high. **Depends on:** Task 3.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts` (`codexCommand`'s `asked` branch, the header comment)
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Consumes: Task 3's `runCodexAsked`; `daemonPost`; `readRemoved`.
- Produces: `harness device codex asked` reads stdin, posts through `runCodexAsked` with `deps.codexHome` unless
  `readRemoved(dataDir).codex` (then nothing), prints nothing, exits 0. It stays out of `DEVICE_USAGE` (as `claude
  asked`). Enable and disable are unchanged here (Task 13).

- [ ] **Step 1: Write the failing tests** (the spec's own throwaway homes and socket daemon):
  - `'codex asked tells the daemon of a user-reviewed escalation, prints nothing and exits 0'`: a rollout in the
    command's Codex home with line 6; the daemon hears exactly `{ engine: 'codex', …, tool: 'Bash', summary:
    'touch /tmp/probe' }`; `{ code: 0, out: [], err: [] }`.
  - `'codex asked after codex disable tells the daemon nothing, and after enable tells it again'` (today's enable and
    disable, which mark the removal).
  - `'codex asked with an auto_review turn tells the daemon nothing and exits 0'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected:
  FAIL (`codex asked` prints the usage and exits 1).
- [ ] **Step 3: Implement** the branch, as `claude asked`'s.
- [ ] **Step 4: Run them and see them pass.** `cd cli && npx vitest run src/deviceClaude/command.spec.ts && npm run
  typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 7: end to end: a Codex wait outside a pane on the dial

**Effort:** high. **Depends on:** Task 6.

**Files:**
- Create: `cli/e2e/deviceCodexAsked.e2e.ts` (no change to `cli/e2e/harness/`: its files select the canary and the app
  eval's six on PR CI)

**Interfaces:**
- Consumes: `CodexOutside` (its `transcriptPath`, `sessionId`, `env`, `hook`), `IsolatedDaemon`, `Desk`, `FakeBackend`;
  the fixture of Task 2; the real CLI as `inOrca.ts` `asked` runs it (`E2E_BUNDLE_PATH`, else `--import tsx src/cli.ts`).

- [ ] **Step 1: Write the test.** `fresh()` as `deviceCodex.e2e.ts`'s. A local helper `asked(codex, turn, event,
  tool, toolInput)` appends the fixture's line 6 with a new `turn_id` and the given `approvals_reviewer` and
  `collaboration_mode.mode` to `codex.transcriptPath`, then runs `device codex asked` under `codex.env` with Codex's
  hook input on stdin, and returns `{ stdout, stderr, code }`. A `CodexOutside` with the Ghostty hint, its `SessionStart`
  and `UserPromptSubmit` hooks run, listed on the dial.
  - `'a user-reviewed escalation shows "touch /tmp/probe · answer in Ghostty", asks once, and its Stop ends the wait'`:
    each run `{ stdout: '', stderr: '', code: 0 }`; one `question` for the agent; one `[observed] waiting prompt · shown`.
  - `'an auto_review escalation shows nothing'`: run it, then a user-reviewed one with another command; only the second
    line reaches the dial, and the log says `shown` once.
  - `'a question in Plan mode shows its first question and asks once; in Default mode nothing'` (the Default one first,
    the Plan one as the anchor).
  - `'a session no hook listed (one in a Harness pane) shows nothing'`, anchored the same way.
- [ ] **Step 2: Run it.** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceCodexAsked.e2e.ts`.
  Expected: PASS on top of Task 6. (Its red is Task 6's: before it, `device codex asked` exits 1 with the usage.)
- [ ] **Step 3: Commit.** One commit.

### Task 8: the Windows specs run on Windows

**Effort:** medium. **Depends on:** Tasks 2 and 4.

**Files:**
- Modify: `.github/workflows/windows.yml` (its `$paths` list)
- Modify: `scripts/ci-plan.py` (`WINDOWS_SPECS`)

- [ ] **Step 1:** Add `src/deviceClaude/codexTurn.spec.ts` and `src/devices/codexPluginTrust.spec.ts` to `windows.yml`'s
  list, and `cli/src/deviceClaude/codexTurn.spec.ts` and `cli/src/devices/codexPluginTrust.spec.ts` to `WINDOWS_SPECS`.
- [ ] **Step 2:** `python3 -m unittest scripts/tests/test_ci_plan.py`. Expected: PASS (the two lists match).
- [ ] **Step 3: Commit.** One commit; no failing test of its own (CI selection).

### Task 15: `dial-setup.json` holds four full lists, and no 65th Codex home is recorded

Added after Tasks 1-8 landed (decision 14); numbered last so the done tasks keep their numbers. It may start now.

**Effort:** high. **Depends on:** none (Task 5 is on the branch).

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts` (`MAX_SETUP_BYTES`, `readJson` and `writeJson` given the file's bound,
  `readSetup`, `writeSetup`, the bound's comment)
- Modify: `cli/src/cable/dialHomeSetup.ts` (`recordCodexPlugin`, its doc comment on `DialHomeSetup`)
- Test: `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/cable/dialHomeSetup.spec.ts`

**Interfaces:**
- Produces: `export const MAX_SETUP_BYTES = 320 * 1024` (dial-setup.json's read and write bound; `MAX_FILE_BYTES`
  stays 256 KiB for dial-skill.json); `recordCodexPlugin(home, version)` returns false and writes nothing when `home`
  is not in the record, `version` is not null and the record already holds `MAX_HOMES` homes. Task 11 relies on that
  false.

- [ ] **Step 1: Write the failing tests.**
  - `dialSkillFiles.spec.ts`: `'four full lists of the longest paths, with the longest versions, are written and read
    back from dial-setup.json'`: `full(list)` as the three-lists test's (1024-byte listable paths), `homes.claude`,
    `homes.codex`, `pluginHomes` and `codexPlugin`'s keys four distinct full lists, every version field (`plugin`,
    `vscode`, `cursor`, `orca`, `orcaHeld`) and every `codexPlugin` value `'0.'.padEnd(64, '9')`: `writeSetup` is
    `undefined` (today `'EFBIG'`), `readSetup` equals the record, and the file is over 256 KiB.
  - `dialSkillFiles.spec.ts`: `'dial-skill.json keeps its 256 KiB bound'`: a dial-skill.json padded to 256 KiB + 1
    reads as `readPluginHomes` `{ homes: [] }` (passes today; it pins that only dial-setup.json's bound moved).
  - `dialHomeSetup.spec.ts`: `'recordCodexPlugin refuses a 65th home: false, the record and the file as before'`: 64
    homes recorded, a 65th → false, `codexPlugin()` and `dial-setup.json`'s bytes unchanged; a recorded home's version
    still changes to another (true), and after one entry is removed (null) the 65th is recorded (true). Red today: the
    65th answers true.
  - Existing tests that pin 256 KiB for dial-setup.json move to `MAX_SETUP_BYTES`: `'a file at 256 KiB still reads'`
    (now at 320 KiB, and 320 KiB + 1 reads as no record), `'a missing, damaged or oversized dial-setup.json'` (padded
    past 320 KiB), `'a record past what a read takes is not written'` (three lists of the escaped paths, `pluginHomes`
    the third, so it outgrows 320 KiB and is still `EFBIG`), and `'a file past the bound reads as today'` (dial-setup.json's
    torn text past 320 KiB, dial-skill.json's past 256 KiB). `'three full lists … each file holds three'` is renamed
    `'… dial-skill.json holds three'`, unchanged otherwise.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts
  src/cable/dialHomeSetup.spec.ts`. Expected: FAIL: `'EFBIG'` where `undefined` is expected, and the 65th home answers
  true.
- [ ] **Step 3: Implement.** `writeJson(file, value, max)` and `readJson(file, max)` take the bound from their caller:
  dial-skill.json's readers and `rewriteSetting` pass `MAX_FILE_BYTES`, `readSetup` and `writeSetup` pass
  `MAX_SETUP_BYTES`. The comments say why: dial-skill.json holds three lists; dial-setup.json four (about 268 KB at
  their longest), and paths JSON escapes can outgrow either, which is then not written. In `recordCodexPlugin`, the
  full check before the write, comment: a save would drop the 65th, so the home would read as never set up.
- [ ] **Step 4: Run them and see them pass.** Same command, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

## Gate G: #4648 merged, the branch rebased onto `main`

Not a task. When #4648 is on `main`, the main session rebases this branch onto it (an implementer's rebase: Tasks 6 and
8's files and any of Tasks 1-8 already done; Part 6 too if it landed) and reruns the affected specs. Tasks 9 to 14 start
only after G and use #4648's helpers as merged; none starts from #4648's branch. If #4648 changes before it merges,
Tasks 9 to 14 follow the merged names (the Interfaces below name #4648's as of 2026-11-26).

## After G (blocked on #4648 merge)

### Task 9: the carried copy holds Codex's files

**Effort:** medium. **Depends on:** G, Task 1.

**Files:**
- Modify: `cli/scripts/lib/claudePluginBundle.mjs` (`PLUGINS['plugins/harness-device']`, `EXECUTABLE`, the comment that
  says no Codex manifest)
- Test: `cli/src/devices/claudePluginBundle.spec.ts`

**Interfaces:**
- Produces: `carriedClaudePlugin().files` holds `plugins/harness-device/.codex-plugin/plugin.json` byte for byte as in
  the repository (no version stamped: Codex installs it as `local`), and `hooks/codex.json` and `hooks/codex-asked` (the
  `hooks/` folder is carried whole already); `executable` holds `plugins/harness-device/hooks/codex-asked`.

- [ ] **Step 1: Write the failing tests** beside #4648's: `'the device plugin carries Codex's manifest unchanged and its
  hook executable'` with a test root holding the three files (the manifest's text equal, no `version` key;
  `executable` includes the hook); and `'the repository's bundle carries the Codex manifest'` on the real root.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/claudePluginBundle.spec.ts`.
  Expected: FAIL (no `.codex-plugin/plugin.json` key; `codex-asked` not executable).
- [ ] **Step 3: Implement.** Add `'.codex-plugin/plugin.json'` to the device plugin's list and the hook to `EXECUTABLE`;
  the comment says Claude Code ignores Codex's manifest and the folder serves both engines.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 10: the Codex plugin through `codex plugin`, from the local marketplace folder

**Effort:** high. **Depends on:** G, Task 4.

**Files:**
- Create: `cli/src/devices/codexPlugin.ts`
- Test: `cli/src/devices/codexPlugin.spec.ts`

**Interfaces:**
- Consumes: `claudeRunner`, `ClaudeRun`, `ClaudePluginFiles`, `failureReason`, `MARKETPLACE` (`devices/claudePlugin.ts`,
  #4648); `ensurePluginFolder` (`devices/pluginFolder.ts`, #4648); `DIAL_PLUGIN_ID`; Task 4's `writePluginTrust`,
  `filesContentHash`, `readConfigText`.
- Produces: `export const MIN_CODEX = '0.172.0'`;
  `export type CodexStep = 'unsupported' | 'launcher' | 'config' | 'folder' | 'marketplace' | 'install' | 'trust' |
  'remove'`;
  `export type CodexFailure = { ok: false; step: CodexStep; error: string; reason?: string }`;
  `export type CodexSetup = { ok: true; outcome: 'installed' | 'updated' | 'absent' | 'own'; trusted: boolean } |
  CodexFailure` (`own`: the home's `openharness` marketplace is the person's own, nothing done, `trusted: false`);
  `export function codexMarketplace(home: string, folder: string): 'harness' | 'own' | 'none' | 'unknown'` (from one
  parse of `<home>/config.toml`: `none` when it holds no `[marketplaces.openharness]` or is missing; `harness` when that
  table's `source_type` is `"local"` and its `source`'s real path equals `folder`'s; `own` for any other table;
  `unknown` when the file cannot be read or parsed; Tasks 11 and 13 call it);
  `export type CodexResult = { ok: true } | CodexFailure`;
  `export interface CodexPluginDeps { run: ClaudeRun | null; home: string; platform: NodeJS.Platform }`;
  `export interface CodexInstallDeps extends CodexPluginDeps { folder: string; files: ClaudePluginFiles }`;
  `export function installedRoot(home: string): string` (`<home>/plugins/cache/openharness/harness-device/local`);
  `export function carriedCodexHash(files: ClaudePluginFiles, platform: NodeJS.Platform): string` (the fingerprint of
  the entries under `plugins/harness-device/`, prefix removed, through `filesContentHash`);
  `export function codexPluginState(home: string): 'on' | 'off' | 'absent' | 'unknown'`;
  `export async function codexFound(home: string, shell: boolean): Promise<ClaudeRun | null>` (as `claudeFound`, for
  `codex`, its child given `CODEX_HOME=<home>` and the binary's folder first on PATH);
  `export function codexRunIn(home: string): ClaudeRun | null` (as `claudeRunIn`);
  `export async function codexSetUp(deps: CodexInstallDeps): Promise<CodexSetup>`;
  `export async function codexUpdate(deps: CodexInstallDeps): Promise<CodexSetup>`;
  `export async function codexRemove(deps: CodexPluginDeps): Promise<CodexResult>`.

- [ ] **Step 1: Write the failing tests** with a fake `run` that records each argv and answers as Codex 0.172.0, and a
  `files` holding Task 4's fixture tree under `plugins/harness-device/` plus a marketplace file: `--version` →
  `codex-cli 0.172.0`; `plugin marketplace add <folder>` → writes `[marketplaces.openharness]` with `source_type =
  "local"` and `source = <realpath(folder)>` into `<home>/config.toml`; `plugin add harness-device@openharness --json`
  → copies the marketplace's `plugins/harness-device` to `installedRoot(home)`,
  writes `[plugins."harness-device@openharness"] enabled = true`, prints `{ "pluginId": …, "version": "local",
  "installedPath": <that folder>, … }`.
  - `codexSetUp` with no marketplace in `config.toml`: the folder written with `files` (each file there, the hook
    executable off Windows); argv list `['--version']`, `['plugin', 'marketplace', 'add', <folder, absolute>]`,
    `['plugin', 'add', 'harness-device@openharness', '--json']`; `{ ok: true, outcome: 'installed', trusted: true }`;
    `config.toml` then holds both trust tables with `carriedCodexHash(files, platform)` as `trusted_content_hash`.
  - `'carriedCodexHash is the fingerprint of the copy Codex installs'`: equals `pluginContentHash(installedRoot(home))`
    after the fake's copy.
  - `it.each` `'a home whose openharness marketplace is the person's own (%s) is skipped: nothing installed, nothing
    written'` over `[marketplaces.openharness]` `source_type = "git"`, `source = "https://github.com/autonomous-ai/openharness.git"`;
    `source_type = "local"` with `source` another folder; and `source_type = "local"` with no `source`: `codexSetUp` and
    `codexUpdate` each → `{ ok: true, outcome: 'own', trusted: false }`; argv list `['--version']` only; the marketplace
    folder not written by the call (its `ensurePluginFolder` spy never called); `<home>/config.toml` byte-identical and
    same mtime; no `plugins/` folder made in the home. Red first: the module does not exist (and the draft installed
    there).
  - `'Harness's own folder through a link is Harness's'` (skip on win32): `source` the real path, `folder` a link to it →
    `codexMarketplace` is `harness`, and `codexSetUp` installs.
  - `codexMarketplace`: missing `config.toml` → `none`; no `openharness` table → `none`; not TOML → `unknown`.
  - `'below 0.172.0 a home with its own marketplace logs nothing either'`: `codex-cli 0.171.9` and a git marketplace →
    `unsupported`.
  - A plugin already on (installed before any record): added again, which Codex allows, and its trust written →
    `installed`.
  - `'below 0.172.0 nothing is set up'`: `codex-cli 0.171.9` → `unsupported`, nothing run after `--version`, no folder
    written, `config.toml` unchanged; a refused launcher → `launcher`.
  - The person turned it off (`enabled = false`) → `{ ok: true, outcome: 'absent', trusted: false }`, no add.
  - A folder that cannot be written → `folder` with `ensurePluginFolder`'s code as the reason, nothing run after
    `--version`; `marketplace add` exits 1 → `marketplace`.
  - `plugin add` exits 1 → `install`, its reason `failureReason`'s fixed word, no trust written; its JSON malformed, or
    its `installedPath` not `installedRoot(home)` → `install`.
  - A `config.toml` that does not parse after the add → `{ ok: false, step: 'trust', error: …, reason: 'unparsed' }`.
  - `codexUpdate` with the plugin on: the folder written again with changed files, no marketplace call, the add, and
    `trusted_content_hash` the new carried fingerprint → `updated`. With the plugin absent from `config.toml` →
    `absent`, nothing run after `--version`.
  - `codexRemove` with the plugin present → `['plugin', 'remove', 'harness-device@openharness']`; absent → nothing run;
    exit 1 → `remove`.
  - `codexFound` (skip on win32): a fake `codex` script on PATH that records its environment: run through the answer,
    `CODEX_HOME` is the home and PATH starts with the script's folder.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/devices/codexPlugin.spec.ts`. Expected:
  FAIL, module not found.
- [ ] **Step 3: Implement**, mirroring #4648's `claudeSetUp` and `claudeUpdate`: 60 s for the marketplace add and the
  plugin add, 15 s for `--version` and remove; `codexPluginState` and the marketplace's presence read from one parse of
  `readConfigText(join(home, 'config.toml'))` (a missing file is `absent`, one that cannot be read or parsed `unknown`,
  which fails `config`). The order: `--version` (below `MIN_CODEX`: `unsupported`), then that one parse (the
  marketplace `own`: return `own` at once; `unknown`: `config`), then the folder written with `ensurePluginFolder(folder,
  files.files, files.executable)`, then the `codex plugin` calls (the marketplace add only for `none`). `codexSetUp` and
  `codexUpdate` end with `writePluginTrust(home, installedPath, carriedCodexHash(files, platform))`: `differs` is
  `trusted: false`, any other failure is `trust` with the kind as its reason. No `codex plugin list` and no
  `marketplace upgrade`: the local folder is written by Harness, and any other `openharness` is the person's.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 11: the dial setup's Codex plugin pass and its re-check

**Effort:** xhigh (passes that overlap a `disable`, owed undos, per-home hours, a trust decision at every pass).
**Depends on:** Task 10 (and so G).

**Files:**
- Create: `cli/src/cable/dialCodexPluginSetup.ts`
- Test: `cli/src/cable/dialCodexPluginSetup.spec.ts`

**Interfaces:**
- Consumes: Task 10's `codexSetUp`, `codexUpdate`, `codexRemove`, `installedRoot`, `carriedCodexHash`,
  `codexMarketplace`, `CodexSetup`; Task 4's `writePluginTrust`, `TrustWrite`; `ClaudePluginSource` (#4648);
  `MAX_HOMES`, `listable`, `SETUP_COUNTS`; the `record` dependency answers false for a 65th home (Task 15 makes the
  real one do so; this task's tests use a fake).
- Produces: `export const CODEX_SETUP_COUNTS = [...SETUP_COUNTS, 'untrusted', 'skipped'] as const`;
  `export interface DialCodexPluginSetupDeps { platform: NodeJS.Platform; version: string; codex(home: string, shell:
  boolean): Promise<ClaudeRun | null>; plugin: ClaudePluginSource; homes(): readonly string[]; wanted(): boolean |
  undefined; recorded(): Readonly<Record<string, string>>; record(home: string, version: string | null): boolean;
  trust(home: string, root: string, expected: string): TrustWrite; now(): number; count(kind: typeof
  CODEX_SETUP_COUNTS[number], reason?: string): void }`;
  `export function createDialCodexPluginSetup(deps): { pass(attached?: boolean): Promise<void> }` (one pass at a time,
  never rejects).

- [ ] **Step 1: Write the failing tests** with fake `codex` runs per home (Task 10's fake answers), a fake clock, a
  `trust` spy over `writePluginTrust`, and `plugin.files()` giving the fixture copy:
  - `'installs once into each home it serves, by real path, and records this version for each'`: two homes, one given
    twice and once through a link → one set of calls per real home, each with that home; `record` per home; `count('set
    up')` per home; a second pass runs nothing.
  - `'trust is written after the install and again after an update'`: the home's `config.toml` holds the fixture's
    tables after the first pass; after a new `version` and a changed carried file, the update runs and
    `trusted_content_hash` is the new carried fingerprint; `count('updated')`.
  - `'a pass with every home current runs no codex and computes no fingerprint while neither stat changed'`: `codex`,
    `wanted` and `trust` never called on the third pass.
  - `'the re-check writes trust again for a folder that matches'`: after the first pass, the home's trust tables removed
    from `config.toml` (another writer) → the next pass calls `trust` once, the tables are back, no `codex` run, nothing
    counted.
  - `'the re-check after Codex reinstalled the same copy'`: `installedRoot` replaced by a fresh copy of the carried
    files and the tables' `trusted_content_hash` set to another value → trust written again.
  - `'a folder that differs is never trusted, and said once'`: one byte of the installed `README.md` changed by hand →
    no `hooks.state` change, `count('untrusted', 'differs')` once across three passes (each with a changed stat); put
    back to the carried bytes → trusted again; changed again → said once more.
  - `'a home whose openharness marketplace is the person's own is skipped: nothing installed, nothing written, said
    once'`: a home whose `config.toml` holds `[marketplaces.openharness] source_type = "git"`: across three passes (each
    past its hour), its argv lists only `['--version']`, `record` and `trust` never called, its `config.toml`
    byte-identical, no `plugins/` folder in it, and `count('skipped', 'own marketplace')` exactly once; another home in
    the same pass is set up as usual. Red first: the module does not exist (and the draft installed there).
  - `'a recorded home whose marketplace became the person's own is skipped from then on and leaves the record'` (open
    question 1's default): set up at this version, then its `[marketplaces.openharness]` replaced by a git one (the
    stat of `config.toml` changes) → the re-check calls `codexMarketplace`, not `trust`; `record(home, null)`;
    `count('skipped', 'own marketplace')` once; no `codex` run; later passes say nothing more.
  - `'no 65th home is installed into'`: `recorded()` holding 64 homes and a 65th served → no `codex` run there,
    `count('failed', 'full')` once a process, no `record`; once a recorded home is gone (its folder removed, its entry
    dropped first) the 65th is set up. And `'a record that is not saved after an install'`: `record` answers false →
    `count('failed', 'record')`, the home waits its hour, then is set up again (which `codex plugin add` allows).
  - `'a re-check whose write fails says its kind and waits its hour'`: a `config.toml` changed at each of the 3 attempts
    → `count('failed', 'trust changed')`, no path or text in any count or log line; tried again after its hour (until
    then Codex asks the person to review the hook, the accepted outcome).
  - `'a home the person removed the plugin from stays removed'`: recorded, then absent from its `config.toml` → the
    update says `absent`, no add, `count('left removed')`; its installed folder gone → the re-check stats, finds
    nothing, writes nothing.
  - `'a disable that lands during the install takes it out again and records nothing'`: `wanted` true then false →
    `codexRemove` in that home, no `record`; that removal failing is owed and tried again after its hour, while
    `wanted` stays false.
  - `'not wanted: nothing installed or removed'` (the command removes); `'wanted unknown: nothing'`; `'Codex removed
    (homes() empty): no re-check'`.
  - `'below 0.172.0: no plugin, no trust, no record, nothing counted; asked again after its hour'`.
  - `'a run from the sources (files() null): no codex run, no re-check, nothing counted'`.
  - `'a failed step waits its own hour, and another home goes on'`: `count('failed', step)` once per try.
  - `'no codex: nothing run, nothing counted'`; `'a recorded home that is gone leaves the record'`.
  - `'the login shell's PATH is read at an attach, else at most every 10 minutes'` (the `shell` argument).
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/dialCodexPluginSetup.spec.ts`.
  Expected: FAIL, module not found.
- [ ] **Step 3: Implement**, as #4648's `dialPluginSetup.ts` default home step, per home: the in-memory checks first
  (every home at this version or within its hour: no `wanted()`), real paths worked out once per changed list,
  `codexSetUp` for a home with no entry and `codexUpdate` for one at another version, with `{ folder: plugin.folder,
  files }` from `plugin.files()` (null: nothing at all), `wanted()` read again after the call. The carried fingerprint
  is computed once per process. The re-check, for each home in `homes()` recorded at this version and not within its
  hour: a stamp of `stat(installedRoot(home))` and `stat(config.toml)` (`dev`, `ino`, `size`, `mtimeMs`; a missing one
  is part of the stamp); equal to the last stamp held for that home: nothing; else `trust(home, root, expected)` and the
  stamp taken again after it, unless `codexMarketplace(home, plugin.folder)` is `own` (then the skip below and
  `record(home, null)`). A folder edited in place without a stamp change is never trusted by this (Codex refuses
  it itself). Before an install into a home with no entry: gone homes leave the record first; still `MAX_HOMES`
  entries → `failed` with `full`, once a process, nothing run. Counts: `installed` → `set up`, `updated` → `updated`,
  `absent` → `left removed`; `own` → `skipped` with `own marketplace`, once per home per process, the home then asked
  again only after its hour (no record, so no re-check); `trusted: false` or a `differs` re-check → `untrusted` with
  `differs`, once per home until a match; `unsupported` → nothing; `record` false → `failed` with `record`; a failure →
  `failed` with its step, a `trust` failure with `trust <kind>` (`trust changed`, `trust unsafe`, …): fixed words only.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 12: the dial setup runs the Codex plugin pass

**Effort:** high. **Depends on:** G, Tasks 5 and 11.

**Files:**
- Modify: `cli/src/cable/dialSetup.ts` (`DialSetupDeps.codex`, the moment)
- Modify: `cli/src/services/devices.ts` (`DevicesDeps.codex`, handed to `createDialSetup` as `deps.codex ?? codexFound`)
- Test: `cli/src/cable/dialSetup.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: Task 5's `codexHomes`, `codexPlugin`, `recordCodexPlugin`; Task 11's `createDialCodexPluginSetup`,
  `CODEX_SETUP_COUNTS`; Task 10's `codexFound`; Task 4's `writePluginTrust`; #4648's `DialSetupDeps.claudePlugin`
  (the same source for the Codex pass).
- Produces: `DialSetupDeps.codex(home: string, shell: boolean): Promise<ClaudeRun | null>`; `DevicesDeps.codex` (for the
  service's tests, `codexFound` by default).

- [ ] **Step 1: Write the failing tests.**
  - `dialSetup.spec.ts`: `'a moment runs the Codex plugin's pass after the homes and Claude Code's plugin, over the Codex
    homes the skill setup served, from the same marketplace folder'` (the default, an adopted and a scanned home each
    get `codex` looked up; the pass's lines go to the `[device] codex plugin` tally); `'an attach looks Codex up with
    the login shell's PATH'`.
  - `devices.spec.ts`: the start helper gets `codex: over.codex === null ? undefined : over.codex ?? (async () => null)`
    beside `claude` (no spec runs the developer's `codex`); `'with no claude given, the daemon's own lookup is used and
    finds none'` becomes `'with no claude or codex given, …'`, passes `codex: null`, and expects `codexFound` called with
    the Codex home's real path and `true`, answering null, and no `codexPlugin` in `dial-setup.json`.
  - `devices.spec.ts`: `'a Codex older than 0.172.0 is set nothing up, and nothing is logged'`: a fake run answering
    `codex-cli 0.171.9` → its argv list only `['--version']`, no `codexPlugin`, no `[device] codex plugin` line, the
    Codex home's `config.toml` and `plugins/` untouched.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/cable/dialSetup.spec.ts
  src/services/devices.spec.ts`. Expected: FAIL (`codexFound` never called; no Codex pass).
- [ ] **Step 3: Implement.** `dialSetup.ts` builds the pass with `count` from its own
  `createEngineTally('[device] codex plugin', ['codex'], CODEX_SETUP_COUNTS, deps.log)`, `plugin: deps.claudePlugin`,
  `trust: writePluginTrust`, and runs it at the end of each moment. `devices.ts` adds the one dependency and its doc
  comment; nothing about waits.
- [ ] **Step 4: Run them and see them pass.** Same command, then `cd cli && npm run test:core`. Expected: PASS, every
  file at 100%.
- [ ] **Step 5: Commit.** Red, then code.

### Task 13: `enable` and `disable` hold the plugin

**Effort:** high. **Depends on:** G, Tasks 5 and 10.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts` (`codexCommand`'s enable and disable, `DeviceDeps.codexIn`, `DEVICE_USAGE`)
- Modify: `cli/src/cli.ts` (`codexIn: codexRunIn`)
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Consumes: Task 10's `codexSetUp`, `codexRemove`, `codexPluginState`, `codexMarketplace`, `codexRunIn`; Task 5's
  `readSetup(dataDir).codexPlugin`; #4648's `DeviceDeps.claudeFiles()`, `deps.home` and
  `harnessPath('claude-marketplace', deps.home)`; `readRemoved`.
- Produces: `DeviceDeps.codexIn(home: string): ClaudeRun | null`. `enable` clears the removal and writes the skill (as
  today), then sets the plugin up in `deps.codexHome` and in each home `codexPlugin` records, from the same folder and
  carried files `claude enable` uses. `disable` marks the removal and removes the skill (as today), then removes the
  plugin in the same homes.

- [ ] **Step 1: Write the failing tests** (the spec's own throwaway homes and socket daemon; `codexIn` a fake run as
  Task 10's; `claudeFiles` the fixture copy):
  - `'codex enable sets the plugin up in its own Codex home and each home the devices recorded, with trust'`.
  - `'codex enable from a build that carries no plugin writes the skill and says This Harness build carries no Codex
    plugin.'` (exit 1), nothing run.
  - `'codex enable over the person's own marketplace writes the skill, sets nothing up there and exits 0'` (open
    question 2's default): a git `[marketplaces.openharness]` in `deps.codexHome` → argv list `['--version']` only,
    `config.toml` byte-identical, no `plugins/` folder in the home, output as with no plugin step, exit 0. Red first:
    today's `enable` does not call `--version` at all.
  - `'codex disable leaves a home whose marketplace is the person's own alone'`: the same home, with
    `[plugins."harness-device@openharness"] enabled = true` (the person's own install) → no `plugin remove` there,
    `config.toml` byte-identical, exit 0.
  - `'codex disable removes the plugin in its own Codex home and each home the devices recorded'`; `'a failed removal
    says Could not remove the Codex plugin. and exits 1, the removal still saved'`; `'with no codex, a plugin its
    config.toml reads on is said left on'`.
  - `'codex enable with a Codex older than 0.172.0 writes the skill and says Codex 0.172.0 or later is needed.'` (exit 1),
    no folder written, no `codex plugin` run.
  - The `DEVICE_USAGE` test's two Codex lines become `harness device codex enable            set Codex up again: the
    plugin and the dial skill in its homes` and `harness device codex disable           remove the plugin and the dial
    skill; Harness leaves them removed`; still no `asked`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected:
  FAIL (the plugin is never set up or removed; the usage lines differ).
- [ ] **Step 3: Implement.** Copy: `Could not set up the Codex plugin.`, `Could not remove the Codex plugin.`, `Codex was
  not found, so its harness-device plugin is still on; codex plugin remove harness-device@openharness removes it.`,
  `Codex 0.172.0 or later is needed.` and `This Harness build carries no Codex plugin.` (as #4648's Claude Code
  sentence). A failure prints its reason word as #4648's `claude enable` does. Each failing home is said once, never by
  its path. `trusted: false` and `own` are no failure and print nothing more. `disable` asks
  `codexMarketplace(home, folder)` before each removal and removes only where it is `harness`, or `none` with the home
  in `codexPlugin`.
- [ ] **Step 4: Run them and see them pass.** `cd cli && npx vitest run src/deviceClaude/command.spec.ts && npm run
  typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Red, then code.

### Task 14: docs

**Effort:** medium. **Depends on:** Tasks 1, 3, 6, 9, 12 and 13.

**Files:**
- Modify: `plugins/harness-device/README.md` (a Codex section: the two hooks, the line per tool, posts only when the
  turn's reviewer is the person or the mode is Plan, the rollout read and its bound, what it misses on purpose; the
  install from Harness's own marketplace folder; trust written only when the installed folder matches the copy this
  CLI carries, re-checked at each dial setup pass, and a folder edited by hand left to Codex's own review; a Codex home
  whose `openharness` marketplace is the person's own (from GitHub or anywhere else) gets nothing from Harness; install
  and remove with `harness device codex enable|disable`)
- Modify: `plugins/harness/README.md` (under the Codex marketplace line: in a Codex home with this marketplace, Harness
  sets up no `harness-device` plugin, so Codex's waits outside a pane do not reach the dial there)
- Modify: `cli/AGENTS.md` (the devices row: Codex's harness-device plugin set up in each Codex home the dial setup
  serves through `codex plugin` from the `claude-marketplace` folder, recorded under `codexPlugin` in
  `dial-setup.json`, its trust records in that home's `config.toml` only for a folder matching the carried copy,
  re-checked at each pass by a stat, none in a home whose `openharness` marketplace is the person's own, and `harness
  device codex asked` reading the rollout's `turn_context` alone, at most 16 MiB)
- Modify: `docs/cli.md` (the `harness device codex` row: enable and disable cover the plugin)
- Modify: `docs/plans/2026-11-16-hook-driven-agent-status-plan.md` (Known gap 4: narrowed: outside a pane, a Codex wait
  now reaches the dial through Harness Device's plugin when the turn's reviewer is the person; a command the automatic
  review approves still rings nothing)

- [ ] **Step 1:** Write them, short. No UI element changes, so the design doc does not.
- [ ] **Step 2:** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts src/deviceClaude/command.spec.ts` (the README
  and usage tests). Expected: PASS.
- [ ] **Step 3: Commit.** One commit.

---

## Task graph

| Task | Depends on | Effort | Blocked on #4648 merge |
|---|---|---|---|
| 1 plugin files | none | high | no |
| 2 rollout reader | none | xhigh | no |
| 3 codex asked body | 2 | high | no |
| 4 trust writer, match condition | none | xhigh | no |
| 5 record and homes | none | high | no |
| 6 `device codex asked` | 3 | high | no |
| 7 end to end | 6 | high | no |
| 8 Windows spec lists | 2, 4 | medium | no |
| 15 dial-setup.json bound, no 65th home | none | high | no |
| G #4648 merged, branch rebased | #4648 | (gate) | yes |
| 9 carried copy holds Codex's files | G, 1 | medium | yes |
| 10 codex plugin from the local folder | G, 4 | high | yes |
| 11 Codex plugin pass and re-check | 10 | xhigh | yes |
| 12 wiring | G, 5, 11 | high | yes |
| 13 enable and disable | G, 5, 10 | high | yes |
| 14 docs | 1, 3, 6, 9, 12, 13 | medium | yes |

Longest chain: 4 → G → 10 → 11 → 12 → 14 (five tasks and the gate). Before G the longest is 2 → 3 → 6 → 7 (four).

## Pull request notes

- The remaining gap, in the PR text: "Between a change of a Codex home's installed plugin folder (Codex's own reinstall
  at its start, or a CLI update) and the next dial setup pass, Codex asks the person to review the hooks; and a home
  whose `openharness` marketplace is the person's own (from GitHub or anywhere else) gets no `harness-device` plugin
  from Harness, so its Codex waits outside a pane do not reach the dial, as today."
- Depends on #4648 (merged before this pull request's Tasks 9-14) and Part 6; released after both.
- The red-then-green commits per task, `test:core`'s receipts, and Verification 1, 2 and 4's evidence.

## Verification

**On GitHub, automatic on the pull request** ([validation and release](../validation-and-release.md)): `cli-typecheck`
and `cli-tests` (every spec above, `architecture.spec.ts` and `architecture.failureLogs.spec.ts` among them), the
`companions` and `pty` checks a `cli/` change runs, `linux-e2e` (the new `deviceCodexAsked.e2e.ts`, and the dial app
eval's six because `services/devices.ts` changes), and `windows-e2e` (x64 for `cli/src/devices/`, `cli/src/cable/` and
`plugins/harness-device*/`; arm64 too with Task 8's `windows.yml` edit): `harnessDevicePlugin.spec.ts` runs the Codex
hook under Windows PowerShell there, and Task 8's two specs run the fingerprint and the file checks on Windows. No
workflow is started by hand.

**Local gates PR CI does not run:** at the final commit, from a clean tree, `python3 scripts/local-checks.py --run`
(selects `npm run test:core`, as `services/devices.ts` changes); paste its receipts in the pull request with the red and
green commits. Also `cd cli && npm run typecheck` and the specs each task names.

1. **The real Codex, on this Mac, before the merge** (a tester; macOS). Codex 0.172.0 or later, its binary only.
   - Build: `cd cli && npm ci && npm run bundle` (`cli/dist/cli.js`, which carries the marketplace with Codex's files).
   - Isolation: a scratch script in the scratchpad, run from `cli/` with `node --import tsx`, starts the e2e harness's
     `IsolatedDaemon` with `env: { CODEX_PATH: <the real codex> }` (its own root: data, auth and computer-id files, a
     free `PORT` other than 18473, a private tmux server, `HOME` and `CODEX_HOME` inside the root, signed out, its
     backend `ws://127.0.0.1:9`) and a `Desk` with one `FakeDial`, as `deviceCodex.e2e.ts` `fresh()` does. Never the
     tester's `~/.codex`, `~/.codex-hq`, `~/.harness`, Codex or ChatGPT login, everyday daemon, or a production backend.
   - Before the dial: in that `CODEX_HOME`, a `config.toml` with the spike's stub provider (`[model_providers.stub]`,
     `base_url = "http://127.0.0.1:<p>/v1"`, `wire_api = "responses"`, `env_key = "STUB_KEY"`), `approval_policy =
     "on-request"`, `sandbox_mode = "read-only"`; `<HOME>/.local/bin/harness` a wrapper `exec node
     <checkout>/cli/dist/cli.js "$@"`.
   - Plug the fake dial. Expect: `<HOME>/.harness/claude-marketplace` written (or the isolated data root's), with
     `plugins/harness-device/.codex-plugin/plugin.json` and `hooks/codex-asked` executable; `config.toml` holds
     `[marketplaces.openharness]` from that folder, `[plugins."harness-device@openharness"]` and the two `hooks.state`
     tables; `dial-setup.json` holds `codexPlugin` with that home at this version; the spike's `hookslist.mjs`
     (`codex app-server` `hooks/list`) shows both plugin hooks `trusted` (the proof that Codex's installed copy equals
     the carried copy byte for byte).
   - Run the Codex TUI in that tmux server, outside any Harness pane, with the daemon's environment, the stub (the
     spike's `stub3.mjs`) answering `exec_command` with `sandbox_permissions: "require_escalated"`:
     (a) `approvals_reviewer = "user"`: the fake dial gets the agent's line `touch … · answer in <app>` and one
     `question`, the daemon's log one `[observed] waiting prompt · shown`; answered in the TUI, the line goes.
     (b) `approvals_reviewer = "auto_review"` (the stub's review answer allows): no line, no `question`, no `shown`.
     (c) The TUI in Plan mode, the stub calling `request_user_input`: the line `Which color? · answer in <app>` and one
     `question`. (d) Default mode, the same call: nothing.
   - (e) Quit and start Codex again: `hooks/list` still says `trusted`. (f) Change one byte of the installed
     `README.md`: `hooks/list` says the hooks need review; after the next pass the daemon's log says `[device] codex
     plugin · codex · untrusted · differs` once and `config.toml`'s tables are unchanged. Put the byte back: the next
     pass leaves or writes trust, `trusted` again.
2. **A CLI update and the person's own GitHub marketplace** (a tester; macOS; public GitHub, no login). In fresh
   isolated `HOME`s and `CODEX_HOME`s, from the branch's bundle: (a) a `dial-setup.json` recording an older version for
   a set-up home, and one pass of the isolated daemon: the folder rewritten, `codex plugin add` again, trust written
   again, `hooks/list` `trusted`. (b) A home where `codex plugin marketplace add autonomous-ai/openharness --sparse
   .claude-plugin --sparse plugins` ran first, then `harness device codex enable`: exit 0, `config.toml` byte-identical
   (no `[plugins."harness-device@openharness"]`, no `hooks.state` table of ours), no `plugins/cache/openharness/
   harness-device` folder; then one pass of the isolated daemon serving that home: its log says `[device] codex plugin
   · codex · skipped · own marketplace` once, and a second pass says nothing more.
3. **Linux:** `linux-e2e` above. The hook is the same POSIX script as on macOS; no real-Codex run is needed.
4. **Windows, by hand** (a tester, on a Windows 11 test machine; the only check of the `\`-path fingerprint and the
   local folder by its absolute Windows path against a real Codex): Codex 0.172.0 or later, an isolated `USERPROFILE`
   and `CODEX_HOME`, the branch's bundle: `harness device codex enable` → `hooks/list` says `trusted`; then one
   escalated command with `approvals_reviewer = "user"` against an isolated daemon (its own data folder and port, signed
   out) posts `asked` through the PowerShell form (the daemon's log says `shown`).
5. **The person's own eye, after the release** (needs the user: their own Codex login, Codex in a terminal, and their
   dial): an escalated command with the reviewer `user` rings the dial once; with `auto_review` it rings nothing.

**Proposal, not built here (decision 12):** a scheduled check of the newest Codex release (no such workflow exists):
install the plugin from the carried copy into a throwaway home, compare `hooks/list`'s hashes with Harness's records,
and read a fresh rollout's `turn_context` for `approvals_reviewer` and `collaboration_mode.mode`, so a Codex that renames
them or changes its fingerprint is seen before every Codex wait outside a pane goes quiet again.
