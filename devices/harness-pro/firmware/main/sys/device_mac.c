#include "device_mac.h"

#include <stdio.h>
#include <string.h>

#include "esp_mac.h"
#include "esp_log.h"

static const char *TAG = "mac";

bool device_mac_str(char *out, size_t cap)
{
    if (!out || cap < DEVICE_MAC_STR_LEN) return false;
    out[0] = '\0';

    uint8_t mac[6] = { 0 };
    // ESP_MAC_BASE — the chip's own factory address, and the one identifier this firmware has that is
    // stable, unique and needs no pairing. It is what the daemon uses to tell one device from another
    // before a byte of protocol is exchanged.
    //
    // It used to ask for ESP_MAC_WIFI_STA, which on the dial is the same value. On the Pro it is not a
    // value at all: the ESP32-P4 has no radio of its own (its Wi-Fi lives in a coprocessor this firmware
    // never wakes), so that read fails with ESP_ERR_NOT_FOUND and the hello went out carrying "mac":"".
    esp_err_t err = esp_read_mac(mac, ESP_MAC_BASE);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_read_mac failed: %d", (int)err);
        return false;
    }
    snprintf(out, cap, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return true;
}
