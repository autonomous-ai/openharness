// The finger from an evdev touchscreen (out_drm.c's): the contact and raw position of the device's last report.
//
// The touch task reads it every 20 ms while no finger is down and every 4 ms while one is (the Pro's pro_touch.c,
// which the Max compiles as it is). A read with no finger down, at its last return and now, first waits up to its bound
// for the device's next event: a press is read as the kernel reports it, not up to 20 ms later. A lift and a held
// finger never wait, so neither the release nor a move is read later than before. The ESP32-P4 polls its GT911 as
// the Pro does; this is the bar's alone.
#pragma once

#include <stdbool.h>

typedef struct {
    int fd;                            // the device, opened O_NONBLOCK
    bool down;                         // at the last report
    int x, y;                          // raw axis values at the last report
    int gone_errno;                    // after a read said the device is gone: why (0: end of file)
    bool pend_down, dropped, was_down;
    int pend_x, pend_y;
} evdev_touch_t;

void evdev_touch_init(evdev_touch_t *t, int fd);

// Takes in every report the device has, waiting first (up to wait_ms; 0: never) while no finger is down. False: the
// device is gone (unplugged, or its end of file), with gone_errno set.
bool evdev_touch_read(evdev_touch_t *t, int wait_ms);
