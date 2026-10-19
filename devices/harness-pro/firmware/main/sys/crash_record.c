#include "crash_record.h"

#include <stdio.h>
#include <string.h>

static const char *const SLOT_NAME[CR_SLOTS] = { "cable", "render", "voice" };

void cr_init(crash_record_t *r)
{
    memset(r, 0, sizeof *r);
    r->magic = CR_MAGIC;
}

bool cr_valid(const crash_record_t *r) { return r->magic == CR_MAGIC && r->npc <= CR_PCS; }

void cr_phase(crash_record_t *r, unsigned slot, const char *phase, uint32_t now_ms)
{
    if (slot >= CR_SLOTS) return;
    if (strncmp(r->slot[slot].name, phase, CR_NAME - 1) != 0) {   // same phase again: only the clock moves
        strncpy(r->slot[slot].name, phase, CR_NAME - 1);
        r->slot[slot].name[CR_NAME - 1] = '\0';
    }
    r->slot[slot].ms = now_ms;
    r->up_ms = now_ms;
}

size_t cr_format(const crash_record_t *r, char *out, size_t cap)
{
    if (!cap) return 0;
    size_t n = 0;
    out[0] = '\0';
#define ADD(...) do { if (n < cap) { int w = snprintf(out + n, cap - n, __VA_ARGS__); if (w > 0) n = n + (size_t)w < cap ? n + (size_t)w : cap - 1; } } while (0)
    ADD("crumbs: alive until %u ms, last cable byte %u ms, internal heap %u free / %u lowest\n",
        (unsigned)r->up_ms, (unsigned)r->rx_ms, (unsigned)r->free_int, (unsigned)r->min_int);
    for (unsigned i = 0; i < CR_SLOTS; i++) {
        if (!r->slot[i].name[0]) continue;
        char name[CR_NAME];   // a torn write must not run the %s past the record
        memcpy(name, r->slot[i].name, sizeof name);
        name[CR_NAME - 1] = '\0';
        ADD("crumbs: %s task: %s at %u ms\n", SLOT_NAME[i], name, (unsigned)r->slot[i].ms);
    }
    if (r->panicked) {
        ADD("crumbs: panic backtrace (addr2line against this build's ELF):");
        for (uint32_t i = 0; i < r->npc && i < CR_PCS; i++) ADD(" 0x%08x", (unsigned)r->pc[i]);
        ADD("\n");
    }
#undef ADD
    return n;
}
