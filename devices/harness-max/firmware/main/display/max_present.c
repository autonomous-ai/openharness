// Harness Max's frame path (max_present.h): ht_damage between the two scenes, each damage rectangle cut into strips as
// pro_frame.c cuts them (MAX_STRIP_LINES rows; a rectangle of at most SMALL_PX pixels in one), and the strips shared
// between two tasks. The render task and a helper on the other core each take the next strip nobody has, rasterise it
// into one of their own buffers and push it (max_strips.h), then rasterise the next into their other buffer while the
// first lands. Whichever task paints a strip, its pixels are ht_raster's.
//
// The helper is waited for only once it has started on the frame: the render task takes every strip the helper does
// not, and at the end shuts the frame to a helper that has not joined it. A busy core 0 makes a frame one core's, never
// a late one.
//
// ht_damage outlines a layout change in pairs of rows. On a glass of odd height (the bar's 415 rows) the last row is in
// no pair, and a change there is dropped from the outline; so the frame adds the last row's changes back itself.
//
// The scene can leave work to the frame (max_present_work: the UI's blurs, its costliest pixels): both tasks share it as
// they share the strips, before either paints one, since the strips read it.
//
// pod_draw.c keeps state between rasters that only one task may touch: a pet frame drawn by the resampler (a cell run
// not baked flat) works in its statics, and the first raster of a flat cell bakes it into a shared table. So the flat
// cells a frame paints are baked before the helper starts, and a strip across an unbaked cell run is the render task's.
#include "max_present.h"

#include <stdatomic.h>
#include <stdbool.h>
#include <string.h>

#include "max_strips.h"
#include "pod/pod_draw.h"
#include "pro_canvas.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "max_present";

// Below the cable reader (5), the touch task (7) and the voice tasks (4 and 6): the helper only takes spare time.
#define HELPER_PRIORITY 3
#define HELPER_CORE 0       // the render task's is 1
#define HELPER_STACK 8192   // ht_raster's frames are small; the PPA's queueing and a log line take the rest
#define SMALL_PX 2048       // pro_frame.c's: a rectangle this small is one push, however tall
// pod_draw.c bakes a flat cell run of up to its arena's 360 K pixels and resamples a larger one in place, as it does a
// run that is not flat. A quarter of the glass is less than that on every glass Max has.
#define BAKED_PX_MAX (HT_WIDTH * HT_HEIGHT / 4)
#define SERIAL_MAX 8   // unbaked cell runs a frame keeps to the render task; with more, it paints the frame alone

enum { GATE_SHUT, GATE_OPEN, GATE_JOINED };

// The frame being painted: the render task's to write while the gate is shut, both tasks' to read while it is open.
static struct {
    const ht_scene_t *scene;
    ht_damage_t damage;
    int first[HT_DAMAGE_MAX + 1];   // each rectangle's first strip; first[damage.count] is the strip count
    ht_rect_t serial[SERIAL_MAX];   // the unbaked cell runs' bounds: a strip across one is the render task's
    int serial_count;
} s_frame;
static atomic_int s_next;   // the next strip nobody has taken
static atomic_int s_gate;
static uint32_t s_helper_us;   // the helper's raster time this frame, read once it has given s_helper_done
static SemaphoreHandle_t s_helper_done;
static TaskHandle_t s_helper;
static bool s_started;
static int s_cores = 2;
static void (*s_work)(int worker);

typedef struct {
    int worker, slot;
    uint32_t raster_us;
} lane_t;

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
static int step_of(ht_rect_t r) { return r.w * r.h <= SMALL_PX ? r.h : MAX_STRIP_LINES; }
static bool overlap(ht_rect_t a, ht_rect_t b)
{
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

static ht_rect_t strip_at(int i)
{
    int n = 0;
    while (s_frame.first[n + 1] <= i) n++;
    const ht_rect_t r = s_frame.damage.rect[n];
    const int step = step_of(r), y = r.y + (i - s_frame.first[n]) * step;
    return (ht_rect_t){r.x, (int16_t)y, r.w, (int16_t)imin(step, r.y + r.h - y)};
}
static bool serial(ht_rect_t strip)
{
    for (int i = 0; i < s_frame.serial_count; i++)
        if (overlap(strip, s_frame.serial[i])) return true;
    return false;
}

static void paint(lane_t *l, ht_rect_t strip)
{
    max_strip_wait(l->worker, l->slot);
    uint16_t *px = max_strip_buffer(l->worker, l->slot);
    const int64_t t = esp_timer_get_time();
    ht_raster(s_frame.scene, strip, px);
    l->raster_us += (uint32_t)(esp_timer_get_time() - t);
    max_strip_push(l->worker, l->slot, strip.x, strip.y, strip.w, strip.h);
    l->slot = (l->slot + 1) % MAX_STRIP_SLOTS;
}
// Strips until none is left, but the render task's own (serial), which it paints apart.
static void take_strips(lane_t *l)
{
    for (int i; (i = atomic_fetch_add(&s_next, 1)) < s_frame.first[s_frame.damage.count];) {
        const ht_rect_t strip = strip_at(i);
        if (!serial(strip)) paint(l, strip);
    }
}
static void land(const lane_t *l)
{
    for (int slot = 0; slot < MAX_STRIP_SLOTS; slot++) max_strip_wait(l->worker, slot);
}

static void helper_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        int open = GATE_OPEN;
        if (!atomic_compare_exchange_strong(&s_gate, &open, GATE_JOINED)) continue;   // a frame done without it
        lane_t l = {1, 0, 0};
        if (s_work) s_work(1);
        take_strips(&l);
        land(&l);
        s_helper_us = l.raster_us;
        xSemaphoreGive(s_helper_done);
    }
}

static void start(void)
{
    s_started = true;
    s_helper_done = xSemaphoreCreateBinary();
    if (!s_helper_done || xTaskCreatePinnedToCore(helper_task, "max_raster", HELPER_STACK, NULL, HELPER_PRIORITY,
                                                  &s_helper, HELPER_CORE) != pdPASS) {
        s_helper = NULL;
        ESP_LOGW(TAG, "no helper task: the render task paints every strip");
    }
}

// The last row's changes, into `d` where it does not cover them yet: one span from the leftmost change to the rightmost,
// on even edges as ht_damage's. Only on a glass of odd height, between two scenes on one background (otherwise the
// damage is the whole glass).
static void last_row(const ht_scene_t *prev, const ht_scene_t *next, ht_damage_t *d)
{
    if (!(HT_HEIGHT & 1) || !prev || prev->background != next->background) return;
    const int y = HT_HEIGHT - 1;
    int x0 = HT_WIDTH, x1 = 0;
    for (int i = 0; i < imax(prev->count, next->count); i++) {
        const ht_run_t *was = i < prev->count ? &prev->runs[i] : NULL, *is = i < next->count ? &next->runs[i] : NULL;
        if (was && is && !memcmp(was, is, sizeof *was)) continue;
        for (int k = 0; k < 2; k++) {
            const ht_run_t *r = k ? is : was;
            if (!r) continue;
            const ht_rect_t b = ht_run_bounds(r);
            if (b.y > y || b.y + b.h <= y) continue;
            x0 = imin(x0, imax(0, b.x));
            x1 = imax(x1, imin(HT_WIDTH, b.x + b.w));
        }
    }
    x0 &= ~1;
    x1 = imin(HT_WIDTH, (x1 + 1) & ~1);
    if (x0 >= x1) return;
    for (int n = 0; n < d->count; n++) {
        const ht_rect_t r = d->rect[n];
        if (r.y <= y && y < r.y + r.h && r.x <= x0 && x1 <= r.x + r.w) return;
    }
    const ht_rect_t span = {(int16_t)x0, (int16_t)y, (int16_t)(x1 - x0), 1};
    if (d->count < HT_DAMAGE_MAX) {
        d->rect[d->count++] = span;
        d->pixels += (uint32_t)span.w;
        return;
    }
    ht_rect_t *last = &d->rect[d->count - 1];   // no room: the last rectangle grows to take the span in
    d->pixels -= (uint32_t)last->w * last->h;
    const int lx = imin(last->x, x0), ly = imin(last->y, y);
    *last = (ht_rect_t){(int16_t)lx, (int16_t)ly, (int16_t)(imax(last->x + last->w, x1) - lx), (int16_t)(HT_HEIGHT - ly)};
    d->pixels += (uint32_t)last->w * last->h;
}

static bool damaged(const ht_run_t *r)
{
    const ht_rect_t b = ht_run_bounds(r);
    for (int n = 0; n < s_frame.damage.count; n++)
        if (overlap(b, s_frame.damage.rect[n])) return true;
    return false;
}
// Readies the frame for two tasks: its unbaked cell runs kept to the render task, its flat ones baked. False when that
// cannot be (more than SERIAL_MAX unbaked runs, or flat cells that do not fit the bake table together): the render task
// paints the frame alone.
static bool share_out(void)
{
    const ht_scene_t *s = s_frame.scene;
    for (int pass = 0; pass < 3; pass++) {
        const unsigned baked = pod_cell_bakes();
        for (int i = 0; i < s->count; i++) {
            const ht_run_t *r = &s->runs[i];
            if (r->pro_kind != POD_CELL || !damaged(r)) continue;
            if (r->text[0] == 1 && (int32_t)r->w * r->pro_height <= BAKED_PX_MAX) {
                uint16_t px;
                ht_pro_raster(r, (ht_rect_t){r->x, r->y, 1, 1}, &px);   // a flat cell's raster bakes it, if it is not
            } else if (pass == 0) {
                if (s_frame.serial_count == SERIAL_MAX) return false;
                s_frame.serial[s_frame.serial_count++] = ht_run_bounds(r);
            }
        }
        if (pod_cell_bakes() == baked) return true;   // a pass that baked nothing: every flat cell is in the table
    }
    return false;
}

uint32_t max_present(const ht_scene_t *prev, const ht_scene_t *next, uint32_t *pushed_px)
{
    if (!s_started) start();
    s_frame.scene = next;
    ht_damage(prev, next, &s_frame.damage);
    last_row(prev, next, &s_frame.damage);
    s_frame.first[0] = 0;
    for (int n = 0; n < s_frame.damage.count; n++) {
        const ht_rect_t r = s_frame.damage.rect[n];
        s_frame.first[n + 1] = s_frame.first[n] + (r.h + step_of(r) - 1) / step_of(r);
    }
    const int strips = s_frame.first[s_frame.damage.count];
    s_frame.serial_count = 0;
    const bool shared = s_helper && s_cores > 1 && strips > 1 && share_out();
    if (!shared) s_frame.serial_count = 0;   // one task paints every strip: none needs keeping apart
    atomic_store(&s_next, 0);
    lane_t me = {0, 0, 0};
    if (shared) {
        atomic_store(&s_gate, GATE_OPEN);
        xTaskNotifyGive(s_helper);
    }
    if (s_work) s_work(0);
    if (shared) {
        for (int i = 0; i < strips; i++) {
            const ht_rect_t strip = strip_at(i);
            if (serial(strip)) paint(&me, strip);
        }
    }
    take_strips(&me);
    land(&me);
    uint32_t raster_us = me.raster_us;
    int open = GATE_OPEN;
    if (shared && !atomic_compare_exchange_strong(&s_gate, &open, GATE_SHUT)) {   // it joined: its last strips land
        xSemaphoreTake(s_helper_done, portMAX_DELAY);
        raster_us += s_helper_us;
    }
    if (pushed_px) *pushed_px = s_frame.damage.pixels;
    return raster_us;
}

void max_present_cores(int cores) { s_cores = cores; }
void max_present_work(void (*work)(int worker)) { s_work = work; }
