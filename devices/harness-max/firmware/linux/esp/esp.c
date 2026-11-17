// The ESP-IDF calls the shared sources make, on Linux (include/esp_*.h, hal/, mbedtls/, soc/). Each header says why
// its calls do what they do here.
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_ota_ops.h"
#include "esp_private/panic_internal.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "hal/efuse_hal.h"
#include "mbedtls/sha256.h"

#ifndef __APPLE__
#include <sys/random.h>
#endif

#ifndef PROJECT_VER
#error "PROJECT_VER is the hello's fw version: CMakeLists.txt passes it"
#endif

// ── the clock and the log ───────────────────────────────────────────────────────────────────────────────────────

static int64_t monotonic_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static int64_t s_start_us;
__attribute__((constructor)) static void clock_start(void) { s_start_us = monotonic_us(); }

int64_t esp_timer_get_time(void) { return monotonic_us() - s_start_us; }

void esp_log_line(char level, const char *tag, const char *fmt, ...)
{
    // One write per line, so lines from different threads never interleave.
    char line[1024];
    int n = snprintf(line, sizeof line, "%c (%lld) %s: ", level, (long long)(esp_timer_get_time() / 1000), tag);
    va_list args;
    va_start(args, fmt);
    if (n >= 0 && (size_t)n < sizeof line) n += vsnprintf(line + n, sizeof line - (size_t)n, fmt, args);
    va_end(args);
    if (n < 0) return;
    if ((size_t)n > sizeof line - 2) n = (int)sizeof line - 2;   // a long line is cut, as the device's is
    line[n++] = '\n';
    (void)!write(STDERR_FILENO, line, (size_t)n);
}

const char *esp_err_to_name(esp_err_t err)
{
    switch (err) {
    case ESP_OK: return "ESP_OK";
    case ESP_FAIL: return "ESP_FAIL";
    case ESP_ERR_NO_MEM: return "ESP_ERR_NO_MEM";
    case ESP_ERR_INVALID_ARG: return "ESP_ERR_INVALID_ARG";
    case ESP_ERR_INVALID_STATE: return "ESP_ERR_INVALID_STATE";
    case ESP_ERR_NOT_FOUND: return "ESP_ERR_NOT_FOUND";
    case ESP_ERR_NOT_SUPPORTED: return "ESP_ERR_NOT_SUPPORTED";
    default: return "ERROR";
    }
}

void esp_error_check_failed(esp_err_t err, const char *file, int line, const char *expr)
{
    esp_log_line('E', "esp", "ESP_ERROR_CHECK failed: %s (0x%x) at %s:%d: %s", esp_err_to_name(err), err, file, line,
                 expr);
    abort();
}

// ── memory, randomness, resets ─────────────────────────────────────────────────────────────────────────────────

void *heap_caps_malloc(size_t size, uint32_t caps)
{
    (void)caps;
    return malloc(size);
}

void heap_caps_free(void *ptr) { free(ptr); }
size_t heap_caps_get_free_size(uint32_t caps) { (void)caps; return 0; }
size_t heap_caps_get_minimum_free_size(uint32_t caps) { (void)caps; return 0; }
size_t heap_caps_get_largest_free_block(uint32_t caps) { (void)caps; return 0; }

uint32_t esp_random(void)
{
#ifdef __APPLE__
    return arc4random();
#else
    uint32_t r = 0;
    while (getrandom(&r, sizeof r, 0) != (ssize_t)sizeof r) {}
    return r;
#endif
}

esp_reset_reason_t esp_reset_reason(void) { return ESP_RST_POWERON; }

void esp_restart(void)
{
    esp_log_line('W', "esp", "restart: the program ends here, for its supervisor to start it again");
    exit(EXIT_FAILURE);   // a failure, so systemd's Restart=on-failure starts it again
}

void panic_print_str(const char *str) { (void)!write(STDERR_FILENO, str, strlen(str)); }

void panic_print_hex(int value)
{
    char hex[16];
    const int n = snprintf(hex, sizeof hex, "%08x", (unsigned)value);
    (void)!write(STDERR_FILENO, hex, (size_t)n);
}

// ── who this is ─────────────────────────────────────────────────────────────────────────────────────────────────

const esp_app_desc_t *esp_app_get_description(void)
{
    static const esp_app_desc_t desc = {.version = PROJECT_VER, .project_name = "harness_max"};
    return &desc;
}

esp_err_t esp_read_mac(uint8_t *mac, esp_mac_type_t type)
{
    (void)type;
    char host[256] = "";
    if (gethostname(host, sizeof host - 1) != 0) return ESP_FAIL;
    // FNV-1a of the host name, spread over 48 bits.
    uint64_t h = 1469598103934665603u;
    for (const char *c = host; *c; c++) h = (h ^ (uint8_t)*c) * 1099511628211u;
    for (int i = 0; i < 6; i++) mac[i] = (uint8_t)(h >> (8 * i));
    mac[0] = (uint8_t)((mac[0] & 0xfc) | 0x02);   // locally administered, unicast: never a vendor's address
    return ESP_OK;
}

// ── no flash: OTA refuses (esp_ota_ops.h) ───────────────────────────────────────────────────────────────────────

const esp_partition_t *esp_ota_get_running_partition(void) { return NULL; }
const esp_partition_t *esp_ota_get_next_update_partition(const esp_partition_t *start) { (void)start; return NULL; }
esp_err_t esp_ota_get_state_partition(const esp_partition_t *p, esp_ota_img_states_t *state)
{
    (void)p; (void)state;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t esp_ota_get_partition_description(const esp_partition_t *p, esp_app_desc_t *desc)
{
    (void)p; (void)desc;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t esp_ota_mark_app_valid_cancel_rollback(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t esp_ota_begin(const esp_partition_t *p, size_t image_size, esp_ota_handle_t *handle)
{
    (void)p; (void)image_size; (void)handle;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t esp_ota_write(esp_ota_handle_t handle, const void *data, size_t size)
{
    (void)handle; (void)data; (void)size;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t esp_ota_end(esp_ota_handle_t handle) { (void)handle; return ESP_ERR_NOT_SUPPORTED; }
esp_err_t esp_ota_abort(esp_ota_handle_t handle) { (void)handle; return ESP_ERR_NOT_SUPPORTED; }
esp_err_t esp_ota_set_boot_partition(const esp_partition_t *p) { (void)p; return ESP_ERR_NOT_SUPPORTED; }
esp_err_t esp_partition_read(const esp_partition_t *p, size_t offset, void *dst, size_t size)
{
    (void)p; (void)offset; (void)dst; (void)size;
    return ESP_ERR_NOT_SUPPORTED;
}
uint32_t efuse_hal_chip_revision(void) { return 0; }

void mbedtls_sha256_init(mbedtls_sha256_context *ctx) { (void)ctx; }
void mbedtls_sha256_free(mbedtls_sha256_context *ctx) { (void)ctx; }
int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int is224) { (void)ctx; (void)is224; return -1; }
int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const unsigned char *input, size_t len)
{
    (void)ctx; (void)input; (void)len;
    return -1;
}
int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, unsigned char output[32]) { (void)ctx; (void)output; return -1; }
