# A Buddy switches between its owner's subscription and a shared model

Task #2354, requested by Scholes. Design for approval before code.

## What the person gets

A person whose Claude subscription runs out (or who just wants a cheaper model) picks one of the models shared in the
Swarm for their Buddy, keeps talking in the same Buddy chat, and later picks **Your subscription** to go back to the
conversation they had.

- The picker is in the Buddy chat's header, on Desktop, the web and the phone (one Flutter screen).
- It lists **Your subscription (Claude Code)** first and always, then every model shared in the Swarm, each naming who
  serves it: "served by Ken's Mac Studio" for a local model, "Diego's saved API" for an API (PM ruling on the task).
- Switching keeps the Buddy chat and its threads. The Buddy's Claude Code relaunches in the same terminal and reopens
  the same conversation, as a pane's model switch does today.
- When the conversation is too long for the chosen model, the Buddy starts a fresh session on it, and says so. Switching
  back to the subscription reopens the earlier conversation.
- Phase 2 (a later task): switching automatically when the subscription hits its limit.

### Mockup (Desktop; the phone shows the same menu as a sheet)

Today the bar under the Buddy chat's header reads
`Claude Code on Scholes's MacBook · reads all your projects · only you can read this chat`. Its first part becomes the
picker; the rest stays as it is.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Buddy                                                        [term] [⋮] │
├─────────────────────────────────────────────────────────────────────────┤
│ Your subscription ▾ · Claude Code on Scholes's MacBook · reads all your │
│ projects · only you can read this chat                                  │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │ ✓ Your subscription                          Claude Code     │      │
│   │ ──────────────────────────────────────────────────────────── │      │
│   │ SHARED IN THIS SWARM                                         │      │
│   │   DeepSeek 4.1 Flash   served by Ken's Mac Studio            │      │
│   │   Kimi K3              served by Ken's Mac Studio, Tony's    │      │
│   │                        Mac mini                              │      │
│   │   GPT-6.1 Sol          Diego's saved API                     │      │
│   │ ──────────────────────────────────────────────────────────── │      │
│   │ What your Buddy reads and writes goes to the machine or API  │      │
│   │ that serves the model you pick.                              │      │
│   └──────────────────────────────────────────────────────────────┘      │
```

A model served by several machines names them all: the Swarm's grid picks one per request.

While it switches the bar reads `Switching to DeepSeek 4.1 Flash…` and the picker is disabled. Afterwards:

```
│ DeepSeek 4.1 Flash ▾ · served by Ken's Mac Studio · Claude Code on      │
│ Scholes's MacBook · reads all your projects · only you can read this…   │
├─────────────────────────────────────────────────────────────────────────┤
│  Your Buddy now runs on DeepSeek 4.1 Flash, served by Ken's Mac Studio. │
│  -- or, when the conversation was too long --                           │
│  Your Buddy started a fresh session on DeepSeek 4.1 Flash: this         │
│  conversation is too long for it (128K). Switch back to your            │
│  subscription to continue the earlier one.                              │
│  -- or, on failure --                                                   │
│  Couldn't switch your Buddy: Ken's Mac Studio isn't serving DeepSeek    │
│  4.1 Flash now. It is still on your subscription.                       │
```

When the model the Buddy is on stops being served (its machines left or went offline), the bar reads
`DeepSeek 4.1 Flash ▾ · not served now`, so the person knows to pick another or go back.

The lines are written by the server into the owner's Buddy chat only; nobody else reads that chat.

## How it works

### Reused: the move onto a shared model

A pane's model picker already moves a running agent between its own login and a grid model:
`agent_retarget` on the machine's daemon (`cli/src/backendSocket.ts`) resolves the model on this machine's own grid
sign-in (`models().moveTarget({ gridName, model })`), and `core/agents/retarget.ts` respawns the same pane with the
grid's environment and `--resume <session>`. The pane, its agent id and its Swarm identity stay; the conversation comes
back. It keeps the model the agent had on its own login (`subscriptionModel`) for the way home, and keeps a Buddy's
role through the Swarm role lookup (#2255), so the relaunch is a Buddy launch with its guard.

The Buddy switch drives exactly that call on the Buddy's own machine. It adds two things the pane picker does not have:
the server's list of what may be offered, and a fresh session when the conversation does not fit.

### Flow

```
Desktop/web/phone            Backend                         Buddy's machine (host + daemon)
  pick a model ──────────► buddy.model ─┐
                           checks: own Buddy, running,       │
                           model in servedLocalModels,       │
                           host has the capability           │
                           records agent.modelRequest ───────┼──► host row carries the request
                                                             │    host: measure the conversation,
                                                             │    agent_retarget { gridModel, gridName,
                                                             │      fresh? } (or clearGrid) per session
                           buddy.modelResult ◄───────────────┘    reports ok / fresh / error
                           sets agent.gridModel,
                           writes the system line
  bar reads gridModel ◄────── change feed
```

This is the same shape as the PM switch (`lead.switch` → `switchRequest` → host → `agent.switchResult`): the person
asks the server, the server decides what is allowed, the host that owns the process carries it out, and the server
records the outcome. The server, not the app, is where the allow list is enforced.

### What may be offered (one server predicate)

The server already has the predicate a routed start on a Swarm model is checked with: `servedLocalModels(state, now)`
in `backend/src/superTabs/machines.ts`, every model on **this Swarm's grid** in a fresh reading of a machine in the
Swarm's Machines list (`kind` `local`, a model a member's machine serves, or `api`, an API a member shares), not one still
starting. `buddy.model` refuses any grid model it does not list, so the Buddy is offered exactly what a Builder may be
started on. Not offered: models of other grids a member is signed into (`kind: shared`, usable only on that member's
machine), models of other Swarms, a machine outside the Swarm. The person's own subscription is always offered.

The Buddy's own machine must be on the Swarm's grid to reach those models; a Buddy-only machine never joins it
(`hostRows.ts`). Then the server refuses with "Add <machine> to the Swarm's Machines to use shared models", and the
picker shows the same line instead of the list.

The picker builds its list from the machine readings the person's own Swarm read already carries (Desktop's
`superTabLocalModelRows`, grouped by model so every serving machine is named, with each machine's person). No new read;
the Buddy agent's own reads still show no machines.

### The switch on the Buddy's machine

New Swarm-side module `cli/src/superTabs/buddyModel.ts` (no Swarm code in `cli/src/core`):

1. Takes a `modelRequest` from the Buddy's host row once (a local record keeps the request id, so a restart never
   repeats it).
2. For each live session of the Buddy on this machine (the main one, then any thread session): if the target is a grid
   model with a known context window, reads the session's current context size: the last assistant turn's
   `input + cache_read + cache_creation + output` tokens from the end of its Claude Code transcript (a bounded tail read,
   `cli/src/lib/conversationSize.ts`). It fits when that is under 80% of the window; unknown size or unknown window counts
   as fitting (the move resumes, as a pane switch does today).
3. Calls its own daemon's `agent_retarget` with `gridModel` + `gridName` (or `clearGrid`), and `fresh: true` when the
   conversation does not fit.
4. Reports `buddy.modelResult { agentId, requestId, ok, fresh, error }`.

Two generic additions to `agent_retarget` (not Swarm code; any pane could use them):

- `fresh: true`: the respawn starts a new session instead of `--resume`, and the registry row keeps the session it left
  as `subscriptionSessionId` (only when leaving the own login, like `subscriptionModel`).
- On the way home (`clearGrid`), a row with `subscriptionSessionId` resumes that session and clears it once the move
  succeeded. A grid-to-grid move keeps it.

### The Buddy's guard on a grid

A grid launch of Claude Code adds the grid's web tools (`--mcp-config` with the grid's web MCP and an allow-tools
argument, `lib/gridLaunch.ts`). A Buddy starts no MCP server (docs/swarms.md, Buddies). So a Buddy's grid launch drops
the web MCP and its allow argument, and keeps every Buddy flag (dontAsk, the guard hook, its own settings only, no
memory files, editing off). A test pins this; it is the main security risk of the change.

### What the server records

`Agent.gridModel` already means "the model on the Swarm's grid this agent runs" (costs and the leaderboard read it).
`buddy.modelResult` sets it when the Buddy lands on a shared model and deletes it when it is back on the subscription.
The request in flight is `Agent.modelRequest { id, gridModel | null, contextWindow?, requestedBy, at }` (the window from the serving reading, for the host's fit check).

### New Buddy thread sessions

A thread session started while the Buddy is on a shared model starts on that model (`gridModel`/`gridName` on its start
request, as a routed Builder's start does today).

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer: ______

1. **Growth.** Two fields on the Buddy's agent record: `modelRequest` (one at a time; deleted by `buddy.modelResult`, or
   by the hourly tidy after 10 minutes with a "didn't answer" line) and `gridModel` (the current shared model; deleted
   when the Buddy goes back to the subscription, and with the agent when the Buddy is removed, its owner leaves or a
   down Buddy is replaced). On the machine: `subscriptionSessionId` on the daemon's registry row (deleted on the way
   home and with the row), and the host's done-requests file (one id per Buddy, the newest kept). One system line per
   switch in the owner's Buddy chat, under that chat's existing retention.
   | Record | create | update | finish | lost / cancel | delete |
   | --- | --- | --- | --- | --- | --- |
   | modelRequest | buddy.model | — | buddy.modelResult | tidy at 10 min | with the agent |
   | gridModel | modelResult ok on a grid | next ok result | modelResult ok home | stays; the bar shows "not served now" | with the agent |
   | subscriptionSessionId | fresh move out | — | move home ok | stays with the row | with the row |
2. **Concurrency.** Each command writes the Swarm state under its existing per-Swarm write; `buddy.model` refuses while a
   `modelRequest` is pending (`BUDDY_SWITCHING`), so one switch runs per Buddy. `buddy.modelResult` must name the
   pending request id. On the machine, retarget already refuses a session mid-turn (`AGENT_BUSY`) and holds the pane's
   terminal control and the reconciler route while it respawns.
3. **Read cost.** The offer list is derived from machine rows the person's read already loads (no new query). It is at
   most the Swarm's machines × 16 models each (the reading's cap), a few KB at 50 machines. `gridModel` and the request add under
   300 bytes to the Buddy's row. The host's transcript tail read is bounded (last 256 KB). Change-feed: the Buddy's
   agent row already changes when its configuration changes.
4. **Scale.** At 10x (500 machines, 500 Buddies) the offer list stays capped per machine and is sent only to its person
   when the Buddy chat's header is read; switches are person-driven (a handful a day). First warning: the size of the
   person's read of the Buddy chat (existing read-size measure).
5. **Compatibility.** An older app never sends `buddy.model` and shows nothing new (it never reads `modelRequest`; `gridModel` already exists on agents). An older host does not
   report the `buddy-model` capability, so the server refuses the switch with "Update Harness on <machine> to switch
   your Buddy's model" (`HOST_OUTDATED`) and never writes a request an old host would ignore. The host and the daemon
   ship in one CLI, so a host reporting `buddyModel` has a daemon that understands `fresh`. Readers of the agent row (roster, Buddy news, closed agents, leaderboard) get
   two optional fields; `closedAgents.ts` strips them as it strips `switchRequest`.
6. **Migration and rollback.** No migration: new optional fields. Deploy order: backend, then CLI, then apps. Rolling
   the backend back leaves `modelRequest` unread and `gridModel` as a plain record on the record (harmless; the Buddy keeps running on
   whatever its pane has, and the pane picker can move it back). Rolling the CLI back: a Buddy left on a grid stays on
   it (its relaunch keeps the grid launch record, as for any pane) until moved home from the pane picker.
7. **Audience.** `buddy.model` is the Buddy's owner's alone (a person, `buddyOf.personId === actor.userId`); the
   Buddy agent cannot send it (not in `BUDDY_COMMANDS`), nor anyone else. `buddy.modelResult` is accepted only from the
   Buddy's own host (actor is that agent) for the pending request id; it is added to `BUDDY_COMMANDS` with that check.
   The offer list goes only to the person's own read; the system lines go only to their Buddy chat. The model a Buddy
   runs on already shows on its roster row (`configuration.model`) like every agent's; nothing new about the Buddy's
   chat leaves it. Known, accepted by the PM's ruling: on a shared model, what the Buddy sends (which can include anything
   its owner reads) reaches the serving machine or API, so the picker names who serves each model before the switch.
8. **Identity.** The Buddy still runs on its owner's own machine, in their own account, as the real Claude Code CLI.
   The grid is reached with that machine's own Swarm-grid sign-in; an API's key stays on its sharer's machine behind the
   grid. Nothing runs as another person.
9. **Failure.** Every refusal (`AGENT_BUSY` mid-turn, model not served, grid unavailable, daemon outdated, respawn
   failed) comes back in `buddy.modelResult` and is written as "Couldn't switch your Buddy: <reason>. It is still on
   <model>." A host that never answers: the tidy expires the request at 10 minutes with "Your Buddy's computer didn't
   answer." A model that stops being served after the switch: the header says "not served now"; the Buddy's own error
   shows in its terminal; Phase 2 adds the automatic fallback.
10. **Platforms.** The picker: Desktop (macOS, Linux, Windows), web and phone, one Flutter screen. The switch runs where
    Buddies run: macOS and Linux (no Buddy on Windows). Tested: Desktop on a Mac, CLI on a Mac and Linux CI.

## Out of scope

- Automatic fallback at the subscription limit (Phase 2).
- Models of grids other than the Swarm's (`kind: shared`), and a Codex Buddy (still refused).
- Choosing an effort or a Claude model (Opus/Sonnet) for the subscription side: "Your subscription" returns to the
  model the Buddy had there.
