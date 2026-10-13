// Host-test stand-in for ESP-IDF's esp_app_desc.h (test_pro_cable.c / test_fw_update.c define the function).
#pragma once
typedef struct { char version[32]; char project_name[32]; } esp_app_desc_t;
const esp_app_desc_t *esp_app_get_description(void);
