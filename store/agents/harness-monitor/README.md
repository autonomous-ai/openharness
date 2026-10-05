# Harness Monitor

Inspect harnesses across connected machines and decide what to stop or delete. The workspace footer
shows only **Harnesses N**; click it to select the existing Harness Monitor tab, creating one when
needed. The footer does not poll resource metrics. The tab retains the standard 70% viewer / 30%
assistant split, including loading, failures and restore. Opening it submits no model prompt.

The default view lists open harnesses. **Stopped harnesses** exposes retained sessions for cleanup;
offline inventory never enables actions. Storage comes first: **Workspace**, **Session data**, then
RAM, CPU and GPU. Workspace size is the default descending sort. Project/worktree files and
conversation data are never combined into one disk figure. Shared folders repeat on individual
rows but count once in workspace totals.

Search, machine/activity filters, sortable/resizable columns and Overview, Resources and AI usage
presets remain available. Unknown readings sort last. Arrow keys select; Enter or double-click
opens Inspect. Freeze updates disables actions until live readings return.

Each row has **Stop Harness** and **Delete Harness** buttons:

- **Stop** ends running work and closes its panes, keeping history, configuration and files.
- **Delete** opens one confirmation directly from the row or Inspect. It shows two independent
  checkboxes, each with its size and full path: **Session data** and **Worktree data**. Available
  options start checked. Nothing is removed until the person confirms; neither option selected
  disables Delete. Main project folders and worktrees used by another harness cannot be selected.
- **Session data** removes only this conversation's verified native history and Harness checkpoints,
  search history, saved metadata and retained harness. Unchecked worktree files stay. Some native
  stores have unsupported schemas or dependent conversations; their session option is unavailable.
  Shared database space becomes reusable but its file may not shrink immediately. Engine-wide
  caches and older conversations from `/clear` are not removed.
- **Worktree data** removes the exact reviewed checkout folder, including ignored dependencies and
  build output. Dirty worktrees require explicit consent to discard uncommitted and untracked files.
  The owning daemon stops the harness, revalidates the checkout and uses `git worktree remove`.
  The main checkout, branch and commits stay. Unchecked session data remains as a stopped harness;
  recreate the checkout to resume later. Locked or nested worktrees and detached commits without
  a saved branch are protected. Selecting both removes the worktree first, then the session data;
  if only part succeeds, the result says what was already removed and is never retried automatically.
- **Inspect** prominently shows the full working folder, worktree path and main project path, with
  copy buttons and an explanation of cleanup eligibility. Opening Inspect only reads these facts.

Deletion is one harness at a time, never automatic. Reviews expire after two minutes and are bound
to the machine, harness and conversation. Changed identities, paths or worktree status require a new
review. Cancel is the default. A lost response is uncertain and is never automatically retried.

## Metric definitions

| Metric | Meaning and availability |
| --- | --- |
| CPU % | Interval CPU across owned processes and children; 100% is one core, so totals can exceed 100%. macOS and Linux. The first sample is unknown. |
| RAM | Process-tree resident memory, in rounded MB/GB. Shared pages can overlap. Nested harness roots are excluded from their parent. Shared Codex servers appear separately and count once. |
| GPU % | GPU use of the harness process tree. macOS reads IOAccelerator clients owned by each PID: Apple Silicon AppUsage and Intel/AMD accumulatedGPUTime counters. GPU nanoseconds divided by the sample interval give percent. Linux reads NVIDIA process utilization. Summed use can exceed 100% across contexts/devices. Initial samples, context changes, resets and unavailable drivers show —. Cloud inference is not local GPU use. |
| GPU memory | NVIDIA compute allocations on supported Linux drivers. macOS and unsupported counters show —. |
| Workspace | Allocated disk space of the entire working folder (project, linked worktree or subfolder), from bounded `du` reads cached for one minute. Shared and nested canonical folders count once per machine in totals. Delete reviews the full worktree root before deletion. |
| Session data | Allocated conversation-file and checkpoint bytes, or estimated conversation content within a shared native database plus checkpoints. Excludes project/worktree files. Cached for one minute; unsupported or unreadable stores show —. |
| Disk read/s / write/s | Physical process-tree I/O deltas from Linux /proc/<pid>/io. Restricted counters, resets and macOS show —. |
| Transcript | Individual conversation-file size when reported. Shared databases show —. |
| Tokens | Conversation input plus output, with cached input counted once. Claude, Codex and OpenCode use the existing incremental daemon ledger. Other frameworks remain visible with unavailable token fields. |
| Input / output / cached input | Input includes cache reads/writes. Cached input is a subset, not an extra charge. Reasoning is included in output once. |
| Tokens/min | Recent change in conversation totals across distinct ledger updates, measured using local receipt time. Includes input/cache; not model generation speed. Session changes, counter resets or stale updates clear it. |
| Last active | Daemon conversation activity, not filesystem modification time. |

Model, framework, machine, project, branch, folder, process count, start time and identity columns
provide context. There is no invented dollar cost: subscription plans, caching and provider prices
cannot be inferred reliably from total tokens.

Totals describe the filtered harnesses and their shared servers. ≥ marks partial totals; — means
unavailable, never measured zero. CPU/GPU use whole percentages; storage and RAM use rounded MB/GB.
The viewer polls local inventory every four seconds and linked machines every fifteen seconds while
visible. Storage work is cached and bounded separately; it does not wait on the terminal-input queue.
The daemon verifies PID birth identity and bounds process probes and directory walks. Older daemons
retain basic inventory but require updating for new metrics and deletion actions. Actions stay
machine-scoped through the paired bridge; remote deletion requires an encrypted owner connection.

## Design references and checks

[Activity Monitor](https://support.apple.com/guide/activity-monitor/view-information-about-processes-actmntr1001/mac)
informs sortable columns, filtering, a focused inspector and an explicit stop review.
[btop](https://github.com/aristocratos/btop) informs process-tree accounting, resource sorting and
pausing display updates. This monitor adds conversation usage and machine identity to those patterns.
GPU and I/O definitions follow [NVIDIA's process telemetry](https://docs.nvidia.com/deploy/nvidia-smi/index.html)
and [Linux procfs](https://www.kernel.org/doc/html/latest/filesystems/proc.html).
The macOS investigation used [Stats' GPU reader](https://github.com/exelban/stats/blob/master/Modules/GPU/reader.swift)
to locate IOAccelerator data and [GPUI's process GPU probe](https://github.com/longbridge/gpui-kit/blob/main/crates/fps/src/gpu/macos.rs)
to verify the per-process counters. Stats' whole-device percentages are never included in harness totals.

`npm test` uses isolated policy/state fixtures. `node test/preview.mjs` serves synthetic sessions and
simulated stops and deletions, without a daemon bridge or model call. Daemon checks live in harnessResources,
harnessTelemetry, agentTokenUsage and backendSocket specs. Desktop tests cover footer scope,
count-only behavior, layout and tab reuse; `tool/check_swarm_titlebar.sh` checks native clicks/layout.
Real Linux NVIDIA counters still require hardware validation; parser fixtures do not establish
support for every driver.
On macOS, `cd cli && RUN_MACOS_GPU=1 npm test -- src/lib/macosProcessGpu.integration.spec.ts`
compiles a disposable Metal workload with the Command Line Tools and verifies that only its
harness gets nonzero GPU use while a separate idle harness stays at zero. It stops only its own
fixtures. Apple Silicon parsing is covered by fixtures; Intel/AMD has been checked on hardware.

The hps CLI offers explicit stop/open and reviewed cleanup commands; old pause/resume names remain compatibility aliases.
Rules/pins live in ~/.config/harness/policy.jsonc; receipts live under ~/.harness/monitor/.
Nothing automatically stops sessions. The assistant keeps its saved configuration, and its header offers the shared agent and model controls.

New OpenCode sessions use `opencode/muse-spark-1.3-contributor-free` with automatic approvals and xhigh effort. **Contributor permits Meta to train on prompts and responses.** The Assistant model disclosure keeps this visible. There is no automatic paid fallback, and existing sessions retain their saved agent/model settings.

## Credit and stewardship

Built by Autonomous for Harness, MIT. See [LICENSE](LICENSE). The Harness CLI owns process identity,
telemetry and lifecycle; this package owns the table and hps. Engine artwork is reused from the
desktop; attribution is included beside the copied icons.
