# The remaining Claude Code and Codex facets

What of Claude Code and Codex the core still runs, mapped from source on 2026-10-08. The core's static
import closure comes from bundling `cli/src/core/main.ts` with esbuild, dynamic imports external.
Before batch (a) it was 72,479 lines in 376 files. After it, 72,776 lines in 384 files: the shared
transport, the broker and declared policy came in, and the native readings went out. Line counts are
informational, never a gate.

Every batch keeps the same split. Core keeps authority: the control lease, identity and binding, turn
state, spawning tmux panes, and hook transport and authentication. The engine worker interprets
snapshots or performs one bounded operation under a revocable grant. Inline mode and older masters
compose the same code in process.

## (a) Submission verification: done in this batch

See [engine submission](2026-10-08-engine-submission.md).

| File | Engine-specific behavior | Stays in core | Moved to the worker | Risk |
| --- | --- | --- | --- | --- |
| `lib/sessionInput.ts` | Claude's 3 s window and types-while-busy; the composer and composer-drawn checks; Claude's paste envelope on the recorded prompt | the queue, the lease wait, every Enter and verdict, receipts | the composer reading; `echo` (async) | An enveloped receipt now arrives one worker round trip later. The pane's state is released at once. |
| `core/deviceInput.ts` | `NATIVE`, `draft()`, busy mode (Claude queue, Codex steering from 0.106) | the writer lock, retries, receipts | `nativeDraft` | A missing reading is unreadable, so the Device never presses an Enter on it. |
| `core/turns/funnel.ts` | Native turn boundary for the Device | the funnel | nothing: it reads the declared policy | none |

Still in core and engine-specific, as data or copy: `engines/{claude,codex}/submissionPolicy.ts`
(declared timing), the per-engine wording in `lib/messageHolds.ts` and `core/cardText.ts`, and
`lib/goalCommand.ts` (`/goal` and `/loop` adaptation, synchronous on the input path). The tmux paste
settle in `lib/tmux.ts` is the writer's own and stays in core.

## (b) Hook admission and installers

| File | Engine-specific behavior | Stays in core | Can move | Risk |
| --- | --- | --- | --- | --- |
| `engines/claude/installHooks.ts` (68) | merges hooks into `~/.claude/settings.json` | when to install, and the hook command string (`engines/kit/notifyHooks.ts`) | the settings merge | synchronous write into an engine home at daemon start (`installEngineHooks`) |
| `engines/codex/installHooks.ts` (60) | writes `<CODEX_HOME>/hooks.json` | the same | the file write | also per agent before spawn (`core/agents/create.ts`, restore). It must finish first, or no hook fires. |
| `engines/claude/hooks.ts` (71) | `transcriptFor`, `onStop` (stale check, `/goal` continuation, grace) | `HookTurnContext`: `closeTurn`, `emit`, `drain` | the transcript correction and the Stop decision | `transcriptFor` is synchronous on the hook HTTP path (`hookServer.ts` `knownTranscriptFor`). `onStop` calls back into core. |
| `engines/codex/hooks.ts` (13) | `admit` rejects subagent rollouts (a synchronous 128 KB read) | admission's fail-closed default | the rule | Synchronous in `hookServer.ts`. A worker that is down would reject every Codex hook. `registry.register` repeats the check. |
| `core/engines/hooks.ts` (~20 of 234) | the moved-home install loop | `resolveHookAgent`, `onSessionEnd` | the loop | already best effort |

About 230 lines would leave. Transport, credential, routes and `registry.register` stay.

## (c) Launch, discovery and resume

| File | Engine-specific behavior | Stays in core | Can move | Risk |
| --- | --- | --- | --- | --- |
| `engines/{claude,codex}/launch.ts`, `engines/launches.ts` | argv contracts | building argv | nothing: stays declared data | `buildEngineLaunchArgv` is synchronous, also at restore |
| `lib/engineLaunch.ts` (~90 of 1,416), `lib/codexStartupRetry.ts` (41) | the Codex prelude and retry script | the shell wrapper | the script text | built synchronously into argv |
| `lib/claudeTrust.ts` (129) | trust writes to `~/.claude.json` and Codex's `config.toml` | the trust decision (security policy) | the file reads and writes | writes into engine homes before spawn |
| `engines/codex/portableHistory.ts` (220) | rewrites a rollout for resume | `setTail` before spawn | the rewrite | synchronous, at restore too. The order must be: await the worker, then set the tail, then spawn. |
| `engines/codex/ownLoginProvider.ts` (105) | `-c model_provider=` from `config.toml` | none | all of it | a synchronous read inside an async launch |
| `lib/sessionRepair.ts` (~190 of 716), `lib/captureResumeIdentity.ts`, `lib/handoffDiscovery.ts` | finding a live or resumed session from its pid or transcript | pid and start-marker evidence, the rebind | the readers | all async. Claude's pid record disappears when the process exits, so capture before the kill. |
| `lib/registry.ts` (~45), `lib/claudeProject.ts`, `lib/cwdRepair.ts`, `lib/engineHomes.ts` | transcript roots, Codex child-rollout repair at load, Claude project cwd | `validTranscriptPath` containment, binding | the evidence | synchronous, at load before any worker exists, and on the hook path (`register`) |
| `lib/tmux.ts` (~30) | process signatures, resume-argv table | process identification | nothing: stays static data | read for every process row in every discovery pass |
| `lib/sessionSearch/externals/{claude,codex}.ts`, `lib/transcriptPages.ts` (~90), `lib/transcriptReader.ts` (~70), `lib/transcriptActivity.ts`, `lib/codexHomeProbe.ts` | listing, paging and probing sessions for adoption | `lineCount`, `forEachLine` | the providers and pagers | async |

About 1,400 lines are pure Claude/Codex logic. Two normalizers stay in the closure through shared
imports:

- **`engines/claude/normalize.ts` (978).** It comes in through `lib/normalize.ts`, which
  `core/transcripts/lastTurn.ts` and `history.ts` import. Command Code and Devin reuse its functions.
- **`engines/codex/normalizer.ts` (771) and `subagent.ts` (271).** They come in through
  `lib/transcriptPages.ts` and `lib/transcriptReader.ts`.

Splitting the shared functions into `engines/kit` frees another 1,000 to 2,000 lines.

## (d) Native control connections: done in the batch after (a)

See [engine native control](2026-10-08-engine-native-control.md). The map below is as it stood before it.

| File | Engine-specific behavior | Stays in core | Can move | Risk |
| --- | --- | --- | --- | --- |
| `lib/codexSessionLifecycle.ts` (176) | `connectCodexControl` spawns `codex app-server proxy` and speaks JSON-RPC over a WebSocket. `stopSharedCodexSession` pauses the goal, interrupts the turn and archives the thread. | the stop and close authority (`stopAgentService.ts`, `closeAgentService.ts`), the SIGTERM after it | the whole protocol, under a revocable grant | Async. The `guard()` checks between RPC steps need cancellation across the process boundary. An effect already sent is never retried. |
| `lib/runtimeActivity.ts` (~45 of 88) | `CodexActivityReader`: one long-lived connection per `CODEX_HOME`, `thread/read` mapped to working or idle | the activity probe's decision | the reader | async. Today core keeps a child process and a socket open. |

About 220 lines would leave, and with them core's only native child process and socket for an engine.
`lib/apiConnections.ts` and `ownLoginProvider.ts` open no channel.

## Proposed order

1. **(a) Submission verification.** Done here.
2. **(d) Native control connections.** The smallest and fully async. It removes a native child process
   and a long-lived socket from core, the kind of work that crashes, hangs or leaks. It reuses the
   control-grant pattern of model and question control.
3. **(b) Hook admission and installers.** The installers become worker operations that core awaits
   before it spawns or binds the hook port. Admission needs a bounded async path, or a declarative rule
   core can evaluate in line, so a worker that is down does not reject every hook.
4. **(c) Launch, discovery and resume.** The largest. It has the most synchronous call sites (registry
   load, discovery tables, argv). Split it into sub-batches:
   - resume preparation and trust writes (async callers, before spawn)
   - session repair and adoption readers
   - splitting the shared normalizers into `engines/kit`
   - static tables and argv stay declared data

This puts (d) before (b) and (c), unlike the order the owner listed. The reason: async work that is
self-contained goes first; work with synchronous hot paths and dependencies at daemon start goes last.
If the owner's order holds, (b) can go next with the same split. Each batch keeps behavior unchanged
and adds an end-to-end case where the worker is lost mid-operation.
