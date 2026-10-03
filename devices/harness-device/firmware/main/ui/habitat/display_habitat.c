#include "illustrated.h"
// Direct text -> RGB565 -> QSPI DMA. No LVGL initialization or object pool.
#include "runtime.h"
#include "perf_bench.h"
#ifdef DEVICE_LAYOUT_BENCH
#include "layout_bench.h"
#endif
#ifdef DEVICE_TRANSPORT_BENCH
void cable_transport_benchmark(void);
#endif
#include "display.h"
#include "touch.h"
#include "ui_perf.h"
#include "audio_capture.h"
#include "cable_link.h"
#include "board_pins.h"
#include "board.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_co5300.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <string.h>
#include <assert.h>
#include <stdlib.h>
#include <stdatomic.h>
#ifdef DEVICE_RENDER_FAULT
#include "esp_attr.h"
#include "cable_client.h"
#endif
#ifdef DEVICE_RENDER_STRESS
#include "audio_client.h"
#endif

#define STRIP_LINES 24
static esp_lcd_panel_handle_t panel;
static SemaphoreHandle_t model_lock, dma_done;
static TaskHandle_t renderer;
static uint16_t *pixels[2];
static ht_scene_t scenes[2];
static bool painted;
static atomic_bool asleep, force_frame;
// Panel IO belongs to the renderer, including brightness changes.
static atomic_uint requested_brightness = 40;
static atomic_uint last_activity;
static int64_t input_us;
static portMUX_TYPE stats_lock = portMUX_INITIALIZER_UNLOCKED;
static habitat_perf_t stats;
static void (*power_cb)(bool);
// Watch actual renderer progress independently of the USB and touch tasks.
// A blocked panel call must not leave a responsive host controlling a frozen screen.
enum { RENDER_MODEL, RENDER_POWER, RENDER_DAMAGE, RENDER_RASTER, RENDER_DMA,
       RENDER_SUBMIT, RENDER_HEALTH, RENDER_WAIT };
static atomic_uint render_stage, render_progress_ms;
static esp_timer_handle_t render_guard;
// The CO5300's power-on register sequence. The Pro has no equivalent here: the ST7703's own
// init lives inside waveshare/esp_lcd_st7703 and is applied by esp_lcd_panel_init().
static const co5300_lcd_init_cmd_t init_cmds[] = {
    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},
    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x06, 0x01, 0xD7}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xD1}, 4, 600},
    {0x11, NULL, 0, 600},
    {0x29, NULL, 0, 0},
};
static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static uint32_t elapsed_since(const atomic_uint *stamp)
{
    // Read the shared timestamp FIRST. Sampling time before a concurrent store
    // can subtract a future millisecond and wrap into a false multi-day stall.
    uint32_t since = atomic_load(stamp);
    return now_ms() - since;
}
static void render_progress(unsigned stage)
{
    atomic_store(&render_progress_ms, now_ms());
    atomic_store(&render_stage, stage);
}
static void render_watch(void *arg)
{
    (void)arg;
    uint32_t elapsed = elapsed_since(&render_progress_ms);
    if (elapsed < 4000) return;
    static const char *stages[] = {"model", "panel power", "damage", "raster",
                                   "DMA wait", "panel submit", "health", "wake wait"};
    unsigned stage = atomic_load(&render_stage);
    ESP_LOGE("habitat", "renderer stalled %lu ms at %s; restarting", (unsigned long)elapsed,
             stage < sizeof stages / sizeof stages[0] ? stages[stage] : "unknown");
    // Panic reboot also preserves the stage in the existing last-words log.
    abort();
}
#ifdef DEVICE_RENDER_FAULT
// Diagnostic image only. One deliberate blocked render task, then normal boot.
// The RTC marker survives the panic; no settings or NVS writes are involved.
static RTC_NOINIT_ATTR uint32_t injected_stall[2];
static void render_fault_once(void)
{
    const uint32_t cookie = 0x48524651u;
    if (injected_stall[0] == cookie && injected_stall[1] == ~cookie) return;
    if (now_ms() < 12000 || !cable_client_is_connected()) return;
    injected_stall[0] = cookie; injected_stall[1] = ~cookie;
    ESP_LOGW("render-test", "INJECT once: blocking renderer at panel submit; guard must recover");
    render_progress(RENDER_SUBMIT);
    vTaskDelay(pdMS_TO_TICKS(20000));
    ESP_LOGE("render-test", "FAIL: renderer stall guard did not restart within 20 seconds");
    abort();
}
#endif
#ifdef DEVICE_RENDER_STRESS
// Local display-only soak. No fabricated contacts, app commands or microphone.
// A real touch or voice session cancels the test immediately.
static uint32_t render_stress_tick(void)
{
    static bool started, finished;
    static uint32_t due, cycles, rng = 0x41be95;
    if (finished) return 1000;
    uint32_t now = now_ms();
    if (now < 15000) return 20;
    touch_stats_t touch; touch_stats(&touch);
    if (touch.presses || audio_client_active()) {
        finished = true;
        ESP_LOGW("render-test", "STRESS cancelled by user input at cycle %lu", (unsigned long)cycles);
        return 1000;
    }
    if (!started) {
        started = true; due = now;
        ESP_LOGI("render-test", "STRESS begin: 1000 sleep/wake cycles; heap integrity + task stack checks");
    }
    if ((int32_t)(now - due) < 0) return 20;
    bool wake = display_is_asleep();
    display_lock();
    if (wake) display_wake(); else display_sleep();
    display_unlock();
    if (wake && ++cycles % 50 == 0) {
        assert(heap_caps_check_integrity_all(true));
        ESP_LOGI("render-test", "STRESS cycles=%lu int=%u min=%u psram=%u render_stack=%u touch_stack=%u action_stack=%u cable_stack=%u",
            (unsigned long)cycles, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
            (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
            (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
            (unsigned)uxTaskGetStackHighWaterMark(NULL),
            (unsigned)uxTaskGetStackHighWaterMark(xTaskGetHandle("habitat_touch")),
            (unsigned)uxTaskGetStackHighWaterMark(xTaskGetHandle("habitat_actions")),
            (unsigned)uxTaskGetStackHighWaterMark(xTaskGetHandle("cable_link")));
    }
    if (cycles >= 1000) {
        finished = true;
        ESP_LOGI("render-test", "STRESS PASS: 1000 complete sleep/wake cycles, no heap corruption; normal control resumes");
        return 1000;
    }
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    due = now + 40 + rng % 181;
    return 20;
}
#endif
void habitat_render_notify(void)
{
    if (renderer)
        xTaskNotifyGive(renderer);
}
void habitat_input_stamp(int64_t us)
{
    portENTER_CRITICAL(&stats_lock);
    input_us = us;
    portEXIT_CRITICAL(&stats_lock);
}
void habitat_perf_get(habitat_perf_t *out)
{
    portENTER_CRITICAL(&stats_lock);
    *out = stats;
    portEXIT_CRITICAL(&stats_lock);
}
// THE DMA FENCE, in the two shapes the two panels report it.
//
// Both say the same thing — the pixels draw_bitmap was given have landed, so the buffer the CPU handed
// over is free again — and both give the same semaphore, which is the only thing the strip loop waits
// on. The dial reports it on the panel IO (a QSPI transfer finished); the Pro reports it on the DPI
// panel (a copy into the scanned framebuffer finished).
//
// On the Pro this MUST be on_color_trans_done and not on_refresh_done. The latter fires when the panel
// has finished SCANNING a frame, which is what a buffer-switch scheme waits for; ours copies, so
// waiting on the scan would fence against the wrong event and stall the first strip forever. The same
// distinction is written up at length in ui/panel_pro.c, which learned it the hard way.
static bool fence_release(void)
{
    ui_perf_flush_done();
    BaseType_t wake = pdFALSE;
    xSemaphoreGiveFromISR(dma_done, &wake);
    // Both drivers act on this return to decide whether to yield out of the ISR — the QSPI IO one and
    // the DPI one (esp_lcd_panel_dpi.c). Saying so is the contract; yielding here as well is not.
    return wake == pdTRUE;
}
static bool color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *event,
                       void *ctx)
{
    (void)io;
    (void)event;
    (void)ctx;
    return fence_release();
}
void display_lock_at(const char *who)
{
    (void)who;
    if (model_lock)
        xSemaphoreTakeRecursive(model_lock, portMAX_DELAY);
}
void display_unlock(void)
{
    if (model_lock)
        xSemaphoreGiveRecursive(model_lock);
}
bool display_is_asleep(void) { return atomic_load(&asleep); }
void display_set_power_cb(void (*cb)(bool)) { power_cb = cb; }
void display_bump_activity(void) { atomic_store(&last_activity, now_ms()); }
void display_sleep(void)
{
    if (atomic_exchange(&asleep, true))
        return;
    if (power_cb)
        power_cb(false);
    habitat_render_notify();
}
void display_wake(void)
{
    if (!atomic_exchange(&asleep, false))
        return;
    display_bump_activity();
    atomic_store(&force_frame, true);
    if (power_cb)
        power_cb(true);
    habitat_render_notify();
}
void display_set_brightness(uint8_t value)
{
    unsigned percent = ((unsigned)value * 100 + 127) / 255;
    atomic_store(&requested_brightness, percent < 8 ? 8 : percent);
    habitat_render_notify();
}
static void wait_dma(void)
{
    render_progress(RENDER_DMA);
    if (xSemaphoreTake(dma_done, pdMS_TO_TICKS(250)) != pdTRUE) {
        ESP_LOGE("habitat", "DMA completion timeout");
        abort();
    }
}
static uint32_t paint(const ht_scene_t *next, const ht_damage_t *damage)
{
    bool pending = false;
    int buffer = 0;
    int64_t started = esp_timer_get_time();
    uint32_t raster_us = 0;
    for (int n = 0; n < damage->count; n++) {
        ht_rect_t rect = damage->rect[n];
        // A small glyph edit fits in one transfer even when taller than a full-width strip.
        // Keep larger regions pipelined: a 40-row buffer saved a command but delayed their DMA.
        int step = rect.w * rect.h <= 2048 ? rect.h : STRIP_LINES;
        for (int y = rect.y; y < rect.y + rect.h; y += step) {
            int h = rect.y + rect.h - y;
            if (h > step)
                h = step;
            ht_rect_t strip = {rect.x, y, rect.w, h};
            int64_t t = esp_timer_get_time();
            render_progress(RENDER_RASTER);
#ifdef DEVICE_LAYOUT_BENCH
            ht_layout_raster(next, strip, pixels[buffer]);
#else
            ht_raster(next, strip, pixels[buffer]);
#endif
            raster_us += (uint32_t)(esp_timer_get_time() - t);
            // CPU prepares B while DMA owns A. Neither buffer is reused before the ISR fence.
            if (pending)
                wait_dma();
            ui_perf_flush((size_t)rect.w * h * 2);
            render_progress(RENDER_SUBMIT);
            ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, rect.x, y, rect.x + rect.w, y + h,
                                                      pixels[buffer]));
            pending = true;
            buffer ^= 1;
        }
    }
    if (pending)
        wait_dma();
    int64_t finished = esp_timer_get_time();
#ifdef DEVICE_OCTOPUS_BENCH
    octopus_perf_paint(raster_us, (uint32_t)(finished - started));
#endif
    portENTER_CRITICAL(&stats_lock);
    stats.frames++;
    stats.bytes += damage->pixels * 2;
    if (raster_us > stats.raster_max_us)
        stats.raster_max_us = raster_us;
    if (finished - started > stats.frame_max_us)
        stats.frame_max_us = (uint32_t)(finished - started);
    if (input_us && input_us <= started) {
        stats.input_last_us = (uint32_t)(finished - input_us);
        if (stats.input_last_us > stats.input_max_us)
            stats.input_max_us = stats.input_last_us;
        input_us = 0;
    }
    portEXIT_CRITICAL(&stats_lock);
    return raster_us;
}
static void heartbeat(void)
{
    static uint32_t last;
    uint32_t now = now_ms();
    if (!last) {
        last = now;
        return;
    }
    if (now - last < 60000)
        return;
    last = now;
    touch_stats_t touch;
    habitat_perf_t perf;
    touch_stats(&touch);
    habitat_perf_get(&perf);
    // The host watches this exact prefix. Emit from the renderer itself, including while asleep,
    // so a live cable cannot mask a stalled UI. Nothing is drawn for this once-a-minute report.
    ESP_LOGI("habitat",
             "alive up=%lus heap=%u/%u psram=%u touches=%lu read_fails=%lu inferred=%lu "
             "frames=%lu bytes=%lu input_last_us=%lu muted=%d raster_max_us=%lu frame_max_us=%lu log_drops=%lu stack_free=%u%s%s",
             (unsigned long)(now / 1000),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned long)touch.presses, (unsigned long)touch.read_failures,
             (unsigned long)touch.inferred_releases, (unsigned long)perf.frames,
             (unsigned long)perf.bytes, (unsigned long)perf.input_last_us,
             (int)audio_notify_is_muted(), (unsigned long)perf.raster_max_us,
             (unsigned long)perf.frame_max_us, (unsigned long)cable_link_dropped_logs(),
             (unsigned)uxTaskGetStackHighWaterMark(NULL),
             touch.controller_ok ? "" : " TOUCH-DEAD",
             display_is_asleep() ? " asleep" : "");
}
static void render_task(void *arg)
{
    (void)arg;
    ESP_ERROR_CHECK(esp_task_wdt_add(NULL));
#ifdef DEVICE_TRANSPORT_BENCH
    cable_transport_benchmark();
#endif
#ifdef DEVICE_LAYOUT_BENCH
    ht_layout_benchmark(pixels[0], &scenes[0], &scenes[1], paint);
    portENTER_CRITICAL(&stats_lock);
    memset(&stats, 0, sizeof stats);
    portEXIT_CRITICAL(&stats_lock);
#endif
    render_progress(RENDER_MODEL);
    const esp_timer_create_args_t guard_args = {.callback = render_watch, .name = "render_guard"};
    ESP_ERROR_CHECK(esp_timer_create(&guard_args, &render_guard));
    ESP_ERROR_CHECK(esp_timer_start_periodic(render_guard, 1000000));
    int front = 0;
    bool panel_on = true;
    unsigned applied_brightness = 101;
    for (;;) {
        ESP_ERROR_CHECK(esp_task_wdt_reset());
#ifdef DEVICE_RENDER_FAULT
        render_fault_once();
#endif
#ifdef DEVICE_RENDER_STRESS
        uint32_t stress_wake_ms = render_stress_tick();
#endif
        render_progress(RENDER_MODEL);
        display_lock();
#ifdef DEVICE_OCTOPUS_BENCH
        int64_t model_started = esp_timer_get_time();
#endif
        habitat_tick();
        bool fresh = habitat_scene_take(&scenes[front ^ 1]);
        uint32_t receipt = habitat_scene_receipt();
        uint32_t wake_ms = habitat_next_wake_ms();
#ifdef DEVICE_RENDER_STRESS
        if (stress_wake_ms < wake_ms) wake_ms = stress_wake_ms;
#endif
#ifdef DEVICE_OCTOPUS_BENCH
        uint32_t model_us = (uint32_t)(esp_timer_get_time() - model_started);
        ht_perf_tag_t tag = octopus_perf_capture(&scenes[front ^ 1], fresh);
#endif
        display_unlock();
        unsigned brightness = atomic_load(&requested_brightness);
        if (brightness != applied_brightness) {
            render_progress(RENDER_POWER);
            ESP_ERROR_CHECK(esp_lcd_panel_co5300_set_brightness(panel, brightness));
            applied_brightness = brightness;
            ESP_LOGI("habitat", "OLED brightness %u%%", brightness);
        }
        bool on = !display_is_asleep();
        if (on != panel_on) {
            render_progress(RENDER_POWER);
            ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, on));
            panel_on = on;
        }
        // A touch/PWR wake can arrive after we sampled `on`, including during
        // panel power-off. Keep its repaint request until an awake iteration.
        bool force = on && atomic_exchange(&force_frame, false);
        if (on && (fresh || force)) {
            if (!fresh)
                scenes[front ^ 1] = scenes[front];
            ht_damage_t damage;
            render_progress(RENDER_DAMAGE);
#ifdef DEVICE_OCTOPUS_BENCH
            int64_t damage_started = esp_timer_get_time();
#endif
            ht_illustrated_prepare(&scenes[front ^ 1]);
            ht_damage(painted && !force ? &scenes[front] : NULL, &scenes[front ^ 1], &damage);
#ifdef DEVICE_OCTOPUS_BENCH
            uint32_t damage_us = (uint32_t)(esp_timer_get_time() - damage_started);
#endif
            if (damage.count)
                paint(&scenes[front ^ 1], &damage);
#ifdef DEVICE_OCTOPUS_BENCH
            octopus_perf_commit(tag, damage.pixels * 2, model_us, damage_us);
#endif
            front ^= 1;
            painted = true;
            if (receipt) habitat_scene_presented(receipt);
        }
        if (!on && fresh) {
            front ^= 1;
            painted = false;
        }
        if (on && elapsed_since(&last_activity) > 300000) {
            display_lock();
            // A touch may have refreshed activity while we waited for this
            // lock. The stale pre-lock idle decision must not swallow it.
            if (elapsed_since(&last_activity) > 300000)
                display_sleep();
            display_unlock();
        }
        render_progress(RENDER_HEALTH);
        heartbeat();
        // Notifications wake immediately; only finite reactions / voice require the short timeout.
        render_progress(RENDER_WAIT);
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wake_ms > 1000 ? 1000 : wake_ms));
    }
}
void display_init(void)
{
    ht_illustrated_init();
    model_lock = xSemaphoreCreateRecursiveMutex();
    dma_done = xSemaphoreCreateBinary();
    assert(model_lock && dma_done);
    const spi_bus_config_t bus =
        CO5300_PANEL_BUS_QSPI_CONFIG(BSP_LCD_QSPI_SCLK, BSP_LCD_QSPI_D0, BSP_LCD_QSPI_D1,
                                     BSP_LCD_QSPI_D2, BSP_LCD_QSPI_D3, HT_WIDTH * STRIP_LINES * 2);
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
    esp_lcd_panel_io_spi_config_t io_cfg =
        CO5300_PANEL_IO_QSPI_CONFIG(BSP_LCD_QSPI_CS, color_done, NULL);
    io_cfg.trans_queue_depth = 2;
    esp_lcd_panel_io_handle_t io;
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &io_cfg, &io));
    co5300_vendor_config_t vendor = {.init_cmds = init_cmds,
                                     .init_cmds_size = sizeof(init_cmds) / sizeof(init_cmds[0]),
                                     .flags = {.use_qspi_interface = 1}};
    esp_lcd_panel_dev_config_t cfg = {.reset_gpio_num = board()->lcd_rst,
                                      .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
                                      .bits_per_pixel = 16,
                                      .vendor_config = &vendor};
    ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(io, &cfg, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 6, 0));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    for (int i = 0; i < 2; i++) {
        pixels[i] =
            heap_caps_malloc(HT_WIDTH * STRIP_LINES * 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
        assert(pixels[i]);
    }
    display_bump_activity();
    // The ROM inflater keeps its Huffman tables on the calling task's stack.
    // Illustrated companions can become active at any time over the USB link.
    assert(xTaskCreatePinnedToCore(render_task, "habitat_render", 24576, NULL, 5, &renderer, 1) ==
           pdPASS);
    touch_init();
    ESP_LOGI("habitat", "direct C renderer on a %dpx face: two %d-byte internal DMA buffers over %s",
             HT_WIDTH, HT_WIDTH * STRIP_LINES * 2,
             "40MHz QSPI");
}
void display_init_ota(void) { display_init(); }
