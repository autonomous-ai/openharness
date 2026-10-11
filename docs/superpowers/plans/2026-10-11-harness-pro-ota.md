# Harness Pro OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Pro connects, the daemon updates it to the newest published Pro image over the USB cable, the way it updates the round.

**Architecture:**
- The Pro gets a copy of the round's OTA receiver (`fw_update.c`), with two extra end checks: project name and chip revision.
- `pro_cable` routes `fw.offer` and 0x03 frames to it.
- The Pod glue draws the U1 "Updating" screen.
- The daemon replaces its Pro skip with a manifest key lookup gated on `ota:"v1"`.
- A Pro-owned upload script publishes the `harness-pro` key.

**Tech Stack:** ESP-IDF 5.5.4 (C11), TypeScript daemon (vitest), Flutter desktop, bash.

**Spec:** `docs/superpowers/specs/2026-10-11-harness-pro-ota-design.md`

## Global Constraints

- Worktree `/private/tmp/claude-503/x/hpro`, firmware `devices/harness-pro/firmware`.
- Do not commit or push.
- `devices/harness-device` must not change.
- Never flash with anything but `scripts/flash.sh`.
- Manifest key `harness-pro`. Bin path `harness/esp32-pro/bin/X.Y.Z.bin`. First release 0.1.0.
- Offer only to a hello with `board:"pro"` and `ota:"v1"`. A `-pod` (non `X.Y.Z`) version is never offered.
- End checks before `esp_ota_set_boot_partition`, all required, in this order:
  1. `esp_ota_end`;
  2. the sha256 read back from the partition;
  3. `esp_app_desc.version` equals the offer;
  4. `project_name` equals the running image's;
  5. the image's minimum chip revision ≤ this chip's revision.
- Stall abort: 10 s. Declined while `pro_voice_open()`.
- Copy:
  - "Updating" (status bar);
  - "Updating Harness Pro";
  - "<old> → <new>";
  - "Keep the cable in";
  - "Restarting…";
  - "<new> is installed";
  - "Updated to X.Y.Z" (3 s notice);
  - "Update failed · trying again later";
  - desktop "Your Harness Pro is updating".
- Firmware gates after each firmware task:
  - `PATH=/usr/local/bin:$PATH bash test/run.sh` with the default font and with `PRO_FONT=$PWD/fonts/LiberationSans-Regular.ttf`;
  - `test/golden.sh --check` for both fonts;
  - `idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build` clean.

## Review Focus

1. **A 0x03 slice arriving with no offer accepted** (or after an abort) must be ignored. It must never call `esp_ota_write`. Task 1 test `slice_without_offer_is_ignored`.
2. **A second `fw.offer` while one is in flight** is declined, and the first continues. Task 1 test `second_offer_declined`.
3. **The session dropping and coming back mid-transfer:** the old transfer is aborted, the screen returns, and a fresh offer is accepted. Task 2 test `session_down_aborts_then_new_offer_ok`.
4. **A voice press during an update** must not start a recording. Task 3 test `voice_refused_while_updating`.
5. **A manifest entry whose version is not newer** than the device's (equal, or a downgrade) is not offered. Task 4 spec `pro equal or older version not offered`.

---

### Task 1: The OTA receiver

**Files:**
- Create: `main/sys/fw_update.c`, `main/sys/fw_update.h`
- Create: `test/test_fw_update.c`, `test/host_esp/esp_ota_ops.h` (stubs: in-memory partition, a settable app desc, a settable chip revision)
- Modify: `test/run.sh` (build and run `test_fw_update`), `main/CMakeLists.txt` (source; REQUIRES `app_update`, `mbedtls` already present)

**Interfaces:**
- Produces (`fw_update.h`):
  - `void fw_mark_valid(void);`
  - `bool fw_was_updated(char *version, size_t cap);` — true only if `fw_mark_valid` found PENDING_VERIFY. It then copies the running version into `version`.
  - `bool fw_update_offer(const char *version, int size, const char *sha256_hex, bool busy);`
  - `void fw_update_slice(const uint8_t *data, size_t len);`
  - `bool fw_update_active(void);`
  - `void fw_update_abort(const char *why);`
  - `void fw_update_tick(uint32_t now_ms);` — aborts after 10 s with no slice.
- Consumes, declared in `fw_update.h` and implemented by Task 2 (by test stubs here):
  - `void fw_update_send_accept(void);`
  - `void fw_update_send_progress(int written);`
  - `void fw_update_send_done(void);`
  - `void fw_update_send_error(const char *message);`
- Consumes, implemented by Task 3:
  - `void fw_update_ui_begin(const char *from, const char *to);`
  - `void fw_update_ui_pct(int pct);`
  - `void fw_update_ui_restarting(const char *to);`
  - `void fw_update_ui_failed(void);`
- Restart goes through `void fw_update_restart(void);`: `esp_restart` after 2000 ms on the device, recorded in the test.

- [ ] **Step 1: Write failing tests** in `test/test_fw_update.c`:
  - `offer_validation`: refuses version `"0.1"`, `"0.1.0-pod"`, a sha of 63 characters or with non-hex, size 0, and size > partition size. Each refusal sends `fw.error` and does not call `esp_ota_begin`.
  - `busy_declined`: `busy=true` → false, no `esp_ota_begin`.
  - `second_offer_declined`.
  - `slice_without_offer_is_ignored`.
  - `slice_past_size_aborts`.
  - `stall_aborts_after_10s`: a tick at +9999 ms keeps it; at +10000 ms it aborts with `fw_update_ui_failed` and `fw.error`.
  - `end_checks` table, one row per check: a bad sha, version mismatch, project `"other"`, image min revision 301 on chip 300, and `esp_ota_end` failing. Each row expects no `esp_ota_set_boot_partition`, `esp_ota_abort` called, `fw.error`, and `ui_failed`.
  - `happy_path`:
    - progress acks after each slice;
    - pct 0..100 monotonic;
    - set_boot called once;
    - `fw.done`, `ui_restarting("0.1.0")`, restart recorded.
  - `mark_valid_only_when_pending`:
    - in VALID state no cancel call, and `fw_was_updated` is false;
    - in PENDING_VERIFY one cancel call, and `fw_was_updated` returns true with the running version.
- [ ] **Step 2:** `bash test/run.sh` → FAIL (`fw_update.h` missing).
- [ ] **Step 3: Implement `fw_update.c`.** Port `devices/harness-device/firmware/main/fw_update.c` (read it, do not edit it).
  - Hashing: sha256 with mbedtls over `esp_partition_read` of the written range.
  - Project and revision come from `esp_ota_get_partition_description` on the new partition, compared with `esp_app_get_description()` and `efuse_hal_chip_revision()`. The image's minimum revision is `esp_image_header_t.min_chip_rev_full`, read from the partition's first bytes.
- [ ] **Step 4:** `bash test/run.sh` → PASS with both fonts; the build is clean.

### Task 2: Cable wiring and hello

**Files:**
- Modify: `main/cable/pro_cable.c` (the dispatch at `:759-800`, `pro_cable_on_frame` at `:808`, `send_hello` at `:203`, session down)
- Modify: `test/test_pro_cable.c`, `test/test_pro_hello.py`

**Interfaces:**
- Consumes: Task 1's `fw_update.h`.
- Produces: the four `fw_update_send_*` functions, implemented in `pro_cable.c` with `msg()` and `send_json()`:
  - `fw.accept {}`;
  - `fw.progress {written}`;
  - `fw.done {}`;
  - `fw.error {message}`.

- [ ] **Step 1: Failing tests.**
  - `test_pro_cable.c`:
    - `fw_offer_routes`: a `fw.offer` JSON calls `fw_update_offer` (a recording stub) with its version, size and sha, and `busy = pro_voice_open()`.
    - `fw_frame_routes`: a type-0x03 frame calls `fw_update_slice` with the payload, and a 0x03 frame is not counted as unknown.
    - `session_down_aborts_then_new_offer_ok`.
    - `send_shapes`: the four messages have exactly the fields above.
  - `test_pro_hello.py`: the hello has `"ota":"v1"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Route `fw.offer` before the agent-id block.
  - Call `fw_update_tick(now)` from the cable task's existing periodic path.
  - Call `fw_update_abort("session down")` where the session is torn down.
  - Add `ota:"v1"` to the hello.
- [ ] **Step 4:** Gates pass.

### Task 3: Screens, mark valid, notices

**Files:**
- Create: `main/pod/pod_view_ota.c` (U1 and Restarting; declared in `pod_view.h`)
- Modify: `main/app/pod_glue.c`, `pod_glue.h`, `main/app/pro_app.c`, `main/app_main.c`
- Modify: `test/pod_render.c` (screens `ota:0`, `ota:42`, `ota:100`, `ota:restart`, `notice:updated`, `notice:failed`), `test/golden.sh` (add them), `test/test_pro_app.py`

**Interfaces:**
- Consumes: Task 1's UI hooks and `fw_was_updated`.
- Produces in glue:
  - `void pod_ui_ota(pod_ui_t *, const char *from, const char *to, int pct, bool restarting);` (pct < 0 ends the screen);
  - `bool pod_ui_updating(const pod_ui_t *);`
  - `void pod_view_ota(pod_out_frame_t *, const char *from, const char *to, int pct, bool restarting);`

- [ ] **Step 1: Failing tests.**
  - `test_pro_app.py`:
    - `ota_screen_and_touch`: `fw_update_ui_begin` puts the screen up, and touches change nothing.
    - `voice_refused_while_updating`: the voice button and the PTT start no recording.
    - `ota_failed_returns`: `ui_failed` restores the previous view and shows the notice "Update failed · trying again later".
    - `ota_keeps_awake`: no sleep while updating.
    - `ota_notifications_quiet`: a summary while updating lands in the Inbox with no banner and no beep.
    - `updated_notice`: with `fw_was_updated` true at start, the notice "Updated to 0.1.0" shows for 3 s.
  - Golden: the six new screens are added. All 255 existing hashes are unchanged.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement**, following the mockup `devices/harness-pro/mockup/pro-ota.html` (U1).
  - The `>_` mark is drawn with `mark_default_big`.
  - The bar's fill uses the transport's blue gradient.
  - `pod_ui_render` draws `pod_view_ota` instead of the stack while it is on.
  - `pro_app.c` implements the four `fw_update_ui_*` hooks under the app lock.
  - `app_main.c` calls `fw_mark_valid()` after the render task's first frame and `pro_cable` start, as in the round's `app_main.c:229`.
- [ ] **Step 4:** Gates pass. Golden is rebaselined only by adding the six screens. Report the diff count, which must be 0 changed and 6 added.

### Task 4: Daemon offers the Pro image

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (hello parsing `:1134-1138`, `maybeOfferFirmware` `:1660-1695`), `cli/src/cable/fwPush.ts` (`otaKeyForBoard`, `PRO_OTA_KEY`), `cli/src/cable/cableHost.ts` (`firmwareFor` `:677`)
- Modify: `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/fwPush.spec.ts`
- Modify: `devices/harness-pro/firmware/CMakeLists.txt:8` (the comment: dev builds are safe because `-pod` fails the plain `X.Y.Z` rule)

**Interfaces:**
- Produces: `otaKeyFor(hw: string | undefined, board: string | undefined, ota: string | undefined): string | null`. It returns:
  - `'harness-pro'` iff `board === 'pro' && ota === 'v1'`;
  - `null` for any other `board === 'pro'`;
  - otherwise the existing `hw` mapping. Old Player-1 builds (`hw:'harness-pro'`, no board) now map to `null`.

- [ ] **Step 1: Failing specs:**
  - `pro with ota v1 is offered the harness-pro entry`;
  - `pro without ota is not offered`;
  - `pro -pod version not offered`;
  - `pro equal or older version not offered`;
  - `hw harness-pro without board is not offered`;
  - `round choice unchanged` (the existing commander cases).
- [ ] **Step 2:** `cd cli && npx vitest run src/cable` → FAIL.
- [ ] **Step 3:** Implement. The firmware cache path (`firmware/<version>.bin`) becomes `firmware/<key>-<version>.bin`, so Pro and round images with the same version cannot collide.
- [ ] **Step 4:** Check:
  - `npx tsc --noEmit -p .`;
  - `npx vitest run src/cable src/services src/architecture.spec.ts`;
  - `npm run test:harnessd`.

  All must pass.

### Task 5: Release script

**Files:**
- Create: `devices/harness-pro/firmware/scripts/upload-firmware.sh`
- Modify: `Makefile` (target `upload-pro`, next to `upload-circle`), `devices/harness-pro/firmware/README.md` (runbook)
- Test: `devices/harness-pro/firmware/test/test_upload_checks.sh` (runs the script with `--check-only <bin>`)

**Interfaces:**
- Produces:
  - `upload-firmware.sh [--dry-run] [--check-only BIN]`.
  - `--check-only` runs only the image checks on a given bin and exits 0 or 1. The checks use `esptool image-info` (the flasher's esptool path, as in `flash.sh`):
    - chip esp32p4;
    - min revision v3.0;
    - project `harness_pro`;
    - plain `X.Y.Z` version.
  - `--dry-run` builds and checks but prints the gcloud commands instead of running them.

- [ ] **Step 1:** In `test_upload_checks.sh`:
  - the current `build/harness_pro.bin` (version `0.0.99-pod`) is refused for its version;
  - a copy with a patched header is refused for chip or project, if esptool allows building one; otherwise only the version case.
- [ ] **Step 2:** Run → FAIL (no script).
- [ ] **Step 3:** Implement.
  - Read the manifest version for `harness-pro`, bump the patch, or use 0.1.0 when it is absent.
  - Build in `build-release/`.
  - Check, upload `harness/esp32-pro/bin/X.Y.Z.bin`, and merge only `data["harness-pro"]` (pattern: `devices/harness-device/firmware/scripts/upload-firmware.sh:187-237`; read it, do not edit it).
  - Add the README runbook.
- [ ] **Step 4:** Run `test_upload_checks.sh` and `scripts/upload-firmware.sh --dry-run` → PASS. Do not upload anything.

### Task 6: Desktop wording

**Files:**
- Modify: `desktop/lib/companions/companion_dial.dart:72-92` (or wherever "Your dial is updating" is), `desktop/test/devices_screen_test.dart` or the nearest test of that widget.

- [ ] **Step 1: Failing test:** a status with `isPro` and `updating: '0.1.0'` shows "Your Harness Pro is updating"; a round still shows the existing copy.
- [ ] **Step 2:** `cd desktop && flutter test <file>` → FAIL.
- [ ] **Step 3:** Implement with `status.isPro`.
- [ ] **Step 4:** `flutter test <file>` and `flutter analyze` → PASS.

### Task 7: On-device check (lead only, no publishing)

- [ ] **Step 1:** Build `-DPROJECT_VER=0.0.98` and flash it with `scripts/flash.sh`.
- [ ] **Step 2:** Build 0.1.0 into `build-010/`. Serve a manifest `{"harness-pro":{version,url,sha256,size}}` and the bin from `python3 -m http.server` in the scratchpad.
- [ ] **Step 3:** Restart the daemon with `CABLE_FW_MANIFEST_URL` set to it. Expected:
  - U1 runs to 100%, then Restarting;
  - the Pro boots 0.1.0 and shows "Updated to 0.1.0";
  - the heartbeat shows the session up;
  - after a power cycle it is still 0.1.0.
- [ ] **Step 4:** Serve a 0.1.1 built with `-DPROJECT_NAME=other` (or a patched project field). Expected: "Update failed · trying again later", 0.1.0 still running, and `fw.error` in the dial log.
- [ ] **Step 5:**
  - Restore: flash the dev build `0.0.99-pod` with `flash.sh`, and restart the daemon without the env var.
  - Report the evidence (log lines, photos from the owner) to the owner.
