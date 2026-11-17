// The running image's description on Linux (esp/esp.c): the build's PROJECT_VER and the device's project name, so the
// hello's `fw` is this build's version.
#pragma once

typedef struct {
    char version[32];
    char project_name[32];
} esp_app_desc_t;

const esp_app_desc_t *esp_app_get_description(void);
