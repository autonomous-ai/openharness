#include "wifi_cable.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/param.h>
#include <unistd.h>

#include "cable_link.h"
#include "device_mac.h"
#include "esp_log.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "wifi_cable";

static int s_listen = -1;
static int s_client = -1;
static TaskHandle_t s_task;
static SemaphoreHandle_t s_sock_mu;
static volatile bool s_want_up;
static bool s_mdns_up;

static void sock_lock(void) { if (s_sock_mu) xSemaphoreTake(s_sock_mu, portMAX_DELAY); }
static void sock_unlock(void) { if (s_sock_mu) xSemaphoreGive(s_sock_mu); }

static void sock_close(int *fd)
{
    sock_lock();
    if (*fd >= 0) {
        shutdown(*fd, SHUT_RDWR);
        close(*fd);
        *fd = -1;
    }
    sock_unlock();
}

bool wifi_cable_client(void) { return s_client >= 0; }

void wifi_cable_drop(void) { sock_close(&s_client); }

bool wifi_cable_write(const uint8_t *data, size_t n)
{
    if (!data || !n) return false;
    sock_lock();
    int fd = s_client;
    if (fd < 0) { sock_unlock(); return false; }
    int sent = 0;
    int spins = 0;
    bool ok = true;
    int fail_errno = 0;
    while (sent < (int)n) {
        int r = send(fd, data + sent, n - (size_t)sent, 0);
        if (r < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR || errno == ENOMEM) {
                if (++spins > 50) { ok = false; break; }
                sock_unlock();
                vTaskDelay(pdMS_TO_TICKS(2));
                sock_lock();
                if (s_client != fd) { ok = false; break; }
                continue;
            }
            fail_errno = errno;   // logged after the unlock below — see the note there
            ok = false;
            break;
        }
        spins = 0;
        sent += r;
    }
    sock_unlock();
    // Logged OUTSIDE the socket lock, deliberately. ESP_LOG here runs through the cable's log sink,
    // which takes s_tx_lock; and that sink sends through THIS function, which takes s_sock_mu. Logging
    // while still holding s_sock_mu is the one path in the firmware that grabs those two locks in the
    // opposite order to everyone else, and two tasks hitting both orders at once deadlock the link —
    // silently, since the message that would explain it is the very thing that blocks.
    if (fail_errno) ESP_LOGW(TAG, "tcp send failed: errno=%d", fail_errno);
    if (!ok) sock_close(&s_client);
    return ok && sent == (int)n;
}

static void mdns_start(void)
{
    char mac[DEVICE_MAC_STR_LEN];
    if (!device_mac_str(mac, sizeof(mac))) snprintf(mac, sizeof(mac), "unknown");
    char host[24];
    snprintf(host, sizeof(host), "harness-%c%c%c%c",
             mac[12], mac[13], mac[15], mac[16]);   // last two octets of AA:BB:CC:DD:EE:FF
    esp_err_t err = mdns_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "mdns_init: %s", esp_err_to_name(err));
        return;
    }
    mdns_hostname_set(host);
    mdns_instance_name_set("OpenHarness dial");
    mdns_txt_item_t txt[] = {
        { .key = "mac", .value = mac },
        { .key = "product", .value = "harness" },
    };
    mdns_service_add(NULL, "_harness-dial", "_tcp", WIFI_CABLE_PORT, txt, 2);
    ESP_LOGI(TAG, "mdns %s.local _harness-dial._tcp:%d mac=%s", host, WIFI_CABLE_PORT, mac);
}

static void mdns_stop(void)
{
    mdns_service_remove("_harness-dial", "_tcp");
    mdns_free();
}

static bool listen_up(void)
{
    if (s_listen >= 0) return true;
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd < 0) return false;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(WIFI_CABLE_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 1) != 0) {
        ESP_LOGW(TAG, "tcp bind/listen failed errno=%d", errno);
        close(fd);
        return false;
    }
    s_listen = fd;
    ESP_LOGI(TAG, "tcp listen :%d (one client; USB-paired daemon only)", WIFI_CABLE_PORT);
    return true;
}

static void reject_extra(void)
{
    if (s_listen < 0) return;
    struct sockaddr_in from;
    socklen_t fl = sizeof(from);
    int extra = accept(s_listen, (struct sockaddr *)&from, &fl);
    if (extra >= 0) {
        ESP_LOGW(TAG, "tcp reject extra client (already paired / USB up)");
        close(extra);
    }
}

static void cable_task(void *arg)
{
    (void)arg;
    static uint8_t chunk[1024];   // BSS — a 2 KiB stack array on a 4 KiB task overflowed on USB unplug
    while (1) {
        if (!s_want_up) {
            if (s_mdns_up) { mdns_stop(); s_mdns_up = false; }
            sock_close(&s_client);
            sock_close(&s_listen);
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        if (!s_mdns_up) { mdns_start(); s_mdns_up = true; }
        if (!listen_up()) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        // USB is the pairing wire and wins whenever it is plugged in. A second daemon on the LAN
        // that finds us via mDNS is closed immediately — even the paired one, so it will reopen USB.
        if (cable_link_host_present()) {
            if (s_client >= 0) {
                ESP_LOGI(TAG, "usb present — dropping tcp");
                sock_close(&s_client);
            }
            int flags = fcntl(s_listen, F_GETFL, 0);
            fcntl(s_listen, F_SETFL, flags | O_NONBLOCK);
            reject_extra();
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        int flags = fcntl(s_listen, F_GETFL, 0);
        fcntl(s_listen, F_SETFL, flags | O_NONBLOCK);

        if (s_client < 0) {
            struct sockaddr_in from;
            socklen_t fl = sizeof(from);
            int c = accept(s_listen, (struct sockaddr *)&from, &fl);
            if (c < 0) {
                vTaskDelay(pdMS_TO_TICKS(200));
                continue;
            }
            int yes = 1;
            setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
            int buf = 16 * 1024;
            setsockopt(c, SOL_SOCKET, SO_SNDBUF, &buf, sizeof(buf));
            setsockopt(c, SOL_SOCKET, SO_RCVBUF, &buf, sizeof(buf));
            s_client = c;
            // Route the log over this socket NOW, before anything else can go wrong on it. Framing used
            // to wait for a session, so every reason a TCP session FAILED to come up — a rejected bind
            // above all — was written to a transport that did not exist. That is what made this class of
            // bug invisible: the dial knew exactly what was wrong and had no way to say it.
            cable_link_set_log_framing(true);
            ESP_LOGI(TAG, "tcp client %s — waiting for USB-paired welcome.bind", inet_ntoa(from.sin_addr));
            cable_link_flush_backlog();
        }

        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(s_client, &rfds);
        FD_SET(s_listen, &rfds);
        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
        int nf = s_listen > s_client ? s_listen : s_client;
        if (select(nf + 1, &rfds, NULL, NULL, &tv) <= 0) continue;
        if (FD_ISSET(s_listen, &rfds)) reject_extra();
        if (!FD_ISSET(s_client, &rfds)) continue;
        int n = recv(s_client, chunk, sizeof(chunk), 0);
        if (n <= 0) {
            ESP_LOGI(TAG, "tcp client gone");
            sock_close(&s_client);
            // Back to the console, and back to buffering. Leaving framing on with no transport would
            // send every subsequent line into a closed socket instead of the backlog.
            if (!cable_link_host_present()) cable_link_set_log_framing(false);
            continue;
        }
        cable_link_feed(chunk, (size_t)n, true);
    }
}

void wifi_cable_on_sta_up(void)
{
    if (!s_sock_mu) s_sock_mu = xSemaphoreCreateMutex();
    s_want_up = true;
    if (!s_task) {
        xTaskCreate(cable_task, "wifi_cable", 8192, NULL, 5, &s_task);
    }
}

void wifi_cable_on_sta_down(void)
{
    s_want_up = false;
    sock_close(&s_client);
    sock_close(&s_listen);
}
