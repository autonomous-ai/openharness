// crash_record.c: the breadcrumb record's phases and its text for the daemon. Host-only, pure.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "crash_record.h"

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
    puts("test_crash_record: ok");
    return 0;
}
