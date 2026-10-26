// Host test for cable_link.c's reader: the partial-frame timeout and the counters. The source is included so its static
// reader_step() can be driven with a fake clock and a recording frame callback; the USB driver and FreeRTOS are stubs.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

#include "cable/cable_link.c"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static int64_t now_us = 1000000;
int64_t esp_timer_get_time(void) { return now_us; }
esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *cfg) { (void)cfg; return ESP_OK; }
esp_err_t usb_serial_jtag_driver_uninstall(void) { return ESP_OK; }
int usb_serial_jtag_read_bytes(void *b, uint32_t n, TickType_t t) { (void)b; (void)n; (void)t; return 0; }
int usb_serial_jtag_write_bytes(const void *s, size_t n, TickType_t t) { (void)s; (void)t; return (int)n; }
bool usb_serial_jtag_is_connected(void) { return true; }
static uint32_t stub_isr = 7, stub_drop = 2;
void usb_serial_jtag_rx_stats(uint32_t *a, uint32_t *b) { *a = stub_isr; *b = stub_drop; }
vprintf_like_t esp_log_set_vprintf(vprintf_like_t f) { return f; }
int xPortInIsrContext(void) { return 0; }
TaskHandle_t xTaskGetCurrentTaskHandle(void) { return NULL; }
TaskHandle_t xSemaphoreGetMutexHolder(SemaphoreHandle_t m) { (void)m; return NULL; }
void vSemaphoreDelete(SemaphoreHandle_t m) { (void)m; }
void last_words_add(const char *l, size_t n) { (void)l; (void)n; }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { return NULL; }
BaseType_t xSemaphoreTake(SemaphoreHandle_t m, TickType_t w) { (void)m; (void)w; return pdTRUE; }
BaseType_t xSemaphoreGive(SemaphoreHandle_t m) { (void)m; return pdTRUE; }
BaseType_t xTaskCreate(TaskFunction_t f, const char *n, uint32_t s, void *a, unsigned p, TaskHandle_t *o) { (void)f; (void)n; (void)s; (void)a; (void)p; (void)o; return pdPASS; }
const char *esp_err_to_name(esp_err_t e) { (void)e; return "err"; }
void usb_serial_jtag_vfs_use_driver(void) {}
void usb_serial_jtag_vfs_use_nonblocking(void) {}
void usb_serial_jtag_ll_phy_enable_pull_override(const usb_serial_jtag_pull_override_vals_t *v) { (void)v; }
void usb_serial_jtag_ll_phy_disable_pull_override(void) {}
void vTaskDelay(TickType_t t) { (void)t; }

static int got;
static uint8_t got_type[8];
static void on_frame(uint8_t version, uint8_t type, const uint8_t *p, size_t n, void *ctx)
{
    (void)version; (void)p; (void)n; (void)ctx;
    if (got < 8) got_type[got] = type;
    got++;
}

// A frame of `n` payload bytes of 'x' into `out`; returns its length.
static size_t frame(uint8_t *out, size_t n)
{
    uint8_t payload[400];
    memset(payload, 'x', n);
    return (size_t)cable_frame_encode(CABLE_TYPE_JSON, payload, n, out, 1024);
}

int main(void)
{
    s_cb = on_frame;
    cable_decoder_init(&s_decoder);
    uint8_t a[1024], b[1024];
    const size_t la = frame(a, 100), lb = frame(b, 20);

    // Whole frames pass straight through.
    reader_step(a, (int)la);
    CHECK(got == 1 && s_decoder.len == 0);

    // The tail of a frame is lost (a dropped USB packet) and nothing follows: 300 ms later the partial is dropped,
    // counted corrupt, and the next frame decodes at once. Before: it sat there for 15 s.
    reader_step(a, 64);
    CHECK(s_decoder.len == 64);
    now_us += 299 * 1000;
    reader_step(NULL, 0);
    CHECK(s_decoder.len == 64 && s_decoder.corrupt_frames == 0);   // not yet
    now_us += 2 * 1000;
    reader_step(NULL, 0);
    CHECK(s_decoder.len == 0 && s_decoder.corrupt_frames == 1);
    reader_step(b, (int)lb);
    CHECK(got == 2);

    // The same loss, but bytes of the next frame arrive after the gap in the same read: the stale partial goes first.
    reader_step(a, 64);
    now_us += 400 * 1000;
    reader_step(b, (int)lb);
    CHECK(got == 3 && s_decoder.corrupt_frames == 2 && s_decoder.len == 0);

    // A whole frame sitting behind the lost tail is salvaged by the resync instead of being thrown away with it.
    uint8_t mix[1024];
    memcpy(mix, a, 30);                       // 30 bytes of a 100 B frame, then a complete 20 B frame behind a gap
    memcpy(mix + 30, b, lb);
    reader_step(mix, (int)(30 + lb));         // the decoder wants 114 B for the first header: waits
    CHECK(got == 3 && s_decoder.len == 30 + lb);
    now_us += 301 * 1000;
    reader_step(NULL, 0);
    CHECK(got == 4 && s_decoder.len == 0 && s_decoder.corrupt_frames == 3);

    // A partial frame keeps its whole window from the last byte it received: the rest arriving inside it completes it.
    uint8_t two[1024];
    memcpy(two, b, lb);
    memcpy(two + lb, a, 50);                  // a whole frame, then half of another
    reader_step(two, (int)(lb + 50));
    CHECK(got == 5 && s_decoder.len == 50);
    now_us += 250 * 1000;
    reader_step(NULL, 0);
    CHECK(s_decoder.len == 50);               // 250 ms since the last byte: still waiting
    reader_step(a + 50, (int)(la - 50));      // the rest arrives in time
    CHECK(got == 6 && s_decoder.len == 0 && s_decoder.corrupt_frames == 3);

    // A lone trailing magic byte is not a partial frame: dropped quietly, not counted.
    uint8_t lone = CABLE_MAGIC_0;
    reader_step(&lone, 1);
    now_us += 400 * 1000;
    reader_step(NULL, 0);
    CHECK(s_decoder.len == 0 && s_decoder.corrupt_frames == 3);

    // The driver's counters ride the stats.
    cable_link_stats_t st = cable_link_stats();
    CHECK(st.isr_rx == 7 && st.ring_drop == 2 && st.frames_ok == 6);
    CHECK(st.corrupt_frames == 3 && st.rx_bytes > 0);

    printf("test_cable_link: %d checks passed\n", checks);
    return 0;
}
