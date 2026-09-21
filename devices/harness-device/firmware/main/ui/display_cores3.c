// M5Stack CoreS3 display bring-up + virtual round-screen compositor. See display_cores3.h.
#include "display_cores3.h"

#include <stdio.h>
#include <string.h>

#include "board_i2c.h"
#include "board_pins.h"
#include "board/cores3_board.h"
#include "board/board.h"
#include "display.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_ili9341.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "ram_telemetry.h"
#include "touch.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "display.c3";

#define PANEL_W   BSP_PANEL_H_RES   // 320
#define PANEL_H   BSP_PANEL_V_RES   // 240
#define SCALE_NUM BSP_SCALE_NUM     // 1
#define SCALE_DEN BSP_SCALE_DEN     // 2
#define OFF_X     BSP_PANEL_OFF_X   // -86
#define OFF_Y     BSP_PANEL_OFF_Y   // -6

// Dest chunk height for DMA staging: 16 panel rows x 320 px = 10 KiB per chunk.
#define FLUSH_CHUNK_ROWS 16

// ── panel revision: ILI9342C vs ILI9342E ────────────────────────────────────────────────────────────
// CoreS3 ships two panel revisions. Which one is mounted is told by the FT5x06-family touch
// controller's identity registers — the probe M5GFX's Panel_M5StackCoreS3::initPanelByTouchVersion
// runs on this exact board: VENDID must be M5Stack's 0x11 and FIRMID 0x10 (C) or 0x12 (E); five
// tries, 20 ms apart, else assume C. (An early read of just FIRMID answered 0x05 here — chip still
// waking up — which is why the vendor check is part of the validity test.)

#define FT5X06_I2C_ADDR       0x38
#define FT5X06_WORKMODE_REG   0x00    // write 0x00 = normal work mode before the version reads
#define FT5X06_CIPHER_REG     0xA3
#define FT5X06_FIRMID_REG     0xA6
#define FT5X06_VENDID_REG     0xA8
#define FT5X06_VENDID_M5STACK 0x11
#define FT5X06_FIRMID_ILI9342C 0x10
#define FT5X06_FIRMID_ILI9342E 0x12
#define FT5X06_PROBE_RETRIES  5

static bool s_is_ili9342e;
static bool s_probe_done;

static esp_err_t ft5x06_read8(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t *out)
{
    return i2c_master_transmit_receive(dev, &reg, 1, out, 1, pdMS_TO_TICKS(100));
}

bool cores3_panel_is_ili9342e(void)
{
    if (s_probe_done) return s_is_ili9342e;
    s_probe_done = true;
    s_is_ili9342e = false;

    i2c_master_bus_handle_t bus = board_i2c_get();
    if (!bus) return false;
    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = FT5X06_I2C_ADDR,
        .scl_speed_hz = 100000,
    };
    i2c_master_dev_handle_t dev;
    if (i2c_master_bus_add_device(bus, &cfg, &dev) != ESP_OK) {
        ESP_LOGW(TAG, "touch version probe: no I2C device — assuming ILI9342C");
        return false;
    }

    bool valid = false;
    uint8_t cipher = 0, firmid = 0, vendid = 0;
    vTaskDelay(pdMS_TO_TICKS(300));                 // touch needs time after power-up
    for (int i = 0; i < FT5X06_PROBE_RETRIES && !valid; i++) {
        const uint8_t work_mode[] = { FT5X06_WORKMODE_REG, 0x00 };
        if (i2c_master_transmit(dev, work_mode, sizeof work_mode, pdMS_TO_TICKS(100)) != ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        esp_err_t rc = ESP_OK;
        rc |= ft5x06_read8(dev, FT5X06_CIPHER_REG, &cipher);
        rc |= ft5x06_read8(dev, FT5X06_FIRMID_REG, &firmid);
        rc |= ft5x06_read8(dev, FT5X06_VENDID_REG, &vendid);
        valid = (rc == ESP_OK)
             && vendid == FT5X06_VENDID_M5STACK
             && (firmid == FT5X06_FIRMID_ILI9342C || firmid == FT5X06_FIRMID_ILI9342E);
        if (!valid) vTaskDelay(pdMS_TO_TICKS(20));
    }
    i2c_master_bus_rm_device(dev);
    if (!valid) {
        ESP_LOGW(TAG, "touch version probe failed (cipher 0x%02X firmid 0x%02X vendid 0x%02X) — assuming ILI9342C",
                 cipher, firmid, vendid);
        return false;
    }
    s_is_ili9342e = (firmid == FT5X06_FIRMID_ILI9342E);
    ESP_LOGI(TAG, "touch CIPHER:0x%02X / FIRMID:0x%02X / VENDID:0x%02X → panel ILI9342%s",
             cipher, firmid, vendid, s_is_ili9342e ? "E" : "C");
    return s_is_ili9342e;
}

// ILI9342C (this unit, and esp-bsp board version 1): no vendor list — the ili9341 driver's
// built-in defaults + invert/BGR. ILI9342E (esp-bsp board version 2) needs the extra list
// from ili9342e_init_cmds.h. Compound literals need file scope to sit in a static initializer.
static const ili9341_lcd_init_cmd_t s_ili9342e_cmds[] = {
    {0xDD, (uint8_t[]){0x01}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x21, NULL, 0, 0},
    {0x36, (uint8_t[]){0x08}, 1, 0},
    {0xD5, (uint8_t[]){0x00}, 1, 0},
    {0xB1, (uint8_t[]){0x22}, 1, 0},
    {0xC8, (uint8_t[]){0x38}, 1, 0},
    {0xCB, (uint8_t[]){0x1C}, 1, 0},
    {0xC9, (uint8_t[]){0x1A}, 1, 0},
    {0xCA, (uint8_t[]){0x1A}, 1, 0},
    {0xB7, (uint8_t[]){0x5A, 0x41, 0x11, 0x19}, 4, 0},
    {0xE4, (uint8_t[]){0x04, 0x08, 0x11, 0x06, 0x12, 0x07, 0x3A, 0x76, 0x47, 0x07, 0x0F, 0x0A, 0x11, 0x19, 0x05}, 15, 0},
    {0xE5, (uint8_t[]){0x02, 0x03, 0x07, 0x06, 0x12, 0x07, 0x36, 0x5F, 0x48, 0x06, 0x10, 0x0C, 0x16, 0x14, 0x09}, 15, 0},
};
static const ili9341_vendor_config_t s_ili9342e_vendor = {
    .init_cmds = s_ili9342e_cmds,
    .init_cmds_size = sizeof(s_ili9342e_cmds) / sizeof(s_ili9342e_cmds[0]),
};

// ── panel bring-up ──────────────────────────────────────────────────────────────────────────────────

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t s_tx_done;   // given by the esp_lcd color-done callback (per DMA chunk)
// Dest chunk: 16 panel rows x 320 px = 10 KiB. DMA-capable internal BSS.
static DMA_ATTR uint16_t s_chunk[PANEL_W * FLUSH_CHUNK_ROWS];
// Complete 466×466 virtual frame in PSRAM. Partial LVGL flushes are copied here, then the
// panel is sampled from this image so glyphs/layers always have real neighbors.
static uint16_t *s_fb;
#define FB_W BSP_LCD_H_RES
#define FB_H BSP_LCD_V_RES

static bool on_color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *edata, void *ctx)
{
    (void)io; (void)edata; (void)ctx;
    if (s_tx_done) xSemaphoreGive(s_tx_done);
    return false;
}

void panel_bringup_cores3(void)
{
    cores3_board_power_init();
    if (!s_tx_done) s_tx_done = xSemaphoreCreateBinary();
    if (!s_fb) {
        s_fb = ram_psram_alloc((size_t)FB_W * FB_H * sizeof(uint16_t), "cores3_fb");
        if (s_fb) memset(s_fb, 0, (size_t)FB_W * FB_H * sizeof(uint16_t));
        else ESP_LOGE(TAG, "virtual framebuffer alloc failed");
    }
    // Hardware reset BEFORE SPI, leave RST high. esp-bsp's bsp_feature_enable(LCD) just
    // drives P1.1 high; M5GFX issue 192 pulses low 20 ms / high 120 ms first. SWRESET
    // (panel_reset with rst_gpio=-1) only reaches the chip once RST is high.
    cores3_lcd_reset();

    const spi_bus_config_t bus = {
        .mosi_io_num = BSP_LCD_MOSI,
        .miso_io_num = -1,               // the panel is never read; GPIO35 is D/C on this board
        .sclk_io_num = BSP_LCD_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = PANEL_W * 32 * BSP_LCD_BIT_PER_PIXEL / 8,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(BSP_LCD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io;
    // Official espressif/esp-bsp m5stack_core_s3 uses SPI mode 0 + BGR + invert.
    // (78/xiaozhi-esp32 uses mode 2 on the same pins; mode 0 is what previously showed
    // UI on this unit. Queue depth 0 asserts in spi_bus_add_device.)
    const esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = BSP_LCD_DC,
        .cs_gpio_num = BSP_LCD_CS,
        .pclk_hz = BSP_LCD_PIXEL_CLK_HZ,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
        .on_color_trans_done = on_color_done,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(BSP_LCD_SPI_HOST, &io_cfg, &io));

    const bool is_e = cores3_panel_is_ili9342e();
    esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = -1,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = BSP_LCD_BIT_PER_PIXEL,
    };
    // esp-bsp: vendor list only for ILI9342E. C revision uses the ili9341 driver's defaults.
    if (is_e) pcfg.vendor_config = (void *)&s_ili9342e_vendor;

    ESP_ERROR_CHECK(esp_lcd_new_panel_ili9341(io, &pcfg, &s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    esp_lcd_panel_invert_color(s_panel, true);
    esp_lcd_panel_swap_xy(s_panel, false);
    esp_lcd_panel_mirror(s_panel, false, false);
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));
    cores3_backlight_set(255);
    ESP_LOGI(TAG, "ILI9342%s up (%dx%d) spi_mode=0 bgr invert vendor=%s",
             is_e ? "E" : "C", PANEL_W, PANEL_H, is_e ? "E-list" : "ili9341-default");
}

void panel_disp_on_off_cores3(bool on)
{
    if (s_panel) esp_lcd_panel_disp_on_off(s_panel, on);
}

// panel coord → virtual coord (the inverse of the flush mapping). Round-nearest, clamped
// into the virtual face. Lives here so touch.c and this file share one definition.
void panel_to_virtual(int px, int py, int *vx, int *vy)
{
    int x = OFF_X + (px * SCALE_DEN + SCALE_NUM / 2) / SCALE_NUM;
    int y = OFF_Y + (py * SCALE_DEN + SCALE_NUM / 2) / SCALE_NUM;
    if (x < 0) x = 0;
    if (x > BSP_LCD_H_RES - 1) x = BSP_LCD_H_RES - 1;
    if (y < 0) y = 0;
    if (y > BSP_LCD_V_RES - 1) y = BSP_LCD_V_RES - 1;
    *vx = x; *vy = y;
}

// Integer 1/2 downsample from a complete 466×466 PSRAM frame: each panel pixel is the
// 2×2 average of virtual pixels (the usual way to shrink bitmap text). SPI wants swapped RGB565.

static inline uint16_t rgb565_spi(uint16_t native)
{
    return (uint16_t)((native >> 8) | (native << 8));
}

static inline uint16_t rgb565_box2(uint16_t a, uint16_t b, uint16_t c, uint16_t d)
{
    int r = ((a >> 11) + (b >> 11) + (c >> 11) + (d >> 11)) >> 2;
    int g = (((a >> 5) & 63) + ((b >> 5) & 63) + ((c >> 5) & 63) + ((d >> 5) & 63)) >> 2;
    int bl = ((a & 31) + (b & 31) + (c & 31) + (d & 31)) >> 2;
    return (uint16_t)((r << 11) | (g << 5) | bl);
}

// Physical top-right letterbox (virtual face ends ~x=276). 5×7 digits so "100%" fits in 44px.
#define HUD_X 278
#define HUD_Y 4
#define HUD_W 40
#define HUD_H 9
#define GLYPH_W 5
#define GLYPH_H 7

static int s_hud_pct = -1;
static bool s_hud_chg;
static int s_wifi_bars = -1;   // 0..4, -1 = hide

#define WIFI_X 4
#define WIFI_Y 4
#define WIFI_W 20
#define WIFI_H 11

// bit0 = left. Rows top→bottom.
static const uint8_t k_digit[10][GLYPH_H] = {
    {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E},
    {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F},
    {0x0E, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0E},
    {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02},
    {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
    {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E},
    {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
    {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E},
    {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},
};
static const uint8_t k_pct[GLYPH_H]  = {0x19, 0x1A, 0x04, 0x04, 0x04, 0x0B, 0x13};
static const uint8_t k_bolt[GLYPH_H] = {0x02, 0x06, 0x0C, 0x1F, 0x06, 0x0C, 0x08};

static void hud_put(uint16_t *buf, int x, const uint8_t *rows, uint16_t col)
{
    if (x + GLYPH_W > HUD_W) return;
    for (int y = 0; y < GLYPH_H; y++) {
        uint8_t bits = rows[y];
        for (int b = 0; b < GLYPH_W; b++) {
            if (bits & (1u << (GLYPH_W - 1 - b)))
                buf[(size_t)(y + 1) * HUD_W + (size_t)(x + b)] = rgb565_spi(col);
        }
    }
}

static void wifi_blit(void)
{
    if (!s_panel || s_wifi_bars < 0) return;
    uint16_t buf[WIFI_W * WIFI_H];
    memset(buf, 0, sizeof(buf));
    const uint16_t on = rgb565_spi(0xFFFF);
    const uint16_t off = rgb565_spi(0x4208);
    for (int i = 0; i < 4; i++) {
        int bw = 3, gap = 2;
        int bh = 3 + i * 2;           // 3,5,7,9
        int bx = 1 + i * (bw + gap);
        int by = WIFI_H - 1 - bh;
        uint16_t col = (i < s_wifi_bars) ? on : off;
        for (int y = 0; y < bh; y++) {
            for (int x = 0; x < bw; x++) {
                buf[(size_t)(by + y) * WIFI_W + (size_t)(bx + x)] = col;
            }
        }
    }
    esp_lcd_panel_draw_bitmap(s_panel, WIFI_X, WIFI_Y, WIFI_X + WIFI_W, WIFI_Y + WIFI_H, buf);
    xSemaphoreTake(s_tx_done, portMAX_DELAY);
}

static void hud_blit(void)
{
    if (!s_panel) return;
    wifi_blit();
    if (s_hud_pct < 0) return;
    uint16_t buf[HUD_W * HUD_H];
    memset(buf, 0, sizeof(buf));
    uint16_t col = s_hud_chg ? 0x07E0 : (s_hud_pct <= 15 ? 0xFFE0 : 0xFFFF);
    char txt[8];
    snprintf(txt, sizeof(txt), "%d%%", s_hud_pct);
    int n = (int)strlen(txt);
    int w = n * (GLYPH_W + 1) - 1;
    if (s_hud_chg) w += GLYPH_W + 1;
    int x = HUD_W - w;
    if (x < 0) x = 0;
    if (s_hud_chg) { hud_put(buf, x, k_bolt, col); x += GLYPH_W + 1; }
    for (int i = 0; i < n; i++) {
        char c = txt[i];
        if (c >= '0' && c <= '9') hud_put(buf, x, k_digit[c - '0'], col);
        else if (c == '%') hud_put(buf, x, k_pct, col);
        x += GLYPH_W + 1;
    }
    esp_lcd_panel_draw_bitmap(s_panel, HUD_X, HUD_Y, HUD_X + HUD_W, HUD_Y + HUD_H, buf);
    xSemaphoreTake(s_tx_done, portMAX_DELAY);
}

void display_cores3_set_battery(int pct, bool charging)
{
    if (pct > 100) pct = 100;
    if (pct == s_hud_pct && charging == s_hud_chg) return;
    s_hud_pct = pct;
    s_hud_chg = charging;
    if (!display_is_asleep()) hud_blit();
}

void display_cores3_set_wifi(bool connected, int rssi)
{
    int bars = 0;
    if (connected) {
        if (rssi >= -55) bars = 4;
        else if (rssi >= -65) bars = 3;
        else if (rssi >= -75) bars = 2;
        else if (rssi >= -85) bars = 1;
        else bars = 0;
    }
    if (bars == s_wifi_bars) return;
    s_wifi_bars = bars;
    if (!display_is_asleep()) hud_blit();
}

// ── native-resolution layer ─────────────────────────────────────────────────────────────────────────
//
// A SECOND LVGL display, 320x240, one-to-one with the glass. It exists for the screens the round face
// cannot serve: the 466 virtual face lands on 233x233 after the integer-half downsample, so a 10-key
// keyboard row gets ~18 px per key, about 2.5 mm, against the ~7 mm a fingertip wants. No amount of
// styling inside the virtual face fixes that, because the half mapping is uniform.
//
// Two displays, ONE panel. They must never paint at the same time, so activate() pauses the refresh
// timer of whichever is going dark. That is the whole concurrency story: LVGL walks displays
// sequentially inside lv_timer_handler, and the flush below is fully synchronous (it blocks on
// s_tx_done per chunk), so a paused display cannot be mid-flush when the other starts.
//
// The draw buffers are SHARED with the virtual display on purpose. A 320-wide partial buffer is 31%
// smaller than the 466-wide one already allocated, and internal DMA RAM on this board is down to tens
// of kilobytes; allocating a second pair to hold strictly less data would be the wrong trade.
static lv_display_t *s_native;
static bool s_native_on;

bool display_cores3_native_active(void) { return s_native_on; }

// Straight to the glass: no s_fb composite, no downsample, no letterbox. Same chunked DMA and the same
// byte swap as the compositor path, because the panel's expectations do not change with the source.
static void lvgl_flush_cores3_native(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
{
    if (display_is_asleep() || !s_panel) { lv_display_flush_ready(disp); return; }

    int dx1 = area->x1, dy1 = area->y1, dx2 = area->x2, dy2 = area->y2;
    if (dx1 < 0) dx1 = 0;
    if (dy1 < 0) dy1 = 0;
    if (dx2 > PANEL_W - 1) dx2 = PANEL_W - 1;
    if (dy2 > PANEL_H - 1) dy2 = PANEL_H - 1;
    if (dx2 < dx1 || dy2 < dy1) { lv_display_flush_ready(disp); return; }

    // PARTIAL mode packs by dirty width, but the stride can still be aligned past it — read it from the
    // draw buffer rather than assuming, exactly as the compositor path does.
    const int aw = area->x2 - area->x1 + 1;
    int src_stride_px = aw;
    lv_draw_buf_t *db = lv_display_get_buf_active(disp);
    if (db && db->header.stride >= (uint32_t)aw * sizeof(uint16_t)) {
        src_stride_px = (int)(db->header.stride / sizeof(uint16_t));
    }
    const uint16_t *src = (const uint16_t *)px;
    const int dw = dx2 - dx1 + 1;

    int dy = dy1;
    while (dy <= dy2) {
        int rows = dy2 - dy + 1;
        if (rows > FLUSH_CHUNK_ROWS) rows = FLUSH_CHUNK_ROWS;
        for (int r = 0; r < rows; r++) {
            const uint16_t *srow = src + (size_t)(dy + r - area->y1) * src_stride_px + (dx1 - area->x1);
            uint16_t *drow = s_chunk + (size_t)r * dw;
            for (int i = 0; i < dw; i++) drow[i] = rgb565_spi(srow[i]);
        }
        esp_lcd_panel_draw_bitmap(s_panel, dx1, dy, dx2 + 1, dy + rows, s_chunk);
        xSemaphoreTake(s_tx_done, portMAX_DELAY);
        dy += rows;
    }
    lv_display_flush_ready(disp);
}

lv_display_t *display_cores3_native_display(void)
{
    if (s_native) return s_native;
    lv_display_t *virt = lv_display_get_default();
    s_native = lv_display_create(PANEL_W, PANEL_H);
    if (!s_native) {
        ESP_LOGE(TAG, "native display create failed — keyboard stays on the virtual face");
        return NULL;
    }
    lv_display_set_flush_cb(s_native, lvgl_flush_cores3_native);
    lv_display_set_color_format(s_native, LV_COLOR_FORMAT_RGB565);
    // Same buffers as the virtual display. Safe only because exactly one of the two is ever unpaused —
    // see the note above; if that invariant is ever broken these must become separate allocations.
    void *b1 = NULL, *b2 = NULL;
    uint32_t bytes = 0;
    display_shared_draw_buffers(&b1, &b2, &bytes);
    if (!b1 || !bytes) {
        ESP_LOGE(TAG, "no shared draw buffers — native display cannot render");
        lv_display_delete(s_native);
        s_native = NULL;
        lv_display_set_default(virt);
        return NULL;
    }
    lv_display_set_buffers(s_native, b1, b2, bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    // Created paused: the virtual face owns the panel until something asks otherwise.
    lv_timer_t *t = lv_display_get_refr_timer(s_native);
    if (t) lv_timer_pause(t);
    lv_obj_set_style_bg_color(lv_display_get_screen_active(s_native), lv_color_black(), 0);
    lv_display_set_default(virt);
    ESP_LOGI(TAG, "native %dx%d display ready (1:1, no downsample)", PANEL_W, PANEL_H);
    return s_native;
}

void display_cores3_native_activate(bool on)
{
    lv_display_t *native = on ? display_cores3_native_display() : s_native;
    if (!native) return;
    if (s_native_on == on) return;
    lv_display_t *virt = display_virtual_display();
    if (!virt) return;

    lv_display_t *up   = on ? native : virt;
    lv_display_t *down = on ? virt   : native;
    lv_timer_t *tu = lv_display_get_refr_timer(up);
    lv_timer_t *td = lv_display_get_refr_timer(down);
    // Down FIRST. Resuming the newcomer before stopping the incumbent leaves a window where both own
    // the panel, and what lands there is whichever flush finished last — which reads as a torn frame.
    if (td) lv_timer_pause(td);
    if (tu) lv_timer_resume(tu);

    s_native_on = on;
    lv_display_set_default(up);
    touch_bind_display(up);

    // Nothing of the other face may survive: the two disagree about where every pixel goes, and a
    // partial repaint would leave the previous screen showing through wherever the new one is not dirty.
    lv_obj_t *scr = lv_display_get_screen_active(up);
    if (scr) lv_obj_invalidate(scr);
    ESP_LOGI(TAG, "display: %s", on ? "native 320x240" : "virtual 466 face");
}

void lvgl_flush_cores3(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
{
    if (display_is_asleep() || !s_fb) { lv_display_flush_ready(disp); return; }

    int vx1 = area->x1, vy1 = area->y1, vx2 = area->x2, vy2 = area->y2;
    if (vx1 < 0) vx1 = 0;
    if (vy1 < 0) vy1 = 0;
    if (vx2 > FB_W - 1) vx2 = FB_W - 1;
    if (vy2 > FB_H - 1) vy2 = FB_H - 1;
    const int aw = area->x2 - area->x1 + 1;
    // PARTIAL reshape packs by the dirty width, but stride may still be aligned past aw.
    int src_stride_px = aw;
    lv_draw_buf_t *db = lv_display_get_buf_active(disp);
    if (db && db->header.stride >= (uint32_t)aw * sizeof(uint16_t)) {
        src_stride_px = (int)(db->header.stride / sizeof(uint16_t));
    }
    const uint16_t *src = (const uint16_t *)px;
    for (int y = vy1; y <= vy2; y++) {
        memcpy(s_fb + (size_t)y * FB_W + vx1,
               src + (size_t)(y - area->y1) * src_stride_px + (vx1 - area->x1),
               (size_t)(vx2 - vx1 + 1) * sizeof(uint16_t));
    }

    int dx1 = (vx1 - OFF_X) * SCALE_NUM / SCALE_DEN;
    int dy1 = (vy1 - OFF_Y) * SCALE_NUM / SCALE_DEN;
    int dx2 = ((vx2 + 1 - OFF_X) * SCALE_NUM + SCALE_DEN - 1) / SCALE_DEN - 1;
    int dy2 = ((vy2 + 1 - OFF_Y) * SCALE_NUM + SCALE_DEN - 1) / SCALE_DEN - 1;
    // Full virtual frame: also paint the letterbox so leftover panel pixels don't stick.
    if (vx1 <= 0) dx1 = 0;
    if (vy1 <= 0) dy1 = 0;
    if (vx2 >= FB_W - 1) dx2 = PANEL_W - 1;
    if (vy2 >= FB_H - 1) dy2 = PANEL_H - 1;
    if (dx1 < 0) dx1 = 0;
    if (dy1 < 0) dy1 = 0;
    if (dx2 > PANEL_W - 1) dx2 = PANEL_W - 1;
    if (dy2 > PANEL_H - 1) dy2 = PANEL_H - 1;
    if (dx2 < dx1 || dy2 < dy1) { lv_display_flush_ready(disp); return; }

    // esp_lcd_panel_draw_bitmap wants a tightly packed bitmap of (dx2-dx1+1) * rows.
    // Writing into 320-wide rows and then handing that buffer over made the first
    // full-screen paint look fine (width happened to be 320) and every later text
    // invalidate look like noise (width 50–230, next row starts 320 pixels later).
    const int dw = dx2 - dx1 + 1;
    int dy = dy1;
    while (dy <= dy2) {
        int rows = dy2 - dy + 1;
        if (rows > FLUSH_CHUNK_ROWS) rows = FLUSH_CHUNK_ROWS;
        for (int r = 0; r < rows; r++) {
            int sy = OFF_Y + (dy + r) * SCALE_DEN / SCALE_NUM;
            uint16_t *drow = s_chunk + (size_t)r * dw;
            for (int i = 0; i < dw; i++) {
                int sx = OFF_X + (dx1 + i) * SCALE_DEN / SCALE_NUM;
                if (sx < 0 || sx > FB_W - 1 || sy < 0 || sy > FB_H - 1) {
                    drow[i] = 0;
                    continue;
                }
                int sx1 = sx + 1;
                if (sx1 > FB_W - 1) sx1 = FB_W - 1;
                int sy1 = sy + 1;
                if (sy1 > FB_H - 1) sy1 = FB_H - 1;
                const uint16_t *row0 = s_fb + (size_t)sy * FB_W;
                const uint16_t *row1 = s_fb + (size_t)sy1 * FB_W;
                drow[i] = rgb565_spi(rgb565_box2(row0[sx], row0[sx1], row1[sx], row1[sx1]));
            }
        }
        esp_lcd_panel_draw_bitmap(s_panel, dx1, dy, dx2 + 1, dy + rows, s_chunk);
        xSemaphoreTake(s_tx_done, portMAX_DELAY);
        dy += rows;
    }
    // Compositor paints the letterbox black on a full-frame flush. Restamp the HUD so it stays
    // in the physical top-right, not on the virtual face.
    if (dy1 <= HUD_Y + HUD_H - 1 && (dx1 <= WIFI_X + WIFI_W - 1 || dx2 >= HUD_X)) hud_blit();
    lv_display_flush_ready(disp);
}

// ── backlight ───────────────────────────────────────────────────────────────────────────────────────

void display_set_brightness_cores3(uint8_t level)
{
    cores3_backlight_set(level);   // AXP2101 DLDO1 — 0 = LDO off, 255 ≈ 3.3V
}
