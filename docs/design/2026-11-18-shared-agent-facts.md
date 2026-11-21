# One capture of an agent's display facts

The app frame and the component `shown` reply currently assemble name, terminal
membership and service publication information separately. This change shares
their per-row capture. It does not add a transport, widen a response, retain a
snapshot, or change which rows either caller lists.

## Design

`lib/agentFrame.ts` owns a pure `agentFacts` capture beside its existing app
formatter. It returns the current display name, the supplied terminal-membership
boolean, and the supplied opaque service fields. It does not copy the registered
row, resolve a path, read a transcript, compute device runtime state or interpret
an open turn as app activity.

The internal `CoreApi.agents.facts(row)` resolves the row against the current live
registry and captures those facts synchronously. A missing current row returns
unavailable. Its service fields are the same existing frame-parts reader that
the app uses; no feature-specific core record is added. Process-only CoreApi
implementations return unavailable, since their current wire replies do not
prove those facts. This method adds no service query or owner-tool request.
`agents.all()` is not a source: it includes stopped history and is now async in
the integration branch.

The real `agentFrame` formatter calls the same capture after `lastActivityAt`
settles. `backendSocket.toProject` and `core/main.projectFrame` retain their
existing pre-await terminal-membership read and their pre-await frame-parts
epoch capture. Name and ordinary row fields remain post-await reads, and service
fields still come from the fenced closure last, after other synchronous frame
providers as well as the await. A newer run's parts
cannot enter an older frame. Stopped formatting keeps its explicit unavailable
terminal and existing overrides. `selectedModel` remains the caller's existing
runtime-profile result; this capture adds no model lookup or await.

`shownAgents` reads `live()` in its existing order and asks for these same facts
once per row. It retains exactly its current public fields. Its existing DSH
context guard still requires the caller row's `dsh` and a string published `dsh`;
that compatibility projection does not become the meaning of the opaque parts.
The same small DSH-context projection is shared with the existing CoreApi DSH
reader rather than copied into another core module. An unavailable fact cannot
be reported as authoritative empty fields. No historical or cloud row is added.

The existing `turnStartedAt.has(sessionId)` callback is named once in composition
and passed to its two real readers: Wi-Fi's running state and recaps' quiet-turn
check. No timestamp or activity field is added. Desktop continues to derive its
turn lifecycle and completion metrics from events, not this capture.

## Proof and limits

RED first at the actual CoreApi/app/component boundary: a current registered row
has the same display and terminal facts as its real app frame, including service
parts published before attachment; an ended row and a process-only API are
unavailable. Existing `shown` payload keys and DSH guard remain unchanged.
Held transcript reads cover post-await name changes, pre-await terminal state,
and frame-parts epoch loss. Cover raw absent launch, explicit starting/ready/
failed launch and inactive registered rows without changing app defaults.

Selected checks cover agentFrame and BackendSocket callers, CoreApi and
experiment/messages shown readers, process-only API callers, recaps' open-turn
behavior, architecture and types. Changed core/service runtime files retain
100% coverage. The integration owner coordinates before/after app-list and
component-list cost evidence; no native or timing run is started by this change.

The complete external registered/window snapshot, bounds and compatibility
remain separate design decisions. This producer alone does not extract the
remaining Wi-Fi view, exclusive workspace guard, confirmed cancellation or
first-window focus/reveal doors.
