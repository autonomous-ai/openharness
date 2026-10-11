/*
 * The Pro's board table. The Pro is a different SoC from any earlier device, so an image built for it cannot
 * be running on anything else: there is nothing to probe and the table is a constant.
 */
#include "board.h"
#include "board_pins.h"

#include "driver/gpio.h"
#include "esp_log.h"

static const board_t s_pro = {
    .name = "harness-pro",
    .lcd_rst = BSP_LCD_RST,
    .touch_rst = BSP_TOUCH_RST,
    .touch = TOUCH_GT911,
    /* The GT911 reports panel-aligned on this board — confirmed on the glass: a touch on the top-left
     * corner mark moves the cursor to the top-left corner. */
    .touch_mirror = false,
    /* An IP5306, not an AXP2101. It answers battery percentage and charge state the same way as far as
     * the UI is concerned, which is what this flag gates. */
    .has_pmic = true,
};

void board_detect(void)
{
    ESP_LOGI("board", "%s", board_describe());
}

void board_pro_hold_coprocessor(void)
{
    // Low is reset (the line is the C5's enable; esp_hosted's "active high" pulses high-low-high). Level first, so the
    // pin never drives high for a moment as it becomes an output.
    gpio_set_level(BSP_C5_RESET, 0);
    const gpio_config_t cfg = {.pin_bit_mask = 1ULL << BSP_C5_RESET, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&cfg);
}

const board_t *board(void) { return &s_pro; }

const char *board_describe(void)
{
    return "board=harness-pro touch=gt911 pmic=ip5306 lcd=st7703/720x720";
}

/*
 * Never. There is no button this could read.
 *
 * The Pro's only switch is its power button, and pressing it is how the board got here — at the moment
 * app_main asks this question the button is, by construction, still down. Reading it would factory-reset
 * the device on every single power-on. A reset gesture for this board has to be something else (a touch
 * held through boot, say) and is not invented here.
 */
bool board_factory_reset_requested(void) { return false; }
