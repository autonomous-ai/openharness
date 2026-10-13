#include "pro_touch.h"

#include <assert.h>
#include <stdatomic.h>

#include "app/pro_app.h"

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TOUCH_STACK 10240   // SRC's Pro stack: a tap runs Pod's gesture and (after the lock is released) a cable send
#define DEAD_AFTER 8        // failed reads in a row before the controller counts as dead in the log

static atomic_uint s_presses, s_failures, s_streak, s_last_press_ms;
static atomic_bool s_held;

void pro_touch_feed(pro_touch_t *t, pro_touch_sample_t sample, int x, int y)
{
    const bool down = sample == PRO_TOUCH_ONE;
    const bool trusted = sample == PRO_TOUCH_ONE || sample == PRO_TOUCH_NONE;
    if (sample == PRO_TOUCH_ERROR) {
        atomic_fetch_add(&s_failures, 1);
        atomic_fetch_add(&s_streak, 1);
    } else {
        atomic_store(&s_streak, 0);
    }
    if (down) {
        t->last_x = x;
        t->last_y = y;
    }
    if (!trusted) {
        // Neither a lost sample, a second finger nor an off-glass point is a lift: do not re-arm on the next
        // DOWN of the same still-held finger. A failed read with nothing down swallows nothing.
        pro_app_touch_cancel();
        t->swallow = t->swallow || t->prev || sample == PRO_TOUCH_BAD;
    }
    if (down && !t->prev) {
        atomic_fetch_add(&s_presses, 1);
        atomic_store(&s_last_press_ms, (uint32_t)(esp_timer_get_time() / 1000));
        if (pro_app_asleep()) {
            // The touch that wakes the screen is not for Pod, nor is the rest of that contact.
            pro_app_touch_cancel();
            pro_app_wake();
            t->swallow = true;
        }
    }
    if (down) pro_app_bump_activity();
    // A power key can put the screen to sleep halfway through a contact, even while this task waited for the lock:
    // pro_app_touch then cancels instead, and the rest of the contact is consumed.
    if (!t->swallow && (down || t->prev) && !pro_app_touch(down, t->last_x, t->last_y)) t->swallow = true;
    if (!down && trusted) t->swallow = false;
    t->prev = down;
    atomic_store(&s_held, down);
}

static void touch_task(void *arg)
{
    (void)arg;
    pro_touch_t t = {0};
    for (;;) {
        int x = 0, y = 0;
        const pro_touch_sample_t s = pro_touch_poll(&x, &y);
        pro_touch_feed(&t, s, x, y);
        vTaskDelay(pdMS_TO_TICKS(s == PRO_TOUCH_ONE ? 4 : 20));
    }
}

void pro_touch_start(void)
{
    BaseType_t ok = xTaskCreatePinnedToCore(touch_task, "pro_touch", TOUCH_STACK, NULL, 7, NULL, 1);
    assert(ok == pdPASS);
    (void)ok;
}

void pro_touch_stats(pro_touch_stats_t *out)
{
    out->presses = atomic_load(&s_presses);
    out->last_press_ms_ago = (uint32_t)(esp_timer_get_time() / 1000) - atomic_load(&s_last_press_ms);
    out->read_failures = atomic_load(&s_failures);
    out->controller_ok = atomic_load(&s_streak) < DEAD_AFTER;
    out->held_now = atomic_load(&s_held);
}
