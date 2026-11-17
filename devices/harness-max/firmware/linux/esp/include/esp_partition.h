// Flash partitions on Linux (esp/esp.c): there are none, so fw_update.c finds no slot and refuses every image.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    uint32_t size;
    const char *label;
} esp_partition_t;

esp_err_t esp_partition_read(const esp_partition_t *p, size_t offset, void *dst, size_t size);
