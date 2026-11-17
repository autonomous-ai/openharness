// The device's factory MAC on Linux (esp/esp.c): a locally administered address made from the host name, stable per
// machine, which is what the daemon tells devices apart by.
#pragma once

#include <stdint.h>

#include "esp_err.h"

typedef enum { ESP_MAC_BASE } esp_mac_type_t;

esp_err_t esp_read_mac(uint8_t *mac, esp_mac_type_t type);
