// Host-test stand-in for esp_timer.h (test_pro_cable.c defines the clock).
#pragma once
#include <stdint.h>
int64_t esp_timer_get_time(void);
