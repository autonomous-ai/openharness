# Harness Pro OTA over the cable

Status: design approved in chat by the owner on 2026-10-11:
- "A": the daemon updates the Pro with published images;
- "A1": automatic, as on the round;
- "ok": the architecture below;
- "U1": the update screen.

Risk: critical. The Pro has a power latch, so an image that does not boot cannot be recovered without a hand flash.

## Goal

When a Pro connects, the daemon updates it to the newest published Pro image over the USB cable. This works the way the round dial updates today. A release is published by a maintainer with one command.

## Non-goals

- OTA over Wi-Fi. The Pro has no Wi-Fi.
- A USB flasher for end users. `scripts/flash.sh` stays a developer tool, pinned to one unit.
- Resuming an interrupted transfer. As on the round, the next offer starts again from 0.
- Updating old Player-1 Pro builds. They never advertise `ota`, so they are never offered an image.
- Changes to `devices/harness-device`.

## Current state

- **Daemon.**
  - The daemon reads the manifest at `CABLE_FW_MANIFEST_URL`. Each board key maps to `{version,url,sha256,size}`.
  - It sends `fw.offer` and streams `CableType.Fw` (0x03) slices of 8 KB inside a 16 KB credit window.
  - It never re-offers the same mac:version, and allows at most 3 writes per hour per MAC.
  - Every `board:"pro"` device is skipped (`cableSession.ts`, `maybeOfferFirmware`).
- **Published manifest** (checked 2026-10-11): it holds `commander`, `commander-square` and `flasher`, and no Pro key.
- **Pro firmware.**
  - `partitions.csv` already has ota_0 and ota_1 (0x7E0000 each), and `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`.
  - There is no OTA code. `pro_cable_on_frame` drops non-JSON frames.
  - Nothing calls `esp_ota_mark_app_valid_cancel_rollback`. That is harmless today because `flash.sh` rewrites otadata.
- **Round receiver**, which the Pro's is copied from: `devices/harness-device/firmware/main/fw_update.c`.

## Design

### Pro firmware

**New `main/sys/fw_update.c` and `.h`**, a copy of the round's receiver, adjusted to the Pro:

- **`fw.offer {version,size,sha256}`**. It declines with `fw.error` in these cases:
  - while a recording, a voice send or another transfer is in flight;
  - when the version is not plain `X.Y.Z`;
  - when the sha is not 64 hex characters;
  - when the size does not fit the next OTA partition.

  Otherwise it calls `esp_ota_begin`, shows the update screen and sends `fw.accept`.
- **Slices (frame type 0x03).** The payload is a u32 little-endian offset, then 1..8188 bytes of data (a payload under 5 bytes is ignored). A slice at `offset == written` goes to `esp_ota_write` and is acked with `fw.progress {written}`.
  - Any other offset writes nothing. A gap (`offset > written`, something was lost) sends `fw.progress {written, resend:true}`, at most once per 500 ms for the same `written`; a duplicate after a rewind (`offset < written`) is ignored. The daemon rewinds to `written` and resends.
  - With no slice accepted for 1500 ms and `written < size`, the device sends the same resend request, again every 1500 ms of silence.
  - A slice past the offered size aborts the transfer.
  - A stall of 10 s with no slice aborts it.
  - A lost session aborts it.
- **The image, once every byte has arrived.** All of these must pass, in this order, before the boot slot changes:
  1. `esp_ota_end` (IDF checks the image header, the chip ID and the chip revision range).
  2. The sha256 of the bytes read back from the partition equals the offered one.
  3. `esp_app_desc.version` equals the offered version.
  4. **Pro only:** `esp_app_desc.project_name` equals this build's own (`harness_pro`). This guards against a same-chip image for a different board.
  5. **Pro only:** the image's minimum chip revision is no higher than this chip's revision.

  Then `esp_ota_set_boot_partition`, `fw.done`, the Restarting screen for about 2 s, and `esp_restart`.
- **Any failure.** `esp_ota_abort` (the boot slot is untouched), `fw.error {message}`, the previous screen and a red notice: "Update failed · trying again later".
- **Mark valid.** The image is confirmed (`esp_ota_mark_app_valid_cancel_rollback`, only in PENDING_VERIFY) on the first cable session (`welcome`), or after 60 s of uptime with a painted frame, whichever comes first. It is never confirmed before the first frame.
  - Confirming on the first frame alone (the round's rule) would keep an image whose cable path crashes, and the cable is the Pro's only way to take a fix (review, 2026-10-11).
  - An unconfirmed image keeps running; the bootloader reverts it only at the next reset.
  - If no frame paints at all, the image asks for its own rollback (`esp_ota_mark_app_invalid_rollback_and_reboot`).
- **Updated notice.** When `fw_mark_valid()` finds the image in PENDING_VERIFY, the first screen shows the notice "Updated to X.Y.Z" for 3 s. The notice pill already exists, so no NVS is needed.
- **Hello** adds `ota:"v1"`.

**Screens** (`pod` and glue, mockup `devices/harness-pro/mockup/pro-ota.html`):
- **U1, Updating.** Its own screen, with the status bar "Updating" and no transport. It shows the `>_` mark, "Updating Harness Pro", "<old> → <new>", a progress bar, the %, and "Keep the cable in".
  - Touch is ignored.
  - The screen stays awake.
  - Notifications still land in the Inbox, but no banner and no beep.
- **Restarting.** A spinner, "Restarting…" and "<new> is installed".

### Daemon (`cli/src/cable`)

- **Choosing the image.** The `board==='pro'` skip becomes a key lookup:
  - a hello with `board:"pro"` and `ota:"v1"` uses the manifest key `harness-pro`;
  - a `board:"pro"` hello without `ota` gets no offer;
  - the round's `hw`-based choice is unchanged.
- **Dev builds** are never offered. A dev build's version (`0.0.99-pod`) fails the plain `X.Y.Z` rule in `shouldOffer`. Correct the comment in the Pro's `CMakeLists.txt`, which gives the wrong reason.
- **Unchanged:** the offer, the credit window, the once per mac:version rule, 3 per hour, and `updating` in the device report.

### Release

- **`make upload-pro`** runs a new, Pro-owned `devices/harness-pro/firmware/scripts/upload-firmware.sh`, maintainer only.
  - The version is the manifest's `harness-pro` version with the patch number bumped. The first release is 0.1.0.
  - The build is `idf.py -DPROJECT_VER=X.Y.Z -DPOD_PANEL_TURN=180 build` with IDF 5.5.4, in a clean build directory.
  - It refuses to upload unless:
    - the image's `project_name` is `harness_pro`;
    - the chip is esp32p4;
    - the minimum revision is v3.0;
    - the version is plain `X.Y.Z`.
  - It uploads `harness/esp32-pro/bin/X.Y.Z.bin`, then merges only the `harness-pro` key into `metadata.json`.
  - The round's script and keys are not touched.
- The release runbook is added to the Pro README.

### Desktop

- A Pro that is updating says "Your Harness Pro is updating" where the round says dial, using `isPro` from `dial_status.dart`. Nothing else changes.

## Errors

The cable occasionally loses 8 to 50 bytes of host-to-device data; the frame then fails its CRC and the decoder resyncs past it. Outside a transfer, when `cable_link_counters()` shows more corrupt frames than last seen, the device sends `swarms.list` and `agents.list` (at most once per 5 s) so a lost roster push is replaced. During a transfer the resend rules above cover it.

| Case | Result |
|---|---|
| A slice lost on the way in | The device writes nothing past the gap and asks for a resend from `written`; the daemon rewinds. The 10 s stall abort still applies if `written` does not advance. |
| Cable out mid-transfer | The device aborts on session loss or after a 10 s stall. The old image keeps running. The daemon offers again on the next hello, within the hourly cap. |
| Wrong sha, version, project or revision | Rejected before the boot slot changes. `fw.error` carries the reason, and the red notice shows. |
| New image crashes before mark-valid | The bootloader rolls back to the previous image on the next reset. |
| Offer during voice or sending | Declined, with no screen and no notice. The daemon offers again at the next hello. |
| Image larger than the slot | Declined at offer time. |

Retries: a version is recorded as installed for a MAC only on `fw.done`. A decline, failure or interruption lets the daemon offer it again at a later hello, and every attempt counts toward the cap of 3 per hour. After `fw.done` the same version is never offered again, even if the unit rolled back to its old version. The daemon also ends a transfer whose acks stop advancing for 30 s.

## Security and limits

- **The checks prove integrity, not authenticity.**
  - The sha256 comes from the same party that sends the bytes.
  - Secure boot and signed apps are off, so anything that can talk to the Pro's USB port can install an image. The same is already true of esptool on that port.
  - On the daemon side, trust is write access to the GCS bucket.
  - Signed images are future work.
- **OTA replaces only the app.** The bootloader, partition table and rollback settings always need a hand flash. Rollback protects only units whose bootloader came from a rollback-enabled `flash.sh` run.
- **The device accepts any plain version; the daemon offers only a newer one.** To roll back a bad release, publish the old code under a higher patch.
- **Panel orientation.** Every Pro panel is mounted turned 180° (owner, 2026-10-11), so the release image is built with `POD_PANEL_TURN=180`. A future unit mounted differently needs its own board key, or a runtime setting, before it may take this image (audit H2).
- **The publish script** aborts when it cannot read the manifest (unless the manifest does not exist yet). It refuses a merge that drops or changes another key, writes the manifest with a generation precondition, and never overwrites a published `.bin`.

## Testing

- **Firmware host tests** (`test/`) for the `fw_update` state machine, with `esp_ota_*` and `esp_app_desc` stubbed:
  - offer validation;
  - a decline while voice or sending is in flight;
  - a slice past the size;
  - stall and session-loss aborts;
  - each of the five end checks failing leaves the boot slot unset;
  - the happy path sets the boot slot and sends `fw.done`;
  - `fw_mark_valid` only acts in PENDING_VERIFY.
- **Views:** golden screens for U1 at 0%, 42% and 100%, Restarting, and the two notices. Existing screens stay byte-identical.
- **Daemon specs:**
  - a pro hello with `ota:"v1"` is offered the `harness-pro` entry;
  - one without `ota` is not;
  - a `-pod` version is not;
  - the round's choice is unchanged.
- **Desktop:** the Pro wording test.
- **On the device, without publishing.**
  1. Hand-flash a build versioned `0.0.98` with `flash.sh`. The daemon offers only to a device whose own version is plain `X.Y.Z`, so a `-pod` build is never offered anything.
  2. Point `CABLE_FW_MANIFEST_URL` at a local manifest that serves a 0.1.0 build.
  3. Check: the update runs, the Pro restarts on 0.1.0, shows "Updated to 0.1.0", and survives a second reboot (it was marked valid).
  4. Then serve a 0.1.1 built with another `project_name` and check that it is rejected and 0.1.0 keeps running.
  5. Restore the dev build with `flash.sh` afterwards.
