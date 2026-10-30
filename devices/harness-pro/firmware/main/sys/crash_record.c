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

// The P4's raw reset codes (soc/reset_reasons.h), in words. The reset level matters: a core reset restarts the
// CPUs and the digital core, a CPU reset only the CPUs.
typedef struct { unsigned code; const char *name; const char *level; } cause_t;
static const cause_t CAUSES[] = {
    { 0x01, "power-on", NULL },               { 0x03, "software", "core reset" },
    { 0x05, "power-down", NULL },             { 0x07, "the HP watchdog", "core reset" },
    { 0x09, "the LP watchdog", "core reset" }, { 0x0B, "the HP watchdog", "CPU reset" },
    { 0x0C, "software", "CPU reset" },        { 0x0D, "the LP watchdog", "CPU reset" },
    { 0x0F, "brownout", NULL },               { 0x10, "the LP watchdog", "system reset" },
    { 0x12, "the super watchdog", NULL },     { 0x13, "a power glitch", NULL },
    { 0x14, "an eFuse CRC error", NULL },     { 0x16, "USB JTAG", NULL },
    { 0x17, "USB serial", NULL },             { 0x18, "JTAG", NULL },
    { 0x1A, "a CPU lockup", NULL },           { 0x1B, "a supply glitch", NULL },
};

static const cause_t *cause_of(unsigned code)
{
    for (size_t i = 0; i < sizeof CAUSES / sizeof CAUSES[0]; i++) if (CAUSES[i].code == code) return &CAUSES[i];
    return NULL;
}

size_t cr_format_hw(const cr_hw_t *hw, char *out, size_t cap)
{
    if (!cap) return 0;
    size_t n = 0;
    out[0] = '\0';
#define ADD(...) do { if (n < cap) { int w = snprintf(out + n, cap - n, __VA_ARGS__); if (w > 0) n = n + (size_t)w < cap ? n + (size_t)w : cap - 1; } } while (0)
    ADD("crumbs: hardware reset:");
    for (unsigned i = 0; i < 2; i++) {
        const cause_t *c = cause_of(hw->cause[i]);
        if (!c)            ADD("%s core %u by reset code 0x%02x", i ? "," : "", i, hw->cause[i]);
        else if (c->level) ADD("%s core %u by %s (%s, 0x%02x)", i ? "," : "", i, c->name, c->level, hw->cause[i]);
        else               ADD("%s core %u by %s (0x%02x)", i ? "," : "", i, c->name, hw->cause[i]);
    }
    ADD("\n");
    if (hw->have_pc) {
        ADD("crumbs: hardware record (addr2line against this build's ELF): core 0 pc 0x%08x sp 0x%08x, core 1 pc 0x%08x sp 0x%08x\n",
            (unsigned)hw->pc[0], (unsigned)hw->sp[0], (unsigned)hw->pc[1], (unsigned)hw->sp[1]);
    }
#undef ADD
    return n;
}
