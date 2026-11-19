// max_present (main/display/max_present.c) on the host, its two tasks on pthreads (the Linux build's FreeRTOS,
// linux/esp/rtos.c), over a fake panel whose pushes land late: a buffer's pixels reach the glass only when its worker
// waits for it, so a buffer written again too soon, or a frame that returns before its strips land, shows on the glass.
// Every screen of max_render.c, whole and changed into the next, must leave the glass exactly as one ht_raster of the
// scene; the strips across a cell run that pod_draw.c resamples (its statics) must be the render task's. So must a change
// in the last row alone. The UI's blurs are the frame's, as the app has them (max_ui_share): both tasks do them before
// the strips, and the glass is the one they give when done in the build. run.sh builds this with ThreadSanitizer too.
#define MAX_RENDER_SCREENS_ONLY
#include "max_render.c"

#include <pthread.h>
#include <stdlib.h>
#include <time.h>

#include "max_present.h"
#include "max_strips.h"
#include "max_ui_draw.h"   // max_layer_forget
#include "pod/pod_draw.h"

static int checks, failures;
#define CHECK(cond)                                                                \
    do {                                                                           \
        checks++;                                                                  \
        if (!(cond)) {                                                             \
            failures++;                                                            \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);        \
        }                                                                          \
    } while (0)

// ── the fake panel ───────────────────────────────────────────────────────────────────────────────────────────────

static uint16_t glass[HT_WIDTH * HT_HEIGHT], want[HT_WIDTH * HT_HEIGHT];
static uint16_t buffers[MAX_WORKERS][MAX_STRIP_SLOTS][MAX_STRIP_PX];
static struct { bool pending; ht_rect_t at; } s_slot[MAX_WORKERS][MAX_STRIP_SLOTS];   // each worker's own
static pthread_mutex_t s_mu = PTHREAD_MUTEX_INITIALIZER;   // the glass and the log below
enum { LOG_MAX = 4096 };
static struct { int worker; ht_rect_t at; } s_log[LOG_MAX];   // this frame's pushes
static int s_logged;

uint16_t *max_strip_buffer(int worker, int slot) { return buffers[worker][slot]; }

void max_strip_push(int worker, int slot, int x, int y, int w, int h)
{
    if (s_slot[worker][slot].pending) {   // pushed again before its wait: the platform's buffer was overwritten
        fprintf(stderr, "FAIL: worker %d pushed slot %d again before waiting for it\n", worker, slot);
        failures++;
    }
    s_slot[worker][slot].pending = true;
    s_slot[worker][slot].at = (ht_rect_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h};
    pthread_mutex_lock(&s_mu);
    if (s_logged < LOG_MAX) {
        s_log[s_logged].worker = worker;
        s_log[s_logged++].at = s_slot[worker][slot].at;
    }
    pthread_mutex_unlock(&s_mu);
    if (worker == 0) nanosleep(&(struct timespec){0, 20000}, NULL);   // room for the helper to take strips
}

void max_strip_wait(int worker, int slot)
{
    if (!s_slot[worker][slot].pending) return;
    const ht_rect_t r = s_slot[worker][slot].at;
    pthread_mutex_lock(&s_mu);
    for (int row = 0; row < r.h; row++)
        memcpy(&glass[(r.y + row) * HT_WIDTH + r.x], &buffers[worker][slot][row * r.w], (size_t)r.w * sizeof glass[0]);
    pthread_mutex_unlock(&s_mu);
    s_slot[worker][slot].pending = false;
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────────────────────────

static int helper_pushes, serial_runs;

static bool overlap(ht_rect_t a, ht_rect_t b)
{
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
// The glass is `next`, everything pushed has landed, and no strip across a resampled cell run was the helper's.
static void check_frame(const char *what, const ht_scene_t *next)
{
    ht_raster(next, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, want);
    const bool same = !memcmp(glass, want, sizeof glass);
    if (!same) fprintf(stderr, "  %s: the glass is not the scene\n", what);
    CHECK(same);
    for (int w = 0; w < MAX_WORKERS; w++)
        for (int s = 0; s < MAX_STRIP_SLOTS; s++) CHECK(!s_slot[w][s].pending);
    for (int i = 0; i < next->count; i++) {
        const ht_run_t *r = &next->runs[i];
        if (r->pro_kind != POD_CELL || r->text[0] == 1) continue;
        for (int p = 0; p < s_logged; p++)
            if (overlap(s_log[p].at, ht_run_bounds(r))) {
                serial_runs++;
                if (s_log[p].worker != 0) fprintf(stderr, "  %s: the helper painted across a resampled cell\n", what);
                CHECK(s_log[p].worker == 0);
            }
    }
    for (int p = 0; p < s_logged; p++) helper_pushes += s_log[p].worker == 1;
    s_logged = 0;
}

static ht_scene_t a, b;

static void present(const ht_scene_t *prev, const ht_scene_t *next, const char *what)
{
    uint32_t pushed = 0;
    max_present(prev, next, &pushed);
    CHECK(prev || pushed == (uint32_t)HT_WIDTH * HT_HEIGHT);
    check_frame(what, next);
}

// Every screen whole, then changed into the next one: the damage between two screens, in rectangles of every shape.
static void every_screen(int cores)
{
    max_present_cores(cores);
    for (int i = 0; i < SCREEN_COUNT; i++) {
        draw(&SCREENS[i]);
        a = S;
        present(NULL, &a, SCREENS[i].name);
        draw(&SCREENS[(i + 1) % SCREEN_COUNT]);
        b = S;
        present(&a, &b, SCREENS[(i + 1) % SCREEN_COUNT].name);
        // A cold frame: no pet cell baked, so the frame bakes them before the helper starts.
        pod_cell_bake_reset();
        present(NULL, &b, "cold");
    }
}

// A change in the glass's last row alone, on the left, in the middle and across: on the bar's 415-row glass that row is
// in no pair of ht_damage's outline, and the change must still land.
static void last_row(void)
{
    static const int SPANS[][2] = {{0, 40}, {700, 31}, {0, HT_WIDTH}};
    for (int i = 0; i < 3; i++) {
        draw(&SCREENS[0]);
        a = S;
        present(NULL, &a, "last row, before");
        b = a;
        CHECK(ht_pro_rect(&b, SPANS[i][0], HT_HEIGHT - 1, SPANS[i][1], 1, 0, 0xF800));
        uint32_t pushed = 0;
        max_present(&a, &b, &pushed);
        CHECK(pushed > 0);
        check_frame("last row", &b);
        // And a layout change (a run moved: ht_damage's outline) that also touches the last row.
        a = b;
        b.runs[b.count - 1].x += 2;
        max_present(&a, &b, NULL);
        check_frame("last row, moved", &b);
    }
    // With the damage's rectangles all taken: small changes on thirty rows, far apart, and the last row's.
    draw(&SCREENS[0]);
    a = S;
    present(NULL, &a, "full damage, before");
    b = a;
    for (int i = 0; i < 30; i++) CHECK(ht_pro_rect(&b, (i % 2) * 1600 + 10, i * 12 + 4, 4, 2, 0, 0x07E0));
    CHECK(ht_pro_rect(&b, 900, HT_HEIGHT - 1, 6, 1, 0, 0xF800));
    ht_damage_t d;
    ht_damage(&a, &b, &d);
    CHECK(d.count == HT_DAMAGE_MAX);   // the case: no rectangle to spare
    max_present(&a, &b, NULL);
    check_frame("full damage and the last row", &b);
}

// Another frame's work over the stack the next scene is built on (the P4's render task runs the frame, the blurs and
// the paint-ahead between two scenes): what a run's bytes are must not be what that work left there.
static __attribute__((noinline)) void scribble_stack(uint8_t v)
{
    volatile uint8_t junk[3072];   // within the render task's 4 KB frames
    for (size_t i = 0; i < sizeof junk; i++) junk[i] = (uint8_t)(v + i);
}

// A run added or dropped mid-scene (a line of words wrapping onto two): the damage is what it draws, not every run after
// it, and the glass is the scene's. The listening band's partial frame does that: the new level ends the quiet, and the
// send prompt's two rows become one, before the X, the slivers and the row's faded ends. Built over another stack than
// the frame before's, it repaints the band alone: ht_damage compares runs byte for byte, and a glow whose parameters
// carried a padding byte off the stack (the P4's compiler copies it in) repainted the page's every glow, 337,600 px.
static void runs_added(void)
{
    draw(&SCREENS[0]);
    a = S;
    present(NULL, &a, "a run added, before");
    b = a;
    const int at = b.count / 2;
    memmove(&b.runs[at + 1], &b.runs[at], (size_t)(b.count - at) * sizeof b.runs[0]);
    b.count++;
    static ht_scene_t one;
    ht_scene_clear(&one, b.background);
    CHECK(ht_pro_rect(&one, 300, 100, 20, 10, 0, 0xF800));
    b.runs[at] = one.runs[0];
    ht_damage_t d;
    ht_damage(&a, &b, &d);
    CHECK(d.pixels == 20 * 10);
    max_present(&a, &b, NULL);
    check_frame("a run added", &b);
    ht_damage(&b, &a, &d);
    CHECK(d.pixels == 20 * 10);
    max_present(&b, &a, NULL);
    check_frame("a run dropped", &a);

    for (int i = 0; i < SCREEN_COUNT; i++)
        if (!strcmp(SCREENS[i].name, "agent-listening")) draw(&SCREENS[i]);
    a = S;
    present(NULL, &a, "listening, before");
    max_ui_level(4, T0 + MAX_TALK_FRAME_MS);
    scribble_stack(0x5A);
    frame(T0 + MAX_TALK_FRAME_MS);
    b = S;
    CHECK(b.count == a.count - 1);   // the case
    ht_damage(&a, &b, &d);
    int tail = 0;   // what follows the band, the same in both: the X, the slivers, the row's faded ends
    while (tail < b.count && !memcmp(&a.runs[a.count - 1 - tail], &b.runs[b.count - 1 - tail], sizeof b.runs[0])) tail++;
    CHECK(tail >= 10);
    for (int k = 0; k < tail; k++)
        for (int n = 0; n < d.count; n++) CHECK(!overlap(ht_run_bounds(&b.runs[b.count - 1 - k]), d.rect[n]));
    CHECK(d.pixels <= 70000);   // the band and the prompt: 64,556 px at 480 rows
    present(&a, &b, "listening, the next level");
}

// App Detail's row as it closes, its blurs left to the frame (max_ui_share): both tasks do them before any strip, and
// the glass is the one those blurs done in the build give. A scene built and never shown (its blurs never done) leaves
// no pet's image unmade for the next frame to take up: that frame paints them again.
static void shared_blurs(void)
{
    static uint16_t built[HT_WIDTH * HT_HEIGHT];
    for (int shared = 0; shared <= 1; shared++) {
        max_layer_forget();
        max_ui_share(shared);
        orca();
        show(MAX_VIEW_AGENT, "rate");
        frame(T0 - 2000);
        max_show(MAX_VIEW_OVERVIEW);
        frame(T0 - 300);   // the close starts
        frame(T0 - 200);   // never shown
        frame(T0 - 200);
        a = S;
        present(NULL, &a, shared ? "row closing, its blurs shared" : "row closing");
        if (!shared) memcpy(built, glass, sizeof glass);
        else CHECK(!memcmp(glass, built, sizeof glass));
    }
}

int main(void)
{
    max_present_work(max_ui_work);
    shared_blurs();
    max_ui_share(true);   // as the app has it
    last_row();
    runs_added();
    every_screen(2);
    CHECK(helper_pushes > 0);   // the helper did paint
    CHECK(serial_runs > 0);     // and the render task kept the resampled cells (Overview's logos)
    const int shared = helper_pushes;
    every_screen(1);
    CHECK(helper_pushes == shared);   // one core: the helper paints nothing
    max_present_cores(2);
    if (failures) {
        fprintf(stderr, "test_max_present: %d of %d checks failed\n", failures, checks);
        return 1;
    }
    printf("test_max_present: %d checks passed (%d strips by the helper)\n", checks, shared);
    return 0;
}
