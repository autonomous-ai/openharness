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

## Counter transport cost

The first fixed ABBA comparison (`/tmp/core-service-counter-cost-v1`) holds source, Node,
40 samples and 10,000 observations per sample. CPU rises from 14.8395 to 21.7035 ms per
sample; elapsed median rises from 14.8024 to 20.8930 ms. The serialized observations grow
from 890,000 to 1,305,000 bytes per sample. Both preparation and measurement exit zero,
with EOF, process groups, guardians, private roots and unchanged hashes verified. This is
a performance hold. The fixture uses the real main callback and counter functions, but
substitutes null-returning unrelated query handlers and an in-memory JSON hop; it is not
whole-daemon or kernel IPC evidence.

A separate two-million-observation profile attributes 2,367 of 4,011 sampled milliseconds
to the serialization adapter and 379 ms to the bundler's function-name helper. Native
JSON work may be inlined into the adapter; these are not separate stringify/parse times.
The new per-call reporting arrow invokes that name helper in the production build too.

Correction before acceptance: retain one bound reporting callback per BackendSocket and
carry service observations on the existing flat `usageCounter` frame with its authenticated
service field. The gateway must send every frame containing that field through service
admission, including malformed fields; it must never fall back to the unrestricted core
counter path. Existing core counters without that field and other usage events retain their
formats. The already coordinated private worker contract 2 covers this unpublished encoding.
No extra queue, timer, retained observation or process is introduced. Tests first cover
callback ownership, exact bounded wire shape, provenance admission and malformed-source
refusal, followed by the existing recorder/backpressure gates and a frozen comparison.

The corrected source `6073cfcfca` passes all 328 affected cases and types; the changed
core gateway link retains 100% coverage on all four measures. The three new transport,
admission and callback-ownership checks fail before the correction and pass after it.
The revised comparison extracts the production gateway proxy methods and receiver switch
in both arms, retaining the same 40 samples and operation counts. Baseline `963b6a5b66`
versus corrected source has elapsed median 14.1041→12.6841 ms and CPU median
14.1265→12.7900 ms per 10,000 observations (−10.07% and −9.46%). Authenticated service
provenance increases wire bytes from 890,000 to 1,105,000 per sample. Every observation is
acknowledged and counted exactly once. This clears the measured isolated-path regression;
it does not establish native IPC or whole-daemon cost. Unrelated query handlers, the common
BackendSocket guard and the final product recorder remain outside this fixture.

All four arms, preparation and their ownership checks pass. Evidence is retained at
`/tmp/core-service-counter-cost-v4`, manifest
`e0eb9cdf5e0ec85cd407436fe3c108b045a2af254dcf68686938f2a86197009f`.
V2 fails during warmup because the fixture generator joined `return` to `default`;
V3 fails its preparation smoke because the expected four-frame byte sum was miscalculated.
Both have zero timed samples and proved process cleanup, with their private failure roots
retained. V4 corrects only those fixture errors, validates the wire before timing, and keeps
the product sources, fixed workload and earlier V1 regression evidence unchanged.
