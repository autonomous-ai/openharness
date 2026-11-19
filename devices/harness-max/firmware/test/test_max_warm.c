// App Detail's next motion painted ahead (max_ui_warm.c): while the row rests, each open a tap can start and the open
// agent's close are drawn off the glass as the tap will draw them, so that the motion, with room for all of it,
// paints no image and bakes no pet frame from its first frame to its last (its open agent's pet, on the clock, may
// need a pose the warming did not land on: none when the tap comes on the warming's own clock); with room for less,
// every motion's first frames still; the glass shows the same pixels as without it; the model is left as it was; a
// step under the lock paints nothing, and what it needs is made out of it a band at a time, the same pixels as made
// whole; and nothing is painted ahead while the row is not at rest.
#include "max_test.h"
#include "pod/pod_draw.h"
#include "pod/pod_pet.h"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
#define T0 1000000u
#define STEPS 2000   // more than any page's warming takes

static uint16_t s_glass[HT_WIDTH * HT_HEIGHT];

static uint32_t fnv(const void *p, size_t n)
{
    const uint8_t *b = p;
    uint32_t h = 2166136261u;
    while (n--) h = (h ^ *b++) * 16777619u;
    return h;
}
// A frame at `now`, its whole glass rasterised: its pixels' hash.
static uint32_t frame(uint32_t now)
{
    render(now);
    for (int y = 0; y < HT_HEIGHT; y += 24) {
        const int h = HT_HEIGHT - y < 24 ? HT_HEIGHT - y : 24;
        ht_raster(&S, (ht_rect_t){0, (int16_t)y, HT_WIDTH, (int16_t)h}, s_glass + y * HT_WIDTH);
    }
    return fnv(s_glass, sizeof s_glass);
}

// n agents at rest on Overview (3 or more), a and d working, nothing kept: Claude's pets, b's and d's the HD Codex
// (its pet resampled below 1x), or all of `engine` (a logo where a pet would stand: small images); or the agent page
// of `open` (its mic off), the row at rest by T0 - MAX_ROW_FRAME_MS.
static void rest_of(int n, const char *open, const char *engine)
{
    max_layer_forget();
    pod_cell_bake_reset();
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    roster_of(ABCDE, n, engine ? engine : "claude");
    max_ui_turn("a", "started", "", 0, T0 - 6000);
    if (n > 3) max_ui_turn("d", "started", "", 0, T0 - 6000);
    for (int i = 1; !engine && i < n; i += 2) max_copy(max_m.agents[i].engine, sizeof max_m.agents[i].engine, "codex");
    max_show(MAX_VIEW_OVERVIEW);
    max_m.idle_from = T0;   // a person was here: Ambient waits a minute
    frame(T0 - 5000);
    if (open) {
        max_open(open);
        frame(T0 - 4000);
    }
    frame(T0 - 1000);
    frame(T0 - 500);
    frame(T0 - MAX_ROW_FRAME_MS);
    CHECK(!max_row_moving(T0 - MAX_ROW_FRAME_MS));
}
static void rest(int n, const char *open) { rest_of(n, open, NULL); }

// What the warming makes out of the lock, a band (or a bake) a call, or all it can.
static unsigned s_asked;
static bool one_band(void) { return s_asked++, false; }
static bool all_bands(void) { return s_asked++, true; }
static bool (*s_go_on)(void) = one_band;

// max_ui_warm until it has nothing left, max_ui_warm_paint first while it has something, as max_app.c steps them: a
// step under the lock leaves one image or layer at most to make and the model as it was (but for what the warming is
// of); one out of it leaves the model as it was. Its steps under the lock.
static int s_paints;   // and out of it
static int warm(uint32_t now)
{
    static max_model_t before;
    int steps = 0;
    s_paints = 0;
    for (bool more = true; more;) {
        CHECK(steps < STEPS && s_paints < 64 * STEPS);
        memcpy(&before, &max_m, sizeof before);
        if (max_ui_warm_paint(s_go_on)) {
            s_paints++;
            CHECK(!memcmp(&before, &max_m, sizeof before));
            continue;
        }
        const unsigned painted = max_layer_painted();
        more = max_ui_warm(now);
        steps++;
        CHECK(max_layer_painted() - painted <= 1);
        before.warm_key = max_m.warm_key;
        CHECK(!memcmp(&before, &max_m, sizeof before));
    }
    return steps;
}

// A tap on `id`'s cell (or its sliver) at `at` and the mic max_app.c opens for it; "" the open agent's X, the mic
// dropped.
static void tap(const char *id, uint32_t at)
{
    if (!id[0]) {
        const max_hit_t *x = NULL;
        for (int i = 0; i < max_m.hit_count && !x; i++)
            if (max_m.hits[i].kind == MAX_HIT_AGENT_X) x = &max_m.hits[i];
        CHECK(x != NULL);
        max_ui_touch(true, x->x + x->w / 2, x->y + x->h / 2, at);
        max_ui_touch(false, x->x + x->w / 2, x->y + x->h / 2, at);
        max_ui_talk(MAX_TALK_IDLE, at);
        CHECK(max_m.view == MAX_VIEW_OVERVIEW);
        return;
    }
    const max_box_t *b = cell_of(id);
    CHECK(b != NULL);
    const int x = b->x + b->w / 2, y = b->y + b->h / 2;
    max_ui_touch(true, x, y, at);
    CHECK(max_ui_touch(false, x, y, at).kind == MAX_ACT_OPEN_TALK);
    max_ui_talk(MAX_TALK_RECORDING, at);
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_m.selected, id));
}

// The motion a tap on `id` at `at` starts, until it rests: its frames' pixels into hash (as many as `frames`), and
// what it painted and baked.
typedef struct { int frames; unsigned painted, baked; uint32_t hash[128]; uint8_t paints[128]; } motion_t;
static motion_t motion_at(const char *id, uint32_t at)
{
    motion_t m = {0};
    const unsigned painted = max_layer_painted(), baked = pod_cell_bakes();
    tap(id, at);
    for (uint32_t now = at;; now += MAX_ROW_FRAME_MS) {
        CHECK(m.frames < 128);
        const unsigned p0 = max_layer_painted() + pod_cell_bakes();
        m.hash[m.frames] = frame(now);
        m.paints[m.frames++] = (uint8_t)(max_layer_painted() + pod_cell_bakes() - p0);
        if (!max_row_moving(now)) break;
    }
    m.painted = max_layer_painted() - painted;
    m.baked = pod_cell_bakes() - baked;
    return m;
}
static motion_t motion(const char *id) { return motion_at(id, T0); }

// What the ahead motion painted, frame by frame, when it should have painted nothing.
static void painted_where(const char *page, const char *tap, const motion_t *m, int steps)
{
    fprintf(stderr, "  %s, tap %s: %u painted, %u baked after %d steps ahead:", page ? page : "overview",
            tap[0] ? tap : "X", m->painted, m->baked, steps);
    for (int f = 0; f < m->frames; f++)
        if (m->paints[f]) fprintf(stderr, " f%d %u", f, m->paints[f]);
    fprintf(stderr, "\n");
}

// The taps the page at rest offers: its X on the agent page, then each cell or sliver on the glass.
static int taps_of(char taps[][ID_MAX])
{
    int n = 0;
    if (max_m.view == MAX_VIEW_AGENT) taps[n++][0] = 0;
    for (int i = 0; i < max_m.cell_hits; i++) max_copy(taps[n++], ID_MAX, max_m.cell_id[i]);
    return n;
}

// Each tap from each page at rest, cold and then painted ahead, the tap on the warming's clock: ahead, the motion
// paints and bakes nothing, and every frame is the same pixels as cold. The warming draws each motion as the tap
// draws it, to where it rests and no further: a step for each of its frames, and one more for each paint or bake a
// frame left to the next (five agents: the row scrolls, its ends fade and its dots in the app column move on later
// in the motion than its start).
static void test_ahead(void)
{
    const struct { int n; const char *page, *engine; } cases[] = {
        {3, NULL, NULL}, {3, "b", NULL}, {5, NULL, "grok"}, {5, "c", "grok"},
    };
    for (unsigned c = 0; c < sizeof cases / sizeof cases[0]; c++) {
        rest_of(cases[c].n, cases[c].page, cases[c].engine);
        char taps[MAX_ROW_HITS + 1][ID_MAX];
        const int n = taps_of(taps);
        CHECK(n == 3);
        static motion_t cold[MAX_ROW_HITS + 1];
        int most = 0;
        for (int t = 0; t < n; t++) {
            rest_of(cases[c].n, cases[c].page, cases[c].engine);
            cold[t] = motion(taps[t]);
            CHECK(cold[t].painted > 0);   // there is something to paint ahead
            most += cold[t].frames + (int)(cold[t].painted + cold[t].baked);
        }
        for (int t = 0; t < n; t++) {
            const char *tap = taps[t];
            rest_of(cases[c].n, cases[c].page, cases[c].engine);
            const int steps = warm(T0);
            CHECK(steps > 10 && steps <= most + 1);   // and the last, which finds nothing left
            const motion_t ahead = motion(tap);
            if (ahead.painted || ahead.baked) painted_where(cases[c].page, tap, &ahead, steps);
            CHECK(ahead.painted == 0 && ahead.baked == 0);
            CHECK(ahead.frames == cold[t].frames);
            CHECK(!memcmp(ahead.hash, cold[t].hash, (size_t)cold[t].frames * sizeof cold[t].hash[0]));
        }
    }
}

// Five agents, room for less than all their opens: painted ahead, then tapped off the warming's clock, every open's
// first frames (0 and 1) paint and bake nothing, and every frame is the same pixels as cold.
static void test_first_frames(void)
{
    rest(5, NULL);
    char taps[MAX_ROW_HITS + 1][ID_MAX];
    const int n = taps_of(taps);
    CHECK(n == 3);
    for (int t = 0; t < n; t++) {
        const char *tap = taps[t];
        rest(5, NULL);
        const motion_t cold = motion(tap);
        rest(5, NULL);
        const int steps = warm(T0 - 37);
        const motion_t ahead = motion(tap);
        if (ahead.paints[0] || ahead.paints[1]) painted_where(NULL, tap, &ahead, steps);
        CHECK(!ahead.paints[0] && !ahead.paints[1]);
        CHECK(ahead.painted < cold.painted);
        CHECK(ahead.frames == cold.frames);
        CHECK(!memcmp(ahead.hash, cold.hash, (size_t)cold.frames * sizeof cold.hash[0]));
    }
}

// Not at rest, nothing is painted ahead: a finger on the glass, the row moving, an overlay up, a page not App Detail's.
static void test_not_resting(void)
{
    rest(3, NULL);
    max_m.down = true;
    unsigned painted = max_layer_painted();
    CHECK(!max_ui_warm(T0));
    max_m.down = false;
    CHECK(max_layer_painted() == painted);

    max_open("b");
    render(T0);
    CHECK(max_row_moving(T0 + MAX_ROW_FRAME_MS) && !max_ui_warm(T0 + MAX_ROW_FRAME_MS));

    rest(3, NULL);
    max_notice_set("Cancelled, nothing sent", T0);
    render(T0);
    CHECK(!max_ui_warm(T0 + MAX_ROW_FRAME_MS));

    rest(3, NULL);
    max_show(MAX_VIEW_INBOX);
    render(T0);
    CHECK(!max_ui_warm(T0 + MAX_ROW_FRAME_MS));
    CHECK(max_layer_painted() == painted);
}

// A frame of the HD Codex below 1x on ground `i` (each ground its own bake), baked as a raster bakes it.
static void bake_one(unsigned i)
{
    static ht_scene_t one;
    static uint16_t px[1];
    ht_scene_clear(&one, 0);
    pod_pet_draw_flat(&one, 0, 0, 120, "codex", POD_SCENE_REST, 0, 0, i, 16);
    for (int r = 0; r < one.count; r++)
        if (one.runs[r].text[0] == 1) ht_raster(&one, (ht_rect_t){one.runs[r].x, one.runs[r].y, 1, 1}, px);
}

// The bakes with no room for one more start over (pod_draw.c), the glass's with them. The first time (other pages'
// bakes filled them), the warming bakes the glass's again and every motion's again from its start: the glass's next
// frame, and the motion's first frames, bake nothing. The second time (no room for the warming's), it bakes the
// glass's again and no more of its own.
static void test_bakes_full(void)
{
    rest(3, NULL);
    unsigned fill = 0, last = pod_cell_bake_px(), one = 0;
    while (pod_cell_bake_px() >= last) {   // how many more fit
        CHECK(fill < 1000);
        if (fill == 1) one = pod_cell_bake_px() - last;
        last = pod_cell_bake_px();
        bake_one(++fill);
    }
    CHECK(fill > 2);
    rest(3, NULL);
    for (unsigned i = 1; i < fill; i++) bake_one(i);   // as full as it gets
    const unsigned full = pod_cell_bake_px();
    warm(T0);
    CHECK(pod_cell_bake_px() < full);   // the warming's bakes had no room
    unsigned baked = pod_cell_bakes();
    frame(T0 - MAX_ROW_FRAME_MS);
    CHECK(pod_cell_bakes() == baked);
    char taps[MAX_ROW_HITS + 1][ID_MAX];
    taps_of(taps);
    const motion_t m = motion(taps[0]);
    CHECK(!m.paints[0] && !m.paints[1]);

    rest(3, NULL);
    for (unsigned i = 1; i < fill; i++) bake_one(i);
    unsigned ground = fill, starts = 0, px = pod_cell_bake_px();
    for (int steps = 0; max_ui_warm_paint(one_band) || max_ui_warm(T0); steps++) {
        CHECK(steps < 64 * STEPS);
        starts += pod_cell_bake_px() < px;
        if (starts == 1 && ground == fill)   // the first time: as full again
            while (pod_cell_bake_px() + one <= last) bake_one(++ground);
        px = pod_cell_bake_px();
    }
    CHECK(starts >= 2);
    baked = pod_cell_bakes();
    frame(T0 - MAX_ROW_FRAME_MS);
    CHECK(pod_cell_bakes() == baked);
}

// After a motion, the page it came to is painted ahead again: listening, only its X (a tap anywhere else sends what
// was said), which then starts warm too.
static void test_again(void)
{
    rest(3, NULL);
    warm(T0);
    motion("b");
    const uint32_t later = T0 + 2000;
    frame(later - 1000);
    frame(later - 500);
    frame(later - MAX_ROW_FRAME_MS);
    CHECK(max_m.talk == MAX_TALK_RECORDING);
    CHECK(warm(later) > 10);
    const motion_t m = motion_at("", later);
    if (m.painted || m.baked) painted_where("b", "", &m, 0);
    CHECK(m.painted == 0 && m.baked == 0);
}

// Out of the lock a call stops where it is told (at a band, or a bake: as many calls as bands and bakes), and an
// image made a band at a time is the same pixels as one made in one go.
static void test_bands(void)
{
    rest(3, NULL);
    s_go_on = all_bands;
    warm(T0);
    const int whole = s_paints;
    char taps[MAX_ROW_HITS + 1][ID_MAX];
    taps_of(taps);
    const motion_t in_one = motion(taps[1]);
    rest(3, NULL);
    s_go_on = one_band;
    s_asked = 0;
    warm(T0);
    CHECK(s_paints > 4 * whole && s_asked <= (unsigned)(2 * s_paints));   // asked once a band, twice at an image's end
    const motion_t banded = motion(taps[1]);
    CHECK(in_one.painted == 0 && banded.painted == 0 && banded.frames == in_one.frames);
    CHECK(!memcmp(banded.hash, in_one.hash, (size_t)in_one.frames * sizeof in_one.hash[0]));
}

int main(void)
{
    test_ahead();
    test_bands();
    test_first_frames();
    test_bakes_full();
    test_not_resting();
    test_again();
    printf("test_max_warm: %d checks passed\n", checks);
    return 0;
}
