# Investigation log

## 2026-09-28, initial pass

Goal remains active. This is the first goal turn; previous goal-turn classification
does not apply. Work completed in this pass is evidence gathering and a written
baseline, not a completion claim.

- Inspected the current worktree's prompts, protocol schema, service, directory,
  mailbox, safe-input preflight, backend adapter, and operating guide.
- Established that membership notices can start model turns; repeated daemon
  polls themselves are not repeated model calls.
- Found no necessity/recipient-evidence gate. Directory metadata does not record
  current ownership; production runtime does not supply its optional branch field.
- Found that task origin currently resolves the swarm but exchanges do not have
  a first-class task lifetime. Return delivery is bounded by exchange state/time,
  not by whether the originating human task is still the one being worked on.
- Located seven local ledger files and seventeen mailbox records. Their contents
  have not yet been analyzed. They must be read without exposing membership keys.
- Began checking primary research and protocol sources. No external claims are
  adopted into the design until the supporting text and limitations are read.

## Local exchange audit

- Read seven ledgers and seventeen mailbox records without exporting member keys.
  Eight questions exist: seven agent-origin, one owner-origin; five are answered
  and three expired. The source records remain unchanged.
- Wrote eight paraphrased case assessments. Distinguished optional broad review
  that found real defects from a necessary peer-held decision; usefulness and
  necessity are not interchangeable.
- Found concrete stale-ownership examples: recipients answer that their work was
  already complete/merged. Current metadata provides no authoritative work claim.
- Found bundled requests and unrelated progress reports in otherwise defensible
  dependency questions. A compact contract must preserve needed constraints while
  excluding unrelated status.
- Measured notice characters and receipt states, not token cost. Three membership
  notices have observed native turn starts. Introductions can create work without
  a task dependency.
- Delivered notices predate the worktree's task-origin lookup. Keep source
  behavior and historical runtime evidence separate.

Next: compare policy alternatives, read the primary research narrowly, and map
passive context/task-lifetime support in the actual engine adapters. Keep runtime
source and the user's experimental setting unchanged during design work.

## Native Claude Code and Codex investigation

The user explicitly asked to study both products' cross-session design. Read
official documentation first, then checked installed CLI help, versions, static
Codex tool descriptors, and locally generated app-server protocol schemas.

- Claude Code has independent-session discovery/messaging separately from Agent
  Teams; an idle subscription can avoid asking a peer for status.
- Codex CLI 0.154.0 includes existing-session browsing and queueing plus TUI
  descriptors for listing, reading, waiting, and sending follow-up prompts to
  other tasks. Public subagent documentation alone misses this distinction.
- Codex app-server separates passive context injection from turn-start and
  turn-steering operations; steering requires an expected active turn ID.
- Found a scope gap: provider-native directories and transports are independent
  of Harness's channel gate. The design must either constrain those paths or
  accurately limit its promise to Harness-mediated communication. It must
  preserve ordinary delegated-agent workflows and avoid global setting changes.
- Provider hook support suggests a passive membership-context path, but the
  current Harness hook intentionally emits no such context. Documented support
  is not a verified adapter implementation.
- Wrote the comparison and evidence metadata. No peer messages, provider model
  calls, live session changes, or production edits were needed.

Next: formalize dependency/ownership evidence, request lifetimes, and the
smallest feasible adapter contract; compare alternatives against the observed
exchanges and adversarial synthetic cases. Test design mechanics separately
from claims about autonomous model quality.

## Cross-provider scope clarified

The user confirmed the product is cross-provider A2A: Codex, Claude Code, Grok,
and other supported harnesses collaborate through Harness in the same swarm.
Preserve native contexts and permissions. Provider research informs adapter
mechanics; no design should require all participants to use one vendor's team
or task server. The pane is a view, and the harness session is the peer identity.

## Policy, adapter contract, and initial checks

- Drafted a provider-independent policy and operation/lifecycle contract. Reads,
  asks, accepted work, and continuation have distinct effects and authority.
- Added the important timing distinction: a necessary dependency can be requested
  before full blockage; an unknown future improvement cannot justify contact.
- Confirmed Grok's documented passive-hook stdout behavior differs from the
  Claude/Codex context-output path. The installed Grok is 1.0.34. A common policy
  needs verified provider-specific adapters, not a universal hook assumption.
- Modeled task-bound idle continuation separately from request admission. Ran
  8,250 bounded event permutations and positive paths; weakened models produced
  stale-input, revoked-grant, and uncertain-retry counterexamples. This is an
  abstract contract check, not a production test or model-quality benchmark.
- Created 36 synthetic decision inputs with separate manual policy labels.
  Checked ID alignment and absence of oracle fields from inputs. No model calls
  or real peer contact occurred.
- Compared policy alternatives and specified a mixed-provider pilot that measures
  task outcomes, total usage including maintenance, false contact, missed
  dependencies, and recipient disruption. The paid pilot remains unrun.

Next: challenge the draft's costs and cold-start behavior, tighten minimum viable
scope, and turn unresolved assumptions into explicit implementation acceptance
checks. Preserve the user's running sessions and all earlier code changes.

## Cold start, priority, and continuation follow-up

- Classified the preceding goal turn as progress: the native comparison,
  provider-independent proposal, synthetic cases, and abstract model were
  completed without a blocking condition.
- Reproduced a current-source availability gap using synthetic events through
  `CodexNormalizer` and `SwarmPromptScopes`: the first goal prompt receives its
  originating swarm, while an automatic continuation clears it. No daemon or
  model session ran. A repair must carry trusted provenance, not match a prefix.
- Read current wait ordering: incoming questions are returned ahead of an already
  available awaited answer. The proposal now preserves the recipient owner's
  priority instead of unconditionally requiring inbound work first.
- Added a concrete first-implementation brief. Publication occurs during shared
  work even when the publisher has no question, with no idle profiling turn.
  Cold-start missing knowledge remains explicit. Cost comparisons include record
  upkeep; titles/native plans remain hints, not current ownership proof.
- Clarified that initial artifact reads use published facts and existing access
  to immutable references. A remote path is not a local file, and retrieving
  evidence does not check out or merge another branch.
- Read a pinned public Grok source revision and its hook/MCP/rules guides. That
  source offers tool-hook context while prompt-hook context is still discarded.
  The source revision differs from the installed build; no runtime capability
  claim or session/configuration change follows from source inspection alone.
- No production source, provider settings, account data, or working peers were
  modified or contacted in this phase. Public source downloads stayed in `/private/tmp`.
- Added twelve decision cases for cold start, quiet publication, recipient
  priority, remote snapshots, historical expertise, and explicit human scope.
  The suite now has 48 cases; its labels are still manual and no model was run.
- Tightened the future pilot: distinguish a manually perfect directory from
  agent-authored records with charged upkeep, include substantial independent
  work, score necessity before revealing the answer, and track both owners' time.
- Added an authority requirement for old in-flight tool calls: a capability is
  pinned to its originating task and cannot inherit a newer input's scope simply
  because it reaches the daemon later.

Next: scrutinize request-evidence quality and the evaluation's ability to expose
missed dependencies, publication overhead, and recipient disruption. Consolidate
the design around implementable decisions rather than adding generic features.

## Native usage attribution follow-up

- Matched ten stored mailbox notices to exact native prompt hashes in four local
  Codex transcripts. Seven windows have an observed native task end; unmatched
  notices remain unmeasured. Scanned bounded lifecycle/usage event ranges and
  obtained preceding cumulative counters, without exporting conversation text.
- Reconciled the follow-up cohort: sixteen of the original seventeen notices
  were eligible; one ledger had changed since the initial snapshot. Six eligible
  notices had no exact match in the bounded scan. All positive counter deltas in
  matched windows agreed with those events' reported last-usage counters.
- Two completed membership-introduction windows recorded 387,026 input tokens
  (15,616 cached) and 215 output tokens including reasoning. This is observed
  native-window usage, not a dollar estimate or causal estimate of savings.
- Kept the explicit human handoff and incomplete windows separate. Existing
  owner work can share a notice-started turn, so per-contribution marginal usage
  cannot be recovered from these totals alone.
- Added anonymized counter observations. The private read-only collector is
  `/private/tmp/swarm_usage_audit.py`; its intermediate metadata stays private.
- Checked primary cache documentation before recommending stable bootstrap/tool
  definitions and measuring adapter context placement. Current cache behavior
  is model/configuration dependent; the low reuse in those samples is not diagnosed.
- Confirmed the current per-conversation `AgentTokenUsageCache` supports Claude,
  Codex, and OpenCode, not Grok. Grok's installed CLI advertises persisted session/
  turn usage, which is a future pilot accounting path to verify. No model calls,
  provider configuration changes, or production edits occurred.

Next: review the proposed decision contract for unnecessary round trips and
ambiguous authority, then define compact agent instructions and a minimal
conformance matrix. Do not confuse more protocol fields with better judgment.

## Compact contract and conformance follow-up

- Classified the preceding goal turn as progress: the implementation brief,
  source-level continuation reproduction, expanded decision cases, pinned Grok
  source inspection, and native usage audit produced concrete new evidence.
- Added a 211-word candidate common policy and a small agent-facing contract.
  Agents supply the dependency and source evidence; the adapter supplies task
  and authority metadata. Independent work requires no directory ritual, and a
  one-line published answer does not require a second fetch or an author turn.
- Distinguished a trustworthy invocation binding from a late lookup of mutable
  current task state. The latter cannot safely assign authority to an old queued
  shell command after newer input arrives.
- Added 24 concrete conformance cases and a six-direction provider coverage
  plan. They are future acceptance requirements, not passing native tests.
- Inspected installed Codex schemas for dynamic tool calls, hooks, steering,
  and context injection. A turn ID alone does not establish accepted-input
  generation or an atomic stale-input check. Recorded additional schema hashes.
- Read pinned public Grok messaging primitives: owned-child/parent capabilities,
  admission uncertainty, prompt/epoch-bound delivery, and explicit delivery
  modes. This reinforces the separation of admission, execution, and task use;
  it does not prove arbitrary independent-session or installed-runtime support.
- Made answer-use reporting honest: delivery, read, use, and resolution are
  distinct. The design does not require a thank-you or an extra turn solely to
  decorate a successful status.
- JSON, local Markdown links, and 48 input/oracle IDs validate. No model pilot,
  production code change, account mutation, or peer contact occurred.

Next: challenge the publication/routing tradeoff with a concrete task fixture.
The proposed pilot must expose hidden required facts and tempting optional asks,
charge publication overhead, and verify artifacts without leaking its answers
through a shared workspace. More manual labels alone cannot establish that.

## Task-fixture follow-up

- Prepared one runnable upload-recovery world with three independently owned
  code tasks, a private v8 product decision, and an attractive peer holding only
  an obsolete v7 discussion. No native harness or model was started.
- Added manual/automatic/undecided private variants and four initial metadata
  conditions. All twelve combinations have identical public workspace hashes.
  Source-private facts and oracle checks are runner-owned, outside participants'
  intended mounts; directories alone are explicitly not treated as isolation.
- Added six provider rotations covering all directed requester/source pairs.
  The future live runner must additionally randomize names/order and record
  actual publication timing and both peers' owner work.
- Verified eleven fixture properties with hand-written reference solutions:
  unfinished scaffolds fail, each intended private variant can pass, wrong
  choices fail, edited public tests do not redefine the judge, and existing
  destinations are not overwritten. Saved the offline verification record.
- Kept communication/usage unscored even when code passes. A lucky correct guess
  and an untouched missing-decision stub must not be counted as successful A2A.
  The private judge is final evaluation, never an answer-leaking feedback loop.

Next: review the remaining design questions as a decision audit, especially the
cost/recall tradeoff of publication and how to reject an attractive but unfounded
request without making a necessary dependency disappear.

## Publication and ownership decision audit

- Classified the preceding goal turn as progress: it produced the compact
  contract, conformance plan, pinned native-source evidence, and an offline
  task fixture with eleven verified properties. No waiting or blocker applied.
- Clarified source selection: several peers can be qualified. Availability can
  break a tie after evidence establishes qualification. No artificial unique-
  expert requirement and no fanout are needed.
- Preserved owner judgment: a missing past choice is not automatically a reason
  to consult a peer or ask the user again when the user already authorized the
  agent to choose. Added two boundary cases; the suite now has fifty manual labels.
- Made publication recall measurable separately from routing. Correct abstention
  at a cold directory can still expose an end-to-end miss. Authenticated records
  prove authorship, not truth; hints must not become ownership by relabeling them.
- Specified the full bounded-work lifecycle beyond the first brief-ask pilot,
  including acceptance, parameter changes, effect reporting, shared consumers,
  and cancellation without killing unrelated owner work. Added six later-slice
  conformance gates; no autonomous work execution was started.
- Separated queued initial contributions from stale continuations. New recipient
  work can defer an unread valid question; new requester input suspends its old
  unsent questions until adopted. Consumed requests cannot masquerade as fresh
  initial delivery after their continuation authority is revoked.
- Tightened deduplication around the dependency itself. Changing a recipient or
  operation ID cannot create a parallel contact; uncertain admission cannot be
  treated as a definite failure and automatically retried elsewhere.
- Kept read operations passive. Explicit adoption can be coalesced with a wait,
  but must disclose reactivation; it is not hidden inside a read. Adoption alone
  does not grant an automatic result wake.
- Added reciprocal-wait handling and a native goal-loop acceptance check. A
  one-shot Harness grant does not control a provider's independent scheduler or
  prove the absence of repeated native model polling.
- Distinguished real structured owner actions from a model's interpretation of
  user text. A quoted/negated instruction must not mint owner credentials just
  because the agent labels it user-requested.
- Reviewed two additional primary research sources for failure diagnosis and
  budget-comparison caveats. Their tasks and resource definitions are not used
  as Harness performance estimates. Rechecked Grok help without starting a
  session or changing settings; quiet existing-session activation remains a
  capability to verify, not a demonstrated feature.
- JSON, Python syntax, Markdown links/headings, and fifty input/oracle IDs
  validate. Running policy, provider sessions, and production code are unchanged.

Next: use concrete two-sided event traces to check that the clarified admission,
adoption, and continuation rules preserve necessary contact while preventing
duplicate or obsolete work. Then reduce the delivery brief for human review.

## Two-sided exchange lifecycle audit

- Classified the preceding goal turn as progress: publication/ownership rules,
  bounded-work design, explicit adoption, native scheduling caveats, and fifty
  decision cases provided concrete design and evidence. No blocker applies.
- Added a finite brief-ask model covering initial delivery, one clarification,
  subsequent parameter and answer, input changes at either endpoint, and
  idempotent pending waits. Checked 6,807 orderings across twelve event families
  and nine positive paths with zero modeled invariant failures.
- Seven deliberately weakened rules produce counterexamples. A separate
  liveness contrast shows that deleting a queued question whenever its recipient
  receives new work can lose necessary contact. Positive paths verify both
  delivery counts and useful final phases/outcome observations.
- The review found a needed distinction: human inspection of Swarm conversation
  must not consume the waiting harness's outcome or grant. Actual delivery to
  that agent during current work can retire its redundant queued wake.
- Made clarification steps explicit. A parameter response advances the exchange
  so another wait cannot replay the old clarification. Opaque service handles
  carry the step identity; optional declared coalescing avoids a ceremonial
  second tool call just to wait for the next required value.
- The model assumes a necessary admitted ask and serialized current state. It
  does not validate semantic routing, real handle encoding, distributed
  cancellation, native delivery, accepted work, or token savings. No providers
  were started and no running collaboration behavior changed.
- Aligned the policy's small request fields with the concrete agent contract;
  material deadlines/constraints are optional or derived rather than invented
  for form completion. Preserved multiple genuinely qualified sources instead
  of implying that every legitimate request must have a unique possible peer.
- Research Python syntax, JSON parsing, local Markdown links, and heading
  uniqueness validate. Existing production edits were left untouched.

Next: audit the twelve investigation questions against the actual evidence and
reduce the implementation recommendation without disguising unresolved native
activation, semantic precision, publication recall, or cost as solved.

## Discovery coverage and record-validity review

- Classified the preceding goal turn as progress: the two-sided model, nine
  positive paths, clarification stages, and human-inspection distinction added
  checked design evidence. No blocker or verified wait applies.
- Rechecked current `sessionTitle.ts`, `MemberRuntime`, channel role derivation,
  and the wait command. Provider names are read/reused without a new Harness
  summarizer, but still supply hints rather than current ownership or knowledge.
  No production files were changed.
- Compared selective publication, broader publication, existing title hints,
  targeted conversation retrieval, and a board of unresolved needs. Retained
  selective records with explicit coverage/cost measurement. Unrecorded private
  knowledge in an indefinitely idle session cannot be discovered for free.
- Closed a record-validity ambiguity: an immutable historical result remains
  reusable for its exact revision, while a claim that a mutable policy is still
  current is bound to the affirming input. New human input suspends the latter
  until reaffirmed; it does not erase the historical fact. Later timestamps
  alone cannot resolve conflicting authorities.
- Added R7 to the future conformance plan and two paired manual decision cases.
  The suite now has 52 aligned inputs/labels. Python syntax, JSON, local links,
  and headings validate; no model was evaluated on those labels.

### Audit of the investigation questions

This audits design coverage, not implementation completion. The proposal's
future release tests are not represented as passing results.

| Question | Current evidence / answer | Remaining uncertainty or design work |
| --- | --- | --- |
| 1. Today's triggers and avoidable exchanges | Source audit, eight paraphrased cases, bounded native usage windows. | No causal estimate of saved tokens or a general waste rate. |
| 2. Necessary contact | Dependency counterfactual, compact instructions, paired decision cases. | Actual semantic precision/recall needs model evaluation. |
| 3. Particular peer and freshness | Evidence-bearing records, exact identities/versions, distinct historical/current assertions. | Retrieval and qualification under imperfect real publication remain unmeasured. |
| 4. Low-cost upkeep | Selective publication during normal work; reuse existing hints; compare broader publication and charge unused records. | Whether coverage earns its upkeep is an empirical tradeoff, not solved by shorter records. |
| 5. Read, ask, coordinate, work, or act locally | Policy table, bounded-ask contract, accepted-work lifecycle. | Later work-offer mechanics remain separate from the first brief-question pilot. |
| 6. Both owners and authority | Task/input binding, exchange-bound contributions, generation guards, native capability limits. | Current source loses Codex goal scope; native serialization/activation is not established for all routes. |
| 7. Changes, waits, retries, and cycles | Three finite lifecycle checks, one owner wait cycle over several outcomes, uncertainty, clarification, adoption, bounded rerouting. | Native owner/contribution provenance, source removal, and distributed consistency remain outside the abstract checks. |
| 8. Small requests and useful outcomes | Four agent fields, host metadata, opaque steps, no acknowledgment/use-confirmation ceremony. | Native tool packaging and its actual round-trip cost remain unmeasured. |
| 9. Instructions versus enforcement | Semantic necessity is model judgment; identity, versions, limits, and continuation belong in the service. | Typed fields are not proof of a justified ask. |
| 10. Evaluation | Complete-task metrics, publication coverage stages, 52 manual cases, executable offline artifact fixture. | No autonomous native pilot or causal savings comparison has run. |
| 11. Provider support | Installed help/schemas, official documentation, pinned Grok source and explicit gaps. | Existing-session quiet activation, goal waiting, and some provenance guarantees need native conformance. |
| 12. Build and rollout | Small implementation slices, compact agent operations, combined-wait contract, and concrete conformance/evaluation gates. | Native support and model-quality evidence are required before a shipping capability can be claimed. |

Next: check one owner waiting on multiple required outcomes, including a
clarification/failure arriving before all answers and invalidation of a mutable
fact already read. Prevent duplicate wakes without turning unrelated directory
updates into new owner work.

## One owner wait over several necessary outcomes

- Added an explicit wait set for the blocked owner step. `Any` and `all` have
  different useful-work predicates, but clarification/failure and explicitly
  watched invalidations cannot be hidden behind an all-results barrier.
- One wait cycle has one continuation. Ready relevant outcomes are returned
  together; pending results remain records after that permission is consumed.
  A second owner turn requires a new wait. Different concurrent specifications
  are rejected for explicit replacement, rather than silently combined.
- A read does not create a future wake subscription. Watching a material mutable
  assertion while waiting on another result is explicit and bounded by that
  same cycle. Human inspection, heartbeats, and unrelated publications do not
  acquire that authority.
- Added `check_wait_set_model.py` and recorded its results: 35,364 bounded
  orderings across eleven families, thirteen positive paths, and zero modeled
  invariant failures. Four weakened mechanisms yield safety counterexamples;
  three liveness contrasts show an intervention hidden by an all-results wait.
- The per-dependency-grant mutant produces two owner resumes for one wait;
  the grouped contract returns both ready outcomes through one. This is a
  protocol counterexample, not a measured token saving or native engine test.
- The model assumes already-authorized dependency adoption, supported register
  and yield, trusted owner/contribution identity, and current state at the write
  boundary. It does not prove arbitrary graph behavior or infer semantic task
  completion from an idle terminal. Updated the future conformance requirements
  and made source departure distinct from revoking the requester's authority.

Next: examine shared result consumption and concentration of requests at one
expert. In particular, clarify whether a passive subscriber keeps an existing
question alive after its original requester changes work, without silently
transferring authority or duplicating the producer's effort. Revisit native
capability gaps that determine whether these lifecycle rules can be enforced.

## Shared production and native invocation identity

- Classified the preceding goal turn as progress: explicit record validity,
  52 paired decision inputs/labels, the wait-set model, and the twelve-question
  evidence audit added concrete design/evaluation coverage. No blocker applies.
- Separated passive observation from an active admitted need. Only an active
  compatible consumer can preserve commissioned production after another owner
  changes work. Kept one original question author, independent consumer authority,
  one bounded production contract, and no uncertainty replay or renewed lifetime.
  A pending requester is not advertised as a holder of the missing answer.
- Added P1–P5 future conformance gates for active sharing, clarification, and
  fair recipient scheduling. Proposed one actively executing brief contribution
  per recipient as an initial backstop, with waiting releasing that slot and
  human/ready owner work taking priority. This limit is not an observed optimum.
- Expanded the offline upload-recovery fixture to one or two consumers. The
  second consumer needs the same private policy for a different output, while
  still being an incorrect source for that decision. Preserved v1 single-consumer
  judging and exposed separate private checks for both consumers.
- Added the reproducible reference verifier and recorded 27 passing checks,
  including public-input equivalence, wrong private choices, all provider-role
  rotations, existing-directory protection, and the CLI round trip. These are
  hand-written reference checks; no agents or provider sessions were run and
  communication, timing, and usage remain unscored.
- Distinguished attempted-request judgment from actual recipient contact.
  Cache interception after a justified decision can avoid delivery without making
  the original decision wrong. Record causal evidence snapshots, charge unused
  publications, and count shared producer usage once per episode.
- Read six additional public Grok files at the pinned revision and verified
  their Git blob identities. Its hook schema permits a prompt ID, but the
  inspected pre-tool and post-tool constructors pass none. The prompt-submit
  gate receives an ID separately; that is not proof of accepted human input or
  subsequent tool origin. The installed build differs and was not exercised.
- Documented two candidate invocation bindings: provider-supplied immutable
  invocation provenance, or a host-authenticated capability delivered into the
  originating task context. A mutable latest-context lookup or hook rewrite
  cannot safely bind a delayed old command to the newest task. Expanded S4's
  required negative cases without claiming adapter conformance has passed.

Next: review whether the integrated evaluation actually distinguishes necessary
contact from successful independent work, including already available answers,
private context, and publication gaps. Keep lifecycle correctness and model
decision quality separate; neither one demonstrates the other's success.

## Independent-success control

- Added a `local` fixture condition in which the same exact decision is already
  in each consumer's repository. A correct peer source remains in the directory,
  so the condition isolates whether contact is necessary, not whether the peer
  is qualified. The `published` condition remains a separate shared-read case.
- Kept the existing task code, checks, and directory unchanged relative to the
  private-source control; only the consumer's authoritative decision files are
  added. The three policy choices and both consumer counts are covered.
- The updated reference verifier passes 36 checks and records current hashes.
  Correct reference artifacts remain communication-unscored. This checks the
  fixture and judge, not whether a real model discovers the local document or
  refrains from unnecessary discovery/contact.
- Clarified that the twelve nonlocal conditions retain identical public files,
  while the new local condition intentionally exposes the policy in the owning
  repository. Publication and local availability are different experimental axes;
  neither should be called successful autonomous behavior before a model runs.

Next: inspect how the evaluation records actual decisions and their available
evidence without rewarding a lucky guess, a plausible post-hoc rationale, or a
directory read that silently started another agent. Preserve the distinction
between a strict semantic oracle and a mechanically auditable event trace.

## Decision review and delayed invocation reproduction

- Added an outcome-blind decision-review procedure. It separates requester
  evidence, service dispatch state, and eventual usefulness; distinguishes an
  obvious skipped local source from an unseen later publication; reviews omitted
  dependencies and leaves zero-denominator precision undefined. It adds no
  online judging turn or new model-facing form.
- Inspected current `TeamService.authorizeTask`, `ChannelDirectory.taskContext`,
  the backend context route, and the wire schema. They consult current swarm
  state, without an originating accepted-input/task capability in the request.
- Added and ran `reproduce_invocation_scope.mts` against those source classes,
  using only synthetic accepted inputs and a disposable temporary ledger. An
  A-pinned command is rejected after input from B, but an older delayed context
  lookup returns B and its resulting B request is admitted. A prior-input B
  command also remains admissible after different accepted work in B.
- Recorded the five source hashes and observations. The disconnected transport
  stub was called zero times; no provider, daemon socket, or real session was
  involved. This establishes a current API provenance gap under controlled
  ordering, not its native frequency or an incident in the installed release.
- Kept the recommendation focused on immutable invocation/task binding. A current
  context lookup cannot recover missing old provenance, and pinned swarm identity
  alone cannot revoke obsolete work within the same swarm. Production files and
  the user's preexisting edits remain untouched by this research.

Next: check whether the proposed small release can preserve ownership without
turning every accepted status question into needless record refresh or duplicate
requests. Review the cost and supported adapter boundary of explicit adoption,
rather than assuming every native prompt starts a new semantic task.

## Ordinary follow-ups and input acceptance

- Classified the previous goal turn as progress: the local-answer fixture control,
  36 checked reference cases, blinded decision review, Grok hook provenance
  finding, and reproducible delayed-invocation admission gap changed the evidence
  and the next investigation. Rechecked their current file/source hashes. No
  blocker or verified wait applies to the goal as a whole.
- Kept logical task continuity separate from accepted-input authority. A status
  follow-up can adopt selected still-needed dependencies without changing their
  request IDs, receipts, or lifetimes. Unchanged current commitments can be
  reaffirmed by reference in a bounded owner update. Immutable facts need no
  refresh, and human log inspection changes no authority.
- Rejected a text classifier that exempts phrases such as "just checking" from
  revocation. Preserve the service's generation rule; let current authorized work
  explicitly retain the relevant needs. Charge that upkeep rather than claiming
  coalescing makes it free. No idle reconciliation or automatic wholesale adoption.
- Clarified that a continuation of the same task uses its latest verified input
  binding. An unchanged native goal ID/objective cannot restore an obsolete swarm
  after accepted steering changed that binding.
- Checked official Claude/Codex hook documentation and the pinned Grok gate:
  submission hooks can precede rejection. Current Harness `hookServer.ts` and
  `cli.ts` pass the notification straight to prompt-scope start. Recorded source
  hashes and the limited finding; no installed prompt was submitted or rejected.
- Added a pending input-transition contract. Do not grant prospective scope from
  a gate event; correlate acceptance/rejection, preserve uncertainty, and prevent
  a late rejection from clearing a newer hold or reviving an expired/revoked grant.
  Extended S2/S3/C3/R7 requirements. Existing abstract models assume accepted
  inputs and do not validate this new native acceptance seam.

## MCP transport does not establish invocation authority by itself

- Read seven further public source files at the pinned Grok revision and verified
  Git blob identities. The inspected erased-tool and common workspace bridge
  handlers ignore their tool-call context and forward name/arguments. The HTTP
  wrapper does not add task identity; the configured session header identifies
  a session rather than the input behind a call.
- Internal invocation/session/turn attribution exists, but these inspected MCP
  paths do not forward it as task authority. This rules out assuming that merely
  switching from shell commands to MCP supplies the missing binding. It does
  not rule out other supported extensions or establish installed-runtime behavior.
- Retained MCP as a transport candidate with a separate provenance requirement:
  an originating task capability, supported native extension, or managed adapter
  with proven input/call serialization. Rotating a shared header to the latest
  task has the same delayed-call problem as a mutable context lookup.
- All source reads were public/read-only; local downloads stayed in temporary
  storage. No MCP server, native provider session, paid model work, or account
  configuration was started or changed.

Next: examine how passive peer content preserves its original authority across
providers, especially when a native hook adds developer context. Distinguish
static Harness policy from untrusted peer facts, and keep the efficient common
path short without implying that a provider message role grants peer permissions.

## Peer content and passive answers

- Kept authenticated routing and stable Harness instructions separate from
  peer-authored text. A native hook's developer-context role does not authorize
  the peer to enlarge the owner's task. Preserve a useful factual answer while
  ignoring an unnecessary review or confirmation suggestion; no rejection chat
  is needed either.
- Specified complete small facts inline and explicit incomplete excerpts with
  full-result references. Transport completeness, factual correctness, and owner
  task completion remain separate. Preserve original source/revision when a
  result is copied or reused.
- Applied task/input/dependency checks to passive insertion as well as idle
  wakes. Keep stale answers stored for possible current adoption. Deduplicate
  outcome versions and retire an old wait after its answer actually reaches
  the owner, without treating human inspection as agent delivery.
- Removed an unsupported claim that passive context is inherently cheaper.
  It does not itself start a new turn, but its token, cache, and latency costs
  still need measurement. Provider serialization is not proof of correct model
  interpretation or native delivery behavior.
- Added paired synthetic cases D53/D54: use the necessary answer and continue;
  do the same when the answer also suggests an optional review. The input suite
  now has 54 unique matching manual labels; no model behavior was scored.
  Research Python syntax, JSON, Markdown headings, and local links validate.
- This was design progress. No production files, settings, provider sessions,
  peer messages, or paid model calls were changed or started.

Next: inspect whether Grok's persisted native updates can correlate a tool call
with its originating accepted input. A useful existing-session adapter must not
substitute the latest prompt merely because hook/MCP invocation metadata is thin.

## Native call correlation has useful evidence and a boundary

- Downloaded six further public source files at the pinned Grok revision and
  checked their Git blob identities. The initial tool-call event is enqueued
  before the pre-tool gate and carries the running native prompt ID through
  notification metadata. Current Harness normalization parses but drops that
  metadata from tool-start events.
- Inspected the existing repository fixture by field/count only: four tool-call
  IDs and eight updates carry consistent prompt mappings. Saved its hash and
  counts, without exporting IDs or conversation bodies. This is a promising
  correlation for existing-session adapters, not a conformance pass.
- Followed native human interjections. The inspected drain submits new user
  conversation items within the running turn without replacing its outer prompt
  ID. Thus calls before and after steering can share that ID. Persisted event
  availability, accepted-input correlation, and generation/replay handling still
  need verification; binding every such call to the latest input is unsafe.
- Recorded the positive evidence alongside the limitation, rather than treating
  thin hook/MCP metadata as proof that the native integration is impossible.
  No production edit, native session, model call, or configuration change occurred.

Next: return to the main selectivity question. Make the practical first pilot
distinguish genuine evidence of who knows from agent/provider/title cues, without
requiring extra online judging or a larger per-request form.

## Blinded decision inputs and unnecessary work inside a valid ask

- Classified the preceding goal turn as progress: the peer-content/passive
  contract and Grok source/steering findings changed the design evidence. The
  goal remains active; there is no blocker or live process to wait for.
- Audited presentation bias in the manual decision suite. Every requester was
  named Alpha, with fixed canonical roster order. Added an offline renderer that
  independently changes name mapping, provider labels, and roster order while
  keeping labels, canonical IDs, and scheduling in runner-only control data.
- Verified reversibility, identity/provider relations, case/label alignment,
  paired-case presentation, and full independent provider/order combinations.
  An oracle canary changes every private label without changing any input byte.
  The documented CLI form works, existing output is protected, and unreviewed
  input fields are rejected. No provider execution or decision scoring occurs.
- Clarified that hypothetical vignette choices, actual native-provider behavior,
  and task-backed discovery quality are different evidence. Required new work
  and explicit human handoffs must not be scored as automatic brief-ask execution
  or smuggled into that narrower operation when acceptance is unavailable.
- Found a distinct selectivity issue: a justified contact can contain avoidable
  extra obligations. Added request-scope review and D55/D56: ask only for a
  missing unit when other details are local, or request two indispensable private
  selections together when the same context holder has both. The action/recipient
  alone cannot distinguish these message-shape requirements.
- Updated the small agent contract to seek the smallest sufficient answer,
  keeping material constraints and bundling necessary same-source facts. A
  short message is not automatically efficient, and a known factual answer must
  not imply an appended review was performed.
- The suite now contains 56 manually labeled inputs. The refreshed validation
  record checks 4,032 reversible renderings across two seeds and all 36 provider/
  roster combinations. This is fixture integrity, not measured agent quality or
  native coverage. All generated trial directories were temporary and removed.

Next: challenge timing and priority with the same standard of necessity. Check
whether the proposed early request and recipient scheduling rules help owners
finish, rather than hiding speculative prefetch or pushing every interruption
onto a frequently useful expert.

## Timing, recipient attention, and an event-wait candidate

- Classified the preceding turn as progress: it produced blinded input tooling,
  verified label isolation, and a distinct request-scope criterion. No blocker
  applies to the design investigation.
- Distinguished early contact for a known committed step from speculative
  prefetch before an available bounded local diagnostic. Added D57/D58 with the
  same owner task and peer identities: diagnose the conditional branch first,
  then ask while doing independent work once the required private input is known.
  Later outcomes must not rewrite the evidence at the earlier decision.
- Tightened recipient scheduling. One active contribution slot can still permit
  an endless sequential inbox drain. Require an opportunity for ready owner work
  between automatic contributions; a verifiably blocked owner can help again,
  with ready owner outcomes taking priority. Added R8 and kept substantive owner
  progress/delay as a measured outcome rather than a property of an idle flag.
- Kept batching as a later measured optimization: bounded eligible requests may
  share a supported window, but arrivals cannot extend it indefinitely, and an
  available answer must not be delayed just to form a batch. No throughput or
  native token saving is claimed.
- Inspected current CLI wait limits: 30-second default, 60-second maximum, and
  internal status/inbox polling. Internal polling is not itself an LLM call;
  model reissuing behavior and its incremental usage remain unmeasured.
- Followed the pinned Grok MCP timeout/cancellation/recovery paths. Configurable
  pending tool calls are a candidate for event waiting. Selected transport errors
  retry with the same parameters; the timeout path does not retry the slow call.
  Recorded source hashes and the differing comment/default detail without
  inferring an installed configuration.
- Added route-specific wait authority: an attached tool response and a later
  idle prompt are different effects. Cancellation/loss cannot silently promote
  one to the other; transparent retries preserve service identity and cannot
  renew grants. Explicit current re-waiting can create a new cycle without
  repeating the original peer question. Native steering/goal behavior stays unrun.
- Refreshed the offline renderer check for 58 manual cases and 4,176 reversible
  presentations. No models were scored. Research changes only; no native MCP
  server, provider session, account setting, peer message, or paid call was used.

Next: audit the common path for procedural overhead. Identify which record and
result updates can happen in an already necessary operation, and which costs
must remain visible in the comparison. Keep the runtime policy small despite
the detailed design and adapter evidence.

## Common-path consolidation, cross-repository sources, and evaluation limits

- Classified the preceding turn as progress: timing cases, recipient-owner
  priority, and wait-route evidence changed the proposed contract. The design
  investigation remains active; no blocked condition applies.
- Audited common-path overhead. Independent work has no mandatory directory
  call; publication is selective; reply reuse needs no second publication;
  consuming an answer needs no acknowledgment. Corrected wording that could
  imply a publication costs no model iteration. The current stable common policy
  is 257 whitespace words, a descriptive size rather than a token-cost estimate.
- Made reply reuse self-contained: preserve the original question, source role,
  material version, completeness, and outcome. A bare negative answer, an unknown,
  and a confirmed absence of a prior decision are different evidence. Indexing
  cannot upgrade a premise into a fact or renew a current assertion.
- Made cross-repository routing explicit. Swarm membership controls eligibility;
  the required producer/contract/version controls relevance. A same-named local
  schema can be wrong, while the required source can be in another repository.
  Added D59/D60 with these read/ask alternatives.
- Recovered the completed verifier output and checked its source hashes: 60
  canonical cases and 4,320 reversible renderings pass input-integrity checks.
  This is no model-quality or native-provider result. No process remained to poll.
- Tightened evaluation claims: these cases were developed alongside the policy,
  so they are development/regression inputs. Label isolation and renamed variants
  do not create an independent holdout or thousands of independent task worlds.
  Future splits must preserve world/contrast groups and use separately constructed
  tasks after freezing the candidate and evaluation criteria.
- Added quiet instruction-lifetime requirements to Q2: verify policy availability
  after compaction, resume, catalog changes, and toggling. A one-time introduction
  is not proof of persistence; any supported refresh belongs at an existing
  boundary. No runtime behavior, provider config, or paid session was changed.
- Rechecked local Markdown file links, JSON syntax, Python syntax, and the decision
  validation's input hashes. Unchanged abstract models and task-fixture checks
  were not rerun. All edits in this turn remained in the research directory.

Next: review the first implementation as a complete path across providers,
including activation and recovery, and keep the recommendation distinct from
capabilities that still require native conformance and behavioral measurement.

## First-path audit: stable needs, trustworthy attribution, and quiet upgrades

- Classified the preceding goal turn as progress: reply reuse, cross-repository
  discovery, holdout limits, and instruction lifetime changed the authoritative
  design. No process is live and no blocked condition applies.
- Re-read current introduction/wait instructions and the real ask/wire/scope
  paths. Kept the first implementation focused on brief necessary exchanges;
  all production files remain unchanged by the research.
- Made dependency identity concrete. The first ask returns a stable need handle
  without a separate creation round trip. Later parameter/adoption/reroute
  operations reuse it. Search can return relevant existing needs along with
  evidence, avoiding a mandatory separate history scan.
- Separated operation idempotence, need-handle invariants, conservative exact
  contract matching, and semantic duplicate judgments. Defined exact matching
  fields; material differences cannot silently merge. Rewording a repeated
  question remains a policy failure to measure, not a promised NLP equality
  capability. D19 and R2 already cover the relevant decision/mechanical boundaries.
  Added that reuse rule to the stable policy, now 266 whitespace words.
- Found a source-backed attribution limit: the RPC is inside an authenticated
  owner/local-client boundary, but an omitted member key selects owner mode,
  bypasses member task-scope checks, and records owner origin. This is not evidence
  of an unauthenticated network path, a native exploit, or an unauthorized observed
  handoff. It means the ledger role alone cannot prove explicit human intent.
- Corrected case F to be conditional pending correlated owner evidence. Likewise,
  agent-origin usage windows do not by themselves prove autonomous selection.
  The stored native counters are unchanged; only attribution language was fixed.
  The new design requires supported agent routes to reject absent credentials
  instead of upgrading them to owner authority, while preserving actual host
  owner actions and stating the same-user access limitation.
- Added quiet upgrade handling: suppress unconsumed introductions in both ledger
  and mailbox, reconcile uncertain/consumed delivery, retain history, and avoid
  an apology or replacement teaching turn. Record policy/tool-contract delivery
  at a natural boundary without mistaking that receipt for model compliance.
- Checked local Markdown targets/anchors, JSON and Python syntax, and unchanged
  decision-fixture hashes. No extra abstract-model run, native session, model
  evaluation, provider configuration change, or paid call was performed.

Next: audit how an unresolved need ends or changes, including negative outcomes
and newly available evidence. Ensure efficiency rules do not accidentally turn
into permanent silence, a false success, or repeated attempts with fresh IDs.

## Negative outcomes without repeated questions or permanent exclusion

- Classified the preceding turn as progress: stable need handles, exact-match
  limits, corrected owner attribution, and quiet migration changed the design.
  No live process, external wait, or blocked condition is present.
- Traced the distinction between a final reply and the still-required owner
  action. Added concrete outcomes for unknown/wrong-source, declined, requires
  work, known pending production, wait timeout, and expired/uncertain delivery.
  None automatically completes the owner task or authorizes another attempt.
- Required new evidence to address the earlier failure. A heartbeat, availability,
  renamed session, new operation ID, or another model turn cannot justify asking
  again. A verified new private choice can; an actually published answer should
  simply be read. Negative evidence remains specific to the need/source version.
- Clarified the provisional contact limit as one further evidenced contact,
  covering either a reroute or the same source acquiring missing information.
  These share the existing allowance/lifetime; source changes cannot reset it.
  An exhausted need remains visibly unresolved rather than silently successful.
- Kept brief questions distinct from accepted new work. A requires-work reply
  cannot cause an investigation through a renamed ask. A known ongoing result
  instead supplies its exact handle for supported observation, without a new
  commission or a promise that unknown answers will be revisited in the background.
- Added D61/D62 with identical tasks and participants: unchanged source evidence
  after unknown versus a verified newly acquired private fact. The former retains
  the missing choice; the latter permits a bounded ask through the existing need.
  These remain development scenarios, not unseen tests or measured model choices.
- Updated the outcome language in the small policy and conversation design: an
  unresolved dependency is not completed work; an unknown/decline/work-needed
  outcome must not become an Answered-success status.
- Refreshed the renderer verification for 62 canonical cases and 4,464 reversible
  presentations. Source hashes match; local links/anchors and JSON/Python syntax
  validate. No native models were evaluated and unchanged abstract models were
  not rerun. All edits remain design/fixture work in this research directory.

Next: inspect the executable pilot's information boundaries and outcome checks.
A routing proposal should not appear effective because a hidden answer leaked
through the fixture, a correct guess passed, or incomplete owner work was ignored.

## Pilot artifact boundaries and repeatable grading

- Classified the preceding turn as progress: explicit negative outcomes and
  changed-evidence rules prevent both repetitive contact and permanent exclusion.
  No live process, external wait, or blocked condition is present.
- Reproduced an evaluator information leak with hand-written control code: the
  private judge supplied its expected policy as a child argument, so submitted
  code could read it and pass all three worlds without obtaining the decision.
  No native agent was run or observed exploiting it.
- Moved private comparison into the evaluator parent. The child receives only
  the public output mode and reports observed values. The same argument-reading
  control now only passes the world matching its fallback guess, and fails the
  other two. This removes that leak, not arbitrary execution access; the actual
  future runner still needs isolated files, profiles, metadata, and arguments.
- Captured module bytes before any execution and used the same hashed snapshot
  for public and private checks. Missing modules produce per-owner failures
  while preserving other owners' results. Ordinary module stdout no longer
  corrupts observation parsing. Explicitly described the self-contained module
  output contract in each task and made tool use conditional on an actual need.
- Added sixteen verifier checks across one/two-consumer worlds, including the
  argument control, missing artifacts, logging, and mutation after snapshot
  capture. All 52 checks passed; the refreshed record matches generator/verifier
  hashes. These are fixture checks, not measured agent routing or token savings.
- Updated the fixture guide and conformance evidence. Local Markdown targets
  and anchors (100), ten JSON files, and seven Python files validate; the separate
  62-case/4,464-rendering decision record's source hashes remain valid. Unchanged
  abstract protocol models were not rerun. All edits remained in this directory.
- Answered the user's progress and terminology questions: shared answers are
  facts already made available inside a swarm; a pending request is an existing
  question awaiting its answer. Reuse requires the same material need/version,
  and the design adds no manual publishing step for the user.

Next: check how relevant shared-work evidence reaches an agent during normal
work without a directory scan at every turn, a live roster, or an author wake.
Then audit the first implementation against the original product requirements.

## Discovery during an already-required shared-work update

- Reviewed the current publication and search contracts against the ordinary
  independent-work path. The existing rule avoided per-turn searches but did
  not explicitly say how a shared-work publisher could see related evidence
  before realizing a conflict existed.
- Added a bounded read to the publication return contract: acknowledge the
  caller's update and return applicable existing same-subject records with
  their original provenance/version. A complete small fact needs no second
  fetch or author turn. No new model, live roster, subscription, or broadcast
  is introduced by that response.
- Distinguished an available decision, a compatible active peer claim, and an
  unresolved material conflict. Only the latter can require a specific ownership
  conversation; merely working on the same resource is insufficient. Publication
  is still selective, and this optimization does not create a record requirement
  for unrelated private work.
- Documented limitations at the read boundary: omitted or late remote evidence
  is possible, a claim does not reserve filesystem edits, and the response cannot
  reveal unrecorded private knowledge. Existing concurrency controls and normal
  source revalidation remain necessary.
- Added corresponding future Q3/R7 checks and a comparison against plain update
  receipts with identical task worlds. Measure discovery, needless contact,
  missing matches, avoided lookups, and added context; no savings are presumed.
  Kept the common policy at its existing size by putting return semantics in
  tool descriptions and the protocol instead of lengthening every model prompt.
- Added plain definitions of shared answers and pending requests to the README.
  All 101 local Markdown targets/anchors, ten JSON files, and seven Python files
  validate. Both unchanged fixture/decision validation records match their source
  hashes. No extra model run, provider session, or production edit was needed.

Next: audit the twelve original design questions against actual evidence and
the smallest proposed release. Separate decisions the design resolves from
native capabilities and measured behavioral improvements that remain untested.

## Design completion audit

- Classified the preceding goal turn as progress: it corrected a concrete
  fixture leak and grading boundaries, and specified discovery during an
  already-required shared-work update. No process was left running or waiting.
- The user asked whether the goal was almost done. Stopped expanding the proposal
  and completed a requirement-by-requirement review of the original design scope,
  retaining autonomous necessary work as well as brief questions. The first
  release's narrower effect surface is a rollout sequence, not the whole goal.
- Re-read current introduction/question/answer prompts and the CLI wait ordering.
  Broad autonomous consultation is still invited over sparse evidence. Existing
  prompts already discourage acknowledgment loops; that useful rule is retained.
  Current wait handling checks inbound questions before returning the owner's
  completed exchange, supporting the proposed owner-priority change.
- Verified saved invocation and input-integration findings against current source
  hashes. Re-ran the synthetic Codex goal reproduction: initial origin is present,
  automatic continuation loses it, and an unproven typed lookalike stays unknown.
  No daemon, native agent, or terminal message was started.
- Closed the source-to-result provenance gap for the three abstract checks by
  reproducing their complete outputs and comparing them to saved JSON. All match:
  8,250 continuation, 6,807 exchange, and 35,364 wait-set orderings. Recorded script
  and report hashes in the closeout validation. These remain bounded models under
  explicit assumptions, not evidence of real autonomous behavior.
- The 52-check task-fixture record and 62-case/4,464-rendering decision record
  remain bound to their current source hashes. No model calls or live pilot were
  added. The final validation also checks document references and JSON/Python
  syntax and records research artifact hashes for later implementation review.
- Added `design-review.md` with all twelve questions, their concrete decisions,
  supporting artifacts, and retained limitations. Marked the README design ready.
  Native conformance, held-out agent behavior, recipient delay, and net usage
  improvements remain future implementation/pilot requirements, not completed
  results. No production code or preexisting work was changed by this research.

Design handoff: use `implementation-brief.md` and `agent-contract.md` first;
`protocol-and-adapters.md` defines precise effects and `conformance-plan.md`
defines the release gates. The design investigation is ready to close after
the final artifact validation, within the user's allotted investigation window.

Final artifact validation passed: 125 local targets/anchors, eleven JSON files,
seven Python files, and 33 recorded research artifact hashes. The design work
is complete. Production implementation and the separately authorized live pilot
remain the documented next stages, not unfinished actions in this design goal.
