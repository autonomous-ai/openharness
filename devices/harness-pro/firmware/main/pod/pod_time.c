#include "pod_time.h"
#include <stdio.h>

size_t pod_fmt_elapsed(char *out, size_t n, int64_t secs)
{
    if (!n) return 0;
    int w;
    if (secs < 0) w = 0, out[0] = 0;
    else if (secs < 3600) w = snprintf(out, n, "%d:%02d", (int)(secs / 60), (int)(secs % 60));
    else if (secs < 86400) {
        int h = (int)(secs / 3600), m = (int)(secs % 3600 / 60);
        w = m ? snprintf(out, n, "%dh %dm", h, m) : snprintf(out, n, "%dh", h);
    } else if (secs < 7 * 86400) {
        int d = (int)(secs / 86400), h = (int)(secs % 86400 / 3600);
        w = h ? snprintf(out, n, "%dd %dh", d, h) : snprintf(out, n, "%dd", d);
    } else if (secs < 100 * 86400) w = snprintf(out, n, "%dd", (int)(secs / 86400));
    else w = snprintf(out, n, "99d+");
    if (w < 0) { out[0] = 0; return 0; }
    return (size_t)w < n ? (size_t)w : n - 1;
}

uint32_t pod_elapsed_next_ms(int64_t secs)
{
    if (secs < 0) return UINT32_MAX;
    if (secs < 3600) return 1000;
    if (secs < 86400) return (uint32_t)(60 - secs % 60) * 1000u;
    return (uint32_t)(3600 - secs % 3600) * 1000u;
}
