# Current behavior audit

Inspected September 28, 2026 on `fix/swarm-prompt-scope`, including the uncommitted
prompt-origin and naming changes. This is source evidence, not proof that every
running daemon uses this build. Live-state evidence is recorded separately.

## What triggers work

1. Account opt-in enables the swarm directory. It reconciles saved membership
   on refresh and a 15-second interval. The poll is daemon work, not a periodic
   model call: [channels.ts](../../../cli/src/teams/channels.ts).
2. Once a swarm has at least two recognized agents, members receive introduction
   notices through the durable mailbox. These notices are real terminal input
   and can start paid model turns. Existing membership receipts prevent sending
   the same introduction repeatedly; joining again creates a new membership:
   [service.ts](../../../cli/src/teams/service.ts), `syncChannel`, `pumpNow`.
3. The introduction gives a roster, commands, and an instruction to discover and
   consult relevant peers autonomously when the task needs help. The requesting
   model decides whether and whom to ask. There is no semantic necessity check:
   [prompts.ts](../../../cli/src/teams/prompts.ts), `introduction`.
4. An explicit advanced CLI consult sends a stronger instruction to read members
   and history and ask a focused question. The current default UI does not expose
   a consult shortcut: `consultPrompt`, [tab-channels.md](../../tab-channels.md).
5. An accepted ask creates a durable exchange. A two-second delivery pump moves
   notices to the addressed member. A separate preflight waits for an idle,
   empty composer and avoids permission dialogs and human drafts. This is a
   useful physical-input safeguard; it is not a judgment about whether the
   recipient should spend time on this request:
   [mailbox.ts](../../../cli/src/teams/mailbox.ts),
   [preflight.ts](../../../cli/src/teams/preflight.ts).
6. A correlated reply normally creates another notice to the asking agent.
   Expired/cancelled exchanges retain late answers without automatic continuation.
   Otherwise the return notice can remain eligible for a day. A new human task
   has no first-class task ID in the exchange schema:
   [model.ts](../../../cli/src/teams/model.ts), `reply`, `sync` in `service.ts`.
7. The CLI wait defaults to 30 seconds and accepts at most 60. Inside that call
   it polls status/inbox roughly every 1.5 seconds; that is process/network work,
   not a model call. On timeout it returns instructions to continue independent
   work or wait again. Reissuing short waits may require additional model
   iterations depending on the native route, but the code alone does not prove
   that every caller does so or quantify the associated token cost:
   [command.ts](../../../cli/src/teams/command.ts), `parseTeamArgs`, `waitForTeamAnswer`.

## What the directory actually knows

`MemberRuntime` can represent name, engine, availability, cwd, and optional branch.
The production `localTeamRuntime` currently returns name, engine, cwd, and runtime
availability; it does not populate branch. Automatically derived roles concatenate
this information. They do not establish a current task, artifact ownership,
knowledge of a decision, specialized access, accepted responsibility, or evidence
that a peer has already solved the question.

Sources: `MemberRuntime` in `model.ts`; `localTeamRuntime` in
[backendSocket.ts](../../../cli/src/backendSocket.ts); `syncChannel` in `service.ts`.

Therefore a “relevant peer” is currently a model inference over weak metadata.
Treating this inference as proof of the right recipient would be unjustified.

## What is enforced

The service checks membership, the recorded prompt's swarm origin, enabled state, exact
recipient identity, self-contact, message sizes, operation identity, and limits.
The present bounds permit eight pending questions per sender, thirty new
questions per minute per team, and a bounded optional parent chain. These are
runaway/retention controls, not a cost-efficient collaboration policy.

A valid request can contain any nonempty question, without stating a blocked
action, local evidence checked, why a peer is needed, why this peer, expected
result, or a stopping rule. A request ID deduplicates transport retries; a fresh
ID can repeat the same question or contact a different peer. Parent IDs are
optional, so chain bounds do not prove that semantic back-and-forth is bounded.

Sources: `QuestionSpec` in `model.ts`; `authorizeTask`, `ask`, `reply` in
`service.ts`; [wire.ts](../../../cli/src/teams/wire.ts).

Owner attribution has a separate limit. The surrounding `backendSocket.ts`
route restricts requests to local or authenticated owner-client connections;
this is not an unauthenticated remote API. Within that route, `wire.ts` derives
`actor.kind = owner` when `memberKey` is absent. `authorizeTask` exempts that actor
from the member's task-scope check, and `ask` records `origin: owner`. The CLI also
supports omitting the member key. Thus a ledger's owner label records this API
role; by itself it does not establish a correlated explicit human instruction.
This is source evidence about attribution, not a demonstrated native bypass or
a claim that an observed handoff was unauthorized. Future agent routes must not
promote missing credentials into owner intent. Explicit owner actions need their
own authenticated origin, with same-user process access kept outside stronger
isolation claims.

The current `Exchange` has one `from` sender. Its cancel operation checks that
sender or the owner actor; there is no collection of separately authorized
consumer tasks. Reading another exchange's status does not make that reader an
active producer need. Future shared requests need an explicit consumer model;
rewriting `from` would lose authorship and cannot establish safe shared authority.

The scope guard reads the session's current accepted-prompt scope, not an immutable
originating invocation. A [source reproduction](reproduce_invocation_scope.mts)
confirms that a command pinned to A is rejected after input from B, while an
older invocation delayed before `context` lookup receives B and can create a B
request. Different accepted inputs inside B are also indistinguishable to that
request. The controlled run used a disposable ledger and no terminal transport;
it does not establish native frequency or deployed behavior.
[Observations and source hashes](invocation-scope-observations.json).

## Existing safeguards worth preserving

- Bound prompt origin controls scope; focus and the most recent roster do not.
- Delivery waits safely and never presses interrupt keys or overwrites drafts.
- Transport retries retain operation identity; uncertain pastes are not repeated.
- Only an explicit, correlated answer counts as an answer.
- Answers do not grant additional authority to publish, deploy, or change work.
- Late answers to cancelled/expired exchanges do not wake the requester.
- Shared history is read-only and does not notify every participant.
- No acknowledgment is required; prompts already discourage reply loops.

Acceptance itself needs stronger evidence than the current hook path provides.
`hookServer.ts` reports `UserPromptSubmit`, and `cli.ts` sends it directly to
`SwarmPromptScopes.started`. Native prompt hooks can subsequently reject the
input. The [submission/acceptance contract](protocol-and-adapters.md#a-submission-hook-is-not-an-acceptance-receipt)
therefore distinguishes a pending candidate from committed owner authority.
This is a source/documentation finding, not a native rejection test performed
against the installed engines.

## Follow-up evidence and remaining gaps

- The later [exchange audit](observed-exchanges.md) contains eight paraphrased
  local cases and a bounded native-usage follow-up. Their conditional judgments
  and observed usage do not establish a general waste rate or causal savings.
- Whether answers changed work or only added reassurance; ledger text alone may
  be insufficient to prove this.
- Exact native-engine seams for passive context, task identity, recipient
  scheduling, and a continuation that expires with the requesting task. The
  [adapter investigation](protocol-and-adapters.md#adapter-evidence-and-capability-matrix)
  records candidate capabilities and unverified native gates.

The earlier three-engine live test proved transport, exact peer-held fact
retrieval, and continuation in a disposable fixture. It instructed the requests
explicitly and does not establish good autonomous contact decisions:
[live verification](../../agent-teams-live-verification.md).
