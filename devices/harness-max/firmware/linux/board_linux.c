// The board table of a Linux build, behind Max's board/board.h. The hello's `hw` names it apart from the ESP32-P4 bar,
// so the daemon has no firmware image for it (cli fwPush.ts); `board` is "max", so the daemon treats it as Harness Max.
// Everything else in the hello is the device's.
#include "board/board.h"

#include "esp_log.h"

static const board_t s_linux = {
    .name = "harness-max-linux",
    .kind = "max",
};

void board_detect(void) { ESP_LOGI("board", "board=%s output=%s", s_linux.name, MAX_LINUX_OUTPUT_NAME); }

const board_t *board(void) { return &s_linux; }
