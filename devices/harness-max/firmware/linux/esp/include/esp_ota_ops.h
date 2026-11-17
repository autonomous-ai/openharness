// OTA on Linux (esp/esp.c): no running or next slot, so fw_update.c refuses every offer ("no update slot") and never
// reaches the writes, which fail if it did. A Linux build is updated by building it again.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_partition.h"

typedef uint32_t esp_ota_handle_t;
typedef enum {
    ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, ESP_OTA_IMG_VALID, ESP_OTA_IMG_INVALID, ESP_OTA_IMG_ABORTED,
    ESP_OTA_IMG_UNDEFINED = -1,
} esp_ota_img_states_t;
#define OTA_WITH_SEQUENTIAL_WRITES 0xfffffffe

const esp_partition_t *esp_ota_get_running_partition(void);
const esp_partition_t *esp_ota_get_next_update_partition(const esp_partition_t *start);
esp_err_t esp_ota_get_state_partition(const esp_partition_t *p, esp_ota_img_states_t *state);
esp_err_t esp_ota_get_partition_description(const esp_partition_t *p, esp_app_desc_t *desc);
esp_err_t esp_ota_mark_app_valid_cancel_rollback(void);
esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot(void);
esp_err_t esp_ota_begin(const esp_partition_t *p, size_t image_size, esp_ota_handle_t *handle);
esp_err_t esp_ota_write(esp_ota_handle_t handle, const void *data, size_t size);
esp_err_t esp_ota_end(esp_ota_handle_t handle);
esp_err_t esp_ota_abort(esp_ota_handle_t handle);
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *p);
