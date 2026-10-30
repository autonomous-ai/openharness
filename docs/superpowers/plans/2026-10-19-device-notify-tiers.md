# Device Notification Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round dial and the Pro notify only when it is worth it:
- every finished turn gets a tier (`alert`, `list` or `silent`);
- rules decide the clear cases;
- Jev decides finished turns on agents nobody is looking at;
- both firmwares act on the tier.

**Architecture:**
- **The tier.** A new pure module `cli/src/lib/notifyTier.ts` decides it: synchronous rules, then Jev with a 1 s budget, then a fallback rule. The decision is logged.
- **The wire.** `devices.ts` calls it for every `summary`. `cableSession.summary` sends `tier`, plus `quiet` and `silent` for older firmware.
- **The firmwares.** Each one maps the tier to sound, wake, toast and list entry. Each also applies the device-side rules: the agent is on screen, a 30 s beep coalesce, one entry per agent, a 6 h expiry.

**Tech Stack:** TypeScript (vitest) for the daemon; C firmware for the round dial (ESP32-S3, `devices/harness-device/firmware`) and the Pro (ESP32-P4, `devices/harness-pro/firmware`) with host tests.

**Spec:** `docs/superpowers/specs/2026-10-19-device-notify-tiers-design.md`

## Global Constraints

- **Tiers:**
  - `alert` = beep, wake, toast and entry;
  - `list` = entry only;
  - `silent` = nothing but the pet and card update.
- **Rules:**
  - A question or a failure is `alert`.
  - A sub-agent, replayed, restored or empty turn is `silent`.
  - An agent on screen is `silent` (`alreadyOnScreen()` on the desktop; on the device, its own room or face).
  - Everything else goes to Jev.
- **Fallback** (Jev unavailable, more than 1 s, no key, no credits): `list` if the turn ran 120 s or more, else `silent`.
- **Jev:**
  - `createJevDecide` from `cli/src/lib/jev/jevClient.ts`, model `typesafe/jev-1.13`.
  - One `choice` question named `tier`, with options `alert`, `list` and `silent`.
  - The recap is cut to 600 chars or fewer.
  - `HARNESS_NOTIFY_SMART=0` disables Jev.
- **Log line:** `notify · <agent> · <tier> · <by> · <detail> · <ms>ms`, where `by` is `rule:<name>`, `jev` or `fallback:<reason>`.
- **Wire:**
  - `summary` gains `tier`.
  - `alert` sends neither `quiet` nor `silent`.
  - `list` sends `quiet: true`.
  - `silent` sends `silent: true`.
- **Devices:**
  - at most one beep per 30 s per device;
  - one list entry per agent (the newest);
  - entries expire after 6 h;
  - the round dial's error view auto-dismisses after 8 s.
- **Compatibility:**
  - A summary with no `tier` (an old daemon) behaves as it does today on both firmwares.
  - Old firmware keeps working through `quiet` and `silent`.
- No file under `devices/harness-pro/firmware` except `.md` may contain `harness-device` (Pro tree isolation).
- Commit only when the owner asks.

## Review Focus

1. **A burst of 5 agents finishing within 30 s.** Expected: at most one beep per device, five entries (Jev permitting), and one Jev call each with no queue pile-up. Test in Task 1 (concurrency) and Tasks 3–4 (coalesce).
2. **Jev slow or failing while the person waits for a question.** Questions and failures never wait for Jev (rules come first) and are never later than today. Test in Task 1.
3. **An agent finishes again while its previous `list` entry is unread.** Expected: still one entry for that agent, now the newest; the count does not double. Tests in Tasks 3–4.
4. **A device that was asleep (screen off) receives a `list` tier.** Expected: the screen stays off and nothing beeps; the entry is there on the next wake. Tests in Tasks 3–4.
5. **A device whose clock is unknown or wraps when checking the 6 h expiry.** Expiry uses the device's monotonic ms since boot, measured from receipt, and the uint32 wrap is safe (compare by signed difference). Tests in Tasks 3–4.

---

### Task 1: `notifyTier.ts`, the decision

**Files:**
- Create: `cli/src/lib/notifyTier.ts`, `cli/src/lib/notifyTier.spec.ts`

**Interfaces:**
- Produces:

```ts
export type Tier = 'alert' | 'list' | 'silent'
export interface TierInput {
  agent: string; engine: string; recap: string;
  durationS: number | null;            // null: unknown start
  stats: { testsPassed?: number; testsFailed?: number; commits?: number };
  subagent: boolean; onScreen: boolean; failed: boolean;
}
export interface TierDecision { tier: Tier; by: string; detail: string; ms: number }
export function createTierDecider(opts: { jev: JevDecide | null; now?: () => number; log: (line: string) => void; budgetMs?: number /* 1000 */ }):
  (input: TierInput) => Promise<TierDecision>
```

- The decider keeps the 30-minute `recent` counts (alerts and lists) itself.

`failed` is true when the turn's summary reports a failed turn; `turn.error` frames bypass the decider and are alerts on the devices.

- [ ] **Step 1: Write the failing tests in `notifyTier.spec.ts` (vitest)**

```ts
it('failed → alert by rule, Jev never asked')                 // jev mock not called
it('subagent → silent; onScreen → silent; empty recap → silent')
it('otherwise asks Jev once with recap ≤ 600 chars and recent counts; returns its choice')
it('Jev throws JevUnavailable / exceeds 1000 ms → fallback: durationS ≥ 120 → list, else silent; unknown duration → silent')
it('jev null (HARNESS_NOTIFY_SMART=0) → fallback without calling anything')
it('logs exactly one line per decision: "notify · <agent> · <tier> · <by> · …"')
it('recent counts: 3 alerts within 30 min are passed as alerts_30m=3; older ones drop out')
it('5 concurrent decisions resolve independently within the budget (no serial queue)')
```

- [ ] **Step 2: Run them.** `cd cli && npx vitest run src/lib/notifyTier.spec.ts` should FAIL (the module is missing).
- [ ] **Step 3: Implement it.**
  - The Jev `state` is `{agent, engine, recap, duration_s, work:{tests_passed, tests_failed, commits}, recent:{alerts_30m, lists_30m}}`.
  - The question is `{ tier: { type:'choice', instructions, criteria:{alert, list, silent} } }`, with the spec's criteria copy.
  - Race the call against an `AbortController` timeout of `budgetMs`.
- [ ] **Step 4: Run them.** PASS.

---

### Task 2: Wire the tier into the daemon

**Files:**
- Modify:
  - `cli/src/services/devices.ts`: `startDevices` (line 78) gains `jev` via `DevicesDeps`; the summary dispatch (~285) calls the decider; the `done` branch stashes the turn's duration and stats for the summary that follows.
  - Where `startDevices` is called (`cli/src/harnessd/services.ts`): pass `createJevDecide({ backend: (m,p,b) => core.account.backend(m,p,b) })` the way `defaultRouter` does, or `null` when `process.env.HARNESS_NOTIFY_SMART === '0'`.
  - `cli/src/cable/cableSession.ts` `summary()` (~2826): replace the boolean pair with `tier: Tier`. Send `tier` plus `quiet` (for `list`) or `silent` (for `silent`). Update its callers.
  - `cli/src/cable/cableHost.ts` (~903-948): a `turn.error` stays as is; the devices treat it as `alert`.
  - `devices/harness-pro/docs/cable.md`, and the round dial's cable doc if there is one: document `tier`.
- Test: `cli/src/cable/cableSession.spec.ts` and `cli/src/services/devices.spec.ts` (create it if it does not exist).

**Interfaces:**
- Consumes `createTierDecider` (Task 1).
- Produces the wire `summary` frame: `{ t:'summary', …, tier, quiet?, silent? }`.

- [ ] **Step 1: Write the failing tests.**
  - session: `summary(tier:'list')` sends `tier:'list', quiet:true`; `'silent'` sends `silent:true`; `'alert'` sends neither.
  - devices:
    - a summary for an agent on screen sends `silent` and Jev is not called;
    - a subagent summary sends `silent`;
    - otherwise Jev's tier is sent;
    - the duration comes from the stashed `done`.
- [ ] **Step 2: Run** `npx vitest run src/cable src/services/devices`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npx vitest run src/cable src/services src/lib/notifyTier.spec.ts` and `npm run typecheck` (or the repo's tsc command). Expected: PASS.

---

### Task 3: The Pro acts on the tier

**Files:**
- Modify:
  - `devices/harness-pro/firmware/main/cable/pro_cable.c:600-605`: parse `tier` (absent means today's behaviour).
  - `main/app/pod_glue.c:763-794` (`pod_ui_notify` takes a tier).
  - `main/app/pro_app.c:147-157,485-487`: beep and wake only for `alert`, coalesced to one beep per 30 s.
  - `main/pod/pod_model.c` and `.h`: one unread entry per agent (replace the older one); expire entries older than 6 h on each model tick, using `received_ms` and a signed difference.
- Test: `test/test_pro_cable.c`, `test/test_pod_model.c`, `test/test_pro_app.py`.

**Interfaces:**
- Consumes the wire `tier` (Task 2).
- Produces `void pod_ui_notify(pod_ui_t *u, const char *agent_id, pod_tier_t tier, …)` with `typedef enum { POD_TIER_ALERT, POD_TIER_LIST, POD_TIER_SILENT } pod_tier_t;`, and `#define POD_BEEP_COALESCE_MS 30000`, `#define POD_UNREAD_TTL_MS (6u * 3600u * 1000u)`.

- [ ] **Step 1: Write the failing tests.**
  - `list`: an entry, no beep, no wake, no toast. `alert`: entry, beep, wake, toast. `silent`: no entry.
  - A missing `tier` keeps today's behaviour, including `quiet` dropping the entry.
  - Two alerts 10 s apart beep once; 31 s apart, twice.
  - The same agent's second entry replaces the first, so the count stays 1.
  - An entry expires at 6 h and survives at 5 h 59 m, with a uint32 wrap case.
  - Asleep plus `list`: the screen stays off.
  - With that agent's room on screen: no beep or wake, and the entry is read at once.
  - A `question` frame is an alert: beep (coalesced), wake, and a toast in another agent's room. Today it is silent.
  - `turn.error` files a failed entry as an alert.
- [ ] **Step 2: Run** `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `bash test/run.sh`, `bash test/golden.sh --check` and `python3 test/test_tree_isolation.py`. Expected: PASS. Re-record golden only if a Notices screen fixture changed, and say which.

---

### Task 4: The round dial acts on the tier

**Files:**
- Modify:
  - `devices/harness-device/firmware/main/cable_client.c:1287-1420`: parse `tier`; no beep unless `alert` (fixing the beep on `quiet` at :1322); beep coalescing of 30 s.
  - `main/ui/habitat/ui_habitat.c`:
    - `ui_notify_task_done` (4189-4205): `list` gets a drawer row with no wake and no celebration;
    - the drawer keeps one row per agent (as today) and expires rows at 6 h;
    - `ui_show_error` auto-dismisses after 8 s and keeps a drawer row.
  - If the agent is on the face: no beep or wake, and the row is read.
- Test: the round dial's test suite (`devices/harness-device/firmware/test/run.sh`; extend `test_audio_notify.py` and the habitat tests it runs).

**Interfaces:**
- Consumes the wire `tier` (Task 2).

- [ ] **Step 1: Write failing tests mirroring Task 3's list**, plus:
  - `quiet:true` with no `tier` no longer beeps (the bug fix);
  - the error view is gone after 8 s while its row stays;
  - a `question` beeps (coalesced) as well as filing its pinned row and waking, as it does today.
- [ ] **Step 2: Run** `bash devices/harness-device/firmware/test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run it again, plus the round dial's golden/screen checks if `run.sh` has them.** Expected: PASS.

---

### Task 5: Measure on the owner's machine

- [ ] **Step 1: Record the baseline.** Before installing, count one working day from the current logs: device beeps (`audio_cap: beep` per device) and desktop done notifications.
- [ ] **Step 2: Install.** Run the CLI from this branch as the daemon (per the CLI README's dev install), flash a Pro with `scripts/flash.sh`, and flash a round dial with its flash procedure (dev version `0.0.99`).
- [ ] **Step 3: After a working day,** count the `notify ·` lines per tier, the beeps per device, and the share decided by `jev` versus `fallback`.
- [ ] **Step 4: Check the success criteria.**
  - Beeps fall by 60% or more.
  - Every question and failure is `alert`, checked by grepping the log for `rule:question` and `rule:failed`.
  - Report to the owner, with a sample of Jev's `alert`/`list`/`silent` calls so its judgement can be reviewed.
