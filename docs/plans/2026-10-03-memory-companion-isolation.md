# Isolate memory and companions from the daemon

Companions and Memory form one optional product experience, implemented as two
separate subsystems outside the core daemon. The companion becomes useful through
what it remembers. Separating their implementation does not mean creating two
products, installations, or unrelated setup flows.

The Harness daemon will own machine execution, transport, authentication, and
ordinary agent lifecycle. It will not own memory capture, learning, recall policy,
companion personality, growth, collection state, or companion automation.

This document records the extraction requested on October 3, 2026, against
`35b57a9ce1d2ca792d353ab4d8b316cc759928d8`. The core-removal stage is implemented
on the isolated refactoring branch. The optional package builds as libraries,
with separate Companions and Memory APIs and an application composition layer.
It has no installed startup service or working desktop connection yet. See the
[package README](../../companions/README.md) for its runnable scope and gaps.

No installed services, user settings, or saved conversations were changed by
this extraction. The earlier [memory MVP](2026-10-03-personal-memory-mvp.md)
remains incomplete. This branch is a core-isolation candidate, not a claim that
companion memory works or is ready to release.

The product owner confirms that companion memory has not been released. The
refactor therefore protects existing Harness users and preserves development
data; it does not need a compatibility framework for unreleased feature clients.

## Required boundary

The daemon must build, start, serve ordinary clients, and shut down with the
optional package absent. Its runtime dependency graph must exclude both subsystems' implementations,
databases, model runners, artwork, and generated workers. Moving those imports
to another folder or lazily loading them inside the daemon does not meet this
requirement.

Ship one optional companion package. Within it, the Companions subsystem owns the
character experience, and the Memory subsystem owns durable knowledge. Each has
its own storage ownership, lifecycle and tests, joined by a small explicit API.
Keep memory's background workload in its own worker or process outside the core
daemon; the exact add-on process arrangement need not become a user-facing choice.

The optional package owns its startup, shutdown and bounded background jobs. The
daemon must not become its feature-specific supervisor or wait for it at startup
or shutdown. A companion's ordinary agent terminal remains a normal DSH session
managed through the existing agent API; it receives no special lifecycle rules.

```text
Desktop, CLI, mobile and other normal clients
                    |
        Existing Harness commands and events
                    |
              Harness daemon
       Sessions, transport, authentication,
       engine integration and device transport
                    ^
                    | existing authorized API
    +---------------+---------------------------------+
    | Optional companion package                      |
    |                                                 |
    | Companions subsystem <-- API --> Memory subsystem|
    | DSH and viewer                    Capture        |
    | Persona and growth                Learning       |
    | Collection and art                Evidence       |
    | Conversation and interaction      Recall         |
    |                                   Review and edit|
    +-------------------------------------------------+
```

Neither subsystem may import the other's implementation. Companions uses the
memory client contract. Memory ownership is the user and project, never an avatar
or companion terminal ID. Switching from Tim to GNU preserves what the system
knows about the person. There is no requirement to ship a standalone Memory app.

The companion DSH's explicit model selection supplies the memory configuration
through the contract. Memory owns its bounded inference jobs, rather than keeping
the foreground terminal alive. An unavailable configuration must remain
unavailable; it does not authorize a fallback account or provider. Provider and
framework adapters belong to the optional package, not core authentication.

Separate processes contain many failures but do not guarantee zero resource
interference on the same machine or create an OS security sandbox. The package
needs bounded concurrency, input sizes, queues, timeouts, retry backoff, and a
stop mechanism. It must never block the daemon's event loop with transcript
parsing, database queries, or model execution.

## Source inventory and destination

The table records dependencies in the original source and their extraction
responsibilities. Feature implementations and tests now live under
`companions/src/{companion,memory,application,shared}`. Core construction and
feature hooks have been removed. Application composition remains to be wired
to verified host capabilities; the moved modules are not running services.

| Current dependency | Extraction responsibility |
| --- | --- |
| [`cli.ts`](../../cli/src/cli.ts): `CodingMemoryRuntime`, `MemorySessionRoster`, `OpenCodeMemoryBinding`, settings, session-event ticks, pause and shutdown | Move capture, authorization mapping, settings, job scheduling and shutdown into Memory. Feed it only authorized input through the public client boundary. |
| [`authSession.ts`](../../cli/src/lib/authSession.ts): `memoryOwner`, `bindMemoryOwner`, refresh-time rebinding; `cli.ts` `/api/auth/me` interception | Core retains its general identity and revocation responsibilities. Memory maintains its own owner mapping. Remove memory-specific writes from the login file without resetting the sign-in, device identity, or refresh state. |
| [`hooks.ts`](../../cli/src/lib/hooks.ts), [`notify.mjs`](../../cli/hook/notify.mjs), [`hookServer.ts`](../../cli/src/hookServer.ts), OpenCode memory and recall plugins | Move native prompt context, provenance stamps, receipts and model-binding hooks into optional add-on adapters. Preserve ordinary session registration, turn and question hooks. Clean up only entries installed by this feature. |
| Memory runtime, client and native readers, formerly `cli/src/memory/`, now [`companions/src/memory/`](../../companions/src/memory/) | Move the entire memory workload outside the daemon. The optional package owns its storage worker, capture and orchestration; native reads may use synchronous SQLite only outside core. |
| [`cli.ts`](../../cli/src/cli.ts): `PairSensor`, `PairBrain`, `PairOwner`, `PairHarness`, rules, gates, fleet, journal, learning and reporting | Move companion observation, decisions, collection management and automation into Companions. Use ordinary agent commands; retain the relevant permissions and stale-question protections. |
| Intelligence, now [`application/intelligence.ts`](../../companions/src/application/intelligence.ts), and the removed `PairHarness.backgroundInUse` | Application composition binds the selected model to Memory's inference contract. Memory owns its background jobs; it cannot keep an ordinary terminal alive merely because learning is enabled. |
| [`dsh/runtime.ts`](../../cli/src/dsh/runtime.ts): automatic lesson installation; [`dsh/builtins.ts`](../../cli/src/dsh/builtins.ts): generated Pair package | Companion packaging belongs to its add-on. Lesson publication belongs to Memory through supported skill installation. Preserve ordinary DSH provisioning and already installed user skills. |
| [`backendSocket.ts`](../../cli/src/backendSocket.ts), [`localWsServer.ts`](../../cli/src/localWsServer.ts), [`applicationFrames.ts`](../../cli/src/lib/e2ee/applicationFrames.ts) | Remove feature handlers while preserving ordinary transport and authentication. Check that removing a feature frame cannot make sensitive input fall through to an unrestricted or plaintext route. |
| Identity, now [`companionIdentity.ts`](../../companions/src/companion/companionIdentity.ts), [`cableSession.ts`](../../cli/src/cable/cableSession.ts), zoo reporters and plate rendering | Companions owns traits, growth, artwork and rendering policy. Core retains only wire identity parsing and existing USB, status, notification, question and brightness transport. |
| [`build.mjs`](../../cli/build.mjs), [`build-bundle.mjs`](../../cli/build-bundle.mjs) | Move memory and plate worker payloads into the optional package. Package absence must be a supported core build configuration. |

Inspection of the original source established that its off state was incomplete:
authenticated profile responses can write memory ownership, and the OpenCode
message hook stamps provenance before checking whether learning is enabled.
Those core paths have been removed. These were observed code paths, not measured
evidence of a production incident.

## Existing APIs and unresolved gaps

Use the existing [command and event contract](../cli.md#automation) for normal
agent operations. Preserve the [DSH workspace contract](../../desktop/design/dsh-workspace.md):
viewer on the left and the real agent terminal on the right. A companion is a
client of this infrastructure.

Do not introduce a new daemon plug-in framework or an unrestricted extension RPC
to make the extraction convenient. First verify that existing APIs provide the
required identities, events and operations with appropriate authority. Specific
gaps still require investigation:

- Which existing client surface can provide scoped transcript access and revoke
  it promptly on logout, account change, or disabling learning?
- How can a native memory adapter verify the calling session and use its selected
  model without changing core authentication or copying credentials through an
  unrestricted endpoint?
- Which device API can accept optional companion presentation without moving USB
  ownership or allowing it to replace active questions and notifications?
- Which existing feature handlers can be removed together with the unreleased
  clients, and which shared code also serves released ordinary Harness features?

An unresolved gap disables the dependent add-on capability. It must not be filled
by weakening caller verification or silently widening core responsibilities.
Any necessary general protocol addition must have a separate, minimal contract
review under [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Extraction order

1. **Establish the ordinary Harness baseline.** Map dependencies from the daemon
   entry point, generated hooks and bundle inputs. Record normal-session behavior
   without companion memory. Identify unrelated fixes in shared files so the
   extraction preserves them. There is no feature-client migration requirement
   for companion memory that has not shipped.
2. **Extract the two subsystems into the optional package.** Move their
   implementations, tests and data ownership behind explicit interfaces. Prove
   they can run against the existing daemon API in a disposable environment. Do not run
   old and new learners against the same data, and do not duplicate active
   companion sessions during this preparation.
3. **Connect the unreleased companion experience.** Update experimental settings,
   viewer, CLI/MCP commands and device presentation to use the package. Keep one
   coherent setup and existing consent controls. Do not build a legacy feature
   bridge or an independent Memory app. Feature requests must never fall through
   to an unrestricted command or plaintext path.
4. **Remove feature runtime dependencies from core.** Delete construction,
   callbacks, timers, account metadata handling, native hook additions, special
   terminal lifecycle behavior and bundled workers. Verify the daemon with the
   whole companion package absent. Preserve security guarantees while removing
   feature-specific protocol handling.
5. **Validate the candidate and prepare a separate PR.** Review the removal diff
   against current main, preserving unrelated fixes. Merging, installing on a
   real user's machine, or publishing is a later action; no release is part of
   this assessment.

The current runnable intermediate state is the ordinary CLI plus independently
built optional libraries. Core safely refuses the old feature requests. The
experimental viewer, automatic learning, old companion CLI/MCP commands and dial
companion synchronization remain unavailable through this core build. Steps 2
and 4 have been performed at the module/build boundary; host integration in
step 3 and end-to-end feature continuity remain open. Normal Harness operation
cannot depend on their completion. A broad revert of earlier PRs is unsuitable
because unrelated later work shares their files.

## Data preservation and disable behavior

Preserve the developer's existing conversations, collection IDs, memories,
evidence, corrections and consent records. Prefer retaining their current paths
initially. If a move is necessary, stop the old writer, stage a copy, validate it
and retain the original for rollback. Do not build a customer data migration
framework for this unreleased feature. Do not grant new consent from an avatar
selection or duplicate a conversation merely to give the package a workspace.

Disabling Memory stops capture, inference, recall delivery and retries, revokes
active work, and leaves its saved data available for explicit management.
Disabling Companions stops its automation and presentation. Existing terminal
conversations follow normal save/stop behavior and remain recoverable. Neither
toggle changes authentication, ordinary terminal settings, normal notifications,
or other installed hooks. There must be no memory-specific message mutation,
background job, model call or probe when Memory is disabled.

Development installations can retain old native hook entries even after their
source is removed from the next CLI bundle. Clean up only entries owned by this
feature, preserve unrelated hooks, and test both enabled and disabled paths.

## Evidence required before merge

Choose the checks once under the [validation guide](../validation-and-release.md).
This crosses shared lifecycle and protocol surfaces and requires the full affected
component suites, relevant native integration checks and packaging checks.
Core and package tests, dependency-graph checks, standalone artifact checks and
private-terminal integration checks cover the extraction. Logs and the exact
validation scope belong in the ignored validation receipt and review summary.
No live application, real-device or private-conversation test has been performed
for the new integration, because that integration is not implemented yet.

| Required evidence | Acceptance |
| --- | --- |
| Core build and dependency audit | Neither feature implementation nor generated feature payload is reachable from the daemon bundle. Build and boot with the optional package absent. Test static, dynamic and generated dependencies. |
| Ordinary session regression checks | Start, discover, prompt, answer, cancel, stop, resume, reconnect and shutdown work with the optional package absent, off and enabled. Cover the shipped engine and client matrix. |
| Failure isolation | Kill, hang and overload the optional package and its memory worker; fill its queue or corrupt its own database. Normal terminal input, questions and daemon responsiveness remain within an agreed baseline tolerance. No unbounded respawn. |
| Identity and permission checks | Logout, account switching, session replacement and opt-out revoke work and discard stale results. Neither subsystem can self-assert a user, bypass a question approval or impersonate a remote machine. |
| Existing customer compatibility | Existing ordinary clients continue to work against the refactored daemon. Preserve encrypted transport, request correlation, saved sessions and user data. Unsupported optional capabilities fail only that capability. |
| Hook and device checks | Remove only owned native hook entries. Companion presentation cannot disrupt device status, questions, notifications, connection or brightness controls. |
| Feature continuity | One real supported conversation teaches a sourced memory used correctly in a later session. Companion switching retains the collection conversation and user-owned memories. |

The full refactor is complete when removing the companion package leaves a functional
daemon with no implementation dependency on either subsystem, and the package
delivers a companion that learns and remembers through the separate Memory API.
The current extraction establishes the build boundary; it does not yet establish
the second result. Passing module tests or moving files alone is insufficient.
