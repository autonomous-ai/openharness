// Harness Max as a Linux program: the device's boot order (main/app_main.c) over the Linux drivers, with the cable's far
// end chosen on the command line. The output is a build choice (MAX_LINUX_OUTPUT).
//
//   harness-max [--live [--port N] | --usb [PORT] | --demo] [--screenshot SECONDS FILE.bmp]
//
// --live (the default): a real daemon dials in over TCP (HARNESS_CABLE_TCP=host:7531). --usb: a real daemon over the
// USB cable, through the serial port of the gadget orangepi/harness-max-usb makes (/dev/ttyGS0). --demo: the scripted
// daemon in main/demo runs inside the program. --screenshot (the SDL window only): save the glass after SECONDS, then
// quit.
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app/max_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "board/board.h"
#include "cable/cable_linux.h"
#include "cable/pro_cable.h"
#include "max_output.h"
#include "pro_display.h"
#include "sys/config_store.h"
#include "sys/last_words.h"
#include "sys/ram_telemetry.h"
#include "terminal.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app";

// app_main's order, without the board's coprocessor and I2C bus (none here) and the image confirmation (a Linux build
// is never installed over the cable, so there is nothing to confirm).
static void boot(void *arg)
{
    (void)arg;
    ram_telemetry_checkpoint("boot");
    last_words_boot();
    board_detect();
    config_store_init();
    pro_display_init();
    pro_voice_init();
    audio_beep_init();
    pro_app_start();
    pro_touch_start();
    ram_telemetry_checkpoint("ui_ready");
    pro_cable_start();
    ram_telemetry_checkpoint("app_ready");
    if (pro_app_wait_first_frame(10000)) ESP_LOGI(TAG, "first frame at %lld ms", (long long)(esp_timer_get_time() / 1000));
    else ESP_LOGE(TAG, "no first frame in 10 s");
    vTaskDelete(NULL);
}

static int usage(void)
{
    fprintf(stderr, "usage: harness-max [--live [--port N] | --usb [PORT] | --demo]%s\n",
#ifdef MAX_OUTPUT_SDL
            " [--screenshot SECONDS FILE.bmp]"
#else
            ""
#endif
    );
    return 2;
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--demo")) {
            cable_linux_use_demo();
        } else if (!strcmp(argv[i], "--live")) {
            cable_linux_use_tcp(CABLE_LINUX_PORT);
        } else if (!strcmp(argv[i], "--usb")) {
            const bool named = i + 1 < argc && strncmp(argv[i + 1], "--", 2) != 0;
            cable_linux_use_usb(named ? argv[++i] : CABLE_LINUX_USB_PORT, NULL);
        } else if (!strcmp(argv[i], "--port") && i + 1 < argc) {
            const int port = atoi(argv[++i]);
            if (port <= 0 || port > 65535) return usage();
            cable_linux_use_tcp(port);
#ifdef MAX_OUTPUT_SDL
        } else if (!strcmp(argv[i], "--screenshot") && i + 2 < argc) {
            const int seconds = atoi(argv[++i]);
            if (seconds <= 0) return usage();
            max_output_screenshot((uint32_t)seconds * 1000, argv[++i]);
#endif
        } else {
            return usage();
        }
    }
    signal(SIGPIPE, SIG_IGN);   // a daemon that hangs up mid-write is a failed send, not the end of the program
    if (!max_output_open(HT_WIDTH, HT_HEIGHT)) return 1;
    TaskHandle_t task;
    if (xTaskCreate(boot, "main", 16384, NULL, 1, &task) != pdPASS) return 1;
    max_output_run();
}
