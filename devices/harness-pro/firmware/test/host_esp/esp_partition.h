// Host-test stand-in for esp_partition.h (test_fw_update.c backs it with memory).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
typedef struct { uint32_t size; const char *label; } esp_partition_t;
esp_err_t esp_partition_read(const esp_partition_t *p, size_t off, void *dst, size_t n);
