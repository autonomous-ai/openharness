# Windows: the dial's inbox follower starts on a small file of its own: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, `harness device claude inbox <session id>` (one per Claude Code session) runs on a ~100 KB
`inbox.mjs` instead of the 13 MB `cli.js`: about 103 MB of working set down to about 40-55 MB per session.

**Architecture:** `build-bundle.mjs` builds `inbox.mjs` from `src/inboxEntry.ts` beside `cli.js` and `notify.mjs`. The
release uploads it and names it in the manifest's `cli` entry (`inbox`, optional). On Windows only, `install.ps1` and both
updaters put it into the version folder, checked against its sha256, and the updaters canary it. `harness.exe`
(`pty/src/command.rs`) runs `inbox.mjs` for the follower's line when the version folder holds it, else `cli.js`, which
already takes the short path (T1).

**Tech Stack:** TypeScript (Node 24), esbuild, Vitest; Rust 2024 (`pty/`); bash release scripts; Windows PowerShell 5.1
(`install.ps1`); GitHub Actions (`release.yml`, `windows.yml`).

**Spec:** `docs/plans/2026-11-27-windows-follower-ram-design.md` (approved; read it with this plan). Base:
`fix/windows-follower-ram` at `3c53fd35fc`.

Paths: TypeScript commands run in `cli/`, Rust in `pty/`. `L/` is `cli/src/lib/`, `S/` is `cli/scripts/`, `X/` is
`cli/src/scripts/`.

## Already landed: Task 1 (T1)

`be3805ebca` (red) and `3c53fd35fc` (code): `deviceClaude/inboxCommand.ts` (`inboxSessionOf`, `runInbox`,
`processInboxDeps`, `writeStdoutLine`, `pluginActs`), the branch in `entry.ts`, and `entry.spec.ts` "follows a session's
inbox without loading the whole CLI". Build on it; do not redo it.

## Decisions already made (PM, 2026-11-27): not reopened

1. `inbox.mjs` is a normal build and release file, like `notify.mjs`. Nothing writes executable code beside `cli.js` at
   run time: only the installer and the updaters write it, checked against the manifest's sha256.
2. `inbox` in the manifest is optional; one of the wrong shape is ignored as if absent; old installs and manifests fall
   back to `cli.js`.
3. Only Windows fetches and stages `inbox.mjs`; `install.sh`, `install-cli.sh` and the Unix stage do not change.
4. Both updaters (`selfUpdate.ts` and `harness update`, `updateCommand.ts`) canary the staged `inbox.mjs` on Windows.
5. The choice is a helper in `pty/src/command.rs`; `launcher.rs`'s `Resolved` and `harness-launch.exe` do not change.
6. Spec section 4 (the release process) is under review by Ken's side: Tasks 8 to 13 hold it, each apart, so their
   feedback changes those tasks only.
7. `install.ps1` reads `inbox` by the updaters' rule: only a string `url` and a string `sha256` make it present; any
   other shape is ignored as absent and never fails the install (Task 13).
8. `windows.yml`'s install job runs the real follower: `check-install.ps1` checks `cli\<version>\inbox.mjs` exists and
   that `harness device claude inbox not-a-session-id` prints `{"off":true}` and exits 0, the only CI run of the real
   `inbox.mjs` through the real `harness.exe`. It is [Ken] Task 14, and the PR body says it is there for Ken's side to
   see.

## What this plan decides from the code (read for this plan, not run)

- **One path for every line that is not the follower's.** `inboxEntry.ts` runs `runInbox(session ?? '', …)`: `''` is
  refused by `followInbox` before anything else (no read, no daemon), which prints `{"off":true}` and returns 0.
- **`contained` is shared, not copied.** `launcher.rs`'s private `contained` becomes `pub(crate)` (visibility only), so
  `command.rs` applies to `inbox.mjs` exactly the check `resolve` applies to `cli.js`: `is_file()` and
  `contained(<root>\cli, file)`, `<root>\cli` being `cli_js.parent().parent()`.
- **One download of a build.** `downloadBuild(entry, platform, limits)` in `selfUpdate.ts` downloads `cli.js`,
  `notify.mjs` and, on `win32` only, the manifest's `inbox.mjs`. Both updaters use it, so the Windows rule is in one place.
- **The canary is `runCanary`'s, not a second function.** After `cli.js` answers its version, `runCanary` runs the given
  `inbox.mjs` from the same canary folder, on the same Node, under the same deadline and kill: both updaters, and the
  self-updater's "does not run on the new Node" retry, get it unchanged.
- **New parameters go last, defaulted to `null`** (`writeVersionFolder`, `stage`, `runCanary`): the ~70 existing call
  sites in the specs do not change.
- **`harness update` needs no `cli.ts` change:** `cli.ts` hands `fetchManifest`'s entry, `inbox` included, to
  `runUpdateSteps`.
- **`merge-manifest.mjs` takes 10 or 13 positional arguments**; any other count exits 2 and writes nothing.
- **`windows-install-manifest.mjs` requires `inbox.mjs`** in `--cli-dir`: a local build always has it (Task 2).
- **Nothing in `cli/src/core/` or `cli/src/services/` changes**, so `npm run test:core` is not required. `pty/` changes,
  so `local-checks.py` selects `cli-pty` (`npm run test:terminal-contract`, macOS).

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 2 | `inbox.mjs`, built | `cli/src/inboxEntry.ts` (new), `cli/src/inboxEntry.spec.ts` (new), `cli/build-bundle.mjs`, headers of `cli/src/entry.ts`, `cli/src/deviceClaude/inbox.ts` | none | high | `inboxEntry.spec.ts` (no `inbox.mjs`) |
| 3 | `harness.exe` runs it | `pty/src/command.rs`, `pty/src/launcher.rs` (visibility), `pty/tests/harness_command.rs`, `cli/AGENTS.md` | none | xhigh | `command.rs` tests, `harness_command.rs` follower cases |
| 4 | Version folders hold it | `L/windows/cliVersions.ts`, `L/windows/cliVersions.spec.ts` | none | high | `cliVersions.spec.ts` inbox cases |
| 5 | The updater's manifest, download, canary, stage | `L/selfUpdate.ts`, `L/selfUpdate.spec.ts` | 4 | xhigh | "the inbox follower's file (Windows)" |
| 6 | The self-updater stages it | `L/selfUpdate.ts`, `L/selfUpdate.spec.ts` | 5 | xhigh | "the automatic updater and inbox.mjs (Windows)" |
| 7 | `harness update` stages it | `L/updateCommand.ts`, `L/updateCommand.spec.ts` | 5 | high | `updateCommand.spec.ts` inbox cases |
| 8 | [Ken] `upload-cli.sh`, `merge-manifest.mjs`, release docs | `S/upload-cli.sh`, `S/merge-manifest.mjs`, `X/mergeManifest.spec.ts` (new), `cli/RELEASE.md`, `cli/README.md` | 2 | high | `mergeManifest.spec.ts` |
| 9 | [Ken] Staging publish | `S/publish-cli-staging.sh`, `X/publishCliStaging.spec.ts` | 2 | medium | two refusal cases |
| 10 | [Ken] `release.yml` checks and lists it | `.github/workflows/release.yml`, `X/windowsWorkflows.spec.ts` | 8 | medium | one text case |
| 11 | [Ken] Local install manifest | `S/windows-install-manifest.mjs`, `X/windowsInstallManifest.spec.ts` | 2 | medium | `windowsInstallManifest.spec.ts` |
| 12 | [Ken] Windows end-to-end fixtures | `S/windows-cli-e2e/fake-cdn.mjs`, `X/fakeCdn.spec.ts`, `S/windows-cli-e2e/fake-cdn.sh`, `S/windows-cli-e2e/serve-updates.sh`, `S/windows-dial-e2e/bundle.mjs` | 8 | high | `fakeCdn.spec.ts` layout cases |
| 13 | [Ken] `install.ps1` | `S/install.ps1`, `X/installPs1.spec.ts`, `docs/testing/windows-cli-e2e.md` | 3 | high | `installPs1.spec.ts` real-install cases (Windows; seen in windows-e2e) |
| 14 | [Ken] The install job runs the real follower | `S/windows-ci/check-install.ps1`, `X/windowsCiChecks.spec.ts` | 3, 11, 13 | medium | `windowsCiChecks.spec.ts` text case (Mac); the real run only in the PR's windows-e2e `install` job |

**Longest chain:** 4 → 5 → 6 (three tasks; 4 → 5 → 7, 2 → 8 → 10, 2 → 8 → 12, 3 → 13 → 14 and 2 → 11 → 14 are as
long). Tasks 2, 3 and 4 start at once; 7 runs beside 6; 9 and 11 start once 2 lands; 13 once 3 lands; 14 once 3, 11
and 13 have.

## Global Constraints

- `cd cli && npm ci` first if the worktree has no `node_modules`.
- **Windows only runs and stages it.** macOS and Linux behave exactly as today: no fetch, no stage, no canary of
  `inbox.mjs`; `install.sh`, `install-cli.sh` unchanged. The release uploads `inbox.mjs` for every platform, in the one
  manifest.
- **Optional and forgiving:** an `inbox` with a string `url` and a string `sha256` is read (`size` when given); any other
  shape is ignored as absent and never rejects the entry. Without it, every install and update works as today.
- **Trust:** `inbox.mjs` reaches a version folder only through `downloadVerified` (updaters) or `Save-HarnessVerified`
  (`install.ps1`), checked against the manifest's sha256 and size. Nothing writes it at run time. No stable copy
  (unlike `cli\notify.mjs`): `harness.exe` runs it from the version folder.
- **The canary's follower run:** `node inbox.mjs device claude inbox canary` (`canary` is no session id), from the canary's
  own folder, within `CANARY_TIMEOUT_MS` (15 s) with the same SIGTERM, then SIGKILL after 2 s; ok only on exit 0 and
  `{"off":true}`. Spawned as the CLI canary is (`execFile`, never `detached`: `docs/windows-rules.md` §1).
- **Nothing logged but kinds:** a failed canary's `ended` names the file and an exit code, a signal or a time, never its
  output; no path, id or text in a log line.
- **Unchanged:** `launcher.rs`'s `Resolved`, `harness-launch.exe`, `isVersionFolder`, `currentCli`, `retireUnused`,
  `switchTo`, `cli.ts`, the pty payload release and promote.
- Every behavior task: a red commit (the failing tests), then a green commit. `npm run typecheck` when a TypeScript
  signature changes. Comments say why and name the spec. Names follow `docs/naming-system.md`. Copy stays short.
- **Section 4 tasks (8-14)** land in their own commits so Ken's review can change them alone.
- **No production:** never run `upload-cli.sh`, `release.yml`, `promote-pty-payload.sh` or `publish-cli-staging.sh`
  without `DRY_RUN=1`; no `gcloud`, no bucket, no CDN. Release scripts are tested by their specs and fakes only.
- **This Mac is shared:** a task runs only its own specs, `npm run typecheck` and `cargo test --locked` in `pty/`;
  `scripts/local-checks.py --run` waits for the PM's go. Never `pgrep -f`, `ps aux`, `ps -o args`; never
  `harness device notify`; no screenshots; no real Claude Code or Codex.

## Review Focus

1. **An install older than this change** (a `harness.exe` from before, a version folder an older updater or installer
   wrote, a manifest without `inbox`): the follower still starts, on `cli.js`. Tests: Task 3
   `an_install_without_inbox_mjs_runs_cli_js_for_the_follower`; Task 13 "installs no inbox.mjs from a manifest without
   one"; Task 6 "still updates from a manifest with no inbox".
2. **`inbox.mjs` that fails to download or does not match on Windows:** the update waits and retries, or is refused as a
   bad `cli.js` is; a folder is never staged without the file the manifest names. Tests: Task 6 "refuses an inbox.mjs
   that does not match", "an inbox.mjs download that fails is a failed check, tried again".
3. **A follower running when older builds are retired:** its folder stays while it runs (its command line names it).
   Test: Task 4 "keeps a build a follower runs inbox.mjs from" (a pin: passes before and after).
4. **The canary's follower run on the person's own data folder:** a refused id reads and writes nothing. Test: Task 2
   "a refused id prints {"off":true}, exits 0, and leaves its home as it was".
5. **A line that looks like the follower's and is not** (an extra word, `Device`, `hn`'s `tui …`, a non-UTF-8 word):
   `cli.js` runs, as before. Test: Task 3 `follows_inbox_only_for_the_followers_line`.

---

### Task 2: `inbox.mjs`, built beside `cli.js`

**Depends on:** none. **Effort:** high.
**Test that must fail first:** `src/inboxEntry.spec.ts` (the build writes no `inbox.mjs`).

**Files:**
- Create: `cli/src/inboxEntry.ts`, `cli/src/inboxEntry.spec.ts`
- Modify: `cli/build-bundle.mjs` (one more build after `cli.js`; the banner comment's list of shipped files; the last
  log line), `cli/src/entry.ts` (header comment only), `cli/src/deviceClaude/inbox.ts` (header comment only)

**Interfaces:**
- Consumes (T1, `deviceClaude/inboxCommand.ts`): `inboxSessionOf(argv: string[]): string | null`,
  `runInbox(sessionId: string, deps: InboxCommandDeps): Promise<number>`, `processInboxDeps(): InboxCommandDeps`.
- Produces: `<BUNDLE_OUT_DIR or dist>/inbox.mjs`, run as `node inbox.mjs device claude inbox <id>` (the arguments
  `cli.js` gets). The contract Tasks 3, 5 and 13 fake: a refused id, or any line that is not the follower's, prints
  `{"off":true}\n` and exits 0.

- [ ] **Step 1: Write the failing tests** in `src/inboxEntry.spec.ts`. `beforeAll` (120 s) runs `build-bundle.mjs` with
  `BUNDLE_OUT_DIR=<tmp>/build` and `ADAPTER_VERSION=9.8.7-inbox.1`, as `leanEntry.spec.ts` does.
  - "is a file of its own, under 200 KB, with the release banner and none of the whole CLI": size `< 200_000`; first line
    starts with `/*! harness v9.8.7-inbox.1 `; no byte above `0x7f`; for each marker
    `'Updating would replace it with a published release'` (`cli.ts`), `'[runtime-profile] connect reconcile failed'`
    (`core/main.ts`): `cli.js` holds it and `inbox.mjs` does not. (`ws` stays: the follower's pipe client,
    `lib/windows/pipeClient.ts`, imports it; the measured 57 MB bundle carried it. Decided 2026-11-27.)
  - "follows on its own: a refused id prints {"off":true}, exits 0, and leaves its home as it was": `spawnSync(node,
    [inbox.mjs, 'device', 'claude', 'inbox', 'not-a-session-id'])` with only `PATH`, `HOME`/`USERPROFILE` = a temp home,
    `ADAPTER_DATA_DIR=<home>/data`, `CLAUDE_CONFIG_DIR=<home>/claude` and `entry.spec.ts`'s `WINDOWS_ENV` →
    `{ status: 0, stdout: '{"off":true}\n', stderr: '' }`; `readdirSync(home)` is `[]`.
  - `it.each` "answers any other line {"off":true} and exits 0": `[]`, `['version']`, `['device']`,
    `['device', 'claude', 'attach', 'x']`, `['device', 'claude', 'inbox', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'extra']`,
    `['claude', 'inbox', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d']` → the same result.
- [ ] **Step 2: Run** `npx vitest run src/inboxEntry.spec.ts`. Expected: FAIL (no `inbox.mjs` in the build).
- [ ] **Step 3: Implement.** `src/inboxEntry.ts`: imports `./lib/connectWait.js` first (as every entry), then
  `session = process.argv[2] === 'device' ? inboxSessionOf(process.argv.slice(3)) : null` and
  `process.exitCode = await runInbox(session ?? '', processInboxDeps())`. Its header: the Windows follower's own file in a
  release, run by `harness.exe` (`pty/src/command.rs`), the measurement (99 KB; 57 MB resident against 143 MB from
  `cli.js` with T1, 158 MB before), and that only the installer and the updaters write it.
  `build-bundle.mjs`: after `cli.js`, `esbuild.build({ ...options, entryPoints: ['src/inboxEntry.ts'], outfile:
  `${outDir}/inbox.mjs` })`, then the `asciiOnly` rewrite `cli.js` gets. Headers: `entry.ts` says a release's
  `harness.exe` starts the follower from `inbox.mjs` and this branch serves an install or a `harness.exe` without it;
  `inbox.ts`'s last paragraph says the same of who runs it.
- [ ] **Step 4: Run** `npx vitest run src/inboxEntry.spec.ts src/entry.spec.ts src/leanEntry.spec.ts` and
  `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** the red commit (spec), then the green commit (the rest).

### Task 3: `harness.exe` runs `inbox.mjs` for the follower

**Depends on:** none. **Effort:** xhigh (which file the person's `harness` command runs: matching and containment).
**Test that must fail first:** `command.rs` unit tests (no `script_for`, no `follows_inbox`) and the
`harness_command.rs` follower cases (the binary runs `cli.js`).

**Files:**
- Modify: `pty/src/command.rs` (module doc; `INBOX`; `follows_inbox`; `script_for`; `run_resolved` runs its script),
  `pty/src/launcher.rs` (`fn contained` → `pub(crate) fn contained`, nothing else), `cli/AGENTS.md` (the devices row's
  words on how the plugin's mod reaches the daemon on Windows: `harness.exe` starts the follower on `inbox.mjs` when the
  version folder holds it, else on `cli.js`)
- Test: `pty/src/command.rs` (`mod tests`), `pty/tests/harness_command.rs`

**Interfaces:**
- Produces: `const INBOX: &str = "inbox.mjs";`
  `fn follows_inbox(args: &[OsString]) -> bool`: `args[0]` is exactly `device`; of `args[1..]`, words starting with `-`
  are dropped, at most three are left, and the first two are `claude` and `inbox`; any argument that is not UTF-8
  (`to_str()` is `None`) makes it false. Applied to the arguments after `hn_args`.
  `fn script_for(resolved: &Resolved, args: &[OsString]) -> PathBuf` (private; its tests are in the module):
  `resolved.cli_js.with_file_name(INBOX)` when
  `follows_inbox(args)`, that path `is_file()`, and `contained(<root>\cli, path)` with `<root>\cli` =
  `cli_js.parent().and_then(Path::parent)`; otherwise `resolved.cli_js.clone()`.
  `run_resolved` runs `node <script_for(resolved, args)> <args>`, the arguments unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `command.rs` `follows_inbox_only_for_the_followers_line`: true for `device claude inbox 0a1b2c3d-…`,
    `device claude inbox`, `device claude inbox ""`, `device --json claude inbox x`, `device claude -q inbox x`; false for
    `device claude attach x`, `device claude inbox x extra`, `claude inbox x`, `Device claude inbox x`,
    `device Claude inbox x`, `tui device claude inbox x` (what `hn` hands on), `device`, `device claude`, `[]`; false with a
    non-UTF-8 id (`#[cfg(unix)]` `OsString::from_vec(vec![0x66, 0xff])`, `#[cfg(windows)]`
    `OsString::from_wide(&[0xD800])`).
  - `command.rs` `script_for_runs_inbox_mjs_only_when_the_version_folder_holds_it`: a temp `<t>/cli/1.2.3/cli.js` and
    `Resolved { node, cli_js }`: a regular `inbox.mjs` + the follower's line → it; another line → `cli.js`; no file →
    `cli.js`; a folder named `inbox.mjs` → `cli.js`; `#[cfg(unix)]` a symlink `inbox.mjs` to a file outside `<t>/cli` →
    `cli.js`.
  - `harness_command.rs`: `CLI_JS` also prints `script: 'cli.js'`; a fake `INBOX_MJS` prints
    `JSON.stringify({ script: 'inbox.mjs', args: process.argv.slice(2) })` (ESM-safe). Cases:
    `the_follower_runs_inbox_mjs_with_its_arguments_untouched` (`device claude inbox 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`
    → `script` `inbox.mjs`, `args` equal); `every_other_line_runs_cli_js` (`version`, `device claude attach x`,
    `device claude inbox x extra`, with `inbox.mjs` present); `an_install_without_inbox_mjs_runs_cli_js_for_the_follower`;
    `a_folder_named_inbox_mjs_is_not_run`; `#[cfg(unix)] an_inbox_mjs_that_leads_out_of_cli_is_not_run`.
- [ ] **Step 2: Run** `cargo test --locked --lib command::` and `cargo test --locked --test harness_command`. Expected:
  FAIL (unit tests do not compile; the follower case reports `cli.js`).
- [ ] **Step 3: Implement** the helpers and `run_resolved` in `command.rs`, the visibility in `launcher.rs`, the module
  doc (which file runs, and why `inbox.mjs`: spec section 3), and the `cli/AGENTS.md` sentence.
- [ ] **Step 4: Run** `cargo test --locked` in `pty/`. Expected: PASS (the Windows run is windows-e2e's).
- [ ] **Step 5: Commit** red (tests), then green.

### Task 4: version folders hold `inbox.mjs`

**Depends on:** none. **Effort:** high (on-disk version folders).
**Test that must fail first:** the inbox cases below (`writeVersionFolder` takes no inbox).

**Files:**
- Modify: `cli/src/lib/windows/cliVersions.ts` (module doc; `const INBOX = 'inbox.mjs'`; `writeVersionFolder`)
- Test: `cli/src/lib/windows/cliVersions.spec.ts`

**Interfaces:**
- Produces: `writeVersionFolder(cliDir: string, version: string, cliBuf: Buffer, notifyBuf: Buffer, inboxBuf: Buffer | null
  = null): string`. Reused as is only when `cli.js` and `notify.mjs` hold these bytes and, when `inboxBuf` is given,
  `inbox.mjs` holds its bytes; otherwise written whole through the temporary folder (with `inbox.mjs` when given) and the
  folder there moved aside, as today. With `inboxBuf` null an `inbox.mjs` already there is never a reason to rewrite.

- [ ] **Step 1: Write the failing tests** in `describe('the CLI\'s version folders')`:
  - "hold the build's inbox.mjs when it has one, and are version folders without it": with it, `readdirSync` is
    `['cli.js', 'inbox.mjs', 'notify.mjs', 'package.json']`; a folder without it still passes `isVersionFolder`.
  - "write a folder again that lacks the build's inbox.mjs or holds another, and keep one whose three files match": the
    first two leave the new `inbox.mjs` and one `.0.5.0.*.old` beside; the third leaves no `.old` and the files untouched.
  - "keep a folder with these cli.js and notify.mjs when the build has no inbox.mjs, whatever inbox.mjs it holds".
  - "leave nothing behind when the write of inbox.mjs fails": `fault.at` matches `inbox.mjs` → throws; no `.tmp`, the
    folder before as it was.
  - In `describe('retiring older builds')`, a pin: "keeps a build a follower runs inbox.mjs from": a row whose `args` is
    `"C:\\h\\runtime\\node\\node.exe" C:\\h\\cli\\0.5.0\\inbox.mjs device claude inbox <uuid>` keeps `0.5.0`.
- [ ] **Step 2: Run** `npx vitest run src/lib/windows/cliVersions.spec.ts`. Expected: FAIL (no `inbox.mjs` written).
- [ ] **Step 3: Implement** `writeVersionFolder` as above; the module doc names the third file and the reuse rule.
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 5: the updater reads, downloads, canaries and stages `inbox.mjs`

**Depends on:** 4. **Effort:** xhigh (what the updater downloads, trusts and runs).
**Test that must fail first:** a new `describe('the inbox follower\'s file (Windows)')` in `selfUpdate.spec.ts`.

**Files:**
- Modify: `cli/src/lib/selfUpdate.ts` (header's manifest shape; `UpdateEntry`; `CliBuild`; `fetchManifest`;
  `downloadBuild`; `runCanary`; `stage` and `stageVersion`)
- Test: `cli/src/lib/selfUpdate.spec.ts`

**Interfaces:**
- Consumes: Task 4's `writeVersionFolder(…, inboxBuf)`.
- Produces:
  - `UpdateEntry { version: string; cli: FileRef; notify: FileRef; inbox?: FileRef }`; `fetchManifest` keeps `inbox` when
    it passes the `okFile` check `cli` and `notify` pass, and leaves it out otherwise.
  - `export interface CliBuild { cliBuf: Buffer; notifyBuf: Buffer; inboxBuf: Buffer | null }`
  - `export async function downloadBuild(entry: UpdateEntry, platform: NodeJS.Platform, limits: TransferLimits =
    DOWNLOAD_LIMITS): Promise<CliBuild>`: `cli`, then `notify`, then `inbox` only when `platform === 'win32'` and the
    entry has one, each through `downloadVerified` (a mismatch throws `DigestMismatchError`). The Windows rule is one
    private `inboxOf(entry: UpdateEntry, platform: NodeJS.Platform): FileRef | undefined`, which Task 6's key uses too.
  - `runCanary(cliBuf, dir, version?, timeoutMs = CANARY_TIMEOUT_MS, node = managedNodePath(), inboxBuf: Buffer | null =
    null): Promise<CanaryResult>`: when `cli.js` passed and `inboxBuf` is given, writes `inbox.mjs` into the same canary
    folder and runs `node inbox.mjs device claude inbox canary` under the same deadline and kill; a write that fails is
    `unwritable`; anything but exit 0 with trimmed stdout `{"off":true}` is `failed` with `ended` one of
    `inbox.mjs: exit <n>`, `inbox.mjs: signal <s>`, `inbox.mjs: no answer within <t>` (the CLI canary's wording of time),
    `inbox.mjs: another answer`. The run and its deadline are one private helper both runs use, moved unchanged out of
    today's body.
  - `stage(dir, cliBuf, notifyBuf, version?, platform = process.platform, previousNode = null, inboxBuf: Buffer | null =
    null): void`: `win32` hands `inboxBuf` to `writeVersionFolder`; elsewhere it is not read.

- [ ] **Step 1: Write the failing tests** (fetch stubbed as the spec's other describes do; real Node for the canary):
  - "reads inbox as optional: kept with a url and a sha256, ignored in any other shape": `{ url, sha256, size }` kept;
    `'inbox.mjs'`, `null`, `[]`, `{ url: 1, sha256 }`, `{ url }` give `inbox` undefined, and the entry is never null.
  - "downloads inbox.mjs on Windows only, and only when the manifest names it": the URLs fetched and `inboxBuf` for
    `win32` with it (three, bytes), `darwin` and `linux` with it (two, null), `win32` without it (two, null); a `win32`
    inbox whose bytes differ rejects with `DigestMismatchError`.
  - "canaries inbox.mjs after cli.js: a refused id answers {"off":true} and exits 0": a fake that prints `{"off":true}`
    only for argv `device claude inbox canary` (else exits 2) → ok; `process.exit(1)` → `failed`, `inbox.mjs: exit 1`;
    printing `{}` → `inbox.mjs: another answer`; never ending, `timeoutMs` 300 → `inbox.mjs: no answer within 300 ms`; a
    `cli.js` that fails → its own `ended`, and the inbox fake, which writes a marker at an absolute path the test names,
    never ran.
  - "stages inbox.mjs into the version folder on Windows, and never off it": `stage(…, 'win32', null, inbox)` →
    `<cli>/9.9.9/inbox.mjs`; `stage(…, 'darwin', null, inbox)` → no `inbox.mjs` in `dir`.
- [ ] **Step 2: Run** `npx vitest run src/lib/selfUpdate.spec.ts -t "inbox follower"`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above; the header's manifest example gains `"inbox"` (Windows only).
- [ ] **Step 4: Run** `npx vitest run src/lib/selfUpdate.spec.ts` (all of it) and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 6: the self-updater stages `inbox.mjs` on Windows

**Depends on:** 5. **Effort:** xhigh (the background updater on every Windows install).
**Test that must fail first:** a new `describe('the automatic updater and inbox.mjs (Windows)')` in `selfUpdate.spec.ts`.

**Files:**
- Modify: `cli/src/lib/selfUpdate.ts` (`startSelfUpdater`'s tick only)
- Test: `cli/src/lib/selfUpdate.spec.ts`

**Interfaces:**
- Consumes: `downloadBuild`, `inboxOf`, `runCanary(…, inboxBuf)`, `stage(…, inboxBuf)` (Task 5).
- Changes: `verified` gains `inboxBuf: Buffer | null`; the key is
  `` `${entry.version} ${entry.cli.sha256} ${entry.notify.sha256} ${inboxOf(entry, platform)?.sha256 ?? '-'}` ``; the download is
  `downloadBuild(entry, platform, download)`; both `runCanary` calls pass `verified.inboxBuf`; `stage` passes
  `ready.inboxBuf`. The `refused` back-off and the `DigestMismatchError` refusal apply to it as to `cli.js`.

- [ ] **Step 1: Write the failing tests** (the `installed()` and `serveUpdate()` pattern of the Windows describe at
  "judged against the build cli\\current names", `platform: 'win32'`, `inboxSource` a fake that prints `{"off":true}`):
  - "on Windows, stages the manifest's inbox.mjs beside cli.js after its canary": staged `['9.9.9']`;
    `cli/9.9.9/inbox.mjs` equals `inboxSource`.
  - "off Windows, never fetches inbox.mjs": `platform: 'darwin'`, the manifest names it; no fetch of its URL; staged.
  - "still updates from a manifest with no inbox, or one of the wrong shape": staged; no `inbox.mjs` in the folder.
  - "refuses a build whose inbox.mjs fails its canary, and stages nothing": inbox `process.exit(1)` → staged `[]`,
    `cli\current` unchanged, `console.error` holds `failed its canary (inbox.mjs: exit 1)`.
  - "refuses an inbox.mjs that does not match its manifest": `does not match its manifest`, nothing staged.
  - "an inbox.mjs download that fails is a failed check, tried again": its first fetch 404s → nothing staged,
    `check failed (will retry)`; the next tick stages.
  - "downloads again a build whose inbox.mjs changed, whatever else stayed": the first tick's `withLock` throws
    `SpawnLockBusyError`; the manifest then names other inbox bytes (same version, `cli`, `notify`); the next tick fetches
    the inbox again and the folder holds the new bytes.
- [ ] **Step 2: Run** `npx vitest run src/lib/selfUpdate.spec.ts -t "inbox.mjs (Windows)"`. Expected: FAIL.
- [ ] **Step 3: Implement** the tick changes above.
- [ ] **Step 4: Run** `npx vitest run src/lib/selfUpdate.spec.ts src/services/updaterProcess.spec.ts` and
  `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 7: `harness update` stages `inbox.mjs` on Windows

**Depends on:** 5. **Effort:** high.
**Test that must fail first:** the inbox cases in `updateCommand.spec.ts`.

**Files:**
- Modify: `cli/src/lib/updateCommand.ts`
- Test: `cli/src/lib/updateCommand.spec.ts` (`steps()`'s fakes take the new shapes, then the new cases)

**Interfaces:**
- Consumes: `CliBuild`, `downloadBuild`, `runCanary(…, inboxBuf)`, `stage(…, inboxBuf)` (Task 5).
- Produces (`UpdateStepsDeps`): `downloadCli: (entry: UpdateEntry) => Promise<CliBuild>` (default
  `downloadBuild(entry, process.platform)`); `canary: (cliBuf: Buffer, dir: string, version: string, inboxBuf: Buffer |
  null) => Promise<CanaryResult>` (default `runCanary` with its defaults and `inboxBuf`); `stage: (dir: string, cliBuf:
  Buffer, notifyBuf: Buffer, version: string, inboxBuf: Buffer | null) => void` (default `stage(dir, cliBuf, notifyBuf,
  version, process.platform, null, inboxBuf)`). The step's `build` carries `inboxBuf` from download to canary to stage.

- [ ] **Step 1: Write the failing tests:**
  - "hands the build's inbox.mjs to its canary and its stage, and installs it": `downloadCli` gives an off-printing
    inbox; the stage fake records it; `result.cli` is `installed`.
  - "keeps the build in use when its inbox.mjs fails its canary": inbox `process.exit(1)` through the real canary →
    `result.cli` `failed`, the log `✗ the new build failed its self-check — keeping v1.0.0`, `cliOnDisk()` unchanged,
    nothing staged.
  - "installs a build that has no inbox.mjs": `inboxBuf` null → `installed`, the stage fake given `null`.
- [ ] **Step 2: Run** `npx vitest run src/lib/updateCommand.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the deps and the step's carrying of `inboxBuf`.
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 8: [Ken] `upload-cli.sh` uploads it, `merge-manifest.mjs` names it

**Depends on:** 2 (`dist/inbox.mjs` exists only from it). **Effort:** high (the production release).
**Test that must fail first:** `src/scripts/mergeManifest.spec.ts` (new).

**Files:**
- Modify: `cli/scripts/merge-manifest.mjs`, `cli/scripts/upload-cli.sh`, `cli/RELEASE.md` (what the script uploads; the
  GCS layout and manifest shape; the daemon's update step 3: on Windows also `inbox.mjs` when the manifest names it),
  `cli/README.md` (the `ADAPTER_CLI_DIR` row: the files a release has)
- Create: `cli/src/scripts/mergeManifest.spec.ts`

**Interfaces:**
- Produces: `merge-manifest.mjs <src> <dst> <key> <version> <cliUrl> <cliSha> <cliSize> <notifyUrl> <notifySha>
  <notifySize> [<inboxUrl> <inboxSha> <inboxSize>]` → `data[key] = { version, cli, notify, inbox? }`, sizes as numbers.
  10 or 13 arguments; any other count: a usage line on stderr, exit 2, `<dst>` not written. Task 12's `fake-cdn.sh` is
  its other caller.
- `upload-cli.sh`: `dist/inbox.mjs` is required beside the other two (one error line names the three); uploaded to
  `harness/cli/<version>/inbox.mjs` with the same immutable cache-control; its own `gcs_refuse_republish` line, run
  with the other two before any `gcs_cp`; its url, sha256 and size handed to `merge-manifest.mjs`; the closing echo
  names it.

- [ ] **Step 1: Write the failing tests** (`spawnSync(process.execPath, [script, …])` in a temp folder):
  - "writes inbox beside cli and notify when given its url, sha256 and size": `inbox: { url, sha256, size: 99000 }`.
  - "writes no inbox without those arguments, as before".
  - "keeps every other key of the manifest": a `commander` key survives; the old `cli` entry is replaced whole.
  - "refuses one or two of the inbox arguments, and writes nothing": exit 2, `<dst>` absent.
- [ ] **Step 2: Run** `npx vitest run src/scripts/mergeManifest.spec.ts`. Expected: FAIL (no inbox; 11 arguments exit 0).
- [ ] **Step 3: Implement** both scripts and the two docs. `upload-cli.sh` is never run here (it publishes):
  `bash -n cli/scripts/upload-cli.sh` only.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 9: [Ken] the staging publish carries it

**Depends on:** 2. **Effort:** medium.
**Test that must fail first:** the two refusals below in `publishCliStaging.spec.ts`.

**Files:**
- Modify: `cli/scripts/publish-cli-staging.sh` (header; `INBOX_OBJECT`; the already-there loop; the bundle check; the
  entry written by its `node -e` gains `inbox`; the dry run copies it; the upload)
- Test: `cli/src/scripts/publishCliStaging.spec.ts`

- [ ] **Step 1: Write the failing tests:**
  - "refuses a version whose inbox.mjs is already there, before the bundle and without uploading": the `ls` shim answers
    only `*/inbox.mjs` → exit 1, stderr holds
    `gs://s3-autonomous-upgrade-3/harness/staging/cli/0.4.18-dev.win1/inbox.mjs already exists`, the log holds its
    `storage ls`, and no ` cp `.
  - "stops on a bundle without inbox.mjs": `CLI_DIST_DIR` holding `cli.js` and `notify.mjs` only, `DRY_RUN=1`,
    `--no-build` → exit 1, stderr names `inbox.mjs` and `is missing`; `DRY_RUN_OUT` not created.
- [ ] **Step 2: Run** `npx vitest run src/scripts/publishCliStaging.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec. Expected: PASS. (The dry run with a real bundle is in Verification.)
- [ ] **Step 5: Commit** red, then green.

### Task 10: [Ken] `release.yml` checks and lists it

**Depends on:** 8 (the published manifest names it from then on). **Effort:** medium.
**Test that must fail first:** one case in `windowsWorkflows.spec.ts`.

**Files:**
- Modify: `.github/workflows/release.yml` ("Bundle and publish the CLI"'s comment; "Verify the published release the way
  a daemon would": its files loop gains `["inbox", "inbox.mjs"]`; "Read staging back the way install.ps1 will": fetches
  `cli.inbox.url` and compares its sha256 and size with the staging manifest, as it does each pty zip; the release
  notes' table gains `` | \`inbox.mjs\` | [download](${base}/inbox.mjs) | ``)
- Test: `cli/src/scripts/windowsWorkflows.spec.ts`

- [ ] **Step 1: Write the failing test** "checks inbox.mjs as it checks cli.js, after the publish and in staging, and lists
  it": `release.yml` contains `["inbox", "inbox.mjs"]`, the staging read-back step contains `cli.inbox`, and the notes
  contain the row above.
- [ ] **Step 2: Run** `npx vitest run src/scripts/windowsWorkflows.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** (`actionlint` runs in PR CI's `plan` job.)
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 11: [Ken] the local install manifest lists it

**Depends on:** 2 (`windows.yml`'s install job runs this on `cli/dist`). **Effort:** medium.
**Test that must fail first:** `windowsInstallManifest.spec.ts`.

**Files:**
- Modify: `cli/scripts/windows-install-manifest.mjs` (header's inputs; `installManifest`; `main` copies `inbox.mjs`)
- Test: `cli/src/scripts/windowsInstallManifest.spec.ts`

**Interfaces:**
- Produces: `installManifest({ version, cli, notify, inbox, nodeZipName, nodeZip, ptyVersion, ptyZipName, ptyZip })` →
  `cli: { version, cli, notify, inbox: fileRef('inbox.mjs', inbox) }`. `inbox` required.

- [ ] **Step 1: Write the failing tests:** the first case's expected document gains
  `inbox: { url: 'inbox.mjs', sha256: sha('inbox'), size: 5 }` (and the refusal case's base an `inbox`); the script case
  writes `dist/inbox.mjs` and checks `doc.cli.inbox`'s digest and size against the copied file; new "refuses a --cli-dir
  without inbox.mjs": exit 1, stderr names `inbox.mjs`.
- [ ] **Step 2: Run** `npx vitest run src/scripts/windowsInstallManifest.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 12: [Ken] the Windows end-to-end fixtures stage it

**Depends on:** 8 (`merge-manifest.mjs`'s inbox arguments). **Effort:** high (four scripts).
**Test that must fail first:** the layout cases in `fakeCdn.spec.ts`.

**Files:**
- Modify: `cli/scripts/windows-cli-e2e/fake-cdn.mjs` (`stagingLayout`'s `cli` list gains `inbox.mjs`),
  `cli/scripts/windows-cli-e2e/fake-cdn.sh` (`stage` places `$build/inbox.mjs` at `$L_cli_inbox_mjs_object` and hands
  `merge-manifest.mjs` its url, sha256 and size), `cli/scripts/windows-cli-e2e/serve-updates.sh` (`build`'s `shasum`
  line names it; `offer`'s entry gains `inbox: ref("inbox.mjs")`), `cli/scripts/windows-dial-e2e/bundle.mjs` (header
  only: `build-bundle.mjs` already writes `inbox.mjs` beside the desk's `cli.js`)
- Test: `cli/src/scripts/fakeCdn.spec.ts`

- [ ] **Step 1: Write the failing tests:** `layout.cli['inbox.mjs']` equals
  `{ object: 'harness/staging/cli/0.4.18-staging.1/inbox.mjs', url: 'https://cdn.autonomous.ai/harness/staging/cli/0.4.18-staging.1/inbox.mjs' }`;
  `layoutLines(layout)` contains `cli_inbox_mjs_object=harness/staging/cli/0.4.18-staging.1/inbox.mjs`.
- [ ] **Step 2: Run** `npx vitest run src/scripts/fakeCdn.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `bash -n` both shell scripts.
- [ ] **Step 4: Run** the spec. Expected: PASS.
- [ ] **Step 5: Commit** red, then green.

### Task 13: [Ken] `install.ps1` installs it

**Depends on:** 3 (the cases run this tree's `harness.exe` and check it runs `inbox.mjs`). **Effort:** high.
**Test that must fail first:** the real-install cases below. They run only on Windows (`describe.runIf(windows)`), so
red and green are seen in PR CI's windows-e2e (x64 and arm64, "Two real builds" step, `HARNESS_EXE_BIN` this run's
build); on the Mac only the "as written" cases run.

**Files:**
- Modify: `cli/scripts/install.ps1` (`Install-HarnessCli`: its comment; the "already installed" rule; one more
  `Save-HarnessVerified` into staging), `docs/testing/windows-cli-e2e.md` (the layout:
  `cli\<version>\{cli.js,notify.mjs,inbox.mjs,package.json}`, no stable `inbox.mjs`)
- Test: `cli/src/scripts/installPs1.spec.ts` (`build()` takes an inbox option: none, these bytes, a wrong sha256, or a
  raw `inbox` value written into the manifest as is; the fake `inbox.mjs` prints `inbox.mjs ` and its arguments as JSON)

**Interfaces:**
- Consumes: Task 3 (`harness.exe device claude inbox <id>` runs `cli\<version>\inbox.mjs` when it is there).
- The rule: `$inbox = Get-HarnessProperty $Entry 'inbox'`; the folder counts as installed when today's rule holds and,
  only when the manifest has `inbox`, `inbox.mjs` is a file whose sha256 `-ieq` the manifest's; a download saves
  `inbox.mjs` into staging through `Save-HarnessVerified` (sha256 and size) when the manifest has it. What "has inbox"
  means is the updaters' rule (decision 7): `$inbox` is present only when `Get-HarnessProperty $inbox 'url'` and
  `Get-HarnessProperty $inbox 'sha256'` are both `[string]`; any other shape is treated as no `inbox` at all, for the
  "already installed" rule and the download alike, and never throws. A string `sha256` that is not 64 hex digits is
  present and is refused by `Save-HarnessVerified`, as the updaters refuse its mismatch.

- [ ] **Step 1: Write the failing tests** (`describe.runIf(windows)('install.ps1, installing for real …')`):
  - "installs the follower's inbox.mjs, and harness runs it for the follower and cli.js for the rest": the file's bytes in
    `cli\9.8.7\`; `harness.exe device claude inbox 0a1b2c3d-…` prints `inbox.mjs ["device","claude","inbox","0a1b2c3d-…"]`;
    `harness.exe echo x` prints `["echo","x"]`.
  - "installs no inbox.mjs from a manifest without one, and the follower runs on cli.js".
  - "fills in a version folder that lacks inbox.mjs, or holds another": an install without it, then with it
    (`Downloading` printed, the file there), then with other bytes (replaced).
  - "downloads nothing again over an install that holds the same inbox.mjs".
  - "refuses an inbox.mjs that is not the manifest's": exit 1, `failed its checksum`, no `cli\9.8.7`.
  - `it.each` "installs as if absent an inbox of the wrong shape, and does not fail the install": raw `inbox` values
    `'inbox.mjs'`, `null`, `[]`, `{ url: 1, sha256 }`, `{ url }`, `{ sha256 }` → exit 0; `cli\9.8.7` holds `cli.js`
    and `notify.mjs` and no `inbox.mjs`; `harness.exe device claude inbox 0a1b2c3d-…` runs `cli.js`.
- [ ] **Step 2: Run** (Windows only) `npx vitest run src/scripts/installPs1.spec.ts`. Expected: FAIL. On the Mac:
  `npx vitest run src/scripts/installPs1.spec.ts` passes its "as written" cases and skips the rest.
- [ ] **Step 3: Implement** `Install-HarnessCli` and the doc line. Keep the file pure ASCII (its first case checks).
- [ ] **Step 4: Run** the same. Expected: PASS (on windows-e2e).
- [ ] **Step 5: Commit** red, then green.

### Task 14: [Ken] `windows.yml`'s install job runs the real follower

**Depends on:** 3 (`harness.exe` runs `inbox.mjs`), 11 (the job's manifest lists it), 13 (`install.ps1` installs it).
**Effort:** medium (one check in one script, one text case).
**Test that must fail first:** a text case in `windowsCiChecks.spec.ts` (Mac and Linux CI). The check itself runs only
on Windows, in the PR's windows-e2e `install` job ("Check the install", x64 and arm64): its red and green are seen
there and nowhere else, so the PR body says this task is for Ken's side to see. No workflow change: the job already runs
`check-install.ps1 -Version $env:CLI_VERSION`.

**Files:**
- Modify: `cli/scripts/windows-ci/check-install.ps1` (its header's list of what it checks; one check after the version)
- Test: `cli/src/scripts/windowsCiChecks.spec.ts` (`describe('check-install.ps1')`)

**Interfaces:**
- Consumes: Task 3 (`harness.exe device claude inbox <id>` runs `cli\<version>\inbox.mjs`), Task 11 (the install
  manifest names `inbox`), Task 13 (`install.ps1` puts it in `cli\<version>\`).
- The check, after `ok   version`: `Fail` unless `$root\cli\$Version\inbox.mjs` is a file
  (`Test-Path -PathType Leaf`); then `$out = & $harness device claude inbox not-a-session-id`; `Fail` unless
  `$LASTEXITCODE` is 0 and the output, joined and trimmed, is exactly `{"off":true}`; on success
  `ok   the follower answers {"off":true} from cli\<version>\inbox.mjs`. A `Fail` line names the exit code and
  whether the answer differed, never the output. (`cli.js` answers the same; which file ran is Task 13's to show.)

- [ ] **Step 1: Write the failing test** "checks the installed follower: inbox.mjs in the version folder, and
  {"off":true} with exit 0 through harness.exe": `checkInstall` contains `inbox.mjs`, contains
  `device claude inbox not-a-session-id`, contains `{"off":true}` and `$LASTEXITCODE`, and that check's lines come after
  the line holding `ok   version`.
- [ ] **Step 2: Run** `npx vitest run src/scripts/windowsCiChecks.spec.ts`. Expected: FAIL (no such check).
- [ ] **Step 3: Implement** the check and the header line. Keep the file ASCII (the spec's case checks).
- [ ] **Step 4: Run** the spec. Expected: PASS on the Mac; on GitHub, the PR's windows-e2e `install` job prints the new
  `ok` line on x64 and arm64.
- [ ] **Step 5: Commit** red, then green.

---

## Verification

Each check names its machine and its isolation. No check touches production: no bucket, no CDN, no real person's account.

1. **The follower's memory, this Mac (required, a tester's run).** Isolated: a scratch folder of the tester's own, `HOME`,
   `CLAUDE_CONFIG_DIR` and `ADAPTER_DATA_DIR` inside it, `PORT=1` (no daemon), only the started pid read.
   1. `cd cli && BUNDLE_OUT_DIR=<scratch>/build node build-bundle.mjs` (never into `cli/dist`).
   2. `mkdir -p <scratch>/home <scratch>/claude <scratch>/data`.
   3. For `inbox.mjs`, then `cli.js`, twice each, back to back: start in the background
      `env -i PATH="$PATH" HOME=<scratch>/home CLAUDE_CONFIG_DIR=<scratch>/claude ADAPTER_DATA_DIR=<scratch>/data PORT=1 node <scratch>/build/<file> device claude inbox 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`,
      keep its `$!`; 8 s later read `ps -o rss= -p <that pid>` and `kill <that pid>`. The starting shell stays up those
      8 s (the follower ends with its parent). No foreground `sleep` in the agent's shell: a background script or Monitor.
      Never `pgrep -f`, `ps aux`, `ps -o args`.
   4. Expected: `inbox.mjs` at most 70 MB resident (57 MB measured), `cli.js` about 143 MB. The PR body records
      `node --version` and the four numbers.
2. **The staging dry run with a real bundle, this Mac.** `HOME=<scratch>/home DRY_RUN=1 DRY_RUN_OUT=<scratch>/staging
   CLI_DIST_DIR=<scratch>/stage-dist bash cli/scripts/publish-cli-staging.sh 0.0.1-dev.inbox1`. `DRY_RUN=1` touches no
   bucket. Expected: exit 0; `<scratch>/staging/inbox.mjs` exists; `metadata.json`'s `cli.inbox` names
   `https://cdn.autonomous.ai/harness/staging/cli/0.0.1-dev.inbox1/inbox.mjs`, that file's sha256 and its size.
3. **Windows on GitHub: PR CI's `windows-e2e`** (it calls `windows.yml` on x64 and arm64, since `pty/` and `install.ps1`
   change; it runs once the PR is ready). Read, do not start: never dispatch `windows.yml` by hand beside the automatic
   run (`docs/validation-and-release.md`). What it shows: `windows-pty`'s "Rust tests" (Task 3 on Windows), "Contract
   suite … Windows CLI specs" (`src/lib/windows/`, so Task 4), "Two real builds" (Task 13's installs with this run's
   `harness.exe`), and the `install` job (Task 11's manifest of this build, `install.ps1`, and `check-install.ps1` with
   Task 14's line `ok   the follower answers {"off":true} from cli\<version>\inbox.mjs`: the real `inbox.mjs` through
   the real `harness.exe`, on x64 and arm64). The Windows update path has no workflow: it is held by Tasks 5-7's specs.
4. **Local gates, this Mac, at the final commit, after the PM's go:** `python3 scripts/local-checks.py --run` from a
   clean tree (it selects `cli-pty`, `npm run test:terminal-contract`, for `pty/`); its receipts go into the PR body.
   `npm run test:core` is not required (no `cli/src/core/` or `cli/src/services/` file changes; check with
   `git diff --name-only main...HEAD`).
5. **Ken's Windows VM, before the merge (held for the PM; Ken's side runs it with a Claude Code test account, never a
   real person's).** The PM sends PR, head SHA and these steps through ken-pm; one VM at a time.
   1. Before, on the VM's current install (the release it runs; note `harness version`): Harness's Claude Code plugin on
      (`harness device claude enable` if needed), one Claude Code session open in Windows Terminal, 60 s after its start.
   2. Find the follower by its parents only: `$c` = that session's `claude` process id;
      `$h = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$c AND Name='harness.exe'").ProcessId`;
      `$f = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$h AND Name='node.exe'").ProcessId`.
   3. `[math]::Round((Get-Process -Id $f).WorkingSet64 / 1MB)` three times, 10 s apart. Expected: about 103 MB.
   4. This branch's build, made where the repository is: `cd cli && ADAPTER_VERSION=<release X.Y.Z>-dev.inbox1
      BUNDLE_OUT_DIR=<dir>/dist node build-bundle.mjs`; the PR's windows-e2e artifact `harness-pty-windows-<arch>` (this
      head's `harness.exe`); nodejs.org's `node-v24.22.2-win-<arch>.zip` checked against its `SHASUMS256.txt`;
      `node cli/scripts/windows-install-manifest.mjs --out <dir>/manifest --cli-dir <dir>/dist --pty-dir <artifact>
      --node-zip <zip> --version <release X.Y.Z>-dev.inbox1`; copy `<dir>/manifest` and `cli/scripts/install.ps1` to the
      VM.
   5. On the VM: `$env:HARNESS_ALLOW_UNSIGNED = '1'` (a PR payload is unsigned; see open question 1), then
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Manifest <manifest>\install-manifest.json`.
      Check `harness version` says the dev version and `cli\<version>\inbox.mjs` exists. A `-dev` build never updates
      itself, so it stays.
   6. Close the Claude Code session, open a new one, wait 60 s, find `$f` as in step 2, read that one process's
      command line once: `(Get-CimInstance Win32_Process -Filter "ProcessId=$f").CommandLine` ends with
      `\cli\<version>\inbox.mjs device claude inbox <id>`.
   7. Step 3 again. Expected: about 40 to 55 MB.
   8. Report the VM's architecture and Windows build, both versions, Node's version and the six numbers; the VM goes
      back as Ken keeps it.
6. **Proposal for the maintainers (not in this PR):** a bound on the follower's working set in `windows.yml`'s install
   job (start `harness device claude inbox <uuid>` through the installed `harness.exe`, read its working set after 8 s,
   fail above a limit), so a later change that brings the CLI back into the follower is seen on Windows itself.

## Open questions

1. **Can Ken's VM run an unsigned `harness.exe`?** (With the PM: asked of Ken, 2026-11-27.) The PR's payload is
   unsigned. If Smart App Control blocks it, the "after" reading through the real chain needs a signed build (a staging
   release), which this plan does not run; the fallback is to measure `node.exe cli\<version>\inbox.mjs device claude inbox <uuid>` started by hand on the signed
   `node.exe`, which measures the file but not the chain.
