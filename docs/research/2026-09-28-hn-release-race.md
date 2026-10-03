# hn 0.1.1 release: concurrent window creation

A fresh check of the merged hn source found a real asynchronous creation race.
[CI run 36384795117](https://github.com/autonomous-ai/openharness/actions/runs/36384795117)
failed on Linux x86-64 because window 18 contained `FAST_19`.
The corresponding [0.1.0 release run](https://github.com/autonomous-ai/openharness/actions/runs/36384791426)
was cancelled before its publish job ran. Its tag remains a record of that
unpublished candidate; the corrected candidate is 0.1.1.

## Cause and correction

`new-window` reserved a tab but placed its eventual shell in the active tab when
the asynchronous response arrived. Standalone CLI commands did not wait for that
response. Concurrent requests also shared a print format, reply slot, detached
selection restoration and last-created hook target.

The correction anchors placement to the reserved window ID and restores detached
selection before yielding. Each command waits only for the shell it started and
receives that request's output, error and exact session/window/pane identity.
After-hooks retain that identity through their own asynchronous commands.
Background shells open their streams, initial geometry survives placement, and
killed targets delete newly created shells. Cancelled command replies fail rather
than becoming empty successes. Popups retain their separate lifecycle.

The TUI release workflow now runs the native terminal integration before building
and publishing. The CLI release workflow separately publishes and byte-verifies
the current installer only after a production bundle passes its download checks.

## Deterministic regression

`async_creation()` in `tui/tests/native-terminal.py` pauses only its private local
supervisor, then overlaps one plain and two printed detached window requests.
It checks that unrelated reads still finish, creation replies remain pending,
commands and output reach the intended windows, and a later selection is never
replaced by an older completion. Two further requests exercise delayed
`after-new-window` hooks. Killing a reserved target must fail its caller and leave
no supervisor child behind.

The original frozen build fails this case. An independent tmux reviewer verified
the corrected frozen build against real tmux 3.5a and found no blocker. The final
macOS binary has SHA-256
`f27733e1bef6136ae63a1812bce65000ced42feddb83f8489b8298180664ddc5`.

Local verification passed:

- 122 release unit tests.
- Full mock-daemon E2E and local-shell lifecycle, including exact 176 KB paste,
  detach/crash recovery and daemon loss/reconnection.
- Full native terminal comparisons: concurrent creation, cancelled-target cleanup,
  retained exits/signals, hooks, respawn, startup typeahead and 1-by-1 geometry.
- All four native and rendered terminal-attribute comparisons.
- Release workflow YAML and installer shell syntax checks.

These tests use frozen copies, disposable homes, guarded ports, explicit hn and
tmux sockets, and cleanup of their own processes. They do not use a real daemon,
real harnesses, default servers or the installed hn. The creature remains outside
the TUI. The publication checks and outcome are recorded below.


## Published release

[PR #413](https://github.com/autonomous-ai/openharness/pull/413) was squash-merged
at `610eb989313009d036c9fd7520382af972139142`. Its tree exactly matches the tested
candidate `d14b09f64f6af47653559a5b3699b498da2bff3d`.

- [Final CI](https://github.com/autonomous-ai/openharness/actions/runs/36387140310):
  all four jobs passed, including static Linux x86-64/ARM64 builds and integration
  suites, the full CLI suite and coverage gate, and backend compatibility.
- [hn 0.1.1](https://github.com/autonomous-ai/openharness/releases/tag/v0.1.1_tui):
  [release run 36389263332](https://github.com/autonomous-ai/openharness/actions/runs/36389263332)
  passed its tests, all four platform builds, and publication.
- [CLI 0.3.21](https://github.com/autonomous-ai/openharness/releases/tag/v0.3.21_cli):
  [release run 36390063621](https://github.com/autonomous-ai/openharness/actions/runs/36390063621)
  passed bundle publication, downloaded checksum/version checks, installer CDN
  byte verification, and GitHub release publication.

All four hn binaries were downloaded from the public manifest and matched its
SHA-256 values. The GitHub release assets have the same digests. The downloaded
macOS ARM64 binary reported `hn 0.1.1 (tmux 3.5a)`.

| Platform | Published SHA-256 |
| --- | --- |
| macOS ARM64 | `fdc31b129738e24d5722ea6ac7d59fa5b04ab927ef07a4512d80c0de6617edc1` |
| macOS x86-64 | `9f24b991183faba34372c3980cff2e74578dc47a5eb46b0e5554b9a9d327a6e0` |
| Linux ARM64 | `77006d8f87f638827df13386ecbd7b543ea185fb43f0117a2e74f4a43a782440` |
| Linux x86-64 | `bf9a1090badddeb726474875afbdb22b6976957c8520c65997912c24520a2061` |

The public CDN installer matched the released source, with SHA-256
`ae952b99a2a7d9ecf59642445183ad980e4a4976183f2882c2f7f7c8fad85a9b`.
A fresh macOS installation in a disposable home installed CLI 0.3.21 and hn 0.1.1.
The installed hn launcher created and drove a private native shell successfully.
The CLI's `harness tui --install` path was also verified in a second empty home
and downloaded the same binary. All owned runtime processes were cleaned up.

For the install smoke test only, hn and tmux version probes received explicit
private socket flags, and hn probes received the guarded port. The published
installer was not modified; its downloads, checksums, launchers and runtime
installation logic were exercised unchanged. No existing hn installation or real
daemon was changed. Fresh-install validation was on macOS; Linux runtime behavior
is covered by the two CI integration jobs above.
