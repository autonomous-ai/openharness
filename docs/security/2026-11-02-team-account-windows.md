# Harness Team account on Windows: can its agents reach the owner's files?

Security pass of 2026-11-02 (task #2022), at `origin/main` 29795af79. It covers what the macOS audit
([2026-11-02-team-account-boundary.md](2026-11-02-team-account-boundary.md), task #2009) left out: `cli/src/team/windowsTeam.ts`,
`windowsScript.ts`, `windowsLayout.ts`, and what they rely on: the OS user, the closed profile, the shared folders, local ports and
pipes, the relay and purge. **No Windows machine was used.** Everything below was read in code, or tested on a Mac against the
text and values the code produces. Nothing on a real account, permission or file was changed.

## Answer

**The folders hold; the daemon's port does not.** Ports were covered only in part: the Team daemon's own port was not read. The ACLs setup writes keep the Team account out of the owner's profile.
Other accounts can't read the sign-in code or the relay's token, and the daemon's pipe proves both ends. On Windows the owner's
local credential went over TCP to whoever holds the daemon's port, and the daemon accepted it from any account (W1, fixed in
task #2095; the connectors bridge's port is still open, its own task, so Team accounts on Windows are not closed yet).
The Team account's daemon starts at boot, before the owner signs in. Purge was written for POSIX paths. It never deleted a
Codex Product Manager's own home on Windows (W2, fixed in this pull request), and it can't finish a Claude Code one there (W3).

| ID | Rating | Finding | Status |
|---|---|---|---|
| W1 | **High** | The owner's local credential goes to whoever holds the daemon's port, and opens the daemon from any account | **Fixed** in task #2095 for every client, test first. The Store add-ons over the pipe (task #2161): fixed in code, pending their real Windows run. The connectors bridge is still open (own task) |
| W2 | **High** | Purge left a Codex Product Manager's whole home on Windows, and could take every PM's home on any platform | **Fixed here**, test first |
| W3 | Medium | Purge can't scrub a Claude Code Product Manager on Windows: the account stays held, its memory stays | Read in code, fix requested |
| W4 | Medium | The Team account can stall the owner's read of its status file | Read in code, fix requested |
| W5 | Medium | The elevated scripts walk and delete folders the Team account can write | Read in code, fix requested |
| W6 | Low | Setup closes the profile folder itself, not what inside it lets others in | Read in code, noted |
| W7 | Low | The elevated setup prints what the Team account wrote to the administrator's console as it is | Read in code, fix requested |

The macOS findings that don't depend on the platform apply here unchanged: H2 (an owner's agent builds a Team agent's branch), M3
(a Team agent's message reaches the owner's agents) and M4 (the relay forwards any path). L1 and L3 are fixed on every platform.

## Findings

### W1. The owner's local credential goes to whoever holds the daemon's port (High)

This is the macOS H1 again, but on Windows nothing of the #2016 fix applies:

- **Hooks send it over TCP.** `cli/hook/notify.mjs:321` `hookRoute`: on Windows every engine hook posts to
  `127.0.0.1:<port>` with the full `hook-credential`, not the hook-only token. Hooks fire at every session start and prompt,
  and the request carries the owner's prompt too (as `notify.mjs`'s own comment on `hookRoute` says): the holder reads it.
- **CLI clients add it to TCP requests.** `lib/localCredential.ts:35` `localCredentialHeaders` returns the credential on Windows
  whatever the path (on macOS and Linux only when no socket can exist). Which of its callers speak TCP on Windows is under
  "Not verified".
- **The daemon accepts it from any account.** `lib/peerAccount.ts:112` `peerIsThisAccount` answers yes on Windows without
  asking. `hookServer.ts:496-500` then lets the holder use the whole local API, the owner's shell included.
- **No race is needed after a reboot.** The Team daemon's task starts at boot (`team/windowsScript.ts:649`, `BootTrigger`). The
  owner's daemon starts at their sign-in (`harnessd/platform.ts:302`, `LogonTrigger`) or on a timer. The Team account can change
  the code its task runs: `cli\<version>\cli.js` in its own profile. Windows lets another account bind a free loopback port. While
  the first socket is open, Windows refuses a second account the same port, so the holder must get there first: at boot, or at a
  daemon restart.
- **Holding the port makes it worse.** Seeing the port taken, the owner's daemon moves to another one (`hookServer.ts:1292`;
  on Windows its pipe path is always set, `lib/localSocket.ts:73`). Hooks keep posting to the installed port, to the holder.
- What holds: Desktop never sends the credential over TCP on Windows (`desktop/lib/ws/local_daemon_transport.dart:167-173`).
  The messages RPC uses only the pipe (`messages/rpc.ts:20-25`). The pipe proves both ends without sending the token
  (`lib/windows/pipeAuth.ts`).

**Proof:** `cli/src/team/windowsBoundary.spec.ts`, "W1" (named "W1, still open" until the fix): on Windows a client put the credential on a TCP request,
and the daemon counted it from a caller it never looked up. Not tried on Windows.

**Fix:** on Windows, send hooks and every CLI request over the daemon's proven pipe, and never the credential over TCP. Until then,
make the daemon refuse the credential over TCP from another account. Windows can say who owns a loopback connection
(`GetExtendedTcpTable` gives the owning process, whose token names its account).

**Fixed (task #2095).** All three parts, each test first; the W1 tests above are turned around:
- The daemon asks Windows who owns the calling end of a TCP connection that showed a valid secret (`lib/peerAccount.ts`
  `windowsPeerQuery`: `Get-NetTCPConnection`, then the process's owner SID against this account's). Anything but a clear yes is
  no. This alone makes a credential heard on the port useless to another account, from an old client or plugin too.
  It takes only a process that started before the connection was made, so a recycled process id never counts. At most four
  lookups run at once and up to 32 wait their turn; one past those is no for now, and is asked again on its next request. A
  lookup that times out stays no for that connection.
- Hooks post over the daemon's pipe (`hook/notify.mjs` `windowsDaemonPipe`), proving the token without sending it, and take an
  answer only with the daemon's proof. With no live pipe they post nothing, as on macOS with no socket.
- CLI clients never put the credential on TCP (`localCredentialHeaders` gives nothing on Windows). Their fetch helper and their
  WebSockets go over the pipe (`lib/localTransport.ts` `daemonFetch`, `openLocalWs`), and with no pipe they say Harness is not
  running.
- The Store add-ons (Harness Monitor, Machine Monitor, Memories, Autonomous Grid) and the Store's dev tools sent the credential to
  `127.0.0.1:18473` on Windows, the default port the Team daemon takes at boot. Task #2095 stopped that; task #2161 makes them work again:
  their one shared transport (`lib/localDaemon.mjs`, a copy of `store/tools/local-daemon.mjs`) reaches the daemon over its pipe as
  the hook does, with the pipe auth and the daemon's proof before any answer or WebSocket open, and with no live pipe says Harness
  is not running. Their `localCredentialHeaders` give nothing on Windows and their 401 probe never runs there
  (`store/tools/windows-pipe.test.mjs`, run on Windows by the Windows workflow, with `store/tools/windows-ci/store-pipe.mjs`
  against the installed daemon).
- Still open, rated Medium, its own task: the connectors bridge. Its default port (51793) is the same for every account, the Team
  daemon also starts connectors, and on Windows `portHolderIsThisAccount` answers null, so the owner's bridge never moves off a
  held port (`services/connectors.ts`). Whoever holds it from boot reads every tool call of the owner's agents and can answer them
  falsely, and Harness's own `bridgeRoute` trusts those answers too. The key opens nothing from another account now. macOS has the
  stdio shim and the move-off (#2558, #2550); Windows has neither. The fix is the shim and Harness's route over the proven pipe;
  a Windows listener-owner lookup, so the bridge moves off a held port, is a cheap first step.
- Still open: the OpenCode, Kilo, Pi and Amp plugins (`engines/kit/pluginFetch.ts`) have no socket on Windows and post to the
  port with the hook-only token and the session's details. The token opens nothing from another account now, but whoever holds
  the port hears both, and each new connection costs the daemon's one-second lookup. They need the pipe too, a separate task.
- A recorded daemon pid that another account runs now is no daemon to the hook and the CLI's WebSockets (EPERM), so a pipe made
  under a dead daemon's name is never dialled for it. A pid this account's own process took since is still dialled; then only the
  pipe's proof refuses the answer, after the request was sent. That needs the pid reused by chance, not by choice.

### W2. Purge left a Codex Product Manager's home on Windows (High, fixed here)

`superTabs/inCore/teamPurge.ts` deletes a purged Codex PM's own engine home only if its path starts with `<home>/.harness-pm-homes/`.
`pmEngineHome` (`superTabs/teamDaemon.ts:35`) builds it with `join`, which gives `\` on Windows, so the check never matched.
Purge answered `ok`, and the PM's Codex history, sessions and sign-in stayed in the Team account for its next agent to read. The
sweep doesn't look there.

The same check also matched a home one level under the PM homes folder. Purge deletes the home's parent, so that would have deleted
every PM's home. It also took any id, and Windows drops a name's trailing spaces and dots: an id of `.. ` is `..`, and the parent
deleted is the whole Team home (security review 1 of this pull request). Only the daemon writes the record, in the Team account's
data folder, so this needs a bad record, or a Team agent that writes it.

**Fixed:** `isPmCodexHome` accepts exactly `<home>\.harness-pm-homes\<id>\codex`, checked with the platform's own path rules,
and the id by `pmEngineHome`'s own rule (`PM_START_ID`: letters, digits, `_` and `-`).
`ownHomeFolder`, main's check for a Team-written agent's own home, follows the same id rule, so `.. ` is refused there too.
Tests: `teamPurge.spec.ts`, "isPmCodexHome" (with `path.win32`), and "of a Codex session whose home is not one of
pmEngineHome's". Both fail on `main`; the `.. ` case fails without the id rule. PR #2559 adds the same `/` check in a second place and needs the same helper.

### W3. Purge can't scrub a Claude Code Product Manager on Windows (Medium)

`teamPurge.ts:120` `folderOf` uses a session's folder only if it starts with `/`. A Windows worktree (`C:\...`) never does,
so the scrub skips its transcript folder, its project memory, its history lines by folder, and its entries in `.claude.json` and
the backups. Then the sweep finds the transcripts, which are named by session id, and answers `SCRUB_INCOMPLETE` at every retry.
The account stays held until a person steps in, which is said (it fails closed). Files the sweep can't name, such as the
project's `memory/` notes, are not checked. `sweepForSession` also looks for `"<folder>/`, a POSIX separator.

**Fix:** derive the folder and its separators from the platform, as W2 does. That covers Claude Code's slug for `C:\` and how
Claude Code writes a Windows path in its history and config. Test with `path.win32`. Check against a real Windows Claude Code home.

### W4. The Team account can stall the owner's read of its status file (Medium)

This is the Windows form of macOS M5. The Team account may write `C:\ProgramData\Harness\Team` (`windowsScript.ts:77`, `status`).
The owner's daemon reads `status.json` there about once a minute, synchronously (`superTabs/service.ts:883`,
`team/privacy.ts:164` `readStatusFile`), as do `harness team status` and setup.

- An exclusive oplock that the Team account takes on its own file makes the owner's open wait until it lets go. On Windows a
  `CreateFile` waits for the oplock to break. That would stop the owner's Swarm service, as the FIFO did on a Mac.
- `O_NOFOLLOW` and `O_NONBLOCK` exist only on POSIX (Node documents Windows' flags), so the open follows a symbolic link. A
  file link needs Developer Mode or the privilege. The size check after the open still bounds what is read.
- A file opened without sharing gives `EBUSY`, which is read as no status. That is harmless.

Not tried: no Windows machine.

**Fix:** read the status off the daemon's main thread with a deadline, in a worker or a child process. Or ask the Team daemon
for it over a connection with a timeout.

### W5. The elevated scripts walk folders the Team account can write (Medium)

`Remove-Tree` (`windowsScript.ts:104-114`) checks that a folder is not a link, then lists it and deletes by path. Removal runs it,
as an administrator, on the Status folder (`:799`, which the Team account may write) and on what is left of its profile
(`:784`, `:790`). A Team process alive at that moment could swap a checked folder for a junction, and the administrator would
delete files elsewhere.

Removal stops the Team account's processes once (`:739-744`). A process still running then holds the profile, and removal stops
before deleting anything (`:761-764`). Only a process that starts between that check and the account's deletion (`:771`) could
race this. That means a new sign-in of the account, such as a task it registered itself. Tasks the Team account registered are
not removed with it. So a Team agent could register a repeating task long before any removal and aim at that window, rather than
count on luck. Whether a standard account can register a task that runs while it is not signed in (an S4U task; setup gives it
the batch logon right) is under "Not verified": rated Medium until it is (security review 1 of this pull request).

On a repair, `Set-Folder` sets an inheritable ACL on the existing Status folder (`:128-130`), and Windows propagates it into the
Team account's files there. Whether that propagation follows a link the account planted was not checked.

**If such a task can be registered, this is High:** deleting as an administrator can be turned
into taking the computer. **Fix:** first rename the folder inside the administrators-only parent, and take the Team account's
access off it on the open handle, without propagation. Then delete by handle, refusing reparse points. Also remove the Team
account's own scheduled tasks.

### W6. Setup closes the profile folder itself, not what inside it lets others in (Low)

Step 4 (`windowsScript.ts:488-498`) removes the explicit allow ACEs for Everyone, Users and Authenticated Users on the profile
folder itself. It doesn't remove inherited ones, and it doesn't look inside. Every Windows account has "Bypass traverse checking",
so a file or folder inside the profile with its own ACE for those groups opens by its full path, though the profile can't be
listed. The privacy check tries eight fixed places (`windowsTeam.ts:51-64`), so it would miss one elsewhere. Default profiles have
no such ACE. None was looked for on a real machine. Also:

- `C:\Users\Public`, and folders an owner's tool makes at `C:\` or in `C:\ProgramData`, are readable by every account. On Windows
  the owner's per-user temporary folder is inside the profile, so macOS M1 is narrower here. Not looked at.
- The check fails for Administrators only (`windowsTeam.ts:104`). Setup takes the account out of that group alone
  (`windowsScript.ts:466`). A repair would leave any other group that someone gave the account.

**Fix:** have setup list, without changing them, explicit broad ACEs under the profile in a bounded walk, and say so in
`harness team status`.

### W7. The elevated setup prints what the Team account wrote (Low)

The one-shot runs as the Team account append to a file in the stage, which that account may write (`windowsScript.ts:393-395`).
The account may also list the stage. Setup prints those lines to the administrator's console as they are (`:534`, `:541`), so they
can carry terminal escape codes. This is L1, in an elevated window. **Fix:** remove control and format characters before printing,
as `privacy.ts` `statusText` does.

## What holds

| Area | What was found | Evidence |
|---|---|---|
| OS user | New standard user in Users, taken out of Administrators, visible; 40-character password from the system's generator, never on a command line or in output, handed to Task Scheduler and cleared. Batch logon given to its SID alone and taken back at removal | `windowsScript.ts:354-367, 446-473, 781`; `windowsScript.spec.ts` |
| Not an administrator | The privacy check fails on Administrators in the token, deny-only included | `windowsTeam.ts:104`; `windowsTeam.spec.ts` |
| Owner's profile | Tied to the owner by Windows' profile list, not by name; broad ACEs on the folder removed; sentinel made by handle (`CreateNew`), given to the owner, no ACE of its own; listing refused, checked every 5 minutes | `windowsScript.ts:423-429, 488-517`; `windowsTeam.ts:51-108` |
| Shared folders | Each one is made with its ACL in one call, and protected. One that already exists must be a plain folder of Administrators or SYSTEM. The Team account adds nothing to the handover folder and can't remove it; it writes in Status but can't delete the handover folder in it | `windowsScript.ts:117-131, 543-566`; `windowsBoundary.spec.ts` |
| Sign-in handover | Other accounts can't read it (protected, no Users ACE). The owner writes only to a plain folder and file. The Team account reads a plain small file once, and deletes anything else unread | `windowsTeam.ts:221-253`; `windowsBoundary.spec.ts`, `windowsTeam.spec.ts` |
| Relay folder | Protected: owner, SYSTEM, Administrators full, Team account read, nobody else. Both sides check the owner's SID of the folder and the file. `icacls` gets an argument array | `windowsScript.ts:553-561`; `relay.ts:214-240`; `windowsBoundary.spec.ts` |
| Daemon pipe | Both ends prove the token by HMAC; a squatter on a dead daemon's name learns nothing usable | `lib/windows/pipeAuth.ts` |
| Terminal host pipe | Its own pipe per user and home, named with 16 random hex digits per start, made first (`FILE_FLAG_FIRST_PIPE_INSTANCE`), DACL `D:P(A;;GA;;;<user SID>)` (the user alone connects), remote clients refused; the daemon checks the host's hello proof of the token | `pty/src/transport/windows.rs:1-17, 172`; `lib/ptyHost/protocol.ts:135-160` |
| Desktop, messages | Only over the pipe on Windows, never the credential over TCP | `local_daemon_transport.dart:167-173`; `messages/rpc.ts:20-25` |
| The task | Runs as the Team account, least privilege. Every account may read it; the owner may also start it. Its XML holds backend addresses only, and its values are limited to what `cmd.exe` passes unchanged | `windowsScript.ts:46-58, 607-688`; `layout.ts` `carriedBackendEnv` |
| Elevated scripts | Every value checked and single-quoted (every PowerShell quote). The administrator writes nothing in the Team profile; only Administrators and SYSTEM change the stage (the Team account lists and reads it, and writes its own output files there, W7); copies refuse links | `windowsScript.ts:31-44, 170-253, 369-383`; `windowsScript.spec.ts` |
| Status text | Control and format characters removed before the owner sees them (L1) | `privacy.ts:180` |
| Removal | Refuses an account or profile that is not ours. When the profile is held, it changes nothing and starts the task again. It forgets only team machines hosted by the owner's machine (L3) | `windowsScript.ts:716-776`; `command.ts:556-562` |

## Not verified

- **No Windows machine.** Nothing here ran on Windows: not the ACLs, the oplock (W4), the race (W5), the port (W1) or Claude
  Code's Windows paths (W3). The SDDL tests check what setup asks Windows for, not what Windows did.
- Whether another standard account can read a Team or owner process's command line on Windows (macOS M2). Windows normally
  needs a right on the process that it doesn't give across accounts. Not checked.
- Ports were covered only in part: the Team daemon's own loopback port (18493) was not read beyond what the macOS audit says.
  The terminal host's pipe was read (under "What holds", security review 2 of this pull request); nothing about it ran on Windows.
- Which callers of `localCredentialHeaders` speak TCP on Windows (W1): the CLI's were traced and moved to the pipe in task #2095;
  the Store add-ons' own copies send nothing to the port on Windows, and reach the daemon over its pipe since task #2161.
- Whether a standard account can register a scheduled task for itself that runs while it is not signed in (W5).
- The integration suite was not run: this change touches no backend code.
