// NVS on Linux (esp/nvs.c): ESP-IDF's calls, codes and limits, over one file. Only the types the shared sources store:
// strings and u8.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define ESP_ERR_NVS_BASE 0x1100
#define ESP_ERR_NVS_NOT_FOUND (ESP_ERR_NVS_BASE + 0x02)
#define ESP_ERR_NVS_TYPE_MISMATCH (ESP_ERR_NVS_BASE + 0x03)
#define ESP_ERR_NVS_READ_ONLY (ESP_ERR_NVS_BASE + 0x04)
#define ESP_ERR_NVS_NOT_ENOUGH_SPACE (ESP_ERR_NVS_BASE + 0x05)
#define ESP_ERR_NVS_INVALID_NAME (ESP_ERR_NVS_BASE + 0x06)
#define ESP_ERR_NVS_INVALID_HANDLE (ESP_ERR_NVS_BASE + 0x07)
#define ESP_ERR_NVS_NO_FREE_PAGES (ESP_ERR_NVS_BASE + 0x0d)
#define ESP_ERR_NVS_VALUE_TOO_LONG (ESP_ERR_NVS_BASE + 0x0e)
#define ESP_ERR_NVS_INVALID_LENGTH (ESP_ERR_NVS_BASE + 0x0c)
#define ESP_ERR_NVS_NEW_VERSION_FOUND (ESP_ERR_NVS_BASE + 0x10)

typedef uint32_t nvs_handle_t;
typedef enum { NVS_READONLY, NVS_READWRITE } nvs_open_mode_t;

esp_err_t nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *out);
void nvs_close(nvs_handle_t handle);
esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out);
esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value);
esp_err_t nvs_get_str(nvs_handle_t handle, const char *key, char *out, size_t *length);
esp_err_t nvs_set_str(nvs_handle_t handle, const char *key, const char *value);
// Writes the file (a new one renamed over the old, so a crash leaves one whole file).
esp_err_t nvs_commit(nvs_handle_t handle);
