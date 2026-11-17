// Harness Max entry point: board, panel, the lanes and the cable. The Pro's boot order, without its power latch (the
// Max is powered by its cable) and its side button (the Max has none).
//
//   BOOT -> display -> max_app (render task) -> touch -> USB cable link -> the daemon's agents -> the lanes
//
// The cable is the one way in: plugging the Max into a computer running the harness daemon IS the authorization, and
// everything on the glass arrives over that wire. Without a daemon the room says "Waiting for the computer".
#include <stdbool.h>
#include <stdint.h>

#include "app/max_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "board/board.h"
#include "cable/pro_cable.h"
#include "max_i2c.h"
#include "pro_app_api.h"
#include "pro_display.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"
#include "sys/last_words.h"
#include "sys/ram_telemetry.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app";

void app_main(void)
{
    board_max_hold_coprocessor();   // the unused C6 stays in reset from the first instant
    ram_telemetry_checkpoint("boot");
    last_words_boot();   // before the first log line, so the previous boot's ring is read, not overwritten
    board_detect();
    config_store_init();

    // One I2C bus carries the touch controller, the codec and the display board's MCU, which powers the panel. The
    // panel driver opens port 1 itself and reuses a bus that is already there, so the bus comes up first.
    if (!max_i2c_bus()) ESP_LOGE(TAG, "I2C bus did not come up: the panel cannot be powered");

    pro_display_init();
    pro_voice_init();    // the PSRAM ring and the microphone, while the heap is unfragmented
    audio_beep_init();   // the ES8311's speaker half, for the notification beep
    pro_app_start();     // the render task; the room waits for the computer until the daemon says hello
    pro_touch_start();
    ram_telemetry_checkpoint("ui_ready");

    // The callbacks pro_cable makes are max_app's, so the app is up first.
    pro_cable_start();
    ram_telemetry_checkpoint("app_ready");

    // A freshly installed image is confirmed by fw_confirm_* (sys/fw_update.h): never before the first frame, then after
    // 60 s up with a 30 s cable session (or 180 s up without). One that never paints is reverted at once.
    if (pro_app_wait_first_frame(10000)) {
        fw_confirm_frame_painted();
        while (fw_confirm_pending()) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            if (fw_confirm_tick((uint32_t)(esp_timer_get_time() / 1000))) pro_app_note_update();
        }
    } else {
        ESP_LOGE(TAG, "no first frame in 10 s: this image is not confirmed");
        fw_no_frame();
    }

    vTaskDelete(NULL);
}
