# Cloud response policy boundary

## Design

The Cloud component already owns create, delivery, answer, rename and Stop operations. Core currently also converts their results into public replies, chooses answer-error wording, builds a rename event and renders the rename reply from its captured accepted owner row. Move that response preparation through the existing Cloud port. This changes no catalogue, journal, provider storage or process count.

The private port carries these already-prepared results:

- Create: the existing public `{agent}` or `{error,detail?}` reply. The component's current creation-id deduplication and provider operation remain unchanged.
- Answer: the existing public question result, including `STALE_QUESTION` versus `ANSWER_FAILED` and the current empty-detail behavior. Core still selects the exact current accepted request and owner before routing.
- Rename: the public `{agent}` reply plus its exact `agent_renamed` frame, or the existing public refusal. Core passes the bounded accepted row captured at request admission so rendering preserves the old snapshot semantics even if provider state changes while the request runs. This is one request's transient input, not another cache. Identity, engine, created-at and current physical service authority must still match before forwarding a rename event; a removed/replaced owner or old service cannot publish a late result. The renamed public frame and event must agree on owner/name/engine.
- Stop: the component prepares the final `{deleted:true,detail?}` or public refusal. The core retains the current three-second deadline and its existing fallback while Cloud is hung or slow. Moving that timer into the feature process would lose the bound when its event loop hangs. This patch does not claim that fallback wording has been extracted.
- Deliver keeps its existing `CloudResult` because it is already the caller's consumed shape.

Core keeps the existing absent-owner fallthrough, name admission (`MISSING_NAME` without waking a feature), missing-update refusal and opened-agent read. Those read/routing paths are the separately documented remaining boundary. Core admits bounded response shapes and matching identities, forwards the component-prepared results and supplies the existing unavailable fallbacks. It never loads the component response module. No new core map, history, receipt or renderer is added.

For physical response fencing, reuse the existing service-start wait and per-connection port identity pattern already used for Wi-Fi. A cold call waits for the existing bounded first-start gate before capturing its current port. Connected/disconnected callbacks replace the Cloud port object without retaining a history. The final caller checks that port identity and owner identity synchronously before any rename event. Pending service calls still use serviceLinks' existing deadlines, physical-connection association and replacement refusal; no request is replayed. The inline path keeps its existing host guard and refuses effects after that service is disabled. The Stop deadline begins immediately and covers readiness as well as the provider wait.

The wire change is private to the unreleased whole artifact. Core and component must update together; rollback restores both. Saved provider and publication-journal formats are unchanged. Reply material is ephemeral and bounded by its existing normalized owner inputs and the private response envelope; it contains no credentials or new logged identifiers/content. Malformed output fails visibly through a fixed refusal, never as success. Each prepared reply is admitted with the existing bounded JSON walker at 256 KiB before copying; malformed records and mismatching rename owner/name/engine/created-at refuse with the existing unavailable reply and a content-free `CLOUD_RESPONSE_INVALID` log. The transient rename input is admitted in the component at 512 KiB, normalized through the existing owner reader and matched to the provider owner before mutation. Ordinary normalized frames remain below the reply bound. These are per-request allocations; no retained data or catalogue grows.

## Validation selected before edits

RED tests at the real service port for prepared create/refusal, answer failure, captured-row rename output, final Stop output and creation-id deduplication. Core controls cover absent/removed/replaced owner, malformed/wrong-owner rename response, a response resolved just before physical replacement, cold-start capture and unchanged public replies. Fake timers prove Stop still returns at its existing deadline while the component stalls, without fixed sleeps or a second provider invocation. Inline and process adapters must expose the same prepared replies, and malformed replies cannot cause client effects.

After implementation: pinned Node 24.22.2 typecheck; affected service, component response, core owner, core link and process adapter tests with one worker and per-file coverage on changed core/service modules. Reuse unchanged publication recovery evidence unless a changed dependency warrants its affected slice. Parent coordinates combined core/harnessd, packaged proof and any later cost comparison; none is implied by this source patch. Runtime diff goes to parent before checkpoint/commit.

Platforms are macOS source validation here and platform-neutral TypeScript on Linux/Windows; Windows execution is deferred by the user and mobile is outside scope. The frozen publication-cost packets and original connected-performance hold remain unchanged.

## Source evidence

- RED: `20261118T143103.265952Z-96629`, 29 passing and six intended failures: prepared real-service replies plus rename responses after owner removal/replacement or physical service replacement/disable.
- First implementation: `20261118T143433.217375Z-3543`, 181/184 tests passed; the three old-shape/stable-port fixtures and TypeScript predicate narrowing were corrected. This failed receipt is preserved, not counted as a passing gate.
- Affected final source: `20261118T143700.009142Z-7570`, pinned Node 24.22.2 typecheck and 193 tests across 12 files passed. Core owner admission, core link, process adapter and component response modules each reached 100% statements/branches/functions/lines (252/299/85/188 aggregate). This includes cold readiness, pre-call owner removal, resolved-before-replacement fencing, malformed/oversize response admission, captured projection stability, current-provider identity and the unchanged immediate 3,000ms Stop bound.

Receipts are under this worktree's `.harness/validation/`. Source tests cover inline and IPC adapters; final real packaged cold-start/restart proof is still owned by the integration coordinator. No new timing or native execution was performed for this patch. The 24-arm correction packet proves retained reconnect savings but does not accept connected publication cost against the original pre-extraction baseline.
