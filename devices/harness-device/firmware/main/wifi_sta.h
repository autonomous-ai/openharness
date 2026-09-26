// CoreS3 STA: scan, join, remember. No SoftAP, no cable-over-TCP yet.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define WIFI_STA_SSID_MAX 33
#define WIFI_STA_PASS_MAX 65
#define WIFI_STA_AP_MAX   16

typedef enum {
    WIFI_STA_OFF = 0,
    WIFI_STA_IDLE,
    WIFI_STA_SCANNING,
    WIFI_STA_CONNECTING,
    WIFI_STA_CONNECTED,
    WIFI_STA_FAILED,
} wifi_sta_state_t;

typedef struct {
    char ssid[WIFI_STA_SSID_MAX];
    int8_t rssi;
    bool open;
} wifi_sta_ap_t;

void wifi_sta_init(void);

wifi_sta_state_t wifi_sta_state(void);
const char *wifi_sta_ssid(void);
const char *wifi_sta_ip(void);
int wifi_sta_rssi(void);   // dBm while connected, else -127

// Last completed scan. Returns count written to `out`.
int wifi_sta_copy_scan(wifi_sta_ap_t *out, int max);

// Queue work for wifi_sta_service() (runs on refresh_task, not LVGL).
void wifi_sta_request_scan(void);
void wifi_sta_connect(const char *ssid, const char *pass);   // pass "" / NULL for open
void wifi_sta_forget(void);

// Drain queued scan/connect/forget. Call off the LVGL task.
void wifi_sta_service(void);

// One-shot: true if a scan finished since the last take (UI rebuilds the list).
bool wifi_sta_take_scan_done(void);
