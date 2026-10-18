#include "elapsed.h"
#include <stdio.h>

#define MIN 60LL
#define HOUR 3600LL
#define DAY 86400LL

size_t fmt_elapsed(char *out, size_t n, int64_t secs)
{
    if (!out || !n) return 0;
    char tmp[FMT_ELAPSED_MAX + 8];
    int len = 0;
    if (secs < 0) tmp[0] = 0;
    else if (secs < HOUR) len = snprintf(tmp, sizeof tmp, "%d:%02d", (int)(secs / MIN), (int)(secs % MIN));
    else if (secs < DAY) {
        int h = (int)(secs / HOUR), m = (int)(secs % HOUR / MIN);
        len = m ? snprintf(tmp, sizeof tmp, "%dh %dm", h, m) : snprintf(tmp, sizeof tmp, "%dh", h);
    } else if (secs < 7 * DAY) {
        int d = (int)(secs / DAY), h = (int)(secs % DAY / HOUR);
        len = h ? snprintf(tmp, sizeof tmp, "%dd %dh", d, h) : snprintf(tmp, sizeof tmp, "%dd", d);
    } else if (secs < 100 * DAY) len = snprintf(tmp, sizeof tmp, "%dd", (int)(secs / DAY));
    else len = snprintf(tmp, sizeof tmp, "99d+");
    size_t k = 0;
    for (; k + 1 < n && k < (size_t)len; k++) out[k] = tmp[k];
    out[k] = 0;
    return k;
}

uint32_t fmt_elapsed_next_ms(int64_t secs)
{
    if (secs < 0 || secs >= 100 * DAY) return 0;
    if (secs < HOUR) return 1000;
    int64_t unit = secs < DAY ? MIN : HOUR;
    return (uint32_t)((unit - secs % unit) * 1000);
}
