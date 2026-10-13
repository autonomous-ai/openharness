// fw_update.c against an in-memory partition: the offer rules, the slice rules, the 10 s stall, the five end
// checks (each one alone must keep the boot partition untouched) and the happy path. The IDF calls
// (esp_ota_*, esp_partition_read, the app desc, the chip revision) and every hook fw_update.c reaches out
// through are recorded here; the SHA-256 is the host stub's, so the digests are real.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "fw_update.h"
#include "hal/efuse_hal.h"
#include "mbedtls/sha256.h"

#define PART_SIZE 65536
#define IMG_SIZE 3500
#define SLICE 1000

// ---- the fake flash and its counters ----------------------------------------------------------------------
static esp_partition_t running = { PART_SIZE, "ota_0" }, target = { PART_SIZE, "ota_1" };
static uint8_t flash[PART_SIZE];
static size_t flash_pos;
static int c_begin, c_write, c_end, c_abort, c_set_boot, c_cancel;
static esp_ota_img_states_t img_state = ESP_OTA_IMG_VALID;
static int end_fails, begin_fails;
static esp_app_desc_t new_desc;
static uint32_t chip_rev = 300;
static int64_t now_us;

static int c_rollback;
void fw_confirm_test_reset(void);   // fw_update.c, under FW_UPDATE_HOST_TEST
esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot(void) { c_rollback++; return ESP_FAIL; }
int64_t esp_timer_get_time(void) { return now_us; }
const esp_app_desc_t *esp_app_get_description(void)
{ static const esp_app_desc_t d = { "0.0.99-pod", "harness-pro" }; return &d; }
uint32_t efuse_hal_chip_revision(void) { return chip_rev; }
const esp_partition_t *esp_ota_get_running_partition(void) { return &running; }
const esp_partition_t *esp_ota_get_next_update_partition(const esp_partition_t *s) { (void)s; return &target; }
esp_err_t esp_ota_get_state_partition(const esp_partition_t *p, esp_ota_img_states_t *s) { (void)p; *s = img_state; return ESP_OK; }
esp_err_t esp_ota_mark_app_valid_cancel_rollback(void) { c_cancel++; return ESP_OK; }
esp_err_t esp_ota_begin(const esp_partition_t *p, size_t n, esp_ota_handle_t *h)
{ (void)p; (void)n; c_begin++; flash_pos = 0; if (begin_fails) return ESP_FAIL; *h = 7; return ESP_OK; }
esp_err_t esp_ota_write(esp_ota_handle_t h, const void *d, size_t n)
{ assert(h == 7); c_write++; memcpy(flash + flash_pos, d, n); flash_pos += n; return ESP_OK; }
esp_err_t esp_ota_end(esp_ota_handle_t h) { assert(h == 7); c_end++; return end_fails ? ESP_FAIL : ESP_OK; }
esp_err_t esp_ota_abort(esp_ota_handle_t h) { (void)h; c_abort++; return ESP_OK; }
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *p) { (void)p; c_set_boot++; return ESP_OK; }
esp_err_t esp_ota_get_partition_description(const esp_partition_t *p, esp_app_desc_t *d) { (void)p; *d = new_desc; return ESP_OK; }
esp_err_t esp_partition_read(const esp_partition_t *p, size_t off, void *dst, size_t n)
{ (void)p; memcpy(dst, flash + off, n); return ESP_OK; }

// ---- the hooks, recorded ---------------------------------------------------------------------------------
static int h_accept, h_progress, h_done, h_error, h_begin, h_failed, h_restarting, h_restart, h_pcts;
static int h_resend, last_resend, last_progress, pcts[64];
static char last_err[96], restarting_to[32], begin_from[32], begin_to[32];
void fw_update_send_accept(void) { h_accept++; }
void fw_update_send_progress(int w) { h_progress++; last_progress = w; }
void fw_update_send_resend(int w) { h_resend++; last_resend = w; }
void fw_update_send_done(void) { h_done++; }
void fw_update_send_error(const char *m) { h_error++; snprintf(last_err, sizeof last_err, "%s", m); }
void fw_update_ui_begin(const char *f, const char *t) { h_begin++; snprintf(begin_from, 32, "%s", f); snprintf(begin_to, 32, "%s", t); }
void fw_update_ui_pct(int p) { if (h_pcts < 64) pcts[h_pcts++] = p; }
void fw_update_ui_restarting(const char *t) { h_restarting++; snprintf(restarting_to, 32, "%s", t); }
void fw_update_ui_failed(void) { h_failed++; }
void fw_update_restart(void) { h_restart++; }

// ---- fixtures --------------------------------------------------------------------------------------------
static uint8_t img[IMG_SIZE];
static char img_sha[65];

static void reset(void)
{
    if (fw_update_active()) fw_update_abort("test reset");
    c_begin = c_write = c_end = c_abort = c_set_boot = c_cancel = c_rollback = 0;
    h_accept = h_progress = h_done = h_error = h_begin = h_failed = h_restarting = h_restart = h_pcts = h_resend = 0;
    end_fails = begin_fails = 0; chip_rev = 300; now_us = 5000000; img_state = ESP_OTA_IMG_VALID;
    memset(flash, 0, sizeof flash); last_err[0] = 0;
    memset(&new_desc, 0, sizeof new_desc); strcpy(new_desc.version, "0.1.0"); strcpy(new_desc.project_name, "harness-pro");
    esp_image_header_t hd; memcpy(&hd, img, sizeof hd); hd.min_chip_rev_full = 300; memcpy(img, &hd, sizeof hd);
}

static void sha_of(const uint8_t *d, size_t n, char hex[65])
{
    mbedtls_sha256_context c; uint8_t o[32];
    mbedtls_sha256_init(&c); mbedtls_sha256_starts(&c, 0); mbedtls_sha256_update(&c, d, n); mbedtls_sha256_finish(&c, o);
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", o[i]);
}

static void make_image(void)
{
    for (int i = 0; i < IMG_SIZE; i++) img[i] = (uint8_t)(i * 31 + 7);
    reset();
    sha_of(img, IMG_SIZE, img_sha);
}

// A slice on the wire: u32 little-endian offset, then the data.
static void slice_at(uint32_t off, const uint8_t *d, size_t n)
{
    uint8_t b[4 + 2048];
    b[0] = (uint8_t)off; b[1] = (uint8_t)(off >> 8); b[2] = (uint8_t)(off >> 16); b[3] = (uint8_t)(off >> 24);
    memcpy(b + 4, d, n);
    fw_update_slice(b, 4 + n);
}
static void feed(void) { for (size_t o = 0; o < IMG_SIZE; o += SLICE) slice_at((uint32_t)o, img + o, IMG_SIZE - o < SLICE ? IMG_SIZE - o : SLICE); }
static bool offer(void) { return fw_update_offer("0.1.0", IMG_SIZE, img_sha, false); }
static void expect_refused(bool ok, int errs) { assert(!ok); assert(c_begin == 0); assert(h_error == errs); assert(!fw_update_active()); }

// ---- tests -----------------------------------------------------------------------------------------------
static void offer_validation(void)
{
    char sha63[64], shabad[65];
    snprintf(sha63, sizeof sha63, "%.63s", img_sha);
    snprintf(shabad, sizeof shabad, "%s", img_sha); shabad[10] = 'g';
    reset(); expect_refused(fw_update_offer("0.1", IMG_SIZE, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer("0.1.0-pod", IMG_SIZE, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer("0.1.0.1", IMG_SIZE, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer("0..1", IMG_SIZE, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer("v0.1.0", IMG_SIZE, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer("0.1.0", IMG_SIZE, sha63, false), 1);
    reset(); expect_refused(fw_update_offer("0.1.0", IMG_SIZE, shabad, false), 1);
    reset(); expect_refused(fw_update_offer("0.1.0", 0, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer("0.1.0", PART_SIZE + 1, img_sha, false), 1);
    reset(); expect_refused(fw_update_offer(NULL, IMG_SIZE, img_sha, false), 1);
    assert(h_begin == 0 && h_accept == 0);
    reset(); assert(fw_update_offer("12.345.6", PART_SIZE, img_sha, false));   // exactly the slot fits
    assert(h_accept == 1 && h_begin == 1 && c_begin == 1 && h_error == 0);
    assert(!strcmp(begin_from, "0.0.99-pod") && !strcmp(begin_to, "12.345.6"));
}

static void busy_declined(void)
{
    reset(); expect_refused(fw_update_offer("0.1.0", IMG_SIZE, img_sha, true), 1);
    assert(h_begin == 0);
}

static void second_offer_declined(void)
{
    reset(); assert(offer());
    slice_at(0, img, SLICE);
    assert(!fw_update_offer("0.2.0", IMG_SIZE, img_sha, false));
    assert(c_begin == 1 && fw_update_active() && h_failed == 0 && h_error == 0);   // the first carries on
    slice_at(SLICE, img + SLICE, SLICE);
    assert(c_write == 2 && last_progress == 2 * SLICE);
}

static void slice_without_offer_is_ignored(void)
{
    reset(); slice_at(0, img, SLICE);
    assert(c_write == 0 && h_progress == 0 && h_error == 0 && h_failed == 0);
    assert(offer()); fw_update_abort("session down"); c_write = 0;   // a late frame after an abort
    slice_at(0, img, SLICE);
    assert(c_write == 0 && h_progress == 0);
}

static void slice_past_size_aborts(void)
{
    reset(); assert(offer());
    feed();                                   // the whole image: ends the update (bad sha irrelevant below)
    reset(); assert(fw_update_offer("0.1.0", 1500, img_sha, false));
    slice_at(0, img, SLICE);
    slice_at(SLICE, img + SLICE, 501);        // 1501 > 1500
    assert(!fw_update_active() && c_abort == 1 && h_error == 1 && h_failed == 1 && c_set_boot == 0);
    assert(c_write == 1);
}

static void stall_aborts_after_10s(void)
{
    reset(); assert(offer());
    uint32_t t0 = (uint32_t)(esp_timer_get_time() / 1000);
    slice_at(0, img, SLICE);
    fw_update_tick(t0 + 9999);
    assert(fw_update_active() && h_failed == 0);
    fw_update_tick(t0 + 10000);
    assert(!fw_update_active() && h_failed == 1 && h_error == 1 && c_abort == 1);
    // a slice moves the deadline
    reset(); assert(offer()); t0 = (uint32_t)(esp_timer_get_time() / 1000);
    now_us += 8000 * 1000; slice_at(0, img, SLICE);
    fw_update_tick(t0 + 15000); assert(fw_update_active());
    fw_update_tick(t0 + 8000 + 10000); assert(!fw_update_active());
    reset(); fw_update_tick(999999); assert(h_failed == 0 && h_error == 0);   // idle: nothing to abort
}

static uint32_t ms(void) { return (uint32_t)(now_us / 1000); }

// Offsets: an in-order slice writes; a gap or a duplicate writes nothing; a gap asks for a resend, once per 500 ms.
static void offsets_and_resend(void)
{
    reset(); assert(offer());
    uint32_t t0 = ms();
    slice_at(0, img, SLICE);
    assert(c_write == 1 && last_progress == SLICE && h_progress == 1 && h_resend == 0);
    slice_at(2 * SLICE, img + 2 * SLICE, SLICE);              // slice 1 was lost
    assert(c_write == 1 && h_progress == 1 && h_resend == 1 && last_resend == SLICE);
    now_us += 499 * 1000; slice_at(3 * SLICE, img + 3 * SLICE - 0, 500);   // still a gap, inside 500 ms
    assert(h_resend == 1 && c_write == 1);
    now_us += 1000; slice_at(2 * SLICE, img + 2 * SLICE, SLICE);            // 500 ms on
    assert(h_resend == 2 && c_write == 1);
    slice_at(0, img, SLICE);                                  // duplicate after a rewind: ignored, no resend
    assert(c_write == 1 && h_resend == 2 && h_progress == 1 && fw_update_active() && h_error == 0);
    // the resent slices complete the image and the five end checks pass
    for (size_t o = SLICE; o < IMG_SIZE; o += SLICE) slice_at((uint32_t)o, img + o, IMG_SIZE - o < SLICE ? IMG_SIZE - o : SLICE);
    assert(c_end == 1 && c_set_boot == 1 && h_done == 1 && h_error == 0 && h_failed == 0);
    assert(memcmp(flash, img, IMG_SIZE) == 0);
    (void)t0;
}

static void silence_asks_for_resend(void)
{
    reset(); assert(offer());
    uint32_t t0 = ms();
    slice_at(0, img, SLICE);
    fw_update_tick(t0 + 1499); assert(h_resend == 0);
    fw_update_tick(t0 + 1500); assert(h_resend == 1 && last_resend == SLICE);
    fw_update_tick(t0 + 2999); assert(h_resend == 1);
    fw_update_tick(t0 + 3000); assert(h_resend == 2);
    fw_update_tick(t0 + 10000); assert(!fw_update_active() && h_error == 1);   // the stall abort stands
    reset(); fw_update_tick(ms() + 5000); assert(h_resend == 0);                // idle: no resend
}

static void short_payload_ignored(void)
{
    reset(); assert(offer());
    uint8_t b[4] = { 0, 0, 0, 0 };
    fw_update_slice(b, 4); fw_update_slice(b, 0);
    assert(c_write == 0 && h_progress == 0 && h_resend == 0 && fw_update_active() && h_error == 0);
}

static void run_bad(const char *name, void (*arm)(void))
{
    reset(); arm();
    assert(offer()); feed();
    if (c_set_boot || !c_abort || h_error != 1 || h_failed != 1 || fw_update_active() || h_done || h_restart || h_restarting) {
        fprintf(stderr, "end check row failed: %s (set_boot=%d abort=%d err=%d failed=%d)\n", name, c_set_boot, c_abort, h_error, h_failed);
        abort();
    }
    // and the receiver is idle again: a fresh offer is accepted
    reset(); assert(offer());
}
static void arm_sha(void) { img_sha[3] = img_sha[3] == '0' ? '1' : '0'; }
static void arm_version(void) { strcpy(new_desc.version, "0.1.1"); }
static void arm_project(void) { strcpy(new_desc.project_name, "other"); }
static void arm_rev(void) { esp_image_header_t hd; memcpy(&hd, img, sizeof hd); hd.min_chip_rev_full = 301; memcpy(img, &hd, sizeof hd); }
static void arm_end(void) { end_fails = 1; }
static void end_checks(void)
{
    char good[65]; sha_of(img, IMG_SIZE, good);
    run_bad("bad sha", arm_sha); strcpy(img_sha, good);
    run_bad("version mismatch", arm_version);
    run_bad("project other", arm_project);
    // arm_rev changes the image bytes, so its sha must follow or the sha row would fire instead.
    reset(); arm_rev(); sha_of(img, IMG_SIZE, img_sha);
    assert(offer()); feed();
    assert(c_set_boot == 0 && c_abort && h_error == 1 && h_failed == 1 && !fw_update_active());
    assert(strstr(last_err, "revision") != NULL);
    make_image();
    run_bad("esp_ota_end fails", arm_end);
}

static void happy_path(void)
{
    make_image();
    assert(offer());
    assert(h_accept == 1 && h_begin == 1);
    int slices = 0;
    for (size_t o = 0; o < IMG_SIZE; o += SLICE, slices++) {
        size_t n = IMG_SIZE - o < SLICE ? IMG_SIZE - o : SLICE;
        slice_at((uint32_t)o, img + o, n);
        if (o + n < IMG_SIZE) assert(h_done == 0 && c_set_boot == 0);
        assert(h_progress == slices + 1 && last_progress == (int)(o + n));   // an ack after EVERY slice
    }
    assert(c_end == 1 && c_set_boot == 1 && c_abort == 0 && h_error == 0 && h_failed == 0);
    assert(h_done == 1 && h_restarting == 1 && !strcmp(restarting_to, "0.1.0") && h_restart == 1);
    assert(!fw_update_active());
    assert(h_pcts > 0 && pcts[h_pcts - 1] == 100);
    for (int i = 0; i < h_pcts; i++) { assert(pcts[i] >= 0 && pcts[i] <= 100); if (i) assert(pcts[i] >= pcts[i - 1]); }
    assert(memcmp(flash, img, IMG_SIZE) == 0);
}

static void mark_valid_only_when_pending(void)
{
    char v[32] = "x";
    reset(); img_state = ESP_OTA_IMG_VALID; fw_mark_valid();
    assert(c_cancel == 0 && !fw_was_updated(v, sizeof v) && !strcmp(v, "x"));
    reset(); img_state = ESP_OTA_IMG_PENDING_VERIFY; fw_mark_valid();
    assert(c_cancel == 1 && fw_was_updated(v, sizeof v) && !strcmp(v, "0.0.99-pod"));
    reset(); img_state = ESP_OTA_IMG_VALID; fw_mark_valid();    // a later call on a valid image clears the flag
    assert(c_cancel == 0 && !fw_was_updated(v, sizeof v));
}

// When a fresh image is confirmed: never before the first frame; then at the first cable session or at 60 s up.
static void confirm_timing(void)
{
    char v[32];
    // welcome before the first frame: nothing yet; the frame then confirms (once)
    reset(); fw_confirm_test_reset(); img_state = ESP_OTA_IMG_PENDING_VERIFY;
    assert(fw_confirm_pending());
    assert(!fw_confirm_session_up() && c_cancel == 0);
    assert(!fw_confirm_tick(61000) && c_cancel == 0);          // 60 s up but no frame: still not
    assert(fw_confirm_frame_painted() && c_cancel == 1 && !fw_confirm_pending());
    assert(!fw_confirm_session_up() && !fw_confirm_tick(90000) && c_cancel == 1);
    assert(fw_was_updated(v, sizeof v));
    // frame first, no welcome: not before 60 s, once at 60 s
    reset(); fw_confirm_test_reset(); img_state = ESP_OTA_IMG_PENDING_VERIFY;
    assert(!fw_confirm_frame_painted() && c_cancel == 0);
    assert(!fw_confirm_tick(1000) && !fw_confirm_tick(59999) && c_cancel == 0 && fw_confirm_pending());
    assert(fw_confirm_tick(60000) && c_cancel == 1);
    assert(!fw_confirm_tick(61000) && !fw_confirm_session_up() && c_cancel == 1);
    // frame, then the welcome: confirmed on the welcome, long before 60 s, once
    reset(); fw_confirm_test_reset(); img_state = ESP_OTA_IMG_PENDING_VERIFY;
    assert(!fw_confirm_frame_painted() && !fw_confirm_tick(5000) && c_cancel == 0);
    assert(fw_confirm_session_up() && c_cancel == 1);
    assert(!fw_confirm_session_up() && !fw_confirm_tick(60000) && c_cancel == 1);
}

// M6: no first frame on a trial image reverts it; on a confirmed image nothing happens.
static void no_frame_rolls_back(void)
{
    reset(); img_state = ESP_OTA_IMG_PENDING_VERIFY; fw_no_frame(); assert(c_rollback == 1);
    reset(); img_state = ESP_OTA_IMG_VALID; fw_no_frame(); assert(c_rollback == 0);
}

int main(void)
{
    make_image();
    offer_validation(); busy_declined(); second_offer_declined(); slice_without_offer_is_ignored();
    slice_past_size_aborts(); stall_aborts_after_10s(); offsets_and_resend(); silence_asks_for_resend(); short_payload_ignored(); end_checks(); happy_path(); mark_valid_only_when_pending();
    confirm_timing(); no_frame_rolls_back();
    puts("test_fw_update: ok");
    return 0;
}
