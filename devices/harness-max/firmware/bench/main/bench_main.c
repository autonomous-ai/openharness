// Harness Max's display bench on an ESP32-P4: how long the product's display path takes with the product's own scenes,
// printed as a report every 5 s, forever (README.md says how to read it). It uses the SoC alone (CPU, memory, the PPA
// and its 2D-DMA): no pin, bus or device of the board it runs on, no flash write, and it never marks its image valid.
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "bench_raster.h"
#include "bench_scenes.h"
#include "max_turn.h"
#include "max_turn_ppa.h"
#include "pod/pod_draw.h"

#include "driver/ppa.h"
#include "esp_attr.h"
#include "esp_cache.h"
#include "esp_chip_info.h"
#include "esp_cpu.h"
#include "esp_heap_caps.h"
#include "esp_psram.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define REPORT_US 5000000
#define STRIP_BYTES ((size_t)PRO_STRIP_PX * sizeof(uint16_t))
#define GLASS_PX ((size_t)HT_WIDTH * HT_HEIGHT)
// A cached layer as wide as Overview's row of cells, and where it lands on the glass.
#define LAYER_W 1169
#define LAYER_H HT_HEIGHT
#define LAYER_X 300

_Static_assert(HT_WIDTH == MAX_GLASS_W && HT_HEIGHT == MAX_GLASS_H, "the bench draws the product's glass");

// The scenes live in PSRAM, as the product's (max_app.c's s_scene).
static EXT_RAM_BSS_ATTR ht_scene_t s_scene, s_before, s_after;
static uint16_t *s_strip, *s_strip2;   // internal, DMA-capable: each core's strip (max_display.c's s_strip)
static uint16_t *s_band;               // internal, DMA-capable: the turned strip (max_display.c's s_band)
static uint16_t *s_ref;                // PSRAM: the CPU's turn, to hold the PPA's against
static uint16_t *s_fb;                 // PSRAM: the panel's 480 x 1920 framebuffer, or the 1920 x 480 glass
static uint16_t *s_layer;              // PSRAM: a LAYER_W x LAYER_H layer
static ppa_client_handle_t s_srm;
static uint32_t s_ticks_per_us;
static TaskHandle_t s_bench, s_helper;
static const ht_scene_t *s_helper_scene;

static uint32_t cycles(void) { return (uint32_t)esp_cpu_get_cycle_count(); }
static double ms_of(uint64_t c) { return (double)c / s_ticks_per_us / 1000.0; }

// The shortest of `reps` runs of `stmt`, in ms. The bench task never leaves its core, so its cycle counter is one clock.
#define BEST_MS(reps, stmt)                                                                                             \
    ({                                                                                                                  \
        uint32_t best_ = UINT32_MAX;                                                                                    \
        for (int rep_ = 0; rep_ < (reps); rep_++) {                                                                     \
            const uint32_t t_ = cycles();                                                                               \
            stmt;                                                                                                       \
            const uint32_t d_ = cycles() - t_;                                                                          \
            if (d_ < best_) best_ = d_;                                                                                 \
        }                                                                                                               \
        ms_of(best_);                                                                                                   \
    })

static void pattern(uint16_t *px, size_t n, unsigned seed)
{
    for (size_t i = 0; i < n; i++) px[i] = (uint16_t)((i * 2654435761u + seed) >> 13);
}

// ---- (e) the second core: the odd strips of the glass, while the bench task does the even ones ----

static void helper_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        bench_glass(s_helper_scene, s_strip2, 1, 2);
        xTaskNotifyGive(s_bench);
    }
}

static void two_cores(const ht_scene_t *scene)
{
    s_helper_scene = scene;
    xTaskNotifyGive(s_helper);
    bench_glass(scene, s_strip, 0, 2);
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
}

// ---- (a) and (e): every screen, whole ----

static void screens(void)
{
    printf("(a, e) whole glass %dx%d in %d-line strips into internal RAM. build: max_ui_render; cold: no pet cell baked "
           "yet; warm: best of 2; 2 cores: strips alternating\n",
           HT_WIDTH, HT_HEIGHT, PRO_STRIP_LINES);
    printf("%-24s %5s %8s %8s %8s %8s %7s\n", "screen", "runs", "build", "cold", "warm", "2 cores", "speedup");
    static bench_kinds_t kinds;
    memset(&kinds, 0, sizeof kinds);
    double warm_sum = 0, warm_max = 0, two_sum = 0;
    const char *worst = "";
    const int n = bench_screen_count();
    for (int i = 0; i < n; i++) {
        bench_screen(i, &s_scene);
        const double build = BEST_MS(2, bench_redraw(&s_scene));
        pod_cell_bake_reset();
        const double cold = BEST_MS(1, bench_glass(&s_scene, s_strip, 0, 1));
        const double warm = BEST_MS(2, bench_glass(&s_scene, s_strip, 0, 1));
        const double two = BEST_MS(2, two_cores(&s_scene));
        bench_glass_kinds(&s_scene, s_strip, &kinds, cycles);
        printf("%-24s %5d %8.2f %8.2f %8.2f %8.2f %7.2f\n", bench_screen_name(i), s_scene.count, build, cold, warm, two,
               warm / two);
        warm_sum += warm, two_sum += two;
        if (warm > warm_max) warm_max = warm, worst = bench_screen_name(i);
        vTaskDelay(1);   // the idle task's turn: the task watchdog watches it
    }
    printf("all %d screens, warm: mean %.2f ms, max %.2f ms (%s); 2 cores: mean %.2f ms\n", n, warm_sum / n, warm_max,
           worst, two_sum / n);

    uint64_t total = 0;
    for (int k = 0; k < BENCH_KINDS; k++) total += kinds.ticks[k];
    printf("(a) by run kind, warm, every screen once:\n%-16s %9s %6s %8s %9s %7s\n", "kind", "ms", "share", "calls", "Mpx",
           "ns/px");
    for (int k = 0; k < BENCH_KINDS; k++) {
        if (!kinds.calls[k]) continue;
        printf("%-16s %9.2f %5.1f%% %8" PRIu32 " %9.3f %7.1f\n", bench_kind_name((bench_kind_t)k), ms_of(kinds.ticks[k]),
               100.0 * (double)kinds.ticks[k] / (double)total, kinds.calls[k], (double)kinds.px[k] / 1e6,
               kinds.px[k] ? ms_of(kinds.ticks[k]) * 1e6 / (double)kinds.px[k] : 0.0);
    }
}

// ---- (a) the frames that change part of a screen ----

static void partials(void)
{
    printf("(a) partial frames: ht_damage, then each rectangle in strips as pro_frame_present (best of 5)\n");
    printf("%-24s %5s %8s %8s\n", "frame", "rects", "px", "ms");
    for (int i = 0; i < bench_partial_count(); i++) {
        bench_partial(i, &s_before, &s_after);
        int rects = 0;
        const uint32_t px = bench_frame(&s_before, &s_after, s_strip, &rects);
        const double ms = BEST_MS(5, bench_frame(&s_before, &s_after, s_strip, NULL));
        printf("%-24s %5d %8" PRIu32 " %8.3f\n", bench_partial_name(i), rects, px, ms);
    }
}

// ---- (b) and (c): the strip turn on the CPU and on the PPA ----

static esp_err_t ppa_turn(ppa_srm_rotation_angle_t angle, bool mirror_x, bool mirror_y, const uint16_t *src, int w, int h,
                          uint16_t *out, size_t out_bytes, int out_w, int out_h, int out_x, int out_y)
{
    const ppa_srm_oper_config_t op = {
        .in = {.buffer = src, .pic_w = (uint32_t)w, .pic_h = (uint32_t)h, .block_w = (uint32_t)w, .block_h = (uint32_t)h,
               .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .out = {.buffer = out, .buffer_size = (uint32_t)out_bytes, .pic_w = (uint32_t)out_w, .pic_h = (uint32_t)out_h,
                .block_offset_x = (uint32_t)out_x, .block_offset_y = (uint32_t)out_y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .rotation_angle = angle,
        .scale_x = 1.0f,
        .scale_y = 1.0f,
        .mirror_x = mirror_x,
        .mirror_y = mirror_y,
        .mode = PPA_TRANS_MODE_BLOCKING,
    };
    return ppa_do_scale_rotate_mirror(s_srm, &op);
}

static void turns(void)
{
    const int w = HT_WIDTH, h = PRO_STRIP_LINES;
    pattern(s_strip, PRO_STRIP_PX, 1);
    max_turn_pixels(s_strip, w, h, s_ref);
    const double cpu = BEST_MS(10, max_turn_pixels(s_strip, w, h, s_band));
    const double cpu_glass = BEST_MS(3, for (int n = 0; n < BENCH_GLASS_STRIPS; n++) max_turn_pixels(s_strip, w, h, s_band));
    printf("(b) CPU turn (max_turn_pixels): %dx%d strip %.3f ms; %d strips %.2f ms\n", w, h, cpu, BENCH_GLASS_STRIPS,
           cpu_glass);

    // Which of the PPA's quarter turns, with or without mirroring, is max_turn_pixels'.
    printf("(c) PPA SRM turn of the %dx%d strip, against max_turn_pixels (MAX_TURN_CCW_DEGREES %d):\n", w, h,
           MAX_TURN_CCW_DEGREES);
    static const struct { ppa_srm_rotation_angle_t angle; int degrees; } ANGLES[] = {
        {PPA_SRM_ROTATION_ANGLE_90, 90}, {PPA_SRM_ROTATION_ANGLE_270, 270}};
    for (int a = 0; a < 2; a++)
        for (int m = 0; m < 4; m++) {
            memset(s_band, 0, STRIP_BYTES);
            const esp_err_t err = ppa_turn(ANGLES[a].angle, m & 1, m & 2, s_strip, w, h, s_band, STRIP_BYTES, h, w, 0, 0);
            printf("  ccw %3d%s%s: %s\n", ANGLES[a].degrees, m & 1 ? " mirror x" : "", m & 2 ? " mirror y" : "",
                   err != ESP_OK ? esp_err_to_name(err)
                   : memcmp(s_band, s_ref, STRIP_BYTES) ? "differs"
                                                         : "SAME");
        }
    const ppa_srm_rotation_angle_t angle = MAX_TURN_CCW_DEGREES == 270 ? PPA_SRM_ROTATION_ANGLE_270 : PPA_SRM_ROTATION_ANGLE_90;
    const double band = BEST_MS(10, ppa_turn(angle, false, false, s_strip, w, h, s_band, STRIP_BYTES, h, w, 0, 0));
    const double band_glass = BEST_MS(3, for (int n = 0; n < BENCH_GLASS_STRIPS; n++)
                                            ppa_turn(angle, false, false, s_strip, w, h, s_band, STRIP_BYTES, h, w, 0, 0));
    printf("  into the internal band: %.3f ms a strip (CPU %.3f), %d strips %.2f ms\n", band, cpu, BENCH_GLASS_STRIPS,
           band_glass);

    // Straight into a framebuffer in PSRAM, at the top strip's place: the turn and the panel's copy in one pass.
    const max_rect_t at = max_turn_rect((max_rect_t){0, 0, w, h});
    const size_t fb_bytes = GLASS_PX * sizeof(uint16_t);
    memset(s_fb, 0, fb_bytes);
    const double fb = BEST_MS(10, ppa_turn(angle, false, false, s_strip, w, h, s_fb, fb_bytes, HT_HEIGHT, HT_WIDTH,
                                           at.x, at.y));
    bool same = true;
    for (int row = 0; row < at.h && same; row++)
        same = !memcmp(s_fb + (size_t)(at.y + row) * HT_HEIGHT + at.x, s_ref + (size_t)row * at.w, (size_t)at.w * 2);
    printf("  into a %dx%d framebuffer in PSRAM at (%d, %d): %.3f ms a strip, %s\n", HT_HEIGHT, HT_WIDTH, at.x, at.y, fb,
           same ? "same as max_turn_pixels" : "DIFFERS from max_turn_pixels");

    // The product's own PPA turn (main/display/max_turn_ppa.c), on every shape the renderer sends: full-width strips,
    // a damage rectangle's strips, and small edits in one transfer. Damage rectangles are even (ht_damage).
    static const int SHAPES[][2] = {{1920, 24}, {1920, 8}, {1000, 24}, {46, 24}, {2, 24}, {1024, 2}, {64, 2}, {2, 2}};
    const int shapes = sizeof SHAPES / sizeof SHAPES[0];
    const esp_err_t err = max_turn_ppa_open();
    int ok = 0;
    char failed[160] = "";
    for (int s = 0; s < shapes && err == ESP_OK; s++) {
        const int sw = SHAPES[s][0], sh = SHAPES[s][1];
        pattern(s_strip, (size_t)sw * sh, (unsigned)s);
        max_turn_pixels(s_strip, sw, sh, s_ref);
        memset(s_band, 0, STRIP_BYTES);
        const esp_err_t e = max_turn_ppa(s_strip, sw, sh, s_band, STRIP_BYTES);
        if (e == ESP_OK && !memcmp(s_band, s_ref, (size_t)sw * sh * 2)) ok++;
        else snprintf(failed + strlen(failed), sizeof failed - strlen(failed), " %dx%d(%s)", sw, sh,
                      e == ESP_OK ? "differs" : esp_err_to_name(e));
    }
    if (err != ESP_OK) {
        printf("  product max_turn_ppa: no PPA client (%s)\n", esp_err_to_name(err));
        return;
    }
    pattern(s_strip, PRO_STRIP_PX, 7);
    const double full = BEST_MS(10, max_turn_ppa(s_strip, w, h, s_band, STRIP_BYTES));
    const double small = BEST_MS(10, max_turn_ppa(s_strip, 46, h, s_band, STRIP_BYTES));
    const double small_cpu = BEST_MS(10, max_turn_pixels(s_strip, 46, h, s_band));
    printf("  product max_turn_ppa: %d/%d shapes same as max_turn_pixels%s%s; 1920x24 %.3f ms, 46x24 %.3f ms (CPU %.3f)\n",
           ok, shapes, ok == shapes ? "" : ", failed:", failed, full, small, small_cpu);
}

// ---- (d) a cached layer's blit ----

static double mb_s(size_t bytes, double ms) { return (double)bytes / 1e3 / ms; }

static esp_err_t ppa_copy(int src_y, int rows, uint16_t *out, size_t out_bytes, int out_w, int out_h, int out_y)
{
    const ppa_srm_oper_config_t op = {
        .in = {.buffer = s_layer, .pic_w = LAYER_W, .pic_h = LAYER_H, .block_w = LAYER_W, .block_h = (uint32_t)rows,
               .block_offset_y = (uint32_t)src_y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .out = {.buffer = out, .buffer_size = (uint32_t)out_bytes, .pic_w = (uint32_t)out_w, .pic_h = (uint32_t)out_h,
                .block_offset_x = LAYER_X, .block_offset_y = (uint32_t)out_y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .rotation_angle = PPA_SRM_ROTATION_ANGLE_0,
        .scale_x = 1.0f,
        .scale_y = 1.0f,
        .mode = PPA_TRANS_MODE_BLOCKING,
    };
    return ppa_do_scale_rotate_mirror(s_srm, &op);
}

// The layer's rows from layer_y on, `rows` of them, at LAYER_X in a picture of the glass's width.
static bool layer_landed(const uint16_t *picture, int layer_y, int rows)
{
    for (int r = 0; r < rows; r++)
        if (memcmp(picture + (size_t)r * HT_WIDTH + LAYER_X, s_layer + (size_t)(layer_y + r) * LAYER_W, LAYER_W * 2))
            return false;
    return true;
}

static void copies(void)
{
    const size_t row = LAYER_W * sizeof(uint16_t), bytes = row * LAYER_H, fb_bytes = GLASS_PX * sizeof(uint16_t);
    pattern(s_layer, (size_t)LAYER_W * LAYER_H, 3);
    printf("(d) copy a %dx%d RGB565 layer (%u KB) to x=%d, no panel scanning PSRAM meanwhile:\n", LAYER_W, LAYER_H,
           (unsigned)(bytes / 1024), LAYER_X);

    const double pp = BEST_MS(3, for (int y = 0; y < LAYER_H; y++)
                                     memcpy(s_fb + (size_t)y * HT_WIDTH + LAYER_X, s_layer + (size_t)y * LAYER_W, row));
    const double wb = BEST_MS(3, {
        for (int y = 0; y < LAYER_H; y++) memcpy(s_fb + (size_t)y * HT_WIDTH + LAYER_X, s_layer + (size_t)y * LAYER_W, row);
        esp_cache_msync(s_fb, fb_bytes, ESP_CACHE_MSYNC_FLAG_DIR_C2M);
    });
    printf("  PSRAM->PSRAM, memcpy a row at a time:      %7.2f ms %6.0f MB/s; with the write-back a DMA reader needs "
           "%.2f ms\n", pp, mb_s(bytes, pp), wb);

    const double pi = BEST_MS(3, for (int n = 0; n < BENCH_GLASS_STRIPS; n++) for (int r = 0; r < PRO_STRIP_LINES; r++)
                                     memcpy(s_strip + (size_t)r * HT_WIDTH + LAYER_X,
                                            s_layer + (size_t)(n * PRO_STRIP_LINES + r) * LAYER_W, row));
    printf("  PSRAM->internal strips, memcpy a row:      %7.2f ms %6.0f MB/s\n", pi, mb_s(bytes, pi));

    memset(s_fb, 0, fb_bytes);
    esp_err_t err = ESP_OK;
    const double ppa_pp = BEST_MS(3, err = ppa_copy(0, LAYER_H, s_fb, fb_bytes, HT_WIDTH, HT_HEIGHT, 0));
    printf("  PSRAM->PSRAM, PPA in one transaction:      %7.2f ms %6.0f MB/s, %s\n", ppa_pp, mb_s(bytes, ppa_pp),
           err != ESP_OK ? esp_err_to_name(err) : layer_landed(s_fb, 0, LAYER_H) ? "same as memcpy" : "DIFFERS");

    const double ppa_pi = BEST_MS(3, for (int n = 0; n < BENCH_GLASS_STRIPS && err == ESP_OK; n++)
                                         err = ppa_copy(n * PRO_STRIP_LINES, PRO_STRIP_LINES, s_strip, STRIP_BYTES, HT_WIDTH,
                                                        PRO_STRIP_LINES, 0));
    printf("  PSRAM->internal strips, PPA a strip:       %7.2f ms %6.0f MB/s, %s\n", ppa_pi, mb_s(bytes, ppa_pi),
           err != ESP_OK ? esp_err_to_name(err)
           : layer_landed(s_strip, LAYER_H - PRO_STRIP_LINES, PRO_STRIP_LINES) ? "same as memcpy (the last strip)"
                                                                                : "DIFFERS");
}

// ---- the report ----

static void report(unsigned pass)
{
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    printf("\n==== Harness Max display bench, pass %u, up %" PRId64 " s ====\n", pass, esp_timer_get_time() / 1000000);
    printf("ESP32-P4 rev v%d.%d, %d cores, CPU %" PRIu32 " MHz, PSRAM %u KB; free internal %u KB (largest %u KB), "
           "PSRAM %u KB\n",
           chip.revision / 100, chip.revision % 100, chip.cores, s_ticks_per_us, (unsigned)(esp_psram_get_size() / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
    screens();
    partials();
    turns();
    copies();
    printf("==== end of pass %u ====\n", pass);
}

static void bench_task(void *arg)
{
    (void)arg;
    for (unsigned pass = 1;; pass++) {
        const int64_t start = esp_timer_get_time();
        report(pass);
        const int64_t left_us = REPORT_US - (esp_timer_get_time() - start);
        vTaskDelay(left_us > 1000 ? pdMS_TO_TICKS(left_us / 1000) : 1);
    }
}

void app_main(void)
{
    s_ticks_per_us = esp_rom_get_cpu_ticks_per_us();
    const uint32_t internal_dma = MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA;
    s_strip = heap_caps_malloc(STRIP_BYTES, internal_dma);
    s_strip2 = heap_caps_malloc(STRIP_BYTES, internal_dma);
    s_band = heap_caps_malloc(STRIP_BYTES, internal_dma);
    s_ref = heap_caps_malloc(STRIP_BYTES, MALLOC_CAP_SPIRAM);
    s_fb = heap_caps_malloc(GLASS_PX * sizeof(uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_CACHE_ALIGNED);
    s_layer = heap_caps_malloc((size_t)LAYER_W * LAYER_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    const ppa_client_config_t srm = {.oper_type = PPA_OPERATION_SRM};
    const esp_err_t ppa = ppa_register_client(&srm, &s_srm);
    if (!s_strip || !s_strip2 || !s_band || !s_ref || !s_fb || !s_layer || ppa != ESP_OK) {
        printf("bench: no memory or no PPA (%s); free internal %u KB, PSRAM %u KB\n", esp_err_to_name(ppa),
               (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
               (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
        return;
    }
    // The bench on core 1, where the product's render task runs, with its stack; its helper on core 0, where the
    // product's cable runs. The helper first: the bench hands it work as soon as it starts.
    xTaskCreatePinnedToCore(helper_task, "bench_core0", 24576, NULL, 5, &s_helper, 0);
    xTaskCreatePinnedToCore(bench_task, "bench", 24576, NULL, 5, &s_bench, 1);
}
