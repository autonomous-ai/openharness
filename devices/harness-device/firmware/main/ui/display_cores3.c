// M5Stack CoreS3 display bring-up + virtual round-screen compositor. See display_cores3.h.
#include "display_cores3.h"

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
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "display.c3";

#define PANEL_W   BSP_PANEL_H_RES   // 320
#define PANEL_H   BSP_PANEL_V_RES   // 240
#define SCALE_NUM BSP_SCALE_NUM     // 8
#define SCALE_DEN BSP_SCALE_DEN     // 11
#define OFF_X     BSP_PANEL_OFF_X   // 13
#define OFF_Y     BSP_PANEL_OFF_Y   // 68

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

// Panel init command lists, from the board's ground truth (m5stack/M5GFX, BSD-licensed):
// ILI9342C → Panel_ILI9342::getInitCommands list0 (verbatim); ILI9342E → the extra command list
// in Panel_M5StackCoreS3::getIli9342EInitCommands (matches esp-bsp's ili9342e_init_cmds.h).
// The esp_lcd_ili9341 driver's built-in ILI9341 defaults are NOT valid for the ILI9342 — most
// importantly the panel locks its extended commands until `0xC8 = FF 93 42` unlocks them, and
// its power/VCOM registers take different values — a default-init panel shows a lit but blank
// (white, corrupted-strips) face, which is exactly what we saw on the first CoreS3 boot.
static const ili9341_lcd_init_cmd_t s_ili9342c_cmds[] = {
    {0xC8, (uint8_t[]){0xFF, 0x93, 0x42}, 3, 0},   // SETEXTC: turn on the external commands
    {0xC0, (uint8_t[]){0x12, 0x12}, 2, 0},         // PWCTR1
    {0xC1, (uint8_t[]){0x03}, 1, 0},               // PWCTR2
    {0xC5, (uint8_t[]){0xF2}, 1, 0},               // VMCTR1
    {0xB0, (uint8_t[]){0xE0}, 1, 0},               // Interface mode control
    {0xF6, (uint8_t[]){0x01, 0x00, 0x00}, 3, 0},   // Interface control
    {0xE0, (uint8_t[]){0x00,0x0C,0x11,0x04,0x11,0x08,0x37,0x89,0x4C,0x06,0x0C,0x0A,0x2E,0x34,0x0F}, 15, 0},
    {0xE1, (uint8_t[]){0x00,0x0B,0x11,0x05,0x13,0x09,0x33,0x67,0x48,0x07,0x0E,0x0B,0x2E,0x33,0x0F}, 15, 0},
    {0xB6, (uint8_t[]){0x08, 0x82, 0x1D, 0x04}, 4, 0},   // Display function control
    {0x38, NULL, 0, 0},                            // idle mode off
    {0x29, NULL, 0, 0},                            // display on
    {0x11, NULL, 0, 120},                          // sleep out, settle
};
static const ili9341_vendor_config_t s_ili9342c_vendor = {
    .init_cmds = s_ili9342c_cmds,
    .init_cmds_size = sizeof(s_ili9342c_cmds) / sizeof(s_ili9342c_cmds[0]),
};

// ILI9342E-revision command list (esp-bsp's ili9342e_init_cmds.h / M5GFX E-list verbatim:
// ILI9341 power-up block + the E-specific gamma/source settings). Compound literals need file
// scope to sit in a static initializer.
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
    {0x11, NULL, 0, 120},
    {0x29, NULL, 0, 120},
};
static const ili9341_vendor_config_t s_ili9342e_vendor = {
    .init_cmds = s_ili9342e_cmds,
    .init_cmds_size = sizeof(s_ili9342e_cmds) / sizeof(s_ili9342e_cmds[0]),
};

// ── panel bring-up ──────────────────────────────────────────────────────────────────────────────────

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t s_tx_done;   // given by the esp_lcd color-done callback (per DMA chunk)

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
    // esp-bsp convention for this board: an async transaction queue (depth 10) + the color-done
    // callback. queue depth 0 is NOT supported here — it flows into xQueueCreate(0, …) and trips a
    // FreeRTOS assert in spi_bus_add_device. The flush below waits on the callback per chunk, so
    // the staging buffer stays valid until each DMA completes.
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

    esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = -1,            // reset already pulsed via the expander
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = BSP_LCD_BIT_PER_PIXEL,
    };
    // ILI9342E (newer boards) needs a vendor command list; ILI9342C boots on driver defaults.
    // Both revisions get their board-specific command list (see the tables above); only the
    // C list rides on the esp_lcd_ili9341 driver's defaults for MADCTL/colmod/sleep handling.
    pcfg.vendor_config = cores3_panel_is_ili9342e() ? (void *)&s_ili9342e_vendor
                                                    : (void *)&s_ili9342c_vendor;

    ESP_ERROR_CHECK(esp_lcd_new_panel_ili9341(io, &pcfg, &s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    // Invert ON — per M5GFX's Panel_M5StackCoreS3 (`invert = true`); without it the image is
    // polarity-flipped (the user saw "inverted" with it off).
    esp_lcd_panel_invert_color(s_panel, true);
    // Native 320x240 memory, no axis swap: with swap_xy the MADCTL MV bit makes partial-update
    // windows fill column-major while our flush streams rows → garbled output (observed).
    // esp-bsp uses no-swap/no-mirror on this board — same here; any final rotation is a
    // one-flag change once seen on hardware.
    esp_lcd_panel_swap_xy(s_panel, false);
    esp_lcd_panel_mirror(s_panel, false, false);
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));
    ESP_LOGI(TAG, "ILI9342%s up (%dx%d)", cores3_panel_is_ili9342e() ? "E" : "C", PANEL_W, PANEL_H);
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

// ── the 0.58 downscale flush (LVGL partial render mode) ──────────────────────────────────────────────
//
// LVGL renders each dirty virtual area into an internal partial buffer; the flush resamples it
// onto the panel:
//
//   panel column dx ← virtual sx(dx) = OFF_X + dx·DEN/NUM (nearest, clamped into the flushed area)
//
// Sampling is a fixed function of the panel column, so consecutive flushes of the same screen
// state agree; the dest window is trimmed so every sample lands inside the flushed area, and
// extended to the panel edges when the flush touches a virtual edge (the margins sample the
// clamped bezel pixels — dark). Whatever a trimmed edge skips is covered by the neighbouring
// flush of the same state, so there are no seams and no missed pixels.

// Dest chunk height: 16 panel rows x 320 px = 10 KiB of internal staging per chunk.
static uint16_t s_chunk[PANEL_W * FLUSH_CHUNK_ROWS];   // 10 KiB internal, DMA-safe (static BSS)

void lvgl_flush_cores3(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
{
    // TEMP bring-up diagnostics: prove the flush fires and the pointer/geometry are sane.
    static int n = 0;
    if (n < 2) {
        ESP_LOGW(TAG, "flush#%d area=(%d,%d..%d,%d) px=%p", n,
                 area->x1, area->y1, area->x2, area->y2, px);
        n++;
    }
    // Asleep: the panel is off — ack immediately so LVGL does not wait on skipped DMA.
    if (display_is_asleep()) { lv_display_flush_ready(disp); return; }

    const int vx1 = area->x1, vy1 = area->y1, vx2 = area->x2, vy2 = area->y2;
    const int aw = vx2 - vx1 + 1;
    const uint16_t *src = (const uint16_t *)px;        // virtual RGB565 (swapped), row-major

    int dx1 = (vx1 - OFF_X) * SCALE_NUM / SCALE_DEN;
    int dy1 = (vy1 - OFF_Y) * SCALE_NUM / SCALE_DEN;
    int dx2 = ((vx2 + 1 - OFF_X) * SCALE_NUM + SCALE_DEN - 1) / SCALE_DEN - 1;
    int dy2 = ((vy2 + 1 - OFF_Y) * SCALE_NUM + SCALE_DEN - 1) / SCALE_DEN - 1;
    // A flush touching a virtual edge also owns the panel margins outside the mapped window
    // (OFF_X is negative: the 466px face is narrower than 320 columns at 0.58). Those columns
    // sample the clamped bezel edge — dark — instead of keeping their post-init GRAM.
    if (vx1 <= 0) dx1 = 0;
    if (vy1 <= 0) dy1 = 0;
    if (vx2 >= BSP_LCD_H_RES - 1) dx2 = PANEL_W - 1;
    if (vy2 >= BSP_LCD_V_RES - 1) dy2 = PANEL_H - 1;
    if (dx1 < 0) dx1 = 0;
    if (dy1 < 0) dy1 = 0;
    if (dx2 > PANEL_W - 1) dx2 = PANEL_W - 1;
    if (dy2 > PANEL_H - 1) dy2 = PANEL_H - 1;
    if (dx2 < dx1 || dy2 < dy1) { lv_display_flush_ready(disp); return; }

    // Column map for the dest range (≤ 320 entries, recomputed per flush — cheap).
    int16_t smap[PANEL_W];
    for (int d = dx1; d <= dx2; d++) {
        int s = OFF_X + (d * SCALE_DEN + SCALE_NUM / 2) / SCALE_NUM;
        if (s < vx1) s = vx1;
        if (s > vx2) s = vx2;
        smap[d - dx1] = (int16_t)(s - vx1);            // index into the flush buffer row
    }

    int dy = dy1;
    while (dy <= dy2) {
        int rows = dy2 - dy + 1;
        if (rows > FLUSH_CHUNK_ROWS) rows = FLUSH_CHUNK_ROWS;
        for (int r = 0; r < rows; r++) {
            int s = OFF_Y + ((dy + r) * SCALE_DEN + SCALE_NUM / 2) / SCALE_NUM;
            if (s < vy1) s = vy1;
            if (s > vy2) s = vy2;
            const uint16_t *srow = src + (size_t)(s - vy1) * aw;
            uint16_t *drow = s_chunk + (size_t)r * PANEL_W;
            for (int d = dx1; d <= dx2; d++) drow[d - dx1] = srow[smap[d - dx1]];
        }
        esp_lcd_panel_draw_bitmap(s_panel, dx1, dy, dx2 + 1, dy + rows, s_chunk);
        // The chunk went onto the async queue; wait so s_chunk can be refilled for the next one.
        xSemaphoreTake(s_tx_done, portMAX_DELAY);
        dy += rows;
    }
    lv_display_flush_ready(disp);
}

// ── backlight ───────────────────────────────────────────────────────────────────────────────────────

void display_set_brightness_cores3(uint8_t level)
{
    cores3_backlight_set(level);   // AXP2101 DLDO1 — 0 = LDO off, 255 ≈ 3.3V
}
