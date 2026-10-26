# PTY host rollover and delivery: end-to-end results

Date: 2026-10-21. Branch `feat/windows-pty-rollover` at `90e426cdd`. This is Task G5.2; the spec's testing section is
[Testing in the design](../superpowers/specs/2026-10-20-pty-host-rollover-design.md#testing). Machine: the Windows 11
ARM64 VM only. The owner decided to skip the x64 test PC, so the dial on COM3 is not covered.

## What was built

- **Terminal host payloads (arm64)** from the Windows workflow on the branch, `release=true` (payload only, the
  tests are not run; the same `cargo build --release` as the full run). One run per version, because the workflow's
  concurrency group is per ref and a second run cancels the first:
  - 0.4.901: [run 39575143666](https://github.com/autonomous-ai/openharness/actions/runs/39575143666);
  - 0.4.902: [run 39575521100](https://github.com/autonomous-ai/openharness/actions/runs/39575521100);
  - 0.4.904: [run 39578332728](https://github.com/autonomous-ai/openharness/actions/runs/39578332728).
  - 0.4.903 reused 0.4.902's bytes under a manifest with a wrong sha256.
- **CLI bundles** built locally from this tree, non-dev: `0.4.40-e2e.1` (N), `0.4.41-e2e.1`, and `0.4.42-e2e.1` with
  the `version --json` answer patched to `"ptyProtocol":3` in the bundle (the only change).

## How it was driven

A throwaway standard user (not in Administrators) was created on the VM and reached over SSH by key. The Mac served a
fake HTTPS CDN (`fake-cdn.sh` with `vm-cdn.ps1`, as in the [Windows CLI run](windows-cli-e2e.md)); the user's
`ADAPTER_UPDATE_URL` pointed at its staging manifest and `NODE_EXTRA_CA_CERTS` at its CA (`vm-cdn-user.ps1`), so the
daemon's updater fetched manifests and zips over HTTPS exactly as a person's would. The release was installed with the
real `irm .../install.ps1 | iex` line. The PTY driver (`cli/scripts/windows-pty-e2e`, bundled to the user's folder)
used the user's own loopback port. Codex was installed with npm; it was not signed in. Claude Code was not installed
(its installer downloads from a host the fake CDN answers for). The VM's `C:\work\e2e` and the admin profile were not
used. Only the arm64 platform is in the manifests.

## Summary

| # | Item | Result |
|---|---|---|
| 1 | Install N (CLI 0.4.40, host 0.4.901) with `install.ps1` from the fake CDN | Passed |
| 2 | Manifest names host 0.4.902: `current-pty`, both `bin\` files and the log, with no `install.ps1` | Passed |
| 3 | Host 0.4.903 with a wrong digest: refused, nothing changes | Passed |
| 4a | CLI needing protocol 3 waits, the log says so | Passed |
| 4b | ... and updates once a protocol-3 payload is served | Not run: no protocol-3 host build exists |
| 5 | After the updater's payload update: a new pane opens on the new host, old panes keep running | Passed |
| 6 | After an `install.ps1` update (CLI 0.4.41, host 0.4.904): same | Passed |
| 7 | Idle agent moves after `QUIET_MS` (same id, scrollback, conversation resumed) | Not run: no signed-in engine (see below) |
| 8 | The terminal is not touched by the mover | Passed |
| 9 | Closing the last pane: the old host exits and its folder goes | Passed, after a held pane was killed (see Findings) |
| 10 | Claude agent | Not run: not installed (installer blocked by the fake CDN names; not signed in anyway) |
| 11 | A tile on screen not moved; another super tab moved; minimize/tray | Not run: needs the desktop UI |
| 12 | Dial on COM3 through the new `harness-serial.exe` | Not run: the owner skipped the x64 PC |

## Results

**1. Install N.** The `irm` line took about 20 s, printed `OK Harness 0.4.40-e2e.1` and `OK terminal host 0.4.901`.
`harness start` brought the daemon up (not signed in, serving this computer only). The daemon log:
`ptyhost: target p2-0.4.901`. A terminal and a Codex agent were created (panes on host 0.4.901).

**2. Payload update.** The manifest was switched to 0.4.902 with no other action. The log:
`newer terminal host available: 0.4.901 -> 0.4.902` (44 s later, the next tick), then `staged terminal host 0.4.902 -
handing over` 60 s after that, `service updater asked to start again`, `core started`, and `the update stayed up -
keeping it` 34 s later. `current-pty` read 0.4.902 and `bin\harness.exe` and `bin\harness-launch.exe` hashed equal to
the 0.4.902 payload's files (and differed from 0.4.901's); both version folders were on disk. The check is two ticks by
design: the first prepares and verifies the payload, the next installs it (`ptyUpdate.ts`, `ready.fresh`). Total from
serving to kept: 2 min 18 s.

**3. Wrong digest.** With 0.4.903 served: `terminal host 0.4.903 was refused (digest mismatch: sha256 mismatch ...)`,
the version folders, `current-pty` and the `bin\` hashes were byte-for-byte as before (the diff of the two snapshots
differed only by the finished probation marker `pty-pending.json`).

**4a. Protocol wait.** With `0.4.42-e2e.1` (protocol 3) served: `newer build available: 0.4.40-e2e.1 -> 0.4.42-e2e.1`
and `0.4.42-e2e.1 needs pty protocol 3; this machine's host speaks 2 - waiting for its payload`. `harness version` still
read 0.4.40-e2e.1. The manifest was put back afterwards.

**5. New pane on the new host.** After step 2 the daemon log read `ptyhost: available (p2-0.4.901, draining)` and
`available (p2-0.4.902)`. Input typed into the pane that was opened before the update was echoed by its shell; a
terminal created after the update was a child of the 0.4.902 host process, the older panes children of the 0.4.901 one
(process tree from a toolhelp snapshot, since WMI refuses a standard user's SSH logon).

**6. After `install.ps1`.** With CLI 0.4.41 and host 0.4.904 served, the same `irm` line printed `Moving the running
Harness from 0.4.40-e2e.1 to 0.4.41-e2e.1 (your agents keep running)...`; afterwards `current-pty` was 0.4.904, the log
read `target p2-0.4.904`, `available (p2-0.4.902, draining)`, and a pane created after it was a child of the 0.4.904
host while the pane opened before (host 0.4.902) still took input.

**7 and 8. The mover.** The Codex agent was at its sign-in screen: it has no session id, so the mover logged
`move <agent>: skipped (no session id)` and the terminal `skipped (a terminal)` at the handover. The agents were idle
with no client attached for more than 300 s (log read 7 minutes after the handover): no move was attempted, the agent
kept its id and pane, and the terminal was untouched. The agent move itself needs a signed-in engine and was not run.

**9. Old host exit.** The old terminal was closed; the host stayed (the Codex pane was still on it, correct). The Codex
pane could not be closed through `agent_delete` (`IDENTITY_UNAVAILABLE ... the native ps probe did not complete`, the
same WMI limit of an SSH logon); it was ended with Ctrl+C instead. Opening the stopped row then started a shell under
the old host with no row of its own, which kept it alive for 5 more minutes. After that process was killed, the host
logged `draining p2-0.4.901 has gone (shut down with no panes left)`, exited, and its version folder was deleted within
the 10 s poll. `.lock` and `.panes` of that instance stayed in `run\`.

## Findings (limits, not fixed)

1. A terminal's row reads `offline` after a payload handover though its shell answers (`list-after`); seen before as G3
   of the Windows CLI run on a CLI-only update.
2. An agent with no session id never moves and keeps its host alive until closed (by design).
3. Opening a stopped agent row put a shell pane under the draining host with no row; not root-caused.
4. A drained host leaves `.lock` and `.panes` in `run\`.

These are in the spec's Known limits.

Fixed after the run: 1 (fdd4129a4: nothing reactivated a shell row after the core marked every row dormant, on any
host), 4 (455b0a2c1: the daemon removes the lock and pane counter with the discovery file). 3 was not a pane made on the
draining host: it was the `afterExit` shell of the Codex pane that was ended with Ctrl+C, kept as a terminal row
(`94184a03`, which the log shows as `move ...: skipped (a terminal)`); no code change, the spec's note on terminals
that never move covers it.

## Clean-up

Done: the user's scheduled tasks, every process of the user, the fake CDN lines in the hosts file (byte-identical to
before: same sha256), the fake CA in `LocalMachine\Root`, the Mac's fake CDN server, the staged files on the VM, the
user's account, and everything under the user's profile except its registry hive files (a loaded hive that Windows had
not released; it goes at the next sign-out or reboot). `C:\work\e2e` was not touched (its `state.json` keeps its
October 15 date).
