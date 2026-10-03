# Read-only audit of observed exchanges

Observed September 28, 2026. The local daemon retained seven swarm ledgers and
seventeen mailbox records. Two ledgers contained exchanges: eight questions in
total, seven attributed to agents and one to the owner. There were five answers
and three expired questions. No advanced `consult` instruction was recorded.

This is a small, selected local sample, not a representative benchmark. The
initial case review used the ledgers without retrieving full terminal context,
previous human instructions, actual task outcomes, or billing. A later bounded
native-counter audit is reported below; it does not establish causal cost savings
or a measured “waste percentage.” The examples below are paraphrases; private member
capabilities, conversation text, machine addresses, and device identities are not
included in this document.

The recorded owner attribution is an API role, not independent evidence of a
human instruction: the current wire adapter selects owner mode when the member
key is omitted within an authenticated owner/local-client connection. The
[baseline audit](baseline.md#what-is-enforced) records that distinction. Case F
therefore remains conditional until a correlated owner action is established;
this investigation does not claim it was unauthorized.

The delivered introductions inspected here use the older policy, without the
new task-origin lookup. The worktree's prompt-origin fix is a separate improvement;
it cannot retrospectively establish the scope or necessity of these requests.

## Case review

| Case | Observed request and result | Assessment at the contact decision | Better behavior to test |
| --- | --- | --- | --- |
| A | An agent researching UI ideas asks which desktop features already exist and which gaps matter. The peer gives a broad answer and says its related work is already complete. | No concrete blocked action or exclusive source is identified in the question. Relevant past experience is real, but much of the requested inventory is likely available in code/history. Full task context could alter the assessment. | Inspect code and published completion notes first. Ask only for a particular unresolved decision or unpublished change that this peer owns. |
| B | An implementation agent requests a general read-only review of several changed files while it runs checks. The peer returns two specific defects. | The result was useful. Usefulness afterward does not establish that the peer was necessary beforehand. The ledger does not show an explicit independent-review requirement or why this was the particular reviewer needed. | Keep optional review out of default autonomous contact. Preserve explicit user/project-required review as a distinct reason with a bounded target and frozen revision. |
| C | An agent debugging a pane that repeatedly reopens asks whether a peer is doing live picker tests and knows a relevant issue. The question expires. | A possible live-state dependency, but the request does not establish that this peer caused or controls the behavior. Expiry does not prove it was never read or that the requester was blocked. | Check the local event/process evidence. Contact the peer only when evidence connects its active work to the interference and its current intent is needed. |
| D | The same debugger later reports a confirmed cause, announces its edit scope, asks the peer to avoid overlap, and asks whether the peer has a hot-reload process. It also expires. | Several intentions are bundled into a new question. Some information is an ownership announcement; process state may be directly inspectable. This also overlaps a still-recent unanswered contact. | Publish the work claim without waking a model. Update or cancel the obsolete dependency; ask one concrete question only if the remaining live-state decision requires the peer. |
| E | A fix author asks whether a peer is modifying two welcome-screen files. The peer says its separate work was already merged and its worktree is clean. | A genuine type of coordination need, answered with stale directory information. It is not clear that another model turn was necessary to establish the current state. | Read fresh work claims and worktree facts. Ask only if there is an actual conflicting claim or unresolved shared interface. Silence or a clean worktree alone must not be treated as a guarantee of future non-overlap. |
| F | A request recorded with owner origin transfers firmware work, naming a commit, constraints, completed checks, and the next actions. The receiving agent accepts. | If confirmed as owner-directed, this is an authorized handoff with a meaningful acceptance step, separate from autonomous-selection precision. The ledger label alone does not prove the originating human instruction. | Preserve genuine explicit handoffs and verify their provenance before classifying them. Send the artifact reference and unresolved actions/constraints; record acceptance as lifecycle state rather than another open-ended discussion. |
| G | The handoff recipient asks the original worker which physical device is safe to use, where it is attached, build flags, and extra UI decisions. The question expires. | The handoff author is a defensible source for unpublished device identity and earlier user context. Build commands and documented behavior may be locally available. One necessary dependency has been mixed with several weaker requests. | Inspect the handoff artifact and local device facts first. Ask only for missing physical identity or a specific prior decision. Do not guess a destructive target when the owner is unavailable. |
| H | The recipient asks which UI surface and branch an earlier user request referred to, and includes a long progress report. The answer distinguishes an artwork reference from UI implementation and confirms that an interaction choice was never decided. | A narrow ambiguity in prior human intent is a legitimate dependency on the context holder. The answer prevents inventing a decision; it does not itself authorize choosing one. The progress report is largely unrelated to the question. | Ask the one unresolved decision with the two relevant references. Return “not decided” with provenance, then resolve the material choice with the user or an already-authorized default. |

These cases support treating **necessity**, **recipient evidence**, **freshness**,
and **message scope** as separate checks. One must not use a useful answer in B to
justify all speculative reviews, or the noisy requests in A/E to suppress G/H.

## Timing and size observations

The three answered agent-origin questions in the desktop ledger took roughly
378–537 seconds from creation to the recorded answer. The necessary interpretation
is end-to-end elapsed time including delivery and waiting, not model compute time.
Two answers were over 4,000 characters. Neither fact alone proves wasted work.

The local mailbox contained:

| Notice kind | Records | Total stored text characters | Receipt states |
| --- | ---: | ---: | --- |
| Membership introduction | 7 | 23,119 | 3 started, 2 received, 2 unknown |
| Question | 6 | 13,653 | 4 received, 2 unknown |
| Answer notification | 4 | 16,064 | 1 started, 2 received, 1 unknown |

These notices include delivery instructions, command prefixes, and wrappers as
well as useful content. They are not token counts. `started` is observed input
acceptance; `received` can mean an inbox read; `unknown` remains ambiguous. A
ledger may include a peer whose mailbox is on a different machine, so ledger
and local mailbox counts need not match.

The evidence does establish that joining a swarm can cause model work before a
specific dependency exists. Removing that wake-up is a concrete design target,
provided agents can learn the tools and policy passively on their next real task.

## Native usage follow-up

A read-only scan matched ten of the seventeen originally audited notices to
exact native user-message text hashes in four local Codex transcripts. Sixteen
notices were eligible for this follow-up: one was excluded because its ledger
had changed from the initial snapshot. Six eligible notices did not match in the
bounded scan. Seven matched windows contain an observed native task end. The
unmeasured notices are not assigned zero cost or assumed undelivered. This local
usage sample does not measure Claude Code or Grok.

The scan reads lifecycle and cumulative usage events in bounded time ranges,
with a preceding counter where necessary. It exports no prompt text, native
session IDs, membership keys, or transcript paths. The anonymized observations
and method are in [usage-window-observations.json](usage-window-observations.json).

| Completed notice window | Positive usage updates | Input, including cache | Cached input subset | Output, including reasoning |
| --- | ---: | ---: | ---: | ---: |
| Introduction N02 | 1 | 204,038 | 7,808 | 99 |
| Introduction N12 | 1 | 182,988 | 7,808 | 116 |
| Agent-origin question N01 | 7 | 606,061 | 571,264 | 3,821 |
| Agent-origin question N05 | 14 | 1,992,458 | 1,875,328 | 11,063 |
| Agent-origin question N06 | 3 | 508,102 | 505,344 | 843 |
| Answer notice N10 | 1 | 221,880 | 221,184 | 89 |
| Answer notice N11 | 1 | 73,727 | 70,656 | 583 |

The two completed introduction windows alone recorded 387,026 input tokens,
including 15,616 cached tokens, and 215 output tokens. These are native recorded
usage counters for the notice-correlated windows. They are not a monetary bill
or a claim that removing the notices would save exactly that amount. The cause
of their low cache reuse was not diagnosed.

The input totals accumulate repeated context across positive usage updates;
they are not the notice's token length. Cached input is already inside input,
and reasoning is already inside output. Positive counter updates are not asserted
to correspond one-to-one with API requests. A recipient may also continue its
owner's work in the same turn, so the window cannot isolate incremental peer work.
The recorded owner-origin handoff and incomplete windows are excluded from this
table; that exclusion does not verify the handoff's human provenance. Likewise,
an agent-origin label does not prove that its question was selected autonomously
rather than explicitly requested earlier. The counters remain usage observations,
not a scored comparison of autonomous and owner-directed decisions.

This gives a stronger reason to remove unnecessary wake-ups and measure context
costs, while preserving the need for a controlled task comparison. Shortening
the visible question alone does not account for the session context it can cause
the provider to process.

## Measurement needed next

An instrumented pilot should record the decision before contact, the evidence
available at that point, the recipient's result, whether the requester used it,
and the recipient's displaced work. It must include independently solvable tasks
and tasks requiring peer-only context. Compare all participants' total usage and
completion time against a competent independent-work baseline.
