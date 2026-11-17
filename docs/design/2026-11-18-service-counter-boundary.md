# Service counter admission in the gateway

Core currently imports the entire product-usage and health vocabulary through
`agentQueries -> serviceMetrics`. Move metric-name and originating-feature admission to the
existing gateway recorder. Core forwards one bounded raw event through the existing usage
channel, with the service name taken from its authenticated service-link callback. The payload
cannot supply that provenance. No new RPC, queue, service, filesystem operation or await.

## Design

- Growth: no new stored data. Existing optional usage reporting retains its existing 35-day
  counters and limits. A raw metric name is at most 128 ASCII lower-case letters, digits and
  underscores; the gateway accepts only the existing fixed vocabulary. No content or arbitrary
  name is recorded. Existing 64 KiB usage backpressure drops optional events rather than queueing
  them for restart. No replay, timer or per-service retained state is added.
- Concurrency: forwarding and final vocabulary admission are synchronous. Core captures the
  authenticated originating service, never an origin supplied in the request payload.
- Read cost: no state scans, network round trips or new reads. The gateway already loads the
  vocabulary for reporting; it checks one bounded name and source.
- Scale: constant bounded event size and no new cardinality. Existing queue pressure remains the
  first warning; measure fixed event forwarding before/after and core closure separately.
- Compatibility: public clients and stored reports are unchanged. Private count-query `ok` now
  acknowledges a structurally valid observation, not vocabulary admission; the existing callers
  discard this reply and already treat reporting as optional. Invalid names never reach a report.
  This private semantic change bumps the executed worker contract; immutable cohort admission
  excludes mixed old/new core and workers. No public 30-day adapter is removed.
- Migration/rollback: no data migration. Roll back the whole executed build cohort. Inline feature
  callers retain their existing typed counter path; their implementations are already outside
  the default core load.
- Audience: gateway admits Browser names only from agentBrowser, and Hachi daemon names only
  from hachi, goals or agentCleanup. App counters, derived launch/day counters and arbitrary names
  stay excluded. Existing raw core request-outcome events keep their own recorder path.
- Identity: only a fixed service role is added; no person, machine, session, path or account identity.
- Failure: absent or congested gateway keeps the existing best-effort reporting behavior. It cannot
  delay session work or wake/restart a reporting process. Malformed query shape is INVALID_REQUEST.
- Platforms: TypeScript control flow on macOS/Linux/Windows; no process/platform behavior changes.

Validation chosen before runtime edits: caller tests for forwarding and forged-origin stripping;
recorder tests for all declared allowed metrics, disallowed origin/name combinations and no duplicate
recording; the existing gateway transport/backpressure tests; a default-core closure assertion;
per-file core coverage and TypeScript. Independent review and fixed cost evidence precede acceptance.

## Validation checkpoint

The first regression run fails three cases: authenticated observation forwarding, gateway admission,
and the core import boundary. All three pass after the change. The five affected caller suites pass
310 tests; that run exits nonzero only because it exposes an existing recorder branch coverage gap.
The added duplicate-receipt case exercises the real outcome emitter and the recorder's independent
later-receipt defense. The final three-file run passes all 16 cases, with agentQueries, usageEvents
and serviceMetrics at 100% statements, branches, functions and lines. Typechecking passes.

The first worker/architecture batch passes 205 cases and fails one stale core-inventory assertion.
Removing precisely the three vocabulary modules from that inventory makes all 31 architecture
cases pass; the 175 passing worker-contract/admission/reexecution cases cover the unchanged cohort
bump. No worker test is described as a passing combined suite. The initial sandboxed caller run
also remains a failure: process-identity inspection was denied; the permitted run passes all 310.

Exact local receipts: `/tmp/core-service-counter-red.log`,
`/tmp/core-service-counter-focused-owned.log`,
`/tmp/core-service-counter-final-coverage2.log`,
`/tmp/core-service-counter-architecture-contract.log`,
`/tmp/core-service-counter-architecture-green.log`, and
`/tmp/core-service-counter-final-types2.log`.
This checkpoint establishes scoped macOS behavior, coverage and import removal, not independent
review, hot-path cost acceptance, other-platform execution or final combined release gates.
