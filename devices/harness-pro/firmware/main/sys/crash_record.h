// The breadcrumb record kept in RTC memory (last_words.c owns the memory): what each task was doing, when,
// and the panic's backtrace. Pure data and text, so it is host-tested; nothing here touches the IDF.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CR_MAGIC 0x43524244u   // "CRBD"
#define CR_PCS 12              // backtrace entries kept
#define CR_SLOTS 3             // one phase per task that can hang on its own
#define CR_NAME 12

typedef struct {
    char     name[CR_NAME];    // the phase, e.g. "ota.write"; empty = never set
    uint32_t ms;               // uptime when it was set
} cr_slot_t;

typedef struct {
    uint32_t  magic;
    uint32_t  up_ms;           // uptime at the latest breadcrumb: the device was alive at least this long
    uint32_t  rx_ms;           // uptime of the last byte from the cable
    uint32_t  free_int;        // internal heap free / lowest-ever, sampled with the breadcrumbs
    uint32_t  min_int;
    uint32_t  panicked;        // the panic handler ran (and filled pc[])
    uint32_t  npc;
    uint32_t  pc[CR_PCS];
    cr_slot_t slot[CR_SLOTS];
} crash_record_t;

void cr_init(crash_record_t *r);
bool cr_valid(const crash_record_t *r);
void cr_phase(crash_record_t *r, unsigned slot, const char *phase, uint32_t now_ms);
// Text for the daemon's log, one '\n'-separated line per fact. Returns the length (always NUL-terminated).
size_t cr_format(const crash_record_t *r, char *out, size_t cap);

// What the hardware kept across the reset (wdt_pc.h): each core's raw reset code and, when the bootloader
// saved them, each core's last PC and SP.
typedef struct {
    unsigned cause[2];
    bool     have_pc;
    uint32_t pc[2];
    uint32_t sp[2];
} cr_hw_t;

// Same contract as cr_format.
size_t cr_format_hw(const cr_hw_t *hw, char *out, size_t cap);
