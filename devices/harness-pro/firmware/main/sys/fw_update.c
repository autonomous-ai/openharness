#include "fw_update.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/efuse_hal.h"
#include "mbedtls/sha256.h"

static const char *TAG = "fw";

// Read-back buffer for the hash. Small and static on purpose: this runs on the cable task (6 KB stack, whose
// frames are capped at compile time), which also carries esp_ota_write().
#define VERIFY_CHUNK 1024
// No slice for this long ends the transfer. The daemon's keepalives prove the host is alive, not that an
// image is still arriving; a stalled half-image must not hold the screen (and the voice gate) forever.
#define STALL_MS 10000u
// Silence on a live transfer before asking for a resend, and the least gap between two asks for the same offset.
#define SILENCE_MS 1500u
#define GAP_ASK_MS 500u

static const esp_partition_t *s_target;
static esp_ota_handle_t       s_handle;
static bool                   s_active;
static uint32_t               s_written;
static uint32_t               s_expected;
static uint32_t               s_last_slice_ms;
static uint32_t               s_resend_ms;        // when we last asked for a resend...
static int64_t                s_resend_written;   // ...and from which offset (-1: not yet)
static int                    s_last_pct;
static char                   s_sha_hex[65];
static char                   s_version[32];
// Set by fw_mark_valid when this boot was a fresh install (PENDING_VERIFY); read by fw_was_updated.
static bool                   s_updated;

// The hooks (fw_update_send_*, fw_update_ui_*) have no default here: pro_cable.c and pro_app.c define them, so a
// missing or renamed one fails the link instead of silently doing nothing. The host test records its own.
#ifndef FW_UPDATE_HOST_TEST
void fw_update_restart(void)
{
    // Let the last frame render and reach the daemon before the reboot takes the link with it: a device that
    // vanishes mid-sentence looks to the far end like a crash rather than a success.
    vTaskDelay(pdMS_TO_TICKS(2000));
    esp_restart();
}
#endif

static void reset_state(void)
{
    s_active = false;
    s_target = NULL;
    s_handle = 0;
    s_written = 0;
    s_expected = 0;
    s_last_slice_ms = 0;
    s_resend_ms = 0;
    s_resend_written = -1;
    s_last_pct = -1;
}

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

// Every failure after the offer was accepted: free the OTA handle (the running image and the boot partition
// are untouched), tell the daemon why, put the previous screen back, and be idle again.
static void fail(const char *why)
{
    ESP_LOGE(TAG, "update failed: %s", why);
    if (s_handle) esp_ota_abort(s_handle);   // after esp_ota_end the handle is already gone: harmless then
    reset_state();
    fw_update_send_error(why);
    fw_update_ui_failed();
}

bool fw_update_active(void) { return s_active; }

void fw_mark_valid(void)
{
    s_updated = false;
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (!run || esp_ota_get_state_partition(run, &st) != ESP_OK) return;
    if (st != ESP_OTA_IMG_PENDING_VERIFY) return;   // not a fresh install: nothing to confirm

    if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
        ESP_LOGE(TAG, "could not confirm the image");
        return;
    }
    s_updated = true;
    const esp_app_desc_t *me = esp_app_get_description();
    ESP_LOGW(TAG, "image confirmed (%s): rollback cancelled", me ? me->version : "?");
}

// ---- when a fresh image is confirmed ---------------------------------------------------------------------------
// Never before the first frame is painted, then at the first cable session (the welcome: parsed, the roster asked
// for) or, failing that, once the uptime reaches CONFIRM_MS. An image whose cable path crashes would otherwise be
// confirmed and then reboot-loop with no rollback, and the cable is the only way to fix it.
#define CONFIRM_MS 60000u
static atomic_bool s_painted, s_session_seen, s_confirmed;

static bool confirm_now(void)
{
    if (atomic_exchange(&s_confirmed, true)) return false;
    fw_mark_valid();
    return true;
}
// Each side stores its own flag, then reads the other's: whichever comes second confirms (once).
bool fw_confirm_frame_painted(void)
{
    atomic_store(&s_painted, true);
    return atomic_load(&s_session_seen) && confirm_now();
}
bool fw_confirm_session_up(void)
{
    atomic_store(&s_session_seen, true);
    return atomic_load(&s_painted) && confirm_now();
}
bool fw_confirm_tick(uint32_t uptime_ms)
{
    return atomic_load(&s_painted) && uptime_ms >= CONFIRM_MS && confirm_now();
}
bool fw_confirm_pending(void) { return !atomic_load(&s_confirmed); }

void fw_no_frame(void)
{
    // A dark glass nobody can see is not an image to keep: back to the previous one at once, if there is one.
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (!run || esp_ota_get_state_partition(run, &st) != ESP_OK || st != ESP_OTA_IMG_PENDING_VERIFY) return;
    ESP_LOGE(TAG, "no first frame: rolling back");
    esp_ota_mark_app_invalid_rollback_and_reboot();   // returns only if it could not
}

#ifdef FW_UPDATE_HOST_TEST
void fw_confirm_test_reset(void)
{
    atomic_store(&s_painted, false); atomic_store(&s_session_seen, false); atomic_store(&s_confirmed, false);
}
#endif

bool fw_was_updated(char *version, size_t cap)
{
    if (!s_updated) return false;
    const esp_app_desc_t *me = esp_app_get_description();
    if (version && cap) snprintf(version, cap, "%s", me ? me->version : "");
    return true;
}

void fw_update_abort(const char *why)
{
    if (!s_active) return;
    ESP_LOGW(TAG, "update abandoned: %s", why);
    if (s_handle) esp_ota_abort(s_handle);
    reset_state();
    fw_update_ui_failed();   // the link is gone, so no fw.error; the screen still has to come back
}

void fw_update_tick(uint32_t now)
{
    // Unsigned subtraction: right across the 49-day wrap of a millisecond counter.
    if (!s_active) return;
    if ((uint32_t)(now - s_last_slice_ms) >= STALL_MS) { fail("firmware transfer stalled"); return; }
    // A lost slice leaves both sides waiting: nudge the daemon back to `written` every 1500 ms of silence.
    if (s_written < s_expected && (uint32_t)(now - s_last_slice_ms) >= SILENCE_MS && (uint32_t)(now - s_resend_ms) >= SILENCE_MS) {
        s_resend_ms = now;
        s_resend_written = s_written;
        fw_update_send_resend((int)s_written);
    }
}

// Plain X.Y.Z: three non-empty runs of digits. A dev build ("0.1.0-pod") or anything looser is refused, so
// only a published release can ever be installed.
static bool plain_version(const char *v)
{
    if (!v || strnlen(v, sizeof s_version) >= sizeof s_version) return false;
    int parts = 0, digits = 0;
    for (const char *p = v; ; p++) {
        if (*p >= '0' && *p <= '9') { digits++; continue; }
        if (digits == 0 || (*p != '.' && *p != 0)) return false;
        digits = 0;
        parts++;
        if (*p == 0) break;
    }
    return parts == 3;
}

bool fw_update_offer(const char *version, int size, const char *sha256_hex, bool busy)
{
    // A second offer while one is in flight is declined WITHOUT fw.error: the daemon would read that as the
    // failure of the transfer it is carrying, and the first update would stall out.
    if (s_active) return false;

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    const char *refuse = NULL;
    if (!plain_version(version)) refuse = "bad version";
    else if (!sha256_hex || strnlen(sha256_hex, sizeof s_sha_hex) != 64) refuse = "bad sha256";
    else if (size <= 0) refuse = "bad size";
    else if (!target) refuse = "no update slot";
    else if (target->size < (uint32_t)size) refuse = "image does not fit";
    else if (busy) refuse = "busy";   // never mid-voice: a reboot in the middle of a turn looks like a crash
    for (unsigned i = 0; !refuse && i < 64; i++) {
        char c = sha256_hex[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) refuse = "bad sha256";
    }
    if (refuse) {
        ESP_LOGW(TAG, "offer declined: %s", refuse);
        fw_update_send_error(refuse);   // the daemon offers again on the next hello
        return false;
    }

    for (unsigned i = 0; i < 64; i++) s_sha_hex[i] = sha256_hex[i] >= 'A' && sha256_hex[i] <= 'F' ? sha256_hex[i] + ('a' - 'A') : sha256_hex[i];
    s_sha_hex[64] = 0;
    snprintf(s_version, sizeof s_version, "%s", version);

    // esp_ota_begin ERASES the slot, which takes seconds; the screen goes up first so the device does not look
    // frozen at exactly the moment a user must not pull the cable.
    const esp_app_desc_t *me = esp_app_get_description();
    ESP_LOGI(TAG, "accepting %s (%d B) into %s", version, size, target->label);
    fw_update_ui_begin(me ? me->version : "", version);
    s_handle = 0;
    if (esp_ota_begin(target, (size_t)size, &s_handle) != ESP_OK) {
        if (s_handle) esp_ota_abort(s_handle);
        reset_state();
        fw_update_send_error("could not start the update");
        fw_update_ui_failed();
        return false;
    }
    s_target = target;
    s_expected = (uint32_t)size;
    s_written = 0;
    s_last_pct = -1;
    s_active = true;
    s_last_slice_ms = s_resend_ms = now_ms();
    fw_update_send_accept();
    return true;
}

// SHA-256 of what is ACTUALLY IN FLASH, read back out of the partition. Not of the bytes as they went past:
// the point is to catch a write that did not land, and a hash taken on the way in cannot see that.
static bool written_hash_matches(void)
{
    static uint8_t buf[VERIFY_CHUNK];
    mbedtls_sha256_context ctx;
    uint8_t digest[32];
    bool ok = true;
    mbedtls_sha256_init(&ctx);
    ok = mbedtls_sha256_starts(&ctx, 0) == 0;
    for (uint32_t off = 0; ok && off < s_written; ) {
        const uint32_t n = s_written - off < VERIFY_CHUNK ? s_written - off : VERIFY_CHUNK;
        ok = esp_partition_read(s_target, off, buf, n) == ESP_OK && mbedtls_sha256_update(&ctx, buf, n) == 0;
        off += n;
    }
    ok = ok && mbedtls_sha256_finish(&ctx, digest) == 0;
    mbedtls_sha256_free(&ctx);
    if (!ok) return false;
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    return strcmp(hex, s_sha_hex) == 0;
}

// Checks 3 to 5, on the image as the bootloader will see it: its version is the one offered, it is the same
// product as the running one, and this chip is new enough to run it. Returns a reason, or NULL when fine.
static const char *image_refusal(void)
{
    esp_app_desc_t cand;
    if (esp_ota_get_partition_description(s_target, &cand) != ESP_OK) return "image has no app description";
    if (strncmp(cand.version, s_version, sizeof cand.version) != 0) return "image version does not match offer";
    const esp_app_desc_t *me = esp_app_get_description();
    if (!me || strncmp(cand.project_name, me->project_name, sizeof cand.project_name) != 0) return "image is for another product";
    esp_image_header_t hdr;   // the first bytes of an app image are its header
    if (esp_partition_read(s_target, 0, &hdr, sizeof hdr) != ESP_OK) return "could not read the image header";
    if (hdr.min_chip_rev_full > efuse_hal_chip_revision()) return "image needs a newer chip revision";
    return NULL;
}

void fw_update_slice(const uint8_t *payload, size_t plen)
{
    if (!s_active || !payload || plen < 5) return;   // no offer accepted (or aborted): never reach flash
    const uint32_t off = (uint32_t)payload[0] | (uint32_t)payload[1] << 8 | (uint32_t)payload[2] << 16 | (uint32_t)payload[3] << 24;
    const uint8_t *data = payload + 4;
    const size_t len = plen - 4;

    if (off != s_written) {   // nothing lost may be guessed at: write nothing, and on a gap ask where to resume
        const uint32_t now = now_ms();
        if (off > s_written && !(s_resend_written == (int64_t)s_written && (uint32_t)(now - s_resend_ms) < GAP_ASK_MS)) {
            s_resend_ms = now;
            s_resend_written = s_written;
            fw_update_send_resend((int)s_written);
        }
        return;
    }

    if (len > s_expected - s_written) { fail("more bytes than the offer promised"); return; }
    if (esp_ota_write(s_handle, data, len) != ESP_OK) { fail("flash write failed"); return; }
    s_written += (uint32_t)len;
    s_last_slice_ms = now_ms();
    // Acknowledge EVERY slice: fw.progress is not only a progress bar, it opens the daemon's credit window.
    fw_update_send_progress((int)s_written);
    const int pct = (int)((uint64_t)s_written * 100 / s_expected);
    if (pct != s_last_pct) { s_last_pct = pct; fw_update_ui_pct(pct); }

    if (s_written < s_expected) return;

    // ---- the image is complete: five checks, in order, ALL before esp_ota_set_boot_partition ------------
    if (esp_ota_end(s_handle) != ESP_OK) { fail("image rejected by esp_ota_end"); return; }        // 1
    if (!written_hash_matches()) { fail("sha256 mismatch"); return; }                              // 2
    const char *why = image_refusal();                                                            // 3, 4, 5
    if (why) { fail(why); return; }
    if (esp_ota_set_boot_partition(s_target) != ESP_OK) { fail("could not set the boot partition"); return; }

    ESP_LOGW(TAG, "update %s written and verified: rebooting", s_version);
    char to[sizeof s_version];
    snprintf(to, sizeof to, "%s", s_version);
    reset_state();
    fw_update_ui_restarting(to);
    fw_update_send_done();
    fw_update_restart();
}
