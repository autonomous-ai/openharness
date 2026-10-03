# App reliability — September 28, 2026

This pass resumed the September 27 checkpoint and reconciled it with current
main. The earlier external-engine work and releases remain intact. Main already
contained PR #367's stale-dialog protection, so this branch preserves its newer
reviewed-question and spoken-answer validation and adds only the missing guards.

## Changes and regression evidence

| Area | Result | Evidence |
| --- | --- | --- |
| CLI launch modes (#371) | `harness new` supplies a default permission mode only when the selected engine implements it. Explicit choices still undergo daemon validation; store harnesses use the underlying engine. | The imported regressions failed before the change; launch and argument tests pass. Adapted from PR #383, `0551e7c6`, by Silexperience210. |
| Desktop sign-out, expiry, and guest recovery | Account content is removed immediately, local panes restore from the saved desk, the expiry explanation survives, and a new sign-in waits for layout rekey/write/teardown. Failed or cancelled guest sign-in stays usable; Retry completes an interrupted guest restore. Local-manual fixtures never start the real daemon. | Nine native-desktop state regressions cover local/remote panes, delayed or failed persistence, cancellation, and missing guest inventory. A failed layout write preserves the old machine ID and leaves guest recovery retryable. The first six failed on the old implementation. Extends PR #325 by jaylfc. |
| File/image drops (#73) | Only visible writable panes accept drops. Deferred reads and clipboard completion recheck the pane, session, and stream before delivering input. | Five widget tests cover cached tabs, zoom, and changes during reads. The cross-tab regression fails against main's implementation and passes with the fix. |
| Lock ownership (#59) | Process timestamps use a fixed locale and UTC. Versioned generation evidence prevents PID reuse; legacy or unknown evidence is conservative. New timestamp records leave the legacy comparison field empty, so an older daemon cannot steal a live new lock during an upgrade. | Daemon and standalone-hook tests cover both migration directions, locales, PID reuse, Linux ticks, unreadable timestamps, and dead PIDs. A live process smoke test also varies locale and timezone. |
| Hermes managed launchers (#372) | Daemon discovery and the standalone hook recognize both direct imports and `runpy` Python bootstraps, including custom installation directories. Matching requires an actual Python inline launcher and masks string literals before interpreting code. | Five new discovery/hook cases failed before the fix. Positive and negative cases pass afterward. A real Python `-I -I -c` process in a disposable tmux server is discovered and validated. Extends main's `0d779626`. |
| False terminal eviction | A failed tmux or process-table query remains `unknown` instead of becoming `gone`. The unused boolean validation wrapper and obsolete comments are removed; resume still uses `checkSessionRuntime`. | Both controlled subprocess failures reproduced the old false eviction. Coordinator, backend, and resume tests pass. Live smoke testing recovers from `unknown` to `alive` after restoring the process probe. Addresses one concrete cause related to #105 and corrects #58's obsolete description. |
| Question routing | A remembered question cannot be redirected to another agent with identical dialog text. Concurrent answers using agent and session aliases share one canonical agent lock. | Two additional regressions, together with main's existing reviewed-answer validation. |
| Native accessibility input (#249) | Native terminals expose the editable semantics already used by the browser. Accessibility insertion updates the platform buffer; a subsequent echo or typed character does not repeat the phrase. Read-only terminals expose no editing action. | Four new macOS/Linux-platform widget variants failed before the change. Keyboard, IME, focus, and drop tests pass. This verifies the app's accessibility insertion path, not Wispr Flow itself. |
| Resume process identity | A resume that becomes ready from process evidence persists the verified identity before announcing readiness. Attachment and Stop need not wait for discovery or a delayed hook. | The real Claude resume fixture exposed a null PID after reopening; a focused unit regression reproduced it. Native Claude and Codex acceptance tests now pass. The fixture separately waits for rendering and deferred startup hooks, matching current readiness semantics. |
| Device pairing | A selected discovery candidate survives one missed mDNS browse. A fresh endpoint takes precedence, and pairing still requires authenticated device identity. | The regression fails before the fix; all 188 device tests pass afterward, including wrong-code, unknown-device, reconnect, and revocation cases. Adapted from PR #354, `ce725639`, by 69tc. |
| Dependency reproducibility | The pnpm lockfile now includes the existing slugify dependency and its two transitive dependencies, at the same versions already present in the npm lockfile. | Linux CI initially stopped before tests because the dependency was missing. The repaired lockfile passes pnpm 11's frozen-lockfile check without changing package versions. |

The process-launch portability integration cases now have an explicit 15-second
test budget. A full run under simultaneous native-build load exceeded the old
five-second unit-test default. Production subprocess deadlines are unchanged.
Linux CI also exposed the Cursor hook fixture's accidental reliance on an unset
host XDG config directory. The existing test fails with a temporary XDG root
before the isolation fix. Equivalent lockfile and Cursor-fixture fixes landed
in main with PR #365 during verification; the final rebase retains main's
versions and drops the duplicate repair commits.
The newly merged native TUI fixture exposed another race on Linux ARM64: pane
death can be visible before its queued `pane-died` hook runs. The fixture now
waits for delivery and then requires exactly one hook for every rapid exit.
Missing hooks still time out, and duplicate hooks still fail with engine/index
diagnostics. The complete fixture passes locally against `hn` and tmux.
The ARM64 rerun confirmed that fix, then exposed first paint occurring before
the command socket was ready. Cleanup now waits for session readiness after
measuring first paint; the tiny-PTY check waits for its file contents, not just
file creation. Timing and exact-size assertions remain intact.

## Validation

The final base is `02496104` (PR #365). The complete CLI suite was rerun after
that integration. Desktop files are unchanged from the complete desktop run
on `0eeef83b`, including PR #411's Git-context changes. Local checks use macOS
26.6.2 arm64, Node 22.23.1, and Flutter 3.47.2.

- CLI typecheck and build pass. Full suite: **5,786 passed, 37 skipped**.
- Desktop: **3,872 passed, 12 skipped**. Analysis has **12 existing informational
  notices in vendored xterm**, no errors or warnings.
- Native macOS terminal integration: **2 passed**. The normal debug
  `lib/main.dart` application was rebuilt afterward, replacing the fixture build.
- Native Claude and Codex acceptance: saved history and native startup hooks,
  repeated immediate pause/resume, stable logical identity with new tmux/PID
  identity, existing-process attachment, receipt replay, recovery of missing
  conversation IDs, persistence, and preservation of neighboring panes and a
  surviving shell all pass.
- Live Hermes-style Python bootstrap: discovery, healthy validation, failed
  process-query handling, recovery, and locale/timezone-stable lock identity pass.
- Native TUI acceptance passes: retained exits/signals and exactly-once hooks,
  history, holder-crash recovery, respawn, startup typeahead, first paint without
  a terminal-identification reply, and the actual 1×1 PTY size.
- Installed-engine multiplexer suite on macOS with tmux **3.5a**: **9 passed,
  9 skipped**. Discovery and process-only deletion preserve the pane for Claude
  **2.1.283**, Codex **0.154.0**, OpenCode **1.18.32**, Pi **0.85.1**, Hermes
  **0.18.0**, and Grok **1.0.34**. The Grok `agent` alias, backend lifecycle,
  and literal/submitted input cases also pass. Cursor, CommandCode, Devin, Muse,
  Amp, Kilo, Antigravity, and Copilot have no verified installed executable;
  the terminal-only row has no engine binary. Those rows are unavailable,
  not passing. These checks establish process discovery and lifecycle, not
  credentialed model calls. The installed Hermes uses the older venv launcher;
  the separate Python smoke above covers the managed inline launcher.
- Docker-backed local/remote full-stack E2E was **not run**: neither configured
  Docker endpoint was running. The native acceptance and smoke tests above use
  their own temporary data, profiles, loopback services, and tmux sockets.

No test changed the user's daemon, tmux server, credentials, engine hooks, or
installed application. The native application build stays inside this worktree.

Local receipts for this run are under `/private/tmp/harness-reliability-*`;
focused red/green receipts include `harness-probe-*`, `harness-pair-*`,
`harness-resume-identity-*`, `harness-accessibility-*`, and `harness-hermes-before.log`.
Repeat the Docker-backed stack using
[the development recipe](../development.md#isolated-end-to-end-testing).

## Remaining report triage

These are the limits of this pass, not a claim that every possible reliability
problem is resolved.

| Report | Current finding / remaining work |
| --- | --- |
| #49: GUI cannot find Homebrew tmux | Current main resolves through the user's shell, updates the daemon PATH, and falls back to managed tmux. Startup can also serve without a tmux backend. Existing path/provisioning tests pass; the old second fatal preflight is no longer the daemon path. |
| #45: closing a pane removes it from other tabs | Current main has per-tab close and shared-pane ownership. Tests preserve another tab's terminal and send no `agent_delete` when closing a view. Global Stop is a separate operation. |
| #41: reopening shows the top of scrollback | Current main follows delayed initial output and preserves a parked reader's position through reconnect/tab changes. Terminal tail and reconnect tests pass. No fresh reproduction of the reported restart jump here. |
| #67 / #92: store installation fails without useful diagnostics | Current main sends install phase, error code, and detail, and renders failure-specific recovery guidance. Store/install tests pass. A specific Marp or KiCad failure on another machine still needs its install/doctor log. No real store install was performed in the user's environment. |
| #105: WSLg pane freezes while tmux continues | The confirmed probe-failure eviction defect is fixed, alongside existing reconnect, stale-connection, keyframe, and stream-routing tests. A Windows/WSLg reproduction and the full Docker-backed transport chain remain unverified. |
| #50: macOS exiting process retains a port | Current main serializes daemon spawn/handoff and performs SIGINT/SIGTERM cleanup. The reported kernel exit state and unreleasable socket were not reproduced; those mechanisms do not establish a fix for that OS failure. |
| #284: native raster crash on macOS 27 with mirrored mixed-DPI displays | Needs the affected display setup and full native crash report. The native fixture passed on this host; that is not proof for the reported configuration. |
| #249: Wispr Flow insertion | The missing native accessibility entry point is fixed and tested. End-to-end dictation using Wispr Flow remains to verify with that application. |
| #107 / #108 / #110: WSL media, viewer, and unified-exec failures | Need the affected WSL/WSLg runtime. No Windows-specific fix is claimed from macOS tests. |
| #39: device notification selects the wrong agent | The original report has no reproduction details. Desktop routing tests cover machine/stream identity across tabs; the physical-device notification path still needs a concrete failing trace. |
| #29: idle tmux sessions accumulate | Idle does not prove a conversation is disposable. Existing Stop/resume retains history; automatic idle cleanup is a retention/product-policy decision, not a safe inferred deletion. |
| #93: pin store dependencies to immutable revisions | Supply-chain policy and repository-pinning work remains separate from this runtime reliability pass; current path-containment fixes on main were preserved. |
| PR #366: final-pane tab close / launch-progress UX | Not imported wholesale. It changes workspace behavior beyond these confirmed fixes and still needs its own review. |

Other inventory entries request features or platform support (workflows, SCM,
Windows/psmux, localization, terminology, completion). They are not treated as
verified runtime defects. Recent main changes already cover trust groups, mobile
launching, and web sharing; this pass preserves those changes.
