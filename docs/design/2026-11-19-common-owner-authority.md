# Common session owner authority

Source base: `ae9ec8a816d2bb1b3383e804af09e5de8a83349c`, including private worker contract 6.
This checkpoint contains caller tests only. No Registry observer, product representation, transport or quota
change is implemented. The reviewed flat allocation model is an implementation candidate, not performance acceptance.

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
