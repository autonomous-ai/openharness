/*
 * Harness Pro touch: opening a GT911 on the shared I2C bus.
 *
 * ⚠️ THE RESET SEQUENCE BELOW IS THE WHOLE POINT OF THIS FILE, and it is not a formality.
 *
 * A GT911 chooses its own I2C address from the level of its INT pin at the RISING EDGE of its RESET:
 * INT low picks 0x5D, INT high picks 0x14. So the pins have to be driven in one specific order, and the
 * order has to complete before anything probes the bus. Get it wrong — most easily by leaving INT
 * floating while reset is released — and the chip comes up at an address nobody is looking at, or does
 * not come up at all. The symptom is a touch controller that "is not on the bus", which sends you
 * looking at wiring that is fine.
 *
 * Because this is done by hand, the driver is then told GPIO_NUM_NC for its own reset pin. Given the
 * real pin it would pulse it again on open, with INT already switched to an input, and undo exactly the
 * choice made here.
 */
#include "touch.h"

#include "board_i2c.h"
#include "board_pins.h"

#include "driver/gpio.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "touch";

/* INT low → RESET low 20 ms → RESET high → 50 ms to settle → INT released to input.
 * The 20 ms and the 50 ms are the vendor's, and both matter: the first is the reset pulse the chip
 * needs to see, the second is how long it takes to read its own straps and answer on the bus. */
static void reset_into_primary_address(void)
{
    const gpio_config_t out = {
        .pin_bit_mask = (1ULL << BSP_TOUCH_RST) | (1ULL << BSP_TOUCH_INT),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&out);

    gpio_set_level(BSP_TOUCH_INT, 0);     /* the strap: low selects 0x5D */
    gpio_set_level(BSP_TOUCH_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(BSP_TOUCH_RST, 1);     /* the edge that latches the address */
    vTaskDelay(pdMS_TO_TICKS(50));

    const gpio_config_t in = {
        .pin_bit_mask = 1ULL << BSP_TOUCH_INT,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&in);
}

bool touch_ctrl_open(esp_lcd_panel_io_handle_t *out_io, esp_lcd_touch_handle_t *out_tp)
{
    reset_into_primary_address();

    i2c_master_bus_handle_t bus = board_i2c_get();
    if (!bus) {
        ESP_LOGW(TAG, "shared i2c bus unavailable — touch disabled");
        return false;
    }

    /* Which address answered is a FACT ABOUT THE BOARD, not a preference: the strap above should make it
     * 0x5D every time, so a board that answers on 0x14 means the sequence did not take and is worth a
     * line in the log rather than a silent fallback. */
    esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
    io_cfg.scl_speed_hz = BSP_I2C_FREQ_HZ;
    if (i2c_master_probe(bus, BSP_TOUCH_ADDR, 50) != ESP_OK) {
        if (i2c_master_probe(bus, BSP_TOUCH_ADDR_ALT, 50) != ESP_OK) {
            ESP_LOGW(TAG, "GT911 answered at neither 0x%02X nor 0x%02X — check the reset order",
                     BSP_TOUCH_ADDR, BSP_TOUCH_ADDR_ALT);
            return false;
        }
        ESP_LOGW(TAG, "GT911 came up at its backup address 0x%02X — the INT strap did not take",
                 BSP_TOUCH_ADDR_ALT);
        io_cfg.dev_addr = BSP_TOUCH_ADDR_ALT;
    }

    esp_lcd_panel_io_handle_t io = NULL;
    if (esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io) != ESP_OK) {
        ESP_LOGW(TAG, "touch panel io failed — touch disabled");
        return false;
    }

    const esp_lcd_touch_config_t cfg = {
        .x_max = BSP_LCD_H_RES,
        .y_max = BSP_LCD_V_RES,
        /* Both NC on purpose. Reset is done above and must not be repeated; the interrupt pin is read by
         * polling — an ISR buys nothing at 30 Hz.
         *
         * No mirror and no swap: confirmed on the glass, a touch on the top-left corner mark puts the
         * cursor on the top-left corner. */
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = GPIO_NUM_NC,
        .flags = { .swap_xy = 0, .mirror_x = 0, .mirror_y = 0 },
    };
    esp_lcd_touch_handle_t tp = NULL;
    if (esp_lcd_touch_new_i2c_gt911(io, &cfg, &tp) != ESP_OK) {
        ESP_LOGW(TAG, "GT911 init failed — touch disabled");
        esp_lcd_panel_io_del(io);
        return false;
    }

    ESP_LOGI(TAG, "GT911 @ 0x%02X · %dx%d", io_cfg.dev_addr, BSP_LCD_H_RES, BSP_LCD_V_RES);
    *out_io = io;
    *out_tp = tp;
    return true;
}
