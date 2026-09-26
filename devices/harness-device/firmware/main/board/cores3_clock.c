// The CoreS3's clock: the BM8563 RTC on the internal I2C bus (0x51), kept in UTC, and the computer's UTC
// offset kept in NVS. The daemon states both in every `welcome` (cable_client.c); between sessions and
// across power-offs the RTC's own crystal carries the time, so the chrome can show it from boot.
#include "cores3_clock.h"

#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "board_i2c.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "nvs.h"

static const char *TAG = "clock";

#define BM8563_ADDR   0x51
#define BM8563_SEC    0x02      // 0x02..0x08: sec, min, hour, day, weekday, month (bit7 = century), year
#define NVS_NS        "c3clock"
#define NVS_TZ        "tzoff"

static i2c_master_dev_handle_t s_rtc;
static bool s_valid;            // the time has been set at least once, by the RTC or by a daemon
static int16_t s_tz_min;        // the computer's UTC offset, minutes

static uint8_t bcd(uint8_t v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }
static uint8_t unbcd(uint8_t v) { return (uint8_t)((v >> 4) * 10 + (v & 0x0F)); }

static bool rtc_open(void)
{
    if (s_rtc) return true;
    i2c_master_bus_handle_t bus = board_i2c_get();
    if (!bus) return false;
    i2c_device_config_t cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BM8563_ADDR, .scl_speed_hz = 400000 };
    return i2c_master_bus_add_device(bus, &cfg, &s_rtc) == ESP_OK;
}

void cores3_clock_init(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_i16(h, NVS_TZ, &s_tz_min);
        nvs_close(h);
    }
    if (!rtc_open()) { ESP_LOGW(TAG, "no RTC"); return; }
    uint8_t reg = BM8563_SEC, r[7];
    if (i2c_master_transmit_receive(s_rtc, &reg, 1, r, sizeof r, pdMS_TO_TICKS(50)) != ESP_OK) {
        ESP_LOGW(TAG, "RTC read failed");
        return;
    }
    // VL (bit 7 of seconds): the oscillator stopped — power was lost, and the time is not to be believed.
    if (r[0] & 0x80) { ESP_LOGI(TAG, "RTC lost power; waiting for a daemon to set it"); return; }
    struct tm t = {
        .tm_sec = unbcd(r[0] & 0x7F), .tm_min = unbcd(r[1] & 0x7F), .tm_hour = unbcd(r[2] & 0x3F),
        .tm_mday = unbcd(r[3] & 0x3F), .tm_mon = unbcd(r[5] & 0x1F) - 1,
        .tm_year = unbcd(r[6]) + ((r[5] & 0x80) ? 200 : 100),
    };
    if (t.tm_year < 124) return;   // before 2024: never set
    setenv("TZ", "UTC0", 1);
    tzset();
    time_t now = mktime(&t);
    struct timeval tv = { .tv_sec = now };
    settimeofday(&tv, NULL);
    s_valid = true;
    ESP_LOGI(TAG, "time from RTC, UTC%+d min", s_tz_min);
}

void cores3_clock_set(int64_t epoch_ms, int tz_min)
{
    if (epoch_ms < 1704067200000LL) return;   // not a real time
    struct timeval tv = { .tv_sec = (time_t)(epoch_ms / 1000), .tv_usec = (suseconds_t)((epoch_ms % 1000) * 1000) };
    // Only when it matters: `welcome` repeats every 15 s, and the RTC and NVS need not hear it each time.
    struct timeval cur;
    gettimeofday(&cur, NULL);
    bool drifted = !s_valid || llabs((int64_t)cur.tv_sec - (int64_t)tv.tv_sec) > 2;
    bool tz_changed = tz_min != s_tz_min;
    if (drifted) settimeofday(&tv, NULL);
    s_valid = true;
    if (tz_changed) {
        s_tz_min = (int16_t)tz_min;
        nvs_handle_t h;
        if (nvs_open(NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
            nvs_set_i16(h, NVS_TZ, s_tz_min);
            nvs_commit(h);
            nvs_close(h);
        }
    }
    if (!drifted || !rtc_open()) return;
    struct tm t;
    time_t secs = tv.tv_sec;
    gmtime_r(&secs, &t);
    uint8_t w[8] = { BM8563_SEC, bcd((uint8_t)t.tm_sec), bcd((uint8_t)t.tm_min), bcd((uint8_t)t.tm_hour),
                     bcd((uint8_t)t.tm_mday), (uint8_t)t.tm_wday,
                     (uint8_t)(bcd((uint8_t)(t.tm_mon + 1)) | (t.tm_year >= 200 ? 0x80 : 0)),
                     bcd((uint8_t)(t.tm_year % 100)) };
    if (i2c_master_transmit(s_rtc, w, sizeof w, pdMS_TO_TICKS(50)) != ESP_OK) ESP_LOGW(TAG, "RTC write failed");
    else ESP_LOGI(TAG, "RTC set from the daemon, UTC%+d min", s_tz_min);
}

bool cores3_clock_local(struct tm *out)
{
    if (!s_valid) return false;
    time_t now = time(NULL) + (time_t)s_tz_min * 60;
    gmtime_r(&now, out);
    return true;
}
