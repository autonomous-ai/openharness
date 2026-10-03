# hn launcher repair for existing installations

CLI 0.3.21 could report “Already on the latest version” while the shell reported
`hn: command not found`. The fresh installer wrote both launchers, but self-update
replaced only `cli.js` and `notify.mjs`. Installations created before hn shipped
never received its launcher.

The installed CLI now adds a missing `hn` command on entry. This includes daemon
handoffs after automatic updates and commands such as `harness update`, even when
there is no newer bundle. The script delegates to the existing `harness` launcher
with `tui`, preserving its managed Node runtime and any `--no-updates` pin.

The migration checks that it is running the installed bundle and that the
existing executable harness launcher names that bundle. Checkout builds and
staging canaries do not migrate the installation. A complete script is published
with an exclusive hard link, so concurrent invocations cannot truncate it or
replace an existing file or symlink. A read-only directory does not prevent the
CLI or daemon from starting.

An old updater whose daemon is stopped only stages the new bundle; the migration
runs when the new CLI is first invoked. `harness version` suffices. A running
daemon invokes the new bundle during its normal update handoff.

## Regression check

After building the bundle in `cli/`:

```sh
npm run typecheck
npm test
npm run bundle
node scripts/test-hn-upgrade.mjs
```

CI runs the packaged regression check. It uses a disposable home with spaces and
an apostrophe, an existing harness launcher, a loopback update manifest on guarded
port 19449, and a recording TUI fixture. It checks the already-current update,
argument and update-pin preservation, concurrent starts, and an existing hn
symlink. All owned files and the HTTP fixture are removed afterward.

For a real upgrade comparison, provide a saved previous release bundle and an
optional frozen native hn binary:

```sh
node scripts/test-hn-upgrade.mjs dist/cli.js /tmp/previous-cli.js /tmp/frozen-hn
```

This additionally reproduces the previous release's missing command after an
already-current update, exercises its original download/checksum/canary/staging
path, and runs the repaired launcher against the frozen native binary. Every
native invocation has a disposable home, explicit socket prefix and port; no
real daemon, harness or installed hn is used.


## Published CLI 0.3.22

[PR #417](https://github.com/autonomous-ai/openharness/pull/417) added the migration.
[PR #418](https://github.com/autonomous-ai/openharness/pull/418) corrected the
native cancellation test's baseline: a pane-dead event precedes asynchronous PTY
reaping, so the test now waits for only its two live anchor children before
checking that cancellation leaves no extra child.

[CLI 0.3.22](https://github.com/autonomous-ai/openharness/releases/tag/v0.3.22_cli)
was published from `27064e2f2eba6df23f91b1fc733f6862be2a8f03`.
[The release workflow](https://github.com/autonomous-ai/openharness/actions/runs/36398977008)
passed publication, downloaded checksum/version checks, installer verification,
and GitHub release creation.

[Final CI](https://github.com/autonomous-ai/openharness/actions/runs/36398238429)
passed all four jobs at `7e947723a5b06fc94848d88df85fa36922fe5a3c`: the full CLI
suite, packaged upgrade regression, updater coverage, static Linux x86-64/ARM64
builds and native integrations, and backend compatibility. The release commit's
CLI, hn, store and workflow files match that tested revision; four unrelated
device firmware files landed during the merge. Local macOS checks passed
7,084 CLI tests, with 37 opt-in/platform skips, typechecking, and the native
terminal suite against the published hn 0.1.1 binary.

The public downloads were verified independently after publication:

| Artifact | SHA-256 |
| --- | --- |
| CLI 0.3.22 | `bd728d59965c1d44302154886aedb33d7cdf67bf32c432d7013d4c5f62c451c1` |
| notify.mjs | `a8ac3ccfcf1499507843e22c2533a6fe14dea6f3944d207f27c8f2d8b139a4fa` |
| CDN installer | `ae952b99a2a7d9ecf59642445183ad980e4a4976183f2882c2f7f7c8fad85a9b` |

The original published 0.3.21 updater installed the downloaded 0.3.22 bundle in a
disposable home. An already-current update then created hn, preserved arguments
and the update pin, tolerated concurrent starts, and preserved an existing hn
symlink. A separate old-install fixture had neither hn nor a native client;
`harness version` repaired its launcher, and the first `hn --version` downloaded
and ran checksum-verified hn 0.1.1. The actual invocation supplied the guarded
port and private socket flags described above. All owned runtime processes were
cleaned up. The native TUI remains hn 0.1.1, with creatures outside its interface.
