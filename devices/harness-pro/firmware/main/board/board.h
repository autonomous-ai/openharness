// The board this image runs on. There is one: the Harness Pro, so nothing is probed at boot.
// `hello.hw` on the cable carries the name, so the daemon and its logs can tell the Pro.
#pragma once

#include <stdbool.h>

typedef enum { TOUCH_NONE = 0, TOUCH_GT911 } touch_chip_t;

typedef struct {
    const char  *name;          // goes up the cable in `hello.hw`, and into the boot log
    int          lcd_rst;       // ST7703 reset GPIO
    int          touch_rst;     // GT911 reset GPIO
    touch_chip_t touch;
    bool         touch_mirror;  // the GT911 reports panel-aligned on this board
    bool         has_pmic;      // an IP5306 answers battery and charge state
} board_t;

// Logs what the board is. Call early in app_main.
void board_detect(void);

// The constant table for the Pro; never NULL.
const board_t *board(void);

// One line, for the boot log and the daemon.
const char *board_describe(void);

// Was a factory reset asked for by holding a button through power-on? Never on the Pro: its only switch
// is the one that turns the board on, so it is by definition held at this moment.
bool board_factory_reset_requested(void);

// The module's Wi-Fi coprocessor (ESP32-C5) is unused: this firmware talks over the cable only. Drive its enable
// low so it stays in reset instead of running its own firmware.
void board_pro_hold_coprocessor(void);
