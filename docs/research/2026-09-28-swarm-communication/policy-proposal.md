# Proposed policy for selective swarm communication

Status: design proposal, not running behavior. Applies equally to supported
Codex, Claude Code, Grok, and other harnesses. The user enables collaboration
once; harnesses in the originating swarm are eligible peers. Eligibility alone
does not justify contact.

## The decision

Keep independent work as the default. Contact one peer when a concrete part of
the task depends on something that peer is evidenced to hold, own, or be able
to do. Read an existing result first. Send the smallest request that resolves
the dependency. A final reply ends the question; any unmet need stays visible.

Do not create a team-planning ceremony, a default coordinator, routine meetings,
introductions, status exchanges, or automatic peer review. Opening a pane,
joining a swarm, becoming idle, and noticing a capable peer do not themselves
start communication.

## What qualifies

| Situation | Correct first action | When contact is justified |
| --- | --- | --- |
| The answer is in code, configuration, a log, or an accessible published result | Read it locally. | A required fact remains absent and a particular peer has it. |
| A peer received a relevant user decision in its conversation | Read a published decision if available. | That recorded context holder is the remaining source; ask for the exact decision. |
| A peer is producing a required artifact | Inspect its published state and exact version. | Subscribe to that artifact; ask only if a necessary contract is missing. |
| Two tasks will change the same interface/resource incompatibly | Read current work claims and the interface contract. | Resolve the specific incompatible decision with the current owner before the dependent change. |
| A required operation needs another machine/device/environment | Inspect existing results and capability records. | The exact peer has the required environment and the operation is within both tasks' authority. |
| The user or project requires independent verification | Check the requirement and select a qualified verifier. | Perform that bounded verification. Do not manufacture a review requirement. |
| A produced change invalidates a peer's registered dependency | Publish the new version and invalidation. | Surface it during the affected task's current work, or through an explicit still-valid wait for that change; a prior read grants no automatic idle wake. |
| Another model might have a useful opinion | Continue independently. | General capability or potential usefulness alone is insufficient. |

“Local first” does not mean exhaustive searching before a two-sentence answer
from its known author. Make a bounded check of the obvious authoritative source.
When a peer demonstrably already did expensive work and its result is absent,
ask for that result instead of recreating it. That requires evidence of the work,
not a guess that another agent might know more.

The key counterfactual is: **What specific action would be wrong, blocked,
duplicated, or needlessly reconstructed without this exchange?** If the answer
is just “it might improve confidence,” do not send it.

## The gate before a request

The agent supplies four short facts, usually in one tool call:

1. A source reference identifying the evidenced recipient.
2. The exact missing fact or result.
3. The dependent action that needs it.
4. What obvious authoritative source was checked, or why it cannot supply it.

Add a revision, environment, or useful deadline when it materially constrains
the answer; derive existing constraints from the source record. Do not require
invented deadlines or a long justification. The [small agent contract](agent-contract.md)
shows the corresponding four-field ask.

The daemon checks the originating task capability, swarm memberships, peer
identity/generation, evidence version, request state, duplicate dependency,
expiry, and supported delivery capabilities. It returns an existing answer,
subscription, or outstanding request when one already satisfies the same need.
Only a new admitted dependency creates an inbound peer request.

Fields are not a proof of necessity. A model can write a plausible justification
for an unnecessary message. Semantic correctness remains a model responsibility
and an evaluation target. Do not hide that limitation behind a numeric
confidence score or an extra model that approves every message.

### Ask for the smallest sufficient answer

A necessary contact can still contain unnecessary obligations. If only the
selected physical unit is missing, ask for that unit. Do not append requests
to restate documented build steps, review the whole plan, or report unrelated
progress. A real dependency in the first sentence does not justify the rest.

Conversely, one dependency can require several facts from the same evidenced
source. If both the unit and calibration choice are missing from the same user
discussion, request both in one bounded exchange. "One question" means one
coherent missing input, not one question mark or one field per model turn.
Include the version and context needed to answer correctly; arbitrary word
limits must not remove material constraints.

The recipient can supply the needed known facts without accepting appended
optional work. When an omitted check could make the answer misleading, state
briefly what was and was not established. A factual reply is not evidence that
an extra review or investigation happened. Do not open a second conversation
just to reject irrelevant additions.

## Finding the right peer

Separate three kinds of evidence in discovery results:

- **Current responsibility:** a user assignment or authenticated work claim
  tied to an active task and an exact artifact, interface, device, or operation.
- **Known source:** an identified author of a relevant decision/result, with
  its source task and version. A finished task can remain a valid information
  source even after its active work claim ends.
- **Hints:** session title, engine, directory, branch, recent edits, or general
  capability. These can narrow a read; they do not by themselves prove who has
  the answer or who still owns the work.

Discovery should return the reason each candidate matches and the underlying
record, not just a similarity score. Strong matches may resolve to an artifact
with no live peer needed. If there is no evidenced recipient, return that fact;
do not choose the nearest title or broadcast the question. If two records
conflict, inspect the records before asking either author. For an unresolved user
decision, follow the owner's instructions: use already-authorized judgment or a
default when appropriate, and seek user direction when the task requires it.
A peer must not invent a past approval or manufacture a new review requirement.

The swarm defines eligible participants; the dependency defines which resource
or contract matters. A correct producer may work in another repository. Use
repository/commit identity where it constrains the fact, not a blanket same-cwd
filter. A matching path or interface nickname in a different product is not the
same source, while a documented cross-repository contract can be an exact match.

Evidence can identify more than one legitimate source. Choose one with the
required context/version and the least disruption to its owner's work; do not
manufacture a uniqueness requirement or ask all of them. Availability is useful
after qualification, not proof of qualification. A matching, readable result
still takes precedence over asking any of its knowledgeable authors.

Authenticated publication establishes who made a claim, not that every statement
is true. Keep the source and observed result distinct from an agent's interpretation.
A signed message or an artifact hash does not prove a test passed or a user
approved a decision. Validate the evidence appropriate to the dependent action.

The directory cannot reveal unrecorded knowledge. Reliable discovery therefore
needs small published work/context records. Perfect routing from names alone
is impossible; the pilot must measure missed dependencies as well as bad asks.

`No established source` means the directory lacks evidence. It must not be
displayed or interpreted as `Nobody in this swarm knows`. The unresolved need
remains available to the owner task; rejection of an unfounded ask does not
silently mark that need satisfied.

## Keeping records current during ordinary work

The daemon already observes process/session identity, workspace, and activity.
Use those observations for liveness and provenance. They are not proof of task
completion or semantic ownership. Add immutable commit/artifact references when
available, avoiding a full transcript index as the default discovery source.

During an existing authorized turn, an agent can publish or update one concise
work claim when it takes responsibility for a shared interface/resource. It can
publish a decision or result when it produces one. This is a small tool action,
not a separate background LLM summarizer or a manual form for the user.
Publish qualifying shared work even when the author has no outgoing question;
otherwise a directory populated only by requesters cannot find quiet experts.
Publish a short known answer directly rather than only advertising that it exists.

Make publishing selective: private scratch work and arbitrary file reads do not
need announcements. Cache stable facts. A process heartbeat updates liveness;
it must not renew an old ownership claim's meaning. New accepted human input suspends
unreaffirmed active claims. Explicit completion/release closes responsibility;
an idle terminal alone does not. Preserve completed results as historical
sources with their original versions.

Keep a historical fact distinct from a claim that it is still current. A test
result or decision pinned to an immutable revision can remain useful after its
author changes tasks. A mutable current policy is input-bound and needs
reaffirmation when that authority changes. Do not manufacture confirmation asks
for pinned facts, or select the latest timestamp as the winner between conflicting
authors. The [record validity contract](protocol-and-adapters.md#historical-evidence-versus-a-current-assertion)
defines these different lifetimes.

Claims are coordination records, not filesystem locks. They do not authorize
overwriting someone else's edits. Unpublished or stale claims reduce discovery
quality and must show as unknown; the system must never pretend that absence of
a claim proves absence of concurrent work.

Existing idle sessions remain unprofiled until their next qualifying authorized
turn. Do not wake them to improve discovery. The [implementation brief](implementation-brief.md)
specifies the cold-start tradeoff, publication triggers, and maintenance-cost
comparison; an unrecorded private fact cannot be reliably routed from a title.

## Three operations, one shared protocol

**Read:** Fetch a work record, decision, or result within the authorized swarm.
This does not enqueue terminal input. It returns provenance, version, and known
freshness limits. Fetching a reference does not check out a branch or merge code.

**Ask:** Request one fact or decision needed for the current task. The recipient
answers from its relevant context or a small bounded lookup. If answering would
require a new investigation, it says so instead of silently taking on that work.
Valid responses include an answer, not known, not the owner, declined, or a
necessary clarification. An answer can supply an existing production's exact
result handle and current state without claiming that its result is ready. A
negative answer can resolve the question without satisfying the original task
dependency. New evidence that addresses the earlier failure can justify
reassessment; availability or another model turn alone cannot. Read any newly
published answer first and retain the original need's lifetime/contact allowance.

**Request work:** Propose a necessary bounded operation suited to an evidenced
peer's particular capability or current responsibility.
The recipient explicitly accepts or declines through the protocol. Acceptance
records the output, limits, and existing authority; delivery alone is not
acceptance. The recipient retains control of its own task priorities. Long work
publishes progress state/artifacts; it does not generate conversational status
pings. No peer request expands either session's permissions or bypasses a denial.

The first pilot should emphasize reads and brief asks. Add autonomous work
requests only when acceptance, cancellation, and result validation are working.
Explicit human handoffs remain a distinct supported case, not evidence that all
autonomous delegation is justified.

## Timing and continuation

Ask early for a known dependency of committed work, so the recipient can answer
at a natural boundary while independent work continues. Do not wait until every
other action is blocked merely to prove necessity.

Keep that distinct from speculative prefetch. If an available, bounded local
check determines whether a peer-only fact is needed at all, perform the check
first. For example, diagnose whether a failing export needs a parser fix or a
change to its user-selected delimiter policy. The context holder is a qualified
source for that policy, but its existence does not justify asking before the
policy branch is established. A later result showing that the fact was needed
does not retroactively justify skipping the cheap deciding check.

Once a current dependency is established, a later task change or new publication
can remove it without making the original decision wrong. Revalidate at delivery
and retain the evidence available at each point. A useful deadline constrains
queueing; it does not create missing authority, source qualification, or a reason
to interrupt another owner's work.

- Joining or leaving updates the directory without starting model work.
- An admitted ask can reach a recipient at a supported safe point. Human drafts,
  approvals, and active tools retain the protections in today's input writer.
- Prefer delivery as scoped peer context within an existing turn where the
  adapter supports it. An idle recipient may run a short response only for an
  admitted request, never a roster refresh or greeting.
- The request creates a contribution tied to its exchange. It does not change
  the swarm origin or permissions of the recipient's unrelated owner task.
- A response is stored even if the requester no longer needs it. Automatic
  continuation requires an outstanding dependency and a still-valid grant for
  that task. A new human input revokes the old automatic grant immediately.
- The agent grants continuation when it actually needs to wait for the result.
  Asking and continuing independent work does not create an unlimited future
  wake-up permission. An already available result returns inline without a wake.
- Several dependencies can belong to one blocked step. Wait for any useful result
  or all required answers as appropriate, with one owner continuation for that
  wait. Clarifications/failures break an all-results wait promptly; separate
  answers must not create redundant owner turns.
- If a new input merely steers the same task, the agent can adopt the unresolved
  dependency during that already-running turn. Reusing it does not resend it.
  Keep the existing request identity and lifetime; reaffirm unchanged current
  claims by reference where needed. Immutable results need no status refresh.
- A task waiting for an artifact gets one result/failure event. An idle event is
  not proof the artifact exists, passed verification, or matches the revision.
- Membership removal, pause, cancellation, expiry, and session replacement stop
  future automatic delivery. Already observed effects cannot be unsent; late
  results remain inert records with an honest status.

Do not equate a human task with one model turn. Do not silently attach a delayed
answer to whichever task happens to be active when it arrives.

## Preventing loops and concentration of work

One recorded dependency has one outstanding request to one recipient. Retrying
uncertain delivery reuses the operation ID; follow-ups and evidenced reroutes
reuse the need handle. A new operation cannot bypass that recorded identity.
Rephrasing the question does not justify a new need, but recognizing arbitrary
semantic duplicates is a model responsibility, not a mechanical service promise.

A brief answer does not include acknowledgments, broad advice, progress reports,
or a follow-up question unless a missing parameter is indispensable. The initial
pilot permits at most one clarification and one further evidenced contact per
dependency, within its original lifetime and attention budget. A qualified reroute
and a same-source contact after material new evidence share that allowance.
These limits need evaluation; neither step is routine. A referral is not authority to fan out, and uncertain
delivery is not a definite failure that justifies another recipient.

Compatible admitted needs for the same versioned result can share one request
inside the same swarm. A passive watcher does not keep commissioned work alive
after its requesting owners withdraw; joining with a current admitted need is
an explicit asking effect. Never coalesce merely similar questions with different
revision, environment, privacy, acceptance, or material timing requirements.
Consumer-specific context must not leak across swarms through a cache.

Limit concurrent contributions at a recipient and preserve its owner's work.
Keep transport limits as backstops, but tune attention budgets using observed
cost and task outcomes. Hitting a budget must produce an explicit unresolved
state, not guessing or silent task success. Do not claim hard token budgets for
an adapter that cannot enforce them.
An awaited answer takes precedence over unrelated incoming questions when a wait
returns; do not make helping every sender a prerequisite for resuming the owner's
task. The recipient can decline work that would require a new investigation.

For the initial scheduling policy, allow at most one actively executing brief
contribution per recipient harness, across its swarms. A contribution waiting
for a parameter releases that execution slot; its record alone does not occupy
the agent. Preserve human input and ready owner results first. For otherwise
eligible distinct requests, use fair ordering across authenticated requester
tasks with the oldest request within each task. Do not rank urgency from
persuasive prose or silently turn a frequently useful peer into a coordinator.
This is a proposed backstop to measure, not an established throughput optimum
or a hard native token budget. Return honest queued/deferred state without
additional model-generated status messages.

One active slot limits concurrency, not cumulative distraction. Do not chain
automatic peer turns while the recipient has ready owner work. After a brief
contribution, yield to that work before automatically taking the next question.
An owner that is verifiably waiting with no ready outcome can permit another
bounded contribution; a newly ready owner result takes priority again. Native
idle alone does not establish that the owner has finished or has nothing to do.
Measure actual owner delay, since an opportunity to resume is not proof of useful
progress and a concurrency limit is not a latency guarantee.

A reciprocal wait may allow each peer to answer a question it already knows;
it does not justify recursive delegation. A true dependency cycle should be
reported with the missing decision or ordering constraint. Repeated polling and
invented answers do not break the cycle.

## What the developer sees

Keep Settings → Experimental → Swarm collaboration, account-level and off by
default. Adding harnesses to a swarm is the only grouping step. No new shortcut
or picker is required for ordinary in-swarm communication.

The existing Swarm conversation view should explain each meaningful exchange:
who asked whom, the missing input, why that peer was selected, the short answer
or result, and whether it resolved the dependency. A developer should be able to
understand an exchange without opening both terminal transcripts.

Use simple visible states such as Waiting, Answered, Could not answer, Work
needed, No longer needed, and Unavailable. For `unknown` or a declined request,
show its actual outcome. An Answered label does not establish that the owner's
task is complete. Put delivery diagnostics behind details. Directory
updates, deduplication, and successful background checks should not appear as
chat messages. Useful inspection does not need a new stream of notifications.

## Examples for a mixed-provider swarm

**No message:** Codex needs the backend's field name. It reads the versioned API
schema published by Claude Code. Both continue their own work.

**One necessary ask:** The user gave Claude Code a decision about retry behavior
that is absent from the repository. Codex is implementing the corresponding UI
and discovery identifies that decision's context holder. Codex asks for the
specific decision. Claude answers with the decision and its source, or states
that the user never decided. No general review follows.

**One subscription:** Grok is already running the exact required device test.
Codex subscribes to that run's result and continues independent work. Grok is not
asked “are you done?” A matching result resumes Codex only if still needed.

**Bounded work:** A required check needs the device connected to Grok's machine.
Codex requests that check with revision, device identity, and acceptance criteria.
Grok accepts if the operation is authorized and fits its commitments, otherwise
declines. No implicit branch switch, deployment, or broad investigation follows.

**No recipient:** Two peers have generic backend titles, but neither has an
ownership or context record for the missing decision. Codex keeps investigating
the available sources or reports the unresolved decision. It does not guess a
peer just to demonstrate collaboration.

## Limits of this proposal

The real exchange audit is small, and none of these rules establishes measured
token savings or autonomous routing accuracy. The protocol can prevent several
mechanical failure modes while still admitting a well-worded unnecessary ask.
The design therefore requires both protocol fault tests and model evaluations
with hidden dependencies, tempting irrelevant peers, and equal task budgets.

Provider-native communication also needs explicit adapter handling; see the
[native comparison](native-session-comparison.md). The product promise must
match what every supported path can actually enforce.
