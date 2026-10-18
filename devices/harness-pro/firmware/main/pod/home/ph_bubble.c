// Pets bubbles: speech, thought and "you" bubbles, the thought dots and the bell (mockup .sp .th .yo .td .bell in pro-edge2/full.py).
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_view_shared.h"
#include "pod/pod_draw.h"
#include "pod/pod_mem.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
#define ELL "\xe2\x80\xa6"
enum { PAD_Y = 22, PAD_X = 28, MAX_ROWS = 6, MUTED_GAP = 6, TAIL_W = 21, TAIL_H = 21, ROW = HT_TEXT_BYTES };

static const struct { unsigned fill, edge, ink, muted; } LOOK[] = {
    [PH_SPEECH]     = {0xF7F2EA, 0, 0x1B1918, 0x7B746C},
    [PH_SPEECH_BAD] = {0xF3D9DA, 0, 0x9B5A5F, 0x9B5A5F},
    [PH_THOUGHT]    = {0x2C2826, 0x47413C, 0xEFE7DE, 0xADA6AD},
    [PH_YOU]        = {0xC6AAEF, 0, 0x1D1426, 0x1D1426},
};

// A newline, return or tab in a message reads as a space (ht_pro_text stops at a newline).
static bool is_sp(char c) { return c == ' ' || c == '\n' || c == '\r' || c == '\t'; }
static void flatten(char *s) { for (; *s; s++) if (is_sp(*s)) *s = ' '; }
// Bytes of the UTF-8 sequence at s (1..4; a stray continuation byte or a truncated sequence counts as the bytes there are, a run
// of continuation bytes from the host is cut every 4 so no "code point" outgrows a row).
static size_t cp_len(const char *s)
{
    size_t m = 1;
    while (m < 4 && s[m] && ((unsigned char)s[m] & 0xc0) == 0x80) m++;
    return m;
}

// The longest prefix of s (a UTF-8 boundary) whose width, with `tail` appended, is within w; returns its byte length.
static size_t fit(const ht_pro_font_t *f, const char *s, size_t len, int w, const char *tail)
{
    char buf[ROW];
    size_t tl = strlen(tail), n = 0, best = 0;
    while (n < len) {
        size_t m = n + cp_len(s + n);
        if (m > len) m = len;
        if (m + tl >= sizeof buf) break;
        memcpy(buf, s, m); memcpy(buf + m, tail, tl + 1);
        flatten(buf);
        if (ht_pro_width(f, buf) > w) break;
        best = n = m;
    }
    return best;
}

// One row of `*p` into out: a word wrap, or (last) the rest cut with the ellipsis when it does not fit. Advances *p.
// Never splits a UTF-8 sequence.
static void take(const ht_pro_font_t *f, const char **p, int w, bool last, char out[ROW])
{
    const char *s = *p;
    while (is_sp(*s)) s++;
    size_t len = strlen(s), n = fit(f, s, len, w, "");
    if (n >= len) { memcpy(out, s, len + 1); flatten(out); *p = s + len; return; }
    if (last) {
        n = fit(f, s, len, w, ELL);
        while (n && is_sp(s[n - 1])) n--;
        memcpy(out, s, n); strcpy(out + n, ELL);
        flatten(out);
        *p = s + len;
        return;
    }
    size_t brk = n;
    while (brk && !is_sp(s[brk])) brk--;
    if (brk) n = brk;
    if (!n) { n = cp_len(s); if (n > len) n = len; }   // one word wider than the row: break it at a code point, at least one
    memcpy(out, s, n);
    out[n] = 0;
    flatten(out);
    while (n && out[n - 1] == ' ') out[--n] = 0;
    *p = s + (brk ? brk : n);
}

// The rows `text` takes in a bubble of width w (inner width w - 2 * PAD_X) at most max_rows (clamped to 1..MAX_ROWS), cut as ph_bubble cuts them.
// rows == NULL only counts.
static int layout_raw(const ht_pro_font_t *f, int w, const char *text, int max_rows, char rows[][ROW])
{
    if (max_rows < 1) max_rows = 1;
    if (max_rows > MAX_ROWS) max_rows = MAX_ROWS;
    char scratch[ROW];
    const char *p = text ? text : "";
    int n = 0;
    while (n < max_rows) {
        while (is_sp(*p)) p++;
        if (!*p && n) break;
        take(f, &p, w - 2 * PAD_X, n == max_rows - 1, rows ? rows[n] : scratch);
        n++;
    }
    return n;
}

// The layout is a pure function of (face, width, row budget, text) and costs a measurement per character (fit() grows a row one code point
// at a time), yet a room asks for it twice a frame (the height to place the bubble, then the bubble) and again every beat of the pet while
// the text has not changed. The last few layouts are kept, keyed by the text itself (compared, not hashed), so a repeat is a lookup.
// Render task only (not reentrant), in PSRAM; a text of TEXT_KEY bytes or more is laid out each time.
enum { TEXT_KEY = 400, CACHE_SLOTS = 4 };
typedef struct { const ht_pro_font_t *f; int w, max_rows, n; char text[TEXT_KEY]; char rows[MAX_ROWS][ROW]; } layout_slot_t;
static EXT_RAM_BSS_ATTR layout_slot_t s_slots[CACHE_SLOTS];
static unsigned s_next_slot;
static unsigned s_layouts;   // layouts computed, not looked up (a test hook)
unsigned ph_bubble_layouts(void) { return s_layouts; }

static int layout(const ht_pro_font_t *f, int w, const char *text, int max_rows, char rows[][ROW])
{
    const char *t = text ? text : "";
    int mr = max_rows < 1 ? 1 : max_rows > MAX_ROWS ? MAX_ROWS : max_rows;   // the clamp layout_raw applies, so equal budgets share a slot
    if (strlen(t) >= TEXT_KEY) { s_layouts++; return layout_raw(f, w, t, max_rows, rows); }
    layout_slot_t *hit = NULL;
    for (int i = 0; i < CACHE_SLOTS && !hit; i++) {
        layout_slot_t *c = &s_slots[i];
        if (c->f == f && c->w == w && c->max_rows == mr && c->n > 0 && !strcmp(c->text, t)) hit = c;
    }
    if (!hit) {
        hit = &s_slots[s_next_slot++ % CACHE_SLOTS];
        hit->n = 0;   // not a hit while it is being rewritten
        s_layouts++;
        int n = layout_raw(f, w, t, mr, hit->rows);
        hit->f = f; hit->w = w; hit->max_rows = mr; hit->n = n;
        snprintf(hit->text, sizeof hit->text, "%s", t);
    }
    if (rows) for (int i = 0; i < hit->n; i++) memcpy(rows[i], hit->rows[i], ROW);
    return hit->n;
}

int ph_bubble_rows(const ht_pro_font_t *f, int w, const char *text, int max_rows) { return f ? layout(f, w, text, max_rows, NULL) : 1; }

int ph_bubble_height(const ht_pro_font_t *f, int w, const char *text, int max_rows, bool muted)
{
    if (!f) return 0;
    return 2 * PAD_Y + layout(f, w, text, max_rows, NULL) * f->height + (muted ? MUTED_GAP + f->height : 0);
}

static void tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, unsigned rgb)
{
    pod_tri(s, x0 * 16, y0 * 16, x1 * 16, y1 * 16, x2 * 16, y2 * 16, C(rgb));
}

static void tail(ht_scene_t *s, int dir, int x, int y, int w, int h, int at, unsigned rgb, int inset)
{
    int i = inset;
    if (dir == 0) { int b = y + h; tri(s, at - TAIL_W + 2 * i, b - 1, at + TAIL_W - 2 * i, b - 1, at, b + TAIL_H - i, rgb); }
    else if (dir == 1) tri(s, x + 1, at - TAIL_W + 2 * i, x + 1, at + TAIL_W - 2 * i, x - TAIL_H + i, at, rgb);
    (void)w;
}

void ph_bubble_box(ht_scene_t *s, ph_bubble_kind_t kind, int x, int y, int w, int h, int tail_x, int tail_dir)
{
    if (kind < PH_SPEECH || kind > PH_YOU) return;
    bool th = kind == PH_THOUGHT;
    int rad = th ? 40 : 30;
    if (tail_dir == 0 || tail_dir == 1) {
        if (th) tail(s, tail_dir, x, y, w, h, tail_x, LOOK[kind].edge, 0);
        tail(s, tail_dir, x, y, w, h, tail_x, LOOK[kind].fill, th ? 2 : 0);
    }
    if (th) {
        ht_pro_rect_aa(s, x, y, w, h, rad, C(LOOK[kind].edge));
        ht_pro_rect_aa(s, x + 2, y + 2, w - 4, h - 4, rad - 2, C(LOOK[kind].fill));
    } else {
        ht_pro_rect_aa(s, x, y, w, h, rad, C(LOOK[kind].fill));
    }
}

int ph_bubble(ht_scene_t *s, ph_bubble_kind_t kind, int x, int y, int w, int tail_x, int tail_dir, const ht_pro_font_t *f, const char *text,
              int max_rows, const char *muted)
{
    if (kind < PH_SPEECH || kind > PH_YOU || !f) return 0;
    int tw = w - 2 * PAD_X;
    char rows[MAX_ROWS][ROW], mu[ROW];
    int n = layout(f, w, text, max_rows, rows);
    bool has_mu = muted && *muted;
    if (has_mu) { const char *m = muted; take(f, &m, tw, true, mu); }
    int h = 2 * PAD_Y + n * f->height + (has_mu ? MUTED_GAP + f->height : 0);
    ph_bubble_box(s, kind, x, y, w, h, tail_x, tail_dir);
    for (int i = 0; i < n; i++) ht_pro_text(s, x + PAD_X, y + PAD_Y + i * f->height, tw, f, C(LOOK[kind].ink), rows[i]);
    if (has_mu) ht_pro_text(s, x + PAD_X, y + PAD_Y + n * f->height + MUTED_GAP, tw, f, C(LOOK[kind].muted), mu);
    return h;
}

void ph_thought_dots(ht_scene_t *s, int x0, int y0, int x1, int y1)
{
    const int d[2] = {28, 16}, cx[2] = {x0, x1}, cy[2] = {y0, y1};
    for (int i = 0; i < 2; i++) {
        ht_pro_rect_aa(s, cx[i] - d[i] / 2, cy[i] - d[i] / 2, d[i], d[i], d[i] / 2, C(LOOK[PH_THOUGHT].edge));
        ht_pro_rect_aa(s, cx[i] - d[i] / 2 + 2, cy[i] - d[i] / 2 + 2, d[i] - 4, d[i] - 4, d[i] / 2 - 2, C(LOOK[PH_THOUGHT].fill));
    }
}

void ph_bell(ht_scene_t *s, int x, int y, int count)
{
    enum { BLUE = 0x006FFF };
    ht_pro_rect_aa(s, x + 3, y, 12, 14, 6, C(BLUE));                          // the dome
    pod_tri_inner(s, (x + 3) * 16, (y + 10) * 16, (x + 15) * 16, (y + 10) * 16, (x + 18) * 16, (y + 17) * 16, C(BLUE), 4);   // the flared skirt,
    pod_tri_inner(s, (x + 3) * 16, (y + 10) * 16, (x + 18) * 16, (y + 17) * 16, x * 16, (y + 17) * 16, C(BLUE), 1);          // two triangles
    ht_pro_rect_aa(s, x + 6, y + 18, 6, 4, 2, C(BLUE));                       // the clapper
    char t[12];
    int v = count < 0 ? 0 : count > 99 ? 99 : count, k = 0;
    if (v > 9) t[k++] = (char)('0' + v / 10);
    t[k++] = (char)('0' + v % 10); t[k] = 0;
    ph_text(s, x + 18 + 8, y + 11, 40, &ph_sb_26, BLUE, t);
}

// The first sentence of `text` (newlines read as spaces); a short opener such as "Done!" takes the next sentence too. A text without a
// sentence end is returned whole. `out` may be `text` itself.
void ph_first_sentence(char *out, size_t cap, const char *text)
{
    enum { SHORT_OPENER = 20 };
    if (!cap) return;
    if (out != text) snprintf(out, cap, "%s", text ? text : "");
    flatten(out);
    char *end = NULL;
    for (char *c = out; *c; c++) {
        if ((*c == '.' || *c == '!' || *c == '?') && (c[1] == ' ' || !c[1])) {
            end = c + 1;
            if (c + 1 - out >= SHORT_OPENER) break;
        }
    }
    if (end && *end) *end = 0;
    pod_utf8_trim(out);
}
