// crash_record.c: the breadcrumb record's phases and its text for the daemon. Host-only, pure.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "crash_record.h"
#include "wdt_pc.h"

int main(void)
{
    crash_record_t r;
    memset(&r, 0xA5, sizeof r);
    assert(!cr_valid(&r));                                  // cold RTC garbage is not a record
    cr_init(&r);
    assert(cr_valid(&r));

    char out[512];
    cr_phase(&r, 0, "ota.write", 1000);
    cr_phase(&r, 1, "render", 1200);
    cr_phase(&r, 0, "ota.verify", 1500);                   // a newer phase replaces the older one in its slot
    cr_phase(&r, 7, "bogus", 9999);                        // an unknown slot is ignored
    assert(r.up_ms == 1500 && !strcmp(r.slot[0].name, "ota.verify") && r.slot[0].ms == 1500 && r.slot[1].ms == 1200);
    r.rx_ms = 1400; r.free_int = 123456; r.min_int = 100000;
    cr_format(&r, out, sizeof out);
    assert(strstr(out, "alive until 1500 ms, last cable byte 1400 ms, internal heap 123456 free / 100000 lowest\n"));
    assert(strstr(out, "cable task: ota.verify at 1500 ms\n") && strstr(out, "render task: render at 1200 ms\n"));
    assert(!strstr(out, "voice") && !strstr(out, "panic"));

    // A long phase is cut, never overrun; a record from a torn write cannot run %s off the end.
    cr_phase(&r, 2, "a-very-long-phase-name", 1600);
    assert(strlen(r.slot[2].name) == CR_NAME - 1);
    memset(r.slot[2].name, 'x', CR_NAME);
    cr_format(&r, out, sizeof out);
    assert(strstr(out, "voice task: xxxxxxxxxxx at 1600 ms\n"));

    // The panic backtrace, most recent frame first; more frames than fit are dropped, not wrapped.
    r.panicked = 1; r.npc = 2; r.pc[0] = 0x4ff00123u; r.pc[1] = 0x40001000u;
    cr_format(&r, out, sizeof out);
    assert(strstr(out, "panic backtrace (addr2line against this build's ELF): 0x4ff00123 0x40001000\n"));
    r.npc = CR_PCS + 1;
    assert(!cr_valid(&r));

    // Too small an output buffer: truncated, terminated, no overrun.
    char tiny[16];
    memset(tiny, 'Z', sizeof tiny);
    size_t n = cr_format(&r, tiny, sizeof tiny);
    assert(n < sizeof tiny && tiny[n] == '\0');
    assert(cr_format(&r, tiny, 0) == 0);

    // The hardware record: a hang that never reached the panic handler (a hardware watchdog, a lockup) leaves
    // only what the CPU kept: each core's last PC and SP, which the bootloader copies into LP store registers.
    assert(wdt_pc_is_watchdog(0x07) && wdt_pc_is_watchdog(0x09) && wdt_pc_is_watchdog(0x0B));
    assert(wdt_pc_is_watchdog(0x0D) && wdt_pc_is_watchdog(0x10) && wdt_pc_is_watchdog(0x12) && wdt_pc_is_watchdog(0x1A));
    assert(!wdt_pc_is_watchdog(0x01) && !wdt_pc_is_watchdog(0x03) && !wdt_pc_is_watchdog(0x0C));   // power-on, software
    assert(!wdt_pc_is_watchdog(0x0F) && !wdt_pc_is_watchdog(0x17) && !wdt_pc_is_watchdog(0));      // brownout, USB, none
    uint32_t st[WDT_PC_WORDS] = { 0 };
    assert(!wdt_pc_valid(st));                              // power-on: the LP store registers read 0
    st[WDT_PC_PC0] = 0x4ff0abcdu; st[WDT_PC_SP0] = 0x4ff7f000u; st[WDT_PC_PC1] = 0x40001234u; st[WDT_PC_SP1] = 0x4ff6e000u;
    wdt_pc_seal(st);
    assert(wdt_pc_valid(st));
    st[WDT_PC_PC1] ^= 4;                                    // one word changed after the seal: not a record
    assert(!wdt_pc_valid(st));
    st[WDT_PC_PC1] ^= 4;

    cr_hw_t hw = { .cause = { 0x07, 0x0B }, .have_pc = true,
                   .pc = { 0x4ff0abcdu, 0x40001234u }, .sp = { 0x4ff7f000u, 0x4ff6e000u } };
    cr_format_hw(&hw, out, sizeof out);
    assert(!strcmp(out, "crumbs: hardware reset: core 0 by the HP watchdog (core reset, 0x07), core 1 by the HP watchdog (CPU reset, 0x0b)\n"
                        "crumbs: hardware record (addr2line against this build's ELF): core 0 pc 0x4ff0abcd sp 0x4ff7f000, core 1 pc 0x40001234 sp 0x4ff6e000\n"));
    hw.have_pc = false; hw.cause[0] = 0x12; hw.cause[1] = 0x55;   // an old bootloader: the cause alone; an unknown code by number
    cr_format_hw(&hw, out, sizeof out);
    assert(!strcmp(out, "crumbs: hardware reset: core 0 by the super watchdog (0x12), core 1 by reset code 0x55\n"));
    memset(tiny, 'Z', sizeof tiny);
    n = cr_format_hw(&hw, tiny, sizeof tiny);
    assert(n < sizeof tiny && tiny[n] == '\0');
    puts("test_crash_record: ok");
    return 0;
}
