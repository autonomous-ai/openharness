#include "config_store.h"
#include <stdlib.h>
#include <string.h>
#include "ram_telemetry.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"

static const char *TAG = "config";
static const char *NS = "pair";

static void read_str(nvs_handle_t h, const char *key, char *dst, size_t cap);   // defined below


void config_store_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

static void read_str(nvs_handle_t h, const char *key, char *dst, size_t cap)
{
    size_t len = cap;
    memset(dst, 0, cap);
    if (nvs_get_str(h, key, dst, &len) != ESP_OK) dst[0] = '\0';
}

void config_load_voicelang(char *out, size_t cap)
{
    nvs_handle_t h;
    memset(out, 0, cap);
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        read_str(h, "vlang", out, cap);
        nvs_close(h);
    }
    if (out[0] == '\0' && cap > 2) { strncpy(out, "en", cap - 1); out[cap - 1] = '\0'; }   // factory default: English (Settings › Voice flips it)
}

void config_save_voicelang(const char *lang)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_str(h, "vlang", lang) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_voicelang '%s': %s", lang, ok ? "ok" : "FAILED");
}

uint8_t config_load_brightness(void)
{
    nvs_handle_t h;
    uint8_t v = 204;    // default 80%: a dial nobody has dimmed (owner, 2026-10-01; was 100%)
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "bright", &v);   // leaves v at default if key is absent
        nvs_close(h);
    }
    return v;
}

void config_save_brightness(uint8_t level)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_u8(h, "bright", level) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_brightness 0x%02x: %s", level, ok ? "ok" : "FAILED");
}

bool config_load_muted(void)
{
    nvs_handle_t h;
    // The prototype starts quiet; a stock build keeps its previous default.
    uint8_t muted = 1;
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "muted", &muted);
        nvs_close(h);
    }
    return muted != 0;
}

bool config_save_muted(bool muted)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_u8(h, "muted", muted ? 1 : 0) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_muted %d: %s", (int)muted, ok ? "ok" : "FAILED");
    return ok;
}

uint8_t config_load_habitat_options(void)
{
    nvs_handle_t h;
    uint8_t options = 0; // Curved title; straight scrolling; reactions enabled
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "habitat", &options);
        nvs_close(h);
    }
    return options & 15;
}
bool config_save_habitat_options(uint8_t options)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_u8(h, "habitat", options & 15) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

// --- scroll direction ---------------------------------------------------------------------------
// Which way a drag moves the window's scrollback. A habit, not a fact about the hardware: some hands
// expect the text to follow the finger, others expect the VIEW to follow it, and neither is wrong.
//
// Stored on the DIAL, not in the window, because it belongs to the hand holding this device. Nothing else
// needs to know: the report is signed before it leaves here, so the daemon, the window and the terminal
// all see the same frame they always did. A preference two sides both hold is a preference they can
// disagree about.
bool config_load_scroll_reversed(void)
{
    nvs_handle_t h;
    uint8_t v = 0;   // default: unchanged from every build before this one
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "scrollrev", &v);
        nvs_close(h);
    }
    return v != 0;
}

void config_save_scroll_reversed(bool reversed)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_u8(h, "scrollrev", reversed ? 1 : 0) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_scroll_reversed %d: %s", (int)reversed, ok ? "ok" : "FAILED");
}

bool config_clear_all(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_erase_all(h);
    bool ok = nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGW(TAG, "clear_all: %s", ok ? "ok" : "FAILED");
    return ok;
}
