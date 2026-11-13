# Windows guest machine sharing — design

**Status:** foundation implemented (`guestShare`, `guestRequests`, `guestSetupClient`, 28 tests); the
elevated setup script, relay/hook split, guest host and UI are tracked in tasks #7, #10, #12 and #11.
**Date:** 2026-11-05
**Related:** [guest machine sharing plan](../../plans/2026-10-19-guest-machine-sharing-plan.md),
[Windows parity plan](../plans/2026-11-04-windows-parity.md) Task 15, [Windows rules](../../windows-rules.md).

## Goal

A person on Windows can share **this computer** with named people (email, or everyone at a
domain) exactly as a Mac can:

- each guest's harnesses run as **their own Windows user**, never the owner's;
- a guest cannot read the owner's files, logins, harnesses, or another guest's;
- guests can use the owner's **Claude and Codex subscription** through the owner's relay;
- the owner shares **specific folders**, read-only or read-write, and nothing else;
- the owner approves **once** with a UAC prompt; guests are never prompted;
- the machine card where work is assigned shows **Claude Code and Codex details** (installed,
  signed in, subscription), as the Mac's Share form does.

## Non-goals

- Full owner rights (removed on every platform, 2026-10-19).
- Guest device pairing, per-person limits/approval/activity views, Store apps or web panes.
- Any change to macOS or Linux behavior, or to the existing Windows **Team account** (`harnessteam`).
- Extending guests to the Team account or to a second machine from the same guest.

## What exists today

### macOS / Linux (the model to match)

- One guest per email: OS user `hg_<12 hex>` (`cli/src/lib/guestAccounts.ts`), created on first
  use by a root helper. The owner approves **once**; the helper + sudoers drop-in then run
  without a password (`cli/src/lib/guestHelperInstall.ts`).
- A guest pane lives in the owner's tmux, but the engine runs as the guest:
  `sudo -n helper run <user> --cwd … --pass KEY … -- <argv>` with an allowlisted environment
  (`guestRunCommand`, `cli/lib/guestPaneCommand.ts`).
- Shared folders are ACLs on exactly those folders (`shareFolders`); the helper also adds
  search-only entries on the closed parents. It records what it granted, changes only the
  difference, and removes a guest's entries when sharing with them ends.
- The subscription relay is loopback HTTP with a per-guest bearer token; Claude gets
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, Codex a `harness_owner` provider
  (`cli/src/lib/subscriptionRelay.ts`, `services/guestLaunches.ts`).
- The core and gateway enforce a default-deny guest policy, per-agent ownership, no group-key
  broadcasts, a loopback credential, and only Claude Code/Codex launches
  (`cli/src/core/guestPolicy.ts`, `backendSocket.ts`, `gateway/gateway.ts`).
- Guest harnesses cannot be restarted, resumed, forked or retargeted; a guest starts a new one.

### Windows today

- The **Team account** works: `harnessteam`, a standard local user (Users only, never
  Administrators), a random password known only to Task Scheduler, its own profile and task,
  hidden from the sign-in screen, with ACL and privacy probes
  (`cli/src/team/windowsScript.ts`, `windowsTeam.ts`).
- **Guest sharing is explicitly unsupported**: `installGuestHelper` returns
  `UNSUPPORTED` — “Sharing this computer needs macOS or Linux.”
  (`cli/src/lib/guestHelperInstall.ts:131`), so the Share form has no folder picker and no
  per-guest engine details on Windows.
- Parity Task 15 records the gap: a spike (“can one daemon drive panes on a second
  `harness-pty` in another account?”), a design with a Design section, a named security
  review, then code.

## Verified Windows constraints

| Constraint | Consequence |
|---|---|
| No sudo; elevation is a UAC consent (`Start-Process -Verb RunAs`) | One prompt at setup; **no prompt per guest or per harness** |
| `New-LocalUser` + a profile under `C:\Users\<user>` | Guest home is OS-created; ACL it to the guest, SYSTEM, Administrators only |
| A standard user (Users SID `S-1-5-32-545`), never Administrators (`…-544`) | Same “least privilege” rule as the Team account |
| Random password in Task Scheduler's LSA secret, never in a file or argv | The guest host can run as the guest without the owner holding a password |
| Task Scheduler `LogonType=Password`, `RunLevel=LeastPrivilege` | Per-guest host can run in a non-interactive session (session 0) |
| `SpecialAccounts\UserList` hides an account from the sign-in screen | Guest accounts stay invisible, as the Team account does |
| Smart App Control blocks unsigned executables | Only Microsoft/OpenJS/signed Harness binaries; scripts run by signed `powershell.exe` |
| Loopback TCP carries no credential on Windows | The daemon identifies the caller by the connecting process's SID (`lib/peerAccount.ts`) and refuses another account. The guest relay and hook must be a **deliberate, token-authenticated exception** to that check, or guests can reach the owner's API |
| Reparse points/junctions are followed by naive ACL tools | Refuse them when sharing; never grant through a link |
| Profiles can be locked at delete time (`PendingFileRenameOperations`) | Unshare must report “restart to finish”, as the Team remove does |

## Architecture

### Recommended: a per-guest harness host (Option B)

```
 owner (DELL)                                  guest (hg_<12hex>)
 ┌─────────────────────────────┐               ┌──────────────────────────────┐
 │ Harness Desktop / core      │  authenticated│ harness-pty.exe (as guest)   │
 │  • guest policy             │  named pipe   │  • ConPTY panes              │
 │  • relay 127.0.0.1:<port>   ├──────────────►│  • engine = claude / codex   │
 │  • hook + local credential  │               │  • cwd = workspace/shared    │
 └──────────────┬──────────────┘               └──────────────┬───────────────┘
                │ owner's link (ACL'd file)                    │ env: relay token,
                ▼                                              ▼ hook token
        C:\ProgramData\Harness\…                     C:\Users\hg_x\work
```

Why: the OS enforces the identity. The owner's process never holds a guest password, the
guest's engine is a child of a process already running as the guest. The core already supports
several pty host versions/instances and host-scoped `create`/`respawn` (`ptyHosts`,
`PtyHostDrain`, `lib/ptyHost/protocol.ts`); a host in **another OS account** is exactly what the
spike must prove, not an existing capability. It mirrors the proven Team account.

The **spike must prove** the parts the code does not yet prove: a second host in another
account at session 0, its pipe authentication, upgrade/restart, and the desktop attaching to
its panes. If the spike fails, fall back to Option A (below), not to a half-built B.

### Alternatives considered

- **Option A — owner host + a privileged token broker.** The owner's `harness-pty` creates the
  engine with `CreateProcessWithLogonW`/`CreateProcessAsUser`. This needs a new **signed**
  service or helper holding guest credentials (DPAPI) and a much larger privileged surface.
  Kept as a fallback only if B cannot attach a guest host to the desktop.
- **Option C — a full Harness daemon per guest.** Duplicates supervision, updates, ports and
  logs for no extra isolation over B. Rejected.

### Setup: one UAC prompt, then no prompts

One elevated PowerShell script, staged in a folder only the owner and SYSTEM can change,
values validated and single-quoted like `windowsScript.ts` (no string interpolation of input),
idempotent on every step:

1. A local group **Harness Guests** (members are added per guest; never Administrators).
2. `C:\ProgramData\HarnessGuests\` — scripts, the shared **Node runtime** (signed OpenJS
   `node.exe`), the hook script, request/response folders. ACL: SYSTEM/Administrators full,
   the owner's user read (and write only to the request folder), guests traversal only.
   **Not `C:\ProgramData\Harness`:** that folder is readable by `Users` for the Team account
   (`team.json`, its status and relay), and every guest is in `Users`; a guest subtree there
   would let a guest read the owner's Team relay. The guest root is its own tree.
3. A **guest setup task** running as SYSTEM, startable by the owner without elevation (its
   task security descriptor grants the owner), which performs only a fixed, validated set:
   `ensure <email>`, `remove <user>`, `share <user> <read|write> <path>`, `unshare <user>`.
   Requests and answers are files in ACL'd folders, never a command line from the owner.
4. A **guest host task template** (`\Harness\Guests\…`) registered on first use with
   `LogonType=Password`, `RunLevel=LeastPrivilege`, hidden; its SD lets the owner start/stop it.
5. The relay/hook runtime is the owner's; nothing privileged listens for guests beyond the
   existing loopback relay.

Two boundaries make this safe, and both need a test:

- **The task can be started without elevation.** Its security descriptor grants the owner
  Start/Stop and denies guests. If Windows will not give a non-admin task that SD, the design
  stops here: per-guest UAC is not acceptable.
- **The prompt is once per setup version, not once ever.** A helper/runtime update changes the
  version and the form asks the owner to turn sharing on again (one UAC prompt); guests still
  never see one. Say so in the form.
- **No time-of-check/time-of-use hole.** Each request is a file with a random id in a folder
  guests cannot write (owner write, SYSTEM full, guests none); the SYSTEM task reads one
  validated operation and arguments, writes one answer to an ACL'd answer file, and deletes the
  request. It never runs a command line from a mutable file; `MultipleInstances=IgnoreNew`
  refuses a second start; a request naming another owner/guest is refused.

Why a setup task, not a service: no new privileged executable, no always-on surface; it uses
the same signed `powershell.exe`/`node.exe` and the Team account's proven task model. The
request/answer folders are the boundary and must be ACL-tested.

### Guest account

- Name `hg_<12 hex of sha256(lowercase email)>` (same derivation as
  `cli/src/lib/guestAccounts.ts`, so the two platforms agree in tests).
- `New-LocalUser` standard, `-PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword`,
  random 40-char password (same generator as the Team script), hidden through
  `SpecialAccounts\UserList`, added to **Users** and **Harness Guests**, never Administrators.
- Profile `C:\Users\hg_x` (OS-created); ACL: guest full, SYSTEM/Administrators full, no `Users`
  access, no inheritance from the owner's home. Workspace `C:\Users\hg_x\work`.
  **Order matters:** `New-LocalUser` creates no profile. The setup task first runs a one-shot
  task as the guest to create the profile, reads the real `Win32_UserProfile.LocalPath` (Windows
  may suffix it), and only then creates/ACLs `work`. A profile it cannot create, or one that is
  not exactly `C:\Users\hg_x`, is refused before anything is shared.
- Delete on unshare: stop the host task and its job object, remove ACLs and tasks, remove the
  user and `Win32_UserProfile`, then report a profile Windows could not release.

### Panes and launches

- A guest harness is started only by the guest policy: Claude Code or Codex, a new harness,
  first message as the engine's argument.
- The guest host creates a ConPTY pane and runs the engine directly as the guest:
  - `cwd`: the guest workspace, or a folder the owner shared (checked by the setup record);
  - env **allowlist**: `TERM`, `COLORTERM`, `LANG`, relay vars, hook vars, `HARNESS_AGENT_ID`;
    no owner `PATH`, `HOME`, `USERPROFILE`, keys or launch script;
  - the shell after exit is the guest's own `cmd.exe`/PowerShell, not the owner's.
- No restart/resume/fork/retarget/restore of a guest row (same refusals as macOS); the guest
  starts a new harness.
- Engine installs run inside the guest's pane on first use, using the shared Node runtime and
  the guest's writable `%USERPROFILE%\.local`; the guest sees progress.

### Guest-host routing, registry and restore

The existing create path (`core/agents/create.ts` → `createAndRegisterPane` → the owner's
`tmuxBackend`) opens panes on the **owner's** host. A guest needs a different host, and this is a
core change, not only a new module:

- A guest row records the host instance (the guest's pipe) in its registry entry; `guestCreate`
  and every later terminal request resolve that host, never the owner's.
- Restore, restart, resume, fork and retarget must **skip/refuse** a row with `guest` (the same
  refusals macOS has). Restore must not rebuild a guest pane as the owner — that is the worst
  possible failure, and it is a test of its own.
- A host that is not running is started by the owner's daemon through the guest's task and
  waited for with a bounded timeout; a failure says which step failed and leaves the row stopped,
  not “starting” forever.

### Host lifecycle and updates

- A guest host is pinned to the CLI/pty version that started it. A CLI or pty update stops each
  guest host through the existing drain (or asks it to shut down when empty).
- A running guest harness **ends** on that restart (guest rows cannot be resumed), and the guest
  starts a new one; the chat says so before it happens.
- A guest host that is missing, outdated or refuses its pipe is reported in the machine card; it
  is never silently replaced by the owner's host.

### Shared folders

- Owner picks folders; each is **read** or **editable** (max 20, as macOS).
- Grant the guest's **SID** (never a name), replacing our own ACE only: `icacls "<path>"
  /grant:r "*<sid>:(OI)(CI)(RX)"` for read (a directory needs `RX`, not bare `R`) or
  `(OI)(CI)M` for edit; **never** `F`. No `/T`: inheritance carries the one ACE.
- Traverse only: each parent up to the drive root gets `(X)` for the guest, recorded as an
  *entry of its own* so unshare removes exactly what was added. No list on parents.
- Refuse: reparse points/junctions anywhere on the path, a path that resolves outside the
  owner's profile/drive rules, system roots (`C:\`, `C:\Windows`, `Program Files*`), another
  user's profile, and paths with invalid characters.
- **A folder inside the owner's profile is the hard case.** Windows evaluates deny ACEs before
  allow, and the owner's profile may remove or deny `Users`/`Authenticated Users`; an allow for
  the guest SID cannot override a deny. The spike must share a real folder under
  `C:\Users\<owner>` with the profile's actual ACL. If the guest cannot traverse, shared folders
  are restricted to a dedicated root outside user profiles (for example
  `C:\ProgramData\Harness\Shared`) instead of weakening the owner's profile.
- The setup task keeps a root/SYSTEM-owned record of every grant (path, SID, level); a second
  share changes only the difference; unshare removes only recorded ACEs and leaves the owner's.
- A large folder propagates for minutes; the form says so, the operation is cancellable, and
  the sharing read waits for it (same known gap as macOS).
- A guest asks `guest_folders` for its workspace and the folders; New Harness offers them;
  a harness may start in one only when the record says it is shared with that guest.

### Relay and hooks

- The owner's relay stays loopback-only (`127.0.0.1`), per-guest bearer tokens minted in
  memory, revoked when the share ends. It swaps in the owner's tokens; guests never see them.
- **Listener split:** Windows refuses a loopback caller from another account by SID
  (`lib/peerAccount.ts`). The relay and the hook are therefore their own listener (or explicitly
  exempt routes) that accept a guest SID **only** when it presents a live per-guest token; every
  other loopback route keeps the owner-SID check. A test proves a guest can reach the relay and
  cannot reach `/api/status` or the local WS.
- Claude: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/claude`, `ANTHROPIC_AUTH_TOKEN=<guest token>`.
  Codex: `-c model_provider="harness_owner" …`, `env_key=HARNESS_RELAY_TOKEN`.
- The guest's engine gets a **guest-scoped hook token** (`HARNESS_HOOK_TOKEN`) and the shared
  `notify.mjs`; the owner's daemon validates token + agent id. Known gap (turn status) is the
  same as macOS and is not widened.
- Loopback has no user identity on Windows, so the relay must reject anything without a live
  guest token; the owner's local credential (ACL'd file) protects every other local route.

### UI

- **Share form (Windows)** — same as macOS: emails/domain, guest access on (one UAC prompt),
  folders read/edit, engines Claude Code and Codex with their state, and the warning that a
  shared folder's contents are readable. Remove the “needs macOS or Linux” refusal.
- **Machine/assignment card** — below the machine, show each engine: installed, signed in,
  using the owner's subscription, and its last check (the data the Team status already prints).
  A guest sees only its own engines and subscription.
- **Guest view** — “Guest · shared by <owner>”; only its own harnesses; no devices, settings,
  share, folder browsing outside its workspace/shared folders, or model management.
- Every failure names the step and the next action (UAC cancelled, folder refused, profile
  locked, engine install failed).

## Security model

| Trust boundary | Who crosses it | Control |
|---|---|---|
| Owner ↔ guest files | guest processes | NTFS ACLs on the profile; traverse-only on parents (optional) |
| Owner ↔ guest harnesses | guest API clients | default-deny policy, per-agent ownership, loopback credential |
| Guest ↔ subscription | guest env | per-guest relay token, revoked on unshare; owner tokens never leave the relay |
| Guest ↔ other guest | same machine | separate SIDs, separate profiles, separate host tasks, per-email tokens |
| Owner ↔ privileged setup | UAC | one explicit consent; staged, validated, idempotent script |
| Guest ↔ elevation | UAC | standard user; no admin group; no service the guest can ask |

Threats and answers:

1. **Read the owner's files.** Profile ACL denies Users; no traverse granted except shared
   paths' parents; reparse points refused; privacy probes run on every sharing read.
2. **Become administrator.** Users only; setup script asserts the account is not in
   Administrators; UAC cannot be triggered silently by a hidden account.
3. **Impersonate the owner on loopback.** The relay requires a guest token; the local
   credential file is ACL'd to the owner+SYSTEM; guest processes are refused every other route.
4. **Read another guest.** Separate SIDs/profiles/tasks; tokens per email; no shared group read.
5. **Escape through a link.** `icacls` never follows a reparse point when we grant; the path is
   resolved and refused if any component is one.
6. **Leave access behind.** Grants recorded by SID and path; unshare removes only ours; a test
   proves a guest loses access after unshare.
7. **Steal a task password.** The password lives only in Task Scheduler's LSA secret and is
   generated inside the elevated script; never printed, logged, written, or on a command line.
8. **Blocked unsigned binary.** Only signed binaries; the setup script is text under
   `C:\ProgramData\Harness` (ACL'd) run by signed `powershell.exe`/`node.exe`.
9. **Resource abuse.** 20 folders, guest cap, engine install timeout, share operation
   cancellable; logs name the guest user, never the email or a path.

## Design checklist (AGENTS)

- **Growth:** one account, profile, host task and ACE set per active guest; all removed when
  the share ends or the owner turns sharing off; no unbounded list (cap guests and folders).
  The setup record is the source of truth for deletion.
- **Concurrency:** one `ensure` per email (same in-memory promise pattern as macOS); one
  share operation per user serialized; ACL changes serialized per folder; task registration
  idempotent; a second setup task start is refused by the task's `MultipleInstances=IgnoreNew`.
- **Read cost:** a sharing read touches only the policy and the setup record; no owner file is
  read; `guest_folders` answers one guest only; engine probes stay at their existing cadence.
- **Scale:** 10× today's guests (tens, not hundreds). The first limit to show is the number of
  hidden accounts/tasks (Windows sign-in and Task Scheduler) and profile disk; a metric warns
  before that. One host per guest, not per harness.
- **Compatibility:** Windows-only modules behind `platform === 'win32'`; macOS/Linux paths are
  not touched; an older CLI without this feature keeps answering `UNSUPPORTED`; the backend
  keeps enforcing who may ask. The Team account and its files are unchanged.
- **Migration and rollback:** no existing Windows guests — the first share creates everything.
  A feature flag (`HARNESS_WINDOWS_GUESTS=0`) turns the form back to unsupported; rollback runs
  the same unshare/remove path for every recorded guest, then deletes the group and
  `C:\ProgramData\Harness\guests`. macOS/Linux rollback is “do nothing”.
- **Audience:** the daemon enforces guest identity from the relay/gateway; the server never
  trusts a client's claim about who it is.
- **Identity:** guest email → account name → SID; never the owner's login, profile or token;
  the owner's Windows account is not used for guest work.
- **Failure:** every step answers with the failing step and a next action; a cancelled UAC,
  refused folder, locked profile, blocked engine and uninstalled helper each have their own
  sentence; nothing fails silently.
- **Platforms:** Windows 10/11 x64 and ARM64; Smart App Control on; no Store apps or web panes;
  macOS and Linux keep their current behavior byte for byte.

## Data and APIs (planned)

- `SharedFolder { path: string; write: boolean }` (unchanged).
- `GuestAccount { user: 'hg_<12hex>'; home: 'C:\Users\hg_x'; workspace: '…\work' }`.
- Setup requests: `ensure <email>`, `remove <user>`, `share <user> <read|write> <path>`,
  `unshare <user>`; answers JSON `{ ok, user, home, workspace, detail? }`.
- New Windows module(s): `lib/windows/guestAccounts.ts`, `lib/windows/guestSetup.ts`,
  `lib/windows/guestHost.ts`; `guestHelperInstall.ts` gains a `win32` branch instead of
  returning `UNSUPPORTED`; `sharedMachines.ts` and the UI use the same ports they already use.
- No change to `GuestLaunchInput`/`GuestLaunch`, the policy, or the relay contract.

## Spike (must pass before code)

On the PC, in a throwaway Windows account, with a signed build:

1. Start `harness-pty.exe` as a hidden standard user from a scheduled task at session 0; can
   the owner's core create and read a pane over an authenticated pipe? Does the desktop attach?
2. Can the owner start that task without elevation (task SD)? Can the guest's processes be
   killed without leftovers (job object)?
3. `icacls` grants and removals for a guest SID on a nested folder, with traverse-only parents;
   unshare leaves no access.
4. Do Claude Code and Codex install and run as the guest with the shared Node runtime and the
   relay? Does npm work there?
5. Does the guest's engine reach the loopback relay, and does the owner's daemon reject a
   request without the guest token?
6. Does unshare delete the profile, or leave `PendingFileRenameOperations`? What does the form
   say?
7. Smart App Control: are all started binaries allowed, and does the event log stay empty?

Record each answer in this document before implementation. If (1) fails, stop and design
Option A properly; do not ship a partial guest feature.

## Test plan

- **Unit:** account-name derivation, setup request validation, ACL argument building (SIDs,
  read/edit, traverse), reparse refusal, record/removal diff, policy identity, sizes/caps.
- **Windows integration (VM, two accounts):** create → launch a pane as the guest → the owner's
  profile is unreadable → a shared read folder is readable, write folder writable, another
  folder is not → unshare → no access and no account/task left.
- **Failure injection:** UAC cancelled, task refused, locked profile, link in the path, engine
  install fails, relay down.
- **Regression:** macOS/Linux guest e2e (`cli/e2e/sharedMachines.e2e.ts`), the Team account
  tests, and the normal Windows CLI/desktop suites stay green.
- **Manual, on the PC:** one UAC prompt on first share; a guest harness answers; Explorer shows
  only the shared folder; after unshare Windows shows nothing of the guest.
- **Acceptance:** the Mac's “What a guest can do” table holds on Windows line for line.

## Rollout

1. Spike + this design reviewed by a named security reviewer.
2. Implementation behind the flag; Windows-only modules and tests.
3. Manual PC pass; then the form is enabled for everyone; the flag stays for rollback one
   release.
4. If anything is wrong, roll back with the flag and run the recorded unshare/remove path;
   macOS/Linux are unaffected.

## Review findings (2026-11-05)

Re-reading the plan against the code found these. Each is either corrected above or is a gate
before implementation.

### Critical

1. **The guest relay/hook cannot use the owner's loopback door.** On Windows the daemon sets
   the local credential and, with it, asks Windows who owns the caller's process
   (`localWsServer.ts`, `hookServer.ts`, `lib/peerAccount.ts`); a guest is another account and
   is refused. But the guest's engine **must** reach the relay and the hook. They need their own
   listener (or exempt routes) that accepts a guest SID only with a live per-guest token, while
   every owner route keeps the SID check. Without the split, guests either cannot use the
   subscription or can reach the owner's API. Corrected in “Relay and hooks”; test both
   directions.
2. **A folder inside the owner's profile may be unshareable.** Deny ACEs beat an allow; the
   profile's real ACL is the test. Fallback: a dedicated shared root outside profiles. Corrected
   in “Shared folders”.
3. **`New-LocalUser` makes no profile.** Workspace/ACL work before the first logon fails.
   Corrected with the create-profile-first order.
4. **Guest rows need a host, and restore must never use the owner's.** The create path currently
   targets the owner's `tmuxBackend`; a guest row must carry its host instance, and
   restore/restart/resume must refuse it. This is a core change, now its own section.
5. **The setup and host tasks must start without elevation.** If a non-admin task SD cannot
   grant Start/Stop, the owner is prompted per guest — unacceptable. Gate before code.

### High

6. **Host updates.** A pty/CLI update ends running guest harnesses (they cannot resume) and each
   guest host must be drained and replaced. Now stated, with the copy the guest sees.
7. **Setup request TOCTOU.** A SYSTEM task reading a file must take one validated operation from
   an ACL'd, unguessable request and write one ACL'd answer; a guest must not write either. Now
   stated.
8. **`icacls` read is `RX`, not `R`, and grants must replace our own ACE (`/grant:r`, no `/T`).**
   Corrected.
9. **Prompt recurrence after an update.** Corrected: once per setup version.
10. **Shared folders vs `fs_list_dir`.** The Mac policy allows `fs_list_dir` only inside the
    workspace; with shared folders, New Harness must offer them and the policy must allow
    exactly those paths, not all of them. Add to the policy work.
11. **Engine details before the first harness.** The machine card needs the guest's engine state
    (installed/signed in). Probing as the guest needs a host/task; otherwise the form shows the
    setup record, not a live probe. Decide in the UI task.
12. **A guest can occupy the owner API's peer-lookup slots** (four at once, 32 waiting) by
    connecting to the owner's port; the SID lookup refuses it, but the owner's own clients can
    queue behind it. The separate relay/hook listener keeps the hot path apart; add a per-source
    bound or a fast refusal for a guest SID in the owner API.

### Medium

13. **Host token file.** The pipe token must live in an ACL'd file (owner + SYSTEM) and the
    guest must not be able to modify it; the guest host's task SD must deny the guest.
14. **Unshare cleanup.** Stop the host and its job, remove only recorded ACEs/tasks/UserList,
    delete the profile (or say “restart to finish”), then remove the account; a test proves no
    access remains.
15. **Windows path UI.** Drive letters, backslashes, a picker that works on the machine being
    shared, and local fixed drives only; the Mac form's `/Users/...` example does not apply.
16. **Do not weaken the owner profile.** No blanket `Users` grant and no removing deny ACEs to
    make a folder work; the dedicated shared root is the safe fallback.
17. **The Team account.** Guests join `Users`; verify `harnessteam`'s profile and the guests'
    profiles cannot list each other, and that the Team task/ACLs are untouched.
18. **Firewall/Defender.** Only loopback listeners; no inbound rule; confirm no Windows Firewall
    prompt is added by the guest host.

### Missed security controls (second pass)

These are not in the first threat table and must be in the implementation.

1. **Pipes, not only TCP.** The owner's daemon pipe, the pty host pipes and a guest
   host's pipe are separate doors. Each must have an ACL and token that deny another
   account (including another guest); test a guest opening the owner's pipe and the Team
   account's pipe/port. A pipe is not covered by the loopback SID check.
2. **Cross-feature secrets.** The Windows PC also has the **Team account** and its
   `C:\ProgramData\Harness\team-relay-*` (the owner's subscription relay) and `team.json`.
   A guest must not read `C:\Users\harnessteam`, the team relay folder, the team status
   files, or any Harness GitHub-App token. Audit the existing `C:\ProgramData\Harness`
   ACLs; a guest in `Users` must be denied, and the Team account/tasks must stay untouched.
   The guest tree is therefore **`C:\ProgramData\HarnessGuests`**, never a subtree of the
   Team folder: an inherited `Users` read on the parent would expose `team.json` and the
   relay even if the guest folder itself was tight.
3. **A guest privacy sentinel.** As the Team account has: a file in the owner's profile the
   guest must not read. Check it on every sharing read and after any ACL change; if a guest
   can read it, turn sharing off and say so. The document says “privacy probes” without
   defining the guest's; this is it.
4. **The relay is not an open proxy.** A guest token must allow only the fixed upstream
   paths and methods the engine needs (Claude messages, Codex responses), with bounded
   bodies, no arbitrary headers or hosts. Otherwise a guest uses the owner's token for
   anything the vendor accepts. Also bind tokens to one guest and one agent.
5. **Guest-created reparse points.** A guest with **write** to a shared folder can create a
   junction inside it (directory junctions are not always privileged). The owner's process
   could then follow it into the owner's files. Refuse/scan reparse points in shared
   folders; re-check on each sharing read and before a harness starts there.
6. **A writable shared folder is untrusted code.** A harness started in it reads the
   guest's files: hooks, `AGENTS.md`, project scripts, a malicious `git` config. Warn the
   owner explicitly; default to **read-only** folders; never auto-approve in a shared
   folder; the engine's permission mode is the owner's.
7. **Hook token binding.** A guest hook token must resolve to exactly one guest and one
   agent; a token cannot report a turn, an alert or a stop for another agent. Test a token
   from guest A naming guest B's agent.
8. **No owner secret in argv, machine-wide env, or a task action.** A guest can query
   `Win32_Process` command lines and task actions, and inherits **machine-wide** environment
   variables. Audit `C:\ProgramData` and HKLM for anything Harness adds; keep relay and
   subscription tokens in memory only.
9. **Port squatting.** On a restart a guest can bind the owner's loopback port first. The
   owner's clients on Windows use the pipe and send no TCP credential; verify no client
   (especially an older one) sends it over TCP, and that a port held by a guest is detected
   and moved off (`portHolderIsThisAccount`), as the Team boundary already does.
10. **Server-side enforcement and audit.** The backend must enforce guest identity for
    starts/messages as macOS does, not only the desktop UI. Log each guest action with the
    guest SID/user and the agent id, never the email or a secret; the owner can see it.
11. **Abuse and resource use.** One guest can spend the owner's subscription, CPU, disk and
    the 20-folder limit. The owner accepts the subscription risk; add a per-guest log and an
    optional rate limit, and keep the folder/guest caps.
12. **Task tampering.** A guest must have no write/change right on its host task (only the
    owner and SYSTEM); otherwise it could change the action, the principal or the token.
    Test the task SD from a guest token.

## No-break guarantees

- Every Windows branch is new code; existing macOS/Linux guest code paths are untouched.
- The Team account (`harnessteam`) and its task/ACLs are not modified; guests use `hg_*`.
- A machine that has never shared on Windows behaves exactly as today (`UNSUPPORTED`).
- The release is gated on the existing OS-specific suites plus the new Windows tests.

## Open questions

- Per-guest host vs. token broker: resolved by spike question 1.
- Where the guest profile lives (default `C:\Users` vs a redirected profile root): default is
  safer with Windows tools; revisit only if the sign-in list or disk says otherwise.
- How a guest sees engine state before its first harness (probe as the guest, or the setup
  record's cache) — needs a UX decision.
- Whether a shared folder may be on another drive or a network path: propose “local fixed
  drives only” first.
