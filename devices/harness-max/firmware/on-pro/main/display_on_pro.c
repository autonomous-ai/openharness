// The Max's glass on the Pro's panel, behind the Pro's pro_display.h and the Max's strips (display/max_strips.h) and
// frames (display/max_frame.h). As the Linux build (linux/display/display_linux.c): the strips land in a copy of the
// whole 1920 x 480 glass (PSRAM), and at the end of each frame the blocks it changed are shrunk into the 720 x 180 band
// (max_shrink.h) and copied into the panel's framebuffer, which the panel scans all the time. The band's surround is
// painted black once and never again. The panel, its backlight and the touch controller are the Pro's drivers
// (pro_panel_bus.c, touch_gt911.c), compiled where they are; a touch is taken back to the glass, or refused off the band.
#include "pro_display.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "board_pins.h"
#include "display/max_frame.h"
#include "display/max_strips.h"
#include "max_shrink.h"
#include "pro_panel_bus.h"
#include "touch.h"

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "on_pro_display";

_Static_assert(PRO_DISPLAY_W == MAX_SHRINK_GLASS_W && PRO_DISPLAY_H == MAX_SHRINK_GLASS_H, "the Max's glass");
_Static_assert(BSP_LCD_H_RES == MAX_SHRINK_PANEL && BSP_LCD_V_RES == MAX_SHRINK_PANEL, "the Pro's square panel");
_Static_assert(MAX_STRIP_SLOTS * MAX_STRIP_PX == PRO_STRIP_PX, "a worker's buffers are one of pro_frame.c's strips");

// Glass rows shrunk and copied at once: 8 blocks, 24 band rows of 720 (34 KB of internal RAM).
#define CHUNK_ROWS (8 * MAX_SHRINK_BLOCK)
#define CHUNK_PX (MAX_SHRINK_BAND_W * CHUNK_ROWS * MAX_SHRINK_CELLS / MAX_SHRINK_BLOCK)
#define WORKER_PX ((size_t)MAX_STRIP_SLOTS * MAX_STRIP_PX)

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t s_dma_done;
static uint16_t *s_buf[MAX_WORKERS];   // a worker's strip slots, one block (internal RAM, where the raster is fast)
static uint16_t *s_glass;              // the whole glass (PSRAM)
static uint16_t *s_band;               // a chunk of the band on its way to the framebuffer (internal, DMA-capable)
static SemaphoreHandle_t s_lock;       // the frame's damage, which both of max_present's tasks add to
static max_shrink_damage_t s_damage;

static esp_lcd_panel_io_handle_t s_touch_io;
static esp_lcd_touch_handle_t s_touch;
static int64_t s_touch_retry_at;

/* on_color_trans_done, not on_refresh_done: it reports that the pixels asked for by draw_bitmap have landed in the
 * framebuffer, which is what reusing s_band waits for (pro_display.c). */
static bool IRAM_ATTR color_done(esp_lcd_panel_handle_t p, esp_lcd_dpi_panel_event_data_t *event, void *ctx)
{
    (void)p;
    (void)event;
    (void)ctx;
    BaseType_t wake = pdFALSE;
    xSemaphoreGiveFromISR(s_dma_done, &wake);
    return wake == pdTRUE;
}

// s_band's w x h pixels into the framebuffer at panel (x, y), landed when it returns.
static void put(int x, int y, int w, int h)
{
    xSemaphoreTake(s_dma_done, 0);   // drop a stale give from an earlier timed-out copy
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(s_panel, x, y, x + w, y + h, s_band));
    if (xSemaphoreTake(s_dma_done, pdMS_TO_TICKS(250)) != pdTRUE) {
        ESP_LOGE(TAG, "DMA completion timeout");
        abort();
    }
}

// The glass rows of a strip into the copy, and its blocks into the frame's damage.
static void land(const uint16_t *src, int x, int y, int w, int h)
{
    assert(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= PRO_DISPLAY_W && y + h <= PRO_DISPLAY_H);
    for (int r = 0; r < h; r++) memcpy(&s_glass[(size_t)(y + r) * PRO_DISPLAY_W + x], src + r * w, (size_t)w * 2);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    max_shrink_damage_add(&s_damage, (max_shrink_rect_t){x, y, w, h});
    xSemaphoreGive(s_lock);
}

// The blocks changed since the last call, shrunk into the band. From the render task, every strip of the frame landed.
static void shrink_out(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    const max_shrink_damage_t d = s_damage;
    s_damage.n = 0;
    xSemaphoreGive(s_lock);
    for (int i = 0; i < d.n; i++)
        for (int y = d.r[i].y; y < d.r[i].y + d.r[i].h; y += CHUNK_ROWS) {
            const int rows = d.r[i].y + d.r[i].h - y < CHUNK_ROWS ? d.r[i].y + d.r[i].h - y : CHUNK_ROWS;
            const max_shrink_rect_t blocks = {d.r[i].x, y, d.r[i].w, rows};
            const max_shrink_rect_t at = max_shrink_panel(blocks);
            max_shrink_paint(s_glass, blocks, s_band);
            put(at.x, at.y, at.w, at.h);
        }
}

void pro_display_init(void)
{
    s_dma_done = xSemaphoreCreateBinary();
    s_lock = xSemaphoreCreateMutex();
    for (int w = 0; w < MAX_WORKERS; w++)
        s_buf[w] = heap_caps_malloc(WORKER_PX * sizeof(uint16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    s_band = heap_caps_aligned_alloc(64, CHUNK_PX * sizeof(uint16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    s_glass = heap_caps_calloc((size_t)PRO_DISPLAY_W * PRO_DISPLAY_H, sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    assert(s_dma_done && s_lock && s_buf[0] && s_buf[1] && s_band && s_glass);

    /* Boost enabled with duty 0, so nothing is shown of an uninitialised framebuffer (pro_display.c). */
    pro_backlight_init();
    ESP_ERROR_CHECK(pro_panel_bus_open(&s_panel, NULL));
    const esp_lcd_dpi_panel_event_callbacks_t cbs = {.on_color_trans_done = color_done};
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_register_event_callbacks(s_panel, &cbs, NULL));
    // The whole panel black once: the band's surround is never painted again.
    memset(s_band, 0, CHUNK_PX * sizeof(uint16_t));
    const int black_rows = CHUNK_PX / MAX_SHRINK_PANEL;
    for (int y = 0; y < MAX_SHRINK_PANEL; y += black_rows)
        put(0, y, MAX_SHRINK_PANEL, MAX_SHRINK_PANEL - y < black_rows ? MAX_SHRINK_PANEL - y : black_rows);
    pro_backlight_set(255);

    if (!touch_ctrl_open(&s_touch_io, &s_touch)) {
        s_touch = NULL;
        s_touch_retry_at = esp_timer_get_time() + 5000000;
        ESP_LOGW(TAG, "touch not up; pro_touch_poll() will retry");
    }
    ESP_LOGI(TAG, "%dx%d glass up, shrunk to a %dx%d band at y %d of the %dx%d panel", PRO_DISPLAY_W, PRO_DISPLAY_H,
             MAX_SHRINK_BAND_W, MAX_SHRINK_BAND_H, MAX_SHRINK_BAND_Y, BSP_LCD_H_RES, BSP_LCD_V_RES);
}

uint16_t *max_strip_buffer(int worker, int slot) { return s_buf[worker] + (size_t)slot * MAX_STRIP_PX; }

void max_strip_push(int worker, int slot, int x, int y, int w, int h)
{
    assert(w * h <= MAX_STRIP_PX);
    land(max_strip_buffer(worker, slot), x, y, w, h);
}

// The push copied the strip before it returned: the buffer is free again at once.
void max_strip_wait(int worker, int slot)
{
    (void)worker;
    (void)slot;
}

void max_frame_show(void) { shrink_out(); }

/* The Pro's push, for pro_frame.c should anything paint through it (the Max's frames go through max_present.h): both its
 * strips are one buffer, landed and shrunk out by the time it returns. */
uint16_t *pro_panel_strip(int which)
{
    (void)which;
    return s_buf[0];
}

void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf)
{
    assert(s_panel && buf == s_buf[0] && w * h <= PRO_STRIP_PX);
    land(buf, x, y, w, h);
    shrink_out();
}

void pro_panel_wait(void) {}

/* Polled, as on the Pro. After this many failed reads in a row the controller is closed and reopened: a wedged one
 * does not recover by itself. */
#define TOUCH_ERRORS_MAX 8

pro_touch_sample_t pro_touch_poll(int *x, int *y)
{
    static unsigned errors;
    if (!s_touch) {
        if (esp_timer_get_time() < s_touch_retry_at) return PRO_TOUCH_NONE;
        s_touch_retry_at = esp_timer_get_time() + 5000000;
        if (!touch_ctrl_open(&s_touch_io, &s_touch)) {
            s_touch = NULL;
            return PRO_TOUCH_NONE;
        }
        errors = 0;
    }
    if (esp_lcd_touch_read_data(s_touch) != ESP_OK) {
        if (++errors >= TOUCH_ERRORS_MAX) {
            esp_lcd_touch_del(s_touch);
            s_touch = NULL;
            esp_lcd_panel_io_del(s_touch_io);
            s_touch_io = NULL;
            s_touch_retry_at = esp_timer_get_time() + 100000;
            errors = 0;
        }
        return PRO_TOUCH_ERROR;
    }
    errors = 0;
    esp_lcd_touch_point_data_t data[CONFIG_ESP_LCD_TOUCH_MAX_POINTS] = {0};
    uint8_t count = 0;
    // Read every contact but accept only a single finger: extra fingers must cancel, never be truncated into a tap.
    if (esp_lcd_touch_get_data(s_touch, data, &count, CONFIG_ESP_LCD_TOUCH_MAX_POINTS) != ESP_OK)
        return PRO_TOUCH_ERROR;
    if (count == 0) return PRO_TOUCH_NONE;
    if (count != 1) return PRO_TOUCH_BAD;
    int gx, gy;
    // Off the band is off the glass: the contact is cancelled, as a point off the Pro's glass is.
    if (!max_shrink_touch(data[0].x, data[0].y, &gx, &gy)) return PRO_TOUCH_BAD;
    if (x) *x = gx;
    if (y) *y = gy;
    return PRO_TOUCH_ONE;
}

bool pro_touch_read(int *x, int *y) { return pro_touch_poll(x, y) == PRO_TOUCH_ONE; }

void pro_display_set_brightness(uint8_t level) { pro_backlight_set(level < 20 ? 20 : level); }

void pro_display_power(bool on) { pro_backlight_enable(on); }
