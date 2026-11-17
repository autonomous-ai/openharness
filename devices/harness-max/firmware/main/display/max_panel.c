#include "max_panel.h"

#include "max_i2c.h"
#include "pins_max.h"

#include "esp_check.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_ota7290b.h"
#include "esp_lcd_panel_ops.h"
#include "esp_ldo_regulator.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "max_panel";

static esp_ldo_channel_handle_t  s_phy_pwr;
static esp_lcd_dsi_bus_handle_t  s_bus;
static esp_lcd_panel_io_handle_t s_io;

// The backlight is a register of the display board's MCU. The render task (sleep, wake) and the cable task (the
// brightness setting) both move it, so the kept level, the on flag and the write go together under one lock.
static i2c_master_dev_handle_t s_mcu;
static SemaphoreHandle_t       s_light;
static uint8_t                 s_level = 255;
static bool                    s_on = true;

static void write_level(uint8_t level)   // under s_light
{
    const uint8_t cmd[2] = {MAX_DISP_REG_LEVEL, level};
    const esp_err_t err = i2c_master_transmit(s_mcu, cmd, sizeof cmd, 50);
    if (err != ESP_OK) ESP_LOGW(TAG, "backlight %u not set: %s", level, esp_err_to_name(err));
}

void max_backlight_set(uint8_t level)
{
    xSemaphoreTake(s_light, portMAX_DELAY);
    s_level = level;
    if (s_on) write_level(level);
    xSemaphoreGive(s_light);
}

void max_backlight_enable(bool on)
{
    xSemaphoreTake(s_light, portMAX_DELAY);
    if (on != s_on) {
        s_on = on;
        write_level(on ? s_level : 0);
    }
    xSemaphoreGive(s_light);
}

esp_err_t max_panel_open(esp_lcd_panel_handle_t *out_panel)
{
    ESP_RETURN_ON_FALSE(out_panel, ESP_ERR_INVALID_ARG, TAG, "out_panel");
    s_light = xSemaphoreCreateMutex();
    ESP_RETURN_ON_FALSE(s_light, ESP_ERR_NO_MEM, TAG, "backlight lock");

    // The panel's power is the display board's MCU, on I2C: no bus, no picture. The driver below reuses this bus.
    i2c_master_bus_handle_t i2c = max_i2c_bus();
    ESP_RETURN_ON_FALSE(i2c, ESP_ERR_INVALID_STATE, TAG, "no I2C bus for the display board's MCU");
    const i2c_device_config_t mcu = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = MAX_DISP_MCU_ADDR,
        .scl_speed_hz = MAX_DISP_MCU_I2C_HZ,
    };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(i2c, &mcu, &s_mcu), TAG, "display MCU at 0x%02X", MAX_DISP_MCU_ADDR);

    /* The DSI PHY runs off an internal LDO, and it has to be up before the bus is created. Getting this wrong does not
     * fail loudly: the bus is created and the panel simply never lights. */
    const esp_ldo_channel_config_t ldo = {
        .chan_id = MAX_LCD_DSI_PHY_LDO_CHAN,
        .voltage_mv = MAX_LCD_DSI_PHY_LDO_MV,
    };
    ESP_RETURN_ON_ERROR(esp_ldo_acquire_channel(&ldo, &s_phy_pwr), TAG, "DSI PHY LDO (VO%d) refused",
                        MAX_LCD_DSI_PHY_LDO_CHAN);

    esp_lcd_dsi_bus_config_t bus = OTA7290B_PANEL_BUS_DSI_2CH_CONFIG();   // 2 lanes at 1300 Mbps
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus, &s_bus), TAG, "dsi bus");

    esp_lcd_dbi_io_config_t dbi = OTA7290B_PANEL_IO_DBI_CONFIG();
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(s_bus, &dbi, &s_io), TAG, "dbi io");

    // 480 x 1920 at a 75 MHz pixel clock. ONE framebuffer: the renderer pushes turned bands with draw_bitmap, so the
    // pixels are copied in rather than swapped (as on the Pro).
    esp_lcd_dpi_panel_config_t dpi = OTA7290B_480_1920_PANEL_60HZ_DPI_CONFIG(LCD_COLOR_PIXEL_FORMAT_RGB565);
    dpi.num_fbs = 1;

    const ota7290b_vendor_config_t vendor = {
        .mipi_config = { .dsi_bus = s_bus, .dpi_config = &dpi },
    };
    const esp_lcd_panel_dev_config_t dev = {
        .reset_gpio_num = -1,   // no reset line: the panel's reset is its power, through the MCU
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = MAX_LCD_BIT_PER_PIXEL,
        .vendor_config = (void *)&vendor,
    };
    // Powers the display board (0x95: 0x11, 0x17), turns its light full on (0x96: 0x00, then 0xFF) and waits 1 s.
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_ota7290b(s_io, &dev, out_panel), TAG, "ota7290b");
    // Dark until the caller has a picture to show: an unstarted panel is not one.
    xSemaphoreTake(s_light, portMAX_DELAY);
    write_level(0);
    xSemaphoreGive(s_light);
    // No esp_lcd_panel_reset: without a reset line it is a software reset the vendor's BSP does not send either.
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(*out_panel), TAG, "panel init");
    return ESP_OK;
}
