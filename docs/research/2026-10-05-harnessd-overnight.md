# harnessd overnight, 2026-10-04 to 10-05

Everything in "Merged" is on main. Nothing is released.

## Read this first

**Security, in released versions too: a message approved permission prompts.** A message sent to a Claude Code or Codex agent while it showed a permission prompt (from the app, the phone through the relay, or the orchestrator) pressed the prompt's highlighted "Yes". The prompt drops the paste, and the Enter confirms. The same answered an open question with its first option. It was found from the engines' source and proven end to end (#821). Every message now goes through one writer that types only into the engine's own composer, re-checks the screen right before its Enter, and otherwise refuses and says why (#821, #828, #831, and the composer change). **Ship this release soon for this alone.**

## In one paragraph

harnessd's core is a set of modules that own sessions (agents, terminals, transcripts, turns, input, questions). Everything else is a service that can fail on its own.
- **Services:** search, the viewers, workspaces and the teams' prompt scopes each run in their own process by default, supervised by the master; one that crashes, hangs or leaks costs only itself. Each process loads only its own code, so the whole daemon idles at about 470 MiB RSS.
- **Requests:** models and the Store answer their own requests, and every core request has left the socket's switch.
- **The master:** supervisable by launchd or systemd (opt-in), and it replaces itself on update without losing its pid.
- **Testing:** end-to-end rounds, three code reviews and a release rehearsal found and fixed well over 80 real defects. Most are things people do every day: closing the lid, running fish, keeping a work account in `CLAUDE_CONFIG_DIR`, renaming a tmux session, a full disk, a slow link, an old tmux, a permission prompt that opens while a message is being typed.

## Merged

| PR | What |
|---|---|
| #757 | Services can run in their own processes (search first), supervised like the core. Rules for coding agents (`AGENTS.md` per layer) and `architecture.spec.ts`. |
| #758 | Services answer their own requests. The Store is a service. |
| #760 | A 64 MB floor under every engine's whole transcript reads. Compared with v0.3.57: nothing differs. |
| #762 | hn's `terminal_info` is answered (no build ever had). 50 agents end to end. |
| #767 | Dead agents stop showing as active when tmux dies. No turns replayed live after a restart. |
| #768 | A full disk loses nothing the daemon answered. Awkward and vanishing folders. |
| #769 | An engine that freezes. The first handoff. |
| #772 | A person's `set -g destroy-unattached on` no longer ends every agent. Shell startup files. |
| #773 | A paused daemon (Ctrl-Z, a paused VM, a swap storm) is no longer taken for a hung core. A master killed while its core starts no longer leaves the core holding the port. fish, tcsh and nushell users can start agents. An updated engine is asked again whether it takes its permission flag. `E2E_WORKERS` and `E2E_BUNDLE`. |
| #774 | `session_get` moves into the core. |
| #775 | Viewers can run in their own process. |
| #776 | The models service answers the models requests. |
| #779 | Agents bind when Claude Code's or Codex's data lives elsewhere (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). |
| #780 | One window's inspect can't swallow another window's close; a reply to a window that left is no longer broadcast, nor queued unencrypted for the relay. |
| #781 | launchd and systemd supervision, opt-in (`harness service install`). |
| #782 | Workspaces can run in their own process. |
| #784 | Devices D0: the fleet (⌘K across machines) is a service; two daemons can be two machines end to end. |
| #789 | Two daemons on one computer no longer take each other's panes or conversations. An agent whose tmux session is renamed or pane moved stays active. |
| #790 | A tmux socket removed under a running server is made again, not taken for a dead server. |
| #791 | The master re-executes itself on update, keeping its pid, with a probe first and a marker that rolls back a master that dies after the exec. |
| #792 | Replies to the relay's requests go only to the client that asked, sealed. |
| #794 | The teams' prompt scopes can run in their own process; a journal brings every change once, in order. |
| #795 | A wake no longer unbinds a working agent; on macOS a clock step is no longer taken for a reboot. |
| #796 | Agents made and closed all day leak nothing; a message arrives as one prompt. |
| #797 | Engines updated in place: an uninstalled engine's restart is refused before anything stops, and more. |
| #798 | Devices D1: the dial reaches the fleet through the core's port. |
| #799 | **Security:** on tmux 3.2a/3.3a a message could end its own bracketed paste and type the rest as keystrokes; control characters are neutralized in every paste. |
| #802 | The relay under stress, as a phone sees it. **The phone app needs the same two client changes.** |
| #805 | Every core request has left the socket's switch. |
| #806 | A held event loop: Node's `execFile` timeout read as success with empty output, so live panes read as gone; probes are honest now (`lib/patientExec.ts`). |
| #807 | The update path under hostile conditions (round 40), 8 fixes. |
| #810 | A cancelled close stays cancelled when the canceller hadn't read the other process's plan. |
| #812 | A close after its task holds across a daemon restart (the flake was the fake engine). |
| #813 | An agent is no longer named after the machine when its name changes; compat re-checked against v0.3.57 and v0.3.58. |
| #814 | Review fixes: tmux socket revival on Linux; the master's re-exec stop and services; round 40 interplay. |
| #816 | Codex pursuing a goal, or browsing its transcript, is no longer read as idle. |
| #817 | Round 40b: a full disk is no verdict on an update; a throwing teardown still hands over; downloads give up on a stalled link. |
| #818 | A message is never typed into Codex's transcript browser or Claude Code's Rewind menu. |
| #819 | A stop during a restart never leaves an agent with no engine; two restarts at once; a supervised core waits out its orphan. |
| #821 | **Security:** a message never approves a permission prompt or answers a question. |
| #822 | Agents work on tmux older than 3.0 again (RHEL 8, Debian 10); terminals on tmux older than 3.2; Harness paints only its own panes. |
| #825 | A Codex agent resumed after the tmux server died mid-turn no longer shows the interrupted message starting anew. |
| #826 | The core's event loop: no blocking canary, unpack or version check; a deadline per reconcile pass; guarded transcript readers; a corrupt device file can't put the core in safe mode. |
| #827 | The release rehearsal, and the bug it caught: updating from 0.3.58 would have lost every service until the next restart. |
| #828 | More screens a message is never typed into: update, trust and sign-in prompts, history search, Codex's pager and find. |
| #829 | **Every service in its own process by default, each loading only its own code**: idle 842 → 470 MiB RSS (541 → 203 MiB physical). `HARNESSD_SERVICES=none` is the escape hatch; a `lean-off` file turns lean loading off. |
| #830 | The tmux backend's spec is deterministic, and can no longer reach the developer's own tmux server. |
| #831 | Review fixes: a retried Enter never approves a prompt; wrapped prompts in narrow panes are held; a full disk spares the master; an offline hook keeps a harness, its mode and its planned close; and nine more. |
| #832 | Review fixes: a v0.3.58 master and a build staged during probation; slow links update; an orphan's exit is restarted by launchd/systemd; a refused restart on old tmux stops nothing; and seven more. |
| #834 | The end-to-end suite runs the hooks the daemon installs, as Claude Code and Codex run them. Six real bugs fixed, among them text typed while an engine exited running as a shell command. |
| #837 | A message is typed only into the engine's own composer, and the screen is read again right before its Enter. A permission prompt opening mid-paste no longer gets the Enter. |
| #839 | **Release blocker found by the final verification:** with every service in its own process, a signed-in daemon's services were refused for good (the core matched their machine id, which differs from a signed-in account's). Services are now taken by their per-boot token; `e2e/signedIn.e2e.ts` runs a signed-in daemon end to end. |

## Verified on main

On main as of #837 (`3e9a1d90c`), from a clean worktree:
- `tsc` clean; `test:core` 723 and `test:harnessd` 211 tests, both at 100%;
- **the full end-to-end suite: 345 tests in 55 files**, from the bundle;
- the full unit suite: every file that failed under load passes when rerun alone;
- the release rehearsal from published 0.3.58 and 0.3.57, signed out: both pass.

The signed-in rehearsal failed there and found #839. On main as of #839 (`3489ea22f`):
- the release rehearsal from 0.3.58, signed in and signed out: both pass;
- signedIn, serviceProcesses, lean, composer and questions end to end: 32 of 32.

Installed on the owner's machine (`v0.3.58-dev.3489ea22f`): the master, the core and four service processes started; all four services connected while signed in; all 19 agents came back.

## Before a release

1. **Dogfood an update.** The update path, the master's start (lean bundles) and every service's process changed. Install main on a computer you use (`make install-cli` installs a `-dev` build, which leaves the release train until `harness update --force`), use it, then check the release with the rehearsal: `REHEARSE_FROM=<published cli.js> npm run test:e2e -- releaseRehearsal`.
2. `make release-cli`.

## Decisions (made overnight, confirmed 2026-10-05)

- **Memory:** every service in its own process costs about 570 MiB RSS against about 300 MiB for v0.3.58. `HARNESSD_SERVICES=none` is the escape hatch.
- **Messages are refused, never forced:** no Esc is pressed for anyone; a message waits while any dialog or picker is open, and the person is told what to do.
- **A deliberate stop right after an update is no verdict on the build** (safe mode, not a rollback).
- **A signed-out daemon queues nothing for the cloud.**
- **Old tmux (before 3.0) works with features left out on purpose** (grids refused, some styling per window).
- **Experimental features stay untouched until after the release;** teams still runs in its own process.

## After the release (decided)

- **Round 30** (branch `e2e-round-30`): Ctrl+Z or SIGSTOP of an engine no longer ends its pane. It rewrites the launch script every agent runs under; its review's fixes are in progress.
- **The engine interface** (`docs/design/2026-10-05-engine-interface.md`): 365 per-engine branches in 62 shared files behind one interface, 31 steps; steps 1–2 done on branches.
- **The core boundary, next** (`docs/design/2026-10-06-core-boundary-next.md`): the core's process loads 111,892 lines; the target is at most 61,000, enforced by a size test.
- **Codex 0.160 model switching:** match the picker's rows by display name, then widen the version check.
- **The phone app:** show why a message was held (it ignores the daemon's `error` frames today), and round 34's two relay fixes.
- **Two daemons on one computer:** each data folder gets its own hook command.
- **Supervision:** the desktop app registers through `SMAppService`; Linux enables linger with supervision; `harness reset` keeps the log folder.
- **Experimental features** (devices D2, cross-machine ⌘K, teams' restart state, the dial under stress): parked.

## The tests that only run when asked

| Test | How |
|---|---|
| The release rehearsal | `REHEARSE_FROM=<published cli.js>` (`REHEARSE_TO`, `REHEARSE_EXPECT_SERVICES`, `REHEARSAL_MEMORY`) |
| Compared with a release | `COMPAT_FROM=<bundle>` |
| Upgrade from a release | `MIGRATION_FROM=<bundle>` |
| Full disk | `DISKFULL=1` (macOS) |
| Scale | `SCALE_AGENTS=50` |
| Soak | `SOAK_ROUNDS=300` |
| Chaos | `CHAOS_SEED=<n> CHAOS_OPS=150` |
| Parallel / bundle | `E2E_WORKERS=4 E2E_BUNDLE=1` (the fastest full run) |
