# Desktop test flavor: a pull request's build beside the installed app

Task #2443, requested by 0xken15@gmail.com. 2026-11-03.

## Why

On 2026-11-03 six Desktop test steps (#2418, #2424, #2425, #2428, #2430, #2419) had no Tester. A Team account has no
display. A person's own account can build a branch, but that build is the installed app in all but location:

- it has the installed app's bundle id (`ai.autonomous.harness`, `desktop/macos/Runner/Configs/AppInfo.xcconfig`);
- it talks to the Mac's one daemon on port 18473 (`desktop/lib/core/config.dart`);
- it reads and writes the person's `~/.harness` (settings, E2EE keys, snapshots);
- it signs in and out through the person's own CLI. `harness logout` signs the whole Mac out.

PRODUCT.md, *What matters most* 3 and *Verification is the moat*: work is verified on real machines before it ships.
A Desktop change that no one can run is not verified. This design makes a PR's Desktop build that a Tester runs in a
person's own account without touching that person's app, data, daemon or sign-in.

## What the Tester does

From a checkout of the PR's branch, in a person's own account on a Mac with Xcode and Flutter:

```
python3 desktop/tool/test_flavor.py start     # builds the PR's CLI and Desktop, starts "Harness Test"
python3 desktop/tool/test_flavor.py status    # its home, port, pids, signed-in account
python3 desktop/tool/test_flavor.py stop      # quits it and removes everything it made
```

`start` is the one command. It prints where the test home is and which account it is signed in as. The first `start`
on a Mac asks for the test account's sign-in once (see *Sign-in* below); later runs reuse it.

## How it is kept apart

Everything Desktop and the CLI keep is found from `$HOME` (Dart `homeDir()`, Node `os.homedir()`), except the few
per-user resources below. The test flavor runs with its own `HOME`, and each of those resources is moved too.

| Shared resource | The installed app uses | The test flavor uses | Moved by |
|---|---|---|---|
| App identity, UserDefaults, notifications | `ai.autonomous.harness`, "Harness" | `ai.autonomous.harness.test`, "Harness Test" | the copy's Info.plist, re-signed (as `scripts/build-devices-review.sh` does) |
| `harness://` links (sign-in and share links) | registered | not registered: `CFBundleURLTypes` removed | the copy's Info.plist |
| `~/.harness` (settings, keys, snapshots, logs, CLI data, pid, socket, hook routes, computer id) | the person's home | `<test home>/.harness` | `HOME=<test home>` |
| Daemon port | 18473 | a free port chosen at `start` | `PORT` for the CLI, `--dart-define=HARNESS_DAEMON_PORT` for Desktop |
| The CLI it runs | `~/.harness/cli` or PATH | the PR's CLI, built into `<test home>/.harness/cli` | `HOME` (Desktop looks there first) |
| tmux server | `/tmp/tmux-<uid>/default` | `<test home>/tmux` | `TMUX_TMPDIR` |
| launchd service `ai.autonomous.harness.harnessd` | registered if the person opted in | never touched: the CLI acts on launchd only when a definition exists under `$HOME/Library/LaunchAgents`, and the test home has none | `HOME` |
| Claude Code's Keychain item | `Claude Code-credentials` | `Claude Code-credentials-<sha(test claude dir)>`, so the CLI never reads or rewrites the person's item | `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to `<test home>/.claude` (the CLI's write reads only the second) |
| Codex sign-in | `~/.codex` | `<test home>/.codex` | `CODEX_HOME` |
| Self-update | the installed copy updates | the PR's CLI is never replaced | `ADAPTER_UPDATE_DISABLE=1`; Desktop's updater runs only in release builds |

The test home is a `mktemp -d` folder. Its path, the port and the pids `start` started are written to
`<checkout>/desktop/build/test-flavor/state.json`, and `stop` acts only on those.

## Sign-in

The test flavor signs in as a test account, never as the person whose Mac it is.

- **Which account.** A dedicated Harness account for testing (one for the project), whose Swarm is the throwaway Swarm
  Testers use. *Open: the PM names or creates it (recommended), or picks another option; see the question on the task.*
- **Where it is kept.** In `~/.harness-test/auth`, outside `~/.harness`, set as `HARNESS_AUTH_DIR`. One sign-in per Mac
  is reused by every run. The CLI's own `session.lock` keeps two runs from refreshing it at once.
- **How.** The first `start` runs `harness login --code` in the test home. The code is approved in a browser where the
  test account is signed in: a private window, never the person's own window.
- **Guard.** After sign-in, `start` reads the account id in the test session and in the person's
  `~/.harness/auth/session.json` (`signInAcct`, or for an older session the access token's subject, compared in memory
  and never printed). It only reads the file: it does not run the person's CLI, which could refresh the
  token. If they are the same account, `start` signs the test home out, deletes it, and stops with: "The test copy
  signed in as this Mac's own account. Sign it in with the test account instead."
- **Signing out.** The test copy's own Sign out runs the test home's CLI, so it can sign out only the test session.
  `python3 desktop/tool/test_flavor.py forget` signs the test account out on this Mac and removes `~/.harness-test`.

## Cleanup

`stop` leaves nothing behind:

1. It quits "Harness Test" by the pid `start` recorded.
2. It stops the test daemon with `harness stop` in the test environment.
3. It ends the test tmux server through its own socket (`tmux -S <test home>/tmux/... kill-server`).
4. It deletes the test home and the copied app.

It never stops anything by name or pattern. The test sign-in and the test computer id (`~/.harness-test/computer-id`,
set as `ADAPTER_COMPUTER_ID_FILE`) stay for the next run, so each Mac is one machine in the test account however often
it tests. `forget` removes them and that machine.

## What stops it from signing out the real CLI

- Desktop's Sign out runs the CLI that `HOME` points to, the test home's (`desktop/lib/core/harness_cli_runner.dart`).
- The test CLI's sign-in folder is `~/.harness-test/auth`, never `~/.harness/auth`.
- The test daemon is on its own port, socket and pid file, so Desktop's daemon-owner guard
  (`DaemonOwnerGuard`, which restarts a daemon Desktop did not launch) sees only the test daemon.
- launchd is never asked (see the table).
- The proof is a test (plan task 3): with a fake "real" home holding a session, settings and a LaunchAgents
  definition, and a fake `launchctl` and `security` on PATH that record every call, it runs the PR's real CLI in the test
  environment through start, sign-in status, sign-out and stop. It then checks that the fake real home's files are
  byte for byte unchanged, that launchctl was never called, and that no Keychain call named the person's item.

## Team-written work

Unchanged. The backend refuses to start an agent in a person's account on a task a Team agent worked on
(`TEAM_WRITTEN_WORK`, `backend/src/superTabs/teamWritten.ts`), so a Tester in a person's account never gets such a
branch. The test flavor adds no way around that, and changes nothing in it.

## Checked against PRODUCT.md and ENGINEERING.md

- PRODUCT.md, *Contribution, Safe*: the contributor's files, secrets and accounts are never exposed. Every row of the
  table above, and the guard, exist for this.
- ENGINEERING.md §1 Simple: one script, one build-time define, no new setting in the app. The flavor is a copy of the
  debug build, as the devices-review build already is, not a new Xcode scheme.
- §3 Correct: each risk has a test that fails first (plan).
- §6 Failures are seen: `start` stops with a plain message on a busy port, a missing Xcode or Flutter, a failed build
  or the same-account guard. `stop` reports anything it could not remove.
- §7 Secure: no token is read by the script. It reads only the account identity in the session files, and prints only
  the email. The test account's sign-in stays in its own folder. Two security reviews (sign-in and Keychain isolation).
- §10 Platforms: macOS only. A Desktop test on Linux or Windows is not part of this task.

## Design (docs/feature-design-rules.md)

1. **Growth.** The test home is deleted by `stop`; a home left by a crashed run is listed by `status` and removed by
   `stop`. One test machine per Mac, removed by `forget`.
2. **Concurrency.** Two runs on one Mac have their own homes and ports. They share only the test sign-in, which the
   CLI's `session.lock` guards.
3. **Read cost.** N/A because nothing is stored or synced beyond what the CLI already does.
4. **Scale.** N/A because it is one Tester per run. Ten runs on one Mac are ten homes and ten ports, and `status`
   lists them.
5. **Compatibility.** The installed app's behavior is unchanged: the new define defaults to 18473.
6. **Migration and rollback.** None. Removing the script and the define leaves the installed app as it is today.
7. **Audience.** N/A because no new read path.
8. **Identity.** The test account only. The guard refuses the Mac owner's account.
9. **Failure.** A failed `start` removes what it made and says why. A failed `stop` names what is left.
10. **Platforms.** macOS, a person's own account, with Xcode and Flutter 3.47.2.
