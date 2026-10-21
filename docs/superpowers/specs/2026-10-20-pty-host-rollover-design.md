# PTY host updates while agents run (sub-project G)

Date: 2026-10-20, delivery added 2026-10-21
Status: implemented on feat/windows-pty-rollover; E2E in docs/testing/pty-rollover-e2e.md

## Why

On Windows every agent and terminal runs in a pane of the Harness PTY host, `harness-pty.exe`. Two things keep new
PTY code from reaching a person's machine today.

**The payload never arrives by itself.** Only `install.ps1` installs the PTY payload (the host, `harness-launch.exe`,
the `harness.exe` command, ConPTY and `harness-serial.exe`). The CLI's self-update downloads `cli.js` only. A machine
updates its CLI on every release and keeps the PTY payload it was installed with, until someone runs `install.ps1`
again. On the x64 test PC on 2026-10-21, the CLI and app were current and the PTY was a build too old to carry
`harness-serial.exe`. The dial on COM3 was never found.

**A payload that arrives never runs while its host does.** A PTY update with the same wire protocol never takes
effect while that host runs. It was measured in C5.2 on the ARM64 VM:
- `install.ps1` put PTY 0.4.19 in place and moved `current-pty` to it;
- the host still running was 0.4.18, with seven agents in it;
- the restarted daemon reconnected to that host, and new panes opened on it too.

The new host code (fixes included) runs only after every pane has gone and the host has exited. In practice that
means a reboot. Stopping the host to force the update would kill the person's agents.

A protocol bump already handles this well (`cli/src/lib/ptyHost/drain.ts`):
- the new protocol's host makes the new panes;
- the old host keeps its panes and is shut down once it has none;
- then its version folder is deleted.

G closes both gaps:
- the self-update installs a newly promoted PTY payload, as it installs a new CLI (§5);
- the new host takes the new panes, the same rule a protocol bump follows, applied to every host version (§1–§3);
- running agents move onto the new host by themselves, at moments no one is using them (§4).

The person never sees any of this: no notice, no button, no choice to make.

## Goals

0. **A promoted payload reaches every machine by itself.**
   - Within one update check of the owner promoting a PTY payload to production, a running Windows install
     downloads it, verifies it and installs it beside the one in use.
   - No one runs `install.ps1` again.
1. **New panes run the new code.** After a PTY update, every new agent or terminal opens on a host of the installed
   version.
2. **Running agents are never interrupted by an update.**
   - An agent or terminal on the old host keeps running, streaming and taking input, exactly as now.
   - It stays there until it ends, or until the daemon moves it unnoticed (§4).
3. **Old hosts go away by themselves.**
   - A host of an old version is shut down once it has no pane, and its version folder is deleted, as the drain
     does today.
   - A host of an old version that has no pane when the daemon starts is shut down then, without waiting for a pane.
4. **Running agents move to the new version by themselves, unnoticed.**
   - The daemon moves an agent to the new host only while it is idle and no one is looking at it.
   - A moved agent keeps its agent id, its scrollback and its engine conversation. The next time the person opens
     it, they find the same agent and the same conversation, with the scrollback above it as before.
5. **Nothing to see.** There is no notice, dialog, badge, setting or button for any of this, on any client. The
   update is visible only in the daemon's log.

## Non-goals

- Changing how a payload is released. Every CLI release still builds a PTY payload stamped with its version and
  publishes it to staging. The owner still promotes one to production by hand (`promote-pty-payload.sh`), only when
  its PTY code is worth shipping. The machines follow the production manifest. They never follow staging, and never
  a CLI release that was not promoted.
- Moving a running process to the new host without restarting it: handing ConPTY handles and screen state from one
  host to another. ConPTY's internals are not documented, and a failure loses the person's agent. Rejected.
- tmux. Scope is Windows only, where the PTY host is the terminal backend.
- Any UI for the rollover, on any client.
- Moving terminals (plain shells): a shell has nothing to resume. A terminal stays on its host until the person
  closes it.
- Moving engines that cannot resume (`fresh` in `resumeCapability.ts`, e.g. `devin`): moving one would lose its
  conversation. It stays on its host until it ends.

## Anti-goals: a failure even if it works

- The person notices the move:
  - an agent interrupted mid-turn;
  - a screen that went blank or lost its scrollback;
  - a tile that flickered or reloaded while they watched;
  - keystrokes lost while they typed;
  - any message about it.
- An update ends a terminal, or an agent that cannot resume.
- A moved agent loses its conversation.
- A moved agent comes back with a new agent id: its tile, links and history break.
- A failed move leaves an agent worse off than if it had not been moved.
- Two hosts left running for good, one of them with no pane.
- A pane that is listed, streams, or takes input on the wrong host, or is listed twice.
- A version folder deleted while a host still runs from it.
- A half-installed payload in use: `current-pty` naming a folder that is missing a file, or holding a file that does
  not match the manifest.
- `bin\harness.exe` or `bin\harness-launch.exe` missing, even for a moment, so that a `harness` command or a pane
  launch fails during an update.
- A CLI update that leaves the machine with no host its daemon can speak to.
- An update that downgrades the PTY, or moves to a dev or staging build.

## Current state (as of `feat/windows-desktop` at `8fb220f15`; Windows merged to main as #1470, `8eb94821d`)

- **The host** (`pty/src`) has one instance per protocol, `p<PROTOCOL>` (`discovery.rs` `instance()`). That name keys
  its discovery file `<home>/run/pty-host-<protocol>.json`, its lock (`host_lock.rs`), its pane-id counter
  (`pane_ids.rs`, `pty-host-<protocol>.panes`), its Unix socket (`pty-host-<protocol>.sock`) and the
  `HARNESS_PANE=<instance>:%N` its children see. The Windows pipe name is random on each start
  (`transport/windows.rs` `pipe_name_for`, suffix `-p<protocol>`); the lock is what keeps one host per protocol per
  home. The host log `<home>/logs/pty-host.log` is per home, and only the lock holder rotates it (`logfile.rs`).
  The version is any non-empty build string (`cli.rs` `release_version`), unvalidated. The discovery
  file already carries the host's `version` (`cli.rs` `publish_and_serve`). A release stamps that version with the
  CLI's version (`HARNESS_PTY_VERSION`), so every CLI release ships a host with a new version.
- **The daemon** (`cli/src/lib/ptyHost/`):
  - `ensurePtyHost` connects to any running host of `PTY_PROTOCOL`, whatever its version, and starts one only
    when there is none.
  - `ptyHostBackends` makes one create backend (`PTY_PROTOCOL`) and one drain backend for each older supported
    protocol with a discovery file or registry rows.
  - The drain shuts an empty old host down after `EMPTY_PASSES` reconcile passes (`shutdownHost`; protocol 2 has
    the `shutdown` op; a protocol 1 host is left idle).
  - Then `removeUnusedPtyVersions` deletes the version folders older than `current-pty` that no running host
    uses. Newer folders always stay (another install's, perhaps not finished).
  - Uninstall (`uninstall/ptyHosts.ts`) and `discoverHosts` find hosts only through `pty-host-<protocol>.json`.
  - Registry rows name their host by runtime instance (`ptyhost:<instance>`, `terminalRuntime.ts`). The instance is
    an opaque string to everything above `ptyHost/`.
- **Updates on Windows.**
  - Only `install.ps1` writes `<runtime>/pty/current-pty`.
    - It reads `pty/metadata.json`, takes the `win32-x64` or `win32-arm64` entry for the machine's native
      architecture (`Get-HarnessPlatform`), and unpacks it into `<runtime>/pty/<version>/`.
    - It copies `harness.exe` and `harness-launch.exe` from there into `bin\`.
  - `install.ps1` then restarts the daemon once (`Restart-HarnessDaemon`: `harness stop`, then start).
  - The CLI's self-update (`selfUpdate.ts` `startSelfUpdater`) does not change the PTY.
    - It reads `cli/metadata.json` on a schedule, downloads and verifies `cli.js` and `notify.mjs`, and runs a canary
      (`node cli.js version`).
    - Under the daemon spawn lock it stages the build into `cli\<version>\`, moves `cli\current`, and restarts the
      daemon (`onStaged`).
    - Dev builds never update themselves (`isLocalDevBuild`).
  - `harness.exe` (`pty/src/command.rs`) and `harness-launch.exe` (`pty/src/launcher.rs`) are short-lived: each
    resolves the pointers, starts `node.exe` and exits. Either may be running at any moment a command or a pane
    starts.
  - The production manifest `pty/metadata.json` changes only when the owner promotes a payload
    (`promote-pty-payload.sh`). Its entries' `url`s point at the immutable staging objects of that release.
  - The CLI and the host meet on `PTY_PROTOCOL` (2 today). `protocol.spec.ts` pins it, because no update path
    brings a new host to an installed machine. G's delivery is that path.
- **Restarting agents.**
  - `restartAgent.ts` relaunches an agent's engine in the same pane, on the same host.
  - `restoreAgents.ts` (after a reboot) makes a new pane for a row whose pane is gone, and relaunches the engine
    there with its resume argv. It keeps the same agent id.
  - `resumeCapability.ts` says per engine whether a conversation comes back (`conversation`), a shell is relaunched
    (`shell`), or only a fresh session is possible (`fresh`).

## Design

### 1. One host instance per host build

- A host's instance name is derived from both its protocol and its version. It is unique for each (protocol,
  version) pair, and stable across restarts of the same build.
- Everything the instance keys today is keyed by the new name, so two hosts of the same protocol and different
  versions can run side by side in one home:
  - the discovery file, the lock and the pane-id counter;
  - the Unix socket, and the Windows pipe's suffix (its name is already random per start);
  - `HARNESS_PANE`'s instance;
  - the host log, so two hosts never rotate one file.
- The exact format is the builder's. The version is unvalidated, so the name must be made safe from it (a
  sanitised form or a short hash) for a file name, a Windows pipe name and a Unix socket path. The socket path must
  stay inside `sun_path` (104 bytes on macOS), which nothing guards today.
- **Hosts already running** (written by today's builds as `pty-host-<protocol>.json`, instance `p<protocol>`) are
  found and treated as instances of their own. Their panes, rows and routes keep working, and they are drained like
  any old host.

### 2. Which host gets new panes

- The daemon's **target host** is the one it would start: `PTY_PROTOCOL`, and the version of the binary
  `ptyHostBinary()` resolves. On Windows that is the folder `current-pty` names. In a dev build it is whatever
  `HARNESS_PTY_BIN` points to, read with `harness-pty version`.
- The daemon looks at every host discovery file in the home, not only those of the supported protocols.
  - The host matching the target becomes the create backend. It is started when there is none.
  - Every other running host of a supported protocol becomes a drain backend.
  - Hosts of unsupported protocols are reported as they are today.
- When the target version cannot be known (no `current-pty` and no readable binary version), the daemon behaves as
  it does today: it creates on any running host of `PTY_PROTOCOL`.
- **When this is decided:** when a core starts, as the backends are built today (`core/main.ts`). G makes every PTY
  update start a new core:
  - the self-update hands over through the harnessd master (§5);
  - `install.ps1`'s `Restart-HarnessDaemon` restarts the daemon only when the CLI version changed
    (`$Before -eq $After` returns early). G makes it restart when `current-pty` moved too.

  When that restart fails, new panes move to the new host at the next restart, and `install.ps1` already says so.
- A downgrade (an older version installed) or a §5 rollback rolls the same way: the target is whatever is
  installed.
  - The newer host is drained like any other: listed, streamed, given nothing new.
  - Its agents are moved to the target under §4.
  - It is shut down once it has no pane.
  - Its version folder is kept, as `removeUnusedPtyVersions` keeps newer folders today.

### 3. Old hosts

- The drain is unchanged: listed, streamed and controlled panes; nothing new; shutdown after `EMPTY_PASSES` empty
  passes; then `removeUnusedPtyVersions`.
- `removeUnusedPtyVersions` must never delete a folder a running host (any instance) was started from. Its rule
  otherwise stays: only folders older than `current-pty` go, and newer ones stay, after a downgrade too.
- Uninstall (`uninstall/ptyHosts.ts`) finds and ends every instance's host, legacy and versioned.
- **More than one daemon on one PTY home** (another data folder, or an older daemon whose stop failed) needs no
  coordination, under two rules:
  - a host is shut down only when it has no pane of any owner, as `drainState` already counts;
  - a daemon never deletes the folder of a host newer than its own target.
  - It drains and shuts down a newer host only when its own install has gone back below it, by a downgrade or a
    rollback. That is, `current-pty` names an older version than that host's. A daemon whose install is still the
    older one, beside a newer one, leaves the newer host alone.
- An old host that has no pane when the daemon starts is shut down on the first passes, as the drain already does.
  Nothing waits for a pane to end.

### 4. Moving running agents, unnoticed

**When an agent is moved.** The daemon moves an agent on an old host only when all of these hold:
- its engine can resume (`conversation` in `resumeCapability.ts`) and its row has a recorded session id;
- its activity is `idle` (`turnActivity.ts`). Never on `working`, and never on `unknown`;
- it has been idle, with no input sent to it, for a quiet period. Five minutes is the starting value (builder may
  tune, see below);
- no one is looking at it (below);
- no other move, restart, stop or delete is in flight for it.

**Who is looking.** An agent counts as looked at when any of these holds:
- a desktop window shows its tile on screen. The desktop already tells the daemon which agent its window focuses
  (`setLocalTerminalFocus`, `TerminalStreamManager.setFocusedAgent`). G widens that local message to carry every
  agent whose tile is on screen in that window. The list is empty while the window is minimized or hidden to the
  tray. A tile kept mounted off screen (another super tab, `Offstage`) is not looked at, even though its stream stays
  open;
- a mobile or web client, or a Share viewer (`terminalWatch.ts`), has a stream open to it. That includes the phone
  pager's streams to the agents one swipe away (`takeover: false`), which the person can reach in a moment;
- a desktop window that has not sent the list (an older desktop) has a stream open to it. That is the safe default:
  fewer moves, never a visible one.

What does not count: a `watch: true` stream held for a desktop window that has been closed
(`terminalStreamManager.ts`). Nothing shows it. Neither does a tile kept mounted off screen, as above.

**Streams across the swap.** A stream still open to the agent when it moves (an off-screen tile, a closed window's
watch, a prefetched neighbour) is moved to the new pane by the daemon. The client is not asked to reconnect. The
client sees what the resumed engine draws, as it would see any redraw. It gets no new frame type and no reload.

This is a client-to-daemon signal only. Clients still get nothing new, and nothing changes on screen.

Agents are moved one at a time. When a move starts, its conditions are checked again. Anything that breaks them
before the switch (input, a viewer subscribing, a turn starting) cancels the move, and the agent is left untouched.
An agent that never meets the conditions simply stays on the old host until it ends.

**How a move happens.**
1. The old pane's scrollback is captured from the old host. It already answers `Snapshot`, within that op's limits:
   `historyLines` and the frame size.
2. A pane is opened on the target host, seeded with that scrollback. The host has no way to seed a pane today: G adds
   one, **without raising `PTY_PROTOCOL`** (below). The old host only needs to answer `Snapshot`, as it does now.
   - The bar is: the scrollback above reads as before, and the live screen is whatever the resumed engine draws.
     `claude --resume` and `codex resume` clear and redraw their screen with the conversation, so the visible screen
     cannot be pixel-identical. It does not need to be.
3. The engine in the old pane is stopped. The old pane is kept, not closed.
4. The engine is relaunched in the new pane with its resume argv, keeping the same agent id and row.
   - It builds the launch as `restoreAgents.ts` does (`buildLaunch`, the resume argv, grid launches). That code is
     shared, not copied.
   - The route handling is the move's own: restore commits a route before launch and goes through
     `launch: starting`, which clients see. A move prepares the new pane off to the side, then swaps.
5. Once the engine is proven running in the new pane, the row's runtime switches to it, and the old pane is closed.
   The switch is atomic for clients: none sees the agent twice, or with no pane.
   - Input that arrives between step 3 and the switch is held, and delivered to the new pane once the engine there
     is ready. It is never dropped. The window is seconds.

**When a move fails.** If the relaunch on the new host fails, or is not proven in time:
- the engine is relaunched in the **old** pane, as `restartAgent.ts` does;
- the new pane is closed;
- the agent is marked so it is not tried again until the next daemon start.

To the person, the agent is where it was, with its conversation.

**What is never moved:** terminals, engines that cannot resume, agents with no session id, and grid agents whose row
cannot be relaunched as `restoreAgents.ts` already defines. They stay until they end.

**Logs only.** Every move, skip and failure is logged by the daemon, with the agent id and the reason. Clients get no
new frame for it.

**The seed op stays on protocol 2.** Machines today run protocol-2 payloads, and only `install.ps1` replaces them.
Every CLI release reaches production, while a payload waits for its promotion. The first G CLI therefore lands on
machines whose host is a pre-G protocol-2 build, under updaters that know nothing of §5's protocol rule. A protocol
bump there would leave the G daemon with no host it can speak to. So:
- the seed op is added to protocol 2 as an optional op. A G daemon learns whether a host has it: from the host's
  `version` output or its hello, or by an `unsupported` answer to the op;
- a G daemon creates panes on a pre-G protocol-2 host as today's daemons do, and moves nothing to it;
- moves start once the target host is a G build, which §5 brings within one check of its promotion.

Raising `PTY_PROTOCOL` later stays possible: once G's updaters are on the machines, §5's protocol rule holds a
protocol-bumped CLI back until its payload is promoted, and its pairing rule then delivers the two together.

### 5. The self-update installs a promoted payload

**When.** The Windows self-update also reads the production `pty/metadata.json`, from the same base as the CLI
manifest it reads, on each of its checks. It installs the machine's entry when all of these hold:
- the entry's `version` is newer than the version `current-pty` names. It is never older and never the same, and
  the same version rule as the CLI's applies (`shouldAutoUpdate`);
- the installed build is not a dev build (`isLocalDevBuild`), as for the CLI;
- that version was not rolled back or refused on this machine (below).

The entry is `win32-x64` or `win32-arm64` for the machine's native architecture, the same choice `install.ps1`
makes. The PTY check and the CLI check are independent:
- a promoted payload is installed on a machine whose CLI is already current;
- a CLI update goes ahead with the PTY in place, under the protocol rule below.

**How a payload is installed.**
1. Download the zip, outside any lock, within the self-update's transfer limits. Check its `sha256` and `size`
   against the entry. A mismatch is refused, as for the CLI, and backed off before it is tried again.
2. Unpack it into a temporary folder beside `<runtime>/pty/`. Check that all six files are there: `harness-pty.exe`,
   `harness-launch.exe`, `harness.exe`, `conpty.dll`, `OpenConsole.exe`, `harness-serial.exe`.
3. Run a canary: the new `harness-pty.exe version` (and `harness-serial.exe version`) must answer with the entry's
   version. A payload that fails is refused. A host whose protocol the installed CLI supports
   (`SUPPORTED_PTY_PROTOCOLS`) is installed as below. A host whose protocol is above the running CLI's
   (`PTY_PROTOCOL`), the host of a protocol bump, is canaried the same way but kept *paired*: it is never installed
   on its own, only under the pairing rule below. A host below every supported protocol is refused.
4. Under the daemon spawn lock, the one the CLI update holds:
   - rename the temporary folder to `<runtime>/pty/<version>/`;
   - replace `bin\harness.exe` and `bin\harness-launch.exe`. A running executable cannot be overwritten on Windows,
     but it can be renamed. So each old file is renamed aside first, and the new file is put in its place. At every
     moment one of the two answers at the path, never neither. The renamed-aside files are deleted at a later check,
     once nothing runs them;
   - move `current-pty` with `writePointer`;
   - hand over to a new core, as a CLI update does. The updater runs in its own process
     (`services/updaterProcess.ts`): it tells the harnessd master `harnessd:staged` and exits. The master asks the
     core to hand over and puts the build on probation (`harnessd/supervisor.ts` `updateStaged`). G gives that
     message a PTY version beside the CLI one (either may be absent), and the master's probation covers both. From
     then on §2 applies: the new core builds its backends, new panes open on the new host, and §3 and §4 take care
     of the old one.

   If any step under the lock fails, the steps before it are undone: the two `bin\` files are put back and
   `current-pty` is left alone. The payload is refused like a failed canary.
5. When the CLI and the PTY both have an update on one check, both are installed under one lock hold and one
   handover. The PTY goes first. The updater stops after one staging today (`done`). After a PTY-only handover it
   must come back to check the CLI, and the reverse.

**The protocol rule.**
- A CLI build is not staged when it needs a host protocol that no installed payload offers. That is, `PTY_PROTOCOL`
  of the new build is above the protocol of the host `current-pty` names.
- The CLI waits, with a log line once per version, until a payload with that protocol is ready to go in with it
  (the pairing rule below), or `install.ps1` has installed one. Then it updates. A host whose protocol cannot be read
  (no `current-pty`, or a `version` that fails or times out) counts as the running CLI's own `PTY_PROTOCOL`.
- **The pairing rule.** A payload whose host protocol is above the running CLI's goes in only in the same lock hold
  and the same handover (`harnessd:staged` with both versions) as a canaried CLI build that needs exactly that
  protocol, the host first, and one probation judges the pair: a failure rolls both back. If the build does not go
  in after the host did, the host is taken back out (not recorded as rejected) and nothing is handed over.
- `harness update` follows the same rules: it installs a paired host only with the build that needs it, refuses a
  build that needs a protocol above the host's (read after its host step), leaves a pair on probation for the next
  master, and takes a paired host back out when its build fails to go in.
- The owner's order stays the one `desktop/RELEASE.md` gives. If a protocol bump's CLI is released before its payload
  is promoted, machines keep the older CLI until the promotion. They never get a CLI with no host to talk to.
- How the updater learns a new build's protocol (from its canary's `version` output, or from the CLI manifest
  entry) is the builder's. It must not need the build to be staged first.
- Once G ships, the `protocol.spec.ts` pin and the B spec's item 6 ("must not be raised until the rollover lands")
  are replaced by this rule.

**Rollback.** A payload whose new core does not come back healthy is rolled back by the master's probation, as it
rolls back a CLI build today (`restore()`, which G extends to the PTY):
- `current-pty` goes back to the previous version, and the two `bin\` files are restored;
- the version is recorded as rejected on this machine, and not tried again until a newer one is promoted.
- The new version folder stays until no host runs from it, under §3's rules.

The probation's signal and its window are the CLI's where they can be shared. Their exact shape is the builder's.

**Other installers.** `install.ps1` keeps installing the payload as it does today. It and the self-update take the
same lock and write the same pointer, so whichever comes second sees the other's version and does nothing.
`harness update` installs a newer promoted payload too, as it installs a newer CLI.

**Logs only.** A found, installed, refused or rolled-back payload is one line in the daemon log, as a CLI update is.
Nothing reaches any client.

## Constraints

- No administrator rights, no UAC prompt, per user. These are the same as A, B and C.
- Scope is Windows. tmux is not touched.
- Seeding a pane (§4) is an optional op on protocol 2, not a protocol bump. Any later bump follows
  `ptyHost/protocol.ts`'s rule (the daemon keeps a client for the protocol before it), §5's protocol rule, and §5's
  pairing rule (the bumped host goes in only with the CLI build that needs it, in one handover and one probation).
- Hosts and daemons of today's builds keep working: a G daemon drains a `p<protocol>` host. A pre-G daemon still
  running beside a G host (its stop failed during an update) keeps its own `p<protocol>` host; that is accepted.
- Never test against the developer's own machine: the real `~/.harness`, the daemon on 18473, the engine homes,
  tmux.
- The repo is public: no addresses, account names, ids or passwords in committed evidence.
- Docs, comments and commit messages in English.

## Testing

- **Unit (every OS):**
  - instance naming;
  - discovery of every instance in a home, including legacy `pty-host-<protocol>.json`;
  - target choice (installed version, unknown version, downgrade);
  - create and drain backends per host;
  - `removeUnusedPtyVersions` with two running versions;
  - the move's conditions: each one alone blocks a move, and breaking one mid-move cancels it;
  - the move's outcomes: moved; failed and back in the old pane; never-moved kinds left alone.
- **Real host (Mac, and Windows CI x64 and arm64):** two host builds with different `HARNESS_PTY_VERSION`, as in
  `ptyHostBackend.restart.spec.ts`:
  - a pane on the old host keeps streaming and taking input while new panes open on the new host;
  - a pane seeded from an old pane's snapshot shows the same screen and scrollback;
  - the old host is shut down after its last pane ends;
  - its folder is then deleted.
- **Unit, delivery (§5):**
  - the PTY check: newer, same, older, dev build, rejected version, missing entry for this architecture;
  - a zip that fails its digest, its size, the file list, or the canary is refused and leaves everything as it was;
  - a failure at each step under the lock is undone: the `bin\` files are back and `current-pty` is unchanged;
  - the protocol rule: a CLI needing a newer protocol waits, then updates once the payload lands;
  - CLI and PTY in one check: one lock hold and one handover, PTY first;
  - rollback after an unhealthy restart.
- **Windows CI (x64 and arm64), real files:** replace `bin\harness.exe` and `bin\harness-launch.exe` while copies of
  each are running, and check that the path answers at every moment, and that the renamed-aside files are deleted
  once they exit.
- **On the ARM64 VM and the x64 test PC, delivery the way a person gets it:**
  - install release N with `install.ps1` from the fake HTTPS CDN (`fake-cdn.sh`, as B5.13 did, so the build is
    not a dev build);
  - serve a PTY manifest naming N+1, and check that the next update check installs it with no `install.ps1`, moves
    `current-pty`, replaces the two `bin\` files and restarts the daemon;
  - on the x64 test PC, check that the dial on COM3 is found through the new payload's `harness-serial.exe`;
  - serve a payload with a wrong digest and check that it is refused and nothing changes;
  - serve a CLI N+1 that needs a protocol the installed payload lacks, and check that it waits, then updates once
    the payload is served.
- **On the ARM64 VM, the way a person updates:**
  - install a release;
  - start a claude agent, a codex agent and a terminal;
  - let the self-update install the next build's payload (§5). Then check the same steps after an `install.ps1`
    update;
  - check that a new agent opens on the new host while the three keep running;
  - close every client and wait out the quiet period. Check that each agent moved one at a time, with the same
    agent id, its scrollback as before and its conversation resumed. Check that the terminal was not touched;
  - with the desktop open, check that an agent whose tile is on screen is not moved, and that one in another super
    tab is;
  - minimize the desktop and check that the agents move;
  - close the terminal and check that the old host exits and its folder is deleted.

## Where and when

- The Windows PR (#1470) has merged and shipped. G is now its own branch, cut from current `main`
  (`feat/windows-pty-rollover`, rebased), and its own PR to `main`. Delivery (§5) and the rollover (§1–§4) ship
  together: either one alone leaves a new payload unused or unreachable.
- It touches:
  - the PTY host (`pty/src`);
  - the daemon's `ptyHost/`;
  - the self-update (`selfUpdate.ts` and its Windows layout code, `windows/installLayout.ts`);
  - agent-restore, stream and input code;
  - the desktop's local focus message.

  It does not touch the cable or serial code, or `harness-install.exe`. `install.ps1` changes only where it must
  share the lock or the rejected-version record with the self-update, and to restart the daemon when `current-pty`
  moved (§2).
- The release flow does not change. Once G ships, the owner promotes a payload when its PTY code is worth shipping,
  and every machine picks it up.

## Left to the builder

- The instance name's format, within §1's rules.
- How the daemon reads the target version where `current-pty` is absent (dev builds).
- The seed op's shape (a snapshot passed at create, or a separate op before the first output), and whether the
  host keeps the seeded scrollback within `--history-limit`.
- The quiet period's exact value and the move timeout, from measurements. Five minutes is the starting value.
- Whether the PTY check runs in the CLI's poller or beside it, and how they share the lock and the one handover.
- How the updater learns a new CLI build's host protocol, within §5's rule.
- The PTY probation's signal and window, shared with the CLI's where possible.
- When the renamed-aside `bin\` files are deleted, and their names.

## Calls made in this design

The owner decided:
- the rollover is invisible to the person, with no UI;
- the product decides when to move;
- a promoted PTY payload reaches machines through the self-update, with no `install.ps1` run (2026-10-21);
- promotion to production stays by hand (`promote-pty-payload.sh`), not on every CLI release (2026-10-21).

These calls are this design's, not yet confirmed by the owner:
- **The host rolls on every version change**, not only when its code changes. Every CLI release stamps a new host
  version, so after each update a second host runs until the old one's panes end or move. This costs one extra
  host process for that time, and keeps one predictable rule.
- **The target is decided at daemon start**, not before each new pane: on Windows an update always restarts the
  daemon.
- **"Looked at" means on screen.** The desktop reports its on-screen tiles through its existing focus message;
  mobile, web and Share count by open stream; an older desktop counts by open stream.
- **Moves wait for idle, unwatched and quiet.** An agent that is never left alone stays on the old host until it
  ends; that is accepted over interrupting the person.
- **Terminals and engines that cannot resume are never moved.** They hold the old host until they end.
- **The screen bar is the scrollback and the conversation**, not a pixel-identical screen.
- **The move shares restore's launch building** but has its own prepare-then-swap route handling.
- **Input during the swap is held and delivered**, never dropped.
- **Several daemons on one PTY home need no coordination**, under §3's two rules.
- **A downgrade keeps the newer version folder**, as today.
- **`bin\` files are replaced by rename-aside**, never by overwrite. A path always answers.
- **A failed download, digest, canary or step is refused and retried later**, with everything left as it was.
- **A CLI that needs a newer host protocol waits for the payload**, instead of installing with no host to speak to.
- **A payload that does not come back healthy is rolled back** and its version rejected on that machine, as a CLI
  build is.
- **PTY and CLI updates in one check share one handover**, PTY first.
- **Delivery is in G's spec and ships with the rollover**, not as a separate project.
- **The seed op is optional on protocol 2**, so the first G CLI works on machines with today's payload. Moves begin
  once a G payload is promoted.
- **Open streams follow a moved agent on the daemon's side**: no reconnect, no reload.
- **The phone's prefetched neighbours count as looked at; a closed window's watch does not.**
- **After a downgrade or rollback the newer host is drained and its agents moved back**, its folder kept.
- **`install.ps1` restarts the daemon when only the PTY changed.**

## Known limits

Found by the ARM64 VM end to end ([results](../../testing/pty-rollover-e2e.md)) and not fixed.

- **An agent with no session id never moves and keeps its old host alive** until its pane ends (by design: it cannot
  resume). On the VM an engine at its sign-in screen was such a pane. The same holds for the shell an exited engine
  leaves in its pane (on Windows the host's `afterExit` shell): it becomes a terminal row on that host, and a terminal
  never moves.
- **The moves of idle agents and the desktop-only cases are unproven on a real machine**: they need a signed-in
  engine and the desktop UI. The protocol rule's "updates once the payload lands" half needs a host build of
  protocol 3.
