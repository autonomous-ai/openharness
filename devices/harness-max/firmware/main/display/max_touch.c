#include "max_touch.h"

#include "max_i2c.h"
#include "pins_max.h"

#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"

static const char *TAG = "touch";

bool max_touch_open(esp_lcd_panel_io_handle_t *out_io, esp_lcd_touch_handle_t *out_tp)
{
    i2c_master_bus_handle_t bus = max_i2c_bus();
    if (!bus) {
        ESP_LOGW(TAG, "I2C bus unavailable: touch off");
        return false;
    }

    /* Unlike the Pro's GT911, the GT9271's INT and RST never reach the P4: nothing here can choose its address. It is
     * whatever the chip latched at power-on, so ask at both. */
    esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
    io_cfg.scl_speed_hz = MAX_I2C_HZ;
    if (i2c_master_probe(bus, MAX_TOUCH_ADDR, 50) == ESP_OK) {
        io_cfg.dev_addr = MAX_TOUCH_ADDR;
    } else if (i2c_master_probe(bus, MAX_TOUCH_ADDR_ALT, 50) == ESP_OK) {
        io_cfg.dev_addr = MAX_TOUCH_ADDR_ALT;
    } else {
        ESP_LOGW(TAG, "GT9271 answered at neither 0x%02X nor 0x%02X", MAX_TOUCH_ADDR, MAX_TOUCH_ADDR_ALT);
        return false;
    }

    esp_lcd_panel_io_handle_t io = NULL;
    if (esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io) != ESP_OK) {
        ESP_LOGW(TAG, "touch panel io failed: touch off");
        return false;
    }

    // The panel's portrait frame, as the controller reports it: no swap, no mirror here. The one turn to the glass is
    // max_turn_touch, the inverse of the picture's turn, so a flip of the picture flips the finger with it.
    const esp_lcd_touch_config_t cfg = {
        .x_max = MAX_LCD_H_RES,
        .y_max = MAX_LCD_V_RES,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = GPIO_NUM_NC,
        .flags = { .swap_xy = 0, .mirror_x = 0, .mirror_y = 0 },
    };
    esp_lcd_touch_handle_t tp = NULL;
    if (esp_lcd_touch_new_i2c_gt911(io, &cfg, &tp) != ESP_OK) {
        ESP_LOGW(TAG, "GT9271 init failed: touch off");
        esp_lcd_panel_io_del(io);
        return false;
    }

    ESP_LOGI(TAG, "GT9271 @ 0x%02X, %dx%d portrait", io_cfg.dev_addr, MAX_LCD_H_RES, MAX_LCD_V_RES);
    *out_io = io;
    *out_tp = tp;
    return true;
}
