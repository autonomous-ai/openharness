// What a hardware watchdog leaves behind: each core's last PC and SP.
//
// A hang the panic handler never sees (both cores stalled on a bus, interrupts off on both) ends in a hardware
// watchdog reset with no backtrace. The P4's assist_debug block records each core's PC and SP in real time and
// keeps them across that reset, but the bootloader turns core 0's recording back on before the app runs, which
// overwrites it. So the bootloader hook (bootloader_components/wdt_pc) copies both cores' values into LP store
// registers first, and last_words.c reads them at boot. Shared by the two; pure, so it is host-tested.
//
// LP_SYSTEM_REG_LP_STORE11..15: free in IDF 5.5 on the P4 (esp32p4/rom/rtc.h assigns 0..10). They hold across
// every reset but a power cut, where they read 0 and the check fails.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define WDT_PC_MAGIC 0x57445043u   // "WDPC"

enum { WDT_PC_PC0, WDT_PC_SP0, WDT_PC_PC1, WDT_PC_SP1, WDT_PC_CHECK, WDT_PC_WORDS };

static inline uint32_t wdt_pc_sum(const uint32_t w[WDT_PC_WORDS])
{
    return WDT_PC_MAGIC ^ w[WDT_PC_PC0] ^ w[WDT_PC_SP0] ^ w[WDT_PC_PC1] ^ w[WDT_PC_SP1];
}

static inline void wdt_pc_seal(uint32_t w[WDT_PC_WORDS]) { w[WDT_PC_CHECK] = wdt_pc_sum(w); }

static inline bool wdt_pc_valid(const uint32_t w[WDT_PC_WORDS]) { return w[WDT_PC_CHECK] == wdt_pc_sum(w); }

// The P4's raw reset codes (soc/reset_reasons.h) that mean a watchdog or a CPU lockup: the resets the panic
// handler did not get to write a backtrace for.
static inline bool wdt_pc_is_watchdog(unsigned code)
{
    switch (code) {
    case 0x07:   // RESET_REASON_CORE_MWDT
    case 0x09:   // RESET_REASON_CORE_RWDT
    case 0x0B:   // RESET_REASON_CPU_MWDT
    case 0x0D:   // RESET_REASON_CPU_RWDT
    case 0x10:   // RESET_REASON_SYS_RWDT
    case 0x12:   // RESET_REASON_SYS_SUPER_WDT
    case 0x1A:   // RESET_REASON_CPU_LOCKUP
        return true;
    default:
        return false;
    }
}
