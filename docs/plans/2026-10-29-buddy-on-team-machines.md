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
4. **Privacy is checked while it runs, not only at start.** A Team account whose privacy check fails or goes stale
   stops its Buddies (session closed, data purged as for confidential sessions) and tells their people in their chat.
   The privacy check is also run at launch (dispatch).
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
  much like Team account setup today. Each user is a home of about 100–300 MB plus the project clone. The engine sign-in
  (Claude) has to come from the owner's relay, as it does for the Team account (#2114). Removal deletes the user.
- Linux: `useradd` needs root once per person, or an unprivileged user namespace (`unshare`/`bubblewrap`) without root
  where the distribution allows it.
- Cost: an admin prompt per person per machine, a user to tidy up, and a launch path that crosses users (the daemon
  starts the Buddy as that user through a small privileged helper, or the user's own login agent).

### B. Each Buddy in an OS sandbox under the Team account's user

The Buddy's processes run in a sandbox that denies the Team account's Harness files, engine homes other than its own,
the daemon's socket and other agents' folders. It can reach only its folder, the engine API and a narrow Buddy endpoint.

- macOS: `sandbox-exec` with a profile (deprecated, but Claude Code and Codex use it for their sandboxes). Its rules
  apply to every child process. No admin needed.
- Linux: `bubblewrap` (namespaces) or Landlock. No root on most distributions.
- Its Buddy-bound sign-in reaches the server through a broker that accepts only that Buddy's token, never the machine's
  sign-in: the daemon's own socket stays outside the sandbox.
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
- **Migration and rollback:** new records only. Rolling back stops team-machine Buddies first (the `buddy.remove`
  steps).
- **Audience:** every rule is on the server: placement, token scope, chat-only reads, privacy stops.
- **Identity:** the Buddy acts only with its own sign-in, never the Team account's or the Mac owner's.
- **Failure:** a sandbox or user that can't be set up refuses the start with a reason in the Buddy chat. A privacy failure
  stops the Buddy and says so there.
- **Platforms:** macOS and Linux as above. Windows is refused, as Buddies are today.

## Carried over

Closed branch `kai/buddy-team-machines` (#2242): server placement into the Team account, the chat-only flag, the CLI
note, Team machines in the desktop and phone pickers, red tests for requirements 4 and 5, and the review's findings.

## Open questions

1. Is the Team account's Claude subscription the right one for another person's Buddy, or should the Buddy use its
   person's own engine sign-in through the relay?
2. Does Dee keep the line "Teammates there can read this chat." once this ships?
