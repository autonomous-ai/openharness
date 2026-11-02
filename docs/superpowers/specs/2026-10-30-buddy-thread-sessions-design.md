# Buddy thread sessions: a thread can have its own Buddy session, in parallel

Status: design · 2026-10-30 · requested by Scholes · Engineer: Atlas · group #1421. Scope (Scholes, through the Lead, 10-30):
backend, CLI host and Desktop. The phone is out of this task: it only reads the new fields so its parity test passes.

## Why

A person talks to their Buddy in one chat, and the Buddy answers one message at a time. A long question ("measure prod
CPU for the last day and tell me what changed") holds every later one, so "what's the PR number again?" waits minutes.
Scholes wants a way to start a thread that has its own Buddy session working in parallel. By default, the chat works as
it does today: one session, one message after another.

Done when: a person starts a thread with **New session**, asks it a long question, and gets an answer to a quick
question in the main Buddy chat while the thread is still working.

## What exists today (read from the code, main 9a82d88)

- **One Buddy per person and project.** `buddy.create` refuses a second one (`BUDDY_EXISTS`, `commands.ts:1632`). It
  starts on the person's own machine (`BUDDY_OWN_MACHINE`) in a worktree of its own (`super-tab/<startId>`).
- **Routing.** In a Buddy chat, a person's message goes to the replied-to agent if it is in the chat, and otherwise to
  `group.agentIds[0]` (`commands.ts:2034-2036`). A thread reply is routed like any other message.
- **Threads.** A top-level message's `thread` is its own id, and a reply's `thread` is its root (`store.ts:1967`,
  `:1192-1200`). Threads never nest, and they can't be closed. Reading with a `{thread}` cursor exists
  (`store.messages`).
- **Order.** The server queues one delivery per recipient. The host on the person's machine claims each agent's list in
  order and types it into that agent's terminal, which holds it while the agent is busy (`host.ts:763-812`). The order is
  kept per agent, so a second agent gets its own queue.
- **Guard.** Each launch writes the session's own `.claude/settings.local.json`, `buddy-guard.mjs` and `buddy-launch`
  into its folder (`lockBuddyFolder`, `swarmSkills.ts:742`).
- **Wide reads (#2310).** A grant holds for one session (its reads list, keyed by the session label), one launch (a
  random id in that folder), the signed-in account, and an hour. The host grants it at each delivery of the person's own
  message (`grantBuddyWide`, `host.ts:1207-1247`).
- **Audience.** A Buddy agent reads its chat only while it is in `agentIds` and its person still reads the project
  (`buddyReads`). The PM and the Swarm owner never read it.
- **Desktop.** **Reply** on a message opens the thread pane (`thread_panel.dart`): the header reads `Thread` with a ×
  (`Close thread`); below it are the root, the replies, and a composer with the hint `Reply` and an `Also send to the
  chat` checkbox, then 📎 and ↑. Under a root in the chat, the thread line reads `N replies · Last reply 5m ago`. Neither
  the chat nor the thread shows whether the Buddy is working; only the sidebar's Buddy row shows an activity mark.

## The model

A **thread session** is a second Buddy agent in the same Buddy chat, tied to one thread. It is started like the main
Buddy, on the same machine with the same engine, guard and skill, in its own worktree. It differs in three ways:

- It hears only its thread.
- It answers only in its thread.
- It ends when its thread is done with it.

The main Buddy (the **main session**) is unchanged.

Ruling: a thread session is a separate agent, not a second process under the main Buddy's agent. Why: delivery, claims,
audience, the folder lock, the wide grant and stopping are all per agent today, so each session gets its own of each with
no new path. Cost if wrong: each session counts as one agent on the machine (`set-agents`), so a full machine refuses
it, and says so.

### Starting one

- **Where.** The Desktop thread composer, in the person's own Buddy chat, shows a **New session** checkbox when the
  thread has no live session. Checking it and sending the reply starts the session, and that reply is its first message.
  A thread that does not exist yet is started the same way: **Reply** on any main-chat message opens the thread pane.
- **Command.** `message.send` gains `newSession: true`. The server accepts it only when every condition below holds,
  and otherwise refuses with the reason shown:
  - The author is a person, in their own Buddy chat.
  - The message is a thread reply (`replyTo` set, landing in a thread).
  - The thread has no live or starting session.
  - The main Buddy exists, and its machine's host says it can run sessions (see Compatibility).
  - The chat has fewer than 3 live or starting sessions (`BUDDY_SESSIONS_FULL`: "3 sessions are running. End one to
    start another.").
- **What it writes,** in the same command:
  - The message, tagged `buddySession: true`.
  - An `AgentStart` with `buddyOf`, `buddySession: { thread: root, from: <the message's sequence> }`, and the main
    Buddy's machine, engine and model.
  - An entry `{ thread, startId, at }` in the chat's `buddySessions` (at most 3).
- **First delivery.** On `agent.started` for a thread session, the server sets `agentId` on the chat's entry and writes
  a delivery to the new agent for each of the person's `buddySession` messages in that thread, in order, that is still
  waiting. So the first message reaches it through the same `accept()` as any other: the person check, the `run:`
  judging and the wide grant all apply.
- **Its first prompt** (`buddyPrompt` for a session) names its chat and thread, and says:
  - It answers only in this thread, with `--reply-to`.
  - Its starting context is the thread plus the main-chat excerpt below.
  - The PM rule is unchanged.

  No message text goes into the start record. Start records are listed in the Lead's status.

### The starting context ("short summary of the main chat")

The session reads, through the server only:

- the thread's root and its replies;
- the **10 main-chat messages before the session started** (sequence ≤ `from`), each cut to 500 characters, at most 6 KB
  in all, oldest first.

The server builds this when the session reads it (`messages CHAT --thread ROOT` returns it as `context`). It is never
stored, and it is fixed by `from`, so it reads the same each time.

Ruling: an excerpt, not a written summary. Why: the main session is the busy one, so it can't stop to write a summary,
and the thread session may not read the main chat itself. Cost if wrong: an excerpt of the last 10 messages may miss an
older topic. The person can paste what is missing into the thread.

### Routing, both ways

- **To a session.** A person's reply in a thread with a live or starting session goes only to that session, and is
  tagged `buddySession: true`. If the session is still starting, it waits for the first delivery above. This is decided
  by the server from the thread, so it holds for every client, old Desktop and the phone included.
- **To the main session.** Everything else goes to the main Buddy: main-chat messages, and threads without a session.
  The main Buddy is picked by `!agent.buddySession`, no longer by `agentIds[0]`.
- **A thread whose session ended.** A plain reply is refused: "This thread's session ended. Send with New session to
  continue." Desktop checks **New session** for it. The new session reads the whole thread, including the replies from
  the session before it.
- **Back.**
  - A thread session's `post` must use `--reply-to` a message in its own thread (`BUDDY_SESSION_THREAD`).
  - It can't use `alsoSend`.
  - Its posts are tagged `buddySession: true`.
  - So a reply can never land in the main chat.

### Stopping

A session ends in these cases:

1. **The person ends it**: **End session** in the thread pane. Closing the pane (×) only hides it. Closing the pane to
   ask a quick question in the main chat is the reason this feature exists, so it must not stop the session. Threads
   can't be closed today, so "thread closed" means **End session**.
2. **30 minutes idle.** The host on the person's machine judges this from what it already reports per session:
   - no screen or transcript change (`harnessProgress`) for 30 minutes;
   - no open delivery to the session;
   - no person message in its thread for 30 minutes.

   A session still working on a long question changes its screen, so it is not idle. The host sends
   `buddy.sessionEnd { agentId, reason: 'idle' }` as the machine's owner, who is the person.
3. **The main Buddy is removed**, or the person loses the project or leaves the Swarm. Every path that removes the main
   Buddy removes its thread sessions in the same write.
4. **Its start fails**, or its process stops unexpectedly. Then the entry is removed and the session is ended, never
   restarted.

Ending uses the existing path:
- `removeAgent` puts the session in `closingSessions`, removes it from the chat's `agentIds` and `buddySessions`, and
  cancels its open deliveries.
- The host's `endSession` then forgets its reads list, closes the terminal, confirms with `agent.sessionClosed`, and
  removes its worktree.
- A quiet line in the thread says why it ended: "Session ended: idle for 30 minutes." / "…: you ended it." / "…: it
  couldn't start: <why>." / "…: it stopped unexpectedly."

## Security

Every thread session runs with the same guard and rules as the main one. Nothing is loosened.

- **Same guard, same skill.** `lockBuddyFolder` runs unchanged for a session, in its own folder. A test compares a
  session's settings and guard file with the main Buddy's, byte for byte, apart from the folder path, the reads-list path
  and the launch id. The Buddy skill text is unchanged; only the first prompt adds the thread paragraph.
- **Sends to the PM only when the person asks.**
  - `buddy.propose` from a session needs `ownerMessageId` to be the person's own message in that session's thread.
  - The guard's secret check and "summaries only" apply as they do today.
  - `harness send/new/tell/close` stay refused from its pane (`buddyPane.ts`).
- **The wide-read grant (#2310).** A session gets its own grant or none. It never shares or inherits the main
  session's:
  - Its own reads list (keyed by its own session label), its own launch id in its own folder, and its own owner mark.
    A grant written for the main session names another session and another launch, so the session's guard refuses it.
  - The host grants it only at the delivery of the person's own message in that session's thread, with the same checks
    as today: `fromOwnPerson`, on the person's machine, signed in as them, and an hour at most. This is why the first
    message arrives as a delivery and not through the prompt. Until then, and whenever a check fails, the session reads
    its own folder alone.
  - `run:` approvals stay per person on this machine, as ruled in #2310. An approval given in a thread also covers the
    main session. Approvals unlock only reads the grammar allows.
- **No session reads another's thread.** One server predicate, `buddySessionReads(agent, message)`, is applied on
  every agent read path of a Buddy chat: messages list, one message, thread read, change feed, the message in a claim,
  and `status`'s chat summary.
  - A thread session reads only messages whose `thread` is its root, plus the starting context above.
  - The main session does not read `buddySession` messages: other sessions' threads, past or present.
  - The person reads everything, as today.
- **Local copies.** Each session is a separate terminal, transcript and folder.
  - Wide mode already closes `~/.claude` (transcripts and the paste cache), `/tmp/claude-<uid>` and Harness's data
    folder.
  - New: the guard also closes every other Swarm session folder on the machine (the worktrees root except its own).
    Another session's downloaded attachments and folder can't be read in wide mode.

| # | Threat | Control | Test |
|---|---|---|---|
| S1 | A session reads the main chat beyond its excerpt | `buddySessionReads` on every agent read path | One test per read path, made-up and real ids |
| S2 | The main session reads a session's thread | Same predicate (`buddySession` messages) | Same |
| S3 | A reply lands in the main chat | `BUDDY_SESSION_THREAD`; no `alsoSend` | Command tests |
| S4 | The wide grant reaches a session nobody granted | Per-session list, launch id and account; granted only at that session's own deliveries | Host and guard tests: the main grant is refused by the session's guard and the reverse |
| S5 | Another session's folder or files are read in wide mode | The guard closes other session folders | Guard test |
| S6 | Someone else starts or ends a session | The person in their own chat; the host's end as the machine owner, who is the person | Command tests, other person, PM, other project |
| S7 | A planted PR in a thread asks for a proposal | `ownerMessageId` must be the person's message in that thread | Command test |

## Desktop (ASCII mockups, from `thread_panel.dart`, `view.dart` and `message_row.dart`)

Only what changes is drawn. Everything else stays as it is. Words follow the design system: one focal action (Send),
quiet borderless controls in the composer row, `ActivityMark` with words for status, and nothing new in the sidebar.

**1. The thread composer in a Buddy chat, with no session.** **New session** sits on the left of the existing row. When
it is checked, **Also send to the chat** is hidden: a session's thread stays in the thread.

```
┌─Thread──────────────────────────────────[×]┐
│ (Q) quang  10:41                           │
│ Measure prod CPU for the last day and say  │
│ what changed                               │
│                                            │
│┌──────────────────────────────────────────┐│
││Reply                                     ││
││☐ New session   ☐ Also send to the chat 📎 ↑││
│└──────────────────────────────────────────┘│
└────────────────────────────────────────────┘
  tooltip on New session: "Answer this thread in its own session, while
  your Buddy keeps answering the chat"
```

**2. At the limit.** The checkbox is disabled and says why.

```
││☐ New session · 3 running, end one first  📎 ↑││
```

**3. A thread with a session.** One line under the header shows which session answers and whether it's working, with
**End session** as a quiet text button. The states are: `Starting…`, `⠋ Working`, `✓ Idle` and `◌ Your Mac is
offline`, each with words.

```
┌─Thread──────────────────────────────────[×]┐
│ ⠋ Own session · Working        End session │
│────────────────────────────────────────────│
│ (Q) quang  10:41                           │
│ Measure prod CPU for the last day …        │
│ 2 replies ──────────────────────────────── │
│ (W) Wren ◆  10:42                          │
│ Reading the last 24 h of pod logs…         │
│┌──────────────────────────────────────────┐│
││Reply                                 📎 ↑││
│└──────────────────────────────────────────┘│
└────────────────────────────────────────────┘
```

**4. The main chat while it works.** The thread line under the root gains the same mark. The main composer is
unchanged, and the main Buddy answers there as usual.

```
│ (Q) quang  10:41                                    │
│ Measure prod CPU for the last day and say what…     │
│ (Q)(W) 2 replies · Last reply 1m ago · ⠋ Own session│
│ (Q) quang  10:43                                    │
│ what's the PR number for the login fix?             │
│ (W) Wren ◆  10:43                                   │
│ #2290.                                              │
│┌───────────────────────────────────────────────────┐│
││Message Wren                                   📎 ↑││
│└───────────────────────────────────────────────────┘│
```

**5. After it ends.** The line under the header says why. **New session** is checked and locked, because a plain reply
there would be refused.

```
│ Session ended: idle for 30 minutes                 │
...
││☑ New session                                 📎 ↑││
```

Ruling: no session list in the sidebar or the header. Why: "less is better". The threads are where the sessions are,
and the thread line shows which ones are working. Cost if wrong: with 3 sessions, the person scrolls to find them.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______ Reviewer (another engine): ______

1. **Growth.**

   | Record | Created | Updated | Finished / removed |
   |---|---|---|---|
   | Chat `buddySessions` entry | New session | `agentId` at start | End, idle, failed start, unexpected stop, main Buddy removed, access lost. At most 3, so it can't grow. |
   | Session `Agent` | `agent.started` | liveness, as any agent | `removeAgent`, then `closingSessions` until the host confirms (existing) |
   | Session `AgentStart` | New session | dispatch and start (existing) | Existing start lifecycle (`finishedAt`, purge) |
   | Message `buddySession` tag | each message in a session thread | never | with its message (existing message lifecycle) |
   | Worktree, guard, reads list on the Mac | launch | grant at each person message | `endSession` removes them (existing) |
   | Ended line in the thread | at end | never | with the chat |

   Leave and rejoin: a new membership generation has a new Buddy chat. The old sessions ended when access was lost.
   Recreated under the same key: an entry is keyed by thread and start id, and a new session in the same thread is a
   new start.
2. **Concurrency.** Each New session writes the Buddy chat's group part, which `message.send` writes anyway (its
   message sequence), and that write checks the part's version. So two quick starts on two threads, or two on one thread,
   serialize. The second re-reads and is refused at the limit or as "already has a session".
   - Ending removes the entry in the same group write. A reply racing an end either reaches the session first, and its
     delivery is cancelled with the agent, or it sees no session and is refused.
   - A session's post after its end is refused, because its agent is gone.
   - On the host, each agent's delivery list is claimed on its own, so a busy main session never holds a session's
     delivery, nor the reverse. Test: a delivery held for the main session while a session's delivery is accepted.
   - Thin slice: two concurrent New session sends against a live store; exactly one start.
3. **Read cost.**
   - Routing reads only the chat's `buddySessions` (at most 3 entries), which is already loaded.
   - A session's reads are thread reads on the existing `[tabId, conversationId, thread, sequence]` index.
   - The excerpt is one indexed read of at most 10 main-stream messages before `from`.
   - The main session's reads add `buddySession != true` to the query it already runs.
   - Nothing new per host poll: the host's idle check uses data it already holds.
   - Test: a session's thread read loads only its thread's rows.
   - Removals: an ended session leaves `agentIds` and `buddySessions` through the existing change feed, so Desktop drops
     its marks.
4. **Scale.**
   - At most 3 sessions per person per project.
   - At 10x people, there are 10x Claude processes, each on its own person's Mac. The server holds at most 3 small
     entries per chat.
   - The first warning is sessions refused because the machine is full, and Macs low on memory: each session is one
     Claude Code process (about 300–600 MB).
   - **Where it shows** (security review 1: the usage counters this line first named do not exist, and the fixed usage
     vocabulary is shared with the CLI, so this uses the server log instead). The backend logs three lines with ids only:
     - `Buddy session started` (Swarm and start id);
     - `Buddy session refused` (Swarm and refusal code: `BUDDY_SESSIONS_FULL`, `BUDDY_SESSION_UNSUPPORTED`,
       `BUDDY_SESSION_ENGINE`, `BUDDY_SESSION_NO_BUDDY` and the machine's capacity refusals);
     - `Buddy session ended`, with the reason (`ended`, `idle`, `stopped`, `failed`, `removed`, `maintenance`), logged
       once committed.

     Prod watch reads them from the backend's logs (ArgoCD app logs). The first alarm: refusals for capacity above 10%
     of starts in a day, or `failed` ends above 10% of starts.
5. **Compatibility.** Every reader of a new field, from a search of the code:
   - **Server** (`agentIds[0]` in `commands.ts:2036`; `BUDDY_EXISTS` at `:1632`; `nameTaken` and `renameBuddy` in
     `buddies.ts`; pending-start lookups at `:1597` and `:1633`; `stopIdleWorkers`, which skips Buddies; `deliveryAllowed`;
     `buddyReads`): each picks the main Buddy by `!buddySession`, or counts only the main Buddy. Rename renames both.
   - **Old CLI host:** it doesn't report `buddySessions` in its machine report, so the server refuses New session ("Update
     Harness on <machine> to use sessions"). An old host never runs a session it doesn't understand.
   - **Old Desktop and the phone:**
     - They show a session's replies as ordinary thread replies from the Buddy.
     - Replies in a session thread still reach that session, because the server routes by thread.
     - A plain reply in an ended thread shows `Not sent` with the reason.
     - Sessions end on their own after 30 minutes idle.
     - Old Desktop's own Buddy pickers read `agentIds.first`; the server keeps the main Buddy first in `agentIds`, even
       after a restart.
   - **Phone parity:** `mobile/lib/swarm/model.dart` reads the new fields (`buddySession` on messages and agents, and
     `buddySessions` on conversations), with no UI, so `desktop_parity_test.dart` holds. This is coordinated with Tony,
     whose work is in `mobile/lib/swarm`.
   - **Rolling deploy:** a new client against an old server never sees the host capability, so it never offers New
     session.
6. **Migration and rollback.**
   - No data migration: every field is optional and absent on old rows.
   - Deploy order: backend first, then CLI (hosts report the capability), then Desktop.
   - What the previous release does with each new field and state, if live sessions were left (security review 1: the
     earlier text here was wrong):
     - It ignores `buddySessions`, `buddySession` on agents and starts, and the message tag.
     - It reads each session agent as one more Buddy in the chat:
       - The main Buddy reads session threads again. No other person can read anything, but sessions are no longer kept
         apart.
       - A session may post anywhere in the chat.
       - Its Buddy removal takes the first Buddy it finds, which may be a session, and leaves the others running.
     - A person's message goes to `agentIds[0]`, which this release keeps as the main Buddy.
     - It refuses `buddy.sessionEnd` (an unknown command), so the host can no longer end idle sessions: they would run on
       the person's Mac until their Buddy was removed.
     - New Desktop's `newSession` is refused by its strict schema; the composer shows the error.
   - **So the rollback ends every session first, while this release still runs:**
     1. `node --import tsx backend/scripts/buddy-sessions/end-all.ts`: a dry run that lists the live sessions by Swarm
        and chat id.
     2. The same with `--apply`. Each session ends through its own end path, as the chat's person, with reason
        `maintenance`. Its host closes it and deletes its folder, and its thread says "Session ended: Harness was
        updated." This is a prod write, so Ken runs it.
     3. The dry run again shows none.
     4. Roll the backend back.

     A session started between steps 2 and 4 would be left: run step 2 again right before step 4. The integration test
     `can all be ended before a rollback` runs steps 1–3 on a live store.
   - Rolling back only the CLI: an older host stops reporting the capability, so New session is refused there. A
     session it already runs is left without the idle end until the Buddy is removed, so the same script runs first.
   - Rolling back only Desktop: the choice disappears, and the server keeps routing by thread.
   - Production check: no migration runs. The read-only anomaly query counts Buddy chats whose `agentIds` hold more
     than one agent today (expected 0), so the main-Buddy-first rule holds on existing data.
7. **Audience.** It doesn't change who can read anything: the chat is still read only by its person. The new rule is
   between that person's own sessions (the Security section). The guards are named for every copy:
   - API reads and the change feed: `buddySessionReads`.
   - The agent's terminal: only its own deliveries.
   - The start record: no text.
   - Logs: ids only.
   - Desktop caches: cleared with the chat on access loss (existing), and a session's marks leave with its agent.
8. **Identity.** A session runs exactly as the main Buddy does:
   - It runs on the person's own machine (`BUDDY_OWN_MACHINE`), under their own account and engine sign-in.
   - Wide mode is never on a Team account.
   - The host's idle end is sent as the machine's owner, who is the Buddy's person; the server checks
     `machineOwnerId === buddyOf.personId`.
   - Anyone else is refused.
9. **Failure.** Who notices each, and what the person sees:

   | Failure | What the person sees | Recovery |
   |---|---|---|
   | Start refused (limit, machine full, old host, Mac offline) | The thread composer says why before sending; the server refuses with the same words | Send without New session, or end a session |
   | Start fails on the Mac | Ended line "couldn't start: <why>" in the thread; the reply stays | New session again |
   | Process stops unexpectedly | Ended line "stopped unexpectedly" | New session again |
   | Mac offline while working | `◌ Your Mac is offline` in the thread line and pane | Replies wait as deliveries; the session resumes or idles out when it returns |
   | Idle end | Ended line "idle for 30 minutes" | New session |
   | Reply to an ended thread | `Not sent` with the reason; Desktop pre-checks New session | Send with New session |
   | Access lost mid-screen | The thread pane closes, and marks and cached rows clear with the chat; in-flight answers are dropped | Existing access-loss path, tested for sessions |
   | A late answer for a replaced thread or chat | Ignored by Desktop (results checked against the open thread and session) | Test |

10. **Platforms.**
    - macOS and Linux: as the main Buddy. Wide mode: macOS, and Linux with bubblewrap.
    - Windows: sessions run with folder-only reads, as its Buddy does.
    - Desktop (macOS, Windows, Linux, web) gets the choice and the marks.
    - The phone shows session replies as thread replies and gets no choice (out of scope; Scholes, 10-30).

## Tests (acceptance checks)

- **Parallel answer** (backend integration plus host): a session holds a long-running delivery while a main-chat
  question is delivered to the main Buddy and answered.
- **Replies stay in the thread:**
  - A session's `post` without `--reply-to`, or to a main-chat message, is refused.
  - `alsoSend` is refused.
  - A person's thread reply is routed to the session only.
- **Stopping:**
  - End session.
  - The host's idle check: 30 minutes with no progress, no deliveries and no messages ends it, and a working session is
    never ended.
  - Removing the Buddy removes its sessions.
  - Each case: the folder, the reads list and the agent are gone.
- **Limit of 3:**
  - The fourth is refused with the reason.
  - Two concurrent starts against a live store make one start.
  - Desktop disables the choice with the reason.
- **Guard identical:** byte compare as above; the wide grant isn't shared in either direction.
- **No cross-thread reads:** every agent read path, for a session and for the main Buddy, with real and made-up ids.
- **Privacy edges (10-29):**
  - Access revoked while the thread pane is open.
  - Ids from another project's or another person's Buddy chat are refused alike, with no title leak.
  - A reused agent id or name across projects.
  - A failed first load of the session line, with a bounded retry and no stuck `Starting…`.
- **Full backend Super Tab integration suite** (`npm run test:super-tabs`) before Ready; CLI Buddy specs; Desktop
  widget tests and light/dark screenshots.

## Open questions (provisional rulings, not waiting on anyone)

- "Thread closed" means **End session**, because threads have no close today. Closing the pane only hides it.
- A session uses the main Buddy's engine and model; there is no picker ("less is better").

## Contract between backend, CLI host and Desktop (build reference)

Records and views:
- `Agent.buddySession?: { thread: string; from: number }`: a thread session. `thread` is the root message id; `from` is
  the sequence of the message that started it. The main Buddy has none.
- `AgentStartRequest.buddySession?`: the same, written only by `message.send` with `newSession`. Never any message text.
- `Conversation.buddySessions?: Array<{ thread: string; startId: string; agentId?: string; at: number }>`: a Buddy chat's
  live or starting sessions, at most 3. `agentId` is set once started.
- `Message.buddySession?: true`: a reply in a session thread, from the person or the session.
- Message `source.kind === 'buddy-session-ended'` with `source.reason` (`ended` | `idle` | `stopped` | `failed`) and
  `source.thread`: the quiet line in the thread when a session ends.
- Machine observation `buddySessions?: true`: the host can run thread sessions. Without it, New session is refused with
  `BUDDY_SESSION_UNSUPPORTED`.

Commands:
- `message.send` takes `newSession?: true`. Refusals:
  - `BUDDY_SESSIONS_FULL`: 3 running.
  - `BUDDY_SESSION_EXISTS`: the thread has one.
  - `BUDDY_SESSION_UNSUPPORTED`: old host.
  - `BUDDY_SESSION_CHAT`: not the person's own Buddy chat, or not a thread reply.
  - `BUDDY_SESSION_NO_BUDDY`: no main Buddy running.

  A plain person reply in a thread whose session ended is refused with `BUDDY_SESSION_ENDED`.
- `buddy.sessionEnd { conversationId, thread, reason: 'ended' | 'idle' | 'stopped' }`: from the chat's person only.
  Desktop sends `ended`. The host on the person's machine sends `idle` and `stopped`. It is idempotent: an already-ended
  thread is a no-op.
- A session agent's `message.send` must reply in its own thread (`BUDDY_SESSION_THREAD`) and can't set `alsoSend`.
  The main Buddy can't reply in a session thread (`BUDDY_SESSION_THREAD`).

Reads:
- A session agent reading its chat gets only its own thread's rows. Read with `thread = its root`, the page also carries
  `context`: up to 10 main-stream rows with sequence ≤ `from`, oldest first, each text cut to 500 characters, 6 KB in all.
- The main Buddy's reads leave out every `buddySession` row, and thread summaries count none of them.
- Project reads (the project chat, workgroups) are the same for every session. Buddy news goes to the main session
  only.

## Changes from the security reviews of e87c2dc

Review 1 said Hold; review 2 passed with two notes. Each change has a test that fails without it.

- **Claude Code only.** The server refuses New session unless the main Buddy runs Claude Code (`BUDDY_SESSION_ENGINE`). The host
  also refuses to launch a session start on any other engine. Codex runs no Buddy guard hook, and a Codex Buddy from before the
  Codex refusal could otherwise have started sessions without one.
- **A session start that fails outside a command** (the pickup and run timeouts in `liveness.ts`) ends through the
  session's own end path (`buddySessions.ts` `endSessionEntry`). Its thread says why, its place frees, and the main chat
  says nothing. It was handled as a failed main Buddy start, telling the person to add their Buddy again.
- **Every end leaves its line**, Buddy removal and replacement included (`removed`), and Desktop locks New session on any
  session reply in a thread, not only on that line.
- **Desktop offers New session only when the server would take it.** Otherwise the choice is disabled with the server's
  reason: the Swarm is paused, the Buddy is down or missing, the Buddy doesn't run Claude Code, or its machine's host lacks
  the `buddySessions` capability. "Ending…" can't be pressed twice, the offline line names the computer, and wrong field
  types never break the read (Desktop and phone).
- **The host's end decision** is worked out again on every pass: an end the backend didn't take is dropped once the
  session has work again. Its operation id names the reason, so a retry is identical.
  - A gap of 2 minutes or more between passes counts as sleep, and the idle clock restarts at wake.
  - Only deliveries still in the host's hands count as work.
- **Ended sessions' folders.** Each Buddy launch writes a self-ignoring `.claude/.gitignore`, never over a project's own, so
  the worktree reads clean and its removal goes through.
- **What a session leaves on the Mac.** When a Claude Code Buddy session ends (main or thread), the host removes its own
  transcript folder, its history lines and the delivered messages those lines name, and nothing of another session's.
  Left: if Harness restarts mid-close, the scrub is skipped.
- **Wide reads.** For a thread session, only its person's message in its own thread grants wide reads or records `run:`
  approvals.
- **Reactions** pass the same session read check as reads (review 2).
- **No main-chat line for a session's start** (review 2). A start warning goes in its thread.
- **Design 4 and 6** now name the log lines that exist and the real rollback steps (above).
