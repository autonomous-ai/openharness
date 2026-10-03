# Native session communication: Claude Code and Codex

Checked September 28, 2026. Installed versions: Claude Code 2.1.283 and Codex
CLI 0.154.0. These are separate-session messaging, delegated-agent coordination,
and host integration mechanisms; they should not be treated as one feature.

## What is established

| Surface | Discovery and addressing | Delivery / lifecycle | Evidence |
| --- | --- | --- | --- |
| Claude Code independent sessions | `ListAgents` discovers reachable sessions; `SendMessage` targets one. Its tools also cover subagents and teammates. | Native peer messaging; separate from experimental Agent Teams. | [Tools reference](https://code.claude.com/docs/en/tools-reference). |
| Claude Code Agent Teams | A lead creates named teammates; task tools can track ownership and dependencies. | Independent contexts, direct teammate messages, automatic completion notices. | [Agent Teams](https://code.claude.com/docs/en/agent-teams). |
| Codex delegated agents | Parent-directed agent tree with bounded delegated tasks. | The main thread collects results; current documentation requires explicit delegation or applicable project/skill instructions for local Codex. | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). |
| Codex CLI independent tasks | Installed TUI descriptors include `list_threads`, `read_thread`, `wait_threads`, and `send_message_to_thread`. | They advertise listing, reading, waiting, and sending follow-up prompts through the connected app server. | Static installed-binary evidence; runtime exposure was not tested. |
| Codex CLI human controls | `codex agents` browses shared-daemon sessions. `codex queue --thread … --message …` addresses an existing session by UUID or exact name. | Explicit queueing is distinct from browsing. | Installed CLI help, not a claim about all Codex clients. |
| Codex host integration | App-server exposes thread listing/reading and explicit turn operations. | `thread/inject_items` adds context without starting a turn; `turn/steer` requires the expected active turn ID. | [App-server](https://learn.chatgpt.com/docs/app-server); installed generated schema confirms these interfaces. |

Claude's independent-session messages contain text, not automatic transcript or
file transfer. Active recipients read them between tool calls; idle recipients
can start a turn. Same-machine transport uses a session socket. Inbound controls
can accept, hold, or refuse. Duplicate/rate limits constrain loops. A one-shot
idle subscription can observe a peer without starting work there; its notice
can still start work in the subscriber. Directory reach extends beyond a
Harness swarm. These are transport behaviors, not proof that a message is
necessary. [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

Codex's installed TUI descriptions distinguish reading another task from giving
it more work. They label retrieved titles, summaries, and task content as
untrusted data. The separate subagent descriptors scope `list_agents` to the
current root tree and distinguish a message from a follow-up that starts a turn.
Those descriptors are not an end-to-end test of the independent-task tools.

See [native-evidence.json](native-evidence.json) for versions, binary/schema
fingerprints, and reproduction commands. No model work or peer contact was
started. Public Codex documentation did not fully describe the installed TUI
task tools; absence from those pages does not mean the capability is absent.

The original “Message from @…” display alone cannot establish which topology
produced it. Claude's message tool covers delegated agents, teammates, and
independent sessions. The independent-session capability is supported by the
documentation above; it should not be inferred solely from the toast's wording.

## What this means for Harness

The useful separation is **discover → read → contact → resume**. Each step has
a different cost and authority. A directory lookup should not wake anyone.
Reading an existing answer should not ask its author to regenerate it. Asking
a question should not automatically authorize unlimited work. Receiving an
answer should not automatically revive a superseded task.

The transports answer how to reach another session. The product still needs to
answer why this dependency needs this peer now. Neither the official pages
reviewed nor the inspected interfaces establish an enforced rule requiring
current ownership evidence and a necessary blocked action before every contact.
This is a bounded finding, not a claim about undisclosed provider internals.

### Borrow

1. **Separate passive information from work.** Give Harness a directory/read path
   and dependency subscriptions that do not become prompts in the observed peer.
2. **Separate information from continuation.** A reply belongs in the ledger even
   when no model should run. Resume only a task that still needs that reply.
3. **Bind delivery to identity and task state.** A stable recipient ID prevents
   name collisions. An expected task/turn generation prevents stale delivery
   from becoming current work. Codex's turn precondition is a useful primitive;
   a native turn is still not the same as a human task spanning several turns.
4. **Preserve provenance.** A peer statement is a peer statement. It does not
   become a human instruction, approval, verified artifact, or ownership claim
   merely because the transport successfully delivered it.
5. **Make the exchange inspectable.** Show the short request, selected peer,
   reason for selection, result, and whether the result was used. Keep routine
   presence and delivery bookkeeping out of the conversational history.

### Do not adopt as defaults

- A global session directory as the authorization boundary for a swarm.
- Wake-on-every-message, routine idle notices, membership introductions that
  start model turns, or acknowledgments that invite another acknowledgment.
- Full-transcript retrieval merely because a provider supports it. Published
  decisions and versioned artifacts are a more selective first source.
- A lead-and-workers hierarchy for every swarm. The user already groups
  independently owned harnesses; they need occasional dependencies resolved,
  not a coordinator manufacturing parallel assignments.
- Rate limits as a substitute for necessity. One unnecessary question can be
  wasteful even when it is far below every transport limit.

## A scope gap requiring an explicit design decision

Harness currently validates its own channel operations. Provider-native
messaging follows provider identity and session boundaries. Therefore, a
Harness channel gate alone cannot establish that every possible peer contact
stays in the originating swarm. This follows from the independent discovery
surfaces above and the current [channel audit](baseline.md).

The implementation needs an adapter capability contract: which native
cross-session tools exist, whether their discovery and sends can be constrained
to the task's swarm, and whether input provenance survives delivery. Native
delegated children must be distinguished from unrelated independent sessions.
Do not silently disable all `SendMessage` use: Claude uses it for delegated
agents too. Do not change global provider settings as a side effect of enabling
one Harness feature.

Where selective enforcement is unavailable, document the narrower guarantee:
Harness-mediated communication is scoped. A prompt instructing agents to use
that route is useful behavior guidance, but it is not equivalent to enforcing
all native routes. A same-user terminal remains capable of other communication;
this is product coordination scope, not an OS isolation boundary.

No provider controls were changed during this investigation. Selective native
tool interception, bypass coverage, and compatibility with nested agents remain
verification requirements before promising comprehensive scope enforcement.

## Integration opportunities to verify

Both providers document hook context delivery. Codex permits additional context
at session/prompt hooks; supported asynchronous hook output waits for an active
turn's safe point or the next user turn instead of starting one. Claude also
supports context through session/prompt hooks.
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude hooks](https://code.claude.com/docs/en/hooks).

That suggests a replacement for unsolicited membership prompts: inject a small
capability notice into an already authorized turn, then let a real dependency
trigger discovery. In this worktree, `cli/hook/notify.mjs` currently reports
lifecycle events and explicitly does not inject prompt context. Hook support in
a provider is an opportunity, not a feature Harness already implements. Verify
installed-version behavior, hook trust, session identity, reconnects, compaction,
and provider-specific precedence before changing that path.

An idle event is insufficient evidence that an artifact is ready. A migration
worker may be idle because it failed or needs permission. A Harness dependency
subscription should target an explicit result or work-claim transition, with
version and failure state, rather than interpreting every idle event as success.

## Grok source cross-check

The pinned public Grok source exposes `send_subagent_message` for an owned-child
relationship, with `parent` supported through a granted sender. It distinguishes
steering, queued delivery, and interjection; an eligible inactive child can resume.
Its output separates accepted admission from rejection and uncertainty. These
are useful protocol distinctions, not evidence of arbitrary independent-session
messaging or of a particular installed binary's runtime behavior.
[Pinned message tool](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-tools/src/implementations/grok_build/send_subagent_message.rs).

The sender capability carries child identity, native session, attempt, and
generation. It applies a concurrency permit and a per-attempt outbound bound.
This supports the design choice to keep identity and limits outside free-form
message text. It does not establish a root-wide budget from this file alone.
[Pinned sender](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-tools/src/implementations/grok_build/task/agent_message_sender.rs).

The reusable lifecycle code binds deliveries to prompt identity and epoch,
separates pending/projecting/delivered state, and distinguishes terminal causes
when returning fallback candidates. A fallback is still a policy decision for
the caller: Harness should not turn every undelivered context item into a new
idle prompt. [Pinned delivery lifecycle](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/common/xai-message-delivery-core/src/lifecycle.rs).

Tool-hook provenance needs a separate check. Although the common hook schema
has an optional prompt ID, this revision's pre-tool constructor and inspected
post-tool path pass no prompt ID. The envelope builder does not infer one.
They retain a tool-use ID, but the adapter still needs a verified relation from
that call to the task/input that authorized it. A prior prompt-gate event or the
daemon's latest session state is insufficient to bind a delayed tool call.
[Pre-tool constructor](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs#L2788),
[envelope constructor](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session/hooks.rs#L143).

The public revision differs from the installed build. These source reads start
no session, prove no cross-provider route, and do not close Grok's outstanding
adapter conformance requirements.

A follow-up through the MCP tool and workspace bridge paths finds no automatic
forwarding of native task origin: the inspected handlers ignore the tool-call
context and construct outgoing calls from name/arguments. A session-ID header
does not distinguish two inputs in that session. This leaves MCP useful as
transport while keeping invocation binding as a separate adapter requirement;
it is not evidence that no possible extension can provide that binding.
[MCP dispatch](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-mcp/src/servers.rs#L1584),
[bridge handler](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/common/xai-computer-hub-mcp-adapter/src/bridge.rs#L233).

The same MCP source is useful for waiting: tool calls have configurable timeouts,
and cancellation of a pending call notifies the server. Selected transport
failures can trigger recovery and a retry with the same parameters; the inspected
timeout branch itself does not retry the slow operation. This makes an attached
event wait a candidate to test, while requiring stable service operation IDs,
route-specific cancellation, and no automatic fallback to a later idle prompt.
It proves neither responsive human steering nor quiet waiting under native goals
in the installed build.
[Call lifecycle](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-mcp/src/servers.rs#L1907),
[cancellation notification](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-mcp/src/servers.rs#L2083).

There is a more promising correlation in persisted updates. The pending tool-call
notification is created before the pre-tool gate. `send_update` stamps the
currently running native `promptId` into its outer metadata; the persistence
path retains that notification. The checked-in Harness fixture contains four
tool-call IDs with prompt mappings and no conflicting mapping in its eight
updates. Current `GrokNormalizer` parses outer metadata but does not carry that
prompt identity into normalized tool-start events. This suggests a source of
invocation evidence without starting a new managed session; it is not yet a
verified adapter.
[Pending call event](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs#L1485),
[notification metadata](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/updates.rs#L299).

The native prompt ID remains too coarse on its own. This revision can inject
human steering into a running turn. The inspected drain submits new conversation
items and persists interjection-marked user chunks without replacing the outer
`current_prompt_id`. Thus calls on both sides of accepted steering can still
share one prompt ID. The adapter needs a proven input-admission/call relation,
including steering and delayed persistence, rather than a `promptId`-to-latest-
input lookup. A pending event enqueued before the hook is not a guarantee that
its persisted line is available to that hook yet. The fixture does not test
these orderings or the installed build.
[Steering drain](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/interjection.rs#L332),
[persisted interjection](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/interjection.rs#L203).

## Consequence for the communication policy

Prompt submission also needs to be distinguished from acceptance. Claude and
Codex both document that `UserPromptSubmit` hooks can block processing. The
pinned Grok gate dispatches that event before applying the verdict. In current
Harness source, the notification goes from `hookServer.ts` through `cli.ts`
directly to `SwarmPromptScopes.started`; that path alone cannot establish a
post-gate acceptance receipt. A quiet context hook and an authority boundary
therefore need separate verification.
[Claude prompt hook](https://code.claude.com/docs/en/hooks#userpromptsubmit-decision-control),
[Codex prompt hook](https://learn.chatgpt.com/docs/hooks#userpromptsubmit),
[pinned Grok gate](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L908).

Before spending another harness's attention, require:

- A concrete next action that depends on the answer or artifact.
- A bounded explanation of why an accessible local source cannot resolve it.
- Current evidence connecting one exact peer to that dependency.
- A task-bound delivery and continuation policy.

The daemon can validate identity, scope, versions, expiry, deduplication, and
continuation state. It cannot prove semantic necessity just because a model
filled out those fields. That judgment needs adversarial evaluation alongside
real task outcomes and total participant cost.
