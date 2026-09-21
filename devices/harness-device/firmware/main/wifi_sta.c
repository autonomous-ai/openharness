#include "wifi_sta.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config_store.h"
#include "wifi_cable.h"
#if __has_include("provisioned_config.h")
#include "provisioned_config.h"
#endif
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"   // xTaskGetTickCount for the reconnect backoff

static const char *TAG = "wifi_sta";

static SemaphoreHandle_t s_mu;
static wifi_sta_state_t s_state = WIFI_STA_OFF;
static char s_ssid[WIFI_STA_SSID_MAX];
static char s_ip[16];
static wifi_sta_ap_t s_aps[WIFI_STA_AP_MAX];
static int s_ap_n;
static volatile bool s_scan_req, s_connect_req, s_forget_req, s_scan_done;
static char s_want_ssid[WIFI_STA_SSID_MAX];
static char s_want_pass[WIFI_STA_PASS_MAX];
static int s_fail_streak;
static bool s_inited;
static esp_netif_t *s_netif;
static volatile TickType_t s_retry_at;   // 0 = nothing scheduled; see retry_delay_ms()

static void lock(void) { if (s_mu) xSemaphoreTake(s_mu, portMAX_DELAY); }
static void unlock(void) { if (s_mu) xSemaphoreGive(s_mu); }

static void set_state(wifi_sta_state_t st)
{
    s_state = st;
}

// 5s, 10s, 20s, 40s, then a flat minute. The cap matters more than the curve: the thing being waited on
// is usually a router coming back, and a dial that has been sulking for an hour should still notice
// within a minute of the AP returning.
static uint32_t retry_delay_ms(void)
{
    int n = s_fail_streak > 5 ? 5 : (s_fail_streak > 0 ? s_fail_streak : 1);
    uint32_t d = 5000u << (n - 1);   // n=5 gives 80s, which the cap below turns into the flat minute
    return d > 60000u ? 60000u : d;
}

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)id;
    const ip_event_got_ip_t *e = data;
    lock();
    snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
    s_fail_streak = 0;
    s_retry_at = 0;
    set_state(WIFI_STA_CONNECTED);
    ESP_LOGI(TAG, "got ip %s ssid='%s'", s_ip, s_ssid);
    unlock();
    wifi_cable_on_sta_up();
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base;
    if (id == WIFI_EVENT_STA_START) {
        lock();
        if (s_ssid[0] && s_state != WIFI_STA_SCANNING) {
            set_state(WIFI_STA_CONNECTING);
            unlock();
            esp_wifi_connect();
            return;
        }
        if (s_state == WIFI_STA_OFF) set_state(WIFI_STA_IDLE);
        unlock();
        return;
    }
    if (id != WIFI_EVENT_STA_DISCONNECTED) return;
    const wifi_event_sta_disconnected_t *e = data;
    wifi_cable_on_sta_down();
    lock();
    s_ip[0] = '\0';
    int reason = e ? e->reason : 0;
    s_fail_streak++;
    bool give_up = s_fail_streak >= 5 ||
                   reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
                   reason == WIFI_REASON_AUTH_FAIL ||
                   reason == WIFI_REASON_NO_AP_FOUND;
    if (give_up) {
        // FAILED is what the UI draws, not the end of the story. A wrong password stays wrong, but
        // NO_AP_FOUND is also exactly what a rebooting router looks like, and this state used to be
        // terminal: nothing in wifi_sta_service() ever left it, so one transient drop cost the LAN for
        // good — wifi_cable_on_sta_down() had already taken the listener and mDNS down with it, and the
        // only way back was a human opening Settings. Schedule a retry and let the backoff keep it cheap.
        const uint32_t delay = retry_delay_ms();
        set_state(WIFI_STA_FAILED);
        // 0 is the "nothing scheduled" sentinel, so a sum that lands there on tick wraparound would
        // silently cancel the retry this whole block exists to guarantee. Cost of avoiding it: one tick.
        s_retry_at = xTaskGetTickCount() + pdMS_TO_TICKS(delay);
        if (!s_retry_at) s_retry_at = 1;
        ESP_LOGW(TAG, "connect failed reason=%d streak=%d — retry in %ums", reason, s_fail_streak,
                 (unsigned)delay);
        unlock();
        return;
    }
    set_state(WIFI_STA_CONNECTING);
    unlock();
    ESP_LOGW(TAG, "disconnected reason=%d — retry", reason);
    esp_wifi_connect();
}

void wifi_sta_init(void)
{
    if (s_inited) return;
    s_mu = xSemaphoreCreateMutex();
    s_ssid[0] = s_ip[0] = '\0';
    char pass[WIFI_STA_PASS_MAX] = "";
    config_load_wifi(s_ssid, sizeof(s_ssid), pass, sizeof(pass));
#if defined(DEVICE_WIFI_SSID) && defined(DEVICE_WIFI_PASS)
    if (!s_ssid[0] || strcmp(s_ssid, DEVICE_WIFI_SSID) != 0) {
        config_save_wifi(DEVICE_WIFI_SSID, DEVICE_WIFI_PASS);
        strncpy(s_ssid, DEVICE_WIFI_SSID, sizeof(s_ssid) - 1);
        strncpy(pass, DEVICE_WIFI_PASS, sizeof(pass) - 1);
        ESP_LOGI(TAG, "using provisioned SSID '%s'", s_ssid);
    }
#endif

    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t el = esp_event_loop_create_default();
    if (el != ESP_OK && el != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(el);
    s_netif = esp_netif_create_default_wifi_sta();
    (void)s_netif;

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &on_got_ip, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    if (s_ssid[0]) {
        wifi_config_t wcfg = { 0 };
        strncpy((char *)wcfg.sta.ssid, s_ssid, sizeof(wcfg.sta.ssid) - 1);
        strncpy((char *)wcfg.sta.password, pass, sizeof(wcfg.sta.password) - 1);
        wcfg.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
        wcfg.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wcfg));
        set_state(WIFI_STA_CONNECTING);
        ESP_LOGI(TAG, "boot join '%s'", s_ssid);
    } else {
        set_state(WIFI_STA_IDLE);
    }
    memset(pass, 0, sizeof(pass));
    ESP_ERROR_CHECK(esp_wifi_start());
    s_inited = true;
}

wifi_sta_state_t wifi_sta_state(void)
{
    lock();
    wifi_sta_state_t st = s_state;
    unlock();
    return st;
}

const char *wifi_sta_ssid(void)
{
    return s_ssid;
}

const char *wifi_sta_ip(void)
{
    return s_ip;
}

int wifi_sta_rssi(void)
{
    lock();
    bool up = s_state == WIFI_STA_CONNECTED;
    unlock();
    if (!up) return -127;
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return -127;
    return ap.rssi;
}

int wifi_sta_copy_scan(wifi_sta_ap_t *out, int max)
{
    if (!out || max <= 0) return 0;
    lock();
    int n = s_ap_n < max ? s_ap_n : max;
    memcpy(out, s_aps, (size_t)n * sizeof(s_aps[0]));
    unlock();
    return n;
}

void wifi_sta_request_scan(void) { s_scan_req = true; }

void wifi_sta_connect(const char *ssid, const char *pass)
{
    if (!ssid || !ssid[0]) return;
    lock();
    strncpy(s_want_ssid, ssid, sizeof(s_want_ssid) - 1);
    s_want_ssid[sizeof(s_want_ssid) - 1] = '\0';
    strncpy(s_want_pass, pass ? pass : "", sizeof(s_want_pass) - 1);
    s_want_pass[sizeof(s_want_pass) - 1] = '\0';
    s_connect_req = true;
    unlock();
}

void wifi_sta_forget(void) { s_forget_req = true; }

bool wifi_sta_take_scan_done(void)
{
    bool v = s_scan_done;
    s_scan_done = false;
    return v;
}

static int ap_cmp(const void *a, const void *b)
{
    const wifi_sta_ap_t *x = a, *y = b;
    return (int)y->rssi - (int)x->rssi;
}

static void do_scan(void)
{
    lock();
    set_state(WIFI_STA_SCANNING);
    unlock();
    wifi_scan_config_t sc = {
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {
        lock();
        if (s_state == WIFI_STA_SCANNING) set_state(s_ssid[0] ? WIFI_STA_CONNECTING : WIFI_STA_IDLE);
        unlock();
        s_scan_done = true;
        return;
    }
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    wifi_ap_record_t rec[32];
    uint16_t got = n > 32 ? 32 : n;
    if (got) esp_wifi_scan_get_ap_records(&got, rec);
    else esp_wifi_scan_get_ap_records(&got, rec);

    wifi_sta_ap_t tmp[WIFI_STA_AP_MAX];
    int tn = 0;
    for (uint16_t i = 0; i < got && tn < WIFI_STA_AP_MAX; i++) {
        if (!rec[i].ssid[0]) continue;
        int exist = -1;
        for (int k = 0; k < tn; k++) {
            if (strncmp(tmp[k].ssid, (const char *)rec[i].ssid, WIFI_STA_SSID_MAX) == 0) {
                exist = k;
                break;
            }
        }
        if (exist >= 0) {
            if (rec[i].rssi > tmp[exist].rssi) tmp[exist].rssi = rec[i].rssi;
            continue;
        }
        strncpy(tmp[tn].ssid, (const char *)rec[i].ssid, WIFI_STA_SSID_MAX - 1);
        tmp[tn].ssid[WIFI_STA_SSID_MAX - 1] = '\0';
        tmp[tn].rssi = rec[i].rssi;
        tmp[tn].open = rec[i].authmode == WIFI_AUTH_OPEN;
        tn++;
    }
    qsort(tmp, (size_t)tn, sizeof(tmp[0]), ap_cmp);

    lock();
    memcpy(s_aps, tmp, (size_t)tn * sizeof(tmp[0]));
    s_ap_n = tn;
    if (s_state == WIFI_STA_SCANNING) {
        if (s_ip[0]) set_state(WIFI_STA_CONNECTED);
        else if (s_ssid[0]) set_state(WIFI_STA_CONNECTING);
        else set_state(WIFI_STA_IDLE);
    }
    unlock();
    s_scan_done = true;
    ESP_LOGI(TAG, "scan %d aps", tn);
}

static void do_connect(void)
{
    char ssid[WIFI_STA_SSID_MAX], pass[WIFI_STA_PASS_MAX];
    lock();
    memcpy(ssid, s_want_ssid, sizeof(ssid));
    memcpy(pass, s_want_pass, sizeof(pass));
    memset(s_want_pass, 0, sizeof(s_want_pass));
    memcpy(s_ssid, ssid, sizeof(s_ssid));
    s_fail_streak = 0;
    s_retry_at = 0;
    s_ip[0] = '\0';
    set_state(WIFI_STA_CONNECTING);
    unlock();

    config_save_wifi(ssid, pass);
    wifi_config_t wcfg = { 0 };
    strncpy((char *)wcfg.sta.ssid, ssid, sizeof(wcfg.sta.ssid) - 1);
    strncpy((char *)wcfg.sta.password, pass, sizeof(wcfg.sta.password) - 1);
    wcfg.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wcfg.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    memset(pass, 0, sizeof(pass));
    esp_wifi_disconnect();
    esp_wifi_set_config(WIFI_IF_STA, &wcfg);
    esp_wifi_connect();
    ESP_LOGI(TAG, "join '%s'", ssid);
}

static void do_forget(void)
{
    config_clear_wifi();
    lock();
    s_ssid[0] = s_ip[0] = '\0';
    s_fail_streak = 0;
    s_retry_at = 0;
    set_state(WIFI_STA_IDLE);
    unlock();
    esp_wifi_disconnect();
    wifi_config_t wcfg = { 0 };
    esp_wifi_set_config(WIFI_IF_STA, &wcfg);
    ESP_LOGI(TAG, "forgot network");
}

// Leave WIFI_STA_FAILED when the scheduled moment arrives. Signed tick arithmetic so a wrapped
// tick counter compares correctly rather than parking the dial for 49 days.
static void service_retry(void)
{
    if (!s_retry_at || (int32_t)(xTaskGetTickCount() - s_retry_at) < 0) return;
    lock();
    if (s_state != WIFI_STA_FAILED || !s_ssid[0]) {
        s_retry_at = 0;
        unlock();
        return;
    }
    s_retry_at = 0;
    set_state(WIFI_STA_CONNECTING);
    unlock();
    ESP_LOGI(TAG, "retrying '%s'", s_ssid);
    esp_wifi_connect();
}

void wifi_sta_service(void)
{
    if (!s_inited) return;
    if (s_forget_req) { s_forget_req = false; do_forget(); }
    if (s_connect_req) { s_connect_req = false; do_connect(); }
    if (s_scan_req) { s_scan_req = false; do_scan(); }
    service_retry();
}
