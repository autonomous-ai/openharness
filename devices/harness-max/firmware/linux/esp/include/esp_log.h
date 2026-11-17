// ESP_LOG* on Linux (esp/esp.c): one line on stderr in the device console's format, which systemd puts in the journal.
// Debug lines are compiled, so their format is checked, and dropped, as at the device's INFO level.
#pragma once

void esp_log_line(char level, const char *tag, const char *fmt, ...) __attribute__((format(printf, 3, 4)));

#define ESP_LOGE(tag, ...) esp_log_line('E', tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) esp_log_line('W', tag, __VA_ARGS__)
#define ESP_LOGI(tag, ...) esp_log_line('I', tag, __VA_ARGS__)
#define ESP_LOGD(tag, ...) do { if (0) esp_log_line('D', tag, __VA_ARGS__); } while (0)
