// Host-test stand-in for esp_random.h (the test defines the function).
#pragma once
#include <stdint.h>
uint32_t esp_random(void);
