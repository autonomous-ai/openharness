// Which board's pin map this image is built against.
//
// The two dials differ in things the I2C bus can be asked about — a touch controller, a reset pin,
// whether a PMIC answers — so they share one image and settle it at boot (board.h). The pin map below is
// the same for both.
//
// Every file includes board_pins.h, not pins_dial.h directly.
#pragma once

#include "pins_dial.h"
