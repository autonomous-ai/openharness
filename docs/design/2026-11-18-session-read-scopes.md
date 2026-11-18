# Existing session membership scopes for complete reads

## Design

Keep ef4cc699de and the v5 packet immutable. The v5 smoke proves equal complete outputs, but also proves
material reply expansion: at 1600 registered rows, WiFi 396,779 -> 994,209 bytes; Devices 4,576 -> 999,015
bytes. DeviceSession consumes eight advertised physical rows in this fixture, while the complete read
currently sends all 1600 occupancy rows. Timing is held. This proposal corrects that specific membership
mismatch without a new catalogue, retained view, feature filter, epoch, storage or poller.

Use the two existing meanings: registered physical sessions and advertised physical sessions. In the
current Registry source, advertised() is exactly list().filter(row => terminalAvailableAgents.has(row.agentId)),
with insertion order preserved. It does not use row.active, launch readiness, sessionId or an engine filter.
The stopped-history collection is separate and remains unread. Both complete-read scopes retain the
existing eligible Cloud member append/order (WiFi still ignores Cloud in its own projection).

Add Registry.advertisedRows(), returning an iterator over the same current map with that exact existing
terminalAvailableAgents predicate. advertised() becomes Array.from(advertisedRows()). rows()/list()
remain the registered path. Admission checks Registry readiness before returning the iterator. The
producer synchronously walks the selected iterator once, charging bounded IDs before retention; it
never allocates an entire registry array. The Registry owner confirmed no overlap and the predicate/order.

## API and authority

CoreApi.agents.readSessions(scope, receive, signal?) requires an explicit 'registered' | 'advertised'.
Actual WiFi readers select registered; actual Devices readers select advertised. The exported producer
can accept the scope as a last argument after its explicit dependencies/receiver/signal; the public
CoreApi wrapper requires it. The row/header shape, physical settled pump and all resource bounds remain.

Use two named declared generic reads, session_read_registered and session_read_advertised, replacing
session_snapshot. This uses the existing read transport without adding request-body forwarding or a
new query mechanism. SERVICE_HOSTS grants WiFi only registered and Devices only advertised, matching
actual callers; no other service gets either. The existing derived WORKER_PLAN changes because the
route declarations change; WORKER_CONTRACT stays 3. Both directions of old/new cohort admission refuse.
readCoreSessions receives the explicit scope and chooses that declared read. No public setting is added.

## Membership and changing facts

- Registered: every captured Registry ID is still visited, including inactive, unbound, starting and
  terminal-unavailable rows. WiFi occupancy can never use the advertised scope. Deletion emits gone;
  same-ID replacement/rebind emits the current row; late new IDs stay out until the next ordinary read.
- Advertised: membership captures exactly IDs terminal-available at admission, followed by eligible
  Cloud IDs. An unavailable row becoming available afterward is outside this capture, as a late eligible
  member. An unread captured ID that is deleted emits gone. A current replacement is read under the
  existing per-row identity fences. If its captured current shared facts say terminalAvailable=false,
  emit gone instead of a row; the final component projection remains equivalent to its existing filter.
  A removal/availability loss after an emitted row can remain until ordinary refresh, as in the explicitly
  approved per-row interval semantics. No atomic whole-time snapshot is claimed.
- Current selected model and turn state are read before shared facts, parts last; final byAgent identity
  is checked after facts. No new provider runs after parts. Availability is the existing shared-facts read,
  not a fabricated global revision. Cloud stopped filtering and current metadata lookup are unchanged.
- Machine/computer/sign-in/environment, service connection, component generation, physical credits,
  deadline, cancellation and provisional-only-until-end behavior are unchanged. Scope grants no create
  authority; final canonical create admission remains untouched.

## RED and compatibility plan

1. Actual producer RED: 1600 registered rows with eight advertised, through the current receiver/pump,
   must emit eight physical row records for advertised and all 1600 for registered. Pass the proposed
   scope as the ignored extra producer argument on the pre-change implementation so the RED is actual
   extra rows, not a missing function/type-only failure. The registered control includes hidden occupancy.
2. Actual producer races: captured advertised member loses availability before emission -> gone; a
   formerly unavailable member becomes available after admission -> excluded; current same-ID rebind
   remains included only if its current facts are terminal-available; deletion -> gone. Registered controls
   continue to carry all unavailable rows. Keep existing provider mutation/parts-last/final identity REDs.
3. Actual Devices facade consumes only the advertised route and preserves every DeviceSession field,
   Cloud append, order, machine/account/window facts and all provisional/reconnect guards. Actual WiFi
   consumes registered and preserves complete Store occupancy, including 4097 rows and large valid parts.
4. Actual Registry iterator proof: readiness refusal, same object identities/order as advertised(), same
   predicate as availability toggles; no additional retained map. Reuse existing Registry fixture custody.
5. Scoped rights and final cohort refusal; ordinary query and question paths untouched. Selected 100%
   core/services coverage, affected actual callers and types. No broad leanEntry rerun or native/timing.
6. After source review, a fresh smoke packet must prove equal outputs and the reduced Devices byte path
   over the exact nine frozen scenarios. The v5 packet remains evidence of the original cost regression.

## DSH duplication analysis: keep the existing fields for this slice

The large fixture legally publishes two 1.6 MB strings and stores the same strings in Registry.dsh, so
current read rows encode both session.dsh and facts.parts.dsh. WiFi intentionally selects the published
value only if it is a string, otherwise falling back to raw Registry.dsh. Devices uses neither package
field, and advertised scope already excludes those two hidden fixture rows (indices 8 and 9).

An app's AgentFrame is not an interchangeable single effective package fact today. agentFrame captures
its name after the existing await, builds raw dsh, reads the fenced parts last, then Object.assigns all
parts. frameParts accepts null/non-string JSON for declared dsh; a null publication overwrites the app's
dsh with null, while WiFi falls back to the retained package string. shownAgents' agentDshContext also
has its deliberate session.dsh truthiness guard. Raw absent/null and a present published string are
likewise distinct in those existing caller contracts. Collapsing these into appFrame.dsh would be lossy.

Do not add a WiFi-only effective-package helper/field, equality sentinel, cache, dictionary or string
interning protocol merely to hide this cost. Keep both existing facts in this scope correction. Before
any later DSH narrowing, the required positive controls are raw absent/null/string versus published
absent/null/non-string/different-string/same-string, current publication epoch invalidation, actual app
frame ordering, shown-row guard and exact WiFi fallback. A real shared fact contract with actual callers
must be reviewed first; no such runtime change is included here.

## Remaining limits

This removes the all-registered transfer from the Devices reader. It does not claim WiFi byte/cost
acceptance: its full registered facts still exceed the original purpose-built projection. Existing
8 MiB membership / 16 MiB frame/global credit / 64 MiB component projection / 20 s limits remain
provisional. Mixed-host step/scroll and canonical-create doors remain explicit separate extraction gaps.


## Source evidence

Base: integrated `e22df56bc7431cc4fb4ef9e7b7f813931cbad54b`, isolated worktree
`/tmp/harness-core-session-read-scopes`, pinned Node 24.22.2 and dependency lock SHA
`a578fb81a3757cfd14de2c687dfe9b7f687d56f8c0112082edf640245995ea61`.

The actual pre-change producer RED ran before runtime edits. Receipt
`.harness/validation/20261118T151254.053606Z-54531/receipt.json` records two failures and exit 1:
advertised output contained 1600 rows instead of eight, and admitted five members instead of four.
The registered 1600-row positive control passed before the advertised assertion failed. An earlier
runner invocation used an invalid `--plan` argument and exited 2 before starting any test; it is not a RED.

First selected GREEN attempt, receipt
`.harness/validation/20261118T151445.862562Z-56519/receipt.json`, passed 215 tests including both
producer REDs and the real Registry iterator/readiness controls. Two projection fixture calls still
used the previous signature and failed (`build is not a function`). Types likewise found the missing
scope arguments and the missing `advertisedRows` member in the dependency Pick. These are retained
failed evidence; the source-only correction updates the fixtures and the declared dependency.

The final selected plan is `/tmp/core-session-scopes-final-plan-20261118.json`, with 100% per-file
coverage required for the eight changed core/service/supervisor modules, affected actual callers,
real Registry fixture custody, architecture and types. The Registry implementation is covered by
its selected behavior/init cases; no claim of 100% coverage of the whole Registry file is made.
The final derived worker plan is `4edc46c29a0fd04b6e482aacde15858110cd28eeb31f4546610e6ee86b69fb5d`.
Contract 3 is unchanged. The old complete-read plan `bf081b9d…e410f7` is tested against this plan in
both directions, alongside successful complete-cohort admission. This is semantic cohort protection,
not a claim that every differing executed artifact is refused.

Native/process transport and cost acceptance remain held. This source change is not performance
acceptance; v5's byte regression remains immutable evidence pending a new reviewed smoke packet.


Final source gate: `.harness/validation/20261118T151807.562559Z-60287/receipt.json`, actual exit 0
for every check, stable before/after source working hash
`34f43138ab903e1acd601aacb546c291975de42252a7e340838ca39ef011f045`:

- 810 tests across 31 selected files passed, including actual producer/caller scope, Cloud current-row
  append controls, Registry initialization/order/predicate, reconnect, physical transport and cohort tests.
- Eight changed core/service/supervisor runtime files each reached 100% statements, branches, functions
  and lines. The separate Registry behavior tests passed; no whole-file Registry coverage claim.
- 36 architecture checks passed; TypeScript passed. Receipt SHA-256:
  `2a3dc52781776135eda9a576dc6d01444554a991302932513ba48f39614eb9b9`.

The tested runtime and tests are unchanged after this receipt; only this evidence section was updated.
The nine-file runtime diff is `/tmp/core-session-scopes-runtime-review-20261118.patch`. Independent
source review and the corrected static-byte/functional smoke remain separate before cost acceptance.
