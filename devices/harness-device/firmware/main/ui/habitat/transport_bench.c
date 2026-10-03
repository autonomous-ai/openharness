// Diagnostic only. All buffers stay in RAM; no synthetic input reaches the app.
#include "cable_frame.h"
#include "cable_client.h"
#include "esp_rom_crc.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

uint16_t reference_crc16(const uint8_t *data, size_t len);
void reference_decoder_init(cable_decoder_t *d);
void reference_decoder_feed(cable_decoder_t *d, const uint8_t *data, size_t n,
                            cable_frame_cb cb, void *ctx);

static RTC_NOINIT_ATTR uint32_t attempted[2];
static uint8_t payload[CABLE_MAX_PAYLOAD + 4];
static uint8_t frame[CABLE_MAX_FRAME];
static cable_decoder_t decoder;

static void decoded(uint8_t version, uint8_t type, const uint8_t *data, size_t n, void *ctx)
{
    (void)ctx;
    assert(version == CABLE_FRAME_VERSION && type == CABLE_TYPE_PCM);
    assert(n <= CABLE_MAX_PAYLOAD && !memcmp(data, payload, n));
    // No forwarding, UI state or app callback: local parser work only.
    payload[CABLE_MAX_PAYLOAD + 3]++;
}

static uint16_t crc_nibble(const uint8_t *data, size_t len)
{
    static const uint16_t table[16] = {
        0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
        0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef
    };
    uint16_t crc = 0xffff;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        crc = (uint16_t)((crc << 4) ^ table[crc >> 12]);
        crc = (uint16_t)((crc << 4) ^ table[crc >> 12]);
    }
    return crc;
}
static uint16_t crc_rom(const uint8_t *data, size_t len)
{
    // Espressif's documented CRC-16/CCITT-FALSE adaptation. The ROM API
    // complements both ends; the wire protocol's init is 0xffff, xorout zero.
    return (uint16_t)~esp_rom_crc16_be(0, data, (uint32_t)len);
}
static int compare(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}
void cable_transport_benchmark(void)
{
    uint32_t key = 2166136261u;
    for (const char *p = esp_app_get_description()->version; *p; p++)
        key = (key ^ (uint8_t)*p) * 16777619u;
    if (attempted[0] == key && attempted[1] == ~key) return;
    attempted[0] = key; attempted[1] = ~key;
    int64_t deadline = esp_timer_get_time() + 15000000;
    while (!cable_client_is_connected() && esp_timer_get_time() < deadline) {
        esp_task_wdt_reset(); vTaskDelay(pdMS_TO_TICKS(100));
    }
    uint32_t rng = 0x41be9587;
    for (size_t i = 0; i < sizeof payload; i++) {
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
        payload[i] = (uint8_t)rng;
    }
    static const size_t sizes[] = {0, 4, 48, 84, 324, 1028, 4100, 8196};
    static const char *modes[] = {"bitwise91", "nibble92", "rom92"};
    uint16_t (*const crc[])(const uint8_t *, size_t) = {reference_crc16, crc_nibble, crc_rom};
    uint32_t times[40];
    for (size_t size = 0; size < sizeof sizes / sizeof sizes[0]; size++) {
        uint16_t expected = crc[0](payload, sizes[size]);
        assert(crc[1](payload, sizes[size]) == expected);
        assert(crc[2](payload, sizes[size]) == expected);
    }
    unsigned before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    ESP_LOGI("transport-bench", "BEGIN 1920 local CRCs; bitwise/nibble/ROM; no USB/app commands");
    for (int pass = 0; pass < 2; pass++) for (int order = 0; order < 3; order++) {
        int mode = pass ? 2 - order : order;
        for (size_t size = 0; size < sizeof sizes / sizeof sizes[0]; size++) {
            uint16_t expected = crc[0](payload, sizes[size]);
            for (int i = 0; i < 40; i++) {
                int64_t start = esp_timer_get_time();
                uint16_t result = crc[mode](payload, sizes[size]);
                times[i] = (uint32_t)(esp_timer_get_time() - start);
                assert(result == expected);
                esp_task_wdt_reset(); vTaskDelay(1);
            }
            qsort(times, 40, sizeof *times, compare);
            ESP_LOGI("transport-bench", "pass=%d mode=%s bytes=%u n=40 min=%lu median=%lu p95=%lu max=%lu",
                pass, modes[mode], (unsigned)sizes[size], (unsigned long)times[0],
                (unsigned long)((times[19] + times[20]) / 2),
                (unsigned long)times[37], (unsigned long)times[39]);
        }
    }
    assert(heap_caps_check_integrity_all(true));
    ESP_LOGI("transport-bench", "END internal=%u/%u; excludes queue, USB and desktop",
        before, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));

    static const size_t lengths[] = {48, 320, 1024, 4096, 8192};
    static const size_t chunks[] = {1, 64, 512, CABLE_MAX_FRAME};
    ESP_LOGI("transport-decode", "BEGIN 3200 local decodes; original91/ROM-block93; no USB/app commands");
    for (int pass = 0; pass < 2; pass++) for (int order = 0; order < 2; order++) {
        int mode = pass ? 1 - order : order;
        for (size_t size = 0; size < sizeof lengths / sizeof lengths[0]; size++) {
            int n = cable_frame_encode(CABLE_TYPE_PCM, payload, lengths[size], frame, sizeof frame);
            assert(n > 0);
            for (size_t chunk = 0; chunk < sizeof chunks / sizeof chunks[0]; chunk++) {
                for (int i = 0; i < 40; i++) {
                    uint8_t count = payload[CABLE_MAX_PAYLOAD + 3];
                    int64_t start = esp_timer_get_time();
                    if (mode) cable_decoder_init(&decoder); else reference_decoder_init(&decoder);
                    for (size_t offset = 0; offset < (size_t)n;) {
                        size_t take = (size_t)n - offset;
                        if (take > chunks[chunk]) take = chunks[chunk];
                        if (mode) cable_decoder_feed(&decoder, frame + offset, take, decoded, NULL);
                        else reference_decoder_feed(&decoder, frame + offset, take, decoded, NULL);
                        offset += take;
                    }
                    times[i] = (uint32_t)(esp_timer_get_time() - start);
                    assert(payload[CABLE_MAX_PAYLOAD + 3] == (uint8_t)(count + 1));
                    assert(!decoder.len && !decoder.corrupt_frames && !decoder.discarded_bytes);
                    esp_task_wdt_reset(); vTaskDelay(1);
                }
                qsort(times, 40, sizeof *times, compare);
                ESP_LOGI("transport-decode", "pass=%d mode=%s bytes=%u chunk=%u n=40 min=%lu median=%lu p95=%lu max=%lu",
                    pass, mode ? "rom-block93" : "original91", (unsigned)lengths[size], (unsigned)chunks[chunk],
                    (unsigned long)times[0], (unsigned long)((times[19] + times[20]) / 2),
                    (unsigned long)times[37], (unsigned long)times[39]);
            }
        }
    }
    assert(heap_caps_check_integrity_all(true));
    ESP_LOGI("transport-decode", "END internal=%u/%u; excludes queue, USB and desktop",
        before, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}
