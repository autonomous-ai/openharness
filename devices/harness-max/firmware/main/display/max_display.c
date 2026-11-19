// Harness Max's glass behind the Pro's pro_display.h: the app draws 1920 x 480 landscape, the OTA7290B's framebuffer is
// 480 x 1920 portrait. Every strip is turned on its way in (max_turn.h: by the PPA, max_turn_ppa.h, else by the CPU) and
// every touch on its way out.
#include "pro_display.h"

#include <assert.h>
#include <stdlib.h>

#include "max_frame.h"
#include "max_panel.h"
#include "max_touch.h"
#include "max_turn.h"
#include "max_turn_ppa.h"
#include "pins_max.h"

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "max_display";

_Static_assert(PRO_DISPLAY_W == MAX_GLASS_W && PRO_DISPLAY_H == MAX_GLASS_H, "the app's glass is the turned panel");
_Static_assert(MAX_GLASS_W == MAX_LCD_V_RES && MAX_GLASS_H == MAX_LCD_H_RES, "the turn swaps the panel's axes");

/* The Pro's API offers two strips so the DMA of one overlaps the raster of the other. Here the DMA never reads a strip:
 * pro_panel_submit turns it into the band before it returns, and the band is what the DMA reads. So both strips are one
 * buffer, and the overlap is the band's DMA with the next strip's raster. pro_frame_present waits for the last submit
 * before the next, which is when the band is free to be written again. */
static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t      s_dma_done;
static uint16_t              *s_strip;   // landscape, rows at the strip's width: the renderer's
static uint16_t              *s_band;    // the same pixels in the panel's portrait raster: the DMA's
static bool                   s_in_flight;
static bool                   s_ppa;      // the PPA turns the strips; off for good after its first failure

#define BAND_BYTES ((size_t)PRO_STRIP_PX * sizeof(uint16_t))

static esp_lcd_panel_io_handle_t s_touch_io;
static esp_lcd_touch_handle_t    s_touch;
static int64_t                   s_touch_retry_at;

/* on_color_trans_done, not on_refresh_done: it reports that the pixels asked for by draw_bitmap have landed in the
 * framebuffer, which is what a copying push waits for. */
static bool IRAM_ATTR color_done(esp_lcd_panel_handle_t p, esp_lcd_dpi_panel_event_data_t *event, void *ctx)
{
    (void)p;
    (void)event;
    (void)ctx;
    BaseType_t wake = pdFALSE;
    xSemaphoreGiveFromISR(s_dma_done, &wake);
    return wake == pdTRUE;
}

void pro_display_init(void)
{
    s_dma_done = xSemaphoreCreateBinary();
    // Internal RAM for both: the raster and the CPU's turn walk them pixel by pixel. Both DMA-capable: the PPA reads the
    // strip and writes the band, the panel's DMA reads the band. DMA-capable memory comes aligned to the cache line,
    // which the PPA needs of what it writes.
    s_strip = heap_caps_malloc(BAND_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    s_band = heap_caps_malloc(BAND_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    assert(s_dma_done && s_strip && s_band);
    const esp_err_t ppa = max_turn_ppa_open();
    s_ppa = ppa == ESP_OK;
    if (!s_ppa) ESP_LOGW(TAG, "no PPA (%s): the CPU turns the strips", esp_err_to_name(ppa));

    // Dark until the panel is up: the framebuffer starts zeroed (black), and the light comes on after.
    ESP_ERROR_CHECK(max_panel_open(&s_panel));
    const esp_lcd_dpi_panel_event_callbacks_t cbs = { .on_color_trans_done = color_done };
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_register_event_callbacks(s_panel, &cbs, NULL));
    max_backlight_set(255);

    if (!max_touch_open(&s_touch_io, &s_touch)) {
        s_touch = NULL;
        s_touch_retry_at = esp_timer_get_time() + 5000000;
        ESP_LOGW(TAG, "touch not up; pro_touch_poll() will retry");
    }
    ESP_LOGI(TAG, "%dx%d glass up (panel %dx%d, turned)", PRO_DISPLAY_W, PRO_DISPLAY_H, MAX_LCD_H_RES, MAX_LCD_V_RES);
}

uint16_t *pro_panel_strip(int which)
{
    (void)which;
    return s_strip;
}

// The PPA's turn of a strip into the band. False when it failed: logged, and the CPU turns every strip from then on.
static bool ppa_turn(const uint16_t *buf, int w, int h)
{
    const esp_err_t err = max_turn_ppa(buf, w, h, s_band, BAND_BYTES);
    if (err == ESP_OK) return true;
    ESP_LOGE(TAG, "PPA turn of %dx%d failed (%s): the CPU turns the strips from now on", w, h, esp_err_to_name(err));
    s_ppa = false;
    return false;
}

void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf)
{
    assert(s_panel && w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= PRO_DISPLAY_W && y + h <= PRO_DISPLAY_H);
    assert(buf == s_strip && w * h <= PRO_STRIP_PX);
    assert(!s_in_flight);   // the band is still the DMA's: writing it now would tear the last strip
    const max_rect_t panel = max_turn_rect((max_rect_t){x, y, w, h});
    if (!s_ppa || !ppa_turn(buf, w, h)) max_turn_pixels(buf, w, h, s_band);
    xSemaphoreTake(s_dma_done, 0);   // drop a stale give from an earlier timed-out push
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(s_panel, panel.x, panel.y, panel.x + panel.w, panel.y + panel.h, s_band));
    s_in_flight = true;
}

void pro_panel_wait(void)
{
    if (!s_in_flight) return;
    if (xSemaphoreTake(s_dma_done, pdMS_TO_TICKS(250)) != pdTRUE) {
        ESP_LOGE(TAG, "DMA completion timeout");
        abort();
    }
    s_in_flight = false;
}

// One framebuffer, which the panel scans all the time: each band is on the glass once its copy lands, so a whole frame
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
