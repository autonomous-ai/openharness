// The ASCII shortcut must produce exactly the original damage rectangles,
// including UTF-8 aliases, malformed bytes and missing trailing space cells.
#include "../main/ui/habitat/terminal.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint32_t rng = 0x61ad349b;
static unsigned next(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
static void compare(const ht_scene_t *a, const ht_scene_t *b)
{
    ht_damage_t reference, fast;
    ht_damage_fast_ascii(false); ht_damage(a, b, &reference);
    ht_damage_fast_ascii(true); ht_damage(a, b, &fast);
    assert(!memcmp(&reference, &fast, sizeof fast));
}
static void random_text(char *out, size_t capacity)
{
    static const char *tokens[] = {" ","  ",".","@",":","x","o","*","!","A","z",
        "—","“","é","↗","█","🐙","\1","\x7f","\xff","\xc2","\xe2\x80","\xf0\x9f"};
    size_t used = 0;
    unsigned count = next() % 60;
    for (unsigned i = 0; i < count; i++) {
        const char *token = tokens[next() % (sizeof tokens / sizeof tokens[0])];
        size_t n = strlen(token);
        if (used + n >= capacity) break;
        memcpy(out + used, token, n); used += n;
    }
    out[used] = 0;
}
int main(void)
{
    static const uint8_t block_pixels[] = {255,255,255,255};
    const ht_font_t blocks = {0x2588,0x2588,4,4,block_pixels};
    const ht_font_t *fonts[] = {&ht_mono_16, &ht_mono_20, &ht_mono_24, &ht_mono_28,
        &ht_open_20, &blocks};
    ht_scene_t a, b;
    for (unsigned trial = 0; trial < 100000; trial++) {
        uint16_t bg = next();
        ht_scene_clear(&a, bg); ht_scene_clear(&b, bg);
        for (unsigned row = 0, count = 1 + next() % 8; row < count; row++) {
            char before[128], after[128];
            random_text(before, sizeof before); random_text(after, sizeof after);
            const ht_font_t *font = fonts[next() % (sizeof fonts / sizeof fonts[0])];
            int x = (int)(next() % 160) - 40, y = (int)(next() % 460) - 20;
            int width = 1 + next() % 400;
            uint16_t fg = next();
            ht_text(&a, x, y, width, font, fg, bg, before);
            ht_text(&b, x, y, width, font, fg, bg, after);
            if (next() % 10 == 0) b.runs[row].x++;
            if (next() % 10 == 0) b.runs[row].fg++;
            if (next() % 5 == 0) b.runs[row] = a.runs[row];
        }
        compare(&a, &b); compare(&b, &a);
        compare(NULL, &b); compare(&a, &a);
    }
    puts("ASCII damage: 400000 original/fast comparisons; exact rectangles, Unicode aliases and malformed bytes PASS");
}
