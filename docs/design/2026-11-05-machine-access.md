# What each machine can reach

Task #2945. Anh Dee (11-04): track which machines have access to what (machine A has email, B has Autodesk Fusion,
C has the database) so the PM routes work to the right machine. Same pattern as lampOS, where thaibao56 shares which of
his team's machines have a real lamp attached for testing. Design only: no product code in this PR.

## In one paragraph

Each machine in the Swarm gets an **Access** list: short names people already use ("Lamp", "Fusion 360",
"Email (dee@)", "Prod DB read-only", "Tony's iPhone"), each in one macOS account (the owner's own, or the Mac's Harness
Team account). The owner adds them in Machines, or confirms what the machine found. A task says what access it needs;
the route leaves out every machine and account that does not have it, and says why. Names only, never a password or a
key. Having access listed never grants a permission: Team accounts still never see the owner's sign-ins, and production
writes still need Ken's go.

## Worked example: the lamp

**Today.** Nothing in Harness knows which machine has a lamp. What exists:

- `harness mcp-servers add lamp -- lamp-mcp` puts the lamp's MCP server into every agent started on that machine
  ([machine MCP servers](2026-10-28-machine-mcp-servers.md), `cli/src/lib/machineMcp.ts`). The file lives in that macOS
  account's Harness data folder only and is never sent to the backend, so the Swarm cannot see it.
- A task can name devices by full path (`task.requires.devices`, backend `superTabs/model.ts` `TaskRequirement`), and
  the route takes `needs.devices` (`cli/src/superTabs/route.ts` `Needs`). But a machine's heartbeat probes no devices
  (`cli/src/superTabs/machines.ts`: `capabilities({ …, devices: [] })`), so the route can only say "Required devices have
  not been reported" for every new agent (`routeCommand.ts`). The device is checked only at start (`capacity.ts`).
  And `/dev/cu.usbmodem1101` is not how anyone says "lamp".
- A task can name machines (`task.requires.machines`), but that is a note, not a filter (`routeCommand.ts` `ELSEWHERE`).
- So the lampOS PM has to remember which teammate's Mac has a lamp, from chat. (I could not read the lampOS project's
  instructions from this project; nothing in this repository marks lamp machines.)

**With this design**, no lamp code anywhere:

1. thaibao56's teammate opens Machines > their Mac. The machine found `lamp` in its MCP servers, and a USB modem device,
   and suggests **Lamp** (kind device). They press Add.
2. The lampOS task says it needs **Lamp**.
3. The route offers only machines whose account that would run the work has Lamp, ok. For a teammate's Mac that is its
   Team account, so the lamp MCP server has to be set up there (open question 3).
4. If an agent finds the lamp unreachable, it marks Lamp "not reachable" (the needs sign-in state, worded for a
   device; see Staleness). The owner is told, and the route stops offering it until it is back.

Email, Fusion 360 and the production database go through exactly the same four steps.

## 1. The model

One list per machine in the Swarm, on its contribution (`ContributedMachine` in `backend/src/superTabs/machines.ts`,
beside `projects` and `ownAccountChoice`), at most 32 entries:

| Field | What it holds |
| --- | --- |
| `id` | 16 hex, made by the server |
| `name` | 1 to 60 characters, as people say it: "Lamp", "Email (dee@)", "Fusion 360", "Prod DB read-only", "Tony's iPhone" |
| `kind` | `app`, `account`, `data`, `device` or `network` |
| `account` | `own` (the owner's macOS account) or `team` (the Mac's Harness Team account). A machine with no Team account has only `own`. |
| `state` | `ok` or `needsSignIn` (shown as "needs sign-in"; for a device, "not reachable") |
| `teammates` | own-account entries only: whether teammates' tasks that need it may run in the owner's account (section 4). Default false. |
| `production` | true for production systems, so the route notes "Production writes need Ken's go". Default false. |
| `check` | optional, how the machine can confirm it by itself: a tool on PATH, an MCP server name, a device path pattern (`/dev/cu.usbmodem*`), an app bundle id. Owner-only to read. |
| `addedBy`, `addedAt` | the person who added or confirmed it; `found: true` when it came from a suggestion |
| `stale` | when `needsSignIn`: which agent said so, when, in which task, and its one-line why |

What it never holds: a password, key, token, file path to a secret, account id or email the owner did not type
themselves. The server refuses a name that looks like a secret (a run of 20+ key-like characters, `user:pass@`, known
token prefixes such as `sk-`, `ghp_`, `xox`, `AKIA`).

A Mac and its Team account are one row in Machines today (naming system: "a Mac and its Harness Team account are one
row"), so both accounts' entries live on the Mac's own contribution, split by `account`. The Team account's pool
(`hostMachineId`) keeps none of its own, the same way it follows its Mac's `projects`.

## 2. How entries get there

**The owner adds or confirms them** in Machines > the machine > Configure, the dialog that already holds Agents and
"Projects that may use it". One new command, `machine.access`, sets the whole list (like `machine.projects`):

- Only the machine's owner (`contributorId`), or the project's PM passing on a message the owner wrote in the last day
  (`askedIn`, exactly as `machine.projects` and `machine.engineResume` do).
- Turning `teammates` on for an own-account entry: the owner's own session only, never through the PM, like turning on
  `machine.ownAccountWork`.

**The machine suggests what it finds**, for the owner to Add or dismiss. Each macOS account looks for itself, so the
Team account's suggestions show what it really has:

| Looks at | Suggests |
| --- | --- |
| Apps in /Applications from a short list of work apps (Fusion 360, Xcode, Blender, Figma, Android Studio, …) | Fusion 360 (app) |
| Signed-in CLIs, by their read-only status command (`gh auth status`, `gcloud auth list`, `aws sts get-caller-identity`, `vercel whoami`, …) | Google Cloud (account). Signed in or not only: no account name is read out. |
| Machine MCP servers (`mcp-servers.json`) | Lamp (from `lamp`) |
| Connected devices: USB product names, `xcrun devicectl` phones, `adb devices` | Tony's iPhone, a USB modem (device) |
| Tools on PATH, from today's tool probe (`COMMON_TOOLS`, `cli/src/superTabs/machines.ts`) | Flutter, Docker (app) |

Suggestions never leave the machine until the owner adds one: Desktop asks the machine's own daemon for them when its
owner opens Configure, and the daemon answers only its owner's session. The server's machine reading has no field for
them (its schema is strict, so a host that sent one is refused). No status command that could sign anything out is ever
run.

## 3. Routing

- A task names the access it needs: `"requires": {"access": ["Lamp"]}` in its brief (beside `devices`), and the route
  takes `needs.access` (beside `needs.tools` and `needs.devices` in `route.ts`). Names match without case.
- For each candidate the route reads the entries of **the account the work would run in**: the Team account for a
  teammate's project on a Mac that has one, the owner's own account otherwise (`teamMachineFor` and `ownAccountWork`
  in `machines.ts` already decide this). An entry counts only when its state is ok and section 4 lets this task use it.
- A candidate without it is left out with one line, like a missing tool today (`requiredToolReason`):
  - "No Lamp here."
  - "Lamp needs sign-in on Gray's Mac; Gray was told."
  - "Fusion 360 is in Gray's own account, not shared with teammates."
- Entries ride in the machine record every route already reads, so nothing new is fetched. Entries with a `check` are
  confirmed by the machine itself every 10 minutes, the tool probe's cache time (`VERIFIED_TOOL_TTL_MS`), and at each
  start (`start.ts` already asks `capacity` for the start's tools and devices).
- The backend checks it again on every start (`admitMachineStart`): a start for a task whose `requires.access` is not
  met there is refused with the same line. So an older CLI that drops `needs.access` cannot start in the wrong place.
- The route still ranks nothing (#2901). The PM picks among what is left by the instructions' Order and quota.
- `needs.tools` and `needs.devices` keep working unchanged.

## 4. Privacy and safety: who sees and uses what

| Who | Sees | Can use |
| --- | --- | --- |
| Swarm members who see the machine today | Name, kind, account, state, who added it | Only through tasks routed by the rules below |
| The machine's owner | Everything, `check` and suggestions included | Their own tasks, any entry |
| A teammate's task, Team account (the default) | — | Team-account entries only. The Team account never sees the owner's sign-ins, apps' logins or files. |
| A teammate's task, owner's own account | — | Only when the owner turned on own-account work (#2806, `ownAccountWork`) or that entry's `teammates` |
| People outside the Swarm, Buddy-only machines | Nothing (`visibleState` already hides both) | Nothing |

- **The server enforces it**: `visibleState` (backend `model.ts`) strips `check` for everyone but the owner; the route
  and `admitMachineStart` apply the table.
- **Sharing one own-account entry** (`teammates`) means teammates' tasks that need it run in the owner's account on
  that Mac, where they can read the owner's files and use their signed-in apps. Turning it on shows the same plain
  warning as own-account work ("Let teammates' work run in your account?"), naming the entry. The route adds the note
  that `ownAccountNote` adds today, so whoever routes it does so knowingly.
- **Access is not permission.** An entry says what a machine can reach, never what an agent may do with it.
  `production` entries add the note "Production writes need Ken's go", and the instructions' rule stands: the
  read-only production login still comes only through its environment file.
- Each entry keeps who added it and when, and a stale mark keeps which agent made it, in which task.

## 5. Staleness

- An agent that finds an entry signed out (or a device not reachable) marks it: `harness super-tab access mark "Email
  (dee@)" needs-sign-in --why "gmail asks for sign-in"`. Only an agent running on that machine, in that entry's
  account, may mark it. Agents can never mark one ok.
- The server sets `needsSignIn` with the agent, task and why, and tells the owner in their Buddy chat (`person.tell`),
  at most once a day per entry: "Email (dee@) on Gray's Mac needs sign-in: Aster found it in #2945."
- It goes back to ok when the owner says so in Machines, or by itself when its `check` passes again.
- Until then the route leaves it out with that line, so no work waits on a signed-out machine without saying so.

## 6. Mockups

Machines screen, a row expanded (today it shows agents, then resources and subscriptions). Access comes last, by
account. Seen by every Swarm member who sees the machine:

```
 Machines
 ~ Gray's Mac                                          (G)  online   ⋯
     Aster   Dev  working
     Kiln6   Rev  idle
     CPU 62% free    Memory 9.1 GB free    Disk 210 GB free
     Subscriptions   Claude 41% left · resets Fri    Codex 77% left
     Access          Gray's account: Fusion 360 · Email (dee@) needs sign-in
                     Team account:   Lamp · Flutter · Tony's iPhone
 ~ Mac Studio                                          (K)  online   ⋯
     Access          Gray's account: Prod DB read-only  (production)
```

Configure dialog (right-click > Configure), owner only. New: the Access section.

```
 Gray's Mac
 Agents                     (•) As memory allows   ( ) At most [4]
 Projects that may use it   (•) All projects       ( ) Only: …

 Access
   Your account
     Fusion 360        App       ok              [ ] Teammates may use    ⋯
     Email (dee@)      Account   needs sign-in   [ ] Teammates may use    ⋯
   Team account
     Lamp              Device    ok                                       ⋯
     Tony's iPhone     Device    ok                                       ⋯
   Add access…

   Found on this Mac
     Blender                    App, your account        Add   Not now
     Google Cloud, signed in    Account, your account    Add   Not now
     lamp MCP server            Device, Team account     Add   Not now

 Remove from this Swarm                                    Cancel   Save
```

Add access:

```
 Add access
 Name    [ Fusion 360                    ]   Like: Email (dee@), Prod DB read-only
 Kind    (•) App  ( ) Account  ( ) Data  ( ) Device  ( ) Network
 Where   (•) Your account  ( ) Team account
 [ ] Production system
 Names only. Never type a password, key or token here.
                                                          Cancel   Add
```

Route card in the task chat, Details open (today's `route_row.dart`: pick, why, Selection, Considered, Unavailable).
New: the Needs line, "has" on each candidate, and the access reasons:

```
 Routed to New agent · Claude opus high · Gray's Mac                  Hide details
 New agent · Claude opus high · Gray's Mac
 Lamp firmware test on a real lamp
 Selection: Chosen by the project's Routing instructions
 Needs: Lamp
 Considered
 New agent · Claude opus high · Gray's Mac — has Lamp (Team account)
 Kiln5 · Claude opus high · Mac Studio — has Lamp (Team account)
 Unavailable: New agent · Codex · Darren-MacBook — No Lamp here.
 Unavailable: New agent · Claude opus high · Diego's Mac — Lamp is not reachable on Diego's Mac; Diego was told.
 Unavailable: New agent · Claude opus high · Tony's Mac — Lamp is in Tony's own account, not shared with teammates.
```

## 7. Migration, phases, open questions

**Migration.** No data moves. `needs.tools`, `needs.devices`, `task.requires.devices` and `requires.machines` stay as
they are. A tool or device path can also be an entry's `check`, so a person who wants a name ("Flutter", "Lamp") uses
access, and a script that names a path keeps working. Rollback: drop the field; the route and starts behave as today.

**Phases**, each its own task and pull request:

1. The list, `machine.access`, Configure and the expanded row, `requires.access` and `needs.access` in the route, and
   the backend start check. Owner adds by hand.
2. Staleness: `access mark`, the owner's notice, `check` runs every 10 minutes and at start.
3. Suggestions from the machine.

Each phase starts with failing tests for the risks above: a teammate's task never offered an unshared own-account
entry, by the route or by a start; a Team account never counted for an own-account entry; a secret-looking name
refused; `check` and suggestions never in a non-owner's read or the server's reading; only an agent on that machine and
account can mark an entry, and never ok; an older CLI's start without `needs.access` refused by the backend; the
owner told once a day, not per mark.

**Open questions**, each with my recommendation:

1. *One list per machine, or per machine per Swarm?* Per Swarm (on the contribution), so "Email (dee@)" is not shown
   to another Swarm's members. The owner adds it again in each Swarm. Recommend per Swarm.
2. *Ship per-entry `teammates` sharing in phase 1?* It exposes the owner's account the same way own-account work does,
   for fewer tasks. Recommend yes, behind the same warning, since the brief asks for it and it is narrower than
   turning own-account work on for everything.
3. *How does the lamp MCP server get into a Team account?* Nobody types there, and agents may not add MCP servers. Recommend:
   Configure's "lamp MCP server, Team account" Add copies the owner's own entry into the Team account's
   `mcp-servers.json` through the Team daemon, as the owner's action from the owner's session (Desktop already sets
   the Team account up this way).
4. *Exact name match or a shared vocabulary?* People will write "Lamp", "lamp", "Desk lamp". Recommend case-insensitive
   exact names, and the route suggests the closest name it saw when nothing matches ("No Lamp here. Did you mean Desk
   lamp?"). No vocabulary to maintain.
5. *Should entries be per person (Dee's email) instead of per machine?* No: the question routing answers is "where can
   this run", and an account signed in on two machines is two entries.

## Design

- **Growth:** at most 32 entries per machine per Swarm; the owner removes them; they go with the machine
  (`machine.remove`). Stale marks replace each other, one per entry.
- **Concurrency:** one command on the Swarm's state under its existing write lock, as `machine.projects`.
- **Read cost:** the list rides in the machine record already read. It changes only when an entry or its state does;
  `check` results go in the reading only when they change (as since #3011).
- **Scale:** 10x is 320 entries a machine, past the cap; at 10x machines the machines part grows by about 5 KB a
  machine. The first warning is the machines part's size in the state-parts metrics.
- **Compatibility:** an older Desktop shows no Access; an older CLI's route ignores `needs.access`, and the backend
  start check catches it with a reason. Older hosts report no checks: entries stay as the owner set them.
- **Migration + rollback:** none to move; removing the field restores today (section 7).
- **Audience:** the server enforces who sees and uses what (section 4).
- **Identity:** entries record the person who added them and the agent that marked them; no machine owner's login is
  used for anything here. Signed-in CLI checks read only "signed in or not".
- **Failure:** a missing entry, a stale one and a refused start each say why in the route or the start's refusal; the
  owner is told of a stale one. A check that cannot run leaves the state as it was, and says so in the row.
- **Platforms:** macOS gets suggestions first (apps, phones); Linux gets tools, MCP servers, USB devices and CLIs;
  Windows has the list and routing, owner-added only.
