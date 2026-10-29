// See main/sys/wdt_pc.h. Runs first thing in the bootloader: no BSS, no flash, no heap yet, only registers.
#include <stdint.h>

#include "esp_rom_sys.h"
#include "hal/assist_debug_ll.h"
#include "soc/assist_debug_reg.h"
#include "soc/lp_system_reg.h"
#include "soc/soc.h"
#include "wdt_pc.h"

// The hooks are weak in the bootloader; this symbol makes the linker keep the file.
void bootloader_hooks_include(void) {}

void bootloader_before_init(void)
{
    if (!wdt_pc_is_watchdog((unsigned)esp_rom_get_reset_reason(0))
        && !wdt_pc_is_watchdog((unsigned)esp_rom_get_reset_reason(1))) return;
    _assist_debug_ll_enable_bus_clock(true);
    uint32_t w[WDT_PC_WORDS] = {
        REG_READ(ASSIST_DEBUG_CORE_0_RCD_PDEBUGPC_REG), REG_READ(ASSIST_DEBUG_CORE_0_RCD_PDEBUGSP_REG),
        REG_READ(ASSIST_DEBUG_CORE_1_RCD_PDEBUGPC_REG), REG_READ(ASSIST_DEBUG_CORE_1_RCD_PDEBUGSP_REG),
        0,
    };
    wdt_pc_seal(w);
    REG_WRITE(LP_SYSTEM_REG_LP_STORE11_REG, w[WDT_PC_PC0]);
    REG_WRITE(LP_SYSTEM_REG_LP_STORE12_REG, w[WDT_PC_SP0]);
    REG_WRITE(LP_SYSTEM_REG_LP_STORE13_REG, w[WDT_PC_PC1]);
    REG_WRITE(LP_SYSTEM_REG_LP_STORE14_REG, w[WDT_PC_SP1]);
    REG_WRITE(LP_SYSTEM_REG_LP_STORE15_REG, w[WDT_PC_CHECK]);
}
