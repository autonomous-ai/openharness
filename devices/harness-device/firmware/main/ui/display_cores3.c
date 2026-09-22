// M5Stack CoreS3 display: panel bring-up, the native 320x240 flush, and a debug snapshot. See display_cores3.h.
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
#include "cable_link.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "display.c3";

#define PANEL_W   BSP_LCD_H_RES   // 320
#define PANEL_H   BSP_LCD_V_RES   // 240

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
static lv_display_t *s_disp;          // the one LVGL display; its flush completes in on_color_done
static uint8_t s_backlight = 255;     // the level Brightness last set, restored on wake

// The DMA finished pushing a strip: hand the buffer back to LVGL, which has been rendering the next
// strip into the other one meanwhile. That overlap is the whole point of the pair of draw buffers.
static bool on_color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *edata, void *ctx)
{
    (void)io; (void)edata; (void)ctx;
    if (s_disp) lv_display_flush_ready(s_disp);
    return false;
}

void panel_bringup_cores3(void)
{
    cores3_board_power_init();
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
        // One whole draw strip per transaction (display.c sizes the strips); esp_lcd splits anything
        // larger itself, and signals done once for the lot.
        .max_transfer_sz = PANEL_W * 48 * BSP_LCD_BIT_PER_PIXEL / 8,
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
    cores3_backlight_set(s_backlight);
    ESP_LOGI(TAG, "ILI9342%s up (%dx%d) spi_mode=0 bgr invert vendor=%s",
             is_e ? "E" : "C", PANEL_W, PANEL_H, is_e ? "E-list" : "ili9341-default");
}

void panel_disp_on_off_cores3(bool on)
{
    if (!s_panel) return;
    // The panel's own display-off blanks the glass but leaves the backlight burning, which is most of
    // the power. Off: backlight first, then the panel; on: the reverse, so no stale frame flashes up.
    if (on) {
        esp_lcd_panel_disp_on_off(s_panel, true);
        cores3_backlight_set(s_backlight);
    } else {
        cores3_backlight_set(0);
        esp_lcd_panel_disp_on_off(s_panel, false);
    }
}


// ── the flush ───────────────────────────────────────────────────────────────────────────────────────
//
// Native, one pixel to one pixel. LVGL renders plain RGB565 into a strip; the panel wants it big-endian,
// so the strip is byte-swapped in place and handed to the SPI DMA as it is — no staging copy, no
// framebuffer. The flush returns at once and on_color_done tells LVGL when the strip is on the glass,
// so the next strip renders while this one travels. (RGB565_SWAPPED rendering would skip the swap, but
// LVGL 9's swapped path mis-draws fonts and layers on this panel: lvgl#9387.)

static void snap_capture(const lv_area_t *area, const uint16_t *px);

void lvgl_flush_cores3(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
{
    s_disp = disp;
    if (display_is_asleep() || !s_panel) { lv_display_flush_ready(disp); return; }
    const uint32_t n = (uint32_t)lv_area_get_width(area) * (uint32_t)lv_area_get_height(area);
    snap_capture(area, (const uint16_t *)px);
    lv_draw_sw_rgb565_swap(px, n);
    esp_lcd_panel_draw_bitmap(s_panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, px);
}

// ── debug snapshot ──────────────────────────────────────────────────────────────────────────────────
//
// What is on the glass, sent back over the cable, so the UI can be looked at without a camera: the host
// sends {"t":"debug.snap"} and gets the frame as SNAP frames — each a 4-byte little-endian offset, then
// RGB565 pixels, 320x240 in all (scripts/cores3-snap.py turns them into a PNG). It captures from the
// flush, so the top layer, overlays and dim are all in it, exactly as shown.

#define SNAP_FRAME_TYPE  0x05
#define SNAP_CHUNK_BYTES 1024   // under the USB-JTAG driver's 2 KB TX ring: a larger write never fits

enum { SNAP_IDLE, SNAP_ARMED, SNAP_CAPTURING };
static volatile int s_snap_state = SNAP_IDLE;
static uint16_t *s_snap;

static void snap_capture(const lv_area_t *area, const uint16_t *px)
{
    if (s_snap_state != SNAP_CAPTURING || !s_snap) return;
    const int w = lv_area_get_width(area);
    for (int y = area->y1; y <= area->y2; y++) {
        if (y < 0 || y >= PANEL_H) continue;
        memcpy(s_snap + (size_t)y * PANEL_W + area->x1, px + (size_t)(y - area->y1) * w, (size_t)w * 2);
    }
}

static void snap_send(void)
{
    const uint8_t *bytes = (const uint8_t *)s_snap;
    const size_t total = (size_t)PANEL_W * PANEL_H * 2;
    static uint8_t frame[4 + SNAP_CHUNK_BYTES];
    for (size_t off = 0; off < total; off += SNAP_CHUNK_BYTES) {
        size_t len = total - off < SNAP_CHUNK_BYTES ? total - off : SNAP_CHUNK_BYTES;
        frame[0] = off & 0xFF; frame[1] = (off >> 8) & 0xFF; frame[2] = (off >> 16) & 0xFF; frame[3] = (off >> 24) & 0xFF;
        memcpy(frame + 4, bytes + off, len);
        // A full TX ring refuses the write rather than waiting past its budget; give the host a moment.
        for (int tries = 0; tries < 5 && !cable_link_send(SNAP_FRAME_TYPE, frame, 4 + len); tries++) {
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
    ESP_LOGI(TAG, "snapshot sent (%ux%u)", PANEL_W, PANEL_H);
}

static void snap_refr_cb(lv_event_t *e)
{
    if (lv_event_get_code(e) == LV_EVENT_REFR_START) {
        if (s_snap_state == SNAP_ARMED) s_snap_state = SNAP_CAPTURING;
        return;
    }
    // REFR_READY: the whole screen was invalidated, so this refresh drew all of it.
    if (s_snap_state != SNAP_CAPTURING) return;
    s_snap_state = SNAP_IDLE;
    snap_send();
}

void display_cores3_snapshot(void)
{
    if (!s_disp) return;
    if (!s_snap) {
        s_snap = heap_caps_malloc((size_t)PANEL_W * PANEL_H * 2, MALLOC_CAP_SPIRAM);
        if (!s_snap) { ESP_LOGE(TAG, "snapshot buffer alloc failed"); return; }
        lv_display_add_event_cb(s_disp, snap_refr_cb, LV_EVENT_REFR_START, NULL);
        lv_display_add_event_cb(s_disp, snap_refr_cb, LV_EVENT_REFR_READY, NULL);
    }
    memset(s_snap, 0, (size_t)PANEL_W * PANEL_H * 2);
    s_snap_state = SNAP_ARMED;
    lv_obj_invalidate(lv_display_get_screen_active(s_disp));
    lv_obj_invalidate(lv_display_get_layer_top(s_disp));
    lv_obj_invalidate(lv_display_get_layer_sys(s_disp));
}

void display_cores3_bind(lv_display_t *disp) { s_disp = disp; }

// ── backlight ───────────────────────────────────────────────────────────────────────────────────────

void display_set_brightness_cores3(uint8_t level)
{
    s_backlight = level;
    if (!display_is_asleep()) cores3_backlight_set(level);   // AXP2101 DLDO1 — 0 = LDO off, 255 ≈ 3.3V
}

// ── status the chrome draws (battery, WiFi) ─────────────────────────────────────────────────────────

static int s_batt_pct = -1;
static bool s_batt_chg;
static int s_wifi_bars = -1;

void display_cores3_set_battery(int pct, bool charging)
{
    s_batt_pct = pct > 100 ? 100 : pct;
    s_batt_chg = charging;
}

void display_cores3_set_wifi(bool connected, int rssi)
{
    int bars = 0;
    if (connected) bars = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : rssi >= -85 ? 1 : 0;
    s_wifi_bars = connected ? bars : -1;
}

void display_cores3_status(int *batt_pct, bool *charging, int *wifi_bars)
{
    if (batt_pct) *batt_pct = s_batt_pct;
    if (charging) *charging = s_batt_chg;
    if (wifi_bars) *wifi_bars = s_wifi_bars;
}
