#include "pro_display.h"
#include "pro_turn.h"

#include <assert.h>
#include <string.h>

#include "board_pins.h"
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
#include "freertos/task.h"

static const char *TAG = "pro_display";

_Static_assert(PRO_DISPLAY_PX == BSP_LCD_H_RES && PRO_DISPLAY_PX == BSP_LCD_V_RES, "square 720 glass");

/* Two internal DMA-capable strip buffers (PRO_STRIP_PX pixels each): the renderer fills one while the other is on the
 * wire, and the turn is done in place, so nothing is copied. */

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t      s_dma_done;
static uint16_t              *s_strip[2];
static bool                   s_in_flight;

static esp_lcd_panel_io_handle_t s_touch_io;
static esp_lcd_touch_handle_t    s_touch;
static int64_t                   s_touch_retry_at;

/* on_color_trans_done, not on_refresh_done: it reports that the pixels asked for by draw_bitmap have
 * landed in the framebuffer, which is what a copying push waits for. */
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
    for (int i = 0; i < 2; i++)
        s_strip[i] = heap_caps_malloc((size_t)PRO_STRIP_PX * sizeof(uint16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    assert(s_dma_done && s_strip[0] && s_strip[1]);

    /* Boost enabled with duty 0, so nothing is shown of an uninitialised framebuffer. */
    pro_backlight_init();
    ESP_ERROR_CHECK(pro_panel_bus_open(&s_panel, NULL));
    const esp_lcd_dpi_panel_event_callbacks_t cbs = { .on_color_trans_done = color_done };
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_register_event_callbacks(s_panel, &cbs, NULL));
    pro_backlight_set(255);

    if (!touch_ctrl_open(&s_touch_io, &s_touch)) {
        s_touch = NULL;
        s_touch_retry_at = esp_timer_get_time() + 5000000;
        ESP_LOGW(TAG, "touch not up; pro_touch_read() will retry");
    }
    ESP_LOGI(TAG, "%dx%d glass up, turn=%d", PRO_DISPLAY_PX, PRO_DISPLAY_PX,
#if defined(POD_PANEL_TURN)
             POD_PANEL_TURN
#else
             0
#endif
    );
}

uint16_t *pro_panel_strip(int which) { return s_strip[which & 1]; }

void pro_panel_prepare(uint16_t *buf, int w, int h)
{
    pro_turn_pixels(buf, (size_t)w * (size_t)h);   /* the panel is mounted upside down: reverse the block (turn builds only) */
}

void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf)
{
    assert(s_panel && w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= PRO_DISPLAY_PX && y + h <= PRO_DISPLAY_PX);
    assert(buf == s_strip[0] || buf == s_strip[1]);
    int px, py;
    pro_turn_rect(x, y, w, h, &px, &py);
    xSemaphoreTake(s_dma_done, 0);   /* drop a stale give from an earlier timed-out push */
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(s_panel, px, py, px + w, py + h, buf));
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

/* The GT911 is polled, not interrupt driven. After this many failed reads in a row the controller is closed and
 * reopened: a wedged one does not recover by itself. */
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
    /* Read every contact the GT911 reports but accept only a single finger: extra fingers must cancel,
     * never be truncated into a tap. */
    if (esp_lcd_touch_get_data(s_touch, data, &count, CONFIG_ESP_LCD_TOUCH_MAX_POINTS) != ESP_OK)
        return PRO_TOUCH_ERROR;
    if (count == 0) return PRO_TOUCH_NONE;
    if (count != 1) return PRO_TOUCH_BAD;
    int tx = data[0].x, ty = data[0].y;
    if (tx < 0 || ty < 0 || tx >= PRO_DISPLAY_PX || ty >= PRO_DISPLAY_PX) return PRO_TOUCH_BAD;
    tx = pro_turn_coord(tx);   /* the contact is turned here, once */
    ty = pro_turn_coord(ty);
    if (x) *x = tx;
    if (y) *y = ty;
    return PRO_TOUCH_ONE;
}

bool pro_touch_read(int *x, int *y) { return pro_touch_poll(x, y) == PRO_TOUCH_ONE; }

void pro_display_set_brightness(uint8_t level) { pro_backlight_set(level < 20 ? 20 : level); }

void pro_display_power(bool on) { pro_backlight_enable(on); }
