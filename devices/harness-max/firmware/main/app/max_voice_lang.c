// Harness Max's voice language before anyone chooses one (max_voice_lang.h).
//
// pro_fork relies on: devices/harness-pro/firmware/main/sys/config_store.c
// pro_fork blob: e515b45bdad252fab787565cbc72c9c6d8325e71 (main 91f60b6a7b)
// scripts/check_pro_forks.py fails once it is no longer that blob: check that the language is still the string "vlang"
// in the namespace "pair" (config_load_voicelang), then record its new blob on these lines and in
// main/pro_fork/upstream.txt.
#include "app/max_voice_lang.h"

#include <stddef.h>

#include "esp_log.h"
#include "nvs.h"
#include "sys/config_store.h"

static const char *TAG = "max_lang";

bool max_voice_lang_default(void)
{
    // Saved means the key is there, whatever it says: config_load_voicelang cannot tell a saved "en" from none.
    nvs_handle_t h;
    size_t len = 0;
    bool saved = false;
    if (nvs_open("pair", NVS_READONLY, &h) == ESP_OK) {
        saved = nvs_get_str(h, "vlang", NULL, &len) == ESP_OK && len > 1;
        nvs_close(h);
    }
    if (saved) return false;
    if (!config_save_voicelang(MAX_VOICE_LANG_DEFAULT)) {   // English for this run; the next boot tries again
        ESP_LOGW(TAG, "could not save the default voice language");
        return false;
    }
    ESP_LOGI(TAG, "voice language: %s (no language was saved)", MAX_VOICE_LANG_DEFAULT);
    return true;
}
