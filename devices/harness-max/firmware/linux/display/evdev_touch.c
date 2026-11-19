#include "evdev_touch.h"

#include <errno.h>
#include <linux/input.h>
#include <poll.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define BITS_LONGS(n) (((n) + 8 * sizeof(long) - 1) / (8 * sizeof(long)))

void evdev_touch_init(evdev_touch_t *t, int fd)
{
    memset(t, 0, sizeof *t);
    t->fd = fd;
}

// After SYN_DROPPED the events in between are gone: read the state back from the device.
static void resync(evdev_touch_t *t)
{
    unsigned long keys[BITS_LONGS(KEY_CNT)] = {0};
    struct input_absinfo ax, ay;
    if (ioctl(t->fd, EVIOCGKEY(sizeof keys), keys) >= 0)
        t->pend_down = (keys[BTN_TOUCH / (8 * sizeof(long))] >> (BTN_TOUCH % (8 * sizeof(long)))) & 1;
    if (ioctl(t->fd, EVIOCGABS(ABS_X), &ax) >= 0) t->pend_x = ax.value;
    if (ioctl(t->fd, EVIOCGABS(ABS_Y), &ay) >= 0) t->pend_y = ay.value;
}

// Every event the device has now, without waiting.
static bool drain(evdev_touch_t *t)
{
    struct input_event ev[64];
    for (;;) {
        const ssize_t n = read(t->fd, ev, sizeof ev);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == EAGAIN) return true;
        if (n <= 0) {   // unplugged (ENODEV), or the end of file
            t->gone_errno = n < 0 ? errno : 0;
            return false;
        }
        for (size_t i = 0; i < (size_t)n / sizeof ev[0]; i++) {
            const struct input_event *e = &ev[i];
            if (e->type == EV_SYN && e->code == SYN_DROPPED) {
                t->dropped = true;
            } else if (e->type == EV_SYN && e->code == SYN_REPORT) {
                if (t->dropped) {
                    resync(t);
                    t->dropped = false;
                }
                t->down = t->pend_down;
                t->x = t->pend_x;
                t->y = t->pend_y;
            } else if (t->dropped) {
                continue;   // until the next report, events are part of what was lost
            } else if (e->type == EV_ABS && e->code == ABS_X) {
                t->pend_x = e->value;
            } else if (e->type == EV_ABS && e->code == ABS_Y) {
                t->pend_y = e->value;
            } else if (e->type == EV_KEY && e->code == BTN_TOUCH) {
                t->pend_down = e->value != 0;
            }
        }
    }
}

bool evdev_touch_read(evdev_touch_t *t, int wait_ms)
{
    if (!drain(t)) return false;
    // The kernel wakes a reader at a report's end (SYN_REPORT), so the wait ends with a whole report to take. An
    // event between the drain and the poll is not missed: poll sees what is there to read.
    if (wait_ms > 0 && !t->down && !t->was_down) {
        struct pollfd p = {.fd = t->fd, .events = POLLIN};
        if (poll(&p, 1, wait_ms) > 0 && !drain(t)) return false;   // POLLHUP and POLLERR: the read says why
    }
    t->was_down = t->down;
    return true;
}
