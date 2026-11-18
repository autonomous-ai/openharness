# Common session owner authority

Source base: `ae9ec8a816d2bb1b3383e804af09e5de8a83349c`, including private worker contract 6.
The first checkpoint contains caller tests only. The subsequent reviewed authority correction reuses Registry's
existing entry callback and the existing service incarnation, with no additional observer or identity map.
The reviewed flat allocation model remains an implementation candidate, not performance acceptance.

## Design (docs/feature-design-rules.md)

1. **Growth.** Native sessions remain in Registry. A service has one accepted presentation record per owner;
   removal/recreation changes its existing private incarnation. Native takeover revokes that incarnation for
   its remaining lifetime, including unchanged replay after native retirement. No second identity map/history.
   The whole daemon's existing explicit restart clears ephemeral presentation authority; a service reconnect does not.
2. **Concurrency.** Native current agent IDs and session aliases take precedence. The publication boundary must
   observe complete native Map installation before any await, including peer reconciliation and admitted cleanup
   failure. Checking Registry only when a service operation resumes misses claim-and-retire races. An existing
   entry notification may be reused only after actual caller RED proves the gap; no new observer is approved.
   Answer dispatch checks the captured question/owner and physical port; result checks owner/physical port,
   allowing successful answers that close their own question before returning.
3. **Read cost.** Existing list/device/session-read consumers must return one current native row on collision.
   Native frames are derived on demand, never retained as a second catalogue. Revocation modifies only the already
   retained service incarnation; it must not scan Registry on each session input or add a history lookup.
4. **Scale.** The flat model's measured absolute maximum accepted heap was 14.725 MiB versus 10.417 MiB, and sampled
   overlap 26.557 versus 29.258 MiB. This justified the candidate's bounded tradeoff, not a new quota or speed claim.
   Old-valid capacity, staged accounting and final combined CPU/latency/memory acceptance remain explicit gates.
5. **Compatibility.** Public frame fields, absence/nullness, list/event ordering and native controller/screen proof
   remain unchanged. A single canonical public object-key order was reviewed separately. The real compact session
   reader uses current header version 2 and worker contract 6. The eventual coherent owner transfer must advance
   the private cohort contract and reject mixed artifacts before runtime; it cannot silently keep both protocols.
6. **Migration and rollback.** These tests use only synthetic private native/provider data. They do not touch
   user sessions or change saved-provider/native schema. Full owner migration will use the reviewed canonical
   journal version and complete-artifact restart/rollback; unknown provider data is never deleted. The component
   must retain synchronous provider-plus-pending persistence before begin/append awaits and the 96-write target.
7. **Audience.** Current native guest/local/device filters stay in their real callers. A service cannot gain
   another native owner by supplying an ID, alias, factory or opaque app field. Accepted owner authority controls
   reads, prepared effects and questions; question logs stay content-free. Tests use synthetic content only.
8. **Identity.** Native authority remains the existing Registry/controller/terminal proof. No provider action is
   reinterpreted as native input and no owner's login becomes a fallback for a missing service identity.
9. **Failure.** Stale service operations receive a fixed refusal through their existing result adapter. Native
   admission remains admitted when later storage cleanup fails (`RegistryCleanupUnavailable`); no service hold
   may veto or undo it. The component's existing unavailable state will expose collision/recovery guidance.
   Exact generic refusal names and propagation belong to the reviewed runtime slice after RED, not these tests.
10. **Platforms.** The boundary affects macOS/Linux/Windows. The first real-storage source gate is on this Mac;
    Windows execution remains deferred by the user, mobile excluded. No real terminal or provider is launched.

## Actual caller RED selection

`cli/src/core/agents/ownerAuthority.spec.ts` has 19 cases. Every case uses a private HOME/data/runtime, real Registry
and its real SessionStorage child. Product imports occur only after private paths are installed. Native claims use
`openPendingAgent`; retirement uses `confirmEngineExit(..., 'remove')`. The answer adapter is the same
`createQuestionResponse(payload => cloud.answer(payload) ?? asking.answer(payload))` used by core composition.

- Four passing controls: unchanged answer, identical replay, close-before-reply, physical disconnect refusal.
- Two startup races: native claim and retirement with no intervening service read, with/without later replay.
- One late result: native claim/retirement after real service dispatch on the same physical port.
- Three actual service operation callers: deliver, update and stop cannot dispatch after native claim/retirement.
- One admission collision: current native owner prevents service frames/effects.
- One peer import: another real Registry writes a native claim; local flush imports it, then real retirement.
- One uncertain-write recovery: real publication rename/sync then injected lost acknowledgement; peer loads and
  binds that row; the local failed retry invokes `reconcileUnconfirmed` and exposes a held native owner.
- One admitted cleanup failure: real `source.release()` completes, then injected failure occurs after native Map
  installation. Both saved/native ownership and `RegistryCleanupUnavailable` are asserted before retirement.
- One native session alias acquired through real `register`, followed by retirement before service dispatch.
- Two real `createAgentList` callers (web/device) and one actual `readSessions` caller must emit one native owner.
- One actual native question-watcher callback must replace the service question, surviving its late close.

The fault hooks wrap real publication/release work, never set private Registry maps or fake a native observer.
Promises and gates are owned by teardown; every Registry drains before its storage child's close/PID proof,
then the fixture root is removed. Failed evidence is preserved without a blind retry. The existing onEnter
preloader is not asserted absent: its correction must not force changing an assertion of the old bug.

## Execution plan, not yet run

After root releases the executable hold: one selected Vitest file, one worker, pinned Node 24.22.2 and the existing
immutable dependency tree, under `scripts/validate-change.py` with a 180-second deadline and process-group custody.
Expected baseline: four positive controls pass; fifteen ownership controls fail at their caller outcomes.
An earlier setup/native-binding failure is a fixture failure, not RED evidence. Read its private stderr/cause
before a separately justified correction. No coverage/build/native/performance run is part of this first plan.

After a valid RED, submit the smallest complete Registry publication seam and common-owner binding for review,
then migrate the reviewed shared serializer, typed staged transfer, component journal and consumers coherently.
No retained raw-plus-presentation view, observer framework, quota increase or additional layout model is in scope.

## Actual RED and narrow authority implementation

The exact 19-case RED ran once at clean `7684855c33fe710a4aa8e2ef99e5944aa57ae13a`: four positive PASS and fifteen
final-caller failures, with no fixture/setup/cleanup failure. Receipt
`.harness/validation/20261118T211407.529493Z-63881/receipt.json` has SHA
`8d825297bdaccc82313a192d92d36b126f71150e9fddc79dc8e96630563cee64`; actual exit 1, 9.189 seconds.
Native aliases, recovered identity holds and admitted-cleanup failure assertions all passed before the stale
service result/list/question outcome failed.

The approved correction extends the existing `onEnter` callback with the actual native owner keys. Normal
publication notifies after the complete Map/baseline and admission marker, before fallible source release;
recovered ownership notifies after the complete affected group. Engine preloading keeps its first argument.
Core composition declares the nullable service broker before binding the callback. No callback vetoes native
admission, and notification failures contain no error content.

The existing non-enumerable token receives a revocation bit. Both agent ID and session alias are revoked before
any close can throw; exact canonical questions retire without deleting a newer native question. Current reads
and dispatch/result checks use that same token plus the required native resolver. Successful answers may close
their own question before replying. A removed/recreated service record has a new token even with identical facts.

Publication and recovery return the fixed typed `SESSION_OWNER_CONFLICT`. The real experiment dispatcher and
process adapter forward it separately from a fingerprint. The component maps it to its existing recovery-required
state and existing explicit daemon-restart guidance; physical reconnect or component restart cannot clear revoked
accepted rows. No provider file/journal format, publication durability/write count, staged transport or quota changes
belong to this prerequisite. The existing raw presentation remains only until the original full shared-owner migration.

Added controls cover failure of the first client close plus its logger while both native aliases remain revoked,
unchanged conflict checkpoints/replay, same-facts removal/recreation rename fencing and exact private-field exclusion,
real IPC conflict forwarding, and component reconnect/restart versus whole-daemon restart recovery. GREEN/types/coverage
and final runtime review remain unrun/open at this source checkpoint; final packaged/cost acceptance remains open too.

## Omitted revoked owner and Stop deadline controls

Review found two additional results of the same authority rule. The existing Stop timer still returns success
after three seconds even when native takeover revoked the captured service incarnation. Two actual-caller controls
hold startup or the provider result, complete real native claim/retirement, then advance only the virtual Stop timer.
The timer runtime stays unchanged until those controls have actually failed.

An accepted snapshot may omit a revoked service row while its native successor remains current. The old removal
loop sends `agent_deleted` through both `clients.send` and `clients.sendCommander`. That event is authoritative:
Desktop `app_state.dart` handles it by `_removeAgent`, Wi-Fi `services/wifi.ts` calls `service.agentGone`, and
`services/devices.ts` discards the agent's event/question state. None can distinguish the old service incarnation
from the native successor by that public ID. A read filter alone therefore cannot preserve native visibility.

Two new actual Registry/publication controls cover omission while the native owner is current and after it retires.
Both require successful empty publication and an empty checkpoint, proving stale service data really was dropped,
with no deletion on either client path. A positive control keeps ordinary omission deletion, then admits a fresh
service incarnation. The narrow correction, only after actual RED, will authorize the deletion against the old
record's non-revoked token and the current native resolver; it must not use the newly replaced Map to reject every
ordinary removal. No collision latch, deletion veto, extra identity map or retained stale row is needed.

The five-case edge selection then ran once: four expected final-caller failures and the ordinary-omission control
PASS, with no setup or cleanup failure. Receipt `.harness/validation/20261118T213442.887594Z-85203/receipt.json`,
SHA `bc27639537286d2f4990fb2becd6a6dc9e45ff03eca35bdbbbdcc9c7339e3db6`, records actual exit 1 in 3.752 seconds;
the working source digest stayed identical before and after. The two minimal guards now inspect the old retained
token/current native resolver before deletion and the captured exact current owner at the existing Stop deadline.
The three-second deadline and successful snapshot omission remain unchanged. GREEN is still pending review/release.

## Focused source evidence and remaining coverage

The first combined selection preserved actual receipt `20261118T213631.959078Z-87356` (SHA
`e7e77fb1107621a875ae1ffcbd38406ccebefbbeb9d31a24774accf9e8b084b5`): 326 of 327 cases passed across fourteen files,
and the existing native preload caller passed. Its only failed assertion compared the existing normalized rename
payload, including `said: null`, with the unnormalized fixture. Types also found five fixture-only issues: widened
mock return literals, an incomplete turns cast and missing native-question fields. All runtime checks stayed frozen.

The corrected selection reused the passing Registry/preload results and ran eleven affected files. Receipt
`20261118T214107.840667Z-92761` (SHA `c79b925dede99256bf932bd1f8a86353072bb54bf874a29004d9d8d2924f1a75`)
records 226/226 cases and CLI types PASS. The corrected test explicitly expects `{...row, said: null}` and exact
own-key membership, including exclusion of every private symbol; the other fixtures now use their actual types.
The overall gate remains FAILED only for coverage: publication/processCoreApi are 100%; the broker lacks the
equal native agent/session-ID branch; experimentQueries lacks existing shared Create, unavailable-facts and default
logger callers that were outside that selection. The preserved reports live beside that receipt.

A source-only supplement covers equal/distinct native aliases through real Registry admission with exactly one
question close, and the actual default refusal logger without query content. Existing Wi-Fi/API caller tests supply
the shared-query coverage. No runtime changed for this supplement. A standard Istanbul merge may reuse the preserved
coverage only after verifying exact hashes of all four runtime files and the prior report, then requiring 100% for
every metric of every file. At preparation the supplement and its final coverage/types result were still unrun;
packaged and matched-cost acceptance remain separate open gates.

The approved supplement subsequently passed once in receipt `20261118T214716.383714Z-99743` (SHA
`6f24574e7a6f2abde0968e45bbcb1dd184e274c759d6c6659bca149672e97d82`): both actual alias
cases, 114 shared-query caller tests across four files, exact-runtime coverage merge, and CLI types. The merged
report `/tmp/core-cloud-owner-authority-merged-coverage-20261119.json` proves 100% statements/branches/functions/lines
for all four selected runtime files without rerunning the already-passing Registry suites. Alongside the prior
receipts, 413 distinct cases across seventeen source files are green; repeated controls are not counted twice.
All validator/storage-child work settled. No product runtime changed during fixture/coverage correction. The
authority source checkpoint is complete; the full common-owner replacement and packaged/cost acceptance remain open.
The merged report has SHA `8984393c9e7d3ac5a30d3e0dd1e0fecfd7796fe39cf52a3bb84106cc4196ba7f`.

## Full migration compatibility decision

The approved flat representation does not retain a provider card when `said` is null, because no public frame,
recent turn, last words, activity or device row then exposes that card. Common-owner migration will intentionally
suppress redundant `agent_synced` events for raw-only absent/null/content card changes with an identical complete
public view. It will retain provider card state in the component and use the latest card when `said` later changes,
with no premature completion notification. This is an explicit event-count difference to explain in matched cost
comparison, not permission to change public absence/null/empty values or meaningful event ordering. No extra core
raw-row hash, duplicate record or component signal will be retained solely to reproduce those redundant syncs.
