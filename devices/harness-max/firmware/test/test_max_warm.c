// App Detail's next motion painted ahead (max_ui_warm.c): while the row rests, each open a tap can start and the open
// agent's close are drawn off the glass as the tap will draw them, so that the motion, with room for all of it, paints
// no image, bakes no pet frame and works out no agent's edges from its first frame to its last (its open agent's pet,
// on the clock, may need a pose the warming did not land on: none when the tap comes on the warming's own clock); with
// room for less, every motion's first frames still; the glass shows the same pixels as without it; the model is left as
// it was; a step under the lock paints nothing, and what it needs is made out of it a band at a time, the same pixels
// as made whole; and nothing is painted ahead while the row is not at rest.
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

// n agents at rest on Overview (3 or more), a and d working, nothing kept (or, `kept`, all that was painted and baked
// before): Claude's pets, b's and d's the HD Codex (its pet resampled below 1x), or all of `engine` (a logo where a pet
// would stand: small images); or the agent page of `open` (its mic off), the row at rest by T0 - MAX_ROW_FRAME_MS.
static void page_of(int n, const char *open, const char *engine, bool kept)
{
    if (!kept) {
        max_layer_forget();
        pod_cell_bake_reset();
    }
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
static void rest_of(int n, const char *open, const char *engine) { page_of(n, open, engine, false); }
static void rest(int n, const char *open) { rest_of(n, open, NULL); }

// What the warming makes out of the lock, a band (or a bake) a call, or all it can.
static unsigned s_asked;
static bool one_band(void) { return s_asked++, false; }
static bool all_bands(void) { return s_asked++, true; }
static bool (*s_go_on)(void) = one_band;

// max_ui_warm until it has nothing left, max_ui_warm_paint first while it has something, as max_app.c steps them: a
// step under the lock leaves one image or layer at most to make and the model as it was (but for what the warming is
// of); one out of it makes bands of that, leaves the model as it was and bakes nothing. Its steps under the lock.
static int s_paints;   // and out of it
static int warm(uint32_t now)
{
    static max_model_t before;
    int steps = 0;
    s_paints = 0;
    for (bool more = true; more;) {
        CHECK(steps < STEPS && s_paints < 64 * STEPS);
        memcpy(&before, &max_m, sizeof before);
        const bool band = max_layer_owes();
        const unsigned bakes = pod_cell_bakes();
        if (max_ui_warm_paint(s_go_on)) {
            s_paints++;
            CHECK(!memcmp(&before, &max_m, sizeof before));
            CHECK(band && pod_cell_bakes() == bakes);   // a band copies a frame below 1x, it never bakes it
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

// The motion a tap on `id` at `at` starts, until it rests: its frames' pixels into hash (as many as `frames`), what it
// painted and baked, and the agents' edges it worked out on the glass.
typedef struct { int frames; unsigned painted, baked, edges; uint32_t hash[128]; uint8_t paints[128]; } motion_t;
static motion_t motion_at(const char *id, uint32_t at)
{
    motion_t m = {0};
    const unsigned painted = max_layer_painted(), baked = pod_cell_bakes(), edges = max_layer_edges();
    tap(id, at);
    for (uint32_t now = at;; now += MAX_ROW_FRAME_MS) {
        CHECK(m.frames < 128);
        const unsigned p0 = max_layer_painted() + pod_cell_bakes() + max_layer_edges();
        m.hash[m.frames] = frame(now);
        m.paints[m.frames++] = (uint8_t)(max_layer_painted() + pod_cell_bakes() + max_layer_edges() - p0);
        if (!max_row_moving(now)) break;
    }
    m.painted = max_layer_painted() - painted;
    m.baked = pod_cell_bakes() - baked;
    m.edges = max_layer_edges() - edges;
    return m;
}
static motion_t motion(const char *id) { return motion_at(id, T0); }

// What the ahead motion painted, frame by frame, when it should have painted nothing.
static void painted_where(const char *page, const char *tap, const motion_t *m, int steps)
{
    fprintf(stderr, "  %s, tap %s: %u painted, %u baked, %u edges after %d steps ahead:", page ? page : "overview",
            tap[0] ? tap : "X", m->painted, m->baked, m->edges, steps);
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
        unsigned edges = 0;
        for (int t = 0; t < n; t++) {
            rest_of(cases[c].n, cases[c].page, cases[c].engine);
            cold[t] = motion(taps[t]);
            CHECK(cold[t].painted > 0);   // there is something to paint ahead
            most += cold[t].frames + (int)(cold[t].painted + cold[t].baked + cold[t].edges);
            edges += cold[t].edges;
        }
        CHECK(edges > 0);   // agents between looks whose edges the glass works out
        for (int t = 0; t < n; t++) {
            const char *tap = taps[t];
            rest_of(cases[c].n, cases[c].page, cases[c].engine);
            const int steps = warm(T0);
            CHECK(steps > 10 && steps <= most + 1);   // and the last, which finds nothing left
            const motion_t ahead = motion(tap);
            if (ahead.painted || ahead.baked || ahead.edges) painted_where(cases[c].page, tap, &ahead, steps);
            CHECK(ahead.painted == 0 && ahead.baked == 0 && ahead.edges == 0);
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

// The P4 bench's order (bench_main.c (g)): each tap painted ahead and then tapped a frame off the warming's clock, then
// tapped again from the same page with all that kept. With room for all its motions, ahead the glass bakes no pet frame:
// the warming baked each it met, a band at a time, or made an image of it (a pose it did not land on is painted, its
// frames' bakes found). Again, it bakes nothing. Every frame is the same pixels as cold.
static void test_after_ahead(void)
{
    const struct { int n; const char *page, *engine; bool room; } cases[] = {
        {3, NULL, NULL, true}, {3, "b", NULL, true}, {5, NULL, NULL, false}, {5, "c", "codex", true},
    };
    for (unsigned c = 0; c < sizeof cases / sizeof cases[0]; c++) {
        rest_of(cases[c].n, cases[c].page, cases[c].engine);
        char taps[MAX_ROW_HITS + 1][ID_MAX];
        const int n = taps_of(taps);
        CHECK(n == 3);
        for (int t = 0; t < n; t++) {
            const char *tap = taps[t];
            rest_of(cases[c].n, cases[c].page, cases[c].engine);
            const motion_t cold = motion(tap);
            rest_of(cases[c].n, cases[c].page, cases[c].engine);
            const int steps = warm(T0 - MAX_ROW_FRAME_MS);
            const motion_t ahead = motion(tap);
            if (cases[c].room && ahead.baked) painted_where(cases[c].page, tap, &ahead, steps);
            CHECK(!cases[c].room || ahead.baked == 0);
            page_of(cases[c].n, cases[c].page, cases[c].engine, true);
            const motion_t again = motion(tap);
            CHECK(again.baked == 0);
            CHECK(ahead.frames == cold.frames && again.frames == cold.frames);
            CHECK(!memcmp(ahead.hash, cold.hash, (size_t)cold.frames * sizeof cold.hash[0]));
            CHECK(!memcmp(again.hash, cold.hash, (size_t)cold.frames * sizeof cold.hash[0]));
        }
    }
}

// The glass makes no image of a pet drawn as it is: its frames below 1x are baked as the Pro bakes them, and the bakes
// kept for the frames that draw them again. Overview at rest with nothing painted ahead paints nothing, and its next
// frame bakes nothing.
static void test_glass_flats(void)
{
    const unsigned painted = max_layer_painted();
    rest(3, NULL);
    CHECK(max_layer_painted() == painted && pod_cell_bakes() > 0);
    const unsigned baked = pod_cell_bakes();
    frame(T0);
    CHECK(max_layer_painted() == painted && pod_cell_bakes() == baked);
}

// Not at rest, nothing is painted ahead: a finger on the glass, the row moving, an overlay up, a page not App Detail's.
static void test_not_resting(void)
{
    rest(3, NULL);
    CHECK(max_ui_warm_rests(T0));
    max_m.down = true;
    unsigned painted = max_layer_painted();
    CHECK(!max_ui_warm(T0) && !max_ui_warm_rests(T0));
    max_m.down = false;
    CHECK(max_layer_painted() == painted);

    // A motion while an image is owed: the row no longer rests, so what is owed waits (max_app.c asks first).
    rest(3, NULL);
    for (int i = 0; i < 64 && !max_layer_owes(); i++)
        if (!max_ui_warm_paint(one_band)) max_ui_warm(T0);
    CHECK(max_layer_owes());
    max_open("b");
    render(T0);
    CHECK(max_row_moving(T0 + MAX_ROW_FRAME_MS) && !max_ui_warm(T0 + MAX_ROW_FRAME_MS));
    CHECK(!max_ui_warm_rests(T0 + MAX_ROW_FRAME_MS));
    max_layer_forget();   // what was owed given up

    rest(3, NULL);
    max_notice_set("Cancelled, nothing sent", T0);
    render(T0);
    painted = max_layer_painted();
    CHECK(!max_ui_warm(T0 + MAX_ROW_FRAME_MS));
    CHECK(max_layer_painted() == painted);

    rest(3, NULL);
    max_show(MAX_VIEW_INBOX);
    render(T0);
    painted = max_layer_painted();
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

// A frame below 1x baked a band of rows at a time (the Max's pod_draw.c, pod_cell_bake_some) is the same pixels as one
// a raster bakes whole, and not one of the rasters' bakes: asked (px 0), it makes no entry; a call bakes px of rows; a
// raster that meets it part baked bakes the rest, one bake. With no room left it is -1, and the arena is not started
// over.
static void test_bake_bands(void)
{
    static ht_scene_t one;
    static uint16_t whole[256 * 256], banded[256 * 256];
    ht_scene_clear(&one, 0);
    pod_pet_draw_flat(&one, 0, 0, 120, "codex", POD_SCENE_REST, 0, 0, 7, 16);
    const ht_run_t *r = NULL;
    for (int i = 0; i < one.count && !r; i++)
        if (one.runs[i].text[0] == 1) r = &one.runs[i];
    CHECK(r != NULL && r->w * r->pro_height <= 256 * 256 && r->pro_height > 8);
    const ht_rect_t box = ht_run_bounds(r);
    const size_t bytes = (size_t)box.w * box.h * sizeof whole[0];
    pod_cell_bake_reset();
    ht_raster(&one, box, whole);
    CHECK(pod_cell_bakes() == 1);

    pod_cell_bake_reset();
    CHECK(pod_cell_bake_some(r, 0) == r->pro_height && pod_cell_bake_px() == 0);
    for (int left = r->pro_height; left > 0;) {
        const int next = pod_cell_bake_some(r, 3 * r->w);
        CHECK(next == (left > 3 ? left - 3 : 0));
        left = next;
    }
    CHECK(pod_cell_bake_some(r, 0) == 0 && pod_cell_bakes() == 0);
    memset(banded, 0, sizeof banded);
    ht_raster(&one, box, banded);
    CHECK(pod_cell_bakes() == 0 && !memcmp(whole, banded, bytes));

    pod_cell_bake_reset();
    CHECK(pod_cell_bake_some(r, 5 * r->w) == r->pro_height - 5);
    memset(banded, 0, sizeof banded);
    ht_raster(&one, box, banded);
    CHECK(pod_cell_bakes() == 1 && pod_cell_bake_some(r, 0) == 0 && !memcmp(whole, banded, bytes));

    rest(3, NULL);
    unsigned fill = 0, last = pod_cell_bake_px();
    while (pod_cell_bake_px() >= last) {   // how many fit
        CHECK(fill < 1000);
        last = pod_cell_bake_px();
        bake_one(++fill);
    }
    rest(3, NULL);
    for (unsigned i = 1; i < fill; i++) bake_one(i);   // as full as it gets
    const unsigned full = pod_cell_bake_px();
    ht_scene_clear(&one, 0);
    pod_pet_draw_flat(&one, 0, 0, 120, "codex", POD_SCENE_REST, 0, 0, fill, 16);
    int none = 0;
    for (int i = 0; i < one.count; i++) {
        if (one.runs[i].text[0] != 1 || pod_cell_bake_some(&one.runs[i], 0) != -1) continue;
        CHECK(pod_cell_bake_some(&one.runs[i], 1024) == -1);
        none++;
    }
    CHECK(none > 0 && pod_cell_bake_px() == full);
}

// The bakes with no room for one more start over (pod_draw.c), and other pages' fill them. A warming never starts them
// over (each of the row's pets below 1x it has no room to bake is an image): with the bakes as full as they get, and
// again just started over, the warming bakes nothing whole, nor does the glass's next frame, and a motion painted ahead
// paints and bakes nothing.
static void test_bakes_full(void)
{
    rest(3, NULL);
    unsigned fill = 0, last = pod_cell_bake_px();
    while (pod_cell_bake_px() >= last) {   // how many fit
        CHECK(fill < 1000);
        last = pod_cell_bake_px();
        bake_one(++fill);
    }
    CHECK(fill > 2);
    char taps[MAX_ROW_HITS + 1][ID_MAX];
    for (int over = 0; over < 2; over++) {
        rest(3, NULL);
        for (unsigned i = 1; i < fill; i++) bake_one(i);   // as full as it gets
        const unsigned full = pod_cell_bake_px();
        if (over) {
            bake_one(fill);
            CHECK(pod_cell_bake_px() < full);   // started over
        }
        const unsigned baked = pod_cell_bakes();
        warm(T0);
        frame(T0 - MAX_ROW_FRAME_MS);
        CHECK(pod_cell_bakes() == baked);
        taps_of(taps);
        const motion_t m = motion(taps[0]);
        if (m.painted || m.baked) painted_where(NULL, taps[0], &m, 0);
        CHECK(m.painted == 0 && m.baked == 0);
    }
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

// Out of the lock a call stops where it is told (at a band: as many calls as bands), and an image made a band at a time
// is the same pixels as one made in one go.
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

// Codex's pets below 1x over the slivers' glows and the open agent's ground: each band of what the warming makes copies
// them (a whole bake there would be one long step), and every frame of the open after it is the same pixels as cold.
static void test_band_flats(void)
{
    rest_of(5, "c", "codex");
    const motion_t cold = motion("");
    rest_of(5, "c", "codex");
    s_go_on = one_band;
    warm(T0);   // its bands bake nothing
    const motion_t ahead = motion("");
    CHECK(ahead.frames == cold.frames && !ahead.paints[0] && !ahead.paints[1]);
    CHECK(!memcmp(ahead.hash, cold.hash, (size_t)cold.frames * sizeof cold.hash[0]));
}

int main(void)
{
    test_ahead();
    test_bands();
    test_band_flats();
    test_first_frames();
    test_after_ahead();
    test_glass_flats();
    test_bake_bands();
    test_bakes_full();
    test_not_resting();
    test_again();
    printf("test_max_warm: %d checks passed\n", checks);
    return 0;
}
