#include "cable_scroll.h"
#include <limits.h>
#include <stdint.h>
#include <string.h>

_Static_assert(INT_MAX == INT32_MAX && INT_MIN == INT32_MIN, "scroll uses signed 32-bit integers");
_Static_assert(CABLE_SCROLL_JSON_MAX >= sizeof("{\"t\":\"scroll\",\"phase\":\"down\",\"dy\":,\"v\":}") + 22,
               "room for every literal, two INT_MIN values, and NUL");

static char *decimal(char *out, int value)
{
    // Unsigned subtraction handles INT_MIN without signed overflow.
    uint32_t n = value < 0 ? 0u - (uint32_t)value : (uint32_t)value;
    char digits[10];
    unsigned used = 0;
    do { digits[used++] = (char)('0' + n % 10); n /= 10; } while (n);
    if (value < 0) *out++ = '-';
    while (used) *out++ = digits[--used];
    return out;
}

size_t cable_scroll_encode(char *out, size_t capacity, int phase, int dy, int velocity)
{
    if (!out || !capacity) return 0;
    out[0] = 0;
    static const char *const names[] = {"down", "move", "up"};
    if ((unsigned)phase >= sizeof names / sizeof names[0]) return 0;
    // Only fixed literals and integers enter this message. No escaping, locale,
    // varargs formatter, allocator or persistent buffer is needed on this path.
    char wire[CABLE_SCROLL_JSON_MAX], *p = wire;
#define PUT(literal) do { memcpy(p, literal, sizeof(literal) - 1); p += sizeof(literal) - 1; } while (0)
    PUT("{\"t\":\"scroll\",\"phase\":\"");
    size_t name_bytes = phase == 2 ? 2 : 4;
    memcpy(p, names[phase], name_bytes); p += name_bytes;
    PUT("\",\"dy\":");
    p = decimal(p, dy);
    if (phase == 2) { PUT(",\"v\":"); p = decimal(p, velocity); }
    *p++ = '}';
    *p = 0;
#undef PUT
    size_t n = (size_t)(p - wire);
    if (n >= capacity) return 0;
    memcpy(out, wire, n + 1);
    return n;
}
