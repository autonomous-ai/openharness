// pod_time: the one elapsed-time format and its redraw cadence.
#include "pod/pod_time.h"
#include "pod/pod_view.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int checks;
static void fmt(int64_t secs, const char *want)
{
    char b[16];
    size_t n = pod_fmt_elapsed(b, sizeof b, secs);
    if (strcmp(b, want) || n != strlen(want)) { fprintf(stderr, "FAIL %lld -> \"%s\" (%zu), want \"%s\"\n", (long long)secs, b, n, want); exit(1); }
    checks++;
}
static void nxt(int64_t secs, uint32_t want)
{
    uint32_t got = pod_elapsed_next_ms(secs);
    if (got != want) { fprintf(stderr, "FAIL next_ms(%lld) = %u, want %u\n", (long long)secs, (unsigned)got, (unsigned)want); exit(1); }
    checks++;
}

int main(void)
{
    fmt(0, "0:00"); fmt(7, "0:07"); fmt(135, "2:15"); fmt(3599, "59:59");
    fmt(3600, "1h"); fmt(3900, "1h 5m"); fmt(3660, "1h 1m"); fmt(3659, "1h"); fmt(86399, "23h 59m");
    fmt(86400, "1d"); fmt(90000, "1d 1h"); fmt(86400 + 3599, "1d"); fmt(604799, "6d 23h");
    fmt(604800, "7d"); fmt(934740, "10d"); fmt(99 * 86400 + 86399, "99d");
    fmt(8640000, "99d+"); fmt(86400LL * 4000, "99d+");
    fmt(-1, ""); fmt(-5, "");
    char b[4] = "xxx";
    if (pod_fmt_elapsed(b, sizeof b, 135) != 3 || strcmp(b, "2:1")) { fprintf(stderr, "FAIL cut: \"%s\"\n", b); return 1; }   // cut to n - 1, still terminated
    checks++;
    if (pod_fmt_elapsed(b, 0, 135) != 0 || strcmp(b, "2:1")) { fprintf(stderr, "FAIL n == 0 wrote\n"); return 1; }
    checks++;
    nxt(0, 1000); nxt(59, 1000); nxt(3599, 1000);
    nxt(3600, 60000); nxt(3630, 30000); nxt(3659, 1000); nxt(86399, 1000);
    nxt(86400, 3600000); nxt(90000, 3600000); nxt(90000 + 1800, 1800000); nxt(86400 * 200 + 3599, 1000);
    nxt(-1, UINT32_MAX);
    {   // a working agent's clock: when its text next changes, from where it is in its second; a resting agent has none
        pod_agent_t a;
        memset(&a, 0, sizeof a);
        a.state = POD_WORKING; a.elapsed_s = 59; a.event_ms = 10000;
        if (pod_agent_timer_ms(&a, 10000) != 1000 || pod_agent_timer_ms(&a, 10250) != 750) { fprintf(stderr, "FAIL timer m:ss\n"); return 1; }
        a.elapsed_s = 3600;   // "1h": the minute turns in 60 s, less the 400 ms already run
        if (pod_agent_timer_ms(&a, 10400) != 59600) { fprintf(stderr, "FAIL timer h\n"); return 1; }
        a.elapsed_s = 90000;   // 1d 1h, 61 s on: the hour turns in 3539 s
        if (pod_agent_timer_ms(&a, 10000 + 61000) != 3539000u) { fprintf(stderr, "FAIL timer d: %u\n", (unsigned)pod_agent_timer_ms(&a, 71000)); return 1; }
        a.state = POD_DONE;
        if (pod_agent_timer_ms(&a, 10000) != UINT32_MAX || pod_agent_timer_ms(NULL, 0) != UINT32_MAX) { fprintf(stderr, "FAIL timer resting\n"); return 1; }
        checks += 5;
    }
    printf("test_pod_time: %d checks ok\n", checks);
    return 0;
}
