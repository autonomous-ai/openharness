// Host-test stand-in for esp_task_wdt.h and the esp_err.h bits that come with it.
#pragma once
#include <stdlib.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERROR_CHECK(x) do { if ((x) != ESP_OK) abort(); } while (0)
esp_err_t esp_task_wdt_add(void *task);
esp_err_t esp_task_wdt_reset(void);
