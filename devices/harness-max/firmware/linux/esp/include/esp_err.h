// ESP-IDF's error codes on Linux (esp/esp.c), with the values ESP-IDF gives them, so a logged code reads the same.
#pragma once

#include <stdlib.h>

typedef int esp_err_t;

#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_NOT_FOUND 0x105
#define ESP_ERR_NOT_SUPPORTED 0x106

const char *esp_err_to_name(esp_err_t err);
void esp_error_check_failed(esp_err_t err, const char *file, int line, const char *expr);

// As on the device: a call that must not fail stops the program, with the code and the place in the log.
#define ESP_ERROR_CHECK(x)                                                           \
    do {                                                                             \
        const esp_err_t err_rc_ = (x);                                               \
        if (err_rc_ != ESP_OK) esp_error_check_failed(err_rc_, __FILE__, __LINE__, #x); \
    } while (0)
