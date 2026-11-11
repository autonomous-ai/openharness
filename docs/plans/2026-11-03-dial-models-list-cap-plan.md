# Round Dial: A Model List Too Big for One Frame No Longer Drops the USB Link Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** The dial's model picker shows the selected model plus the rest, up to 48, within one frame, and an oversized frame never closes the port.

**Architecture:** `models.list` (cli/src/cable/cableSession.ts) answers the selected id first, then the catalog in order, up to the dial's 48, and stops before the frame would pass `CABLE_MAX_PAYLOAD - 256` bytes or `SWARM_TOKENS_MAX` tokens, the bounds other Swarm frames already use. `send()` tells an encode failure (a message over the cap: a bug on this side) from a write failure (a dead port): the first is logged and dropped, and only the second closes the link.

**Tech Stack:** TypeScript, Vitest.

**Spec:** Task #2340 (Diego), brief in conversation 99cbcd773e7621eb9cd2180b.

## Global Constraints

- The PR body starts with: `Requested by diego@autonomous.ai through Harness.`
- No firmware change. Never publish firmware, run upload scripts or touch the device update manifest.
- Only `cli/src/cable/cableSession.ts` and its spec change.
- Before Ready: both new tests fail on main, red/green evidence in a PR comment, and `npm run test:super-tabs`.

## Review Focus

1. A selected id that is not in the catalog (an engine's list moved on): nothing invented, the list goes as it is. Test in Task 1.
2. A single model id longer than the frame allows on its own: it is skipped, and the next ones that fit still go. Test in Task 1.
3. A write that fails on a live port (the dial unplugged mid-frame) still closes the link, as today. The existing write-failure tests stay green.

---

### Task 1: models.list fits one frame

**Files:**
- Modify: `cli/src/cable/cableSession.ts:1473-1495`
- Test: `cli/src/cable/cableSession.spec.ts` (beside 'answers models.list even when the catalog is empty')

**Interfaces:**
- Produces: the `models` reply's `items` hold at most 48 `{ id }`: the `selected` id first when the catalog lists it, then the catalog in order without it. The reply's JSON is at most `CABLE_MAX_PAYLOAD - 256` bytes, and `jsonTokens` is at most `SWARM_TOKENS_MAX`.

- [ ] **Step 1: Write the failing tests** `answers a catalog too big for one frame within the cap and keeps the link` (325 runtime-v1 ids of about 100 bytes; hello, wait for `agents.end`, `models.list` request 7 selecting the 300th id: one `models` frame for request 7, at most 48 items, the selected id first, every frame within 8192 bytes, port open). Also `leaves out a selected id the catalog does not list, and an id too long to fit`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "models"`. Expected: FAIL (the port closed with "write failed").
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement** the selection and the fitting loop in the `models.list` case.
- [ ] **Step 5: Run** the file. Expected: PASS. **Step 6: Commit.**

### Task 2: An oversized frame is dropped, not the link

**Files:**
- Modify: `cli/src/cable/cableSession.ts:2516-2527` (`send`)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces: `send(msg)` returns false and logs `cable: dropped a <t> frame over the cap (<n> bytes)` when the message cannot be framed; the port stays open. A write failure logs `write failed` and closes the link as today.

- [ ] **Step 1: Write the failing test** `drops and logs a frame over the cap, and the link stays up`: a message of about 9000 bytes sent through the session returns false, a log line names it, `port.isOpen` stays true, and the next small message still goes.
- [ ] **Step 2: Run.** Expected: FAIL (the port closed). **Step 3: Commit.**
- [ ] **Step 4: Implement.** **Step 5: Run** the file and `npm run test:super-tabs`. Expected: PASS. **Step 6: Commit and push.**
