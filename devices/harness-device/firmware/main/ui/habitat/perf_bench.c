// Same binary, ABBA body-clock comparison. Synthetic data; never connect to live agents.
#include "perf_bench.h"
#include "runtime.h"
#include "display.h"
#include "ui_screens.h"
#include "ui_perf.h"
#include "touch.h"
#include "audio_probe.h"
#include "audio_capture.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/portmacro.h"
#include "cJSON.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TAG "OCTO_PERF"
static atomic_bool animated;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t sequence, completed;
static char expected[80];
static bool expect_pressed;
typedef struct {
    uint32_t latency, bytes, model, damage, raster, paint;
    bool matches;
} sample_t;
static sample_t result;
static int64_t requested;
static uint32_t last_raster, last_paint;
static bool collecting;
static struct {
    uint32_t frames, bytes, model, damage, raster, paint, n;
    uint32_t raster_samples[256], paint_samples[256];
} ambient;

bool octopus_perf_animate(void) { return atomic_load(&animated); }

ht_perf_tag_t octopus_perf_capture(const ht_scene_t *scene, bool fresh)
{
    if (!fresh) return (ht_perf_tag_t){0};
    // Called under the model lock, after the entire scene has been assembled. A frame
    // already in DMA before this request carries its OLD sequence, so it cannot satisfy it.
    bool matches = !expected[0];
    for (int i = 0; i < scene->count && !matches; i++)
        matches = strstr(scene->runs[i].text, expected) != NULL;
    if (expect_pressed) matches = matches && habitat_bench_pressed();
    return (ht_perf_tag_t){sequence, matches};
}
void octopus_perf_paint(uint32_t raster_us, uint32_t paint_us)
{
    last_raster = raster_us;
    last_paint = paint_us;
}
void octopus_perf_commit(ht_perf_tag_t tag, uint32_t bytes, uint32_t model_us, uint32_t damage_us)
{
    int64_t done = bytes ? ui_perf_last_done() : esp_timer_get_time();
    portENTER_CRITICAL(&mux);
    if (tag.sequence && tag.sequence == sequence && completed != tag.sequence) {
        result = (sample_t){.latency = (uint32_t)(done - requested), .bytes = bytes,
            .model = model_us, .damage = damage_us, .raster = bytes ? last_raster : 0,
            .paint = bytes ? last_paint : 0, .matches = tag.matches};
        completed = tag.sequence;
    }
    if (collecting) {
        ambient.model += model_us;
        ambient.damage += damage_us;
        if (bytes) {
            ambient.frames++;
            ambient.bytes += bytes;
            ambient.raster += last_raster;
            ambient.paint += last_paint;
            if (ambient.n < 256) {
                ambient.raster_samples[ambient.n] = last_raster;
                ambient.paint_samples[ambient.n++] = last_paint;
            }
        }
    }
    portEXIT_CRITICAL(&mux);
}
static int cmp(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return (x > y) - (x < y);
}
static void memory(const char *stage, int round, bool animate)
{
    ESP_LOGI(TAG, "memory stage=%s round=%d animate=%d internal=%u largest=%u psram=%u",
        stage, round, animate,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}
static void fixture(bool animate)
{
    atomic_store(&animated, animate);
    ui_project_clear_all();
    ui_projects_bulk_begin();
    for (int i = 0; i < 16; i++) {
        char id[24], title[40];
        snprintf(id, sizeof id, "perf-%d", i);
        snprintf(title, sizeof title, "Thread %02d alpha", i);
        ui_project_set_name(id, title);
        ui_project_set_engine(id, "codex");
        ui_project_set_machine(id, "perf-machine", "M2");
        ui_project_restore_event(id, "done",
            "The build passed. Fixed the input queue and added a regression test. "
            "All checks passed. The update is ready to review.", "Build passed; input fixed.");
        ui_project_emit(id, NULL, "processing", NULL, NULL);
    }
    ui_projects_bulk_end();
    ui_focus_project("perf-1");
    habitat_bench_prepare(animate);
    vTaskDelay(pdMS_TO_TICKS(600));
}
static uint32_t begin(const char *text, bool pressed, int64_t start)
{
    // Caller holds model lock across this mark and the entire API mutation.
    portENTER_CRITICAL(&mux);
    requested = start;
    sequence++;
    uint32_t id = sequence;
    snprintf(expected, sizeof expected, "%s", text);
    expect_pressed = pressed;
    portEXIT_CRITICAL(&mux);
    return id;
}
static sample_t await_frame(uint32_t id)
{
    int64_t deadline = esp_timer_get_time() + 1000000;
    for (;;) {
        portENTER_CRITICAL(&mux);
        bool ready = completed == id;
        sample_t value = result;
        portEXIT_CRITICAL(&mux);
        if (ready) return value;
        assert(esp_timer_get_time() < deadline);
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}
static void run_case(const char *name, int kind, int round, bool animate)
{
    uint32_t samples[40];
    cJSON *qs = cJSON_Parse("[{\"key\":\"direction\",\"q\":\"Which direction should we take?\","
        "\"multi\":false,\"options\":[\"Keep it quiet\",\"A little character\",\"Both directions\"]}]");
    assert(qs);
    ui_show_projects();
    ui_focus_project("perf-1");
    if (kind == 4) habitat_bench_question(qs);
    vTaskDelay(pdMS_TO_TICKS(300));
    for (int i = 0; i < 40; i++) {
        // Vary arrival phase against the 60/80/100ms pose holds; avoid a timer-locked result.
        if (kind == 3 || kind == 5) {
            display_lock();
            habitat_touch_cancel();
            ui_show_projects();
            display_unlock();
            // Touch gaze lingers for 400ms after release. Let it return before the next DOWN.
            if (kind == 5) vTaskDelay(pdMS_TO_TICKS(430));
        }
        vTaskDelay(pdMS_TO_TICKS(61 + (i * 37 % 97)));
        char expect[80];
        if (kind == 0) snprintf(expect, sizeof expect, "%d working", (i & 1) ? 16 : 15);
        else if (kind == 1) snprintf(expect, sizeof expect, "Thread %02d alpha", i & 1);
        else if (kind == 2) snprintf(expect, sizeof expect, "Thread 01 %s", (i & 1) ? "alpha" : "bravo");
        else if (kind == 3) snprintf(expect, sizeof expect, "latest result");
        else if (kind == 4) {
            const char *prompt = (i & 1) ? "Which direction should we take?" : "What should we explore next?";
            cJSON_SetValuestring(cJSON_GetObjectItem(cJSON_GetArrayItem(qs, 0), "q"), prompt);
            snprintf(expect, sizeof expect, "%s", (i & 1) ? "Which direction" : "What should we");
        } else expect[0] = 0;
        int64_t t = esp_timer_get_time();
        display_lock();
        uint32_t id = begin(expect, kind == 5, t);
        if (kind == 0) ui_project_emit("perf-15", NULL, (i & 1) ? "processing" : "done", NULL, NULL);
        else if (kind == 1) ui_focus_project((i & 1) ? "perf-1" : "perf-0");
        else if (kind == 2) {
            ui_projects_bulk_begin();
            for (int j = 0; j < 16; j++) {
                char agent[24], title[40];
                snprintf(agent, sizeof agent, "perf-%d", j);
                snprintf(title, sizeof title, "Thread %02d %s", j, (i & 1) ? "alpha" : "bravo");
                ui_project_set_name(agent, title);
            }
            ui_projects_bulk_end();
        } else if (kind == 3) habitat_bench_reader();
        else if (kind == 4) habitat_bench_question(qs);
        else habitat_touch(true, 170, 225, (uint32_t)(esp_timer_get_time() / 1000));
        display_unlock();
        uint32_t api = (uint32_t)(esp_timer_get_time() - t);
        sample_t s = await_frame(id);
        ESP_LOGI(TAG, "sample round=%d animate=%d case=%s i=%d api_us=%lu dma_us=%lu bytes=%lu "
            "model_us=%lu damage_us=%lu raster_us=%lu paint_us=%lu matches=%d",
            round, animate, name, i, (unsigned long)api, (unsigned long)s.latency,
            (unsigned long)s.bytes, (unsigned long)s.model, (unsigned long)s.damage,
            (unsigned long)s.raster, (unsigned long)s.paint, s.matches);
        // A background frame or no-op must never be reported as a successful response.
        assert(s.matches && s.bytes && s.latency);
        samples[i] = s.latency;
    }
    cJSON_Delete(qs);
    display_lock();
    habitat_touch_cancel();
    display_unlock();
    qsort(samples, 40, sizeof samples[0], cmp);
    ESP_LOGI(TAG, "case=%s round=%d animate=%d n=40 dma_p50_us=%lu dma_p95_us=%lu dma_max_us=%lu",
        name, round, animate, (unsigned long)samples[20], (unsigned long)samples[38], (unsigned long)samples[39]);
}
static void ambient_run(const char *state, int round, bool animate)
{
    vTaskDelay(pdMS_TO_TICKS(1000));
    portENTER_CRITICAL(&mux);
    memset(&ambient, 0, sizeof ambient);
    collecting = true;
    portEXIT_CRITICAL(&mux);
    int64_t t = esp_timer_get_time();
    vTaskDelay(pdMS_TO_TICKS(10000));
    portENTER_CRITICAL(&mux);
    collecting = false;
    portEXIT_CRITICAL(&mux);
    uint32_t elapsed = (uint32_t)(esp_timer_get_time() - t), n = ambient.n;
    qsort(ambient.raster_samples, n, sizeof(uint32_t), cmp);
    qsort(ambient.paint_samples, n, sizeof(uint32_t), cmp);
    ESP_LOGI(TAG, "ambient state=%s round=%d animate=%d elapsed_us=%lu frames=%lu bytes=%lu "
        "model_us=%lu damage_us=%lu raster_us=%lu paint_us=%lu raster_p50_us=%lu raster_p95_us=%lu "
        "paint_p50_us=%lu paint_p95_us=%lu samples=%lu",
        state, round, animate, (unsigned long)elapsed, (unsigned long)ambient.frames,
        (unsigned long)ambient.bytes, (unsigned long)ambient.model, (unsigned long)ambient.damage,
        (unsigned long)ambient.raster, (unsigned long)ambient.paint,
        (unsigned long)(n ? ambient.raster_samples[n/2] : 0),
        (unsigned long)(n ? ambient.raster_samples[n*95/100] : 0),
        (unsigned long)(n ? ambient.paint_samples[n/2] : 0),
        (unsigned long)(n ? ambient.paint_samples[n*95/100] : 0), (unsigned long)n);
}
void octopus_perf_run(void)
{
    // Runs on app_main, before cable startup; production render/audio priorities are unchanged.
    ESP_LOGI(TAG, "BEGIN version=octopus27-abba-v1 cpu_mhz=240 panel_mhz=40 n=40 rounds=4");
    assert(audio_notify_is_muted());
    touch_stats_t first;
    touch_stats(&first);
    const char *names[] = {"working_count", "agent_switch", "agent_burst16", "recap_open", "question_update", "touch_feedback"};
    const bool modes[] = {false, true, true, false};
    for (int round = 0; round < 4; round++) {
        bool animate = modes[round];
        fixture(animate);
        memory("before", round, animate);
        for (int kind = 0; kind < 6; kind++) run_case(names[kind], kind, round, animate);
        if (round < 2) {
            ui_show_projects();
            ambient_run("working", round, animate);
            ESP_LOGI(TAG, "audio_begin round=%d animate=%d display=working_full_animation", round, animate);
            audio_probe_run();
            ESP_LOGI(TAG, "audio_end round=%d animate=%d", round, animate);
            for (int i = 0; i < 16; i++) {
                char id[24]; snprintf(id, sizeof id, "perf-%d", i);
                ui_project_emit(id, NULL, "done", NULL, NULL);
            }
            ambient_run("idle", round, animate);
        }
        memory("after", round, animate);
        touch_stats_t touch;
        touch_stats(&touch);
        ESP_LOGI(TAG, "touch round=%d presses=%lu failures=%lu inferred=%lu", round,
            (unsigned long)(touch.presses-first.presses), (unsigned long)(touch.read_failures-first.read_failures),
            (unsigned long)(touch.inferred_releases-first.inferred_releases));
        assert(touch.presses == first.presses);
    }
    ESP_LOGI(TAG, "END completed=960 normal_firmware_must_be_restored");
    // Keep all synthetic state isolated until the flasher restores the saved daily image.
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}
