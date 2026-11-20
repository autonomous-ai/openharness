// Harness Max on the desk Harness Pro: the Max's boot (../../main/app_main.c) on the Pro's board, with the Pro's power
// latch and coprocessor duties first (the Pro's app_main.c), and no side button (the Max has none).
//
// The image is never confirmed: it is loaded into the Pro's spare slot on trial (README.md), so any reset, the Pro's
// power cycled included, rolls the Pro back to its own firmware. One that never paints is reverted at once.
#include <stdbool.h>
#include <stdint.h>

#include "app/max_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "board/board.h"
#include "board/board_i2c.h"
#include "board/power.h"
#include "board_on_pro.h"
#include "cable/pro_cable.h"
#include "pro_app_api.h"
#include "pro_display.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"
#include "sys/last_words.h"
#include "sys/ram_telemetry.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app";

void app_main(void)
{
    // Dock-only, as the Pro: the battery supply stays off (power_pro.c), before logging, NVS, display or I2C.
    power_hold_init();
    board_on_pro_hold_coprocessor();   // the unused C5 stays in reset from the first instant
    ram_telemetry_checkpoint("boot");
    last_words_boot();   // before the first log line, so the previous boot's ring is read, not overwritten
    board_detect();
    power_init();
    config_store_init();

    // The shared I2C bus carries the touch controller and both codecs; the GT911's own reset is done inside
    // pro_display_init(), before its driver opens.
    if (!board_i2c_get()) ESP_LOGE(TAG, "shared I2C bus did not come up; touch will stay off");

    pro_display_init();
    pro_voice_init();    // the PSRAM ring and the microphones, while the heap is unfragmented
    audio_beep_init();   // the ES8311's speaker, for the chimes (chime_on_pro.c)
    pro_app_start();     // the render task; the room waits for the computer until the daemon says hello
    pro_touch_start();
    ram_telemetry_checkpoint("ui_ready");

    // The callbacks pro_cable makes are max_app's, so the app is up first.
    pro_cable_start();
    ram_telemetry_checkpoint("app_ready");

    if (!pro_app_wait_first_frame(10000)) {
        ESP_LOGE(TAG, "no first frame in 10 s: back to the Pro's own firmware");
        fw_no_frame();
    }
    ESP_LOGW(TAG, "on trial in the Pro's spare slot, never confirmed: a reset goes back to the Pro's firmware");
    vTaskDelete(NULL);
}
