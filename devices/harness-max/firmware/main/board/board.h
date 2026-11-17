// The board this image runs on: the Harness Max bring-up board (pins_max.h). There is one, so nothing is probed.
// pro_cable.c, compiled from the Pro's tree, reads this header for the hello: `hw` is the name, `board` the kind.
#pragma once

typedef struct {
    const char *name;   // `hello.hw` and the boot log: "harness-max"
    const char *kind;   // `hello.board`: which of the daemon's per-board rules apply ("max")
} board_t;

// Logs what the board is. Call early in app_main.
void board_detect(void);

// The constant table; never NULL.
const board_t *board(void);

// The NANO's ESP32-C6 is its Wi-Fi coprocessor and this firmware talks over the cable only: drive its enable low so
// it stays in reset instead of running its own firmware.
void board_max_hold_coprocessor(void);
