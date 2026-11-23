# A dial keeps the pets another computer put on it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** A computer stops sending `pet.drop` for packs another computer put on the dial: it drops only its own stale packs, and a foreign (spare) pack only when the dial needs the slot or refused a pack for memory or busy.

**Architecture:**
- **`planPetSync`** (`cli/src/cable/pets/sync.ts`, pure) takes the per-link own set and returns `spare` beside `map`, `send`, `drop`; `drop` is only own packs the mapping no longer names.
- **`CableSession`** (`cli/src/cable/cableSession.ts`) keeps the own set per link (in memory, cleared on link close), drops the first spare pack just before a `pet.offer` into a full dial (rule 2) and in the `pet.error` memory/busy path before the once-per-pack retry (rule 3).
- Devices process only. No core, firmware, protocol or state-file change.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`. No new dependency.

**Spec:** `docs/plans/2026-11-20-dial-keep-other-machines-pets-design.md`. Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md` (Protect the core; Rules 3, 6, 7).

## Base

- Branch `fix/dial-keep-other-machines-pets` at `90ac4e5902` (= its merge base with `origin/main`), worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-pet-keep`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (the worktree has no `node_modules`). One `npm` process at a time.
- Names at the base (tasks name functions, never lines):
  - `pets/sync.ts`: `planPetSync`, `PetDialState`. `pets/sync.spec.ts`: `A`, `B`, `C`, the two `planPetSync` cases.
  - `pets/store.ts`: `MAX_PACKS` (4), `PetMapping`.
  - `cableSession.ts`: fields `petTransfer`, `petDropSent`, `petRetried`, `petRetryTimers`, `petHeld`, `petDoneAt`, `petErrors`, `petMapSent`; the link-close reset in `onClosed` (`this.petHeld.clear()` …); `onMessage` cases `pet.done`, `pet.error`; `readPetHello` (its `t && (shrank || this.petHeld.has(t.id))` branch); `petsChanged`, `syncPets`, `runPetSync`, `armPetStall`; constants `PET_RETRY_MS`, `PET_TRANSIENT`.
  - `cableSession.spec.ts`: `describe('custom pets')` with `A`, `B`, `NEW`, `pack`, `packs`, `fakeStore`, `hello`, `petTypes`; `connect(host, log)`, `tmpLog`, `settle`, `NEXT_TICKS`, `LoopbackPort`; the cases `a cut transfer is resent after reattach` (the multi-port setup to copy), `a memory refusal after a pet.drop is offered once more after 1.5 s`, `a held pack that is no longer mapped is dropped on hello; …`, `petsChanged with a new mapping → …`. Log lines are read with `await log.flush()` then `readFileSync(log.currentPath, 'utf8')`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 `planPetSync` drops only own stale packs and lists spare ones | `cli/src/cable/pets/sync.ts`, `cli/src/cable/pets/sync.spec.ts`, `cli/src/cable/cableSession.ts` (the one `planPetSync` call) | none | medium | `sync.spec.ts` |
| 2 The session keeps foreign packs until it needs their slot | `cli/src/cable/cableSession.ts`, `cli/src/cable/cableSession.spec.ts` | 1 | high | `cableSession.spec.ts` (`custom pets`) |

Longest chain: two tasks (1 → 2). The dependency is real: Task 2 consumes `spare` and the `own` parameter, and both touch `cableSession.ts`.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/pets/sync.ts`, `cli/src/cable/cableSession.ts` | **Devices service process** | their specs (PR CI `cli-tests`, Linux; locally on this Mac), `npm run typecheck` |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/services/`, `cli/src/architecture.coreFiles.txt`, `cli/e2e/`, `devices/` (firmware), `cli/src/cable/pets/store.ts`, `cli/src/lib/harnessDevices.ts`. `npm run test:core` is not required (no core or services file changes).

## Global Constraints

- **Own** (per link, in memory): a pack the dial answered `pet.done` for; the pack in flight when a hello lists it (`readPetHello` finishes it as `stored`); every held pack the mapping named at any `runPetSync` on this link. Cleared in the link-close reset with the rest of the per-link pet state. Never written to disk.
- **Spare:** held, not own, not mapped, in the order the dial listed them (`petHeld`'s insertion order).
- **Rule 1:** `drop` = own held packs the mapping does not name; dropped at once, as today.
- **Rule 2:** just before a `pet.offer`, when `petHeld.size >= MAX_PACKS` (4, imported from `./pets/store.js`), drop the first spare pack, then offer. Never when no offer goes out.
- **Rule 3:** on `pet.error` with reason `memory` or `busy` and the pack not in `petRetried`, drop the first spare pack (if any) before the existing retry condition (`petDropSent && !petRetried.has(id)`, `PET_RETRY_MS` = 1500) is evaluated. A second refusal of the same pack on this link drops nothing.
- **Log:** one new line per spare pack dropped (rule 2 or 3): `cable: pet <id> dropped for room`. Nothing logged for a kept spare pack. Ids, counts and `errorKind` only.
- `pet.map` still replaces the dial's whole mapping, unchanged. The stall timer's `pet.drop` (`armPetStall`) is unchanged.
- **Never the person's own:** no test or check touches a real dial, Diego's daemon (port 18473), `~/.harness`, or production. Nothing is flashed.
- **Repo rules:** test first at the layer where the behavior lives; no fixed sleeps (fake timers or `settle`); comments say why; no dead code (Task 1's bridging argument is replaced in Task 2).

## Review Focus

1. **A mapped pack that is never offered into a full dial** (newer than the dial reads, refused for crc, unreadable). Expected: no spare pack dropped. Task 2, `a pack newer than the dial reads is never made room for`.
2. **The pet changed while attached, the old pack held since the hello.** Expected: `pet.drop` of the old pack at once. Task 2, `a pack held at the hello and mapped, then unmapped, is dropped at once`.
3. **This computer replaced its pet while the dial was on another computer.** Expected: on reattach the old pack is spare (kept), the new one offered. Task 2, `after a reattach, a pack this computer sent on the last link is spare`.
4. **A second missing pack into a still-full dial.** Expected: after `pet.done` of the first, the next offer drops the next spare in the dial's order, one per offer. Task 2, in `a full dial of foreign packs …` (second mapped pack).
5. **Keepalive hellos repeating.** Expected: no drop and no `dropped for room` line per hello. Task 2, the two-computers case (two hellos, zero `pet.drop`, no log line) and the rule-3 case (keepalive drops nothing more).

## Decided (the PM, 2026-11-20)

Option 1, CLI only: drop only for room; own stale packs first, foreign packs only when the dial needs the slot; retry on a memory/busy refusal. No firmware or protocol change, no new state file. Pets stay owned by the computer: `pet.map` still replaces the whole mapping. "Own" is per link, in memory. Nothing in the daemon core; devices process only. No end-to-end check.

## Decided here, where the spec was silent

- **The session derives "held and mapped" from the plan:** after each `planPetSync`, every held id in neither `drop` nor `spare` is added to the own set. `planPetSync` keeps exactly the four fields the spec names.
- **Task 1 keeps today's behavior at the call site** by passing `new Set(this.petHeld)` as `own` (every held pack own ⇒ `drop` as today, `spare` empty), so its commit is green and typechecks. Task 2 replaces that argument with the per-link set.
- **One helper drops a spare pack for both rules**: `private async dropSpare(): Promise<void>` (first spare of a fresh `planPetSync` over the store's mapping, `[...this.petHeld]` and the own set; nothing when there is no store or no spare). It deletes the id from `petHeld`, sets `petDropSent`, logs `cable: pet <id> dropped for room`, then sends `pet.drop`.
- **Rule 2's place in `runPetSync`:** after the last `if (this.petTransfer || this.transfer || !this.link?.isOpen) return` and after `this.petTransfer` is assigned (so no firmware image starts while the drop is awaited), before `armPetStall()` and the `pet.offer`.
- **The rule-3 test uses two foreign packs, not one**, so "drops nothing more" is checked with a spare pack still held.

---

### Task 1: `planPetSync` drops only own stale packs and lists spare ones

**Files:**
- Modify: `cli/src/cable/pets/sync.ts` (`planPetSync` and its comment)
- Modify: `cli/src/cable/cableSession.ts` (only the `planPetSync(...)` call in `runPetSync`)
- Test: `cli/src/cable/pets/sync.spec.ts`

**Interfaces:**
- Produces: `planPetSync(mapping: PetMapping, held: string[], own: ReadonlySet<string>): { map: PetMapping; send: string[]; drop: string[]; spare: string[] }`. `drop` = de-duplicated held ids in `own` and not mapped, in held order; `spare` = de-duplicated held ids not in `own` and not mapped, in held order. `map` and `send` unchanged.

- [ ] **Step 1: Write the failing tests** in `sync.spec.ts`
  - Update `held nothing → send all mapped, map first` to pass `new Set()`; add `expect(plan.spare).toEqual([])`.
  - Update `held stale → drop it, send only what is missing` to `planPetSync({ all: null, engines: { claude: A, codex: B } }, [B, C], new Set([C]))`: `drop` `[C]`, `send` `[A]`, `spare` `[]`.
  - New `an empty mapping and another computer's packs → nothing dropped, all spare in the dial's order`: `planPetSync({ all: null, engines: {} }, [C, A, B], new Set())` → `drop` `[]`, `send` `[]`, `spare` `[C, A, B]`.
  - New `a held pack neither own nor mapped is spare, an own one is dropped, a mapped one is neither`: `planPetSync({ all: A, engines: {} }, [B, A, C], new Set([C]))` → `drop` `[C]`, `spare` `[B]`, `send` `[]`.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/cable/pets/sync.spec.ts`
  Expected: FAIL (`spare` is `undefined`; `drop` holds the foreign packs).

- [ ] **Step 3: Commit red:** `test(dial): planPetSync drops only own stale packs and lists spare ones (red)` (only `sync.spec.ts`).

- [ ] **Step 4: Implement** the signature above in `sync.ts`; rewrite the `drop` comment line and add one for `spare` (another computer's packs: kept until the dial needs the slot). In `cableSession.ts` `runPetSync`, pass `new Set(this.petHeld)` as `own` with a one-line comment that Task 2 replaces it (today's behavior).

- [ ] **Step 5: Run to verify they pass**

  Run: `cd cli && npx vitest run src/cable/pets/sync.spec.ts src/cable/cableSession.spec.ts && npm run typecheck`
  Expected: PASS, no type errors (the session specs are unchanged and still green).

- [ ] **Step 6: Commit:** `fix(dial): planPetSync drops only own stale packs and lists spare ones`.

---

### Task 2: The session keeps foreign packs until it needs their slot

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (a new field beside `petHeld`, the link-close reset, `pet.done`, `pet.error`, `readPetHello`, `runPetSync`, a new `dropSpare`; import `MAX_PACKS` from `./pets/store.js`)
- Test: `cli/src/cable/cableSession.spec.ts` (`describe('custom pets')` only)

**Interfaces:**
- Consumes: `planPetSync(mapping, held, own)` and its `spare` (Task 1).
- Produces (private): `petOwn = new Set<string>()` (doc comment: what own means and why it is in memory: `PetStore.sweep` deletes a replaced pet's files, so disk cannot tell); `dropSpare(): Promise<void>` as in "Decided here".

Foreign ids for the tests: `const F = ['1', '2', '3', '4'].map((d) => d.repeat(16))` inside `describe('custom pets')`.

- [ ] **Step 1: Write the failing tests** (new cases, and the existing ones changed to the new rule)
  - **New** `two computers: a second computer with no pets keeps the first one's packs`: session 1 (`fakeStore({ all: A, engines: {} })`) greets `petIds: []`, gets `pet.accept`/`pet.done` for `A`; stop it. Session 2 (`fakeStore({ all: null, engines: {} })`, its own `tmpLog()`) greets `petIds: [A]` twice. Expect session 2's port: `pet.map` `{ t: 'pet.map', all: null, engines: {} }` exactly once, no `pet.drop`, no `pet.offer`; `session.petDial().held` `[A]`; its log has no `dropped for room`.
  - **New** `a full dial of foreign packs: one spare dropped just before each offer, in the dial's order`: mapping `{ all: A, engines: { claude: B } }`, hello `petIds: F`. Expect `petTypes(port)` `['pet.map', 'pet.drop', 'pet.offer']`, the drop `{ t: 'pet.drop', id: F[0] }`, the offer `A`; the log contains `cable: pet ${F[0]} dropped for room` once. Then `pet.done` `A` → the next drop is `F[1]`, immediately followed by `pet.offer` `B` (Review Focus 4). Then `pet.error` `B` `crc` → `pet.drop` ids stay `[F[0], F[1]]`.
  - **New** `a pack newer than the dial reads is never made room for`: `packs[B][4] = 2` (restore in `finally`), mapping `{ all: B, engines: {} }`, hello `pets: 1, petIds: F` → no `pet.drop`, no `pet.offer`.
  - **Replace** `a memory refusal after a pet.drop is offered once more after 1.5 s` with `a memory refusal drops a spare pack once and offers again after 1.5 s` (fake timers as today): mapping `{ all: A, engines: {} }`, hello `petIds: [F[0], F[1]]` → no `pet.drop`, offer `A`. `pet.error` `A` `memory` → `pet.drop` ids `[F[0]]`; at +1000 ms one offer; at +1600 ms offers `[A, A]`. `pet.error` `A` `memory` again → drops still `[F[0]]`, no third offer after +5000 ms. Keepalive hello `petIds: [F[1]]` → offers `[A, A, A]`; `pet.error` `A` `memory` → drops still `[F[0]]`.
  - **Change** `a held pack that is no longer mapped is dropped on hello; …` to `a foreign pack is kept at the hello; the next missing pack is offered after pet.done`: same setup (`petIds: [NEW]`), expect no `pet.drop`; offers `[A, B]` after `pet.done` `A`.
  - **New (guard)** `a pack held at the hello and mapped, then unmapped, is dropped at once`: mapping `{ all: B, engines: {} }`, hello `petIds: [B]`; `store.current = { all: NEW, engines: {} }`, `petsChanged()` → `pet.drop` `B`, then `pet.offer` `NEW`.
  - **New** `after a reattach, a pack this computer sent on the last link is spare`: copy the multi-port setup of `a cut transfer is resent after reattach`. Link 1: mapping `{ all: B, engines: {} }`, hello `petIds: []`, `pet.accept`/`pet.done` `B`; close the port; `store.current = { all: NEW, engines: {} }`. Link 2: hello `petIds: [B]` → no `pet.drop`, `pet.offer` `NEW`.
  - Unchanged and still green: `petsChanged with a new mapping → …` (a pack sent on this link, then unmapped, is dropped at once).

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts -t 'custom pets'`
  Expected: FAIL in the two-computers, full-dial, memory-refusal, foreign-kept and reattach cases (today every unmapped held pack is dropped at the hello). The two guards pass.

- [ ] **Step 3: Commit red:** `test(dial): the session keeps foreign packs until it needs their slot (red)` (only `cableSession.spec.ts`).

- [ ] **Step 4: Implement** in `cableSession.ts`:
  - `petOwn` field; `this.petOwn.clear()` in the link-close reset.
  - `pet.done`: `this.petOwn.add(id)`. `readPetHello`: when the hello lists the pack in flight (finished as `stored`), add its id.
  - `runPetSync`: pass `this.petOwn` (removes Task 1's bridging argument and its comment); after planning, add each held id in neither `plan.drop` nor `plan.spare` to `petOwn`; rule 2 as placed in "Decided here".
  - `pet.error`: rule 3 before the existing retry condition; update its comment (the drop is part of the once-per-pack-and-link retry).
  - `dropSpare()` as in "Decided here".

- [ ] **Step 5: Run to verify they pass**

  Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts src/cable/pets/sync.spec.ts src/architecture.spec.ts src/architecture.failureLogs.spec.ts && npm run typecheck`
  Expected: PASS, no type errors.

- [ ] **Step 6: Commit:** `fix(dial): a dial keeps the pets another computer put on it`.

---

## Verification

None beyond the unit specs. There is no cable pet end-to-end suite, and the session specs already drive the real `CableSession` against a fake dial (`LoopbackPort`) and a fake store, which is where this behavior lives. A real dial is never touched and nothing is flashed. PR CI `cli-tests` (Linux) runs both spec files; the PR names macOS, Linux and Windows as affected (platform-free TypeScript in the devices process).
