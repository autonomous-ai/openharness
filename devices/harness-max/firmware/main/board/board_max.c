// Harness Max's board table. One board, so the table is a constant.
#include "board.h"
#include "pins_max.h"

#include "driver/gpio.h"
#include "esp_log.h"

static const board_t s_max = {
    .name = "harness-max",
    .kind = "max",
};

void board_detect(void)
{
    ESP_LOGI("board", "board=%s touch=gt9271 lcd=ota7290b/480x1920 audio=es8311", s_max.name);
}

void board_max_hold_coprocessor(void)
{
    // Level first, so the pin never drives high for a moment as it becomes an output.
    gpio_set_level(MAX_C6_RESET, 0);
    const gpio_config_t cfg = {.pin_bit_mask = 1ULL << MAX_C6_RESET, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&cfg);
}

const board_t *board(void) { return &s_max; }
