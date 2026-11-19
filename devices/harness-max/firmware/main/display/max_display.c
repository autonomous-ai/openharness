// Harness Max's glass behind the Pro's pro_display.h: the app draws 1920 x 480 landscape, the OTA7290B's framebuffer is
// 480 x 1920 portrait. Every strip is turned on its way in (max_strips.c: by the PPA straight into the framebuffer,
// max_turn_ppa.h, else by the CPU and copied in here) and every touch on its way out.
#include "pro_display.h"

#include <assert.h>
#include <stdlib.h>

#include "max_frame.h"
#include "max_panel.h"
#include "max_strips.h"
#include "max_strips_p4.h"
#include "max_touch.h"
#include "max_turn.h"
#include "pins_max.h"

#include "esp_attr.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "max_display";

_Static_assert(PRO_DISPLAY_W == MAX_GLASS_W && PRO_DISPLAY_H == MAX_GLASS_H, "the app's glass is the turned panel");
_Static_assert(MAX_GLASS_W == MAX_LCD_V_RES && MAX_GLASS_H == MAX_LCD_H_RES, "the turn swaps the panel's axes");

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t      s_dma_done;

static esp_lcd_panel_io_handle_t s_touch_io;
static esp_lcd_touch_handle_t    s_touch;
static int64_t                   s_touch_retry_at;

/* on_color_trans_done, not on_refresh_done: it reports that the pixels asked for by draw_bitmap have landed in the
 * framebuffer, which is what a copy waits for. */
static bool IRAM_ATTR color_done(esp_lcd_panel_handle_t p, esp_lcd_dpi_panel_event_data_t *event, void *ctx)
{
    (void)p;
    (void)event;
    (void)ctx;
    BaseType_t wake = pdFALSE;
    xSemaphoreGiveFromISR(s_dma_done, &wake);
    return wake == pdTRUE;
}

// A band the CPU turned, into the framebuffer (max_strips_copy_t), landed before it returns: the band is the worker's
// next buffer.
static void copy_band(int x, int y, int w, int h, const uint16_t *band)
{
    xSemaphoreTake(s_dma_done, 0);   // drop a stale give from an earlier timed-out copy
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(s_panel, x, y, x + w, y + h, band));
    if (xSemaphoreTake(s_dma_done, pdMS_TO_TICKS(250)) != pdTRUE) {
        ESP_LOGE(TAG, "DMA completion timeout");
        abort();
    }
}

void pro_display_init(void)
{
    s_dma_done = xSemaphoreCreateBinary();
    assert(s_dma_done);
    // The strips' buffers first: internal RAM, which the raster and the CPU's turn walk pixel by pixel.
    ESP_ERROR_CHECK(max_strips_init(copy_band));

    // Dark until the panel is up: the framebuffer starts zeroed (black), and the light comes on after.
    ESP_ERROR_CHECK(max_panel_open(&s_panel));
    const esp_lcd_dpi_panel_event_callbacks_t cbs = { .on_color_trans_done = color_done };
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_register_event_callbacks(s_panel, &cbs, NULL));
    void *fb = NULL;
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_get_frame_buffer(s_panel, 1, &fb));
    max_strips_framebuffer(fb);
    max_backlight_set(255);

    if (!max_touch_open(&s_touch_io, &s_touch)) {
        s_touch = NULL;
        s_touch_retry_at = esp_timer_get_time() + 5000000;
        ESP_LOGW(TAG, "touch not up; pro_touch_poll() will retry");
    }
    ESP_LOGI(TAG, "%dx%d glass up (panel %dx%d, turned by the %s)", PRO_DISPLAY_W, PRO_DISPLAY_H, MAX_LCD_H_RES,
             MAX_LCD_V_RES, max_strips_ppa() ? "PPA" : "CPU");
}

/* The Pro's push, for pro_frame.c should anything paint through it (Max's frames go through max_present.h): both its
 * strips are one buffer, because the push has turned it into place by the time it returns. */
uint16_t *pro_panel_strip(int which)
{
    (void)which;
    return max_strip_buffer(0, 0);
}

void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf)
{
    assert(s_panel && w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= PRO_DISPLAY_W && y + h <= PRO_DISPLAY_H);
    assert(buf == max_strip_buffer(0, 0) && w * h <= PRO_STRIP_PX);
    max_strips_put(x, y, w, h);
}

void pro_panel_wait(void) {}

// One framebuffer, which the panel scans all the time: each strip is on the glass once its turn lands, so a whole frame
// has nothing left to show.
void max_frame_show(void) {}

/* Polled, as on the Pro. After this many failed reads in a row the controller is closed and reopened: a wedged one
 * does not recover by itself. */
#define TOUCH_ERRORS_MAX 8

pro_touch_sample_t pro_touch_poll(int *x, int *y)
{
    static unsigned errors;
    if (!s_touch) {
        if (esp_timer_get_time() < s_touch_retry_at) return PRO_TOUCH_NONE;
        s_touch_retry_at = esp_timer_get_time() + 5000000;
        if (!max_touch_open(&s_touch_io, &s_touch)) {
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
    const int px = data[0].x, py = data[0].y;   // the panel's portrait frame
    if (px < 0 || py < 0 || px >= MAX_LCD_H_RES || py >= MAX_LCD_V_RES) return PRO_TOUCH_BAD;
    int gx, gy;
    max_turn_touch(px, py, &gx, &gy);
    if (x) *x = gx;
    if (y) *y = gy;
    return PRO_TOUCH_ONE;
}

bool pro_touch_read(int *x, int *y) { return pro_touch_poll(x, y) == PRO_TOUCH_ONE; }

void pro_display_set_brightness(uint8_t level) { max_backlight_set(level < 20 ? 20 : level); }

void pro_display_power(bool on) { max_backlight_enable(on); }
