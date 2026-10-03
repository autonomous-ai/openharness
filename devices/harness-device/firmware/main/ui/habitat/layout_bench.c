// Opt-in ESP32 service-time measurements before the live renderer starts.
// Fixed local scenes only: no app actions, microphone or fabricated contacts.
#include "octopus.h"
#include "ascii_clip.h"
#include "layout_bench.h"
#ifdef DEVICE_LAYOUT_BASELINE82
#define BASELINE_LABEL "regions82"
#define CURRENT_LABEL "bands84"
#elif defined(DEVICE_LAYOUT_BASELINE79)
#include "reference79/reference.h"
#define BASELINE_LABEL "dense79"
#define CURRENT_LABEL "packed81"
#else
#include "reference48/reference.h"
#define BASELINE_LABEL "baseline48"
#define CURRENT_LABEL "optimized"
#endif
#include "touch.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_heap_caps.h"
#include "cable_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

enum { SAMPLES = 40 };
static RTC_NOINIT_ATTR uint32_t attempted[2];
void cable_scroll_benchmark(void);
static bool reference_renderer;
void ht_layout_raster(const ht_scene_t *scene, ht_rect_t region, uint16_t *out)
{
#ifdef DEVICE_LAYOUT_BASELINE82
    ht_raster(scene, region, out);
#else
    if (reference_renderer)
#ifdef DEVICE_LAYOUT_BASELINE79
        ht79_raster(scene, region, out);
#else
        ht48_raster(scene, region, out);
#endif
    else ht_raster(scene, region, out);
#endif
}
static void make_scene(ht_scene_t *scene, const ht_tim_face_t *face, uint8_t frame,
                        uint16_t ink, const char *recap)
{
#if !defined(DEVICE_LAYOUT_BASELINE79) && !defined(DEVICE_LAYOUT_BASELINE82)
    if (reference_renderer) { ht48_octopus_face(scene, face, frame, ink, recap); return; }
#endif
    ht_octopus_face(scene, face, frame, ink, recap);
}
static void find_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out)
{
#ifdef DEVICE_LAYOUT_BASELINE82
    ht_damage(before, after, out);
#else
    if (reference_renderer)
#ifdef DEVICE_LAYOUT_BASELINE79
        ht79_damage(before, after, out);
#else
        ht48_damage(before, after, out);
#endif
    else ht_damage(before, after, out);
#endif
}
static int compare(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}
static void report(const char *stage, uint32_t values[SAMPLES])
{
    qsort(values, SAMPLES, sizeof values[0], compare);
    ESP_LOGI("layout-bench", "%s n=%d min=%lu median=%lu p95=%lu max=%lu",
        stage, SAMPLES, (unsigned long)values[0],
        (unsigned long)((values[19] + values[20]) / 2),
        (unsigned long)values[37], (unsigned long)values[39]);
}
static uint32_t raster(const ht_scene_t *scene, const ht_damage_t *damage, uint16_t *scratch)
{
    int64_t began = esp_timer_get_time();
    for (int i = 0; i < damage->count; i++) {
        ht_rect_t r = damage->rect[i];
        int step = r.w * r.h <= 2048 ? r.h : 24;
        for (int y = r.y; y < r.y + r.h; y += step) {
            int h = r.y + r.h - y; if (h > step) h = step;
            ht_layout_raster(scene, (ht_rect_t){r.x, y, r.w, h}, scratch);
        }
    }
    return (uint32_t)(esp_timer_get_time() - began);
}
static void checkpoint(const char *label)
{
    assert(heap_caps_check_integrity_all(true));
    touch_stats_t t; touch_stats(&t);
    ESP_LOGI("layout-bench", "%s internal=%u largest=%u psram=%u stack=%u touches=%lu failures=%lu",
        label, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        (unsigned)uxTaskGetStackHighWaterMark(NULL),
        (unsigned long)t.presses, (unsigned long)t.read_failures);
}
void ht_layout_benchmark(uint16_t *scratch, ht_scene_t *a, ht_scene_t *b,
                         uint32_t (*paint)(const ht_scene_t *, const ht_damage_t *))
{
    // At most one attempt per version across watchdog/software resets.
    uint32_t key = 2166136261u;
    for (const char *p = esp_app_get_description()->version; *p; p++)
        key = (key ^ (uint8_t)*p) * 16777619u;
    if (attempted[0] == key && attempted[1] == ~key) {
        ESP_LOGW("layout-bench", "already attempted; normal device control resumes");
        return;
    }
    attempted[0] = key; attempted[1] = ~key;
    int64_t deadline = esp_timer_get_time() + 15000000;
    while (!cable_client_is_connected() && esp_timer_get_time() < deadline) {
        esp_task_wdt_reset(); vTaskDelay(pdMS_TO_TICKS(100));
    }
    vTaskDelay(pdMS_TO_TICKS(200));
    static const char *layouts[] = {"straight", "curved", "reading"};
    static const char *events[] = {"animation", "name", "status", "gaze", "recap"};
    static const char *names[] = {"Deploy latest firmware", "Mobile app build and deploy"};
    static const char *summary = "The update is installed. Voice input now sends to the selected agent. The result stays in the center.";
    uint32_t model[SAMPLES], damage_us[SAMPLES], raster_us[SAMPLES], total[SAMPLES], bytes[SAMPLES];
    ESP_LOGI("layout-bench", "BEGIN 4800 samples; CPU and request-to-final-DMA service time; excludes queue, sensor, panel scanout and voice; actual " BASELINE_LABEL " versus " CURRENT_LABEL " ABBA; 40 per block");
    ht_arc_fast_sampling(true); ht_glyph_cache_enable(true); ht_damage_fast_ascii(true); ht_raster_fast_ascii(true); ht_arc_tight_bounds(true);
    ht_octopus_fast_scene(true);
    ht_ascii_clip_short_runs(true);
    checkpoint("before");
    uint32_t touches = touch_activity_generation();
    for (int pass = 0; pass < 2; pass++) for (int mode_order = 0; mode_order < 2; mode_order++) {
        int mode = pass ? 1 - mode_order : mode_order;
        reference_renderer = mode == 0;
#ifdef DEVICE_LAYOUT_BASELINE82
        ht_damage_banded(mode != 0);
#endif
        for (int path_order = 0; path_order < 2; path_order++) {
            int panel = pass ? 1 - path_order : path_order;
            for (int order = 0; order < 3; order++) {
                int layout = pass ? 2 - order : order;
                for (int event = 0; event < 5; event++) {
                    ht_tim_face_t f = {.recipient=names[0], .status="Inbox 2 / Working",
                        .mood=HT_TIM_WORKING, .straight_title=layout==0,
                        .foreground=0xffff, .dim=ht_rgb(0x909990), .ink=ht_rgb(0xb9ed80)};
                    ht_scene_clear(a, ht_rgb(0x080c08));
                    make_scene(a, &f, 0, ht_rgb(0xc8a9f0), layout==2 ? summary : NULL);
                    ht_damage_t damage; find_damage(NULL, a, &damage);
                    if (panel) paint(a, &damage); else raster(a, &damage, scratch);
                    for (int i = 0; i < SAMPLES; i++) {
                        if (touch_activity_generation() != touches) {
                            ESP_LOGW("layout-bench", "CANCEL real input; normal control resumes");
                            goto done;
                        }
                        esp_task_wdt_reset();
                        f.recipient=names[event==1 ? (i+1)%2 : 0];
                        f.status=event==2 && !(i%2) ? "Inbox 2 / Wandering" : "Inbox 2 / Working";
                        f.pose.look=event==3 ? (i%2 ? -1 : 1) : 0;
                        uint8_t frame=event==0 ? (i+1)%HT_OCTOPUS_FRAMES : 0;
                        bool reading = event==4 ? ((i+1)%2 ? layout!=2 : layout==2) : layout==2;
                        int64_t start=esp_timer_get_time();
                        ht_scene_clear(b,a->background);
                        make_scene(b,&f,frame,ht_rgb(0xc8a9f0),reading ? summary : NULL);
                        int64_t modeled=esp_timer_get_time();
                        find_damage(a,b,&damage);
                        int64_t damaged=esp_timer_get_time();
                        assert(damage.count && damage.pixels);
                        raster_us[i]=panel ? paint(b,&damage) : raster(b,&damage,scratch);
                        int64_t end=esp_timer_get_time();
                        model[i]=modeled-start; damage_us[i]=damaged-modeled; total[i]=end-start;
                        bytes[i]=damage.pixels*2;
                        *a=*b;
                        // Outside every timing interval; no diagnostic idle-WDT starvation.
                        vTaskDelay(1);
                    }
                    ESP_LOGI("layout-bench", "BLOCK pass=%d renderer=%s path=%s layout=%s event=%s",
                        pass,mode ? CURRENT_LABEL : BASELINE_LABEL,panel ? "DMA" : "CPU",layouts[layout],events[event]);
                    report("model_us",model); report("damage_us",damage_us);
                    report("raster_us",raster_us); report("total_us",total); report("pixel_bytes",bytes);
                }
            }
        }
        checkpoint("block");
    }
    ESP_LOGI("layout-bench", "END complete; normal device control resumes");
    cable_scroll_benchmark();
done:
    reference_renderer = false;
    ht_damage_banded(true);
    memset(a,0,sizeof *a); memset(b,0,sizeof *b);
    checkpoint("after");
}
