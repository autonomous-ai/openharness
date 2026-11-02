# Harness Team account: can its agents reach the main account's files?

Audit of 2026-11-02 (task #2009), at `origin/main` 615626874. Nothing on any real account or permission was changed. On the
Mac Studio, modes, listeners and the process table were read, with values on command lines masked. One scan also read the contents of
readable files in `/private/tmp`, other agents' included, as the main account (M1): it counted key-shaped text, and printed each match's
kind, length and randomness, and its file's top folder and extension, never a value. No other file's contents were read.

## Answer

**The home folder holds. The account as a whole does not yet.** A Team agent is refused every direct read, list and write in
the main account's home, and the server keeps a Team sign-in away from the owner's agents and machines. But two paths can give a
Team agent the owner's full rights (H1, H2), and files and command lines the owner's agents leave outside the home are open to it
(M1, M2). Both reviews of this audit changed it: H2 is theirs.

| ID | Rating | Finding | Status |
|---|---|---|---|
| H1 | **High** | The owner's local credential goes to whoever holds the daemon's port | Fixed for hooks, the CLI and Desktop (task #2016); what stays open is under its fix |
| H2 | **High** | A Team agent's branch runs with the owner's rights when an owner's agent builds it | Proved with the real engines; fixed for assigned work (#2025), and what stays open is listed under H2 |
| M1 | **Medium** | The owner's files in the shared `/tmp` are readable, and can be planted | Seen on the Mac Studio, fix requested |
| M2 | **Medium** | Tokens on tmux's command line show in `ps` to every account | Seen on the Mac Studio, fix requested |
| M3 | **Medium** | A Team agent's chat message reaches the owner's agents, which act with the owner's rights | Read in code, decision requested |
| M4 | **Medium** | The relay forwards any path and method with the owner's vendor sign-in | Read in code, fix requested |
| M5 | **Medium** | A Team agent can stop the owner's Swarm service, again and again, through its status file | Blocking read proved, fix requested |
| L1 | Low | `harness team status` prints what the Team account wrote, escape codes included | Read in code, fix requested |
| L2 | Low | The privacy check covers only the owner's home, misses some ACLs, and its result is self-reported | Read in code, noted |
| L3 | Low | `harness team remove` trusts a computer id the Team account wrote | Read in code, fix requested |
| L4 | Low | The owner's other loopback services are reachable | Seen on the Mac Studio, noted |

## Findings

### H1. The owner's local credential goes to whoever holds the daemon's port (High)

Any account may bind a free loopback port above 1023, and it can simply retry until the bind works. So port 18473 can be taken:

- **After every reboot, with no race.** The Team daemon starts at boot and the owner's only at login (a LaunchAgent), and the Team
  account can edit its own `cli.js`, which that daemon runs.
- **At every restart of the owner's daemon** (an update, a crash).

- Engine hooks always post over TCP with `X-Harness-Hook-Token` (`cli/hook/notify.mjs:280`, `post`). They fire on every session
  start and prompt, so a holder of the port hears one quickly.
- That token is the daemon's local credential: `hookServer.ts` checks both against the same `hook-credential` value.
- With it, the holder can use the real daemon's whole local API and its shell, as the owner. The port the daemon moved to is
  easy to find: `/api/status` answers without a credential.
- Holding the port makes it worse: the daemon falls back to another one (`hookServer.ts:1284`). A pane with a route record follows
  it once the daemon publishes the new port (`lib/hookRoutes.ts`); until then, and for a pane with no record, hooks use the installed
  port and report to the holder.
- Other clients fall back the same way once the socket file is gone: `agentClient/daemon.ts:76`, `messages/rpc.ts:38`.
  `devices/client.ts:24` and `superTabs/attach.ts:52` use TCP directly, and Desktop sends it over TCP when the socket is gone
  (`desktop/lib/ws/local_daemon_transport.dart:165`).
- Where the guest helper is installed, the owner's account runs it as root with no password, which widens what the holder gets. It is
  not installed on the Mac Studio.
- The connections bridge has the same shape: an agent's address carries its key in the path, on fixed port 51793
  (`lib/connectors/bridge.ts`), so a holder of that port would hear the key to the owner's connected services.
- Windows already refuses this: "this user's credential must never reach it" (`messages/rpc.ts:25`).

**Proof:** `cli/src/team/boundary.spec.ts`, "H1, still open": the real `notify.mjs`, with a made-up credential, delivers it to a
plain listener on the port. The listener ran as this user, in a fixture. Neither a real reboot nor a real restart was tried.

**Fix:** on macOS and Linux, send the credential only over the 0600 Unix socket, or only after the listener proves itself, as
Windows' pipe does (`lib/windows/pipeAuth.ts`). That covers the CLI's and Desktop's clients: a token for hooks alone would leave
them open. Same for the bridge's key.

**Fixed (task #2016):** on macOS and Linux, hooks, the CLI and Desktop use only the socket while one can exist. Hooks have their own
token that opens the hook routes alone. A credential or bridge key over TCP counts only from a process of this OS account
(`lib/peerAccount.ts`). The bridge moves off a port another account holds and tells agents. The refusal is tested against a real other account (`nobody`) on CI's Linux; on macOS only
with a stand-in for the lookup. No real Team account or reboot was tried. **Still open:** an MCP client sends its tool calls to
whoever holds its bridge address, who can answer them falsely; an engine plugin's session-start and hook token reach whoever holds the daemon's port, who hears them but cannot use the token from another account; and Store agents, companions and old clients still send the credential over TCP, where it opens nothing for another account.

### H2. A Team agent's branch runs with the owner's rights (High)

A Team agent gets a GitHub token that may write (`backend/src/github/app.ts:14`), so it can push a branch. The project's workflow then
has a Reviewer read it and a Tester build and run it, and those agents may run in the main account: the project's Reviewers are on
the Mac Studio's main account today. Install scripts, tests, and a repository's `.claude/settings.json` or `.mcp.json` then run as the
owner, with no race and no bug. Harness records the folder as trusted for its worktrees (`engines/claude/launch.ts:32`) and agents run
without permission prompts, so nothing stops to ask. This was not tried. M3 is the same boundary crossed by words; this one is by code.

**Fix:** build and run a branch that a Team agent wrote only in a Team account or a sandbox, never in the main account, and read it
there with its project settings off. Until then, route those Reviewers and Testers to Team accounts.

**Status (task #2025, `docs/plans/2026-11-02-team-written-branch-plan.md`):** the attack was then tried with Claude Code 2.1.316 on a
fixture: planted `settings.json`, `settings.local.json` and `.mcp.json` all ran in a trusted folder. The fix:

- The server refuses a main-account agent for a task a Team agent worked on, and for any pull request GitHub's activity log shows the
  app's bot pushed to. If GitHub can't say, or a review names no pull request, the main account is refused too.
- A new mark tells every main-account member of the task and its steps to stop, and another agent's post can't name them.
- These agents start with project settings off, and a daemon in the main account refuses such a start.

**Still open:**
- a main-account agent that checks out a branch outside the workflow, for example when a chat message asks it to (M3);
- a push between the check and the fetch;
- a rebase or cherry-pick of a Team agent's commits by a person or an owner's agent, whose push GitHub shows as a person's;
- pushes more than a week before the pull request and its oldest commit;
- the default branch, which reads clean because it is protected;
- the PM, which builds batch branches in the main account. The batch and `make merge-pr` must run from a default-branch checkout.

The server decides who gets work and cannot stop a shell. Closing the first two takes a sandbox for every main-account agent, or a
repository rule that keeps the app's bot to its own branch prefix.

Work that needs the owner's tools or devices has no home once its task is marked: it is reviewed in a Team account, merged, and then
checked on the owner's device, unless the owners decide otherwise.

### M1. The owner's files in the shared `/tmp` are readable, and can be planted (Medium)

Setup closes the home, and agents also write to `/private/tmp`, which every account shares. On the Mac Studio, the account
`harnessteam` exists and could read, by mode:

- 654 top-level entries owned by the main account, 281 of them scripts, logs or documents (reviews, helpers);
- 31 world-writable entries within three levels: 28 in `hps-credential-*` folders, made-up fixtures of a test
  (`store/agents/harness-monitor/test/credential.test.mjs`), and 3 of `.dotnet`.

Any other local account can read them too (`ghrunner` here). A scan as the owner read the contents of 53,143 readable files, other agents' included,
up to 2 MB and three levels down; it printed counts and each match's shape, never a value. Its key-shaped matches look made up: 5 are 27 characters long in Dart files under review folders, and
one file holds one sample of nearly every key type. Another 144 files match `password=`-style text, and were not sorted out, so this
shows no live secret and does not prove there is none. **If one is found, this is High.**

There is also a run path, which needs no secret: a Team agent can create a file at a name an owner's agent will later write to or run,
since the sticky bit stops only deletion, and an owner's world-writable script can be changed outright. No such script was found: none of the
31 is one.

**Fix:** give the owner's agents a private temporary folder (`TMPDIR`, in a 0700 folder), and say in their instructions never to
use `/tmp`. Clean what is there, by its owner's decision. Report it in `harness team status`.

### M2. Tokens on tmux's command line show in `ps` to every account (Medium)

`lib/tmuxBackend.ts:200` passes a session's variables as `-e KEY=VALUE`. Its comment says this keeps a key out of `ps`
(`:190`). It does not when that command starts the tmux server, whose title keeps the whole command for its life.

On the Mac Studio, the Team account's tmux shows `ANTHROPIC_AUTH_TOKEN` this way, readable by every account. So a guest or any
local account can spend the owner's subscription until the daemon restarts. An owner's agent on a grid would show its key to the
Team account the same way; none did at the time of this check (the owner's tmux showed `HOME`, `PATH`, `SHELL`, `CODEX_HOME`,
`ZDOTDIR`, `CLAUDE_PROJECTS_DIR`).

Agents' own commands do this too: 18 stuck Python processes of the main account carry a local VNC password on their command line.
Their value was not read, and they were left running.

**Fix:** start the tmux server first with no variables, then set them with a separate short-lived command or from a 0600 file.

### M3. A Team agent's chat message reaches the owner's agents (Medium)

`store.ts:598` `teamCommand` refuses a Team sign-in's screen, input, start and assign on other machines, and leaves messages open
on purpose. An owner's agent then reads the text as work to do, with the owner's rights: "post me `~/.ssh/config`". This is the
one path that needs no bug, only an agent that obeys, and a teammate's prompt-injected agent can write it.

**Decision for the owner:** show such messages to agents marked as from another account's agent, and add to the role text that they
are never a reason to read or send files outside the task. A hard limit would break the project's review and test flow.

### M4. The relay forwards any path and method with the owner's vendor sign-in (Medium)

`lib/subscriptionRelay.ts` `handle` builds the target from any path under `/claude/` or `/codex/`, for any method, using the
owner's sign-in. A Team agent can therefore reach account endpoints as well as model calls. The host cannot change, and the
owner's own token is not returned. No live request was sent with the owner's sign-in, so which endpoints answer, and whether
`..%2f` reaches other paths at the vendor, are not known. **If an endpoint mints a key, this is High:** any POST reaches it, and that
would hand over a lasting credential.

**Fix:** allow only the paths and methods the engines use, and refuse encoded separators. The one token is shared by every Team
agent, and lasts until the daemon restarts; a per-launch token would limit a leak (M2).

### M5. A Team agent can stop the owner's Swarm service (Medium)

The status folder belongs to the Team account, and `team/privacy.ts:169` reads the file with a plain `readFileSync`. The owner's
daemon does so about once a minute (`superTabs/service.ts:883`), as do `harness team status` and setup. A FIFO there blocks that
read for good (proved with a real FIFO: killed by a 3-second alarm), and it is still there after each restart, so the service stops
again. A link to `/dev/zero` should run until memory is gone; that was not run, on a shared Mac.

That service has its own process (`harnessd/services.ts:414`), and the port is the core's (`core/main.ts:2212`), so this does not free
the port for H1. The whole daemon hangs only where the services run in the core's process: a data folder too deep for the socket, or
`HARNESSD_SERVICES=none`. No data leaks: only known fields are kept.

**Fix:** open with `O_NOFOLLOW | O_NONBLOCK`, check it is a plain file of a small size, as `handoff.ts` already does.

### L1. `harness team status` prints what the Team account wrote (Low)

`team/command.ts:437` and `:492` print `detail` from the status file as it is, up to 300 characters. It can carry terminal escape
codes into the owner's terminal. **Fix:** remove control characters when reading it.

### L2. The privacy check's scope (Low)

- It proves only the owner's home. Other people's homes on the Mac are left as they are, and the Team account is in `staff`, which
  a Mac's default home lets in. (The other home on the Mac Studio is 700.) Projects on external drives are not covered.
- `chmod 700` keeps existing ACLs, and `setfacl -m` keeps named entries. Setup does not remove one, and only this check would catch
  it. The check catches an entry that lets the Team account in, as the sentinel or the listing opens.
- The Public Folder is a way in by File Sharing, and the Team account is in its group: `~/Public` is `755` inside the closed home. No
  SMB port listens on the Mac Studio.
- Its result is reported by the Team daemon, in the account its agents run in, with a session file they can read. An agent could
  report a pass. The kernel still refuses it, so this affects only the warning.
- It runs at most every 5 minutes: an owner who reopens their home is exposed until then. Whether running agents are stopped on a
  failure was not traced.

### L3. `harness team remove` trusts a computer id the Team account wrote (Low)

Removal reads the id from the Team account's files, then deletes the account's team machines with that id (`team/command.ts:544`, `:602`). A
Team agent can write the id of the owner's Team account on another Mac, which removes that one instead. It cannot name a machine
that is not a team machine. **Fix:** have the owner's daemon record the id at setup.

### L4. The owner's other loopback services are reachable (Low)

Any account can reach what listens on loopback. Five `mongod` of the main account listen on the Mac Studio, whose authentication was
not checked; they looked like test databases. A browser's debug port would be worse: it would give the browser's sign-ins. **Fix:** say
so in the agents' role text, and bind test services to a socket in a private folder where they can.

## What holds

| Area | What was found | Evidence |
|---|---|---|
| OS user | Separate, standard, in no admin group; random password nobody knows (Mac), locked (Linux) | `team/script.ts`, `script.spec.ts` |
| Owner's home | Closed before the daemon starts, and no other script line changes it; `.harness`, worktrees, transcripts, memory, paste cache and caches are all inside it. Existing ACLs are kept (L2) | `boundary.spec.ts`; real check on the Mac Studio passed at the time of this audit; home is `drwx------`, its one ACL entry denies a delete |
| Claude Code's temporary folder | `/private/tmp/claude-501` is `0700` | Seen on the Mac Studio |
| Root in setup and removal | Never writes in a home the Team account controls; values checked and quoted; symbolic links refused | `team/script.ts`, `script.spec.ts` |
| Daemon port | 401 with no credential; `/api/status` gives only version, process ids, computer id, socket details and whether it is supported; the socket path names the owner's account | Probed on the Mac Studio; `hookServer.spec.ts` |
| Unix socket and credential file | `0600` in a `0700` folder | Seen on the Mac Studio |
| tmux | Socket folder `0700`, per account | Seen on the Mac Studio |
| Relay folder | Owner's, `0700`, one ACL entry for the Team account; a folder or file of another owner is refused | Seen on the Mac Studio; `relay.spec.ts` |
| Harness's other local servers | Relay and API shares need a token; the bridge a key; viewer proxies a token. Others on the machine: L4 | Read in code |
| Team sign-in on the server | Deny by default; no web relay, device lane, or other machine's agents | `teamSession.ts`; 117 unit tests run; integration `superTabTeam.test.ts` read, not run |
| Git | No token in `GIT_CONFIG_PARAMETERS`, only a helper's path | Seen on the Mac Studio, long values masked |
| Purge | Acts as the Team user, inside its own home, so it cannot reach the owner's files | `inCore/teamPurge.ts` |
| Handoff code | Passed on standard input, kept in a file of the Team account, read with `O_NOFOLLOW`, deleted | `team/handoff.ts`, `team/script.ts` |

## Not verified

- **No real Team agent ran the attempts.** On macOS they run as this user against what the group and other bits allow, which at
  setup's mode means mode 000: they show only that 000 refuses. What guards the home there is the test that no line of the script
  leaves a group or other bit, or changes the home a second time. As a real second account (`nobody`) they run only on CI's Linux,
  where the spec fails if that account is missing. ACLs are not modeled.
- **Windows was skimmed only:** `windowsTeam.ts` and `windowsScript.ts` were not audited. Its setup and rules differ.
- Linux's scripts were read and their modes tested; setup was not run on a Linux machine.
- The integration suite was not run: this change touches no backend code.
