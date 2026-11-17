// esp_timer_get_time on Linux (esp/esp.c): microseconds on the monotonic clock since the program started, as the
// device counts them since boot.
#pragma once

#include <stdint.h>

int64_t esp_timer_get_time(void);
