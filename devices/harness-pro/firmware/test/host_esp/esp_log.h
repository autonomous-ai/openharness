// Host-test stand-in for esp_log.h: logging is dropped, but the arguments are still compiled and the format is checked.
#pragma once
#include <stdio.h>
#define ESP_LOGE(tag, ...) ((void)(tag), (void)(0 && printf(__VA_ARGS__)))
#define ESP_LOGW(tag, ...) ((void)(tag), (void)(0 && printf(__VA_ARGS__)))
#define ESP_LOGI(tag, ...) ((void)(tag), (void)(0 && printf(__VA_ARGS__)))
#define ESP_LOGD(tag, ...) ((void)(tag), (void)(0 && printf(__VA_ARGS__)))
#include <stdarg.h>
typedef int (*vprintf_like_t)(const char *, va_list);
vprintf_like_t esp_log_set_vprintf(vprintf_like_t func);
