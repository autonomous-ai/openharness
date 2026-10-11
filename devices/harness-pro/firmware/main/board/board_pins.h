// The Pro's pin map. Every file keeps including board_pins.h; nothing includes pins_pro.h directly.
#pragma once

#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32P4)
#error "this firmware builds for the ESP32-P4 only"
#endif

#include "pins_pro.h"
