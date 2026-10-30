// bootloader_components/wdt_pc: the bootloader hook against a fake register file. A bad bootloader can leave a
// unit needing a USB reflash, so the hook's whole behaviour is checked here before any device runs it.
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "soc/assist_debug_reg.h"
#include "soc/lp_system_reg.h"
#include "soc/soc.h"
#include "wdt_pc.h"

void bootloader_before_init(void);

#define REGS 0x3000u
static uint32_t s_reg[REGS / 4];
static unsigned s_writes;
static unsigned s_cause[2];
static bool s_clock;

uint32_t host_reg_read(uint32_t addr) { assert(addr < REGS && addr % 4 == 0); return s_reg[addr / 4]; }
void host_reg_write(uint32_t addr, uint32_t value) { assert(addr < REGS && addr % 4 == 0); s_reg[addr / 4] = value; s_writes++; }
unsigned esp_rom_get_reset_reason(int cpu_no) { assert(cpu_no == 0 || cpu_no == 1); return s_cause[cpu_no]; }
void _assist_debug_ll_enable_bus_clock(bool enable) { s_clock = enable; }

static void boot(unsigned cause0, unsigned cause1)
{
    memset(s_reg, 0, sizeof s_reg);
    s_writes = 0; s_clock = false;
    s_cause[0] = cause0; s_cause[1] = cause1;
    s_reg[ASSIST_DEBUG_CORE_0_RCD_PDEBUGPC_REG / 4] = 0x4ff0abcdu;
    s_reg[ASSIST_DEBUG_CORE_0_RCD_PDEBUGSP_REG / 4] = 0x4ff7f000u;
    s_reg[ASSIST_DEBUG_CORE_1_RCD_PDEBUGPC_REG / 4] = 0x40001234u;
    s_reg[ASSIST_DEBUG_CORE_1_RCD_PDEBUGSP_REG / 4] = 0x4ff6e000u;
    bootloader_before_init();
}

static void stored(uint32_t w[WDT_PC_WORDS])
{
    w[WDT_PC_PC0] = s_reg[LP_SYSTEM_REG_LP_STORE11_REG / 4];
    w[WDT_PC_SP0] = s_reg[LP_SYSTEM_REG_LP_STORE12_REG / 4];
    w[WDT_PC_PC1] = s_reg[LP_SYSTEM_REG_LP_STORE13_REG / 4];
    w[WDT_PC_SP1] = s_reg[LP_SYSTEM_REG_LP_STORE14_REG / 4];
    w[WDT_PC_CHECK] = s_reg[LP_SYSTEM_REG_LP_STORE15_REG / 4];
}

int main(void)
{
    uint32_t w[WDT_PC_WORDS];

    // A clean boot writes nothing at all: not a register, not the clock.
    boot(0x01, 0x01);                       // power-on
    assert(s_writes == 0 && !s_clock);
    boot(0x0C, 0x0C);                       // esp_restart, an OTA reboot
    assert(s_writes == 0 && !s_clock);
    boot(0x17, 0x17);                       // reset over USB serial (a flash)
    assert(s_writes == 0 && !s_clock);

    // A core reset by the HP watchdog: both cores' PC and SP land in the LP store, sealed.
    boot(0x07, 0x07);
    stored(w);
    assert(s_clock && wdt_pc_valid(w));
    assert(w[WDT_PC_PC0] == 0x4ff0abcdu && w[WDT_PC_SP0] == 0x4ff7f000u);
    assert(w[WDT_PC_PC1] == 0x40001234u && w[WDT_PC_SP1] == 0x4ff6e000u);
    assert(s_writes == 5);                  // the five LP store registers and nothing else

    // Only core 1 reset by the watchdog: still saved. A CPU lockup on core 0: saved.
    boot(0x0C, 0x0B);
    stored(w);
    assert(wdt_pc_valid(w) && w[WDT_PC_PC1] == 0x40001234u);
    boot(0x1A, 0x0C);
    stored(w);
    assert(wdt_pc_valid(w) && w[WDT_PC_PC0] == 0x4ff0abcdu);
    puts("test_wdt_pc_hook: ok");
    return 0;
}
