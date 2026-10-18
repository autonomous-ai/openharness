// fmt_elapsed / fmt_elapsed_next_ms: the one elapsed-time format (main/elapsed.c).
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "elapsed.h"

static void is(int64_t secs, const char *want)
{
    char b[FMT_ELAPSED_MAX];
    size_t n = fmt_elapsed(b, sizeof b, secs);
    if (strcmp(b, want) || n != strlen(want)) {
        fprintf(stderr, "fmt_elapsed(%lld) = \"%s\" (%zu), want \"%s\"\n", (long long)secs, b, n, want);
        assert(0);
    }
}
static void next(int64_t secs, uint32_t want)
{
    if (fmt_elapsed_next_ms(secs) != want) {
        fprintf(stderr, "next_ms(%lld) = %u, want %u\n", (long long)secs, fmt_elapsed_next_ms(secs), want);
        assert(0);
    }
}

int main(void)
{
    is(0, "0:00"); is(7, "0:07"); is(59, "0:59"); is(60, "1:00"); is(135, "2:15"); is(3599, "59:59");
    is(3600, "1h"); is(3659, "1h"); is(3660, "1h 1m"); is(3900, "1h 5m"); is(86399, "23h 59m");
    is(86400, "1d"); is(86400 + 3599, "1d"); is(90000, "1d 1h"); is(604799, "6d 23h");
    is(604800, "7d"); is(934740, "10d"); is(99 * 86400 + 86399, "99d");
    is(100 * 86400 - 1, "99d"); is(100 * 86400, "99d+"); is(8640000, "99d+"); is((int64_t)1 << 40, "99d+");
    is(-1, ""); is(-5, ""); is(INT64_MIN, "");
    // longest string fits 7 characters
    char b[FMT_ELAPSED_MAX];
    assert(fmt_elapsed(b, sizeof b, 86399) == 7);
    // truncation keeps the NUL
    char t[4];
    assert(fmt_elapsed(t, sizeof t, 86399) == 3 && !strcmp(t, "23h"));
    assert(fmt_elapsed(t, 1, 5) == 0 && !t[0]);

    next(0, 1000); next(3599, 1000);
    next(3600, 60000); next(3659, 1000); next(3660, 60000); next(86399, 1000); next(86340, 60000);
    next(86400, 3600000); next(86400 + 3599, 1000); next(604799, 1000);
    next(7 * 86400, 3600000); next(100 * 86400 - 1, 1000);
    next(100 * 86400, 0); next(-1, 0);
    // The string must not change before next_ms and must change at it.
    for (int64_t s = 0; s < 3 * 86400; s += (s < 4000 ? 1 : 37)) {
        char a[FMT_ELAPSED_MAX], c[FMT_ELAPSED_MAX], d[FMT_ELAPSED_MAX];
        fmt_elapsed(a, sizeof a, s);
        uint32_t ms = fmt_elapsed_next_ms(s);
        fmt_elapsed(c, sizeof c, s + ms / 1000 - 1);
        fmt_elapsed(d, sizeof d, s + ms / 1000);
        assert(!strcmp(a, c) && strcmp(a, d));
    }
    puts("test_elapsed OK");
    return 0;
}
