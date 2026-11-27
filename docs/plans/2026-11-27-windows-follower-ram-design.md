# Windows: the dial's inbox follower starts on a small file of its own (2026-11-27)

## The report

Ken's Windows VM (backlog, 2026-11-25): the follower `harness device claude inbox <session id>` (deviceClaude/inbox.ts,
#4585), one `node.exe` per Claude Code session with Harness's dial plugin on, holds about 103 MB working set, about
twice what the VM notes expected. It runs for the whole life of each session, so ten sessions hold about 1 GB.

## What it holds (measured)

macOS, Node 22.23.5, the release bundle (`BUNDLE_OUT_DIR=<scratch> node build-bundle.mjs`), the follower in its 60 s
retry wait (isolated HOME, CLAUDE_CONFIG_DIR and ADAPTER_DATA_DIR, PORT=1, no daemon), 8 s after start, each run twice
back to back, 2026-11-27:

| Started on | Resident | JS heap used |
|---|---|---|
| `cli.js`, before (the whole CLI evaluated) | 158 MB | 48 MB |
| `cli.js`, with T1 below (entry.ts sends it to `inboxCommand.ts`) | 143 MB | 40 MB |
| `cli.js`, its lightest command (`__swarm-shell-guard`) | 136 MB | |
| a 99 KB bundle of the follower alone | 57 MB | 8 MB |
| bare `node` | 39 MB | 3.6 MB |

Nothing in the follower grows: no transcript is read, no cache, no list. Evaluating the whole CLI cost about 15 MB.
Nearly all the rest is Node reading and compiling the 13 MB `cli.js`. That cost is the same for every command, so no
change inside `cli.js` removes it: the follower has to start on a file of its own. The follower runs only on Windows.
On macOS and Linux the plugin's mod reaches the daemon's socket itself (`plugins/harness-device/hooks/device.js`:
`state.windows`, `followOnce`), so nothing changes there.

## What changes

1. **Already on the branch (T1).** `deviceClaude/inboxCommand.ts` holds the follower's wiring, its stdout writer and
   `pluginActs`, and `inboxSessionOf(argv)` is the one match of `claude inbox [id]`. `entry.ts` runs it before
   `cli.js`'s CLI loads, and `command.ts` runs it too, for the per-file dev build. `entry.spec.ts` holds that the
   follower loads no `cli.ts`, `core/`, `tui/` or `lib/e2ee/`.
2. **A release file `inbox.mjs`, built and shipped as `notify.mjs` is.**
   - `build-bundle.mjs` builds it with the bundle's own options (version, banner, `asciiOnly`) from a small entry,
     `src/inboxEntry.ts`, which imports `./lib/connectWait.js` first as every entry does, and runs
     `runInbox(inboxSessionOf(process.argv.slice(3)), …)` when `process.argv[2] === 'device'`. The arguments are the
     same as `cli.js` gets, `device claude inbox <id>`. Any other line (no `device`, no match) prints `{"off":true}`
     and exits 0, as the follower does for a refused id.
   - It is never written at run time, by `cli.js` or anything else (PM, 2026-11-27): only the installer and the
     updater put it into a version folder, checked against the manifest's sha256 like the other files.
3. **`harness.exe` runs it** (`pty/src/command.rs`). The match, applied to the arguments after `hn_args`: the first is
   exactly `device`; of the rest, words starting with `-` are dropped, at most three are left, and the first two are
   `claude` and `inbox` (the same as `entry.ts` and `inboxSessionOf`). An argument that is not UTF-8 never matches.
   On a match it runs `node.exe <cli\<version>\inbox.mjs>` with the same arguments, unchanged, when
   `cli_js.with_file_name("inbox.mjs")` is a regular file (not a folder) inside `cli\`, the check `resolve` applies to
   `cli.js`. Otherwise it runs `cli.js`, as today: an install from before this change, a version an older updater
   staged, a manifest with no `inbox`. The choice is a helper in `command.rs`: `launcher.rs`'s `Resolved`, which
   `harness-launch.exe` shares, does not change, and neither does `harness-launch.exe`. Only `bin\harness.exe` is
   covered: when the mod finds no `bin\harness.exe` it runs `harness` from PATH (`device.js` `harnessOf`), which is
   the same program.
   `harness.exe` reaches people in the pty payload, not the CLI release (`ptyInstall.ts` `BIN_FILES`,
   `install.ps1`): until a pty build with this change is promoted (`release.yml` `promote_pty`) and swapped in, every
   follower runs `cli.js` with T1's short path.
4. **The release carries it** (Ken's side owns the CLI release process: the PM sends them this section before the
   merge):
   - `cli/scripts/upload-cli.sh`: `dist/inbox.mjs` is required beside `cli.js` and `notify.mjs`, uploaded to
     `harness/cli/<version>/inbox.mjs`, with its own refuse-republish line (`gcs_refuse_republish` refuses per object),
     and its url, sha256 and size are handed to `merge-manifest.mjs`, which writes `inbox: {url, sha256, size}` into
     the version's one entry (one manifest for every OS). `merge-manifest.mjs` takes positional arguments; its other
     caller, `cli/scripts/windows-cli-e2e/fake-cdn.sh`, passes them too.
   - `cli/scripts/publish-cli-staging.sh`: the same for staging.
   - `.github/workflows/release.yml`: the post-publish check of each file, the staging check, and the release notes'
     file table name `inbox.mjs`.
   - `cli/scripts/windows-install-manifest.mjs` (used by `.github/workflows/windows.yml`): it copies and lists
     `inbox.mjs`. So do the Windows end-to-end fixtures that build a manifest (`cli/scripts/windows-cli-e2e/fake-cdn.mjs`,
     `serve-updates.sh`, `cli/scripts/windows-dial-e2e/bundle.mjs`), so those runs test the new path, not only the
     fallback.
   - The Windows install, `cli/scripts/install.ps1`: when the manifest has `inbox`, it downloads `inbox.mjs` into the
     version folder and checks its sha256 and size (`Save-HarnessVerified`). A version folder already there counts as
     installed only when it also holds an `inbox.mjs` with the manifest's sha256, and that rule applies only when the
     manifest has `inbox`, so a reinstall fills it in. There is no stable copy (unlike `cli\notify.mjs`): harness.exe
     runs it from the version folder.
   - The pty payload that carries the new `harness.exe` is released and promoted as today (section 3).
   - macOS and Linux (`install.sh`, `install-cli.sh`, the Unix updater's stage) do not fetch it: nothing runs it there.
5. **The updater on Windows stages it, both of them.** The daemon's self-updater (`selfUpdate.ts`) and
   `harness update` (`updateCommand.ts`, its own `downloadCli` and `stage`) read `inbox` as optional
   (`UpdateEntry.inbox?`). An `inbox` field of the wrong shape is ignored, as if absent, and never rejects the entry.
   They download and check it only on Windows, and `cliVersions.ts` `writeVersionFolder` writes it into the version
   folder. The self-updater's record of what it verified (its key and its buffers) carries the inbox sha256 too, so a
   release that changes only `inbox.mjs` is picked up. A folder is reused as the same bytes only when it also holds
   the same `inbox.mjs`, and that comparison applies only when the manifest has `inbox`, so a manifest without it
   never rewrites a folder. `isVersionFolder` and `currentCli` do not require it, so older version folders still
   count for a rollback and for retirement.
   **Canary.** The updater already runs the staged `cli.js` before it switches to a version (`runCanary`). On Windows
   it also runs the staged `inbox.mjs` once, `device claude inbox` with a refused id, and expects `{"off":true}` and
   exit 0 within the canary's time limit; a failure rejects the version as a failed `cli.js` canary does. This
   matters because the mod has no fallback of its own: a launcher that exits non-zero, or six quick ends in a row,
   is taken for an older Harness and the follower is not started again (`device.js` `restartAfter`).
6. **Docs**: `cli/RELEASE.md`, `cli/README.md` (the files of a release), `docs/testing/windows-cli-e2e.md` (the
   layout), the devices row in `cli/AGENTS.md` (how the follower starts on Windows), `entry.ts`'s and `inbox.ts`'s
   headers.

## Tests (each red first where it is behavior)

- `inbox.mjs` stays small: a spec builds the bundle (as `leanEntry.spec.ts` does) and holds `inbox.mjs` under 200 KB,
  with none of the code only the whole CLI carries (a marker of `cli.ts`, of `core/`, and of `ws`). Red: no
  `inbox.mjs` is built.
- `inbox.mjs` follows: run on its own with an isolated home and a refused id, it prints `{"off":true}` and exits 0.
- `harness.exe`: `pty/tests/harness_command.rs` with an install whose fake `inbox.mjs` and `cli.js` each print their
  own name: `device claude inbox <id>` runs `inbox.mjs`, any other command and an install without the file run
  `cli.js`, and a file outside the version folder (or a folder of that name) is not run. `launcher.rs` unit tests if
  the choice lives there.
- The manifest and the installers: `windowsInstallManifest.spec.ts`, `installPs1.spec.ts` (with and without `inbox`,
  and a version folder missing it or holding another sha256), `publishCliStaging.spec.ts`, and a new spec for
  `merge-manifest.mjs` (with and without the inbox arguments).
- The updaters: `selfUpdate.spec.ts`, `updateCommand.spec.ts` and `cliVersions.spec.ts`: a manifest with `inbox`
  stages it on Windows and not elsewhere, one without it (or with a bad one) still updates, a folder staged without
  it is written again, one with the same files is reused, a release that changes only `inbox.mjs` is staged, and an
  `inbox.mjs` whose canary fails rejects the version.

## Verification

- Local (this Mac): the bundle built, `node dist/inbox.mjs device claude inbox <uuid>` held in its retry wait as above:
  resident at most 70 MB (57 MB measured), against 158 MB from `cli.js`.
- The Windows build of the install manifest on GitHub (`windows.yml`), when it can be run by hand.
- Ken's Windows VM, before the merge (a check held for the PM): the follower's working set on the current release and
  on this branch's build, by the numbered steps in the PR body. Expected about 103 MB before and about 40 to 55 MB
  after.

## Design (docs/feature-design-rules.md)

Reviewed revision: this file. Each line: answered / N/A because …

1. Growth: one more file in each Windows version folder, about 100 KB, removed with its folder by the retirement that
   removes `cli.js` (`retireUnused`). A running follower names its folder in its command line, so that folder is kept,
   as one running `cli.js` keeps it today.
2. Concurrency: N/A. The file is written only by the installer and the updater, into a temporary folder renamed into
   place, as today.
3. Read cost: the follower reads 100 KB instead of 13 MB at each start. One more download of about 100 KB per update,
   on Windows alone.
4. Scale: per Claude Code session about 100 MB less resident (macOS measure), so ten sessions hold about 1 GB less.
   The size bound in the bundle test is the first warning.
5. Compatibility: an old client ignores the manifest's new `inbox` field (its parser picks the fields it knows). A new
   client reads it as optional, so an old or staging manifest without it still updates. An old `harness.exe`, or a
   version folder without the file, runs `cli.js`, which already takes the follower's short path (T1).
6. Migration and rollback: none stored. A rollback to an older version folder runs `cli.js`. Removing the file from
   the release leaves every install on `cli.js`.
7. Audience: N/A, no data is exposed. The file is public like `cli.js`.
8. Identity: N/A. The follower runs as the same user and does the same as before.
9. Failure: a missing `inbox.mjs`, or a folder of that name, runs `cli.js`. A corrupt file cannot reach a version
   folder: it is checked against the manifest's sha256. A broken build cannot either: the updater's canary runs it
   before the switch (section 5), because the mod would take a follower that keeps failing for an older Harness and
   stop starting it. A follower that fails at run time anyway ends with the same lines and back-off as today.
10. Platforms: Windows (x64 and ARM64) runs it. macOS and Linux have no follower, and their installers and updater do
    not fetch it. The release uploads it for every platform, in the one manifest.
