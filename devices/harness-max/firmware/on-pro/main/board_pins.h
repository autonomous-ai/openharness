// The Pro's pin map for the Pro's drivers this image compiles where they are (CMakeLists.txt): they include
// "board_pins.h", which in the Pro's tree is beside them in board/, a directory a Max build keeps off its path (it has a
// board.h of its own). This is that header: the Pro's pins_pro.h, read where it is.
#pragma once

#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32P4)
#error "this firmware builds for the ESP32-P4 only"
#endif

#include "board/pins_pro.h"
