# The daemon core, audited

An audit, a plan and one fix (#4238). It measures what the daemon core's process loads and does today, says what
should leave it and in what order, and records the rule it is held to. The design it continues is
[2026-10-03-harnessd.md](2026-10-03-harnessd.md) and [2026-10-06-core-boundary-next.md](2026-10-06-core-boundary-next.md).
Paths are under `cli/src/`; line numbers are from `main` at 5bceb0fede (2026-11-12).

The owner's direction, verbatim (anh Dee, 2026-11-12): "i want to keep the core really small and secure. everything
else is a sub component. at run time, the same. core is small and secure. everything else is running in their own
process. … protect the daemon core."

## In short

- **The core's process grew 38% in five weeks.** It loads 98,437 lines in 556 files, against 71,244 in 332 on
  7 October, when the last plan's moves had landed. Nothing stopped it: the test that guards the core names the
  folders it must not load, and the growth came in files no list named.
- **With the Swarm on, the default, it loaded 30,724 more:** the Swarm's whole service, which runs in its own
  process, was loaded into the core by one re-export and never run there. #4238 fixes it: the Swarm's door into
  the core becomes 20 files and 1,987 lines (630 KB to 39 KB in the shipped build, 5.7 MiB to 0.4 MiB of heap).
- **About 22,200 of the 98,437 lines can leave** (23%), 7,500 of them at low risk in changes of a
  day each: code the core loads for one helper, features that run in its process, and engine code.
- **At run time the walls mostly hold.** On a working Mac the daemon is 14 processes; only the gateway holds a
  connection to the outside, and the core listens on this computer alone. But the core is the largest of them
  (412 MiB), and on Harness OS every service runs inside it.
- **The core is the most trusted process and does things it should not:** it runs a command line a service hands
  it, signs any backend call an experiment asks for, and parses bytes that came from outside this computer. Each is
  listed under [Security](#security).
- **The rule is now written where agents read it** (`AGENTS.md`, `cli/AGENTS.md`, `cli/src/core/AGENTS.md`,
  `cli/src/services/AGENTS.md`), and #4238 holds the first door with a test that lists its files one by one.

## The rule

The core is the one process every agent depends on, and the most trusted: it types into every terminal. So:

1. **Small.** It owns sessions only: agents, terminals, transcripts, turns, input, questions, and the door and
   the boundary themselves.
2. **Everything else is a component in a process of its own.** The same at run time: the core loads none of a
   component's code, and starts, serves and stops without any of them.
3. **Secure.** It meets the outside least. What someone other than this computer's owner can shape is parsed and
   checked in the component that faces it. The core runs no command a component hands it and lends its sign-in
   only on routes a component declared.
4. **The core is a process, not a folder.** What counts is what `core/main.ts` imports, wherever the file lives.

The first two are the October design's rule 1 ("No feature runs in the process that owns sessions"). What is new
is that they are measured at run time, that security is part of them, and that they are in the rules files, not
only in a design document.

## How it was measured

- **What the core loads:** the walk `architecture.spec.ts` makes (`closureOf('core/main.ts')`): every static and
  dynamic import under `src`, without `import type` and tests. It passes over three doors that load code only when
  needed: the Swarm's (`superTabs/inCore.ts`, while the Swarm is on), the other engines' (`engines/inProcess.ts`,
  once one of their sessions needs it) and the services' (`services/inline.ts`, only when a service runs in the
  core's process). The same walk was run with each door open, and on the source of 7 October, where it gives the
  71,244 lines that plan recorded.
- **What each file is:** each of the 556 files was looked at (its header, its exports and who imports it; all of
  it where that did not decide) and given a class and a verdict, with the lines that leave, the risk and the
  evidence: [2026-11-12-core-audit/files.tsv](2026-11-12-core-audit/files.tsv). Lines that leave are estimates
  from line ranges. The largest claims were checked again in the code, and measured where a number is given.
- **The shipped build:** the lean bundle of v0.6.51 on a working Mac, and a bundle built with and without the fix.
- **At run time:** `ps` and `lsof` on a Mac that had run about fifteen agents for four hours.

## What the core's process loads

| | Files | Lines |
| --- | ---: | ---: |
| 7 October (b4027cbd1) | 332 | 71,244 |
| Today, the Swarm off | 556 | 98,437 |
| Today, the Swarm on (the default) | 694 | 129,161 |
| The Swarm on, with #4238 | 576 | 100,424 |
| And once a session of another engine than Claude Code and Codex runs | +107 | +16,055 |
| On Harness OS, or with `HARNESSD_SERVICES=none`: every service inside the core | +517 | +113,149 |

Where it grew since 7 October (lines loaded by the core's process, the Swarm off):

| Area | 7 October | Today | Change |
| --- | ---: | ---: | ---: |
| `core/`, the core's own folder | 14,143 | 25,604 | +11,461 |
| `lib/` | 36,053 | 45,674 | +9,621 |
| `engines/kit/`: the engines' declared data, applied in the core | 0 | 8,989 | +8,989 |
| The Windows terminal host (`lib/windows/`, `lib/ptyHost/`) | 0 | 4,615 | +4,615 |
| `harnessd/`: the master's own files | 769 | 2,542 | +1,773 |
| The three doors (`backendSocket.ts`, `hookServer.ts`, `localWsServer.ts`) | 2,922 | 3,852 | +930 |
| The engines' own folders | 10,637 | 4,670 | -5,967 |
| `lib/sessionSearch/`, `dsh/` | 5,356 | 797 | -4,559 |

Some of the growth is the plan working: Claude Code's and Codex's code left for their workers, and what the core
keeps of every engine became declared data (`engines/kit/`). Some is new platforms: Windows. The rest is features.

By what each file is:

| What it is | Files | Lines | Can leave | Unsure |
| --- | ---: | ---: | ---: | ---: |
| Sessions: agents, terminals, transcripts, turns, input, questions | 123 | 27,084 | 2,085 | 250 |
| The core's own plumbing: its doors, the registry, the service links, configuration | 61 | 20,387 | 3,080 | 265 |
| Engines: the declared data and the code of Claude Code, Codex and the fourteen others | 131 | 19,048 | 7,101 | 0 |
| The core's side of one service: a link, a wake, a cache of what it reports | 128 | 11,864 | 1,140 | 441 |
| Platform: tmux, the Windows terminal host, paths | 60 | 10,805 | 495 | 0 |
| Features: what a session runs without | 47 | 8,090 | 7,303 | 238 |
| Dead, test-only, or compatibility past its date | 6 | 1,159 | 1,007 | 131 |
| **Total** | **556** | **98,437** | **22,211** | **1,325** |

By risk and size of the job: 7,517 lines at low risk in jobs of about a day; 1,541 at low risk in a few days;
6,503 at medium risk in a few days; 1,829 at medium risk in a week or more; 4,821 at high risk (the engine set-up,
which needs a ruling first).

## At run time

A working Mac, four hours after its daemon started, about fifteen agents:

| Process | Memory | Open connections to another host |
| --- | ---: | --- |
| core | 412 MiB | none; listens on `127.0.0.1` and the private socket |
| gateway | 351 MiB | 8, all HTTPS: the daemon's only ones |
| engine-codex, engine-claude | 191, 135 MiB | none |
| search | 175 MiB | none |
| superTabs (the Swarm) | 169 MiB | none |
| edge | 168 MiB | none |
| memory, viewers, models | 142, 138, 137 MiB | none |
| updater, master | 107, 106 MiB | none |
| devices, sharing | 94, 78 MiB | none |

- The walls between processes hold: one process talks to the outside, and it is not the core.
- The core is the largest. A fresh one is about 92 MiB, and its own code holds 39 MiB of heap (loaded from
  source, after a full collection); what the other 300 MiB are after four hours is not known. Measure it before deciding anything on it (a heap profile of a core
  that has run a day of agents, in a test home).
- The core's children are its terminals: one `tmux -C` client for each open pane.
- Its process can start a child from 86 files, eight of them synchronously, and loads seven packages that are
  not ours: `ws`, `zod`, `chokidar`, `smol-toml`, `yaml`, `dotenv`, `@sindresorhus/slugify`.

**Harness OS is the exception.** Its unit sets `HARNESS_NO_MASTER=1`
(`os/root/usr/lib/systemd/user/harness-daemon.service`): the core runs alone and every service runs inside it, a
choice made for the device's memory. There the rule does not hold at run time. See [Decisions](#decisions-for-the-owner).

## The first fix (#4238): the Swarm's service loaded in the core

`superTabs/inCore.ts` is the Swarm's door into the core: the few things the Swarm runs in the core's process. Its
last line re-exported the Swarm service's own start, for a core that runs the service itself
(`HARNESSD_SERVICES=none`). The export was static, so every core with the Swarm on loaded the service and
everything it imports: its host, its GitHub loops, the transcript normalizers of eleven engines, the change-agent
handoff, the Codex profiles. 118 files and 28,739 lines it never ran, 24 of them files the architecture test
forbids the core to load. The test did not see it, because it walks the core with the Swarm off.

With #4238 the door holds the Swarm's side of the core alone, and a core that runs the service itself loads it by
an import of its own (`core/main.ts`), beside the doors and before its wiring starts.

| | Before | After |
| --- | ---: | ---: |
| Files and lines the Swarm's door adds to the core | 138 and 30,724 | 20 and 1,987 |
| The same in the shipped build, beside the core's 2,233 KB | 630 KB | 39 KB |
| Heap the door holds after a full collection | 5.7 MiB | 0.4 MiB |

Three tests hold it, each failing without the change: the architecture test lists the door's 20 files one by one;
the build test checks the shipped door holds none of the service; and on the real daemon the core's process loads
none of `services/superTabs.ts`, `superTabs/host.ts` and `superTabs/service.ts`, which it loaded before.

## What leaves, in order

Each line is one pull request or a few, with the test that fails without it, and removes its entry from this
list. The per-file detail is in [files.tsv](2026-11-12-core-audit/files.tsv), as the audit found it.

Left since, with the core's process as `src/architecture.coreFiles.txt` lists it after each:

| What | Files | Lines |
| --- | ---: | ---: |
| The audit's count, with the changes that landed while it ran | 563 | 99,467 |
| The CLI's client code: seven files loaded for a helper each (13 November) | 558 | 98,600 |
| The master's supervisor and its supervision of the services, with the two security changes of the same day, which add 137 lines (13 November) | 557 | 97,686 |
| The platform's launchd, systemd and Task Scheduler code, loaded to repoint one Node path: the master does it now (13 November) | 554 | 96,582 |
| Windows files loaded for a constant: the guest set-up's protocol and folder checks, the pane's command for a guest, the updater's version folders and the install layout (13 November) | 551 | 95,749 |
| `harness uninstall`'s hook removers, loaded for how one outcome is said (13 November) | 551 | 95,590 |
| The guests' accounts, loaded for a user-name check and a small runner; and a function nothing called (13 November) | 552 | 95,372 |
| The probe of which engines this machine has: the edge host answers it and starts its login shells (13 November) | 550 | 95,029 |
| The agent ledger, loaded for one erase in a delete: the agent cleanup erases what a harness was told, asked before anything is deleted. And the dial's recap of a cloud agent's last words, markdown a maker's agent wrote: its service works the card out and the core shows what it is handed (13 November) | 548 | 94,575 |
| The agent browser's stream: the exec into a browser's container for each viewer, the reading of the viewer's VNC bytes, the credit and the pacing run in the agent browser's process. The core keeps a forwarder that holds each stream to the connection that opened it, bounds what it passes on by itself (an unanswered open, unread bytes), and sends the service's screen frames on unread, which costs it no more per byte than reading the pipe did (13 November) | 547 | 94,319 |
| The sign-in's renewal, the core's last call to another host: the gateway renews it, and the core asks it for a token. A test lists what in the core's process can open a connection, each to this computer (13 November) | 547 | 94,321 |
| The Swarm's chat-file upload, the last call to another host with the Swarm on: the core keeps the file in its private uploads folder and the gateway sends it. The connection test reads every file of the core's process, the Swarm's door too. The core no longer loads the backend's address (`lib/backendHttpBase.ts`) at all (13 November) | 546 | 94,344 |

### 1. Code the core loads for one helper (low risk, about a day each)

| What | Lines | What the core needs instead |
| --- | ---: | --- |
| `lib/agentTmp.ts`, a Swarm agent's private temporary folder, made and swept at a launch. A relaunch needs the folder too, and behind the Swarm's door it would still load by default | 183 | the folder kept in the launch record; the Swarm's service makes and sweeps it |
| `lib/apiConnectionMetadata.ts`: the saved-API store parsed at every launch, keys included, to learn whether one exists. A look that skips the check gives another answer for a file the check refuses, as the engine probe's first cut did (#4255) | 53 | the keys in a file of their own, apart from what a launch reads: a change of what is on disk, with its migration |
| Exports only tests read: `decodeTmuxControlData` and `normalizeTmuxCaptureLines` in `lib/tmuxStream.ts`, `stopSessionOwner`, `writeTty` and `foregroundJob` in `lib/externalOwnerControl.ts` (kept with a golden test: ask before deleting) | 154 | nothing, or a test's own file |
| Lines of `core/api.ts` no core file imports, and code only the inline mode runs (`core/serviceHost.ts:122-233`, `lib/transcriptPages.ts:240-466`, `lib/sharedMachinesPort.ts:49-160`) | 707 | with their service, or gone with the inline mode |

**Stays, decided 13 November: the agent settings sync** (`core/experiments.ts` `createAgentSettingsSync`, 150 lines).
It was built as a service in the edge host and measured. The core's side of it (the local door's relay of a window's
switch, the link, and the check that the edge host changes no switch but the agents' own, since Hachi's is the person's
yes) came to more than what left: one file and 47 lines more in the core's process, and `harness settings` would fail
while the edge host is down. Lending the edge host every switch would make the core smaller and let a process that
reads other accounts' messages turn Hachi on. What the sync does in the core is ask the gateway for one small read
every five minutes and write one file.

Not counted above, because it is not a move to a service: **the other platform's terminal code.** The Windows
terminal host and its host moves load on a Mac and on Linux and never run there (`lib/ptyHost/`,
`lib/ptyHostBackend.ts`, `lib/hostMove/`: 3,835 lines). A door at `core/main.ts:626-636` that loads the backend
this platform uses leaves them out. Low risk on a Mac and Linux, medium on a Windows start.

### 2. Features that run in the core's process

| What | Lines | Where to | Risk |
| --- | ---: | --- | --- |
| **Feature routes in the two doors.** Pairing and keys, the account, desk and Store proxies, device and Wi-Fi routes, usage reports, voice, the relay to other machines (`hookServer.ts` 470, `localWsServer.ts` 430, `core/main.ts` about 320, `lib/deviceManagementHttp.ts` 199, `lib/storeProxy.ts` 48) | 1,470 | gateway, devices, edge, through one adapter that turns a route into a service request | medium |
| **Git.** A create clones a repository or adds a worktree inside the core; every agent frame runs git for its project and branch (`lib/gitProject.ts`, `agentProject.ts`, `projectFolder.ts`, `sessionGitHistory.ts`, `sessionGitContext.ts`, `worktreeDeletion.ts`, `sshHosts.ts`, `scm/`) | 1,900 | edge (workspaces): a create asks for its folder, a frame reads a reported cache | medium |
| **The product usage vocabulary** and the mapping of each request's outcome to counter names (`lib/productUsageContract.ts`, `productUsageSignals.ts`, `productHealthContract.ts`, `appProductUsageReport.ts`) | 723 | gateway: the core sends one raw outcome | low |
| **Paste uploads.** Up to 20 MB from a remote client into the core's memory, then files written and clipboard tools started (`lib/terminalStreamManager.ts:1003-1234`, with `lib/osClipboard.ts` and `lib/pasteDropFiles.ts`) | 240 to 465 | a paste service in the edge host | medium |
| **The harness index and manifest,** read and parsed with zod on the frame path (`dsh/installed.ts`, `manifest.ts`, `compatibility.ts`) | 420 | viewers (the Store): a reported cache | medium |
| **The change-agent handoff's file transaction** (`core/handoffPublication.ts`, `lib/handoffPublication.ts`, `handoffFiles.ts`, `handoffValidation.ts`). It was moved into the core on purpose (#1145): unsure | 510 | edge (handoff) | medium |
| **The Wi-Fi device's own delivery queue and session relaying** (`core/deviceInput.ts`, `core/wifi.ts`): unsure | 360 | one delivery path in `core/input.ts`; devices | high |
| Smaller: the phone sign-in relay (127, gateway), guest rules and a guest's engine install (256, edge), cloud agents' cards (150, cloud), the gateway's pass-throughs (150), `harness remote` (47) | 730 | | low to medium |

### 3. Engine code

| What | Lines | Where to | Risk |
| --- | ---: | --- | --- |
| **A Codex resume reads its whole rollout synchronously on the core's loop,** twice when it repairs (`engines/kit/resumeRepair.ts:146`, from `core/agents/launch.ts:132`). The rollout of 3 October was 803 MB. First asynchronous, a day; then the worker | 495 | Codex's worker | medium |
| **Six engines' model switch drives their panes from the core** (`lib/runtimeControl.ts:229-663`), with their question key steps and readers. Claude Code and Codex already use a worker's grant | 715 | the other engines' worker | medium |
| **The other fourteen engines run in the core:** their normalizers, readers and Stop rules (`core/transcripts/attach.ts:415-599`, `ingest.ts`, `history.ts`, `core/turns/turnHooks.ts:133-280`), and 16,055 more lines loaded once one of their sessions needs it | 2,584 + 16,055 | one worker for all fourteen, as the plan says ([other engines](2026-10-08-other-engines-out-of-core.md)) | medium, high on attach |
| **Engine set-up:** installing engines, their hooks and plugins, probing binaries, the person's login shell (`engines/kit/native*.ts`, `hookSettings.ts`, `hookReview.ts`, `launchExecutable.ts`, `engines/nativeLaunch.ts`) | 4,436 | a set-up process: needs a ruling first | high |
| Store engines: deletes on their databases at purge, a whole conversation read into the core at close, Codex's title index read whole | 483 | their worker | medium to high |

### 5. The Swarm, out of the core's process

anh Dee, 2026-11-13: "swarm is an experimental feature. we could turn it off / kill the feature at any time. the
philosophy: small tiny core that is super stable and solid and a lot of components around it". With the Swarm on, its
door (`superTabs/inCore.ts`) loaded 20 files, about 2,100 lines, into the core's process; 17 and about 1,900 once the
first lines below left (13 November). Each leaves by one of two ways,
so the core keeps no Swarm code at all, and deleting the Swarm changes nothing in it:

- **Through a relay.** What the Swarm's service and the devices tell each other goes through a small generic relay in
  the core: a listed sender, receiver and kind, each bounded in size, checked by the receiver. The core carries it unread.
- **As data the Swarm hands the core.** What the core decides in line about an agent (a start's additions, whether its
  turns are quiet on the devices, whether it may be closed) becomes a fact the Swarm's service gives the core ahead of
  time, kept with the agent's row, so a relaunch while the service is down still has it. The core's code is generic:
  "an agent a component marked protected is not closed", never "a Lead".

| What (lines) | What the core asks of it | Where it goes | Order |
| --- | --- | --- | ---: |
| `inCore/devices.ts` (9) | whether a finished turn is quiet on the devices | a row flag the Swarm sets at its start | 2 |
| `inCore/cards.ts` (228), `inCore/attention.ts` (98) | the device cards, the waits on a person | the relay: the Swarm's service to the devices, and their wants back; the devices check and replay | 4 |
| `inCore/launch.ts` (79), `lib/swarmSkills.ts` (110), `lib/swarmEngineArgs.ts` (15), `lib/agentInstructions.ts` (408) | a start's roles, the team's basics, the agent's own instructions, its engine flags, its share of the cores | a start's additions (instructions text, flags, variables) the Swarm's service hands the core with the start and refreshes; kept in the row for a relaunch | 6 |
| `inCore/agents.ts` (56), `retention.ts` (103), `leadSwitch.ts` (152) | which agents the Swarm may close or reopen; that a Lead is never closed, but in its engine switch | protected agents the Swarm's service names, kept on disk by the core, and the one switch's receipt check as a port | 7 |
| `inCore/adoption.ts` (90), `inCore/role.ts` (13) | an attached agent's role at its restart | the Swarm's service tells the core the role when it knows it; kept in the row | 8 |
| `lib/swarmGitHub.ts` (192) | the Harness GitHub App's git and gh for old sessions | deleted on or after 2026-12-10, as it says | 9 |
| `lib/superTabAttachmentProxy.ts` (159) | a chat file posted to this computer | already sent by the gateway (13 November); the intake stays with the local door until the doors' routes move (part 2) | |
| `readContract.ts` (89), `wire.ts` (50) | helpers of the files above | go with them | |

Each line is one pull request, tested with the Swarm's own end-to-end files (`superTabs*.e2e.ts`, `swarm*.e2e.ts`).

Left: `cleanupCloses.ts`, the closes the agent cleanup made, for the machine's report (order 1). The door handed it only
to an agent cleanup in the core's process; that one now gets it as the cleanup in its own process does, from the
Swarm's side of the services (`superTabs/inServices.ts`) (13 November).

Left: `inCore/deliveries.ts`, whether a chat message types while the agent works (order 3). The input queue
(`lib/sessionInput.ts`) also named the Swarm's delivery ids itself, outside the door. Now the core keeps one list of the
services whose typed turns go into a working agent's own input (`WHILE_BUSY_DELIVERERS`, `core/api.ts`, beside the list
of those that may deliver at all), and the input asks it by the maker each delivery's id names. Deleting the Swarm
takes its name off that list and changes no code (13 November).

Left: `inCore/terminal.ts`, a member's screen for its Lead and keys into it (order 5). It is now the core's own
`core/terminals/panes.ts`: an agent's pane read as plain text and typed into under its write lock, for the services the
core lists (`PANE_TYPERS`, `core/api.ts`). It was the Swarm's only by name, so the core gains it: one more file in the
core with the Swarm off (547 files, 94,487 lines), and the same count with it on (564), as the door loses it. The
queries a service's process sends are `pane_screen`, `pane_input` and `pane_input_if_screen` (13 November).

### 4. Modes where everything runs in the core

- **Harness OS** runs the core alone, with every service inside it: 113,149 more lines. A decision, below.
- **`HARNESSD_SERVICES=none`** and the fallbacks for an old master: `services/inline.ts`, the start and serve half of
  `core/serviceHost.ts`, 29 branches in `core/main.ts`. The October plan ends it once every service has run in its
  own process for a release, which they have. It stays while Harness OS needs it.
- **Compatibility with no end date:** `core/updaterBeside.ts` (a master from before 7 October), `core/updateHandoff.ts:103-179`,
  `config/env.ts:29-118` (adopts `~/.machine` at import, in every process, since 6 August), `lib/cwdRepair.ts` (rows
  from before 22 September, repaired at every start), the refusals of retired `daemon_*` frames. Each needs a date.

## Security

The core is the most trusted process: whoever runs code in it can type into every agent's terminal. What it does
today that the rule says it should not, most serious first:

1. **The core ran a command line a service handed it.** The agent browser's process gave the core an argv, and the
   core started it for each viewer (`core/agentBrowserLink.ts`, `core/browserStreams.ts`). Fixed on 13 November: the
   stream is the agent browser's own, in its process (`services/agentBrowser/streams.ts`), and the core starts no
   command for it and is handed none. What the core still decides is who may open a browser's stream, and whose each
   stream is: the screen's bytes go only to the connection that opened it, which the service never names.
2. **An experiment's process could call any backend route as the account.** `core/experimentQueries.ts` signed any
   `/api/` path for the orchestrator, Share, Memories, the router, the Swarm and cloud agents. Fixed on 13 November:
   each declares its routes (`core/api.ts` `EXPERIMENT_BACKEND_ROUTES`), as Agent Messages does, and the core signs
   no other: the Swarm's own API and `GET /api/auth/me`, Share's grants and links, Jev's decision, and none for the
   other three. A refused route is said in the core's log. What the Swarm's process may still ask is all of the
   Swarm's API, not only the routes its service calls: an app's asks go through that service.
3. **Bytes from outside this computer are parsed in the core:** a paste of up to 20 MB from a remote client
   (`lib/terminalStreamManager.ts:1003-1234`), a third-party `harness.json` (`dsh/manifest.ts`). A remote viewer's
   VNC bytes were (`core/rfbShaper.ts`), until 13 November: the agent browser's process reads them now, and the
   core passes them on unread. And what agents write: fourteen engines' transcripts and SQLite stores
   (`core/transcripts/attach.ts:415-599`), with `node:sqlite` on threads inside the core.
4. **The core's loop can be held.** A registry save: its lock can sleep the loop for 2 s, and its three fsyncs took
   about 60 ms of a save measured on a Mac (a synchronous `ps` on every save, for a start time that never changes,
   is gone since 13 November: read once); a Codex resume that
   reads its whole rollout; a login shell and `harness-pty version`, up to 5 s each
   (`lib/engineBin.ts:116`, `lib/ptyHost/launch.ts:227`); fsync bursts for the handoff; `~/.claude.json` rewritten
   synchronously (`engines/kit/folderTrust.ts:101-115`). (The agent ledger's lock, 2 s, is the edge host's to wait
   on since 13 November.) And work that grows with history: create receipts are
   never deleted and are scanned every minute, a bounded part at a time (493 on the Mac measured,
   `lib/agentCreationReceipt.ts`).
5. **Children that are a feature's:** `git clone` inside `agent_create` (`lib/projectFolder.ts:241`), engine installers
   that run npm or curl (`engines/kit/nativeInstall.ts:357`), `amp threads export`, which calls Amp's servers
   (`core/transcripts/history.ts:56`). The New dialog's login shells are the edge host's since 13 November.
6. **Launch arguments, environment and files from models, the Store and shared machines are checked for shape
   only** (`core/modelsLink.ts:75-89`, `storeLink.ts:36-42`, `sharedMachinesLink.ts:22-25`).
7. **Keys the core holds without need.** A grid's API key is kept on the registry row and copied into each
   stopped agent's file (`lib/registry.ts:145-153`, `lib/stoppedAgents.ts:147`). The whole environment of up to
   256 agent processes is cached to find their sessions (`lib/processEnv.ts:121`), and an OpenRouter key is cached
   and never read (`lib/gatewayRuntime.ts:100`). The saved-API store is parsed at every launch, keys included,
   to learn whether one exists (`lib/apiConnectionMetadata.ts:33-52`). A connected service's secret passes
   through the core in the clear (`lib/connectors/vaultOps.ts:22-25`).
8. **Any process of this OS user is the owner on both local doors, an agent's included** (`localWsServer.ts:474`,
   `backendSocket.ts:411-416`). An agent that reads other people's text, a Swarm task or a pull request, holds the
   person's rights over the daemon. That is today's trust model; it deserves its own design.
9. **It writes into the person's folder.** A start appends a "Saved APIs" block to the instruction file of the
   folder it launches in, once the person has saved an API (`lib/apiInstructions.ts:23-32`, from
   `core/agents/create.ts:426`, `launch.ts:68`, `fork.ts:180`). Its comment says only workspaces Harness made; the
   code does not check. To confirm with a test, then fix.
10. **Test hooks ship in the core** (`core/stall.ts`, `core/main.ts:2076, 3460`). They stay (13 November): a fault
    that holds the core's event loop has to run in the core's process, and each does nothing unless
    `HARNESSD_TEST_FAULTS` names it, which only whoever starts the daemon sets.

What already holds: the core calls no other host, with the Swarm on or off (13 November): the gateway renews the
sign-in (decision 4, `lib/authRefresh.ts`) and sends a Swarm chat file to the backend (`gateway/upload.ts`), and
`src/architecture.spec.ts` reads every file of the core's process and lists what can open a connection, each on this
computer. The E2EE keys are the gateway's; both local doors refuse another OS user and a web page (the private socket's mode,
the local credential, the Host and Origin check, `lib/loopbackRequest.ts:22-29`); a service's process connects
with the master's token.

## Decisions for the owner

Decided by anh Dee on 2026-11-13, each as recommended: "ok do it all. test carefully. it's the daemon core."

1. **A file list for the whole core** ([What holds it](#what-holds-it-from-now-on)). Recommended: yes. Built:
   `src/architecture.coreFiles.txt`.
2. **Engine set-up in a process of its own.** 4,436 lines, the largest block that is not sessions. The October
   ruling is that a launch never waits on a worker ([engine hooks](2026-10-08-engine-hooks.md)). Recommended:
   installs, plugin writes and probes leave, and a launch that needs one waits behind the hold it already has;
   what a restart or a restore needs stays in the core.
3. **Harness OS: one process, or the same walls.** Recommended: decide when work on Harness OS resumes. Until then
   it is the one named exception to the rule.
4. **Who refreshes the sign-in.** Done 13 November: the gateway. Before, the core did, and that refresh was its one
   call to another host. Every daemon
   process runs as the same OS account and can read the session file, so the gateway refreshing it loses no
   secrecy (the October plan's open decision 3). Recommended: the gateway refreshes; then the core calls no other
   host at all, and a test can hold that.
5. **Agents as owners of the local door.** Recommended: its own design, after the moves above.

## What holds it from now on

- **The rule, where agents read it:** `AGENTS.md` (The daemon core), `cli/AGENTS.md` (Protect the core),
  `cli/src/core/AGENTS.md` (rules 2 and 8), `cli/src/services/AGENTS.md` (every service in a process of its own).
- **The Swarm's door is listed file by file** (`architecture.spec.ts`, #4238): a file added to it fails the test
  until it is added to the list, in a change that says why.
- **The same for the whole core:** every file the core's process loads is a line of
  `src/architecture.coreFiles.txt`, checked both ways by the test, so that adding one is a line in a pull
  request that a reviewer sees, and the test names the file that imports it. In the 43 hours before this audit,
  14 of 79 changes to the CLI changed that set and added 17 files, among them `agentClient/ledger.ts` (363 lines
  for one call) and `engines/claude/backgroundCommands.ts` (engine code, in the core). While the audit ran, one
  more change added 7 files and 1,017 lines (#4239: 99,454 lines in 563 files); with the list as it stood before
  it, the test fails and names the seven. It is not a line count: comments and fixes never trip it. It also holds
  the engines' code out: a new engine file the core would load is a new line like any other.
