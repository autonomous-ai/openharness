// The one elapsed-time format of the Pro, every screen (owner rule): floor, at most two units largest first, a zero second unit
// dropped, no leading zero on it, one space between.
//   < 1 h   M:SS    0:07  2:15  59:59
//   < 24 h  Hh Mm   1h  1h 5m  23h 59m
//   < 7 d   Dd Hh   1d  1d 1h  6d 23h
//   < 100 d Dd      7d  99d
//   else    99d+
// The longest text is "23h 59m" (7 characters): layouts must fit it.
#pragma once
#include <stddef.h>
#include <stdint.h>

// Writes the text for `secs` into out (NUL-terminated, cut to n). A negative `secs` is unknown: writes "" (never "-0:03", never
// "0:00"). Each call site keeps its own meaning of unknown (a model's elapsed_s -1, a Done turn with no length) and passes -1.
size_t pod_fmt_elapsed(char *out, size_t n, int64_t secs);

// Milliseconds from the start of second `secs` until the text next changes: 1000 under an hour, to the next minute under a
// day, to the next hour after. UINT32_MAX for a negative `secs` (nothing is shown, nothing to redraw). Redraw cadence
// follows the smallest unit shown, so an unchanged timer is not redrawn.
uint32_t pod_elapsed_next_ms(int64_t secs);
