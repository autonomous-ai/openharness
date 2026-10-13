// Applying a firmware image that arrives over the cable (the Pro's half; ported from the round dial's receiver).
//
// The daemon pulls the published image (harness/esp32-pro/bin/X.Y.Z.bin) and pushes it as 0x03 frames; this
// file gets those bytes into the inactive OTA slot and refuses to boot into them unless five checks pass.
// The promise underneath: a failed update costs a reboot at worst and leaves the running image untouched.
//
// The cable (pro_cable.c) owns the wire and the app (pro_app.c) owns the glass; both reach this file through
// the hooks below, which are declared here and defined there (no defaults: a missing one fails the link). The
// host test supplies recording versions.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Confirm THIS image if this boot is a freshly installed one. With CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE an
// app booted from an OTA slot starts PENDING_VERIFY and the bootloader REVERTS it at the next reset unless told
// otherwise (an unconfirmed image keeps running until then). Do not call it directly: use the fw_confirm_*
// triggers below, which hold it back until the image has proved its cable path.
void fw_mark_valid(void);

// When to confirm: never before the first frame is painted, then at the FIRST cable session (pro_cable's
// session_up on `welcome`) or after 60 s of uptime, whichever comes first. A crash on the cable path then
// still rolls back, and an idle cable cannot cost a good image (it is merely confirmed at 60 s). Each returns
// true only on the call that did the confirming, so the caller can announce the update once.
bool fw_confirm_frame_painted(void);
bool fw_confirm_session_up(void);
bool fw_confirm_tick(uint32_t uptime_ms);
bool fw_confirm_pending(void);   // not confirmed (or decided) yet: keep ticking

// The first frame never painted within the wait: if this image is still on trial, revert to the previous one
// now (does not return) instead of leaving a dark, unconfirmed image running.
void fw_no_frame(void);

// True only if fw_mark_valid found PENDING_VERIFY, i.e. this boot is the first of an update. Copies the
// running version into `version`, for the "Updated to X.Y.Z" notice.
bool fw_was_updated(char *version, size_t cap);

// An image the daemon is offering. Accepting erases the slot and starts expecting slices; refusing leaves
// the running image and any transfer in flight alone. `busy` is the caller's "do not start now" (a voice
// recording is open). Refusals other than "a transfer is already in flight" tell the daemon with fw.error.
bool fw_update_offer(const char *version, int size, const char *sha256_hex, bool busy);

// One slice: the frame payload, a u32 little-endian offset then 1..8188 bytes of data. Ignored entirely when no
// offer is accepted (a late frame after an abort must never reach flash), and when shorter than 5 bytes. Only a
// slice at offset == written is written and acknowledged with fw.progress, which is what opens the daemon's credit
// window. Any other offset writes nothing: a gap (something was lost) asks for a resend, a duplicate is dropped.
void fw_update_slice(const uint8_t *data, size_t len);

// True while an update is in flight: the UI shows progress and touches do nothing.
bool fw_update_active(void);

// Abandon a transfer in flight (the session dropped). The running image keeps running.
void fw_update_abort(const char *why);

// Called from the cable task's periodic path with a millisecond clock: aborts a transfer that has seen no
// slice for 10 s and, after 1500 ms of silence, asks the daemon to resend from `written` (cable keepalives prove the host is alive, not that an image is still arriving).
void fw_update_tick(uint32_t now_ms);

// ---- hooks: the wire (implemented in pro_cable.c, Task 2) -----------------------------------------------
void fw_update_send_accept(void);
void fw_update_send_progress(int written);
void fw_update_send_resend(int written);   // fw.progress {written, resend:true}: continue from here
void fw_update_send_done(void);
void fw_update_send_error(const char *message);

// ---- hooks: the glass (implemented in pro_app.c, Task 3) ------------------------------------------------
void fw_update_ui_begin(const char *from, const char *to);
void fw_update_ui_pct(int pct);
void fw_update_ui_restarting(const char *to);
void fw_update_ui_failed(void);

// Reboot into the new image: esp_restart after 2 s on the device (so the last frame renders and reaches the
// daemon before the reboot takes the link with it), recorded in the host test.
void fw_update_restart(void);
