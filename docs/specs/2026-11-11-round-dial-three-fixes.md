# Round dial: three fixes the resources review found (Diego, 2026-11-11)

The review of PR #3848 found three defects that were already on main before it. They are fixed here, on the round
dial only (`devices/harness-device/firmware`, Focus is its only mode since #3848).

## 1. A new image is confirmed even when it cannot open the cable

**Today:** `app_main.c` calls `cable_client_start()`, logs if it fails, then calls `fw_mark_valid()` regardless.
A firmware pushed over the cable boots in `PENDING_VERIFY`; `fw_mark_valid()` cancels the rollback. If that image's
cable link cannot start (task creation, memory, the USB driver), the dial keeps an image that can never be updated
over the cable again: it needs a USB `harness flash`.

**Fixed:**
- **One retry.** If `cable_client_start()` fails, `app_main` tries once more after 200 ms. A failed start cleans up
  after itself, so a retry is safe.
- **Then a decision**, in a new `fw_confirm_boot(bool link_started)` (replaces `fw_mark_valid`, same file):
  - Not a fresh install (state is not `PENDING_VERIFY`): nothing to do, as today. A dial that is not mid-update
    keeps running and shows "Not connected".
  - Fresh install and the link started: confirm the image (today's path).
  - Fresh install and the link did not start: log it and call `esp_ota_mark_app_invalid_rollback_and_reboot()`.
    The dial reboots into the image it had before. If that call returns (no other valid image), log and keep
    running.
- **No loop.** After a rollback the bad image sits in the next update slot, marked `ESP_OTA_IMG_INVALID`, and the
  daemon would offer the same version again on the next `hello` (every 15 s). `fw_update_offer()` declines an
  offer when that slot is `INVALID` and holds the offered version (`esp_ota_get_partition_description`). Declining
  is silence, as for every other declined offer, so nothing is erased. A newer version is accepted.

## 2. On Focus, a drag that returns near its start starts voice

**Today:** the Focus face starts voice on release if the contact did not scroll, ended within 24 px of where it went
down, was not guarded, and lasted under 650 ms (`ui_habitat.c`, the `A_PET` branch with `dx*dx+dy*dy < 24*24`). It
looks only at where the finger came up. A finger that goes 77 px out and comes back, or a vertical drag that
returns while the host is congested and no scroll is reported, starts voice. Tim's layout did not.

**Fixed:** the face starts voice only if the contact never went more than 24 px from where it went down. A thumb that
drifts within 24 px and lifts still talks, as the 2026-10-01 rule intends.

## 3. On Focus, carried text is dropped when voice starts

**Today:** with text carried from the desktop (`carry.active`), a touch on the Focus face starts plain voice.
`make_action()` attaches the carry (`a.value = 3`, `a.text = carry.id`) only for an `A_PET` hit, but the Focus face
dispatches `A_VOICE`. So `s.voice_carry` stays false and the carried passage never reaches the agent.

**Fixed:** a touch on the Focus face while text is carried starts voice with the carry attached, as the pet did on
Tim: `s.voice_carry` is set and the voice names the carry id. Without carried text nothing changes.

## Done when

- **Tests:**
  - `make device-test` and every `firmware/test/test_*.py` pass (`test_cable_models.py` fails on macOS on main,
    as before).
  - New cases, each seen failing first:
    - `fw_confirm_boot` in all four combinations: (pending or not) × (link up or not).
    - A rollback call that returns.
    - The offer of an invalid slot's version declined, and a newer version accepted.
    - Out-and-back horizontal and congested vertical drags start no voice.
    - A 20 px drift still starts voice.
    - A tap with carried text starts voice with the carry attached.
- **Builds:** the default build and `-DBOARD_PROBE=1` still build.
- **On a dial** (USB, `-DPROJECT_VER=0.1.0-dev`):
  - an out-and-back drag starts nothing;
  - a plain tap talks;
  - carried text goes with the voice.

  Bug 1 cannot be triggered on a working dial; its host tests are the proof.

## Design

- **Growth, read cost, scale:** none.
- **Compatibility:** the cable protocol is unchanged. A declined offer is the existing silence, and the daemon keeps
  offering on `hello` as today; it no longer causes a reinstall.
- **Failure:** bug 1's fix can only roll back a fresh install that cannot reach the host. A transient failure on a
  good image costs one rollback, and the daemon offers that image again only when its version is not the one marked
  invalid. So a version that failed once is not retried until a newer one is published. That is accepted: a
  dial that silently stops taking updates is worse.
- **Platforms:** the round dial only. The Pro has its own firmware and is not touched.
