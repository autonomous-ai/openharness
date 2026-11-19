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

// ---- the state chip ----

enum { CHIP_DOT = DX(8), CHIP_GAP = DX(8) };
static int chip_pad(bool small) { return small ? DX(13) : DX(16); }
int max_chip_w(const max_agent_t *a, bool small, int max_w)
{
    const int w = 2 * chip_pad(small) + CHIP_DOT + CHIP_GAP + ht_pro_width(&ph_sb_22, max_status_word(a));
    return w < max_w ? w : max_w;
}
int max_chip(ht_scene_t *s, int x, int cy, const max_agent_t *a, bool small, int max_w)
{
    const unsigned c = max_chip_ink(a);
    const unsigned words = a->state == MAX_IDLE ? REST : a->state == MAX_FAILED ? FAIL : c;
    const int h = small ? DY(30) : DY(34), pad = chip_pad(small), w = max_chip_w(a, small, max_w);
    max_box(s, x, cy - h / 2, w, h, h / 2, 1, max_mix(c, GROUND, 40), max_mix(c, GROUND, 15));
    max_dot(s, x + pad, cy, CHIP_DOT, c);
    const int tx = x + pad + CHIP_DOT + CHIP_GAP;
    max_text(s, tx, cy, x + w - pad - tx, &ph_sb_22, words, max_status_word(a));
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
uint32_t max_motion_ms(uint32_t now_ms)
{
    if (!s_moving) return MAX_WAKE_MS;
    const int32_t left = (int32_t)(s_due - now_ms);
    return left > 0 ? (uint32_t)left : 0;
}

// ---- over the page: the toast of a question that came while a person talks, and the notice pill ----

enum { TOAST_W = DX(760), TOAST_H = DY(52), TOAST_Y = DY(6), PILL_PAD = DX(22), PILL_DOT = DY(8) };

// The toast's place: top centre; while New Harness is up, in its title row left of Close, so it covers none of the
// form's buttons.
static max_box_t toast_box(bool form)
{
    if (!form) return (max_box_t){(HT_WIDTH - TOAST_W) / 2, TOAST_Y, TOAST_W, TOAST_H};
    return (max_box_t){FORM_CLOSE_X - 16 - TOAST_W, FORM_HEAD_Y + (MAX_BUTTON_H - TOAST_H) / 2, TOAST_W, TOAST_H};
}

// Who needs the person, in its kind's colour, and what for, on one row: its question, or its turn's summary or failure.
// The toast holds only while its agent still is what it announced (max_toast_shown), so its state says which.
static void toast(ht_scene_t *s, max_box_t t)
{
    const max_agent_t *a = max_find(max_m.toast_id);
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

// The notice at the bottom centre after a green dot; while New Harness is up, in its title row left of the toast's place.
static void notice(ht_scene_t *s, bool form, max_box_t toast_at, bool toasting)
{
    const ht_pro_font_t *f = &ph_rg_24;
    char row[ROW_BYTES];
    max_cut(row, max_m.notice, f, DX(900), false);
    const int tw = ht_pro_width(f, row), w = 2 * PILL_PAD + PILL_DOT + DX(10) + tw, h = NOTICE_H;
    const int right = toasting ? toast_at.x - 12 : FORM_CLOSE_X - 16;
    const int x = form ? right - w : (HT_WIDTH - w) / 2;
    const int y = form ? FORM_HEAD_Y + (MAX_BUTTON_H - h) / 2 : HT_HEIGHT - DY(22) - h;
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
// colours.
static void done_note(ht_scene_t *s, const max_agent_t *a, const done_t *d)
{
    const max_box_t c = d->card;
    max_box(s, c.x, c.y, c.w, c.h, DONE_H / 3, 1, RIM, CARD);
    const int cy = c.y + c.h / 2;
    max_pet(s, a->engine, POD_SCENE_REST, c.x + DONE_PAD_L + DONE_PET_W / 2, cy + DONE_PET_H / 2, DONE_PET_W / 2,
            DONE_PET_H, CARD, 0, true);
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
        const bool form = max_form_open(), toasting = max_m.link && max_toast_shown(now_ms);
        const max_box_t t = toast_box(form);
        if (toasting) max_hit(t.x, t.y, t.w, t.h, MAX_HIT_TOAST, 0);   // first: it lies over the page's own
        // The done note, over any page but the form (whose buttons it would cover; its notice waits in Inbox).
        const max_agent_t *done = max_m.link && !form && max_done_shown(now_ms) ? max_find(max_m.done_id) : NULL;
        done_t d = {.name_w = 0};
        if (done) {
            d = done_layout(done);
            const int hx = d.card.x - DONE_REACH, hy = d.card.y - DONE_REACH;
            const int hw = d.card.w + 2 * DONE_REACH, hh = d.card.h + 2 * DONE_REACH;
            max_hit(hx, hy, hx + hw > HT_WIDTH ? HT_WIDTH - hx : hw, hy + hh > HT_HEIGHT ? HT_HEIGHT - hy : hh,
                    MAX_HIT_DONE_NOTE, 0);
        }
        if (form) max_draw_form(s);
        else page(s, now_ms);
        if (toasting) toast(s, t);
        if (done) done_note(s, done, &d);
        if (max_notice_shown(now_ms)) notice(s, form, t, toasting);
    }
    max_m.drawn_key = max_time_key(now_ms);
}
