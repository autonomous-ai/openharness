// What loops and fades by the clock (max_ui_view.c, max_ui_overview.c, max_ui_agent.c, max_ui_lists.c) against V3's
// numbers: the chip's dot and an asking chip's pulse, the rail's sweep and pulse, the asking glow's breath, the talk
// band's colours and its live dot's glow, Inbox's unread dot, the row's faded ends, and the toast, the done note and the
// notice coming in and going. The loops run from when the page came up, wake the render task only while something on
// the glass loops, and leave what does not loop (a cell's pet, a sliver's layer) as it was.
#include <math.h>

#include "max_test.h"
#include "max_ui_motion.h"
#include "pod/pod_draw.h"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
static const pro_ask_item_t ASK = {"q1", "Which database?", {"Postgres", "SQLite"}, 2, false, true};
#define T0 1000000u
enum { K_TEXT = 1, K_IMAGE = 3, K_RECT_AA = 4, K_GRAD = 18 };
enum { CHIP_DOT = DX(8), LIVE_DOT = DX(12), FADE_W = DX(64), HALO_N = 63, NOTE_DOT = DY(12) };
#define BAND_Y (HT_HEIGHT - DY(16) - DY(96))
static uint16_t PX[HT_WIDTH * HT_HEIGHT];

// ---- V3's numbers, as doubles give them ----

static double bez(double a, double b, double m) { return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m; }
// Flutter's Cubic.transform: halving [0, 1] until the curve's x is within .001 of t.
static double cubic(double x1, double y1, double x2, double y2, double t)
{
    double lo = 0, hi = 1;
    for (;;) {
        const double mid = (lo + hi) / 2, x = bez(x1, x2, mid);
        if (fabs(t - x) < .001) return bez(y1, y2, mid);
        if (x < t) lo = mid;
        else hi = mid;
    }
}
static double ease(double t) { return cubic(.25, .1, .25, 1, t); }
static double ease_in_out(double t) { return cubic(.42, 0, .58, 1, t); }
// motion.dart's keyframes(p, from, to, at: .5, curve).
static double keyframes(double p, double from, double to, double (*curve)(double))
{
    return p < .5 ? from + (to - from) * curve(p / .5) : to + (from - to) * curve((p - .5) / .5);
}
// k of colour a over b, each channel rounded.
static unsigned mix(unsigned a, unsigned b, double k)
{
    unsigned out = 0;
    for (int sh = 0; sh <= 16; sh += 8)
        out |= (unsigned)lround(((a >> sh) & 255) * k + ((b >> sh) & 255) * (1 - k)) << sh;
    return out;
}
// Within a level of RGB565 in every channel.
static bool near565(uint16_t got, unsigned rgb)
{
    const uint16_t want = ht_rgb(rgb);
    if (abs((got >> 11) - (want >> 11)) <= 1 && abs((got >> 5 & 63) - (want >> 5 & 63)) <= 1 &&
        abs((got & 31) - (want & 31)) <= 1)
        return true;
    fprintf(stderr, "  got %04x, want %04x (%06x)\n", got, want, rgb);
    return false;
}
static bool near(int got, int want, int tol)
{
    if (abs(got - want) <= tol) return true;
    fprintf(stderr, "  got %d, want %d (within %d)\n", got, want, tol);
    return false;
}

// ---- the scene ----

static int index_of(const char *t)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, t)) return i;
    return -1;
}
// The chip's runs before its word: its edge, its fill, its dot.
static const ht_run_t *chip_part(const char *id, int back)
{
    const int i = index_of(max_status_word(max_find(id)));
    CHECK(i >= 3);
    return &S.runs[i - back];
}
static const ht_run_t *run_at(int kind, int x, int y)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == kind && S.runs[i].x == x && S.runs[i].y == y) return &S.runs[i];
    return NULL;
}
static const ht_run_t *image_w(int w)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_IMAGE && S.runs[i].bitmap.width == w) return &S.runs[i];
    return NULL;
}
static uint16_t pixel(int x, int y)
{
    ht_raster(&S, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, PX);
    return PX[y * HT_WIDTH + x];
}

// a asks, b works, c rests: App Detail's three cells, drawn first at T0, where the page's loops start.
static void three(void)
{
    linked(ABCDE, 3);
    max_ui_turn("b", "started", "", 0, T0 - 9000);
    max_ui_question("a", "r1", ASK.q, &ASK, 1, false, false, T0 - 9000);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    render(T0);
    CHECK(max_find("a")->state == MAX_ASKING && max_find("b")->state == MAX_WORKING);
}

// ---- the curves ----

static void test_curves(void)
{
    for (int i = 0; i <= 20; i++) {
        const int32_t t = i * 65536 / 20;
        CHECK(near(max_ease(MAX_EASE_IN_OUT, t), (int)lround(ease_in_out(t / 65536.0) * 65536), 66));
    }
    for (int i = 0; i <= 16; i++) {
        const int32_t p = i * 65536 / 16;
        CHECK(near(max_keyframes(p, MAX_ONE, MAX_PULSE_LOW, MAX_EASE_IN_OUT),
                   (int)lround(keyframes(p / 65536.0, 1, .35, ease_in_out) * MAX_ONE), 5));
        CHECK(near(max_keyframes(p, 180, 50, MAX_EASE), (int)lround(keyframes(p / 65536.0, 180, 50, ease)), 1));
    }
    CHECK(max_keyframes(0, 180, 50, MAX_EASE_IN_OUT) == 180 && max_keyframes(32768, 180, 50, MAX_EASE_IN_OUT) == 50);
}

// ---- the chip ----

// A working agent's dot: 1 to .25 and back over the pill every 1.2 s (easeInOut); an asking agent's whole chip to .35
// and back every 1 s. A resting agent's chip holds still.
static void test_chip(void)
{
    three();
    const unsigned c = ACCENT, fill = max_mix(ACCENT, GROUND, 15);
    for (uint32_t t = 0; t <= 1200; t += 150) {
        render(T0 + t);
        const double lit = keyframes(t % 1200 / 1200.0, 1, .25, ease_in_out);
        CHECK(near565(chip_part("b", 1)->fg, mix(c, fill, lit)));
        CHECK(chip_part("b", 2)->fg == ht_rgb(fill));   // the pill holds still
        const double o = keyframes(t % 1000 / 1000.0, 1, .35, ease_in_out);
        CHECK(near565(chip_part("a", 2)->fg, mix(max_mix(WAIT, GROUND, 15), GROUND, o)));
        CHECK(near565(chip_part("a", 1)->fg, mix(WAIT, GROUND, o)));
        CHECK(near565(S.runs[index_of("Needs you")].fg, mix(WAIT, GROUND, o)));
        CHECK(chip_part("c", 1)->fg == ht_rgb(CHIP_IDLE));
    }
    render(T0 + 600);   // the dot's faintest
    CHECK(near565(chip_part("b", 1)->fg, mix(c, fill, .25)));
    render(T0 + 2000);   // the asking chip round twice, back where it was
    CHECK(chip_part("a", 1)->fg == ht_rgb(WAIT) && chip_part("a", 2)->fg == ht_rgb(max_mix(WAIT, GROUND, 15)));
}

// ---- the rail and the glow ----

static void test_rail(void)
{
    three();
    const max_box_t *b = cell_of("b"), *a = cell_of("a");
    const int lw = CELL_W * 55 / 100, peak = b->x + lw * 95 / 100;
    // At the loop's start the light lies before the rail: the rail is its own colour all along.
    CHECK(pixel(peak, 2) == ht_rgb(ACCENT) && pixel(b->x + 3, 2) == ht_rgb(ACCENT));
    // Half way round, the light's middle at .95 of its length: white there, the rail's own before the light.
    render(T0 + 750);
    CHECK(near565(pixel(peak, 2), 0xFFFFFF) && near565(pixel(b->x + lw / 4, 2), ACCENT));
    CHECK(near565(pixel(peak - lw / 4, 2), mix(0xFFFFFF, ACCENT, .5)));
    CHECK(pixel(peak, RAIL_H) != pixel(peak, 2));   // only the rail
    // The asking rail at .35 over its glow's top, which breathes .20 to .05 and back over the same second.
    render(T0 + 500);
    const unsigned top = ((WAIT >> 16 & 255) * 50 / 1000) << 16 | ((WAIT >> 8 & 255) * 50 / 1000) << 8 |
                         (WAIT & 255) * 50 / 1000;   // .05 of it, rounded down as the glow's mix rounds
    CHECK(near565(pixel(a->x + 40, 2), mix(WAIT, top, .35)));
    CHECK(run_at(K_GRAD, a->x, 0)->fg == ht_rgb(top));
    render(T0 + 1000);
    CHECK(pixel(a->x + 40, 2) == ht_rgb(WAIT) && run_at(K_GRAD, a->x, 0)->fg == ht_rgb(max_mix(WAIT, GROUND, 20)));
    render(T0 + 250);   // a quarter round: .125
    const double g = keyframes(.25, .20, .05, ease_in_out);
    CHECK(near565(run_at(K_GRAD, a->x, 0)->fg, mix(WAIT, GROUND, g)));
    // The working and the resting glows hold still: the working one's .20 (max_glow_pct), the resting one none.
    CHECK(run_at(K_GRAD, b->x, 0)->fg == ht_rgb(max_mix(ACCENT, GROUND, 20)) && !run_at(K_GRAD, cell_of("c")->x, 0));
}

// The pet over the breathing glow keeps the ground it was baked on. The cells' pets play (max_ui_overview.c): a frame
// that draws them as the last did bakes nothing anew as the glow moves, and a new frame of theirs bakes at most once
// each.
static int cell_pets(ht_run_t *pets, int cap)
{
    int n = 0;
    for (int i = 0; i < S.count && n < cap; i++)
        if (S.runs[i].pro_kind == 16) pets[n++] = S.runs[i];   // pod_draw.h POD_CELL
    return n;
}
static void test_pet_still(void)
{
    three();
    render(T0 + 33);
    ht_run_t pets[8], now[8];
    int n = cell_pets(pets, 8);
    CHECK(n >= 3);
    unsigned bakes = pod_cell_bakes();
    int held = 0, moved = 0;
    for (uint32_t t = 66; t <= 1200; t += 33) {
        render(T0 + t);
        const int m = cell_pets(now, 8);
        if (m == n && !memcmp(now, pets, (size_t)n * sizeof pets[0])) {
            CHECK(pod_cell_bakes() == bakes);
            held++;
        } else {
            CHECK(pod_cell_bakes() <= bakes + (unsigned)m);
            moved++;
        }
        memcpy(pets, now, sizeof now);
        n = m;
        bakes = pod_cell_bakes();
    }
    CHECK(held > 0 && moved > 0);
}

// ---- the frame clock ----

// When Ambient's three pets next move: the first of their next steps.
static uint32_t demo_pets_step(uint32_t t)
{
    const uint32_t steps[] = {max_pet_next_ms("claude", POD_SCENE_RELAX, t), max_pet_next_ms("muse", POD_SCENE_RELAX, t),
                              max_pet_next_ms("codex", POD_SCENE_REST, t)};
    uint32_t ms = MAX_WAKE_MS;
    for (int i = 0; i < 3; i++)
        if (steps[i] < ms) ms = steps[i];
    return ms;
}
// When Ambient next moves: its drift's frame, or its pets' next step if sooner.
static uint32_t ambient_step(uint32_t t)
{
    const uint32_t pets = demo_pets_step(t);
    return pets < MAX_LOOP_FRAME_MS ? pets : MAX_LOOP_FRAME_MS;
}

// When the cells' pets next move (they play at rest, max_ui_overview.c): the first of their next steps.
static uint32_t cells_step(uint32_t t)
{
    uint32_t ms = MAX_WAKE_MS;
    for (int i = 0; i < max_m.cell_hits; i++) {
        const max_agent_t *a = max_find(max_m.cell_id[i]);
        const uint32_t step = a ? max_pet_next_ms(a->engine, max_pet_scene(a, false), t) : MAX_WAKE_MS;
        if (step < ms) ms = step;
    }
    return ms;
}

static void test_clock(void)
{
    // Something loops: a frame every MAX_LOOP_FRAME_MS, or sooner at a cell's pet's next step.
    three();
    const uint32_t first = cells_step(T0) < MAX_LOOP_FRAME_MS ? cells_step(T0) : MAX_LOOP_FRAME_MS;
    CHECK(max_motion_ms(T0) == first && max_ui_next_wake_ms(T0) <= first);
    CHECK((first <= 5 || !max_ui_tick(T0 + 5)) && max_ui_tick(T0 + first));
    // Nothing that loops: the render task wakes only for the cells' pets' next step.
    linked(ABCDE, 3);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    render(T0);
    CHECK(cells_step(T0) > MAX_LOOP_FRAME_MS && cells_step(T0) < MAX_WAKE_MS && max_motion_ms(T0) == cells_step(T0));
    // Ambient loops nothing, whatever the agents do: the render task wakes for its drift's frame and its pets' steps.
    three();
    max_show(MAX_VIEW_AMBIENT);
    render(T0 + 10);
    CHECK(max_motion_ms(T0 + 10) == ambient_step(T0 + 10));
    // A page's loops start when it comes up; the agent page's are App Detail's.
    max_show(MAX_VIEW_OVERVIEW);
    render(T0 + 500);
    CHECK(max_m.page_from == T0 + 500);
    max_open("b");
    render(T0 + 700);
    CHECK(max_m.page_from == T0 + 500);
    // Slivers are kept layers: their rails and glows hold still, nothing painted again as the open agent loops.
    render(T0 + 1500);
    const unsigned painted = max_layer_painted(), bakes = pod_cell_bakes();
    for (uint32_t t = 1533; t < 3000; t += 33) render(T0 + t);
    CHECK(max_layer_painted() == painted && pod_cell_bakes() == bakes);
    CHECK(max_motion_ms(T0 + 2985) > 0 && max_motion_ms(T0 + 2985) <= MAX_LOOP_FRAME_MS);
}

// Ambient's pets are the demo's three, whatever the ring holds (V3 ambient_page.dart _Pets): Claude and the Muse
// relaxing and Codex idling, left to right, playing by the clock. A step changes the glass only where they stand.
// The pets' frames on the glass (the image runs), left to right.
static int pet_frames(ht_run_t *out, int max)
{
    int n = 0;
    for (int i = 0; i < S.count && n < max; i++)
        if (S.runs[i].pro_kind == 16) out[n++] = S.runs[i];
    return n;
}
// The runs of `kind` on the glass, in order.
static int runs_of(int kind, ht_run_t *out, int max)
{
    int n = 0;
    for (int i = 0; i < S.count && n < max; i++)
        if (S.runs[i].pro_kind == kind) out[n++] = S.runs[i];
    return n;
}
static void ambient_of(const char *engine, int n)
{
    static const char *const IDS[] = {"x", "y", "z", "w"};
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    if (n) roster_of(IDS, n, engine);
    max_show(MAX_VIEW_AMBIENT);
}
static void test_ambient_pets(void)
{
    static ht_scene_t before;
    static ht_run_t first[8], now[8];
    ht_damage_t d;
    three();
    max_show(MAX_VIEW_AMBIENT);
    render(T0);
    CHECK(max_motion_ms(T0) == ambient_step(T0));
    const int n = pet_frames(first, 8);
    CHECK(n == 3 && first[0].x < first[1].x && first[1].x < first[2].x);
    // The same three at the same clock with Codex's agents, a logo's, none, and no link.
    const char *const engines[] = {"codex", "aider", "claude"};
    const int counts[] = {4, 1, 0};
    for (int k = 0; k <= 3; k++) {
        if (k < 3) ambient_of(engines[k], counts[k]);
        else max_ui_reset();   // no link: Ambient
        render(T0);
        CHECK(max_m.view == MAX_VIEW_AMBIENT && max_motion_ms(T0) == ambient_step(T0));
        CHECK(pet_frames(now, 8) == n && !memcmp(now, first, (size_t)n * sizeof now[0]));
    }
    // Round its frames the pets and the specks move; the clock, the date and the words stay.
    three();
    max_ui_wall(true, 15, 7, 3, 18, 10);
    max_show(MAX_VIEW_AMBIENT);
    render(T0);
    static ht_run_t words[8], again[8];
    const int nw = runs_of(K_TEXT, words, 8);
    CHECK(nw >= 3);
    bool moved = false;
    uint32_t t = T0;
    for (int i = 0; i < 40; i++) {
        t += max_motion_ms(t) ? max_motion_ms(t) : 1;
        before = S;
        render(t);
        CHECK(max_motion_ms(t) == ambient_step(t) && S.count < HT_RUNS);
        CHECK(runs_of(K_TEXT, again, 8) == nw && !memcmp(again, words, (size_t)nw * sizeof words[0]));
        ht_damage(&before, &S, &d);
        moved |= d.pixels > 0;
    }
    CHECK(moved);
}

// V3's drift (aurora.dart step), as doubles give it: one 60 Hz step of `frame` (its frames after the step).
static void v3_drift(double *x, double *y, int n, int frame)
{
    const double k = frame * (1000.0 / 60) / 6000;
    for (int i = 0; i < n; i++) {
        const double ang = sin(x[i] * 0.003 + k) * 1.2 + cos(y[i] * 0.012 - k * 1.3);
        x[i] += cos(ang) * 0.45 + 0.12;
        y[i] += sin(ang) * 0.3;
        if (x[i] > 1480) x[i] = 0;
        if (x[i] < 0) x[i] = 1480;
        if (y[i] > 320) y[i] = 0;
        if (y[i] < 0) y[i] = 320;
    }
}
// Within tol of each other on a ring `size` round (a speck that wrapped).
static bool near_ring(double a, double b, double size, double tol)
{
    double d = fabs(a - b);
    if (size - d < d) d = size - d;
    if (d <= tol) return true;
    fprintf(stderr, "  got %f, want %f (within %f)\n", a, b, tol);
    return false;
}
enum { SPECKS = 150 };
static int drift_now(double *x, double *y)
{
    float fx, fy;
    int n = 0;
    while (max_drift_speck(n, &fx, &fy)) {
        CHECK(n < SPECKS && fx >= 0 && fx <= 1480 && fy >= 0 && fy <= 320);
        x[n] = fx;
        y[n++] = fy;
    }
    return n;
}

// Ambient's specks drift as V3's (aurora.dart): 150 of them on its flow field, 60 steps a second of the clock in V3's
// px, starting a second in when Ambient comes up, at most 4 steps a frame (a stall slows the drift, the clock jumps).
static void test_ambient_drift(void)
{
    static double x[SPECKS], y[SPECKS], got_x[SPECKS], got_y[SPECKS], first_x[SPECKS], first_y[SPECKS];
    three();
    max_show(MAX_VIEW_AMBIENT);
    render(T0);
    CHECK(drift_now(first_x, first_y) == SPECKS && max_drift_frames() == 60);
    memcpy(x, first_x, sizeof x);
    memcpy(y, first_y, sizeof y);
    // Frame by frame, each step V3's from where the specks stood.
    int frames = 60;
    for (uint32_t t = T0 + MAX_LOOP_FRAME_MS; t <= T0 + 6000; t += MAX_LOOP_FRAME_MS) {
        render(t);
        const int due = (int)((1000u + (t - T0)) * 60u / 1000u);
        CHECK(due - frames <= 4);
        while (frames < due) v3_drift(x, y, SPECKS, ++frames);
        CHECK(max_drift_frames() == frames && drift_now(got_x, got_y) == SPECKS);
        for (int i = 0; i < SPECKS; i++) CHECK(near_ring(got_x[i], x[i], 1480, .01) && near_ring(got_y[i], y[i], 320, .01));
        memcpy(x, got_x, sizeof x);
        memcpy(y, got_y, sizeof y);
    }
    // A stalled glass: its clock jumps, the specks take 4 steps.
    const uint32_t late = T0 + 6000 + 10000;
    render(late);
    const int due = (int)((1000u + (late - T0)) * 60u / 1000u);
    for (frames = due - 4; frames < due;) v3_drift(x, y, SPECKS, ++frames);
    CHECK(max_drift_frames() == due && drift_now(got_x, got_y) == SPECKS);
    for (int i = 0; i < SPECKS; i++) CHECK(near_ring(got_x[i], x[i], 1480, .01) && near_ring(got_y[i], y[i], 320, .01));
    // Ambient again later: the field comes up as it first did.
    max_show(MAX_VIEW_OVERVIEW);
    render(late + 500);
    max_show(MAX_VIEW_AMBIENT);
    render(late + 900);
    CHECK(max_drift_frames() == 60 && drift_now(got_x, got_y) == SPECKS);
    CHECK(!memcmp(got_x, first_x, sizeof got_x) && !memcmp(got_y, first_y, sizeof got_y));
}

// Between two loop frames the glass changes only where something loops: a working agent's rail and dot, an asking
// agent's glow, rail and chip, and the cells' pets that took a step (they play, max_ui_overview.c).
static void test_damage(void)
{
    static ht_scene_t before;
    ht_damage_t d;
    linked(ABCDE, 3);
    max_ui_turn("b", "started", "", 0, T0 - 9000);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    render(T0);
    render(T0 + 990);
    before = S;
    render(T0 + 1023);
    ht_damage(&before, &S, &d);
    uint32_t pets_px = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == 16) pets_px += (uint32_t)S.runs[i].w * (uint32_t)S.runs[i].pro_height;
    CHECK(d.count >= 1 && d.pixels > 0 && d.pixels <= (uint32_t)(CELL_W * RAIL_H + 64 * DY(34)) + pets_px);
    // Every frame round the loops, the light coming onto its rail and going off it too: the runs keep their places.
    three();
    for (uint32_t t = 16; t <= 3200; t += 16) {
        before = S;
        render(T0 + t);
        ht_damage(&before, &S, &d);
        CHECK(S.count == before.count && d.pixels <= (uint32_t)(CELL_W * (DY(138) + 2 * RAIL_H) + 4 * 300 * DY(34)));
    }
}

// ---- the open agent's band ----

static const ht_run_t *band_fill(void)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].y == BAND_Y + 1 && S.runs[i].pro_height == DY(96) - 2)
            return &S.runs[i];
    return NULL;
}
static const ht_run_t *live_dot(void)
{
    const int cy = BAND_Y + DY(30);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == LIVE_DOT && S.runs[i].y == cy - LIVE_DOT / 2)
            return &S.runs[i];
    return NULL;
}

// Its colours ease 300 ms (Curves.ease) between talking and not; the live dot pulses to .35 and back every 0.8 s
// (Curves.ease) over its fill, in its glow; sending, the dot is a still grey with no glow.
static void test_band(void)
{
    three();
    max_show(MAX_VIEW_INBOX);
    render(T0 - 50);
    max_m.view = MAX_VIEW_AGENT;   // a page just up: the agent open at rest, its loops from T0
    max_copy(max_m.selected, sizeof max_m.selected, "b");
    render(T0);
    render(T0 + 100);
    const unsigned talk_fill = max_mix(VOICE, GROUND, 6);
    CHECK(band_fill()->fg == ht_rgb(BAND_BG) && !live_dot());
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "b");
    max_ui_talk(MAX_TALK_RECORDING, T0 + 1000);
    render(T0 + 1000);
    CHECK(band_fill()->fg == ht_rgb(BAND_BG) && max_motion_ms(T0 + 1000) == MAX_ROW_FRAME_MS);
    render(T0 + 1150);
    CHECK(near565(band_fill()->fg, mix(talk_fill, BAND_BG, ease(.5))));
    render(T0 + 1300);
    CHECK(band_fill()->fg == ht_rgb(talk_fill));
    render(T0 + 1600);   // the loop's start: the dot whole, its glow whole
    CHECK(live_dot()->fg == ht_rgb(VOICE) && image_w(HALO_N) && image_w(HALO_N)->radius == 0);
    const ht_run_t *halo = image_w(HALO_N);
    CHECK(halo->x == live_dot()->x + LIVE_DOT / 2 - HALO_N / 2 && halo->y == BAND_Y + DY(30) - HALO_N / 2);
    CHECK(halo->bitmap.alpha[HALO_N * (HALO_N / 2) + HALO_N / 2] == 0);                      // none over the dot
    CHECK(near(halo->bitmap.alpha[HALO_N * (HALO_N / 2) + HALO_N / 2 + 9], 47, 2));          // 9 px out, .19
    CHECK(halo->bitmap.alpha[HALO_N * (HALO_N / 2)] <= 1 && halo->bitmap.alpha[0] == 0);   // gone by its edge
    for (uint32_t t = 100; t < 800; t += 100) {
        render(T0 + 1600 + t);
        const double o = keyframes(t / 800.0, 1, .35, ease);
        CHECK(near565(live_dot()->fg, mix(VOICE, talk_fill, o)));
        CHECK(near(image_w(HALO_N)->radius, (int)(o * 255), 3));
    }
    max_ui_talk(MAX_TALK_SENDING, T0 + 2500);
    render(T0 + 2500);
    CHECK(live_dot()->fg == ht_rgb(REST) && !image_w(HALO_N));
    // Talking ends: back to the quiet band's colours over the same 300 ms.
    max_ui_talk(MAX_TALK_IDLE, T0 + 3000);
    render(T0 + 3000);
    render(T0 + 3150);
    CHECK(near565(band_fill()->fg, mix(talk_fill, BAND_BG, 1 - ease(.5))) && !live_dot());
    render(T0 + 3300);
    CHECK(band_fill()->fg == ht_rgb(BAND_BG));
    // Another page and back: the band where it is, no easing.
    max_show(MAX_VIEW_INBOX);
    render(T0 + 4000);
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "b");
    max_ui_talk(MAX_TALK_RECORDING, T0 + 4500);
    max_m.view = MAX_VIEW_AGENT;
    render(T0 + 4500);
    CHECK(band_fill()->fg == ht_rgb(talk_fill));
}

// ---- Inbox ----

static void notices(int n)
{
    max_m.inbox_count = 0;
    for (int i = 0; i < n; i++) {
        max_inbox_t *e = &max_m.inbox[max_m.inbox_count++];
        snprintf(e->id, sizeof e->id, "n%d", i);
        snprintf(e->name, sizeof e->name, "a");
        snprintf(e->engine, sizeof e->engine, "claude");
        snprintf(e->text, sizeof e->text, "%s", ASK.q);
        e->at = T0 - 60000;
        e->unread = true;
    }
}
static const ht_run_t *unread_dot(void)
{
    const ht_run_t *last = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == NOTE_DOT && S.runs[i].pro_height == NOTE_DOT)
            last = &S.runs[i];
    return last;
}

// An unread card's dot pulses to .35 and back every 1.4 s (easeInOut), over the lit card; nothing loops once all are
// read.
static void test_inbox(void)
{
    linked(ABCDE, 3);
    notices(1);
    max_m.view = MAX_VIEW_INBOX;
    render(T0);
    CHECK(unread_dot()->fg == ht_rgb(WAIT) && max_motion_ms(T0) == MAX_LOOP_FRAME_MS);
    for (uint32_t t = 175; t <= 1400; t += 175) {
        render(T0 + t);
        CHECK(near565(unread_dot()->fg, mix(WAIT, NOTE_LIT, keyframes(t / 1400.0, 1, .35, ease_in_out))));
    }
    max_m.inbox[0].unread = false;
    render(T0 + 1500);
    CHECK(!unread_dot() && max_motion_ms(T0 + 1500) == MAX_WAKE_MS);
}

// ---- the row's faded ends ----

static const ht_run_t *fade(bool left)
{
    return run_at(K_IMAGE, left ? ROW_X : ROW_X + ROW_W - FADE_W, RAIL_H);
}
static int opacity(const ht_run_t *r) { return !r ? 0 : r->radius ? r->radius : 255; }

// Black from .9 at the row's end to clear 64 design px in, under the rails, while more of the row lies that way (by
// more than 4): eased in and out over 250 ms (Curves.ease) as the row scrolls.
static void test_fades(void)
{
    linked(ABCDE, 3);   // the row fits: neither
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    render(T0);
    CHECK(!fade(true) && !fade(false));
    linked(ABCDE, 5);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    render(T0);   // at its front: the right end only, whole at once on a page just up
    const ht_run_t *r = fade(false);
    CHECK(!fade(true) && opacity(r) == 255 && r->bitmap.width == FADE_W && r->bitmap.height == HT_HEIGHT - RAIL_H);
    CHECK(r->bitmap.alpha[FADE_W - 1] == (int)lround(.9 * 255 * (1 - .5 / FADE_W)) && r->bitmap.alpha[0] <= 2);
    CHECK(r->bitmap.alpha[FADE_W / 2] == r->bitmap.alpha[FADE_W / 2 + FADE_W * 200]);   // the same all the way down
    CHECK(pixel(ROW_X + ROW_W - 10, 2) == ht_rgb(IDLE_RAIL));   // under the rails
    CHECK(max_motion_ms(T0) == cells_step(T0));   // the fades hold still: only the cells' pets play
    // The finger drags the row 100 px on: the left end comes in over 250 ms.
    max_ui_touch(true, 1200, 240, T0 + 1000);
    max_ui_touch(true, 1100, 240, T0 + 1010);
    max_ui_touch(true, 1000, 240, T0 + 1020);
    render(T0 + 1020);
    CHECK(opacity(fade(true)) == 0 && max_motion_ms(T0 + 1020) == MAX_ROW_FRAME_MS);
    render(T0 + 1020 + 125);
    CHECK(near(opacity(fade(true)), (int)(ease(.5) * 255), 2) && opacity(fade(false)) == 255);
    render(T0 + 1020 + 250);
    CHECK(opacity(fade(true)) == 255);
    // Scrolled to the row's end: the right end goes.
    max_ui_touch(false, 1000, 240, T0 + 1400);
    max_m.row_first = 2;
    for (uint32_t t = T0 + 1400; t < T0 + 3000; t += MAX_ROW_FRAME_MS) render(t);
    CHECK(opacity(fade(true)) == 255 && !fade(false) && !max_row_moving(T0 + 3000));
}

// ---- the overlays ----

// The notice rises 20 design px as it fades in over 300 ms (Curves.ease), and goes the same way when its time is up,
// its words kept while it goes.
static void test_notice(void)
{
    linked(ABCDE, 3);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    render(T0 - 100);
    max_ui_notice("Saved to Inbox", 3000, T0);
    render(T0);
    CHECK(!text_run("Saved to Inbox") && max_motion_ms(T0) == MAX_ROW_FRAME_MS);
    render(T0 + 400);
    const ht_run_t rest = *text_run("Saved to Inbox");
    CHECK(rest.fg == ht_rgb(FG));
    render(T0 + 150);
    const int32_t v = (int32_t)lround(ease(.5) * MAX_ONE);
    const ht_run_t *r = text_run("Saved to Inbox");
    CHECK(r && near(r->y - rest.y, DY(20) * (MAX_ONE - v) / MAX_ONE, 1));
    CHECK(near565(r->fg, mix(FG, GROUND, (v * 256 / MAX_ONE) / 256.0)));
    // A notice already up only changes its words.
    max_ui_notice("Saved again", 3000, T0 + 500);
    render(T0 + 500);
    CHECK(text_run("Saved again")->fg == ht_rgb(FG));
    // Its time up, it goes; then nothing moves.
    render(T0 + 3500);
    CHECK(text_run("Saved again")->fg == ht_rgb(FG) && max_motion_ms(T0 + 3500) == MAX_ROW_FRAME_MS);
    render(T0 + 3650);
    r = text_run("Saved again");
    CHECK(r && near565(r->fg, mix(FG, GROUND, 1 - ease(.5))) && r->y > rest.y);
    render(T0 + 3800);
    CHECK(!text_run("Saved again") && max_motion_ms(T0 + 3800) == cells_step(T0 + 3800));   // gone: the pets play on
}

static bool hit(max_hit_kind_t kind)
{
    for (int i = 0; i < max_m.hit_count; i++)
        if (max_m.hits[i].kind == kind) return true;
    return false;
}
// The done note slides 24 design px in from the right as it fades in over 300 ms, its pet by its alpha; it goes the
// same way, what it said kept, and takes the finger only while the model shows it.
static void test_done_note(void)
{
    linked(ABCDE, 3);
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;
    max_ui_turn("c", "started", "", 0, T0 - 9000);
    render(T0 - 100);
    max_ui_summary("c", "All green.", NULL, false, POD_TIER_ALERT, T0);
    max_show(MAX_VIEW_OVERVIEW);
    render(T0 + 400);
    CHECK(max_done_shown(T0 + 400) && hit(MAX_HIT_DONE_NOTE));
    const int rest_x = text_run(" is done")->x;
    render(T0 + 150);
    const int32_t v = (int32_t)lround(ease(.5) * MAX_ONE);
    CHECK(near(text_run(" is done")->x - rest_x, DX(24) * (MAX_ONE - v) / MAX_ONE, 1));
    bool faded_pet = false;
    for (int i = 0; i < S.count; i++) faded_pet |= S.runs[i].pro_kind == K_IMAGE && S.runs[i].radius > 0;
    CHECK(faded_pet);
    // It goes when its agent works again: no hit, its words kept a while.
    max_ui_turn("c", "started", "", 0, T0 + 1000);
    render(T0 + 1000);
    CHECK(!max_done_shown(T0 + 1000) && !hit(MAX_HIT_DONE_NOTE) && text_run("All green."));
    render(T0 + 1150);
    CHECK(text_run(" is done")->x > rest_x);
    render(T0 + 1300);
    CHECK(!text_run(" is done"));
}

// The toast rises as the notice does, and goes the same way.
static void test_toast(void)
{
    three();
    max_show(MAX_VIEW_INBOX);
    render(T0 - 50);
    max_m.view = MAX_VIEW_AGENT;
    max_copy(max_m.selected, sizeof max_m.selected, "b");
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "b");
    max_ui_talk(MAX_TALK_RECORDING, T0);
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "a");
    max_m.toast_attn = MAX_ATTN_ASK;
    max_m.toast_from = T0 + 1000;
    render(T0 + 1000);
    CHECK(!text_run("a asks") && hit(MAX_HIT_TOAST));
    render(T0 + 1400);
    const int rest_y = text_run("a asks")->y;
    render(T0 + 1150);
    CHECK(near(text_run("a asks")->y - rest_y, DY(20) * (MAX_ONE - (int32_t)lround(ease(.5) * MAX_ONE)) / MAX_ONE, 1));
    max_m.toast_id[0] = 0;
    render(T0 + 2000);
    CHECK(text_run("a asks") && !hit(MAX_HIT_TOAST));
    render(T0 + 2300);
    CHECK(!text_run("a asks"));
}

int main(void)
{
    test_curves();
    test_chip();
    test_rail();
    test_pet_still();
    test_clock();
    test_ambient_pets();
    test_ambient_drift();
    test_damage();
    test_band();
    test_inbox();
    test_fades();
    test_notice();
    test_done_note();
    test_toast();
    printf("test_max_loops: %d checks passed\n", checks);
    return 0;
}
