// The board table of Harness Max on a Harness Pro. To the daemon it is a Max (`hw` "harness-max", `board` "max"), so
// it gets the Max's frames and rules; its `-dev` version keeps it from ever being offered an image.
#include "board/board.h"
#include "board_on_pro.h"
#include "board_pins.h"

#include "driver/gpio.h"
#include "esp_log.h"

static const board_t s_board = {
    .name = "harness-max",
    .kind = "max",
};

void board_detect(void)
{
    ESP_LOGI("board", "board=%s on a harness-pro: lcd=st7703/720x720 (the glass in a 720x180 band) touch=gt911 "
             "audio=es7210+es8311", s_board.name);
}

const board_t *board(void) { return &s_board; }

void board_on_pro_hold_coprocessor(void)
{
    // Level first, so the pin never drives high for a moment as it becomes an output (board_pro.c).
    gpio_set_level(BSP_C5_RESET, 0);
    const gpio_config_t cfg = {.pin_bit_mask = 1ULL << BSP_C5_RESET, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&cfg);
}
