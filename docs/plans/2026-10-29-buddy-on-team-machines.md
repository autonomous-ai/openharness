# A Buddy on a teammate's machine

Status: draft, for the Lead and Dee to choose an option. Date: 2026-10-29.

## Why

Dee (10-29) asked that a person pick where their Buddy runs, including a teammate's machine. #2242 built that inside the
Mac's Harness Team account, with a chat-only Buddy. Security review 1 found it unsafe (Critical), and #2242 was closed:

- Harness signs in per machine, not per agent. Anything that runs as the Team account's computer user can use that
  machine's sign-in to act as **any** agent there, the Engineers and Product Manager included. It can read their
  projects and workgroups (projects the Buddy's person may not see) and other Buddies' chats.
- A Buddy is steered by its person through chat, so the Buddy, and whoever steers it, is untrusted with respect to
  everything else on that machine.
- The only thing between a Buddy and that sign-in is its read guard (`cli/src/lib/buddyGuard.ts`), a Claude Code hook.
  It has been bypassed in four review rounds, and it documents that other processes on the same computer user can place
  links into the Buddy's folder.

#2234 (own machines) and #2240 (phone) ship without team machines.

## What must hold

1. **A Buddy reaches no sign-in but its own.** No file, socket or process environment of the machine's sign-in, the
   Team account's daemon, or another agent is readable or usable from the Buddy's processes. This is enforced by the OS,
   not by the agent's own hooks.
2. **Its sign-in is bound to that one Buddy and its chat.** The server mints it at start and accepts it only for that
   Buddy acting in that chat (read and post), on every route, host routes included. It is never valid for another agent,
   another chat, or a person.
3. **The machine's sign-in cannot act as that Buddy.** Today a Team account's sign-in speaks for every agent on its
   machine (`store.ts actor`). For a Buddy it would need the Buddy's sign-in too.
4. **Privacy is checked while it runs, not only at start, and the server does not wait for the host to stop it.** The
   check runs at launch (dispatch) too. A host that is offline can't acknowledge a stop or a purge, so:
   - **Revocation is immediate and server-side.** When the Team account's privacy check fails or goes stale, or its
     host's lease (below) lapses, the server revokes the Buddy's sign-in at once. Every route refuses it from then on,
     whatever the host does. The person is told in their chat.
   - **A bounded host lease.** The Buddy's sign-in is valid only while its host renews a lease (for example every 60 s,
     carrying a fresh passing privacy check). A host that can't renew it runs a watchdog that kills the sandbox (or the
     user's processes) when the lease runs out, so a Buddy cut off from the server also stops on the machine.
   - **Purge is pending until acknowledged.** The session's data on that machine is deleted when its host next connects
     and confirms it, as the existing closing-session hold (`heldFor`) does for confidential sessions. Until then the
     record says "purge pending", and the Team account keeps taking only that project's work.
   - **No rollback past enforcement while team-machine Buddies exist.** A backend from before this design doesn't know
     a revocation record, and its actor path lets the Team account's sign-in act as any agent resident there
     (`store.ts actor`). So revocation and expiry alone don't make a rollback safe. The rule, enforced by the release
     check rather than by hand:
     1. The first backend that enforces Buddy-bound sign-ins is the **floor** for any Swarm with a team-machine Buddy.
        The release/rollback check (`make release-backend` and the rollback runbook) queries every Swarm and refuses to
        deploy a backend below the floor while any team-machine Buddy agent or pending team-machine Buddy start exists.
     2. To roll back below the floor: first stop new ones (the server refuses every team-machine Buddy start from then
        on, recorded per environment so the old backend can't undo it before the revert lands), then remove every
        team-machine Buddy the way `buddy.remove` does (fail its starts, remove the agent, close its session, queue the
        host cleanup), and only then revert. The check above passes only when none are left.
     3. **Purge pending stays explicit.** Removed sessions whose host hasn't confirmed the purge stay as closing-session
        holds (`heldFor`), which older backends already keep. The Team account keeps taking only that project's work
        until its host confirms, before and after the revert.
5. **A chat-only read.** Full and change-feed reads give that Buddy only its person, its project's name, its chat and
   itself: no roster, emails, members, progress or repository (red tests are on the closed branch).
6. **Pickers match the server.** Eligibility (Team account present, private, not removed) and the account chosen come
   from the server, not recomputed in each app.

Unchanged: the people and agents on that Team account can still read the chat itself (its terminal, its files). The
picker says so: "Teammates there can read this chat."

## Options

### A. Each Buddy as its own computer user

The Team Mac gets one extra computer user per person who has a Buddy there ("buddy-<person>"). Their Buddies run there
with only their Buddy-bound sign-ins. File permissions keep them from the Team account and from each other.

- macOS: creating a user needs an administrator (`sysadminctl`/`dscl`), so the Mac's owner is asked once per person,
  much like Team account setup today. Each user is a home plus the project clone; the size of an empty home (a guess
  of 100–300 MB) is **unverified** and has to be measured. The engine sign-in (Claude) has to come from the owner's relay,
  as it does for the Team account (#2114). Removal deletes the user.
- Linux: `useradd` needs root once per person. (An unprivileged user namespace is not a separate user; that is option
  B and needs B's whole policy.)
- Cost: an admin prompt per person per machine, a user to tidy up, and a launch path that crosses users (the daemon
  starts the Buddy as that user through a small privileged helper, or the user's own login agent).

### B. Each Buddy in an OS sandbox under the Team account's user

The Buddy's processes run in a sandbox under the Team account's computer user. Every control below is required; **the
start is refused, with a reason in the Buddy chat, when any of them is unavailable** on that machine (an old kernel or
Landlock ABI, user namespaces turned off, `sandbox-exec` missing, the proxy not running).

- **Files.** Only its folder (read) and its own engine state are reachable. The Team account's Harness files, other
  engine homes, other agents' folders and the daemon's socket are denied.
- **Network: an external allowlisting proxy.** The sandbox has no network of its own. Its only outbound path is a
  proxy outside the sandbox that allows by host name: the engine's API and the Buddy broker, nothing else. Port rules
  alone (as Landlock gives) can't do this, since any HTTPS host would pass. Linux: a network namespace whose only route
  is the proxy's socket. macOS: the profile denies all network except the proxy's local port.
- **Processes and IPC.** No signals, tracing or process inspection outside the sandbox. No shared memory, Mach or
  XPC lookups, or Unix sockets other than the proxy's and the broker's. Linux: PID, IPC and mount namespaces. macOS:
  profile rules for `process-info`, `signal`, `mach-lookup` and `ipc`.
- **A sanitized start.** The Buddy starts with an empty environment plus an allowlist (no Harness or engine tokens, no
  `SSH_AUTH_SOCK`), and with every inherited file descriptor closed except its terminal.
- **Its sign-in.** It reaches the server only through the broker, which accepts that Buddy's token and nothing else.
  The daemon's own socket and sign-in stay outside.
- macOS: `sandbox-exec` with such a profile (deprecated, but Claude Code and Codex use it). Linux: `bubblewrap` for the
  namespaces plus Landlock for files. Neither needs admin or root on most systems.
- Cost: a sandbox profile to keep in step with Claude Code's needs (its config, cache and the API), a broker route, and
  testing on both platforms. The engine credential still has to be readable inside the sandbox, so the Buddy can use the
  Team account's Claude subscription. That's acceptable, since it already runs on it.

### Recommendation

**B first, with A as the fallback for a platform where B can't hold.** B needs no admin prompt per person and keeps
one computer user per Team account. Requirements 2–6 are the same for both and can land first, behind the picker
staying "your machines" only. Requirement 1 decides when team machines appear in the picker at all.

## Design (feature design rules)

- **Growth:** a Buddy's sign-in is deleted when its session closes or its person leaves. A per-person user (A) is
  deleted with that person's last Buddy on the machine.
- **Concurrency:** starting and stopping go through the existing start and closing-session records, guarded per agent
  and per machine part, as today.
- **Read cost:** the token check is one indexed lookup per request. The chat-only projection reads less than today.
- **Scale:** one sandbox (or user) per running Buddy. Team account memory is the first limit (each Buddy needs about
  2 GB, as now), shown by the machine's slots.
- **Compatibility:** older hosts never receive a team-machine Buddy start: it is offered only to hosts reporting a new
  capability, as the Product Manager start is.
- **Migration and rollback:** new records only. Rolling back below the enforcing backend is refused by the release check
  while any team-machine Buddy or start exists. Before reverting, stop new starts, remove every team-machine Buddy, and
  keep their purges pending until hosts confirm (requirement 4).
- **Audience:** every rule is on the server: placement, token scope, chat-only reads, privacy stops.
- **Identity:** the Buddy acts only with its own sign-in, never the Team account's or the Mac owner's.
- **Failure:** a sandbox or user that can't be set up, or a required control that is missing, refuses the start with a
  reason in the Buddy chat. A privacy failure or a lapsed lease revokes the sign-in at once and says so there. The
  machine-side stop and purge follow when the host can act (requirement 4).
- **Platforms:** macOS and Linux as above. Windows is refused, as Buddies are today.

## Carried over

Closed branch `kai/buddy-team-machines` (#2242): server placement into the Team account, the chat-only flag, the CLI
note, Team machines in the desktop and phone pickers, red tests for requirements 4 and 5, and the review's findings.

## Open questions

1. Is the Team account's Claude subscription the right one for another person's Buddy, or should the Buddy use its
   person's own engine sign-in through the relay?
2. Does Dee keep the line "Teammates there can read this chat." once this ships?
