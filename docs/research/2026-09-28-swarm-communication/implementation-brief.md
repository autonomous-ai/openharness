# First implementation: fewer, better exchanges

Status: design recommendation, not implemented. This is the short implementation
brief for the cross-provider policy; the other files retain its evidence and
detailed contracts.

## User-visible behavior

The developer enables Swarm collaboration once and puts harnesses in a swarm.
Each keeps working on its owner's task. Codex can consult Claude Code or Grok
when one of them holds a required input. There is no setup conversation, default
coordinator, human role form, or routine review round.

Most collaboration should be reading a previously published decision or result.
When a question is needed, the Swarm conversation shows one exchange: the missing
input, selected harness, selection evidence, and answer. Show use or resolution
only when the requester actually reports it; delivery alone is not use.
Routine directory updates do not become chat. An unresolved dependency remains
visible as unresolved; silence must not look like successful completion.

The first implementation supports brief questions and explicit existing human
handoffs. Autonomous new work assignment follows later, once acceptance and
cancellation have been verified. Keep the account-level experimental setting
off by default.

The [small agent contract](agent-contract.md) contains the candidate instructions
and tool inputs. Host-managed identity belongs in the adapter/service, not a
long form the model repeats for every question. Independent work needs no swarm
call; a published one-line fact should not require a second fetch or author turn.

## Make discovery useful without a second workforce

Create a small record for qualifying shared work or context, with additional
result records only when needed. The agent maintains it during its existing work.
The daemon stores and searches it; it does not hire another model to summarize
every conversation.

1. **When shared work begins:** publish the objective, exact interface/resource,
   and intended output. A task changing a shared contract, operating a shared
   environment, or holding a relevant user decision qualifies. A trivial answer,
   private scratch calculation, or every file read does not. Publication is
   expected even when the author has no question for another peer.
2. **When the useful fact changes:** publish the decision, artifact version, or
   result. If the fact is short, publish the fact itself; advertising that one
   knows an answer and making every consumer ask for it wastes work.
3. **When responsibility changes:** release, complete, or replace the claim.
   New human work marks an unreaffirmed active claim as needing revalidation.
   A process heartbeat does not make an obsolete claim current.

Bind the claim to the accepted task and originating swarm, and reuse unchanged
records across native turn continuations. Coalesce publication with an already
necessary task-binding or result operation where possible. Do not require a
separate tool call just to restate the same record at every turn.

The update response can also include bounded existing facts and claims for the
same shared subject. This exposes relevant evidence during already-required
work instead of adding a directory scan to every turn. A compatible peer claim
does not require a conversation; only a concrete unresolved dependency or
conflict does. Return provenance and incomplete/missing states honestly. This
read does not reserve edits, guarantee discovery of concurrent remote claims,
or wake their authors. See the [combined update/read contract](protocol-and-adapters.md#return-relevant-evidence-with-a-shared-work-update).

Initially store a short objective, a bounded list of exact subjects, record kind,
source task, version, and accessible references. Do not design a company-wide
ontology or vector service first. A title or native plan can suggest candidate
subjects, but it is not silently upgraded into a current ownership claim.
`cli/src/lib/sessionTitle.ts` currently obtains useful names; those names remain
hints. Shared provider plans are not a substitute for scoped publication.

Give records explicit validity. Preserve results for their immutable revisions;
suspend input-bound current commitments when their author accepts new human
work. A historical decision and an assurance that it is still current are
different assertions. This avoids both stale reuse and unnecessary confirmation
questions about facts that remain valid for the consumer's pinned revision.

### Cold start is explicit

Enabling the feature does not wake idle harnesses to fill in their profiles.
An existing harness publishes when it next does qualifying authorized work.
Until then, its presence/title is visible as a hint, with no invented ownership.
Completed published work can remain a valid context source even when its author
has a different current task. Current editing authority and historical knowledge
must remain separate.

If a necessary input has no established source, discovery says so. The requester
can inspect another authoritative artifact or report the missing decision. It
must not spend several peers' attention trying to discover who might know.
An explicit human direction to ask a named harness remains usable without
requiring that harness to fill out a profile first.

This favors routing precision at cold start and can miss unrecorded knowledge.
That is a measurable tradeoff, not a solved inference problem. Compare selective
publication against publishing once for every substantial task during the pilot;
include the added tool/context costs before choosing broader publication.

### Start with a small, transparent search

Search scoped records when a concrete dependency arises. Prefer exact repository,
resource/interface, revision, and result references where known. Text matching
can return candidates, but its ranking is not ownership evidence. Put the fact
or claimed subject and its provenance before the author's title/provider.

Repository location is provenance and a search constraint when the dependency
requires that repository; it is not the swarm's collaboration boundary. A client
and its API producer may live in different repositories or on different machines.
Search the required contract/resource across the authorized swarm, using the
producer identity and version when known. Do not silently restrict discovery to
the requester's cwd, or treat a same-named local file as the required contract.
A location match is not a substitute for evidence of the needed subject.

For a small swarm, bounded inspection of a few relevant records is preferable
to adding an LLM router or vector service before proving a need. A broader
read-only lookup can recover a terminology mismatch without waking peers; it
must still be scoped and bounded. Empty search results describe the search's
knowledge, not every participant's private knowledge.

A `not owner` or `unknown` reply should annotate that exact dependency and source
version. It does not make the entire harness incompetent or invalidate all its
other claims. A verified referral can identify a next candidate; a failed ask
alone is no reason to try each remaining peer in turn.

## Respect the recipient's task

An ask requests an answer already in context or obtainable through a small
bounded lookup. It does not implicitly commission research. A recipient that
would need substantial investigation returns `requires work`, `unknown`, or
`declined`; it does not silently begin an unrelated project.

A closed question need not mean completed work. `Unknown`, a declined
contribution, a confirmed absence of a prior choice, and a reference to a pending
result have different next steps. Keep the missing need visible. New evidence
that the source now holds the required fact can justify reassessment within the
same bounded need; a heartbeat or another turn cannot. Read a published answer
first. See [closed-question outcomes](protocol-and-adapters.md#after-an-answer-or-a-closed-question).

The daemon queues an admitted ask until the provider supports a safe delivery
point. The requester sees whether it is queued, consumed, answered, or unavailable
without sending another message. A busy terminal is not interrupted just because
another agent labeled a request urgent. The requester can continue independent
work or explicitly wait for the required result.

When the recipient sees a request during its own work, it may answer a known
fact briefly at a natural boundary. It retains responsibility for its owner's
task. If answering would disrupt a committed step or miss the request's useful
deadline, it can decline. An unavailable owner is an honest blocked dependency;
a loosely related replacement is not automatically a valid source.

One active contribution slot is insufficient by itself: an endless sequence of
different necessary questions can still displace the recipient's own fix. After
a brief contribution, yield to ready owner work before another automatic question.
Native idle is not proof that the owner is finished. Verify that the adapter can
distinguish owner resumption from another peer-only turn, and measure the owner's
actual delay. Batching can be evaluated later under the same priority rule.

Return the requester's awaited result before unrelated inbox work. The current
`waitForTeamAnswer` in `cli/src/teams/command.ts` checks incoming questions before
testing whether the awaited exchange has already been answered, and instructs
the agent to answer incoming questions first. That can delay its own newly
unblocked task. Remove the unconditional priority rule in the proposed policy.

A true reciprocal dependency needs an explicit ordering/decision resolution.
Allow each peer to answer a fact it already has; do not recursively delegate
another investigation to break the cycle. Bounded contribution concurrency and
queue limits are mechanical backstops. A hard token limit is not promised for
an existing provider turn that Harness cannot meter or stop independently.

When a blocked step needs several peer outcomes, use one owner wait over that
set. `Any` returns when a result enables useful work; `all` waits for the required
answers but surfaces clarification, failure, or an explicitly watched mutable
invalidation promptly. Return ready relevant outcomes together and consume one
continuation. Remaining answers need a new explicit wait to start another owner
turn. A prior fact read alone never creates an idle change subscription.

## Use artifacts before adding a file-transfer system

The first version can read published text facts, prior exchange results, and
immutable repository references through existing authorized access. A path on
another machine is a reference, not an accessible local file. Include repository
and machine identity, revision or content hash, and the relevant path.

If an exact required snapshot is inaccessible, ask its evidenced author for the
bounded result or excerpt. Do not read a same-named local file and assume it is
the peer's version. Do not automatically check out a branch, merge work, or claim
that tests on one revision verify another. Larger immutable artifact storage can
be added behind the same read contract after this path demonstrates value.

## Fix lifetime handling before making delivery faster

Maintain distinct identities for a harness, native session, owner task, accepted
human input, and peer exchange. Compaction and a verified automatic continuation
are not new human requests. Peer replies are not user steering. Unknown input
provenance must still fail closed.

Submission is not yet acceptance: a native prompt hook can run before another
hook blocks that input. Track a correlated pending transition and establish its
outcome before granting its swarm authority. A rejection or timeout cannot be
used to restore obsolete permissions. For an accepted status follow-up that
continues the same work, reuse selected dependencies and reaffirm unchanged
current claims by reference during existing work; never resend the questions or
refresh every immutable fact. These authority updates still have a measurable
tool/context cost.

A synthetic reproduction against current worktree code confirms a gap:

- A prepared `/goal` input binds Codex to its originating swarm.
- `CodexNormalizer.goalTurn` then emits `Continuing goal: …` on the next automatic
  continuation.
- `cli.ts` sends that event to `SwarmPromptScopes.started`, which cannot match a
  prepared input and clears the scope.

Run [reproduce_goal_scope.mts](reproduce_goal_scope.mts) for the observations.
This is an in-process source reproduction, not an installed-daemon test. It
demonstrates lost collaboration availability, not a cross-swarm send.

The repair needs trusted continuation provenance through normalization and a
binding to the existing task. Do not recognize continuation by a user-copyable
text prefix, or treat identical goal wording as a durable identity. Verify the
sequence with intervening human steering, a genuinely new task in another swarm,
goal replacement, session rotation, compaction, and daemon restart. When the
adapter cannot establish the relationship, retain an explicit unknown state.

A second [source reproduction](reproduce_invocation_scope.mts) isolates the
delayed-invocation problem with synthetic inputs and a disposable service ledger:

- A command already pinned to swarm A is rejected after accepted input from B.
- An older invocation delayed before `context` lookup receives B's command and
  can create a B-scoped request, because its original input is not represented.
- A command from an earlier input in B also remains admissible after different
  human work is accepted in B; matching the swarm does not distinguish tasks.

The [recorded observations](invocation-scope-observations.json) include source
hashes. No transport was attached and no message was delivered. This proves an
API-level inability to distinguish these simulated origins, not a measured native
occurrence or a deployed cross-swarm send. Pin task/input authority before a
command can be delayed; do not repair it by resolving the latest context later.

## Small release slices

| Slice | Deliverable | Required evidence |
| --- | --- | --- |
| 1 | Quiet feature discovery, concise policy, no introductions or default reviews. | Enabling/joining/idle causes no model turn on each supported adapter; existing sessions have an honest activation path. |
| 2 | Input/task identity and one-shot continuation, clear exchange outcomes, owner-task priority. | Trusted continuation retains origin; unknown input does not; stale results never resume a different task; uncertain dispatch is not replayed. |
| 3 | Minimal scoped work/context/result records, evidence-bearing asks, existing-result reuse. | A cold/stale directory abstains; ready results avoid waking authors; all directed provider pairings route to exact harness identities. |
| 4 | Exact-result subscriptions and supported passive delivery; active request sharing only after its separate gates pass. | Idle is not a successful artifact. Passive watchers do not keep canceled work alive; compatible admitted consumers can share production without replay or authority transfer. |
| Later | Accepted bounded autonomous work and richer artifact storage. | Acceptance, effects, cancellation, permissions, version validation, and recipient cost are observable. |

Quiet setup includes migration: cancel queued, unconsumed membership introductions
in the ledger and destination mailbox, and reconcile uncertain prior delivery.
Do not compensate with another teaching/apology turn. Existing sessions receive
the new small policy at a verified natural boundary; record its version without
claiming that delivery alone proves the agent follows it. History remains readable.

These can be reviewed separately. Do not launch a stronger autonomous asking
policy with quiet discovery missing on one provider or task identity reduced to
one terminal turn. Runtime changes stay in `cli/src/teams` and narrow adapter/
input seams; the existing Swarm conversation handles inspection.
The [conformance plan](conformance-plan.md) makes the acceptance conditions
concrete; it does not claim those future adapter tests have already passed.

## What must earn its cost

Compare complete-task usage and elapsed time across all participants. The new
system only saves usage when avoided conversations and reused results outweigh
publishing, discovery, extra context, and remaining requests. Passive context
still costs tokens when the model reads it; a short response in a long session
can still have substantial input cost. Use provider usage, including cached
input where reported, rather than converting character counts to money.

The pilot must also preserve task quality and dependency recall. Measure the
recipient owner's delay separately from the requester's speedup. The criteria
and currently unrun model evaluation are in [alternatives-and-evaluation.md](alternatives-and-evaluation.md).

Keep the small bootstrap policy and tool schemas stable. Avoid embedding a live
roster, timestamps, or changing work summaries in those definitions. Deliver
dynamic facts only when the current task needs them, and measure how each
adapter places that context. API caching behavior depends on matching prefixes
and configured breakpoints; stable content alone does not guarantee a cache hit.
This is an integration recommendation, not a claim about the installed CLIs'
cache configuration. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

The [native usage follow-up](observed-exchanges.md#native-usage-follow-up) found
large input-context costs in some short notice windows, including two membership
introductions. It does not identify the cause of their cache misses or quantify
the marginal savings this proposal would achieve.
