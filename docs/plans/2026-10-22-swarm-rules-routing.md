# Swarm rules replace Jev in routing

> Replaced by [2026-10-30-project-instructions-design.md](2026-10-30-project-instructions-design.md): the instruction document and agents' direct messages
> replace what this describes. Kept as history; do not build from it.

Date: 2026-10-22. Status: approved by the Lead on 2026-10-22 and implemented.

## Why

On 2026-10-22 the Lead overrode Jev's pick about half the time: Haiku, a stopping agent on an offline
machine, low effort. Jev does not know the owner's rules, so asking it is a step the Lead then undoes.
The rules also lived only in the Lead's head. They move into the Swarm. The system enforces the hard
ones and ranks candidates by the soft ones, and routing stops asking a hosted model.

## Rules

A rule is stored in the Swarm's state (`SuperTabState.rules`, at most 50 rules):

```ts
interface Rule {
  id: string                    // the operation id of the command that added it
  rule:
    | { kind: 'forbidModel'; engine?: 'claude' | 'codex'; model: string }   // hard
    | { kind: 'machines'; machineIds: string[] }                           // hard
    | { kind: 'minEffort'; engine?: 'claude' | 'codex'; effort: Effort }   // hard
    | { kind: 'preferEngine'; taskKind: string | null; engine: 'claude' | 'codex' } // soft
    | { kind: 'preferIdle' }                                               // soft
    | { kind: 'noGridFirst' }                                              // soft (2026-10-27)
  text: string                  // the owner's words, 1–200 characters, e.g. "No Haiku, ever."
  askedBy: string               // the owner's user id
  askedIn: { conversationId: string; messageId: string } | null   // the owner's message, when a Lead relays it
  addedBy: string               // actorKey of whoever sent the command (owner or Lead)
  createdAt: string
}
type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
```

The meaning of each rule:

- **forbidModel** (hard): no agent may run a model whose id contains `model`, compared case-insensitively.
  This catches the short name and the full id (`haiku` matches `haiku` and `claude-haiku-4-5`). A rule
  naming a full id also matches a start that asks for that family's alias (`claude-haiku-4-5` matches
  `haiku`). A model of `default` matches nothing, because the actual model is not known.
- **machines** (hard): agents run only on the listed machines. There is at most one such rule; adding
  another replaces it.
- **minEffort** (hard): the effort is at least `effort`, in the order
  minimal < low < medium < high < xhigh < max. An unknown effort (`default`, `auto`) does not meet it.
  A member's `auto` is first resolved from its start record, as `withLaunchEffort` does today. A
  new-agent candidate whose policy row says `default` or `auto` is not dropped: it is lifted to the
  minimum, and the start it suggests names that effort.
- **preferEngine** (soft): for tasks of `taskKind`, or for every task when it is null, candidates on
  `engine` rank first. A task's kind is a new optional `kind` word in the route JSON
  (`"kind":"ui"`). A review group's kind is always `review`.
- **preferIdle** (soft): an idle member ranks before a new agent. Among new agents, a machine with fewer
  running agents ranks first.
- **noGridFirst** (soft, 2026-10-27): turns off grid models first. By default a low-difficulty, low-risk
  task that is not a review ranks models served on the Swarm's grid (Kimi K3, DeepSeek) before subscription
  candidates, right after the preferred engine (roadmap, Dec: about 30% of work on cheaper models). The owner
  opts out with this rule.

Routing already removes an offline machine, a stopping agent (it is busy or refused) and an exhausted
quota. Those stay as they are and are not rules.

## Who changes rules

Two new commands go through the existing `command` path:

```json
{"type":"rule.set","rule":{"kind":"forbidModel","model":"haiku"},"text":"No Haiku.","askedIn":{"conversationId":"…","messageId":"…"}}
{"type":"rule.remove","ruleId":"…","askedIn":{"conversationId":"…","messageId":"…"}}
```

- A person may change rules only if they are the Swarm owner, and they omit `askedIn`.
- An agent may change rules only if it is the tab's Lead (the `controls(state, actor)` check that
  `tab.rename` uses), and it must pass `askedIn`. The backend reads that message, the way it reads
  `replyTo` for `message.send`. The message must meet three conditions:
  - its author is the owner, as a person;
  - it is a plain chat message: no system row, such as the owner's own "Rule added" row or a warning;
  - it is at most a day old.

  Otherwise the change is refused with "Only the Swarm owner sets rules; quote a chat message the owner
  wrote in the last day asking for this change." This was added in the review of #1586. One owner
  message may ask for several rules, so the Lead may quote it for each of them.
- Everyone else is refused with `OWNER_REQUIRED`: "Only the Swarm owner, or the Lead passing on the
  owner's request, changes rules."
- Each change posts one row in the lead group ("Rule added: No Haiku."), so the change can be seen
  without any UI. The row has no email in it; who asked is kept on the rule.
- **Listing:** the rules are part of the tab state that `status` already returns, with each rule's
  `text`. When asked, the Lead lists them in the owner's own words. No new command is added.

## Backend enforcement (hard rules)

The check is one pure function, `broken(rules, { machineId, engine, model, effort })`, in
`backend/src/superTabs/rules.ts`. It returns the sentence for the first broken rule, or null. The CLI
has the same check (`breaks` in `route.ts`), so a pick it offers is never refused later. It is called by:

- **agent.start**, with the request's machine, engine, model and effort;
- **work.assign**, with the worker's machine and configuration (effort resolved from its start record
  when it reports `auto`);
- **conversation.agent** when an agent joins or leads a group (leaving is never checked);
- **agent.startDispatch**, so a start recorded before a rule was added is not launched past it. An agent's
  dispatch is refused, and the start stays unlaunched;
- **route.record**, with the pick (a new-agent candidate's fields, or the member's current
  configuration). Other candidates in the record are not checked, so an older CLI that lists a
  forbidden candidate can still record a decision when its pick is allowed.

An **agent** that breaks a rule is refused with `RULE_BROKEN` and one plain sentence, for example:
`The owner's rule "No Haiku." rules out Claude haiku. Route again.` An `overrideReason` does not get
past a hard rule.

A **person** is not blocked. The command goes through, its result carries `warnings`, and the group gets
one row (a rule row, with a name rather than an email): `ken started Builder anyway. The owner's rule
"No Haiku." rules out Claude haiku.` A person's `route.override` to a candidate that breaks a rule works
the same way.

The person's choice carries through. When the Lead then starts or assigns exactly the candidate the person
chose, it is let through with the same warning; anything else the Lead does is still refused. The same
applies to dispatching such a start.

Agents that were already running when a rule was added keep running. Routing just stops offering them,
and new assignments to them are refused.

Soft rules are not enforced by the backend.

## CLI routing (`cli/src/superTabs/route.ts`, `routeCommand.ts`, `service.ts`)

`choose()` goes through these steps:

1. **Refusals** (unchanged).
2. **Hard rules**: a candidate that breaks a rule moves to `excluded` with the reason
   `Breaks the owner's rule: …`. If nobody is left, the result is `NO_CANDIDATE`, and the excluded
   list says why.
3. **Quality floor, strength for hard tasks, quota fit groups** (unchanged).
4. **Fixed order**: preferred engine for the kind (soft), then idle member before new agent (soft), then
   today's order (effective cost, quality, room on the tightest window, member in the same repository,
   title).

`decide()` keeps the first candidate. The verdict is `only` when there is one candidate and `order`
otherwise, with no `fallback`.

Removed:

- `routeJev` (the daemon action) and the `jev` option in `service.ts`;
- the group-messages read in `routeHistory`, which only Jev used;
- `jevQuestion`, `contextSize`, `INSTRUCTIONS`, `folderText`, `JevInput`, the `jevPick` import and the
  record's `context` field;
- `scrub`, which existed so that nothing identifying reached the hosted model. Labels now go only to
  the Swarm's own log, which its members can already read.

Kept:

- the decision log (`route.record`), and labels and fit in it;
- the commitments read from the log;
- the rule from #1555 that an agent's start or assign needs a routeDecisionId;
- the 30-per-hour limit;
- `jevClient`, `jevPick` and the backend `jevRoute`, which the voice router, recaps and devices
  still use.

The route reads its rules from the tab state that `routeContext` already returns. No new daemon action
or backend read is needed.

CLI help (`HELP` in `service.ts`):

- `route` gains the optional `kind` and the sentence "Candidates that break the owner's hard rules
  are left out; soft rules rank."
- `command` gains `rule.set` and `rule.remove`, including that `askedIn` is the owner's message.
- `status` notes that `rules` lists them.

## Mixing versions

| | Old backend (no rules) | New backend |
|---|---|---|
| **Old CLI** | today | It still asks Jev. The record is refused only when the pick breaks a hard rule, with a sentence asking the Lead to update or route again. Start and assign are enforced. |
| **New CLI** | No rules in the state, so routing is today's minus Jev. `rule.set` and `rule.remove` are refused by the strict schema, and the CLI reports "This Swarm's server does not support rules yet." | full |

The record keeps today's schema. `via: 'jev'` stays valid in it for old CLIs, and nothing new is added to
it, so the CLI's existing v1 retry is unchanged. A new CLI with a daemon that has not restarted still
works, because it no longer calls `routeJev`.

With no rules, the result is today's order, minus Jev's three-second call and minus the overrides Jev
caused.

## Tests

The tests are unit tests only. They never touch port 18473, `~/.harness`, `~/.claude`, `~/.codex` or
real tmux.

- `backend/src/superTabs/commands.test.ts`:
  - set, list and remove by the owner;
  - set and remove by the Lead with an owner message;
  - refused for the Lead without one, for the Lead quoting a non-owner message, for a collaborator, and
    for a non-Lead agent;
  - `agent.start`, `work.assign` and `route.record` refused for an agent that breaks each hard rule
    kind;
  - a person passes with a warning row;
  - `overrideReason` does not bypass a rule;
  - with no rules, today's behaviour (the existing suite is unchanged).
- `backend/integration/superTabs.test.ts`: on a real database, the Lead records a rule only by quoting a
  message the owner wrote in the tab.
- `route.spec.ts`:
  - each hard rule moves candidates to excluded;
  - a lifted effort for a `default` row under minEffort;
  - each soft rule changes only the order, never the set;
  - with no rules, the same order as today.
- `routeCommand.spec.ts` and `service.spec.ts`:
  - no Jev call is made (the injected `request` never sees `routeJev`, and service options have no
    `jev`);
  - the rules come from the tab state;
  - a hard rule leaves only allowed picks.

Commands, recorded in the PR:

- `cd backend && npm run typecheck && npx vitest run src/superTabs src/routes/superTabs && npm run test:super-tabs`
- `cd cli && npm run typecheck && npx vitest run src/superTabs src/lib/routeDecide src/lib/jev src/architecture.spec.ts && npm run test:super-tabs`
  (`test:super-tabs` holds `route.ts` and `routeCommand.ts` at 100%). No `src/core` or `src/services` file changes,
  so `test:core` does not apply.

## Lead skill wording (proposed, not applied)

> Routing follows the owner's rules. When the owner states a lasting rule in chat ("never Haiku",
> "only these machines", "at least high effort", "prefer Codex for UI", "reuse idle agents"),
> record it with `rule.set` and quote the owner's message in `askedIn`. Remove it with `rule.remove`
> when asked. When asked what the rules are, read `rules` in `status` and answer in the owner's
> words. The backend refuses starts and assignments that break a hard rule, so route again
> instead of overriding.

## Open questions for the Lead

1. **Lifting a `default`/`auto` effort to the minimum** instead of dropping the candidate. This keeps
   Codex's `default` row usable under "at least high". Proposed: lift.
2. **Recording `kind`.** It is not recorded in the decision log, which keeps the record schema
   unchanged. Proposed: not recorded.
