# Round dial three fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three pre-existing round-dial defects:
1. a fresh image that cannot open the cable is confirmed anyway;
2. an out-and-back drag on the Focus face starts voice;
3. carried text is dropped when voice starts on Focus.

**Architecture:**
- Branch `fix/round-dial-three-bugs` (worktree `.claude/worktrees/dialbugs`), one commit per task.
- Bug 1 lives in `fw_update.c` with its decision in a new `fw_confirm_boot(bool)`, called from `app_main.c`, tested in the existing fake-SDK harness `test_fw_update.py`.
- Bugs 2 and 3 live in `ui_habitat.c`, tested in `test_touch_ui.py`.

**Tech Stack:** ESP-IDF 5.5.4 (ESP32-S3) C11; Python host tests that compile C slices.

**Spec:** `docs/specs/2026-11-11-round-dial-three-fixes.md`

## Global Constraints

- Firmware root `devices/harness-device/firmware/` (`FW/`). Do not touch `devices/harness-pro`, `cli/`, `desktop/`.
- Tools (from the resources work; still valid):
  - `/tmp/dialres-build/build.sh <name> [-D…]` builds the **`dialres`** worktree, so for this branch call `idf.py` directly. In a subshell, source `/tmp/dialres-build/env.sh` and build with `-C .claude/worktrees/dialbugs/devices/harness-device/firmware -B /tmp/dialbugs-build/<name> -DSDKCONFIG=/tmp/dialbugs-build/<name>.sdkconfig` (delete that sdkconfig first).
  - Host tests:
    - `env -u IDF_PATH make device-test`.
    - Every `FW/test/test_*.py` with the system `python3` and `IDF_PATH=~/esp/esp-idf-5.5.4`.
    - `test_cable_models.py` failing with "'snprintf' macro redefined" is the known macOS failure.
- Values:
  - Retry delay 200 ms.
  - Excursion limit 24 px (`24 * 24` squared) and the 650 ms limit, both unchanged.
  - The carry value 3 and `a.text = carry.id`, as `make_action` already uses for `A_PET`.
- Do not flash until Task 5. Do not push.

## Review Focus

- **A thumb that drifts 10–20 px and lifts** must still talk. Expected: voice starts. The Task 3 test pins a 20 px drift.
- **A good image whose first cable start fails transiently** (memory). Expected: the retry recovers it, with no rollback. The Task 1 test covers "first start fails, retry succeeds" → confirmed.
- **The daemon offering the version that just rolled back**, every 15 s. Expected: declined silently, no erase. A newer version is accepted (Task 2).
- **Voice started from the `[ say ]` footer control while text is carried.** Expected: the carry is attached there too, since `make_action` decides it for `A_VOICE`. Covered by the same Task 4 change; add a footer-control case.
- **Carried text that expired** (`carry.error[0]`). Expected: unchanged. The existing `A_VOICE` guard still shows "Carried text"; the Task 4 test keeps the existing expired-carry case passing.

---

### Task 1: Confirm a fresh image only if its cable link started (bug 1)

**Files:**
- Modify:
  - `FW/main/fw_update.h`: replace `void fw_mark_valid(void);` with `void fw_confirm_boot(bool link_started);`, and move the comment to it, saying what each case does.
  - `FW/main/fw_update.c`: rename `fw_mark_valid` to `fw_confirm_boot(bool link_started)`.
  - `FW/main/app_main.c`: around `cable_client_start()` / `fw_mark_valid()`.
- Test: `FW/test/test_fw_update.py`.

**Interfaces:**
- Produces: `void fw_confirm_boot(bool link_started)`.
  - Not `PENDING_VERIFY` (or the state is unreadable): return.
  - `link_started`: `esp_ota_mark_app_valid_cancel_rollback()` and its existing logging.
  - Otherwise: `ESP_LOGE` "new image cannot open the cable — rolling back", then `esp_ota_mark_app_invalid_rollback_and_reboot()`. If it returns, `ESP_LOGE` "rollback failed: %s" and return.

- [ ] **Step 1: Write the failing test.** In `test_fw_update.py`:
  - Add a fake `esp_ota_mark_app_invalid_rollback_and_reboot()` that counts `rollbacks` and returns `fault==10` (non-zero = failed).
  - Replace the four `fw_mark_valid()` lines with these cases:
    - not pending, `fw_confirm_boot(false)` → `!marks && !rollbacks`;
    - not pending, `fw_confirm_boot(true)` → `!marks`;
    - pending, `fw_confirm_boot(true)` → `marks==1 && confirmed_log && !rollbacks`;
    - pending, `fw_confirm_boot(false)` → `rollbacks==1 && marks==0`;
    - pending, `fault=10`, `fw_confirm_boot(false)` → `rollbacks==1 && marks==0`, and the function returned;
    - keep the existing `fault=8` (state read fails) and `fault=9` (mark fails) cases on the `true` path.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 FW/test/test_fw_update.py`. Expected: FAIL to compile (`fw_confirm_boot` undefined).
- [ ] **Step 3: Implement `fw_confirm_boot`** per the Interfaces block.
- [ ] **Step 4: Update `app_main.c`:**
  - `bool linked = cable_client_start();`
  - If it fails, `ESP_LOGW` "cable link did not start — retrying once", `vTaskDelay(pdMS_TO_TICKS(200))`, then `linked = cable_client_start();`.
  - If it still fails, keep today's `ESP_LOGE` line.
  - Then `fw_confirm_boot(linked);`.
  - Update the comment above it: a fresh image that cannot reach the host is rolled back, because the cable is the only way to replace it.
- [ ] **Step 5: Run** the test (PASS) and the full host tests; build `default`. `git grep fw_mark_valid` finds nothing.
- [ ] **Step 6: Commit** `round dial: a fresh image that cannot open the cable rolls back instead of being confirmed`.

### Task 2: Decline the version that just rolled back (bug 1, no loop)

**Files:** Modify `FW/main/fw_update.c` (`fw_update_offer`, after the size check and before `esp_ota_begin`). Test: `FW/test/test_fw_update.py`.

- [ ] **Step 1: Write the failing test.**
  - Give the fake `esp_ota_get_state_partition` a per-partition state.
  - Make `esp_ota_get_partition_description` on the target slot report a settable version (reuse the harness's existing fake if present).
  - Cases:
    - target slot state `ESP_OTA_IMG_INVALID` with version "0.1.1": `fw_update_offer("0.1.1", …)` returns false, with no `esp_ota_begin` and `erases` unchanged;
    - the same slot with `fw_update_offer("0.1.2", …)` is accepted (`accepts` +1);
    - target slot `ESP_OTA_IMG_VALID` with version "0.1.1": `fw_update_offer("0.1.1", …)` is accepted (only a slot marked invalid blocks).
- [ ] **Step 2: Run.** Expected: FAIL (the 0.1.1 offer is accepted today).
- [ ] **Step 3: Implement.**
  - When `esp_ota_get_state_partition(target, &st) == ESP_OK && st == ESP_OTA_IMG_INVALID` and `esp_ota_get_partition_description(target, &d) == ESP_OK && !strcmp(d.version, version)`:
    - `ESP_LOGW(TAG, "offer %s declined: that image failed to start here", version)`;
    - return false.
  - Declining is silence, as for every other declined offer.
- [ ] **Step 4: Run** the test (PASS) and the full host tests.
- [ ] **Step 5: Commit** `round dial: decline re-offers of an image that rolled back`.

### Task 3: The Focus face talks only if the contact stayed within 24 px (bug 2)

**Files:** Modify `FW/main/ui/habitat/ui_habitat.c`:
- the `s` struct: add `int touch_far2;   // the largest squared distance from (start_x,start_y) this contact reached`;
- the down path in `habitat_touch`, where `s.start_x = x`: reset it to 0;
- the move path, on every sample: raise it to `(x-start_x)²+(y-start_y)²` when larger;
- the release path: include the release point;
- the Focus `A_PET` release branch: replace `dx * dx + dy * dy < 24 * 24` with `s.touch_far2 < 24 * 24`.

The `A_PET_INBOX` branch (the badge) gets the same change, because it uses the same rule.

Test: `FW/test/test_touch_ui.py`.

- [ ] **Step 1: Write the failing tests** next to the existing Focus voice-on-release cases. Use the file's own helpers (`reset()`, `habitat_touch(down,x,y,t)`, `starts`, `switches`, `congestion`):
  - **Out and back, horizontal:** `habitat_touch(true,233,220,1000)`, then `(false…)` moves to (310,220) at 1030 and (233,220) at 1060, release at 1080 → `starts==0 && switches==0`. Then `tap(2000,233,220)` → `starts==1`.
  - **Out and back, vertical while congested:** `congestion=true`, press (233,220), move to (233,330), back to (233,222), release within 600 ms → `starts==0`. Then `congestion=false; tap(…)` → `starts==1`.
  - **Drift:** press (233,220), move to (248,232) (about 19 px), release at (250,232) within 400 ms → `starts==1`.
  - **Badge:** a badge-press out-and-back opens no inbox (same pattern on the `A_PET_INBOX` region).

  Check how the existing tests simulate moves (`habitat_touch(true, …)` repeated is "move"), and follow that.
- [ ] **Step 2: Run** `python3 FW/test/test_touch_ui.py`. Expected: FAIL on the out-and-back cases (`starts==1`).
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run** the test (PASS) and the full host tests, including `test_voice_ui.py`, `test_question_ui.py` and `test_draft_ui.py`, which slice `ui_habitat.c`.
- [ ] **Step 5: Commit** `round dial: the Focus face talks only when the contact stayed within 24 px`.

### Task 4: Carried text goes with voice on Focus (bug 3)

**Files:** Modify `FW/main/ui/habitat/ui_habitat.c` `make_action()`. Its carry branch reads `(s.view == HOME || s.view == AGENT) && h.action == A_PET && carry.active`; extend it to `(h.action == A_PET || h.action == A_VOICE)`. Test: `FW/test/test_touch_ui.py`.

- [ ] **Step 1: Write the failing test.**
  - At the existing carry case (`tap(3400,233,220); assert(starts==1 && !strcmp(target,"b"));` with the comment "Focus starts voice from its own touch branch, without the carry context"), change the assert to `starts==1 && !strcmp(target,"b") && s.voice_carry && !strcmp(voice_context, carry.id)`, and drop that comment.
  - Add a footer `[ say ]` case: dispatch the Focus footer voice control while carrying, and assert the same.
- [ ] **Step 2: Run.** Expected: FAIL (`s.voice_carry` false).
- [ ] **Step 3: Implement** the one-condition change.
- [ ] **Step 4: Run** the test (PASS) and the full host tests. The existing expired-carry ("Carried text" message) case must still pass.
- [ ] **Step 5: Commit** `round dial: carried text goes with voice on the Focus face`.

### Task 5: Proof on a dial

**Files:** none.

- [ ] **Step 1: Build and flash.** Build `default` with `-DPROJECT_VER=0.1.0-dev`, and flash with the repo procedure:
  1. Quit Harness.
  2. `date +%s > ~/.harness/flasher/flashing`.
  3. `harness stop`.
  4. `python -m esptool chip_id`, which must say ESP32-S3.
  5. `idf.py -p <port> flash`.
  6. Remove the flag.
  7. `harness start`.
  8. Open Harness.

  Expected: the daemon log says `on fw 0.1.0-dev`.
- [ ] **Step 2: Ask Diego to check:**
  - a quick drag out and back on the face starts nothing;
  - a plain tap talks;
  - with text carried from the desktop, a tap on the face sends voice with that text (the agent receives the passage).

  Bug 1 has no on-dial check; its host tests are the proof.
