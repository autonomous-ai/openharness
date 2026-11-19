// The screen (max_ui.h), 1920 x 480 (or 415): one of Demo V2's pages over the whole glass (max_m.view), in the dial's
// look; New Harness over it while it is up, the update screen instead of it. Over the page the toast of a question that
// came while a person talks, a finished turn's note, and the notice pill. Here too what the page files share: text,
// shapes, icons, buttons and what moves by the clock. Inter faces (gen_fonts.py ph_*): at the Max's 225 ppi they come
// out a little larger than on the Pro's 258.
#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "max_ui_draw.h"
#include "max_ui_icons.h"
#include "max_ui_motion.h"
#include "pod/pod_mem.h"   // EXT_RAM_BSS_ATTR: what a going overlay said, the halo's image

static const char ELLIPSIS[] = "\xe2\x80\xa6";   // the Inter faces draw it (gen_fonts.py CONSOLE_EXTRA)

// ---- text ----

// Whether t's first n bytes and an ellipsis fit `width` px (out: scratch).
static bool fits_cut(char out[ROW_BYTES], const char *t, size_t n, const ht_pro_font_t *f, int width)
{
    memcpy(out, t, n);
    memcpy(out + n, ELLIPSIS, sizeof ELLIPSIS);
    return ht_pro_width(f, out) <= width;
}
// t as one run of at most `width` px: whole when it fits, else as many letters as fit before an ellipsis, with no space
// or comma left before it. With `words`, between words when that keeps at least half of what fits. A wider prefix never
// measures narrower, so the cut is a binary search over the code points that fit in a run.
void max_cut(char out[ROW_BYTES], const char *t, const ht_pro_font_t *f, int width, bool words)
{
    const size_t len = strlen(t);
    if (len < ROW_BYTES) {
        memcpy(out, t, len + 1);
        if (ht_pro_width(f, out) <= width) return;
    }
    uint8_t at[ROW_BYTES];   // code point ends
    int ends = 0;
    for (size_t n = 0; t[n];) {
        size_t next = n + 1;
        while (((unsigned char)t[next] & 0xc0) == 0x80) next++;
        if (next + sizeof ELLIPSIS > ROW_BYTES) break;
        at[ends++] = (uint8_t)(n = next);
    }
    int lo = 0, hi = ends;   // the first `lo` ends fit
    while (lo < hi) {
        const int mid = (lo + hi + 1) / 2;
        if (fits_cut(out, t, at[mid - 1], f, width)) lo = mid;
        else hi = mid - 1;
    }
    size_t n = lo ? at[lo - 1] : 0, space = n;
    while (space && t[space] != ' ') space--;
    if (words && space > n / 2) n = space;
    // Nor an ellipsis already there: a name the model cut ends in one (max_copy_label).
    for (bool more = true; more;) {
        while (n && strchr(" ,;:", t[n - 1])) n--;
        more = n >= sizeof ELLIPSIS - 1 && !memcmp(t + n - (sizeof ELLIPSIS - 1), ELLIPSIS, sizeof ELLIPSIS - 1);
        if (more) n -= sizeof ELLIPSIS - 1;
    }
    memcpy(out, t, n);
    memcpy(out + n, ELLIPSIS, sizeof ELLIPSIS);
}
// The cell's baseline sits at 1/1.375 of its height.
int max_top_of(const ht_pro_font_t *f, int cy) { return cy - f->height * 15 / 32; }
int max_text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char row[ROW_BYTES];
    if (!t || !t[0] || w <= 0 || x >= HT_WIDTH) return 0;   // past the glass (a card it cuts): not a run spent
    max_cut(row, t, f, w, false);
    const int tw = ht_pro_width(f, row);
    ht_pro_text(s, x, max_top_of(f, cy), tw, f, C(rgb), row);
    return tw;
}
int max_text_right(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char row[ROW_BYTES];
    if (!t || !t[0] || w <= 0) return 0;
    max_cut(row, t, f, w, false);
    const int tw = ht_pro_width(f, row);
    ht_pro_text(s, x - tw, max_top_of(f, cy), tw, f, C(rgb), row);
    return tw;
}
void max_text_centered(ht_scene_t *s, int cx, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char row[ROW_BYTES];
    if (!t || !t[0] || w <= 0) return;
    max_cut(row, t, f, w, false);
    const int tw = ht_pro_width(f, row);
    ht_pro_text(s, cx - tw / 2, max_top_of(f, cy), tw, f, C(rgb), row);
}
void max_dot(ht_scene_t *s, int x, int cy, int d, unsigned rgb)
{
    if (x < HT_WIDTH) ht_pro_rect_aa(s, x, cy - d / 2, d, d, d / 2, C(rgb));
}

// The bytes of t that fill a row of `width` px, ending at a word; a first word wider than the row is cut by letters.
size_t max_fit(const char *t, const ht_pro_font_t *f, int width)
{
    char row[ROW_BYTES];
    size_t best = 0;
    for (;;) {
        size_t e = best;
        while (t[e] == ' ') e++;
        if (!t[e]) break;
        while (t[e] && t[e] != ' ') e++;
        if (e >= sizeof row) break;
        memcpy(row, t, e);
        row[e] = 0;
        if (ht_pro_width(f, row) > width) break;
        best = e;
    }
    if (best) return best;
    size_t n = 0;
    while (t[n]) {
        size_t next = n + 1;
        while (((unsigned char)t[next] & 0xc0) == 0x80) next++;
        if (next >= sizeof row) break;
        memcpy(row, t, next);
        row[next] = 0;
        if (n && ht_pro_width(f, row) > width) break;
        n = next;
    }
    return n;
}
int max_wrap(char rows[][ROW_BYTES], int max_rows, const char *t, const ht_pro_font_t *f, int w)
{
    if (max_rows > MAX_ROWS) max_rows = MAX_ROWS;
    int n = 0;
    for (; n < max_rows && t; n++) {
        while (*t == ' ') t++;
        if (!*t) break;
        if (n == max_rows - 1) {   // the last row takes the rest
            max_cut(rows[n++], t, f, w, true);
            break;
        }
        const size_t len = max_fit(t, f, w);
        memcpy(rows[n], t, len);
        rows[n][len] = 0;
        t += len;
    }
    return n;
}
int max_paragraph(ht_scene_t *s, int x, int y, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, int max_rows)
{
    char rows[MAX_ROWS][ROW_BYTES];
    const int n = max_wrap(rows, max_rows, t, f, w);
    for (int i = 0; i < n && x < HT_WIDTH; i++) ht_pro_text(s, x, y + i * f->height, w, f, C(rgb), rows[i]);
    return y + n * f->height;
}

bool max_big_can_draw(const char *t)
{
    for (const char *p = t; *p; p++) {
        const unsigned char c = (unsigned char)*p;
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || strchr(".-+_% ", c)) continue;
        if (!strncmp(p, ELLIPSIS, sizeof ELLIPSIS - 1)) {
            p += sizeof ELLIPSIS - 2;
            continue;
        }
        return false;
    }
    return true;
}

// The colon of a clock: two dots d across, in a slot three dots wide.
static int colon_d(const ht_pro_font_t *f) { return f->height / 12 > 2 ? f->height / 12 : 2; }
int max_clock_w(const ht_pro_font_t *f, const char *t)
{
    char part[16];
    int w = 0;
    while (*t) {
        const char *colon = strchr(t, ':');
        const size_t n = colon ? (size_t)(colon - t) : strlen(t);
        snprintf(part, sizeof part, "%.*s", (int)n, t);
        w += ht_pro_width(f, part) + (colon ? 3 * colon_d(f) : 0);
        t += n + (colon ? 1 : 0);
    }
    return w;
}
void max_clock(ht_scene_t *s, int x, int cy, const ht_pro_font_t *f, unsigned rgb, const char *t)
{
    char part[16];
    const int d = colon_d(f), off = f->height * 11 / 100;   // the dots sit either side of the digits' middle
    while (*t) {
        const char *colon = strchr(t, ':');
        const size_t n = colon ? (size_t)(colon - t) : strlen(t);
        snprintf(part, sizeof part, "%.*s", (int)n, t);
        const int pw = ht_pro_width(f, part);
        if (pw) ht_pro_text(s, x, max_top_of(f, cy), pw, f, C(rgb), part);
        x += pw;
        if (colon) {
            ht_pro_rect_aa(s, x + d, cy - off - d / 2, d, d, d / 2, C(rgb));
            ht_pro_rect_aa(s, x + d, cy + off - d / 2, d, d, d / 2, C(rgb));
            x += 3 * d;
        }
        t += n + (colon ? 1 : 0);
    }
}

void max_ago(char *out, size_t cap, uint32_t at, uint32_t now_ms)
{
    const uint32_t secs = (now_ms - at) / 1000u;
    if (secs < 60) snprintf(out, cap, "just now");
    else if (secs < 3600) snprintf(out, cap, "%u min ago", (unsigned)(secs / 60));
    else if (secs < 86400) snprintf(out, cap, "%u h ago", (unsigned)(secs / 3600));
    else snprintf(out, cap, "%u d ago", (unsigned)(secs / 86400));
}

// ---- shapes ----

void max_box(ht_scene_t *s, int x, int y, int w, int h, int r, int line, unsigned edge, unsigned fill)
{
    if (line) {
        ht_pro_rect_aa(s, x, y, w, h, r, C(edge));
        x += line, y += line, w -= 2 * line, h -= 2 * line, r -= line;
    }
    ht_pro_rect_aa(s, x, y, w, h, r > 0 ? r : 0, C(fill));
}
void max_round(ht_scene_t *s, int cx, int cy, int d)
{
    ht_pro_rect_aa_stroke(s, cx - d / 2, cy - d / 2, d, d, d / 2, C(RIM), C(CARD));
}
void max_stroke16(ht_scene_t *s, int x0, int y0, int x1, int y1, int w, unsigned rgb)
{
    const int dx = x1 - x0, dy = y1 - y0, len = (int)ht_pro_isqrt((unsigned)(dx * dx + dy * dy));
    if (!len) return;
    // Half the width across the line, and half along it at each end: the mockup's round caps, squared.
    const int px = -dy * w / (2 * len), py = dx * w / (2 * len), ex = dx * w / (2 * len), ey = dy * w / (2 * len);
    x0 -= ex, y0 -= ey, x1 += ex, y1 += ey;
    pod_tri_inner(s, x0 + px, y0 + py, x1 + px, y1 + py, x1 - px, y1 - py, C(rgb), 1u << 2);
    pod_tri_inner(s, x0 + px, y0 + py, x1 - px, y1 - py, x0 - px, y0 - py, C(rgb), 1u << 0);
}
unsigned max_mix(unsigned a, unsigned b, unsigned pct)
{
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8) out |= ((((a >> sh) & 0xff) * pct + ((b >> sh) & 0xff) * (100 - pct)) / 100) << sh;
    return out;
}
unsigned max_mix_q(unsigned a, unsigned b, int32_t q)
{
    const unsigned k = q < 0 ? 0 : q > MAX_ONE ? MAX_ONE : (unsigned)q;
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8)
        out |= ((((a >> sh) & 0xff) * k + ((b >> sh) & 0xff) * (MAX_ONE - k) + MAX_ONE / 2) >> 12) << sh;
    return out;
}
static unsigned s_toward, s_keep = 256;
static int s_dim;
static max_dim_t s_dim_m;
void max_tint(unsigned toward, unsigned keep)
{
    s_toward = toward;
    s_keep = keep < 256 ? keep : 256;
}
void max_dim(int t)
{
    s_dim = t;
    if (t) s_dim_m = max_dim_of(t);
}
int max_dim_now(void) { return s_dim; }
unsigned max_tinted(unsigned rgb)
{
    unsigned out = rgb;
    if (s_keep < 256) {
        out = 0;
        for (int sh = 0; sh <= 16; sh += 8)
            out |= ((((rgb >> sh) & 0xff) * s_keep + ((s_toward >> sh) & 0xff) * (256 - s_keep) + 128) >> 8) << sh;
    }
    return s_dim ? max_dim_rgb(&s_dim_m, out) : out;
}
void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg)
{
    if (max_m.hit_count >= MAX_HITS) return;
    max_m.hits[max_m.hit_count++] = (max_hit_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, (uint8_t)kind, (int8_t)arg};
}

// ---- icons: the mockup's 24-unit SVG strokes (1.8 units wide) ----

// A point of the 24-unit grid, given in half units, in sixteenths of a px of an icon `size` px from `origin`.
static int at16(int origin, int size, int half_units) { return origin * 16 + half_units * size / 3; }
static void line24(ht_scene_t *s, int x, int y, int size, int x0, int y0, int x1, int y1, unsigned rgb)
{
    max_stroke16(s, at16(x, size, x0), at16(y, size, y0), at16(x, size, x1), at16(y, size, y1), size * 6 / 5, rgb);
}
void max_icon_x(ht_scene_t *s, int x, int y, int size, unsigned rgb)
{
    line24(s, x, y, size, 12, 12, 36, 36, rgb);
    line24(s, x, y, size, 36, 12, 12, 36, rgb);
}
void max_icon_bell(ht_scene_t *s, int x, int y, int size, unsigned rgb)
{
    // M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4: the dome, its sides, the flared rim and the clapper.
    pod_arc(s, at16(x, size, 24), at16(y, size, 22), 6 * size * 2 / 3, size * 6 / 5, 90, 90, C(rgb));
    line24(s, x, y, size, 12, 22, 12, 32, rgb);
    line24(s, x, y, size, 36, 22, 36, 32, rgb);
    line24(s, x, y, size, 12, 32, 9, 36, rgb);
    line24(s, x, y, size, 36, 32, 39, 36, rgb);
    line24(s, x, y, size, 9, 36, 39, 36, rgb);
    line24(s, x, y, size, 20, 41, 28, 41, rgb);
}
void max_icon_grid(ht_scene_t *s, int x, int y, int size, unsigned rgb)
{
    const int side = size * 6 / 24 + 1, line = size > 24 ? 2 : 1;
    for (int i = 0; i < 4; i++)
        max_box(s, x + (i % 2 ? 14 : 4) * size / 24, y + (i / 2 ? 14 : 4) * size / 24, side, side, side / 4 + 1, line, rgb,
                GROUND);
}
void max_icon_mic(ht_scene_t *s, int x, int y, int size, unsigned rgb)
{
    // rect x9 y3 6x11 rx3, M5 11a7 7 0 0 0 14 0, M12 18v3: the capsule (filled), its cradle and its stand.
    ht_pro_rect_aa(s, x + 9 * size / 24, y + 3 * size / 24, 6 * size / 24 + 1, 11 * size / 24, 3 * size / 24, C(rgb));
    pod_arc(s, at16(x, size, 24), at16(y, size, 22), 7 * size * 2 / 3, size * 6 / 5, 270, 90, C(rgb));
    line24(s, x, y, size, 24, 36, 24, 42, rgb);
}

// The colour of an app's icon by its id or name: the mockup's Harness "H", Orca's black, VS Code's blue, else grey.
static unsigned app_tint(const char *app)
{
    if (!strcasecmp(app, "harness")) return 0xD97757;
    if (!strcasecmp(app, "orca")) return 0x111114;
    if (!strcasecmp(app, "vscode") || !strcasecmp(app, "vs code") || !strcasecmp(app, "visual studio code")) return 0x007ACC;
    return 0x3A3B45;
}
const ht_pro_bitmap_t *max_icon_find(const char *app, int size)
{
    char key[24];
    size_t n = 0;
    for (const char *c = app ? app : ""; *c && n + 1 < sizeof key; c++)
        if (isalnum((unsigned char)*c)) key[n++] = (char)tolower((unsigned char)*c);
    key[n] = 0;
    for (const max_icon_t *i = max_icons; n && i->app; i++)
        if (i->image.width == size && !strcmp(i->app, key)) return &i->image;
    return NULL;
}
void max_app_icon(ht_scene_t *s, int x, int y, int size, const char *app, const char *name)
{
    if (x >= HT_WIDTH) return;
    // Its own icon is its own rounded tile, drawn as it is (V3's AppIcon).
    const ht_pro_bitmap_t *own = max_icon_find(app, size);
    if (!own) own = max_icon_find(name, size);
    if (own && ht_pro_image(s, x, y, own)) return;
    const unsigned tint = app_tint(app);
    max_box(s, x, y, size, size, size * 14 / 60, tint == 0x111114 ? 1 : 0, TRACK, tint);
    const char *from = name && name[0] ? name : app;
    char initial[5] = "";
    size_t n = 1;
    while (((unsigned char)from[n] & 0xc0) == 0x80 && n < 4) n++;
    memcpy(initial, from, from[0] ? n : 0);
    initial[from[0] ? n : 0] = 0;
    if (initial[0] >= 'a' && initial[0] <= 'z') initial[0] = (char)(initial[0] - 'a' + 'A');
    const ht_pro_font_t *f = size >= 90 && max_big_can_draw(initial) ? &ph_sb_48 : size >= 66 ? &ph_sb_34
                           : size >= 44 ? &ph_sb_26 : &ph_sb_22;
    max_text_centered(s, x + size / 2, y + size / 2, size, f, 0xFFFFFF, initial);
}

// ---- what an agent's state looks like ----

unsigned max_state_ink(const max_agent_t *a)
{
    switch (a->state) {
    case MAX_WORKING: return ACCENT;
    case MAX_ASKING: return WAIT;
    case MAX_DONE: return DONE;
    case MAX_FAILED: return FAIL;
    default: return FAINT;
    }
}
unsigned max_rail_ink(const max_agent_t *a)
{
    return a->state == MAX_FAILED ? FAIL_RAIL : a->state == MAX_IDLE ? IDLE_RAIL : max_state_ink(a);
}
unsigned max_chip_ink(const max_agent_t *a) { return a->state == MAX_IDLE ? CHIP_IDLE : max_rail_ink(a); }

unsigned max_glow_pct(const max_agent_t *a)
{
    return a->state == MAX_ASKING ? 18 : a->state == MAX_FAILED ? 14 : a->state == MAX_IDLE ? 0 : 8;
}
unsigned max_glow_top(const max_agent_t *a, unsigned under, uint32_t now_ms, bool still)
{
    const unsigned ink = max_chip_ink(a);
    if (still || a->state != MAX_ASKING) return max_mix(ink, under, max_glow_pct(a));
    // In tenths of a percent, rounded down as max_mix rounds: the loop's start is the glow at rest.
    const unsigned pm = (unsigned)max_keyframes(max_loop(now_ms, 1000), 180, 50, MAX_EASE_IN_OUT);
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8)
        out |= ((((ink >> sh) & 0xff) * pm + ((under >> sh) & 0xff) * (1000 - pm)) / 1000) << sh;
    return out;
}

// V3's overlayWhite: each channel under half doubled, the rest white (the sweep's peak over the rail's colour).
static unsigned overlay_white(unsigned c)
{
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8) {
        const unsigned v = (c >> sh) & 0xff;
        out |= (v < 128 ? 2 * v : 255) << sh;
    }
    return out;
}
void max_rail(ht_scene_t *s, int x, int w, const max_agent_t *a, unsigned under, uint32_t now_ms, bool still)
{
    const unsigned c = max_rail_ink(a);
    if (!still && a->state == MAX_ASKING) {
        const int32_t o = max_keyframes(max_loop(now_ms, 1000), MAX_ONE, MAX_PULSE_LOW, MAX_EASE_IN_OUT);
        ht_pro_rect(s, x, 0, w, RAIL_H, 0, C(max_mix_q(c, under, o)));
        return;
    }
    ht_pro_rect(s, x, 0, w, RAIL_H, 0, C(c));
    if (still || a->state != MAX_WORKING) return;
    // The light's start at sweep(p) = -1 + 2.9 p of its lengths along the rail: off it at the loop's start and end.
    const int32_t p = max_loop(now_ms, 1500);
    const int lw = w * 55 / 100, lx = x + (int)(((int64_t)p * 29 / 10 - 65536) * lw >> 16);
    max_layer_light(s, lx, lw, x, x + w, max_tinted(c), max_tinted(overlay_white(c)));
}

// ---- the state chip ----

enum { CHIP_DOT = DX(8), CHIP_GAP = DX(8) };
static int chip_pad(bool small) { return small ? DX(13) : DX(16); }
int max_chip_w(const max_agent_t *a, bool small, int max_w)
{
    const int w = 2 * chip_pad(small) + CHIP_DOT + CHIP_GAP + ht_pro_width(&ph_sb_22, max_status_word(a));
    return w < max_w ? w : max_w;
}
int max_chip(ht_scene_t *s, int x, int cy, const max_agent_t *a, bool small, int max_w, uint32_t now_ms)
{
    const unsigned c = max_chip_ink(a), fill = max_mix(c, GROUND, 15);
    const unsigned words = a->state == MAX_IDLE ? REST : a->state == MAX_FAILED ? FAIL : c;
    const int h = small ? DY(30) : DY(34), pad = chip_pad(small), w = max_chip_w(a, small, max_w);
    const unsigned toward = s_toward, keep = s_keep;
    if (a->state == MAX_ASKING)   // the whole chip by its opacity, over what the tint fades toward
        max_tint(toward, keep * (unsigned)max_keyframes(max_loop(now_ms, 1000), MAX_ONE, MAX_PULSE_LOW,
                                                        MAX_EASE_IN_OUT) / MAX_ONE);
    max_box(s, x, cy - h / 2, w, h, h / 2, 1, max_mix(c, GROUND, 40), fill);
    const int32_t lit = a->state == MAX_WORKING
                            ? max_keyframes(max_loop(now_ms, 1200), MAX_ONE, MAX_ONE / 4, MAX_EASE_IN_OUT) : MAX_ONE;
    max_dot(s, x + pad, cy, CHIP_DOT, max_mix_q(c, fill, lit));   // over the pill
    const int tx = x + pad + CHIP_DOT + CHIP_GAP;
    max_text(s, tx, cy, x + w - pad - tx, &ph_sb_22, words, max_status_word(a));
    max_tint(toward, keep);
    return w;
}

unsigned max_kind_ink(max_attn_t kind) { return kind == MAX_ATTN_ASK ? WAIT : kind == MAX_ATTN_DONE ? DONE : FAIL; }

// ---- buttons ----

enum { LABEL_PAD = 14, MIC_GAP = DX(10) };
#define MIC_SIZE DY(22)
static const struct { unsigned fill, edge, ink; int line; } LOOKS[] = {
    [STYLE_PLAIN] = {CARD, RIM, FG, 1},           // an answer, Say it, the form's own
    [STYLE_CHOSEN] = {CARD, DONE, FG, 2},         // one of several, chosen
    [STYLE_PRIMARY] = {DONE, DONE, ALLOW_INK, 0}, // Allow, Send, the form's action
    [STYLE_REJECT] = {CARD, DENY_RIM, DENY_INK, 2},   // Deny
    [STYLE_GHOST] = {GROUND, RIM, FG, 1},         // Back, Reload
    [STYLE_OFF] = {CARD, RIM, FAINT, 1},          // nothing to press now
};

int max_button_w(const char *label, bool mic, int pad)
{
    return ht_pro_width(&ph_sb_26, label) + 2 * pad + (mic ? MIC_SIZE + MIC_GAP : 0);
}
void max_button(ht_scene_t *s, int x, int y, int w, int h, max_style_t style, const char *label, bool mic)
{
    max_box(s, x, y, w, h, BUTTON_R, LOOKS[style].line, LOOKS[style].edge, LOOKS[style].fill);
    const unsigned ink = LOOKS[style].ink;
    const int icon = mic ? MIC_SIZE + MIC_GAP : 0, inner = w - 2 * LABEL_PAD - icon, cy = y + h / 2;
    if (ht_pro_width(&ph_sb_26, label) <= inner) {
        const int tw = ht_pro_width(&ph_sb_26, label), left = x + (w - tw - icon) / 2;
        if (mic) max_icon_mic(s, left, cy - MIC_SIZE / 2, MIC_SIZE, ink);
        max_text(s, left + icon, cy, tw, &ph_sb_26, ink, label);
        return;
    }
    char rows[2][ROW_BYTES];
    const int n = max_wrap(rows, 2, label, &ph_sb_22, inner);
    if (mic) max_icon_mic(s, x + LABEL_PAD, cy - MIC_SIZE / 2, MIC_SIZE, ink);
    for (int i = 0; i < n; i++)
        max_text_centered(s, x + (w + icon) / 2, cy + (2 * i - (n - 1)) * ph_sb_22.height * 2 / 5, inner, &ph_sb_22, ink,
                          rows[i]);
}

// ---- what moves by the clock ----

static bool s_moving;   // something the last render drew moves on by the clock alone
static uint32_t s_due;  // and when it next does
void max_motion(uint32_t now_ms, uint32_t ms)
{
    const uint32_t due = now_ms + ms;
    if (!s_moving || (int32_t)(due - s_due) < 0) s_due = due;
    s_moving = true;
}
void max_render_aside(ht_scene_t *s, uint32_t now_ms)
{
    const bool moving = s_moving;
    const uint32_t due = s_due;
    ht_scene_clear(s, 0);   // the render sets its ground
    max_ui_render(s, now_ms);
    s_moving = moving;
    s_due = due;
}
uint32_t max_motion_ms(uint32_t now_ms)
{
    if (!s_moving) return MAX_WAKE_MS;
    const int32_t left = (int32_t)(s_due - now_ms);
    return left > 0 ? (uint32_t)left : 0;
}
int32_t max_loop(uint32_t now_ms, uint32_t period_ms)
{
    max_motion(now_ms, MAX_LOOP_FRAME_MS);
    return (int32_t)((uint64_t)((now_ms - max_m.page_from) % period_ms) * 65536u / period_ms);
}
int32_t max_keyframes(int32_t p, int32_t from, int32_t to, max_curve_t curve)
{
    const int32_t half = 65536 / 2;
    if (p < half) return from + (int32_t)(((int64_t)(to - from) * max_ease(curve, 2 * p) + half) >> 16);
    return to + (int32_t)(((int64_t)(from - to) * max_ease(curve, 2 * (p - half)) + half) >> 16);
}

// The halo's alpha (of 255) by the distance from the dot's middle in quarter px, from HALO_FROM (the dot's edge,
// 7.5 px) on: a disc 15 px across blurred by a Gaussian of sigma 7 * 1.297 px, worked out offline. Past it, nothing.
enum { HALO_FROM = 30, HALO_K = 31, HALO_N = 2 * HALO_K + 1 };
static const uint8_t HALO[] = {
    55, 54, 53, 52, 51, 50, 49, 48, 47, 45, 44, 43, 42, 41, 40, 39, 38, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26,
    25, 24, 23, 22, 22, 21, 20, 19, 18, 17, 17, 16, 15, 15, 14, 13, 13, 12, 12, 11, 10, 10, 9, 9, 8, 8, 8, 7, 7,
    6, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1};
void max_voice_halo(ht_scene_t *s, int x, int cy, int32_t o)
{
    static EXT_RAM_BSS_ATTR uint16_t px[HALO_N * HALO_N];
    static EXT_RAM_BSS_ATTR uint8_t alpha[HALO_N * HALO_N];
    static bool made;
    if (!made) {
        for (int i = 0; i < HALO_N * HALO_N; i++) {
            const int dx = i % HALO_N - HALO_K, dy = i / HALO_N - HALO_K;
            const int q = (int)ht_pro_isqrt((unsigned)(16 * (dx * dx + dy * dy))) - HALO_FROM;
            px[i] = ht_rgb(VOICE);
            alpha[i] = q >= 0 && q < (int)sizeof HALO ? HALO[q] : 0;
        }
        made = true;
    }
    const unsigned opacity = (unsigned)(o < 0 ? 0 : o > MAX_ONE ? MAX_ONE : o) * s_keep / 256 * 255 / MAX_ONE;
    const ht_pro_bitmap_t b = {px, alpha, HALO_N, HALO_N, 1, NULL};
    const int left = x + DX(12) / 2 - HALO_K, top = cy - HALO_K;   // on the live dot's middle pixel (max_dot)
    if (opacity >= 255) ht_pro_image(s, left, top, &b);
    else if (opacity) ht_pro_image_faded(s, left, top, &b, opacity);
}

// ---- over the page: the toast of a question that came while a person talks, and the notice pill ----

enum {
    TOAST_W = DX(760), TOAST_H = DY(52), TOAST_Y = DY(6), PILL_PAD = DX(22), PILL_DOT = DY(8),
    OVERLAY_MS = 300, RISE = DY(20), SLIDE = DX(24),   // V3's toast rises in, its done note slides in, both fading
};

// How much of an overlay shows at now_ms (MAX_ONE whole): up, coming in over OVERLAY_MS from when it came; gone, going
// the same way from where it was then (Curves.ease). Frames while it moves.
static int32_t overlay(max_fade_t *f, bool up, uint32_t from, uint32_t now_ms)
{
    int32_t v;
    if (up) {
        const int32_t gone = (int32_t)(now_ms - from);
        v = gone >= OVERLAY_MS ? MAX_ONE : gone <= 0 ? 0
          : (int32_t)(((int64_t)max_ease(MAX_EASE, gone * 65536 / OVERLAY_MS) * MAX_ONE + 32768) >> 16);
        f->up = true;
        max_tween_rest(&f->out, v);   // where it goes out from
    } else {
        if (f->up) f->out = (max_tween_t){f->out.to, 0, now_ms, OVERLAY_MS, MAX_EASE};
        f->up = false;
        v = max_tween_at(&f->out, now_ms);
    }
    if (up ? v < MAX_ONE : v > 0) max_motion(now_ms, MAX_ROW_FRAME_MS);
    return v;
}
// The overlay's colours `v` of MAX_ONE their own, the rest the ground's.
static void fade_by(int32_t v) { max_tint(GROUND, (unsigned)v * 256 / MAX_ONE); }

// The toast's place: top centre; while New Harness is up, in its title row left of Close, so it covers none of the
// form's buttons.
static max_box_t toast_box(bool form)
{
    if (!form) return (max_box_t){(HT_WIDTH - TOAST_W) / 2, TOAST_Y, TOAST_W, TOAST_H};
    return (max_box_t){FORM_CLOSE_X - 16 - TOAST_W, FORM_HEAD_Y + (MAX_BUTTON_H - TOAST_H) / 2, TOAST_W, TOAST_H};
}

// Who needs the person, in its kind's colour, and what for, on one row: its question, or its turn's summary or failure.
// The toast holds only while its agent still is what it announced (max_toast_shown), so its state says which.
static void toast(ht_scene_t *s, max_box_t t, const max_agent_t *a)
{
    const max_attn_t kind = a->state == MAX_DONE ? MAX_ATTN_DONE : a->state == MAX_FAILED ? MAX_ATTN_FAIL : MAX_ATTN_ASK;
    const unsigned ink = max_kind_ink(kind);
    max_box(s, t.x, t.y, t.w, t.h, t.h / 2, 1, RIM, CARD);
    const int cy = t.y + t.h / 2, dot = DY(10), x = t.x + DX(24), right = t.x + t.w - DX(24);
    max_dot(s, x, cy, dot, ink);
    char who[CABLE_NAME_MAX + 12];
    snprintf(who, sizeof who, "%s %s", a->name,
             kind == MAX_ATTN_DONE ? "is done" : kind == MAX_ATTN_FAIL ? "failed" : "asks");
    const int tx = x + dot + DX(12), nw = max_text(s, tx, cy, (right - tx) / 2, &ph_sb_22, ink, who);
    max_text(s, tx + nw + DX(14), cy, right - tx - nw - DX(14), &ph_rg_24, FG,
             kind == MAX_ATTN_ASK ? a->question : a->note);
}

// The notice at the bottom centre after a green dot, `rise` px under its place; while New Harness is up, in its title
// row left of the toast's place.
static void notice(ht_scene_t *s, const char *text, bool form, max_box_t toast_at, bool toasting, int rise)
{
    const ht_pro_font_t *f = &ph_rg_24;
    char row[ROW_BYTES];
    max_cut(row, text, f, DX(900), false);
    const int tw = ht_pro_width(f, row), w = 2 * PILL_PAD + PILL_DOT + DX(10) + tw, h = NOTICE_H;
    const int right = toasting ? toast_at.x - 12 : FORM_CLOSE_X - 16;
    const int x = form ? right - w : (HT_WIDTH - w) / 2;
    const int y = (form ? FORM_HEAD_Y + (MAX_BUTTON_H - h) / 2 : HT_HEIGHT - DY(22) - h) + rise;
    max_box(s, x, y, w, h, h / 2, 1, RIM, CARD);
    max_dot(s, x + PILL_PAD, y + h / 2, PILL_DOT, DONE);
    ht_pro_text(s, x + PILL_PAD + PILL_DOT + DX(10), max_top_of(f, y + h / 2), tw, f, C(FG), row);
}

// ---- over the page: a finished turn's note ----

// V3's done note: 460 x 42 design px at most, 16 from the glass's right and 10 from its foot, its pet 34 x 30; the
// finger's target reaches 12 past it all round (the bar's touch lands off the finger at the right).
enum {
    DONE_W = DX(460), DONE_H = DY(42), DONE_RIGHT = DX(16), DONE_FOOT = DY(10), DONE_PAD_L = DX(10), DONE_PAD_R = DX(18),
    DONE_PET_W = DX(34), DONE_PET_H = DY(30), DONE_GAP = DX(10), DONE_REACH = DX(12), DONE_MIN_SAID = DX(40),
};
#define DONE_IS " is done"
#define DONE_DOT " \xc2\xb7 "

typedef struct {
    max_box_t card;
    int name_w, said_w;   // what of the name and of what it said fits; no words when said_w is 0
} done_t;

// The note of agent a, as wide as its words up to DONE_W: the name (at most half the room when words follow it),
// " is done", then as much of what the turn said as fits, if enough does to read.
static done_t done_layout(const max_agent_t *a)
{
    const ht_pro_font_t *nf = &ph_sb_22, *sf = &ph_rg_24;
    const int is_w = ht_pro_width(nf, DONE_IS), dot_w = ht_pro_width(sf, DONE_DOT);
    const int left = DONE_W - DONE_PAD_L - DONE_PET_W - DONE_GAP - DONE_PAD_R - is_w;
    char row[ROW_BYTES];
    max_cut(row, a->name, nf, a->note[0] ? left / 2 : left, false);
    done_t d = {.name_w = ht_pro_width(nf, row)};
    if (a->note[0]) {
        max_cut(row, a->note, sf, left - d.name_w - dot_w, false);
        d.said_w = ht_pro_width(sf, row);
        if (d.said_w < DONE_MIN_SAID) d.said_w = 0;
    }
    const int w = DONE_PAD_L + DONE_PET_W + DONE_GAP + d.name_w + is_w + (d.said_w ? dot_w + d.said_w : 0) + DONE_PAD_R;
    d.card = (max_box_t){HT_WIDTH - DONE_RIGHT - w, HT_HEIGHT - DONE_FOOT - DONE_H, w, DONE_H};
    return d;
}

// The pet, still, then "name is done · what it said" on one row, the name in the done green, on a card in the toast's
// colours, `slide` px right of its place; the pet fades by its alpha as the rest by its colours.
static void done_note(ht_scene_t *s, const max_agent_t *a, const done_t *d, int slide)
{
    const max_box_t c = {(int16_t)(d->card.x + slide), d->card.y, d->card.w, d->card.h};
    max_box(s, c.x, c.y, c.w, c.h, DONE_H / 3, 1, RIM, CARD);
    const int cy = c.y + c.h / 2, from = s->count;
    max_pet(s, a->engine, POD_SCENE_REST, c.x + DONE_PAD_L + DONE_PET_W / 2, cy + DONE_PET_H / 2, DONE_PET_W / 2,
            DONE_PET_H, CARD, 0, true);
    max_layer_pet(s, from, CARD, 0, s_keep);
    int x = c.x + DONE_PAD_L + DONE_PET_W + DONE_GAP;
    x += max_text(s, x, cy, d->name_w, &ph_sb_22, DONE, a->name);
    x += max_text(s, x, cy, c.x + c.w - x, &ph_sb_22, DIM, DONE_IS);
    if (!d->said_w) return;
    x += max_text(s, x, cy, c.x + c.w - x, &ph_rg_24, FAINT, DONE_DOT);
    max_text(s, x, cy, d->said_w, &ph_rg_24, RECAP, a->note);
}

// ---- the whole screen ----

static void update_screen(ht_scene_t *s)
{
    const int cx = HT_WIDTH / 2, bar_w = 800;
    char pct[16], version[MAX_VERSION_BYTES + 8];
    snprintf(pct, sizeof pct, "%d%%", max_m.update_pct);
    max_text_centered(s, cx, MAX_Y(140), 600, &ph_sb_34, FG, "Updating");
    max_text_centered(s, cx, MAX_Y(214), 400, &ph_sb_48, FG, pct);
    ht_pro_rect_aa(s, cx - bar_w / 2, MAX_Y(276), bar_w, 14, 7, C(TRACK));
    if (max_m.update_pct > 0)
        ht_pro_rect_aa(s, cx - bar_w / 2, MAX_Y(276), bar_w * max_m.update_pct / 100, 14, 7, C(DONE));
    if (max_m.update_to[0]) {
        snprintf(version, sizeof version, "Version %s", max_m.update_to);
        max_text_centered(s, cx, MAX_Y(334), 600, &ph_sb_22, REST, version);
    }
}

// The page the model shows. One that names an agent no longer in the ring shows Overview instead; App Detail draws the
// agent page, its agent open across the row.
static void page(ht_scene_t *s, uint32_t now_ms)
{
    const max_agent_t *attn = max_find(max_m.attn_id);
    if (max_m.view == MAX_VIEW_ATTENTION && attn) max_draw_attention(s, attn, now_ms);
    else if (max_m.view == MAX_VIEW_INBOX) max_draw_inbox(s, now_ms);
    else if (max_m.view == MAX_VIEW_APPS) max_draw_apps(s);
    else if (max_m.view == MAX_VIEW_AMBIENT) max_draw_ambient(s);
    else max_draw_overview(s, now_ms);
}

void max_ui_render(ht_scene_t *s, uint32_t now_ms)
{
    // What loops runs from when this page came up (V3's Motion comes with its page); the agent page is App Detail's.
    const uint8_t face = max_m.update_pct >= 0 ? 0xFF : max_form_open() ? 0xFE
                       : max_m.view == MAX_VIEW_AGENT ? MAX_VIEW_OVERVIEW : (uint8_t)max_m.view;
    if (!max_m.page_up || face != max_m.page_face) max_m.page_from = now_ms;
    max_m.page_up = true;
    max_m.page_face = face;
    s->background = C(GROUND);
    max_m.cell_hits = 0;
    max_m.hit_count = 0;
    max_m.card_id[0] = 0;
    max_m.dirty = false;
    max_m.row.had = max_m.row.drawn;   // whether the row was on the glass just before (max_row_step)
    max_m.row.drawn = false;
    max_m.row.open_l = max_m.row.open_r = 0;
    s_moving = false;
    max_tint(0, 256);
    max_dim(0);
    if (max_m.update_pct >= 0) {
        update_screen(s);
    } else {
        // What each overlay says, kept while it goes: its agent may be gone by then.
        static EXT_RAM_BSS_ATTR max_agent_t toast_a, done_a;
        static EXT_RAM_BSS_ATTR char said[MAX_NOTICE_BYTES];
        const bool form = max_form_open(), toasting = max_m.link && max_toast_shown(now_ms);
        const max_box_t t = toast_box(form);
        if (toasting) {
            max_hit(t.x, t.y, t.w, t.h, MAX_HIT_TOAST, 0);   // first: it lies over the page's own
            toast_a = *max_find(max_m.toast_id);
        }
        // The done note, over any page but the form (whose buttons it would cover; its notice waits in Inbox).
        const max_agent_t *done = max_m.link && !form && max_done_shown(now_ms) ? max_find(max_m.done_id) : NULL;
        if (done) done_a = *done;
        const bool noticing = max_notice_shown(now_ms);
        if (noticing) memcpy(said, max_m.notice, sizeof said);
        const int32_t toast_v = overlay(&max_m.toast_fade, toasting, max_m.toast_from, now_ms);
        const int32_t done_v = overlay(&max_m.done_fade, done != NULL, max_m.done_from, now_ms);
        const int32_t notice_v = overlay(&max_m.notice_fade, noticing, max_m.notice_from, now_ms);
        done_t d = {.name_w = 0};
        if (done_v) d = done_layout(&done_a);
        if (done) {
            const int hx = d.card.x - DONE_REACH, hy = d.card.y - DONE_REACH;
            const int hw = d.card.w + 2 * DONE_REACH, hh = d.card.h + 2 * DONE_REACH;
            max_hit(hx, hy, hx + hw > HT_WIDTH ? HT_WIDTH - hx : hw, hy + hh > HT_HEIGHT ? HT_HEIGHT - hy : hh,
                    MAX_HIT_DONE_NOTE, 0);
        }
        if (form) max_draw_form(s);
        else page(s, now_ms);
        if (toast_v) {
            fade_by(toast_v);
            toast(s, (max_box_t){t.x, (int16_t)(t.y + RISE * (MAX_ONE - toast_v) / MAX_ONE), t.w, t.h}, &toast_a);
        }
        if (done_v && !form) {
            fade_by(done_v);
            done_note(s, &done_a, &d, SLIDE * (MAX_ONE - done_v) / MAX_ONE);
        }
        if (notice_v) {
            fade_by(notice_v);
            notice(s, said, form, t, toast_v > 0, RISE * (MAX_ONE - notice_v) / MAX_ONE);
        }
        max_tint(0, 256);
    }
    max_m.drawn_key = max_time_key(now_ms);
}
