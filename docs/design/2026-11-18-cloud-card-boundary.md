# Cloud card transitions belong to the Cloud component

## Design

The Cloud service already renders the last answer. Move its transition policy and
last-notified-answer map out of `core/agents/cloud.ts` too. The existing private
Cloud publication carries the complete harness list and zero or one prepared card
per harness in the same message. Core validates that every card belongs to a
published Cloud harness before forwarding it; terminal/session ownership and
question answer authority remain unchanged. No new process, broker, listener or
core-side feature cache is introduced.

The component suppresses old answers on its first publication, emits working
cards for busy harnesses, and preserves the existing working/done/error/summary
transitions thereafter. A reconnect republishes working cards so a replacement
core can restore existing observers. A surviving core can receive the same
working card again; these cards have no completion notification and overwrite the
same tile. Completion summaries are never replayed merely by reconnecting.

Growth: the component retains one busy bit and notified-answer string per Cloud
harness, deleting both when that harness disappears. Core loses its separate
notified-answer map. Existing Cloud list growth is unchanged; this increment does
not establish a bound for the persistent Cloud catalogue. Each publication has at
most one card per row and remains subject to the existing private IPC frame bound.

Concurrency: publication and card calculation are synchronous in the Cloud
component, and list/card admission and emission are synchronous in core. There is
no await between selecting a published owner and emitting its card. Existing
per-harness service queues and question-before-list ordering remain in force.

Read cost: no filesystem or network read is added. Only transitions produce cards in the component; no extra timer or polling loop is added. Measure the same fixed
publication workload before/after at current and 10x row counts, including IPC
bytes and core/worker CPU separately. Catalogue growth remains a separate limit.

Compatibility: this is private worker protocol under the already-unreleased
contract 3 cohort. Contract 2 cohorts run their original complete implementation;
the supervisor reaps workers before changing cohorts. Public app frames, stored
Cloud data and the last 30 days of client contracts are unchanged. The service
still computes cards for legacy stored rows before publication. Removing core's
pre-13-November missing-card renderer does not change whole-build rollback.

Migration/rollback: no stored format changes or migration. Roll back the complete
cohort; never mix private worker implementations. Audience: only the authenticated
Cloud service can publish, and a card can name only a Cloud row in that publication.
Identity: no login or launch authority moves. Failure: malformed card batches are
refused with a fixed log code, without content; an unavailable Cloud process costs
its cards, not terminal agents. Platforms: portable TypeScript on macOS/Linux;
Windows execution is deferred by the owner.

## Validation selected before implementation

First reproduce the missing component-owned transitions and core synthesis on
the current code. Cover every prior transition, unchanged rows, stopped/deleted
rows, reconnect and initial suppression; reject mismatched, duplicate, oversized
or malformed card batches before emitting any part. Run affected Cloud service,
process adapter, query and core suites with 100% changed-core/service coverage,
architecture and types. Run the existing packaged Cloud flow once on the combined
build; use its fake adapters and private daemon state. Independent review and
matched publication costs remain required before acceptance.

Question construction, Cloud agent-list presentation and other feature routes
remain explicit residuals; moving transitions alone does not finish all extraction.

## Source checkpoint

The original code fails both behavioral REDs: the real Cloud service supplies no
prepared card, and core synthesizes cards when no component card was supplied
(`/tmp/core-cloud-cards-red-20261118.log`, two failures). The first combined run
exposed two private publication-shape changes from normalizing the transmitted
rows; those original row bytes and cached rendered-card identity are restored,
while transition calculation uses the same normalized owner projection as core.
The existing query test now asserts the additional private card argument.

All 77 selected cases pass. The first scoped coverage collection exits 1 because
it omits the existing Messages link caller of the shared refusal logger; all three
other selected files reach 100%. The final selected collection includes that
caller. Types pass. Packaged checks, cost measurement and independent review are
still outstanding; this source checkpoint is not release acceptance.

The final fixed-source receipt `20261118T051021.783039Z-35208` exits 0: 130 cases
across nine suites, architecture included, and types. All four selected runtime
files have 100% statements, branches, functions and lines (334/332/149/255).
