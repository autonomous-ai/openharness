# Sharing a Windows computer with guests

Status: draft for security review. No code until the spike below answers and the review passes. Part of W7 of
[the Windows parity design](2026-11-04-windows-parity-design.md).

## What a person sees

The same as on a Mac (`docs/plans/2026-10-19-guest-machine-sharing-plan.md`): the owner turns sharing on once, Windows asks
once, and after that a guest they share with starts Claude Code or Codex in a workspace of their own on the owner's
subscription. The guest's agent cannot read the owner's files, except the folders the owner shared. Removing the guest
removes their account and everything in it.

## Why it is not the Mac's design

On a Mac the owner's daemon runs `sudo -n guest-helper`, and a tmux pane the owner holds becomes the guest through it. Windows
has no sudo, and a console cannot be handed across accounts: `CreateProcessWithLogonW` cannot attach a pseudoconsole. So what
crosses accounts is the terminal host, not the engine: each guest's account runs its own `harness-pty`, and the owner's daemon
drives it as one more host (`p<host>:%N` names already carry the host).

## Design

### Turning it on: one prompt, and one privileged program

- One UAC prompt installs `harness-guest-helper.exe` into `%ProgramFiles%\Harness\` and registers one task as SYSTEM to run it.
  It runs from there, never from a folder its owner can write: a SYSTEM program in `.harness` would be SYSTEM for whatever
  replaced it. It is signed in the payload and checked before the copy.
- It takes one request at a time from a folder only the owner can write, and accepts fixed verbs with strictly checked words:
  `create hg_<12 hex>`, `remove hg_<12 hex>`, `share hg_<12 hex> <folder> read|write`, `unshare …`. Anything else is refused and
  logged. It takes no command to run and no path to a program: nothing the daemon sends can make it run something else.
- It refuses any account but `hg_<12 hex>`, so it can never touch the owner, an administrator, or the Team account.

### A guest's account

- `create` makes a standard local account, `hg_<12 hex>` from the guest's email as on a Mac, with a random password nobody
  keeps, in no group but Users, denied network and interactive logon.
- Its host runs from a task in that account with **S4U logon**, so no password is stored anywhere. S4U has no network
  credentials, which a guest's agent does not need: it reaches models through the owner's relay, and git over HTTPS.
- Its home is a normal profile, which the owner's account cannot read and which cannot read the owner's. The Team account's
  privacy probes run in each guest account and prove the second half before a guest's first harness starts.

### The owner's daemon and the guest's host

- A guest's host admits two SIDs on its pipe, the guest's and the owner's (`D:P(A;;GA;;;<guest>)(A;;GA;;;<owner>)`), and proves
  its token in its hello as today. Today's host admits its own user alone, so this is one new, validated start option.
- Its discovery file and token are in a folder ACLed to those two SIDs, as the Team relay's folder is (`windowsRelayAclCommand`).
- The daemon reads that file and adds one more host backend, by the existing instance machinery. A pane on it is a pane to
  everything above: registry, `core/guestPolicy.ts`, `guestCreate.ts`.
- The engine's environment is what `GUEST_ENV_KEYS` allows and no more, sent in the create request.

### Removing a guest

`remove` ends the host's job, deletes its task, ACL entries on shared folders, profile and account, and says what it could not.
`harness uninstall` removes every guest first, then the task and the helper.

## The spike, before any code

On the Windows PC, with a signed build:

1. A host in a second account, started by an S4U task, with a pipe admitting the owner: can the owner's daemon reach it and open a
   pane? (If not: each guest needs their own daemon, as the Team account has, and this design changes.)
2. Does a pane's engine run under S4U at all: ConPTY, Node, Claude Code's own install and sign-in through the relay?
3. Is a profile created for an S4U task's first logon, or does the helper have to create it (`CreateProfile`)?
4. What does Smart App Control do with a signed program run as that account?

## For the security review

- The helper is the only new privileged code: is its request folder's ACL, verb set and word checking enough?
- S4U rather than a stored password.
- A second SID on a host's pipe: who else can reach it, and what can a guest's own agent do to the owner's daemon through it? It
  holds the pipe the owner dials, so the owner's daemon must treat what that host says as a guest's words: never the owner's.
- A guest's agent runs with no sandbox inside its account. The account boundary is the boundary, as on a Mac.

## Feature design rules

- **Growth:** one account, profile and task per guest. Removing a guest deletes them; a guest not used in 90 days is listed for
  the owner to remove. Nothing deletes a guest by itself.
- **Concurrency:** the helper takes one request at a time, by the request folder's lock. Each guest has one host.
- **Read cost:** the daemon reads a guest's discovery file once at start and when the host goes.
- **Scale:** 10 guests is 10 hosts with no panes open most of the time. Warns first: hosts' memory on the machine. Limit: 10 per
  computer, enforced by the helper.
- **Compatibility:** a CLI from before this refuses as today ("needs macOS or Linux"). The backend needs no change.
- **Migration + rollback:** none to migrate. Rollback: turning sharing off removes every guest, with the owner told first.
- **Audience:** the OS account and the daemon's existing guest policy, never the client.
- **Identity:** runs as the guest's own account, never the owner's.
- **Failure:** each refusal says why in one line; a host that will not start fails that guest's harness with its reason.
- **Platforms:** Windows 10 1809 and later, x64 and Arm. Mac and Linux are unchanged.
