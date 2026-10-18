// The one elapsed-time format for every timer the dial shows (working line, "finished in", tab rows).
// Pure C, no dependencies, so the host tests compile it as is.
//
//   < 1 h        M:SS     0:07  2:15  59:59
//   1 h  .. 24 h Hh Mm    1h  1h 5m  23h 59m
//   1 d  ..  7 d Dd Hh    1d  1d 1h  6d 23h
//   7 d  ..100 d Dd       7d  10d  99d
//   >= 100 d     99d+
//
// Always floored, never rounded up. At most two units, largest first, a zero second unit left out, no
// leading zero on it. The longest string is "23h 59m" (7 characters).
#pragma once
#include <stddef.h>
#include <stdint.h>

#define FMT_ELAPSED_MAX 8   // longest string plus its NUL

// Writes the text for `secs` into out (at most n bytes, always NUL-terminated when n > 0) and returns its
// length. secs < 0 means unknown or clock-skewed: writes "" and returns 0, so nothing is drawn.
size_t fmt_elapsed(char *out, size_t n, int64_t secs);

// Milliseconds until the text for `secs` can next change, measured from the start of that second:
// 1000 under 1 h, to the next minute boundary under 24 h, to the next hour boundary after that.
// Returns 0 when it never changes again (>= 100 d, or secs < 0).
uint32_t fmt_elapsed_next_ms(int64_t secs);
