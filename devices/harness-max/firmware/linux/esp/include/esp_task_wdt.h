// The task watchdog on Linux: none. A crashed program ends and its supervisor (systemd) starts it again.
#pragma once

#include "esp_err.h"
#include "freertos/task.h"

static inline esp_err_t esp_task_wdt_add(TaskHandle_t task) { (void)task; return ESP_OK; }
static inline esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }
