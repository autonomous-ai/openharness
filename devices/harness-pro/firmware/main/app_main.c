// Harness Pro entry point: power latch, board, panel, Pod and the cable.
//
//   BOOT -> display -> pro_app (render task) -> touch -> USB cable link -> the daemon's agents and tabs -> Pod
//
// The cable is the one way in: plugging the Pro into a computer running the harness daemon IS the authorization,
// and everything on the glass arrives over that wire. Without a daemon the Pro shows "Not connected".
#include <stdbool.h>
#include <stdint.h>

#include "app/pro_app.h"
#include "app/pro_touch.h"
#include "board.h"
#include "ptt_pro.h"
#include "board_i2c.h"
#include "cable/pro_cable.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "config_store.h"
#include "last_words.h"
#include "power.h"
#include "pro_display.h"
#include "ram_telemetry.h"
#include "sys/fw_update.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app";

void app_main(void)
{
    // Dock-only: the board's analog power latch is never held. power_hold_init drives PWR_HOLD low (and USB powers
    // the board), so the battery supply stays off. Take over the supply policy before logging, NVS, display or I2C.
    power_hold_init();
    board_pro_hold_coprocessor();   // the unused C5 stays in reset from the first instant
    ram_telemetry_checkpoint("boot");
    last_words_boot();   // before the first log line, so the previous boot's ring is read, not overwritten
    board_detect();
    power_init();
    config_store_init();

    // The shared I2C bus carries the touch controller and both codecs. The GT911's own reset (which also
    // picks its I2C address) is done by hand inside pro_display_init(), before its driver opens.
    if (!board_i2c_get()) ESP_LOGE(TAG, "shared I2C bus did not come up; touch will stay off");

    pro_display_init();
    pro_voice_init();    // the PSRAM ring and the microphone, while the heap is unfragmented
    audio_beep_init();   // the ES8311 speaker for the notification beep
    pro_app_start();     // the render task; Pod shows "Connecting" until the daemon says hello
    pro_touch_start();
    // The side button, after the microphone and the app are up (as the round firmware started its button after the
    // codec): a press goes home or wakes the screen, a 0.8 s hold toggles screen sleep.
    ptt_set_handlers(&(const ptt_handlers_t){.on_press = pro_app_button_press, .on_hold = pro_app_button_hold});
    ptt_start();
    ram_telemetry_checkpoint("ui_ready");

    // The callbacks pro_cable makes are pro_app's, so the app is up first.
    pro_cable_start();
    ram_telemetry_checkpoint("app_ready");

    // A freshly installed image is confirmed by fw_confirm_* (sys/fw_update.h): never before the first frame, then at the first
    // cable session (pro_cable) or at 60 s up, whichever comes first. One that never paints is reverted at once.
    if (pro_app_wait_first_frame(10000)) {
        if (fw_confirm_frame_painted()) pro_app_note_update();
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
