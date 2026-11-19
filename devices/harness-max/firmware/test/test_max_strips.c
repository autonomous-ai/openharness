// The ESP32-P4's strips (main/display/max_strips.c) on the host, over a fake PPA (max_turn_ppa.h) and panel copy, on
// the Linux build's FreeRTOS (linux/esp/rtos.c). Every strip pushed must reach the framebuffer as max_turn_pixels turns
// it, whatever the PPA does with its turn: lands it; leaves it waiting until a turn queued after it (a kick, or the
// next push) starts it, as ESP-IDF 5.5's driver can; never lands it (the strip is put in place by the CPU, the PPA
// given up and that logged once, and nothing waits on that turn again); or refuses it. The PPA reads a strip's buffer
// only when its turn lands, as the chip's does, so a buffer written again too soon shows in the framebuffer. Each case
// runs in a process of its own: the strips' state is the program's.
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "max_strips.h"
#include "max_strips_p4.h"
#include "max_turn.h"
#include "max_turn_ppa.h"

static struct { atomic_int checks, failures; } *s_tally;   // shared with the cases' processes
static FILE *s_out;                                         // the test's own output: the log goes elsewhere
#define CHECK(cond)                                                                    \
    do {                                                                               \
        atomic_fetch_add(&s_tally->checks, 1);                                         \
        if (!(cond)) {                                                                 \
            atomic_fetch_add(&s_tally->failures, 1);                                   \
            fprintf(s_out, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);             \
            fflush(s_out);                                                             \
        }                                                                              \
    } while (0)

enum { FB_PX = MAX_GLASS_W * MAX_GLASS_H, ROWS = MAX_STRIP_LINES };

static uint16_t *s_fb, *s_want;

// ── the fake PPA ─────────────────────────────────────────────────────────────────────────────────────────────────

typedef enum { LANDS, WAITS, HANGS, REFUSES } ppa_mode_t;   // what the PPA does with the turns queued from now on

enum { TURNS = 16 };
typedef struct {
    bool used, waiting, hung;
    const uint16_t *src;
    int w, h, x, y;
    SemaphoreHandle_t landed;
} turn_t;
static pthread_mutex_t s_mu = PTHREAD_MUTEX_INITIALIZER;   // what follows
static ppa_mode_t s_mode;
static turn_t s_turns[TURNS];
static int s_kicks, s_queued_ever;
static atomic_int s_queued;
static atomic_bool s_stop;

// The turn's pixels into the portrait framebuffer, read from its buffer now.
static void turn_into_fb(const uint16_t *src, int w, int h, int x, int y)
{
    static uint16_t band[MAX_STRIP_PX];
    max_turn_pixels(src, w, h, band);
    for (int row = 0; row < w; row++)   // the panel rectangle is h wide and w tall
        memcpy(&s_fb[(size_t)(y + row) * MAX_GLASS_H + x], &band[(size_t)row * h], (size_t)h * sizeof band[0]);
}

esp_err_t max_turn_ppa_open(void) { return ESP_OK; }

esp_err_t max_turn_ppa_into(int lane, const uint16_t *src, int w, int h, uint16_t *pic, int pic_w, int pic_h,
                            size_t pic_bytes, int x, int y, SemaphoreHandle_t landed)
{
    (void)lane;
    CHECK(pic == s_fb && pic_w == MAX_GLASS_H && pic_h == MAX_GLASS_W && pic_bytes == FB_PX * sizeof *pic);
    pthread_mutex_lock(&s_mu);
    if (s_mode == REFUSES) {
        pthread_mutex_unlock(&s_mu);
        return ESP_FAIL;
    }
    for (int i = 0; i < TURNS; i++)   // a turn queued starts, once it lands, every turn waiting before it
        s_turns[i].waiting = false;
    int i = 0;
    while (i < TURNS && s_turns[i].used) i++;
    CHECK(i < TURNS && landed);   // the strips queue every turn they make
    if (i == TURNS || !landed) {
        pthread_mutex_unlock(&s_mu);
        return ESP_FAIL;
    }
    s_turns[i] = (turn_t){true, s_mode == WAITS, s_mode == HANGS, src, w, h, x, y, landed};
    s_queued_ever++;
    atomic_fetch_add(&s_queued, 1);
    pthread_mutex_unlock(&s_mu);
    return ESP_OK;
}

int max_turn_ppa_queued(void) { return atomic_load(&s_queued); }

esp_err_t max_turn_ppa_kick(void)
{
    pthread_mutex_lock(&s_mu);
    s_kicks++;
    for (int i = 0; i < TURNS; i++) s_turns[i].waiting = false;
    pthread_mutex_unlock(&s_mu);
    return ESP_OK;
}

// The PPA at work: every turn that can land lands, about 50 us after it is queued.
static void *lander(void *arg)
{
    (void)arg;
    while (!atomic_load(&s_stop)) {
        nanosleep(&(struct timespec){0, 50000}, NULL);
        pthread_mutex_lock(&s_mu);
        for (int i = 0; i < TURNS; i++) {
            turn_t *t = &s_turns[i];
            if (!t->used || t->waiting || t->hung) continue;
            turn_into_fb(t->src, t->w, t->h, t->x, t->y);
            t->used = false;
            atomic_fetch_sub(&s_queued, 1);
            xSemaphoreGive(t->landed);
        }
        pthread_mutex_unlock(&s_mu);
    }
    return NULL;
}

static void ppa_mode(ppa_mode_t mode)
{
    pthread_mutex_lock(&s_mu);
    s_mode = mode;
    pthread_mutex_unlock(&s_mu);
}
static int kicks(void)
{
    pthread_mutex_lock(&s_mu);
    const int n = s_kicks;
    pthread_mutex_unlock(&s_mu);
    return n;
}
static int queued_ever(void)
{
    pthread_mutex_lock(&s_mu);
    const int n = s_queued_ever;
    pthread_mutex_unlock(&s_mu);
    return n;
}

// ── the panel's copy, and the strips ────────────────────────────────────────────────────────────────────────────

static atomic_int s_copies;

static void copy(int x, int y, int w, int h, const uint16_t *band)
{
    for (int row = 0; row < h; row++)
        memcpy(&s_fb[(size_t)(y + row) * MAX_GLASS_H + x], &band[(size_t)row * w], (size_t)w * sizeof band[0]);
    atomic_fetch_add(&s_copies, 1);
}

// Strip `row` (ROWS rows across the glass) drawn into the worker's buffer, pixels of its own push, and pushed; the
// framebuffer it must leave noted.
static void push(int worker, int slot, int row)
{
    static atomic_int pushes;
    const int n = atomic_fetch_add(&pushes, 1);
    uint16_t *px = max_strip_buffer(worker, slot);
    for (int i = 0; i < MAX_STRIP_PX; i++) px[i] = (uint16_t)(i * 7 + n * 1031 + row * 37 + 1);
    const max_rect_t at = {0, row * ROWS, MAX_GLASS_W, ROWS};
    static uint16_t band[MAX_STRIP_PX];
    max_turn_pixels(px, at.w, at.h, band);
    const max_rect_t p = max_turn_rect(at);
    for (int r = 0; r < p.h; r++)
        memcpy(&s_want[(size_t)(p.y + r) * MAX_GLASS_H + p.x], &band[(size_t)r * p.w], (size_t)p.w * sizeof band[0]);
    max_strip_push(worker, slot, at.x, at.y, at.w, at.h);
}
// The buffer's strip has landed: the worker writes it again (as max_present.c does once it has waited).
static void reuse(int worker, int slot)
{
    uint16_t *px = max_strip_buffer(worker, slot);
    for (int i = 0; i < MAX_STRIP_PX; i++) px[i] = 0xDEAD;
}

static bool fb_is_want(void) { return !memcmp(s_fb, s_want, FB_PX * sizeof *s_fb); }

static double now_ms(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

// The log's lines with `what` in them.
static FILE *s_log;
static int logged(const char *what)
{
    fflush(stderr);
    rewind(s_log);
    char line[512];
    int n = 0;
    while (fgets(line, sizeof line, s_log))
        if (strstr(line, what)) n++;
    fseek(s_log, 0, SEEK_END);
    return n;
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────────────────────────

static void lands(void)
{
    push(0, 0, 0);
    push(0, 1, 1);
    max_strip_wait(0, 0);
    reuse(0, 0);
    max_strip_wait(0, 1);
    reuse(0, 1);
    CHECK(fb_is_want());
    CHECK(kicks() == 0 && atomic_load(&s_copies) == 0 && max_strips_ppa());
}

// The frame's last push left waiting: nothing is queued after it, so the wait kicks the PPA, and it lands.
static void waits_for_a_kick(void)
{
    ppa_mode(WAITS);
    push(0, 0, 3);
    ppa_mode(LANDS);
    const double t0 = now_ms();
    max_strip_wait(0, 0);
    reuse(0, 0);
    CHECK(now_ms() - t0 < 200);   // well inside the time it would be given up in
    CHECK(fb_is_want());
    CHECK(kicks() == 1 && atomic_load(&s_copies) == 0 && max_strips_ppa());
    max_strip_wait(0, 0);   // landed: no second wait, no second kick
    CHECK(kicks() == 1);
}

// A push left waiting mid-frame: the next push starts it, no kick needed.
static void waits_for_the_next(void)
{
    ppa_mode(WAITS);
    push(0, 0, 4);
    ppa_mode(LANDS);
    push(0, 1, 5);
    max_strip_wait(0, 1);
    max_strip_wait(0, 0);
    CHECK(fb_is_want());
    CHECK(kicks() == 0 && max_strips_ppa());
}

// Turns that never land, the kick or not: the PPA given up from then on (logged once) with both the worker has in
// flight, each strip put in place by the CPU in the order pushed (the second over the first, its slot's other way
// round), and the next push the CPU's at once, although the lost turns are still queued.
static void hangs(void)
{
    ppa_mode(HANGS);
    push(0, 1, 6);
    push(0, 0, 6);   // the same strip, drawn again
    const double t0 = now_ms();
    max_strip_wait(0, 0);
    const double waited = now_ms() - t0;
    CHECK(waited >= 250 && waited < 1000);
    CHECK(!max_strips_ppa() && kicks() >= 1 && atomic_load(&s_copies) == 2);
    reuse(0, 0);
    max_strip_wait(0, 1);   // given up with the other
    reuse(0, 1);
    CHECK(atomic_load(&s_copies) == 2);
    CHECK(fb_is_want());
    const int queued = queued_ever();
    const double t1 = now_ms();
    push(0, 0, 8);
    max_strip_wait(0, 0);
    CHECK(now_ms() - t1 < 100);
    CHECK(queued_ever() == queued && atomic_load(&s_copies) == 3 && max_turn_ppa_queued() == 2);
    CHECK(fb_is_want());
    CHECK(logged("did not land") == 1);
}

// A refused turn: the CPU from then on, logged once.
static void refuses(void)
{
    ppa_mode(REFUSES);
    push(0, 0, 9);
    CHECK(!max_strips_ppa() && atomic_load(&s_copies) == 1);
    push(0, 1, 10);
    max_strip_wait(0, 0);
    max_strip_wait(0, 1);
    CHECK(atomic_load(&s_copies) == 2 && fb_is_want());
    CHECK(logged("failed") == 1 && logged("did not land") == 0);
}

// The helper's turn never lands while the render task's push goes to the CPU (the PPA off): the render task's copy
// waits for the helper's turn without holding the framebuffer from the helper, and both strips are in place once the
// helper gives its turn up.
static void *helper(void *arg)
{
    (void)arg;
    push(1, 0, 11);
    max_strip_wait(1, 0);
    return NULL;
}
static void helper_hangs(void)
{
    ppa_mode(HANGS);
    pthread_t t;
    pthread_create(&t, NULL, helper, NULL);
    while (!max_turn_ppa_queued()) nanosleep(&(struct timespec){0, 100000}, NULL);
    max_strips_use_ppa(false);   // as after a refusal of the render task's
    const double t0 = now_ms();
    push(0, 0, 12);
    CHECK(now_ms() - t0 < 1000);
    pthread_join(t, NULL);
    CHECK(atomic_load(&s_copies) == 2 && fb_is_want());
    CHECK(logged("did not land") == 1);
}

static void run(const char *name, void (*body)(void))
{
    fflush(NULL);
    const pid_t pid = fork();
    if (pid == 0) {
        s_fb = calloc(FB_PX, sizeof *s_fb);
        s_want = calloc(FB_PX, sizeof *s_want);
        s_log = tmpfile();
        CHECK(s_fb && s_want && s_log);
        dup2(fileno(s_log), STDERR_FILENO);   // the strips' log lines, counted by logged()
        CHECK(max_strips_init(copy) == ESP_OK && max_strips_ppa());
        max_strips_framebuffer(s_fb);
        pthread_t t;
        pthread_create(&t, NULL, lander, NULL);
        body();
        atomic_store(&s_stop, true);
        pthread_join(t, NULL);
        exit(0);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);   // no abort
    fprintf(s_out, "  %s\n", name);
    fflush(s_out);
}

int main(void)
{
    s_out = fdopen(dup(STDERR_FILENO), "w");
    s_tally = mmap(NULL, sizeof *s_tally, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANON, -1, 0);
    if (!s_out || s_tally == MAP_FAILED) return 1;
    run("lands", lands);
    run("waits for a kick", waits_for_a_kick);
    run("waits for the next push", waits_for_the_next);
    run("hangs", hangs);
    run("refuses", refuses);
    run("the helper's hangs", helper_hangs);
    printf("test_max_strips: %d checks, %d failures\n", atomic_load(&s_tally->checks), atomic_load(&s_tally->failures));
    return atomic_load(&s_tally->failures) != 0;
}
