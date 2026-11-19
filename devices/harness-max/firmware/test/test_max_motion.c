// App Detail's row in motion (max_ui_row.c, max_ui_overview.c, max_ui_layer.c) against V3's numbers: the curves as
// Flutter computes them, each part of an agent's look at fixed times while one opens and closes, the scroll carried
// along and sent back, a page the row was not on snapping, the frame clock only while something moves, and the
// slivers' layers kept while they move and painted again when their agent changes.
#include <math.h>

#include "max_test.h"
#include "max_ui_motion.h"
#include "pod/pod_draw.h"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e", "f"};
#define T0 1000000u

static bool near(int32_t got, int32_t want, int32_t tol)
{
    if (got >= want - tol && got <= want + tol) return true;
    fprintf(stderr, "  got %d, want %d (within %d)\n", got, want, tol);
    return false;
}
static const max_look_t *look(const char *id)
{
    for (int i = 0; i < max_m.row.look_count; i++)
        if (!strcmp(max_m.row.looks[i].id, id)) return &max_m.row.looks[i];
    return NULL;
}
static max_place_t PLACES[MAX_AGENTS];
static int SCROLL;
static const max_place_t *place(const char *id, uint32_t now)
{
    const int n = max_row_layout(now, PLACES, &SCROLL);
    for (int i = 0; i < n; i++)
        if (!strcmp(PLACES[i].a->id, id)) return &PLACES[i];
    return NULL;
}
static int width(const char *id, uint32_t now) { return place(id, now)->w; }
static int scroll(uint32_t now)
{
    place("a", now);
    return SCROLL;
}
// The frames the render task draws from `from` to `to`, every MAX_ROW_FRAME_MS.
static void frames(uint32_t from, uint32_t to)
{
    for (uint32_t t = from; t < to; t += MAX_ROW_FRAME_MS) render(t);
    render(to);
}
// The row on the glass with n agents at rest, as an Overview drawn a while ago.
static void row_of(int n)
{
    linked(ABCDE, n);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;   // a person was here: Ambient waits a minute
    render(T0 - 5000);
    render(T0 - 4000);
}

// Flutter's Cubic.transform (its halving to within .001) and Interval, as doubles give them, in Q16.
static void test_curves(void)
{
    static const struct { int32_t t, row, ease, late; } AT[] = {
        {6554, 25968, 6252, 0},        {16384, 50257, 26837, 0},       {32768, 62006, 52559, 29013},
        {49152, 64954, 62951, 59394}, {58982, 65458, 65159, 64700},
    };
    for (unsigned i = 0; i < sizeof AT / sizeof AT[0]; i++) {
        CHECK(near(max_ease(MAX_EASE_ROW, AT[i].t), AT[i].row, 66));
        CHECK(near(max_ease(MAX_EASE, AT[i].t), AT[i].ease, 66));
        CHECK(near(max_ease(MAX_EASE_LATE, AT[i].t), AT[i].late, 66));
    }
    CHECK(max_ease(MAX_EASE_ROW, 0) == 0 && max_ease(MAX_EASE_ROW, 65536) == 65536);
    CHECK(max_ease(MAX_EASE, -5) == 0 && max_ease(MAX_EASE_LATE, 70000) == 65536);
    // A tween at rest is its end; one running is its curve's way there, and again from where it is on a new end.
    max_tween_t t = {100, 200, 50, 400, MAX_EASE};
    CHECK(max_tween_at(&t, 40) == 100 && max_tween_at(&t, 250) == 100 + (100 * 52559 + 32768) / 65536);
    CHECK(max_tween_at(&t, 450) == 200 && max_tween_done(&t, 450) && !max_tween_done(&t, 449));
}

// An agent opens: its cell widens over 420 ms as its neighbours narrow (kRowEase), its face fades (250 ms ease), its
// ground darkens (350 ms ease), its panel comes in late (440 ms, Interval(140/440)); the slivers' pets go smaller and
// lower with the move, their words fade in 200 ms and they dim in 350.
static void test_opening(void)
{
    row_of(5);
    CHECK(width("c", T0) == CELL_W && width("b", T0) == CELL_W && scroll(T0) == 0);
    max_open("c");
    render(T0);
    CHECK(width("c", T0) == CELL_W && max_row_moving(T0));
    const uint32_t mid = T0 + 210;
    CHECK(near(width("c", mid), 1133, 1) && near(width("b", mid), 194, 1) && near(width("e", mid), 194, 1));
    const max_look_t *c = look("c"), *b = look("b");
    CHECK(near(max_tween_at(&c->panel, mid), 1520, 3));
    CHECK(near(MAX_ONE - max_tween_at(&c->face, mid), 4033, 3) && near(max_tween_at(&c->ground, mid), 3625, 3));
    CHECK(max_tween_at(&c->sl, mid) == 0 && max_tween_at(&c->dim, mid) == 0);
    CHECK(near(max_tween_at(&b->sl, mid), 3875, 3) && max_tween_at(&b->words, mid) == 0);
    CHECK(near(max_tween_at(&b->dim, mid), 3625, 3) && max_tween_at(&b->face, mid) == MAX_ONE);
    CHECK(max_tween_at(&b->panel, mid) == 0 && max_tween_at(&b->ground, mid) == 0);
    // At 420 ms the widths are there; the panel's fade runs to 440.
    CHECK(width("c", T0 + 420) == OPEN_W && width("b", T0 + 420) == SLIVER_W);
    CHECK(max_tween_at(&c->panel, T0 + 420) < MAX_ONE && max_tween_at(&c->panel, T0 + 440) == MAX_ONE);
    // Settled once the dots that went dark with the carry have eased (250 ms after a goes off the glass).
    frames(T0, T0 + 700);
    CHECK(!max_row_moving(T0 + 700));
    // The open agent and two slivers fill the row exactly as the cells did.
    CHECK(place("b", T0 + 440)->x == ROW_X && place("c", T0 + 440)->x == ROW_X + SLIVER_W);
    CHECK(place("d", T0 + 440)->x == ROW_X + SLIVER_W + OPEN_W);
}

// The scroll is carried along with the move to where the open agent rests, a sliver before it (V3 _carry).
static void test_carry(void)
{
    row_of(6);
    max_open("e");   // the fifth: it rests with three slivers' width scrolled off
    render(T0);
    CHECK(scroll(T0) == 0 && near(scroll(T0 + 210), 500, 1) && scroll(T0 + 420) == 3 * SLIVER_W);
    CHECK(place("d", T0 + 420)->x == ROW_X && place("e", T0 + 420)->x == ROW_X + SLIVER_W);
    // The first agent opens with nothing before it: no carry.
    row_of(6);
    max_open("a");
    render(T0);
    CHECK(scroll(T0 + 210) == 0 && scroll(T0 + 420) == 0);
}

// Closed, the cells take their width back where the row is, then the row goes back to the closed agent one cell in
// (V3 _back), 420 ms after.
static void test_closing(void)
{
    row_of(5);
    max_open("c");
    render(T0);
    render(T0 + 500);
    CHECK(scroll(T0 + 500) == SLIVER_W);
    max_show(MAX_VIEW_OVERVIEW);   // X: c was third, the row comes back with it one cell in
    CHECK(max_m.row_first == 1);
    render(T0 + 1000);
    const max_look_t *c = look("c");
    CHECK(near(width("c", T0 + 1210), 543, 1) && scroll(T0 + 1210) == SLIVER_W);
    CHECK(near(max_tween_at(&c->panel, T0 + 1150), 811, 3));   // 300 ms ease out, half way: .802 gone
    CHECK(max_tween_at(&c->panel, T0 + 1300) == 0 && near(max_tween_at(&c->face, T0 + 1125), 3285, 3));
    render(T0 + 1420);   // the cells have their width: the way back begins
    CHECK(width("c", T0 + 1420) == CELL_W && scroll(T0 + 1420) == SLIVER_W && max_row_moving(T0 + 1420));
    CHECK(near(scroll(T0 + 1630), 489, 1) && scroll(T0 + 1840) == CELL_W);
    frames(T0 + 1420, T0 + 2100);
    CHECK(!max_row_moving(T0 + 2100) && max_motion_ms(T0 + 2100) == MAX_WAKE_MS);
    // Rendered late, the way back still runs from when the move ended.
    row_of(5);
    max_open("c");
    render(T0);
    max_show(MAX_VIEW_OVERVIEW);
    render(T0 + 1000);
    render(T0 + 1630);
    CHECK(near(scroll(T0 + 1630), 489, 1));
}

// The model sends the row to its front (an agent moved up past it): the row eases there.
static void test_front(void)
{
    row_of(6);
    max_m.row_first = 3;
    render(T0);
    CHECK(near(scroll(T0 + 210), 3 * CELL_W * 62006 / 65536, 1) && scroll(T0 + 420) == 3 * CELL_W);
    render(T0 + 500);
    max_m.row_first = 0;
    render(T0 + 600);
    CHECK(scroll(T0 + 600) == 3 * CELL_W && near(scroll(T0 + 810), 3 * CELL_W - 3 * CELL_W * 62006 / 65536, 1));
}

// From any other page the row is laid out where it rests, with nothing to ease (V3 builds the page afresh).
static void test_fresh_page(void)
{
    row_of(6);
    max_show(MAX_VIEW_INBOX);
    render(T0);
    max_open("e");
    render(T0 + 10);
    CHECK(width("e", T0 + 10) == OPEN_W && scroll(T0 + 10) == 3 * SLIVER_W && !max_row_moving(T0 + 10));
    CHECK(max_tween_at(&look("e")->panel, T0 + 10) == MAX_ONE && max_tween_at(&look("d")->dim, T0 + 10) == MAX_ONE);
}

// While anything in the row moves the render task gets a frame every MAX_ROW_FRAME_MS, by the clock; settled, it
// sleeps (the cells' pets hold one frame).
static void test_frame_clock(void)
{
    row_of(5);
    CHECK(max_motion_ms(T0 - 4000) == MAX_WAKE_MS && !max_ui_tick(T0 - 3999));
    max_open("d");
    max_m.dirty = false;
    render(T0);
    CHECK(max_motion_ms(T0) == MAX_ROW_FRAME_MS && max_ui_next_wake_ms(T0) <= MAX_ROW_FRAME_MS);
    CHECK(!max_ui_tick(T0 + 5) && max_ui_tick(T0 + MAX_ROW_FRAME_MS));
    max_show(MAX_VIEW_OVERVIEW);   // closed 16 ms in: the cells' 420 ms, then the way back's
    for (uint32_t t = T0 + 16; t < T0 + 2000; t += 16) {
        render(t);
        if (!max_row_moving(t)) {
            // The way back ends 840 ms after the close; a dot lit near its end eases 250 ms more.
            CHECK(t >= T0 + 16 + 2 * MAX_ROW_MS && t <= T0 + 16 + 2 * MAX_ROW_MS + 250 + 16);
            CHECK(max_motion_ms(t) == MAX_WAKE_MS && max_ui_next_wake_ms(t) > 1000);
            return;
        }
        CHECK(max_motion_ms(t) == MAX_ROW_FRAME_MS);
    }
    CHECK(!"the row never settled");
}

// What is drawn where: a cell at rest on the glass itself, a sliver at rest as a kept layer, an agent between looks as
// a layer painted this frame, each cut to the row; the row's hits are the windows on the glass.
static int images(void)
{
    int k = 0;
    for (int i = 0; i < S.count; i++) k += S.runs[i].pro_kind == 3;
    return k;
}
static void test_drawn(void)
{
    row_of(5);
    CHECK(images() == 0 && max_m.cell_hits == 3);
    max_open("c");
    render(T0);
    const unsigned painted = max_layer_painted();
    render(T0 + 100);   // b and d between looks, painted fresh; a's sliver comes in from the left, e's off the glass
    CHECK(images() >= 2 && max_layer_painted() > painted);
    int covered = 0;
    for (int i = 0; i < max_m.cell_hits; i++) {
        const max_box_t b = max_m.cell_box[i];
        CHECK(b.x >= ROW_X && b.x + b.w <= ROW_X + ROW_W && b.w > 0);
        covered += b.w;
    }
    CHECK(covered + (max_m.row.open_r - max_m.row.open_l) == ROW_W);
    // The open agent's X and body are its own, cut to its window as it widens.
    for (int i = 0; i < max_m.hit_count; i++) {
        const max_hit_t *h = &max_m.hits[i];
        if (h->kind == MAX_HIT_BODY || h->kind == MAX_HIT_AGENT_X)
            CHECK(h->x >= max_m.row.open_l && h->x + h->w <= max_m.row.open_r);
    }
    render(T0 + 440);
    CHECK(images() == 2);   // the two slivers at rest
}

// A settled sliver's layer is painted once and kept while it moves; its agent changing paints it again.
static void test_layer_kept(void)
{
    row_of(5);
    max_ui_turn("a", "started", "", 0, T0);   // at work, first by need as before: a sliver no test kept yet
    max_open("c");
    render(T0);
    render(T0 + 500);
    render(T0 + 600);
    const unsigned painted = max_layer_painted();
    render(T0 + 700);
    CHECK(max_layer_painted() == painted);
    // The finger drags the slivers to the right: b and d move, kept; a comes onto the glass, painted once.
    const int x = ROW_X + SLIVER_W / 2;
    max_ui_touch(true, x, 200, T0 + 800);
    max_ui_touch(true, x + 60, 200, T0 + 820);
    max_ui_touch(true, x + 120, 200, T0 + 840);
    render(T0 + 840);
    CHECK(max_layer_painted() == painted + 1 && scroll(T0 + 840) == SLIVER_W - (120 - 60));
    max_ui_touch(true, x + 300, 200, T0 + 860);   // past the row's start: it stops there
    render(T0 + 860);
    CHECK(max_layer_painted() == painted + 1 && scroll(T0 + 860) == 0);
    max_ui_touch(true, x + 230, 200, T0 + 880);
    render(T0 + 880);
    CHECK(scroll(T0 + 880) == 70);
    max_ui_touch(false, x + 230, 200, T0 + 900);   // open: it rests where it is let go
    render(T0 + 1200);
    CHECK(scroll(T0 + 1200) == 70 && !max_row_moving(T0 + 1200) && max_layer_painted() == painted + 1);
    // b turns out to be Codex: its sliver shows Codex's pet, painted again; a and d stay as they were.
    max_copy(max_find("b")->engine, sizeof max_find("b")->engine, "codex");
    render(T0 + 1300);
    CHECK(max_layer_painted() == painted + 2);
    // Two agents that look the same in a sliver (their words are gone) share its layer: d starts work as a did.
    max_ui_turn("d", "started", "", 0, T0 + 1400);
    render(T0 + 1400);
    CHECK(max_layer_painted() == painted + 2);
}

// ---- the slivers' filter ----

// What a layer is painted from: a glow, a rail, the line on its right, and two marks (a pet's stand-ins), one by the
// left side. No words: those the filter leaves sharp.
static void marks(ht_scene_t *s, int x, const void *arg)
{
    const int w = *(const int *)arg;
    pod_grad_aa_dither(s, x, 0, w, DY(138), 0, ht_rgb(0x2A3D2A), ht_rgb(0));
    ht_pro_rect(s, x, 0, w, 7, 0, ht_rgb(0xE6E62E));
    ht_pro_rect(s, x + w - 1, 0, 1, HT_HEIGHT, 0, ht_rgb(0x26262E));
    ht_pro_rect(s, x + w / 2 - 30, DY(130), 60, 60, 0, ht_rgb(0xEAEAF0));
    ht_pro_rect(s, x + 2, DY(200), 20, 20, 0, ht_rgb(0xD9774B));
}
// V3's _Dim done the plain way, in doubles: the agent's columns [x, x + w) rasterised alone, blurred down then across
// by a Gaussian of the layer's sigma (transparent past the agent and the glass), dimmed by dimMatrix(t). Out: 8 bits a
// channel, the glass's [l, r) by HT_HEIGHT.
static double REF[HT_HEIGHT][HT_WIDTH][3];
static void plain_filter(int x, int w, int l, int r, int t, int arg)
{
    static ht_scene_t sub;
    static uint16_t px[HT_WIDTH * HT_HEIGHT];
    static double a[HT_HEIGHT][HT_WIDTH][3];
    ht_scene_clear(&sub, 0);
    marks(&sub, x, &arg);
    ht_raster(&sub, (ht_rect_t){(int16_t)x, 0, (int16_t)w, HT_HEIGHT}, px);
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int i = 0; i < w; i++) {
            const uint16_t c = px[y * w + i];
            a[y][i][0] = (c >> 11) * 255.0 / 31;
            a[y][i][1] = (c >> 5 & 63) * 255.0 / 63;
            a[y][i][2] = (c & 31) * 255.0 / 31;
        }
    // Sigma as the layer has it: in eighths of a px, 1.2 t logical px (1.297 px across, 1.5 down at 480 a logical px).
    const double sx = ((t * 1245 / 100 + MAX_ONE / 2) / MAX_ONE) / 8.0;
    const double sy = ((t * 144 * HT_HEIGHT / 4800 + MAX_ONE / 2) / MAX_ONE) / 8.0;
    double kx[11], ky[11], nx = 0, ny = 0;
    for (int i = -5; i <= 5; i++) {
        kx[i + 5] = sx < .3 ? i == 0 : exp(-i * i / (2 * sx * sx)), nx += kx[i + 5];
        ky[i + 5] = sy < .3 ? i == 0 : exp(-i * i / (2 * sy * sy)), ny += ky[i + 5];
    }
    static double b[HT_HEIGHT][HT_WIDTH][3];
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int i = 0; i < w; i++)
            for (int c = 0; c < 3; c++) {
                double v = 0;
                for (int k = -5; k <= 5; k++)
                    if (y + k >= 0 && y + k < HT_HEIGHT) v += ky[k + 5] * a[y + k][i][c];
                b[y][i][c] = v / ny;
            }
    const double tt = (double)t / MAX_ONE, br = 1 - .38 * tt, sat = 1 - .45 * tt;
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int g = l; g < r; g++) {
            const int i = g - x;
            double v[3] = {0, 0, 0};
            for (int k = -5; k <= 5; k++)
                if (i + k >= 0 && i + k < w)
                    for (int c = 0; c < 3; c++) v[c] += kx[k + 5] * b[y][i + k][c];
            for (int c = 0; c < 3; c++) v[c] /= nx;
            const double R = v[0], G = v[1], B = v[2];   // the Filter Effects saturate matrix, then b, then opacity b
            REF[y][g][0] = br * br * ((.213 + .787 * sat) * R + (.715 - .715 * sat) * G + (.072 - .072 * sat) * B);
            REF[y][g][1] = br * br * ((.213 - .213 * sat) * R + (.715 + .285 * sat) * G + (.072 - .072 * sat) * B);
            REF[y][g][2] = br * br * ((.213 - .213 * sat) * R + (.715 - .715 * sat) * G + (.072 + .928 * sat) * B);
        }
}
// The layer just shown on S (its last run, a window of an image: PRO_IMAGE 3) against REF over [l, r): every pixel
// within 1.6 of its RGB565 levels (the dither's 1, the rest the integer filter's roundings).
static bool matches_plain(int l, int r)
{
    const ht_run_t *run = &S.runs[S.count - 1];
    if (run->pro_kind != 3 || run->x != l || run->w != r - l) return false;
    double worst = 0;
    int wx = 0, wy = 0;
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int g = l; g < r; g++) {
            const uint16_t c = run->bitmap.pixels[(size_t)y * run->bitmap.width + (g - l)];
            const double d[3] = {fabs((c >> 11) - REF[y][g][0] * 31 / 255),
                                 fabs((c >> 5 & 63) - REF[y][g][1] * 63 / 255),
                                 fabs((c & 31) - REF[y][g][2] * 31 / 255)};
            for (int k = 0; k < 3; k++)
                if (d[k] > worst) worst = d[k], wx = g, wy = y;
        }
    if (worst <= 1.6) return true;
    fprintf(stderr, "  %.2f levels off V3's filter at (%d, %d)\n", worst, wx, wy);
    return false;
}

// A settled sliver (kept) and one between looks, its window cut by the row's end, dimmed and blurred as V3's _Dim:
// worked out near the edges only, the same as everywhere.
static void test_layer_filter(void)
{
    static const int SLIVER = SLIVER_W, CUT = CELL_W - 120;
    const int x = ROW_X + 300;
    ht_scene_clear(&S, 0);
    max_layer_frame();
    max_layer_kept(&S, x, x, x + SLIVER_W, marks, &SLIVER);
    plain_filter(x, SLIVER_W, x, x + SLIVER_W, MAX_ONE, SLIVER);
    CHECK(matches_plain(x, x + SLIVER_W));
    // Half way dimmed, the agent's left 60 px past the row's start.
    max_layer_frame();
    max_layer_fresh(&S, x, CUT, x + 60, x + CUT, MAX_ONE / 2, marks, &CUT);
    plain_filter(x, CUT, x + 60, x + CUT, MAX_ONE / 2, CUT);
    CHECK(matches_plain(x + 60, x + CUT));
}

int main(void)
{
    test_curves();
    test_opening();
    test_carry();
    test_closing();
    test_front();
    test_fresh_page();
    test_frame_clock();
    test_drawn();
    test_layer_kept();
    test_layer_filter();
    printf("test_max_motion: %d checks passed\n", checks);
    return 0;
}
