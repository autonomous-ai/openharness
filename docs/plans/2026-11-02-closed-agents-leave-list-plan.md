# Swarm: an agent closed on its machine leaves the list, and is never shown as Idle

**Goal:** an agent whose session is closed on its machine is recorded as stopped and leaves the Machines list on its
own. Huy (2026-11-02) closed 4 agents on MacBookPro2021. Their sessions were in the machine's stopped list and each had
been down since 07:04-08:15 UTC, yet the Swarm kept them waiting for a keep-or-stop answer and the Machines list showed
them under **Idle** for hours.

**Why it happens:** a machine's report that lists a session as stopped already loses the agent's open task
(`liveness.ts` `loseTasks`) but leaves the agent itself in `state.agents`. Only the agent's own host, after a stop was
asked for (`agent.release` then `agent.remove`), ever removed it. A session closed by hand never asked. Desktop then draws
any agent without work as Idle (`machines.dart` `_agentGroups`).

## Behavior

- A report that lists an agent's session as stopped (proved the way slot counting already proves it, `machines.ts`
  `machineSlots`) and not running removes the agent once it has been down 30 seconds (`STOPPED_REMOVE_MS`) and the
  previous fresh reading did not list it running either. The wait covers a host mid-restart and Change agent, which list a
  session stopped for a moment before it is back. The task it held went to the PM as lost first.
- An agent that is down (not listed running) for 15 minutes, with its machine reporting fresh on two reports in a row,
  is removed the same way, but never while the report or the previous one lists no session running at all (a fault in
  the host's listing must not empty a machine). One report after a machine was silent never removes anyone.
- Stays: a coordinator (it leads a project), a Buddy (its owner's to stop), an agent whose coordinator or a person
  chose **keep**, an agent whose stop was asked for (its host closes it and takes it out), and an agent that holds a
  task: active, or lost just now and not yet handed on or cancelled by the PM (the PM is told by name and the agent
  stays fenced). The next report after the PM decides removes it. A kept agent that is down shows **Kept (closed)**, not
  Idle, in the Machines list, on its line and in its hover.
- Removal is `removeAgent`'s bookkeeping, **with its close record** (`closedAgents.ts` `recordClosing`, shared with
  `commands.ts`): the agent's host closes the session, a confidential session on a Team account keeps the account held
  for its project until the host confirms the data deleted, and the host's confirmation frees the session's slot
  (`agent.sessionClosed`). The agent leaves every group's members and leads, its undelivered messages are cancelled, and
  the terminals opened on its old session are revoked.
- Resume: the CLI host never sends `agent.add` (only Desktop's "add session" does), so a session reopened after its
  agent was removed runs without a Swarm agent until someone adds it. Re-adding it from the host is its own task (the
  removed agent's group, role and configuration are gone, so the host needs a new command and a journal of what to
  restore); Lead 2026-11-02.

## Steps (test first)

1. Integration tests in `backend/integration/superTabLiveness.test.ts`, run on main to watch them fail: a stopped
   session's agent leaves (with its lost task still reaching the PM), a kept one stays, a coordinator stays, a running
   one stays, a down-15-minutes one leaves only after two fresh reports; a stop requested, a restart and an empty running list keep it;
   an assignment racing the removal; the close record (unit tests in `closedAgents.test.ts`, confidential Team session held).
2. `closedAgents` (selection) and `removeClosedAgents` (state change) in `backend/src/superTabs/closedAgents.ts`;
   `store.ts` `fullReading` loads the groups of those agents, removes them, cancels their deliveries (one plain match each: an `in` here is
   sent as `$expr`, hotFilters) and revokes their native contexts. `nextRemovalAt` keeps the machine's deadline: an unchanged stopped
   list skips the full report, so the agent's wait end forces one.
3. Dart tests for the row label: a kept agent with `downSince` reads **Kept (closed)** in the Machines list and the agent
   line. Then the label in `agent_line.dart` and the grouping in `machines.dart`.
4. Full Super Tab suite (`cd backend && npm run test:super-tabs`); Desktop tests for the changed files.

## Design

- **Growth:** this deletes. An agent row, its group memberships and undelivered messages go when its session is
  closed, instead of waiting for a person.
- **Concurrency:** inside the machine's report transaction, which already writes the agent and group parts it
  changes and retries on a conflict with a newer write.
- **Read cost:** the report additionally loads the groups of the agents it removes (by the `agents` index), only when
  there is one; the common report loads exactly what it did.
- **Scale:** at most the machine's agents per report; the metric to watch is reports that remove agents.
- **Compatibility:** no new fields. Old clients see the agent leave the list as they do after a host-confirmed stop; a
  kept closed agent keeps showing as before on old clients (Idle or Down).
- **Migration + rollback:** none; reverting stops removals, and nothing removed comes back by itself (an agent whose
  session is resumed is not added again, see Behavior).
- **Audience:** the server decides from the machine owner's own report, which can only name its own sessions
  (the report already refuses another's machine); no client input chooses who is removed.
- **Identity:** nothing is written as a person; no message is posted.
- **Failure:** an agent holding a task is not removed (its task is lost first, the PM decides, the next report removes it);
  a coordinator is never removed. A heartbeat that changes nothing is stored without the full load; the machine's deadline
  is the end of the next agent's wait (`nextRemovalAt`), so a stopped list that stays the same still removes its agent
  then, not after the five-minute cap.
- **Platforms:** backend, Desktop and the web build share `machines.dart`.
