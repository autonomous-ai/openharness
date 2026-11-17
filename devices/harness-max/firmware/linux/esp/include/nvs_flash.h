// NVS on Linux (esp/nvs.c): the device's settings live in a file, ${XDG_CONFIG_HOME:-~/.config}/harness-max/nvs.
#pragma once

#include "esp_err.h"

// Reads the file. A missing or unreadable one is an empty store, as a new device's: never an error.
esp_err_t nvs_flash_init(void);
// Empties the store and deletes the file.
esp_err_t nvs_flash_erase(void);
