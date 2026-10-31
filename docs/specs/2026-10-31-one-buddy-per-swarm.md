# One Buddy per person per Swarm, shown as # buddy under Projects

Status: spec for Dee's confirmation · 2026-10-31 · requested by Dee · group #1596 · Engineer: Atlas.
Builds on Buddies (`docs/swarms.md#buddies`), Buddy read access (`docs/specs/2026-10-30-buddy-read-access.md`) and
Buddy thread sessions (`docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md`).

## Why

Dee (10-31, project chat): "why do i have 2 buddies?" and "if there is only 1 buddy, there is no need to create a separate
section. just have # buddy under project". Today each person has a Buddy chat, and may run a Buddy, in every project.
Slack has one assistant per workspace. A person should have one Buddy per Swarm that knows all the projects they can read.

Done when a person sees exactly one Buddy in a Swarm, it answers across every project they can read, it never carries
one project's material into another, Dee confirmed the mockup, two security reviews passed, and it is merged.

## What exists today (main cd87859)

- A Buddy chat is a `kind: 'buddy'` conversation **inside one project** (`projectId`), id
  `stableId('buddy', projectId, person, generation)`, read only by its person (`audience`) and its Buddy.
- A Buddy agent belongs to that project (`agent.projectId`). The server lets an agent read exactly one project
  (`canReadProject`: `agentProjectId(agent) === project.id`). It reads the project chat and the project's non-private
  workgroups, posts only in its own chat, and `buddy.propose` posts in **its** project's chat.
- It runs in a read-only worktree of that project's checkout (`projectFolder`), behind the guard (`buddyGuard.ts`).
  Wide mode (#2310) lets it also read the person's home and named system folders.
- Thread sessions (#2427): New session starts a second Buddy agent tied to one thread of the chat, same project, same
  folder, with a 10-message excerpt of the main chat.
- Desktop: a **Buddies** section below Projects with one row per project. The phone's round dial has a Buddy screen per
  project. The CLI's status, cards and host all find the Buddy chat by project.

## The model

**One Buddy chat per person per Swarm**, at Swarm level like the Leads conversation: `kind: 'swarm-buddy'`,
no `projectId`, id `stableId('buddy', 'swarm', person, generation)`, audience the person alone. It is opened for each
member from the start, as today's chats are.

**Two kinds of Buddy agent in it:**

| | Main Buddy (and plain New session) | Project session (New session in *X*) |
|---|---|---|
| Reads through Harness | Every project its person reads now: each project chat and non-private workgroups, task status, PR state | Project *X* only, as today's Buddy |
| Reads in the chat | The main chat (not session threads) | Its own thread, and in it only its person's messages and its own |
| Folder | Buddy home folder: one read-only worktree per project whose repository is on this machine | A read-only worktree of *X*'s checkout, as today |
| Wide mode (#2310) | As today | Off |
| Posts | Its own chat only | Its own thread only |
| Proposes to a PM | Never | Only to *X*'s PM, for its person's message in its thread |

So the only Buddy that can write anything outside the person's own chat is a project session, and it has never read
anything but *X* and its person's own words.

**Every write into a project comes only from that project's session** (River, 10-31). A Buddy's writes today are a post
or reaction in its own chat and a proposal; every other command is refused (`requireBuddyCommand`). With one Buddy:

- The main Buddy and a plain session write nowhere but the person's own chat: a post, reaction, proposal, file upload or
  task (`group.create`, `work.*`, `person.tell`, decisions) aimed at any project is refused.
- A project-*X* session writes its own thread, and into *X* only a proposal to *X*'s PM ("Proposal from Wren, on
  quang's behalf") with its files. A post in *X*'s chat or a workgroup, a reaction there, or anything aimed at another
  project is refused.
- The server test covers each write path: post, reply, reaction, proposal, attachment upload (`sentIn`), task creation
  and decisions, from the main Buddy, a plain session, an *X* session aiming at *Y*, and an *X* session aiming at *X*'s
  chat directly. The person's words are the only bridge between projects, and that is their
choice, as when they post in a project chat themselves.

## The five likely failures, settled

### 1. Existing per-project Buddy chats keep their history

- The one Buddy chat is **a new chat**, not one of the old ones. Ruling. Why: each old chat is bound to its project
  (its proposals, PM lines and sessions), so promoting one would carry that project into a cross-project chat. Cost if
  wrong: the person's last conversation is one click away instead of in front of them.
- Old chats stay stored and unchanged; new Desktop shows them **read only**. In the Buddy chat's ⋮ menu, **Earlier chats** lists each project
  whose old chat has messages; opening one shows it with a line on top: "Your earlier Buddy chat in openharness. Read
  only." A project the person no longer reads drops off the list, as its old chat was unreadable to them before.
- Old chats stay writable from older apps until the mobile release (section 4); new Desktop shows them read only.
- No release script. A person's per-project Buddies keep running in their old chats until the person starts their one
  Buddy from # buddy (one click, machine and Claude Code already chosen); that start removes them in the same write, so
  from then on they have exactly one. A message in an old chat afterwards reaches a session of that project on the one
  Buddy's machine (section 4). Ruling. Why: no prod write, and nobody loses a working Buddy at release. Cost if wrong: until
  they start it, new Desktop shows # buddy with Start while an old Buddy still answers in an old chat.

### 2. One Buddy reads several projects' code without mixing checkouts

- The main Buddy's folder is a **Buddy home** on the person's machine: `<swarm folder>/buddy-<person>/`, holding
  `projects/<project>/`, one read-only worktree per project the person reads whose repository is on this machine. The
  server lists the projects in the start (`buddyProjects: [{ id, name, cwd }]`); the host makes each worktree from that
  project's own checkout, so checkouts never mix. A project whose repository is not on this machine gets no folder; the
  Buddy reads its chats, tasks and pull requests and says it can't see its code here.
- The guard confines reads to the home folder as it does to one worktree today. `git` and `gh` read commands need a
  repository folder, so they run in project sessions; the main Buddy reads files with Read, Grep and Glob.
- Before each delivery, the host compares the folder with the projects its person reads now and removes a worktree that
  is no longer listed, so a lost project's code leaves the folder before the Buddy's next turn.
- A project session runs in a worktree of its project's checkout, exactly as today's Buddy does.

**Staying within one context in a Swarm with many projects** (River, 10-31). The main Buddy reads on demand and preloads
nothing beyond a short index:

- Its first prompt and its `status` give one line per project it reads (name, open tasks, what waits on its person),
  at most 50 projects, and the 20 newest changed tasks across them. Nothing else is in its prompt.
- It reads a project's tasks with `status --project <name>` (today's per-project status, newest 100, a page at a time)
  and a chat or task with `messages`, only when the person's question needs it.
- Code is read file by file with Read, Grep and Glob in that project's worktree, as today.
- News arrives as single lines, as today. Claude Code's own compaction handles a long chat; a long question can go to a
  New session so the main context stays small.

### 3. Guard: only X's material goes into X (security-critical)

Enforced by the server, not by the Buddy's good behaviour:

- `buddy.propose` from the main Buddy or a plain session: refused, `BUDDY_PROPOSE_SESSION` ("Start a New session in that
  project to send it to its PM."). From a project session: its project's PM only; `ownerMessageId` must be its person's
  message **in its own thread**; files only from its own worktree or sent by its person **in that thread**.
- A project session's reads are checked as its person's, limited to *X*: the project chat, *X*'s workgroups, its own
  thread. Every other id (another project's group, a message in the main chat, another session's thread, a private chat,
  the old Buddy chats) is refused the same way as an id that does not exist: no title, name or count.
- It reads its thread filtered to its person's messages and its own (plus the "session ended" lines). A thread started
  by replying to a main-Buddy message never shows that message to the session. No main-chat excerpt for project
  sessions (plain sessions keep #2427's excerpt).
- No wide mode for project sessions: wide mode reads the person's home, which may hold another project's clone. Ruling.
  Why: there is no reliable list of every clone on a machine. Cost if wrong: a project session can't read prod logs or
  CI itself; the person asks the main Buddy and pastes what matters into the thread.
- Proposal text and files are still checked by the guard's secret and "summaries only" checks.
- News (replies to the person's proposals, tags, shipped work) goes to the main Buddy, which posts only in the person's
  own chat.
- The PM's private lines (`person.tell`, delegated decisions) go to the one chat, marked with their project:
  "River (PM · openharness) → you". Only the person and their main Buddy read them; no session does.

### 4. Older apps and CLIs

The phone app shows a Buddy chat per project (the round dial's Buddy screen, and the chat list), so an update notice
alone would leave a phone user without a working Buddy until a mobile release (River, 10-31). So until the mobile
release, **old per-project chats stay writable** and keep working on old clients:

- A person's message in their old *X* chat goes to an *X* project session that lives in that old chat: started on the
  person's Buddy machine with the one Buddy's name and engine when the first message arrives, ended after 30 idle
  minutes like any session. It is a project session in every rule above: it reads only *X*, writes only that old chat
  and proposals to *X*'s PM, no wide mode. On the phone it looks as it does today.
- The PM's private lines from *X* also go into the old *X* chat while this lasts, so an old client never misses one.
  Desktop shows them once (in # buddy; the old chat sits under Earlier chats).
- Older Desktop and web keep the Buddies section, working the same way.
- **After the mobile release** (a follow-up for the mobile team: the dial's Buddy screen and the chat list move to the
  one chat), a server change makes old chats read only and stops the copies. Until then nobody is left without a Buddy.
- Ruling: compatibility through project sessions, not by keeping per-project Buddies. Why: a project session already has
  the narrow rules an old chat needs, and the person still has one Buddy (one name, one machine). Cost if wrong: more
  server paths to keep until the mobile release.
- **Older CLIs (hosts)**: the Swarm Buddy needs a host that says it can run one (capability `swarmBuddy`). On an older
  host `buddy.create` is refused: "Update Harness on <machine> to start your Buddy." Old per-project Buddies on such a
  host keep running until their person starts their one Buddy.
- **An older server (rolling deploy or rollback)**: the Swarm chat has a kind of its own, `swarm-buddy`, which an older
  release parks unread (`parkLaterConversations`) instead of reading it as a project's chat, so nobody reads it, its person
  included, until the new server is back, and no other read breaks. It shows the old per-project chats as before.

### 5. Access

- Each read is checked as the person, now, per project: the person's current membership and generation, as
  `buddyPerson` does today, for each project instead of one.
- A Buddy runs only on its person's own machine, never on a machine shared with them and never in a Harness Team
  account. A Team account's rules are unchanged.
- **Removed from project X**, in the same write: X's project sessions end and their pending starts fail; X's messages
  in the chat (PM lines and X session threads) are hidden from the person, as X's old chat was; the main Buddy's reads
  of X are refused at once, and its worktree of X is removed before its next turn. The main Buddy's earlier answers stay:
  they are the person's own conversation.
- **Leaving the Swarm** or rejoining: as today; the chat is bound to the membership generation.

## Desktop (ASCII, from `project_sidebar.dart`, `buddy_rows.dart`, `view.dart`, `thread_panel.dart`)

Only what changes is drawn.

**Sidebar.** The Buddies section is gone. `# buddy` is the first row under Projects, above the A–Z projects. It uses the
project row's `#` mark and bold-when-unread, with the Buddy's activity mark on the right (`⠋` working, `◌` offline, none
when idle or not started). No chevron: it has no workgroups.

```
 [👥] Swarm: autonomous.ai           ▾
 [+ ] New project
 [○ ] Your devices
 [🧠] Your models
 [🔔] Notifications                (3)

 Projects ▾                         [+]
  #  buddy                          ⠋      ← only you read it
  #  openharness                    ?  >
  #  product-managers
  #  web-2                             v
     196  Regression in login       ⠋
     195  Fix CI                    ?
         Moving · waiting on ken
     … 4 more
     Closed (3)                        >

 Machines ▾  [3 online]             [+]
 Models ▾
```

**The chat.** Header and bar as today's Buddy chat, with the project replaced by "all your projects". Earlier chats and
Rename / Remove stay in ⋮.

```
┌ Wren · Your Buddy ─────────────────────────────────────── ⋮ ┐
│ Claude on Kens-MacBook · reads all your projects · only you  │
│ can read this chat                                           │
│──────────────────────────────────────────────────────────────│
│ (R) River (PM · openharness) → you  10:02                    │
│ Your login fix shipped in 0.5.18.                            │
│ (Q) quang  10:41                                             │
│ which of my tasks are stuck, across projects?                │
│ (W) Wren ◆  10:41                                            │
│ openharness #196 waits on review; web-2 #88 waits on you.    │
│┌────────────────────────────────────────────────────────────┐│
││Message Wren                                                ││
││[New session ▾]                                       📎  ↑ ││
│└────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
  ⋮ menu:  Rename Buddy…  ·  Earlier chats ▸ openharness, web-2  ·  Remove Buddy
```

**New session picks where it works.** The chip opens a short menu. "Any project" is today's New session. A project
starts a project session, which is the only way to send work to that project's PM.

```
[New session ▾]
 ┌──────────────────────────────────────────────┐
 │ Any project · reads all, can't send to a PM  │
 │ openharness · can send to its PM             │
 │ web-2 · can send to its PM                   │
 └──────────────────────────────────────────────┘
```

**A project session's thread** says its project on the session line.

```
┌─Thread─────────────────────────────────[×]┐
│ ⠋ openharness session · Working  End session│
│───────────────────────────────────────────│
│ (Q) quang  10:45                          │
│ Turn #196 into a proposal for the PM      │
│ (W) Wren ◆  10:46                         │
│ Sent to River: "Fix login retry…"         │
│┌─────────────────────────────────────────┐│
││Reply                               📎 ↑ ││
│└─────────────────────────────────────────┘│
└───────────────────────────────────────────┘
```

**When the main Buddy is asked to send something to a PM:** "I can't send from here. Start a New session in
openharness and I'll send it from there." (skill text).

## Design

- **Growth.** One chat per person per Swarm replaces one per project, so fewer conversations. Messages follow the
  existing chat retention. Old chats stay, read only, until the existing retention removes them; nothing new to delete.
- **Concurrency.** Chat creation is idempotent by its stable id. `buddy.create` is one write that checks one main Buddy
  per person per Swarm (`BUDDY_EXISTS`) and pending starts, as today per project. Sessions keep the per-chat limit of 3.
- **Read cost.** The main Buddy's status is an index: one line per project (at most 50) and the 20 newest changed tasks,
  only what changed since its last read; a project's full task list only on request. No new full-Swarm read.
- **Scale.** At 10x projects per person, the Buddy home holds 10x worktrees; the first metric to warn is disk per
  Buddy launch (`BUDDY_REQUIREMENTS.diskBytes`), so worktrees are made only for projects whose repository is on that
  machine and are shallow read-only checkouts.
- **Compatibility.** Section 4.
- **Migration and rollback.** Additive: a new chat kind (`swarm-buddy`) and agent fields; old chats untouched; no script.
  An older release parks the new kind unread during a rolling deploy. Rollback: the old server finds no project for the Swarm chat, so nobody
  reads it; people add their per-project Buddies again.
- **Audience.** The server enforces every read and command: the chat's audience is the person alone; the session's
  project limits are checked on each read path and on `buddy.propose`.
- **Identity.** The Buddy speaks as its own agent, on its person's own machine and account; never the machine owner's
  login for someone else.
- **Failure.** A worktree that can't be made is skipped and the Buddy says which project's code it can't read. A host
  without `swarmBuddy` gets a clear refusal. A refused proposal tells the Buddy why, and it tells its person.
- **Platforms.** macOS and Linux as today; Windows still refused for Buddies. Desktop and web get # buddy; the phone
  keeps its per-project chats working (section 4) until its follow-up release.

## Build order (reviewable PRs)

1. **Server**: the Swarm Buddy chat and agent, reads per project, project sessions, `buddy.propose` limits, `person.tell`
   to the one chat, old chats answered by a project session, the Swarm chat's own kind. Integration suite in full.
2. **CLI and guard**: Buddy home folder and per-project worktrees, host capability `swarmBuddy`, folder sync before each
   delivery, project session start (no wide mode), `fromOwnPerson` for the Swarm chat, status across projects, skill
   and help text.
3. **Desktop**: # buddy row, no Buddies section, chat bar, Earlier chats, New session menu, session line; light and
   dark screenshots.

## Tests that fail first

- One Buddy per person per Swarm: a second `buddy.create` in the same Swarm is refused; two projects show one chat.
- Old history: an old per-project chat still reads for its person and is listed in Earlier chats; a message there from
  an old client reaches an *X* project session, and the PM's *X* lines land in both chats.
- Writes: each write path above is refused from the main Buddy, a plain session and an *X* session aiming at *Y* or at
  *X*'s chat directly; only an *X* session's proposal lands in *X*.
- No carrying: a project-X session reading project Y's group, the main chat, another thread or a main-Buddy root is
  refused like a made-up id; its proposal lands only in X; the main Buddy's proposal is refused; a file from the main
  chat on an X proposal is refused.
- Access: after the person is removed from X, X's sessions end, the main Buddy's reads of X are refused, X's PM lines
  are hidden, and X's worktree leaves the Buddy home before the next delivery.
