// The bar's evdev touch reader (display/evdev_touch.c) over a pipe that stands in for the device: reports commit at
// SYN_REPORT, a press with no finger down wakes a waiting read as it comes, a lift and a held finger never wait, the
// wait is bounded, and a device that goes away ends the read.
#include "display/evdev_touch.h"

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static int64_t now_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static void sleep_ms(int ms)
{
    struct timespec ts = {.tv_sec = ms / 1000, .tv_nsec = (long)(ms % 1000) * 1000000};
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {}
}

static struct input_event ev(int type, int code, int value)
{
    struct input_event e;
    memset(&e, 0, sizeof e);
    e.type = (uint16_t)type;
    e.code = (uint16_t)code;
    e.value = value;
    return e;
}

// One write, as the kernel hands a reader a whole report at once.
static void put(int fd, const struct input_event *e, int n)
{
    const ssize_t w = write(fd, e, (size_t)n * sizeof *e);
    assert(w == (ssize_t)((size_t)n * sizeof *e));
    (void)w;
}

static void press(int fd, int x, int y)
{
    const struct input_event e[] = {ev(EV_ABS, ABS_X, x), ev(EV_ABS, ABS_Y, y), ev(EV_KEY, BTN_TOUCH, 1),
                                    ev(EV_SYN, SYN_REPORT, 0)};
    put(fd, e, 4);
}

static void lift(int fd)
{
    const struct input_event e[] = {ev(EV_KEY, BTN_TOUCH, 0), ev(EV_SYN, SYN_REPORT, 0)};
    put(fd, e, 2);
}

// A pipe whose read end is non-blocking, as the device is opened.
static void device(evdev_touch_t *t, int *w)
{
    int p[2];
    const int ok = pipe(p);
    assert(ok == 0);
    (void)ok;
    fcntl(p[0], F_SETFL, fcntl(p[0], F_GETFL) | O_NONBLOCK);
    evdev_touch_init(t, p[0]);
    *w = p[1];
}

typedef struct {
    int fd, after_ms;
    bool close_it;   // close the write end instead of pressing: the device unplugged
    int64_t at_us;   // when it wrote (or closed)
} later_t;

static void *later(void *arg)
{
    later_t *l = arg;
    sleep_ms(l->after_ms);
    l->at_us = now_us();
    if (l->close_it) close(l->fd);
    else press(l->fd, 700, 300);
    return NULL;
}

static void test_report_commits_at_syn(void)
{
    evdev_touch_t t;
    int w;
    device(&t, &w);
    const struct input_event half[] = {ev(EV_ABS, ABS_X, 11), ev(EV_ABS, ABS_Y, 22), ev(EV_KEY, BTN_TOUCH, 1)};
    put(w, half, 3);
    CHECK(evdev_touch_read(&t, 0));
    CHECK(!t.down);   // no report yet
    const struct input_event syn = ev(EV_SYN, SYN_REPORT, 0);
    put(w, &syn, 1);
    CHECK(evdev_touch_read(&t, 0));
    CHECK(t.down && t.x == 11 && t.y == 22);
    // After SYN_DROPPED, the events up to the next report are part of what was lost: not taken as they come.
    const struct input_event drop[] = {ev(EV_SYN, SYN_DROPPED, 0), ev(EV_ABS, ABS_X, 99), ev(EV_SYN, SYN_REPORT, 0),
                                       ev(EV_ABS, ABS_X, 33), ev(EV_SYN, SYN_REPORT, 0)};
    put(w, drop, 5);
    CHECK(evdev_touch_read(&t, 0));
    CHECK(t.down && t.x == 33 && t.y == 22);   // a pipe has no state to read back: the next report's
    close(w);
    close(t.fd);
}

static void test_press_wakes_the_wait(void)
{
    evdev_touch_t t;
    int w;
    device(&t, &w);
    later_t l = {.fd = w, .after_ms = 60};
    pthread_t th;
    pthread_create(&th, NULL, later, &l);
    const int64_t t0 = now_us();
    CHECK(evdev_touch_read(&t, 1000));   // no finger at the last read: waits for the next event
    const int64_t t1 = now_us();
    pthread_join(th, NULL);
    CHECK(t.down && t.x == 700 && t.y == 300);
    CHECK(t1 - t0 >= 50000);          // it waited for the press...
    CHECK(t1 - l.at_us < 15000);      // ...and was back as it came, not a 20 ms poll later
    close(w);
    close(t.fd);
}

static void test_lift_and_held_finger_do_not_wait(void)
{
    evdev_touch_t t;
    int w;
    device(&t, &w);
    press(w, 5, 6);
    int64_t t0 = now_us();
    CHECK(evdev_touch_read(&t, 1000));   // the press there to read is taken at once
    CHECK(t.down && now_us() - t0 < 10000);
    t0 = now_us();
    CHECK(evdev_touch_read(&t, 1000));   // held, nothing new: the touch task's 4 ms cadence goes on
    CHECK(t.down && now_us() - t0 < 10000);
    lift(w);
    t0 = now_us();
    CHECK(evdev_touch_read(&t, 1000));   // the lift is read as it is, even with no event after it
    CHECK(!t.down && now_us() - t0 < 10000);
    t0 = now_us();
    CHECK(evdev_touch_read(&t, 80));     // the read after it waits, up to its bound
    const int64_t waited = now_us() - t0;
    CHECK(!t.down && waited >= 75000 && waited < 500000);
    t0 = now_us();
    CHECK(evdev_touch_read(&t, 0));      // no bound: no wait
    CHECK(!t.down && now_us() - t0 < 10000);
    close(w);
    close(t.fd);
}

// A press and lift between two reads ends lifted, as with the poll: the wait changes no state, only when it is read.
static void test_tap_between_reads(void)
{
    evdev_touch_t t;
    int w;
    device(&t, &w);
    press(w, 1, 2);
    lift(w);
    CHECK(evdev_touch_read(&t, 50));
    CHECK(!t.down && t.x == 1 && t.y == 2);
    close(w);
    close(t.fd);
}

static void test_gone(void)
{
    evdev_touch_t t;
    int w;
    device(&t, &w);
    later_t l = {.fd = w, .after_ms = 40, .close_it = true};
    pthread_t th;
    pthread_create(&th, NULL, later, &l);
    const int64_t t0 = now_us();
    CHECK(!evdev_touch_read(&t, 1000));   // unplugged during the wait: the read says so as it happens
    CHECK(now_us() - t0 < 500000);
    pthread_join(th, NULL);
    CHECK(t.gone_errno == 0);             // end of file (a real device says ENODEV)
    close(t.fd);
}

int main(void)
{
    test_report_commits_at_syn();
    test_press_wakes_the_wait();
    test_lift_and_held_finger_do_not_wait();
    test_tap_between_reads();
    test_gone();
    printf("test_evdev_touch: %d checks passed\n", checks);
    return 0;
}
