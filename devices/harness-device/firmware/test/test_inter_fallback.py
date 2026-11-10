"""The Inter faces keep Vietnamese's Latin Extended-A letters and those with no one-letter base; every other letter draws its base letter."""
from pathlib import Path
import os
import subprocess
import tempfile

here = Path(__file__).resolve().parent
native = here.parent / 'main/ui/habitat'

code = r'''
#include "terminal.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
extern const ht_pfont_t ht_lv_inter_20;
static uint16_t buf[HT_WIDTH * HT_HEIGHT];
static int index_of(const ht_pfont_t *f, unsigned cp) {
    for (unsigned i = 0; i < f->count; i++) if (f->codes[i] == cp) return (int)i;
    return -1;
}
static void render(const char *text) {
    ht_scene_t s;
    ht_scene_clear(&s, 0);
    assert(ht_text(&s, 20, 100, 400, &ht_lv_inter_20.base, 0xffff, 0, text));
    ht_raster(&s, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, buf);
}
static uint16_t other[HT_WIDTH * HT_HEIGHT];
// 1 when the two strings draw the same pixels.
static int same(const char *a, const char *b) {
    render(a); memcpy(other, buf, sizeof buf);
    render(b);
    return !memcmp(other, buf, sizeof buf);
}
int main(void) {
    const ht_pfont_t *f = &ht_lv_inter_20;
    assert(index_of(f, 0x15B) < 0);                       // s with acute: cut
    assert(index_of(f, 0x103) >= 0);                      // a with breve: Vietnamese, kept
    static const unsigned keep[] = {0x102,0x103,0x110,0x111,0x128,0x129,0x168,0x169,0x1A0,0x1A1,0x1AF,0x1B0,0xF3,0x1EA0,0x1EF9};
    for (unsigned i = 0; i < sizeof keep / sizeof *keep; i++) assert(index_of(f, keep[i]) >= 0);
    // Every Latin Extended-A letter draws something other than '?': its own glyph or a one-letter base.
    for (unsigned cp = 0x100; cp <= 0x17F; cp++) {
        char utf8[3] = {(char)(0xC0 | (cp >> 6)), (char)(0x80 | (cp & 0x3F)), 0};
        if (cp == 0x149 || !same(utf8, "?")) continue;   // Inter has no U+0149 and the table gives it two letters
        printf("U+%04X draws '?'\n", cp);
        assert(0);
    }
    for (unsigned i = 0; i < 9; i++) {                   // letters with no one-letter base keep their own glyph
        static const unsigned own[] = {0x132,0x133,0x138,0x13F,0x140,0x14A,0x14B,0x152,0x153};
        assert(index_of(f, own[i]) >= 0);
    }
    assert(same("\xC5\x9B", "s"));                        // s with acute draws s
    assert(!same("\xC4\x83", "a"));                       // a with breve keeps its own glyph
    assert(!same("\xC5\x9B", "?"));
    // A cut letter beside kept ones: base letters for the cut, no '?'.
    assert(same("\xC5\x81\xC3\xB3\x64\xC5\xBA Krak\xC3\xB3w", "L\xC3\xB3" "dz Krak\xC3\xB3w"));
    assert(!same("\xC5\x81\xC3\xB3\x64\xC5\xBA Krak\xC3\xB3w", "?\xC3\xB3" "d? Krak\xC3\xB3w"));
    // Vietnamese: every letter has its own glyph, so the sentence has no '?' and no base-letter stand-in.
    const char *vi = "H\xC3\xA0 N\xE1\xBB\x99i, \xC4\x90\xC3\xA0 N\xE1\xBA\xB5ng, Hu\xE1\xBA\xBF";
    assert(!same(vi, "Ha Noi, Da Nang, Hue"));
    assert(!same(vi, "H? N?i, ?? N?ng, Hu?"));
    puts("Inter fallback PASS");
}
'''
sources = ['lvgl_fonts.c', 'lvgl_icons.c', 'focus_marks.c', 'focus_faces.c', 'terminal.c', 'fonts.c']
with tempfile.TemporaryDirectory(prefix='harness-inter-fallback-') as directory:
    out = Path(directory)
    (out / 'test.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
        '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
        '-I', str(native), '-I', str(native.parent.parent), str(out / 'test.c'), *(str(native / f) for f in sources),
        '-o', str(out / 'test'), '-lm'], check=True)
    subprocess.run([str(out / 'test')], check=True)
