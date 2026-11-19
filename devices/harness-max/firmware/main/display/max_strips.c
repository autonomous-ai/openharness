// The ESP32-P4's side of max_strips.h. A worker's buffers are internal RAM; a push queues the PPA to turn the strip
// straight into its place in the panel's framebuffer (on the worker's own PPA client) and returns, so the worker
// rasterises its next strip while the PPA turns this one, and no copy of the turned band follows. Where the PPA cannot
// (none, or a turn it refused, from then on), the CPU turns the strip into the worker's other buffer and the panel's
// copy puts it in place before the push returns.
//
// The framebuffer has two kinds of writer, and a cache line of it holds pixels of neighbouring strips. Queueing a PPA
// turn drops the cache's lines of the rows it writes; a CPU copy writes through the cache and writes those lines back
// whole. So the two never overlap: they take turns at s_fb_lock, and a copy waits for every queued turn to land. Both
// kinds meet only after the PPA's first refusal, when the turns queued before it are still landing.
#include "max_strips.h"
#include "max_strips_p4.h"

#include <assert.h>
#include <stdatomic.h>
#include <stdlib.h>

#include "max_turn.h"
#include "max_turn_ppa.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "max_strips";

#define LANDED_MS 250   // a turn that has not landed by then never will (the panel's own copy waits as long)
#define CACHE_LINE 64
#define FB_BYTES ((size_t)MAX_GLASS_W * MAX_GLASS_H * sizeof(uint16_t))
#define WORKER_BYTES ((size_t)MAX_STRIP_SLOTS * MAX_STRIP_PX * sizeof(uint16_t))

_Static_assert(MAX_STRIP_SLOTS * MAX_STRIP_PX == PRO_STRIP_PX, "a worker's buffers are one of pro_frame.c's strips");
_Static_assert(MAX_WORKERS <= MAX_TURN_PPA_LANES, "a PPA client a worker");

static uint16_t *s_buf[MAX_WORKERS];   // a worker's slots, one block
static uint16_t *s_fb;
static max_strips_copy_t s_copy;
static SemaphoreHandle_t s_fb_lock;   // the framebuffer's writers: a PPA turn's queueing, a CPU copy
static SemaphoreHandle_t s_landed[MAX_WORKERS][MAX_STRIP_SLOTS];
static bool s_in_flight[MAX_WORKERS][MAX_STRIP_SLOTS];   // each worker's own
static atomic_bool s_ppa;

esp_err_t max_strips_init(max_strips_copy_t copy)
{
    s_copy = copy;
    s_fb_lock = xSemaphoreCreateMutex();
    if (!s_fb_lock) return ESP_ERR_NO_MEM;
    for (int w = 0; w < MAX_WORKERS; w++) {
        // DMA-capable for the PPA's reads and the panel's copy; cache-line aligned so no line is shared with anything.
        s_buf[w] = heap_caps_aligned_alloc(CACHE_LINE, WORKER_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
        if (!s_buf[w]) return ESP_ERR_NO_MEM;
        for (int s = 0; s < MAX_STRIP_SLOTS; s++)
            if (!(s_landed[w][s] = xSemaphoreCreateBinary())) return ESP_ERR_NO_MEM;
    }
    const esp_err_t ppa = max_turn_ppa_open();
    atomic_store(&s_ppa, ppa == ESP_OK);
    if (ppa != ESP_OK) ESP_LOGW(TAG, "no PPA (%s): the CPU turns the strips", esp_err_to_name(ppa));
    return ESP_OK;
}

void max_strips_framebuffer(uint16_t *fb) { s_fb = fb; }
bool max_strips_ppa(void) { return atomic_load(&s_ppa); }
void max_strips_use_ppa(bool on) { atomic_store(&s_ppa, on); }

uint16_t *max_strip_buffer(int worker, int slot) { return s_buf[worker] + (size_t)slot * MAX_STRIP_PX; }

// The PPA's turn of `src` into its place; queued when `landed` is given. False when the PPA did not take it: logged
// once, and the CPU turns every strip from then on.
static bool ppa_turn(int lane, const uint16_t *src, int w, int h, max_rect_t panel, SemaphoreHandle_t landed)
{
    if (!atomic_load(&s_ppa)) return false;
    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    esp_err_t err = ESP_ERR_INVALID_STATE;
    if (atomic_load(&s_ppa)) {   // again, under the lock: the other worker may have turned it off meanwhile
        err = max_turn_ppa_into(lane, src, w, h, s_fb, MAX_GLASS_H, MAX_GLASS_W, FB_BYTES, panel.x, panel.y, landed);
        if (err != ESP_OK) {
            atomic_store(&s_ppa, false);
            ESP_LOGE(TAG, "PPA turn of %dx%d failed (%s): the CPU turns the strips from now on", w, h,
                     esp_err_to_name(err));
        }
    }
    xSemaphoreGive(s_fb_lock);
    return err == ESP_OK;
}
static void cpu_turn(const uint16_t *src, int w, int h, max_rect_t panel, uint16_t *band)
{
    max_turn_pixels(src, w, h, band);
    xSemaphoreTake(s_fb_lock, portMAX_DELAY);
    while (max_turn_ppa_queued()) vTaskDelay(1);   // only right after the PPA's refusal: its last turns landing
    s_copy(panel.x, panel.y, panel.w, panel.h, band);
    xSemaphoreGive(s_fb_lock);
}

void max_strip_push(int worker, int slot, int x, int y, int w, int h)
{
    assert(s_fb && w > 0 && h > 0 && w * h <= MAX_STRIP_PX && !s_in_flight[worker][slot]);
    const max_rect_t panel = max_turn_rect((max_rect_t){x, y, w, h});
    const uint16_t *src = max_strip_buffer(worker, slot);
    if (ppa_turn(worker, src, w, h, panel, s_landed[worker][slot])) {
        s_in_flight[worker][slot] = true;   // its give may come before this: the semaphore keeps it
        return;
    }
    const int band = (slot + 1) % MAX_STRIP_SLOTS;   // the worker's other buffer, once its own push has landed
    max_strip_wait(worker, band);
    cpu_turn(src, w, h, panel, max_strip_buffer(worker, band));
}

void max_strip_wait(int worker, int slot)
{
    if (!s_in_flight[worker][slot]) return;
    if (xSemaphoreTake(s_landed[worker][slot], pdMS_TO_TICKS(LANDED_MS)) != pdTRUE) {
        ESP_LOGE(TAG, "a PPA turn did not land in %d ms", LANDED_MS);
        abort();
    }
    s_in_flight[worker][slot] = false;
}

void max_strips_put(int x, int y, int w, int h)
{
    assert(s_fb && w > 0 && h > 0 && w * h <= PRO_STRIP_PX);
    const max_rect_t panel = max_turn_rect((max_rect_t){x, y, w, h});
    if (ppa_turn(0, s_buf[0], w, h, panel, NULL)) return;
    cpu_turn(s_buf[0], w, h, panel, s_buf[1]);   // the helper's buffers: idle between frames
}
