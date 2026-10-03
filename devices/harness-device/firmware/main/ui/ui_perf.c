// Same scripted UI API calls on both renderers, before the live cable session starts.
#include "ui_perf.h"
#ifdef DEVICE_PERF_BENCH
#include "ui_screens.h"
#include "display.h"
#include "touch.h"
#include "audio_probe.h"
#include "habitat/runtime.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/portmacro.h"
#include "cJSON.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t total_bytes, flushes;
static int64_t last_done;
int64_t ui_perf_last_done(void)
{
    portENTER_CRITICAL(&mux);
    int64_t done = last_done;
    portEXIT_CRITICAL(&mux);
    return done;
}
void ui_perf_flush(size_t bytes)
{
    portENTER_CRITICAL(&mux);
    total_bytes += (uint32_t)bytes;
    flushes++;
    portEXIT_CRITICAL(&mux);
}
void ui_perf_flush_done(void)
{
    portENTER_CRITICAL_ISR(&mux);
    last_done = esp_timer_get_time();
    portEXIT_CRITICAL_ISR(&mux);
}
#ifndef DEVICE_OCTOPUS_BENCH
typedef struct {
    uint32_t api, visible, bytes, flushes, frames;
} sample_t;
static void counters(uint32_t *bytes, uint32_t *n, int64_t *done)
{
    portENTER_CRITICAL(&mux);
    *bytes = total_bytes;
    *n = flushes;
    *done = last_done;
    portEXIT_CRITICAL(&mux);
}
static int cmp(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return (x > y) - (x < y);
}
static void report(const char *name, sample_t *s, int n)
{
    uint32_t us[48], api[48], bytes[48], count[48];
    int missed = 0;
    for (int i = 0; i < n; i++) {
        us[i] = s[i].visible;
        api[i] = s[i].api;
        bytes[i] = s[i].bytes;
        count[i] = s[i].flushes;
        if (!s[i].visible)
            missed++;
    }
    qsort(us, n, sizeof(*us), cmp);
    qsort(api, n, sizeof(*api), cmp);
    qsort(bytes, n, sizeof(*bytes), cmp);
    qsort(count, n, sizeof(*count), cmp);
    ESP_LOGI("PERF",
             "case=%s n=%d api_p50_us=%lu api_p95_us=%lu visible_p50_us=%lu visible_p95_us=%lu "
             "visible_max_us=%lu bytes_p50=%lu flush_p50=%lu no_frame=%d",
             name, n, (unsigned long)api[n / 2], (unsigned long)api[n * 95 / 100],
             (unsigned long)us[n / 2], (unsigned long)us[n * 95 / 100], (unsigned long)us[n - 1],
             (unsigned long)bytes[n / 2], (unsigned long)count[n / 2], missed);
}
static void run_case(const char *name, int kind)
{
    sample_t samples[40];
    cJSON *qs = cJSON_Parse("[{\"key\":\"direction\",\"q\":\"Which direction should we "
                            "take?\",\"multi\":false,\"options\":[\"Keep it very quiet\",\"A "
                            "little character\",\"Show both directions\"]}]");
    for (int i = 0; i < 40; i++) {
        if (kind == 2)
            cJSON_SetValuestring(cJSON_GetObjectItem(cJSON_GetArrayItem(qs, 0), "q"),
                                 (i & 1) ? "Which direction should we take?"
                                         : "What should we explore next?");
        uint32_t b0, f0, b1, f1;
        int64_t done, ignored;
        habitat_perf_t before, after;
        habitat_perf_get(&before);
        counters(&b0, &f0, &ignored);
        int64_t t = esp_timer_get_time();
        if (kind == 0)
            ui_fleet_set(16 + ((i + 1) & 1), true);
        else if (kind == 1) {
            char id[32];
            snprintf(id, sizeof(id), "perf-%d", i & 1);
            ui_focus_project(id);
        } else if (kind == 2) {
            char req[32];
            snprintf(req, sizeof(req), "perf-q-%d", i);
            ui_question_show("perf-0", "Welcome screen", "M2", req, qs);
        } else {
            ui_projects_bulk_begin();
            for (int j = 0; j < 16; j++) {
                char id[32], title[40];
                snprintf(id, sizeof(id), "perf-%d", j);
                snprintf(title, sizeof(title), "Thread %02d %s", j, (i & 1) ? "bravo" : "alpha");
                ui_project_set_name(id, title);
            }
            ui_projects_bulk_end();
        }
        samples[i].api = (uint32_t)(esp_timer_get_time() - t);
        // Settling is outside the measured interval. Completion is recorded in the SPI DMA ISR.
        vTaskDelay(pdMS_TO_TICKS(160));
        counters(&b1, &f1, &done);
        samples[i].visible = done > t ? (uint32_t)(done - t) : 0;
        samples[i].bytes = b1 - b0;
        samples[i].flushes = f1 - f0;
        habitat_perf_get(&after);
        samples[i].frames = after.frames - before.frames;
    }
    cJSON_Delete(qs);
    report(name, samples, 40);
    for (int i = 0; i < 40; i++)
        if (samples[i].visible > 10000 || !samples[i].visible || samples[i].frames > 1)
            ESP_LOGI("PERF", "detail case=%s i=%d frames=%lu bytes=%lu visible_us=%lu", name, i,
                     (unsigned long)samples[i].frames, (unsigned long)samples[i].bytes,
                     (unsigned long)samples[i].visible);
    touch_stats_t touch;
    touch_stats(&touch);
    ESP_LOGI("PERF", "touch presses=%lu inferred=%lu failures=%lu held=%d",
             (unsigned long)touch.presses, (unsigned long)touch.inferred_releases,
             (unsigned long)touch.read_failures, touch.held_now);
}
#endif
#ifdef DEVICE_OCTOPUS_BENCH
#include "habitat/perf_bench.h"
void ui_perf_run(void) { octopus_perf_run(); }
#else
void ui_perf_run(void)
{
    const char *renderer = "habitat-direct-c";
    ESP_LOGI("PERF", "BEGIN renderer=%s cpu_mhz=240 panel_qspi_mhz=40 samples=40 settle_ms=160",
             renderer);
    ui_enter_boot_loading();
    ui_set_connected(true);
    ui_projects_bulk_begin();
    for (int i = 0; i < 16; i++) {
        char id[32], name[40];
        snprintf(id, sizeof(id), "perf-%d", i);
        snprintf(name, sizeof(name), "Thread %02d alpha", i);
        ui_project_set_name(id, name);
        ui_project_set_engine(id, "codex");
        ui_project_set_machine(id, "perf-machine", "M2");
        ui_project_restore_event(
            id, "done",
            "A quiet terminal workspace. Text, one selected row, and enough room to think.",
            "Ready for a look.");
    }
    ui_projects_bulk_end();
    ui_fleet_set(16, true);
    ui_land_after_reload();
    vTaskDelay(pdMS_TO_TICKS(600));
    ESP_LOGI("PERF", "memory int_free=%u int_largest=%u psram_free=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    run_case("home_count", 0);
    ui_show_projects();
    ui_focus_project("perf-1");
    vTaskDelay(pdMS_TO_TICKS(300));
    run_case("agent_focus", 1);
    run_case("agent_burst16", 3);
    run_case("question", 2);
    uint32_t b0, f0, b1, f1;
    int64_t done;
    counters(&b0, &f0, &done);
    vTaskDelay(pdMS_TO_TICKS(2000));
    counters(&b1, &f1, &done);
    ESP_LOGI("PERF", "idle_ms=2000 bytes=%lu flushes=%lu", (unsigned long)(b1 - b0),
             (unsigned long)(f1 - f0));
    audio_probe_run();
    ui_question_close("perf-0", NULL);
    ui_project_clear_all();
    ui_set_connected(false);
    ui_enter_boot_loading();
    ESP_LOGI("PERF", "END renderer=%s", renderer);
}
#endif
#endif
