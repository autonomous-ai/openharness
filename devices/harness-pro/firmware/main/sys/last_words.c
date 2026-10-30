#include "last_words.h"

#include <string.h>

#include "crash_record.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_private/panic_internal.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "soc/lp_system_reg.h"
#include "soc/soc.h"
#include "wdt_pc.h"

static const char *TAG = "boot";

#define RING_BYTES 4096
#define RING_MAGIC 0x4C575244u   // "LWRD"

// RTC_NOINIT: not touched by the bootloader or the startup code, so it holds across a panic, a watchdog
// reset or esp_restart(). A power cut clears it, and that is fine — a power cut is not a bug this can
// name. The magic and a checksum of the header guard against reading garbage on a cold boot.
typedef struct {
    uint32_t magic;
    uint32_t head;      // next write position
    uint32_t len;       // bytes in use (≤ RING_BYTES)
    uint32_t check;     // ~(head ^ len)
    char     buf[RING_BYTES];
} ring_t;

static RTC_NOINIT_ATTR ring_t s_ring;
// The breadcrumbs: a second small RTC record for the resets the log ring cannot explain (hardware watchdog,
// brownout) and the panic's backtrace. No checksum: tasks and the panic handler write it without a lock, and a
// torn field is worth more than a dropped record; only a valid magic and an abnormal reset make it speak.
static RTC_NOINIT_ATTR crash_record_t s_rec;
static crash_record_t s_prev_rec;
static bool s_have_rec;
// What the hardware kept (wdt_pc.h): read at boot, reported with the reset reason.
static cr_hw_t s_hw;
static bool s_have_hw;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

static esp_reset_reason_t s_reason;
static bool s_abnormal;
// The previous boot's lines, copied out before this boot starts overwriting the ring. Static rather than
// heap: 4 KB of BSS is cheaper than a failed allocation at the one moment it would matter.
static char s_previous[RING_BYTES + 1];
static size_t s_previous_len;
static bool s_reported;

static bool ring_valid(void)
{
    return s_ring.magic == RING_MAGIC && s_ring.len <= RING_BYTES && s_ring.head < RING_BYTES
        && s_ring.check == ~(s_ring.head ^ s_ring.len);
}

static void ring_seal(void) { s_ring.check = ~(s_ring.head ^ s_ring.len); }

static const char *reason_name(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON:   return "power-on";
    case ESP_RST_EXT:       return "external pin";
    case ESP_RST_SW:        return "software (esp_restart)";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INTERRUPT WATCHDOG";
    case ESP_RST_TASK_WDT:  return "TASK WATCHDOG";
    case ESP_RST_WDT:       return "WATCHDOG";
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "sdio";
    case ESP_RST_USB:       return "usb";
    case ESP_RST_JTAG:      return "jtag";
    case ESP_RST_CPU_LOCKUP: return "CPU LOCKUP";
    default:                return "unknown";
    }
}

void last_words_boot(void)
{
    s_reason = esp_reset_reason();
    s_abnormal = s_reason == ESP_RST_PANIC || s_reason == ESP_RST_INT_WDT || s_reason == ESP_RST_TASK_WDT
              || s_reason == ESP_RST_WDT || s_reason == ESP_RST_BROWNOUT || s_reason == ESP_RST_CPU_LOCKUP
              || s_reason == ESP_RST_UNKNOWN;
    if (s_abnormal) {
        // Which watchdog, and at what level: ESP_RST_WDT folds the P4's six watchdog resets into one.
        s_hw.cause[0] = (unsigned)esp_rom_get_reset_reason(0);
        s_hw.cause[1] = (unsigned)esp_rom_get_reset_reason(1);
        uint32_t w[WDT_PC_WORDS] = {
            REG_READ(LP_SYSTEM_REG_LP_STORE11_REG), REG_READ(LP_SYSTEM_REG_LP_STORE12_REG),
            REG_READ(LP_SYSTEM_REG_LP_STORE13_REG), REG_READ(LP_SYSTEM_REG_LP_STORE14_REG),
            REG_READ(LP_SYSTEM_REG_LP_STORE15_REG),
        };
        // Sealed by the bootloader hook only after a watchdog or lockup reset; an older bootloader never seals it.
        s_hw.have_pc = wdt_pc_valid(w);
        s_hw.pc[0] = w[WDT_PC_PC0]; s_hw.sp[0] = w[WDT_PC_SP0];
        s_hw.pc[1] = w[WDT_PC_PC1]; s_hw.sp[1] = w[WDT_PC_SP1];
        s_have_hw = true;
    }
    // Read once: a later clean reset must not replay this one's record.
    REG_WRITE(LP_SYSTEM_REG_LP_STORE15_REG, 0);
    if (s_abnormal && ring_valid() && s_ring.len) {
        // Unroll the ring into reading order: oldest byte first.
        uint32_t start = (s_ring.head + RING_BYTES - s_ring.len) % RING_BYTES;
        for (uint32_t i = 0; i < s_ring.len; i++) s_previous[i] = s_ring.buf[(start + i) % RING_BYTES];
        s_previous_len = s_ring.len;
        s_previous[s_previous_len] = '\0';
    }
    if (s_abnormal && cr_valid(&s_rec)) { s_prev_rec = s_rec; s_have_rec = true; }
    cr_init(&s_rec);
    s_ring.magic = RING_MAGIC;
    s_ring.head = 0;
    s_ring.len = 0;
    ring_seal();
}

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

void last_words_phase(lw_task_t task, const char *phase)
{
    const uint32_t now = now_ms();
    cr_phase(&s_rec, (unsigned)task, phase, now);
    static uint32_t s_heap_ms;   // heap numbers are O(1) but not free: once a second is plenty
    if (now - s_heap_ms >= 1000) {
        s_heap_ms = now;
        s_rec.free_int = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
        s_rec.min_int = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
    }
}

void last_words_rx(uint32_t ms) { s_rec.rx_ms = ms; }

// The panic's backtrace. IDF's panic handler prints it through this weak hook, one (pc, sp) per frame, from
// the frame-pointer unwinder (CONFIG_ESP_SYSTEM_USE_FRAME_POINTER), and it runs after the panic text is on its
// way and before the reboot — on an exception, a failed assert, abort(), the task watchdog and the interrupt
// watchdog alike. Kept: still prints as IDF does, plus a copy into RTC. IRAM and no calls out of it: it can
// run with the flash cache off.
void IRAM_ATTR esp_fp_generated_step(uint32_t pc, uint32_t sp)
{
    panic_print_str(" 0x");
    panic_print_hex((int)pc);
    panic_print_str(":0x");
    panic_print_hex((int)sp);
    if (s_rec.magic == CR_MAGIC && s_rec.npc < CR_PCS) s_rec.pc[s_rec.npc++] = pc;
    s_rec.panicked = 1;
}

void last_words_add(const char *line, size_t len)
{
    if (!len) return;
    portENTER_CRITICAL(&s_mux);
    if (!ring_valid()) { s_ring.magic = RING_MAGIC; s_ring.head = 0; s_ring.len = 0; }
    for (size_t i = 0; i < len; i++) {
        s_ring.buf[s_ring.head] = line[i];
        s_ring.head = (s_ring.head + 1) % RING_BYTES;
    }
    s_ring.buf[s_ring.head] = '\n';
    s_ring.head = (s_ring.head + 1) % RING_BYTES;
    s_ring.len += len + 1;
    if (s_ring.len > RING_BYTES) s_ring.len = RING_BYTES;
    ring_seal();
    portEXIT_CRITICAL(&s_mux);
}

// One warning per '\n'-separated line of a crash_record text.
static void log_lines(char *text)
{
    for (char *p = text, *nl; p && *p; p = nl ? nl + 1 : NULL) {
        if ((nl = strchr(p, '\n'))) *nl = '\0';
        ESP_LOGW(TAG, "%s", p);
    }
}

void last_words_report(void)
{
    if (s_reported) return;
    s_reported = true;
    if (s_abnormal) ESP_LOGW(TAG, "reset reason: %s", reason_name(s_reason));
    else            ESP_LOGI(TAG, "reset reason: %s", reason_name(s_reason));
    static char text[512];
    if (s_have_hw) {
        cr_format_hw(&s_hw, text, sizeof text);
        log_lines(text);
        s_have_hw = false;
    }
    if (s_have_rec) {
        cr_format(&s_prev_rec, text, sizeof text);
        log_lines(text);
        s_have_rec = false;
    }
    if (!s_previous_len) return;
    ESP_LOGW(TAG, "last %u bytes of log before that reset follow", (unsigned)s_previous_len);
    // The first line is very likely a fragment (the ring wrapped through it); everything after is whole.
    char *p = s_previous;
    while (p && *p) {
        char *nl = strchr(p, '\n');
        if (nl) *nl = '\0';
        if (*p) ESP_LOGW(TAG, "last: %s", p);
        p = nl ? nl + 1 : NULL;
    }
    ESP_LOGW(TAG, "end of last words");
    s_previous_len = 0;
}
