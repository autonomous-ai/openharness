#pragma once
// Where Pod's big scratch buffers live. On the device EXT_RAM_BSS_ATTR puts a static in PSRAM, which keeps tens of
// KB of internal RAM free; the host has one memory, so it is empty there.
#ifdef ESP_PLATFORM
#include "esp_attr.h"
#else
#define EXT_RAM_BSS_ATTR
#endif
