// The Linux cable (linux/cable/cable_linux.c) as pro_cable sees it, at each far end. One far end per process (the
// link starts once): `test_cable_linux demo` runs against a fake of main/demo defined here, `test_cable_linux tcp`
// against a daemon played by this test over a socket, `test_cable_linux usb` against a host played over a pty.
#define _GNU_SOURCE   // glibc's posix_openpt and ptsname
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "cable/cable_link.h"
#include "cable/cable_linux.h"
#include "demo/max_demo.h"
#include "esp_timer.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static void sleep_ms(int ms)
{
    const struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
    nanosleep(&ts, NULL);
}

static int64_t now_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

// Polls `cond` for up to two seconds: the link works on its own thread.
#define WAIT_FOR(cond) do { for (int w_ = 0; w_ < 200 && !(cond); w_++) sleep_ms(10); } while (0)

// ── what pro_cable sees ─────────────────────────────────────────────────────────────────────────────────────────

typedef struct {
    uint8_t version, type;
    size_t len;
    uint8_t data[CABLE_MAX_PAYLOAD];
} frame_t;

#define FRAMES_MAX 16
static pthread_mutex_t s_mu = PTHREAD_MUTEX_INITIALIZER;   // everything below
static frame_t s_got[FRAMES_MAX];
static int s_got_n;
static atomic_int s_ticks;
static pthread_t s_reader;   // the thread the callbacks run on
static atomic_bool s_reader_known, s_off_reader;
static const char *s_answer;   // what the frame callback sends back, as pro_cable answers a welcome from the reader

static void on_reader(void)
{
    if (!atomic_exchange(&s_reader_known, true)) s_reader = pthread_self();
    else if (!pthread_equal(s_reader, pthread_self())) atomic_store(&s_off_reader, true);
}

static void on_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t len, void *ctx)
{
    CHECK(ctx == &s_got);
    on_reader();
    pthread_mutex_lock(&s_mu);
    if (s_got_n < FRAMES_MAX) {
        frame_t *f = &s_got[s_got_n++];
        f->version = version;
        f->type = type;
        f->len = len;
        memcpy(f->data, payload, len);
    }
    const char *answer = s_answer;
    s_answer = NULL;
    pthread_mutex_unlock(&s_mu);
    if (answer) CHECK(cable_link_send(CABLE_TYPE_JSON, (const uint8_t *)answer, strlen(answer)));
}

static void on_tick(void *ctx)
{
    CHECK(ctx == &s_got);
    on_reader();
    atomic_fetch_add(&s_ticks, 1);
}

static int got_count(void)
{
    pthread_mutex_lock(&s_mu);
    const int n = s_got_n;
    pthread_mutex_unlock(&s_mu);
    return n;
}

static bool got_is(int i, uint8_t type, const char *text)
{
    pthread_mutex_lock(&s_mu);
    const bool is = i < s_got_n && s_got[i].version == CABLE_FRAME_VERSION && s_got[i].type == type &&
                    s_got[i].len == strlen(text) && !memcmp(s_got[i].data, text, s_got[i].len);
    pthread_mutex_unlock(&s_mu);
    return is;
}

static bool send_text(const char *text) { return cable_link_send(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text)); }

// The tick runs while nothing arrives, at least every 100 ms as on the device.
static void check_idle_ticks(void)
{
    const int before = atomic_load(&s_ticks);
    sleep_ms(1000);
    CHECK(atomic_load(&s_ticks) - before >= 5);
}

// ── the demo far end: a fake of main/demo ───────────────────────────────────────────────────────────────────────

static atomic_int s_resets, s_story_resets;
static pthread_t s_demo_thread;
static atomic_bool s_demo_known, s_demo_off_thread;
static uint8_t s_received[64][16];   // the first bytes of each frame the demo was handed, and its type
static uint8_t s_received_type[64];
static size_t s_received_len[64];
static atomic_int s_received_n;
static pthread_mutex_t s_gate = PTHREAD_MUTEX_INITIALIZER;   // held by the test to stall the demo's receive
static atomic_bool s_stalled;   // the demo is in a receive, waiting for the gate
static char s_outbox[64];   // under s_mu: a frame for the next tick
static uint32_t s_due_ms, s_emitted_at_ms;   // under s_mu: when the outbox is due, and when the tick sent it

static void demo_call(void)
{
    if (!atomic_exchange(&s_demo_known, true)) s_demo_thread = pthread_self();
    else if (!pthread_equal(s_demo_thread, pthread_self())) atomic_store(&s_demo_off_thread, true);
}

void max_demo_reset(uint32_t now_ms, bool story)
{
    (void)now_ms;
    demo_call();
    atomic_fetch_add(&s_resets, 1);
    if (story) atomic_fetch_add(&s_story_resets, 1);
}

void max_demo_receive(uint8_t type, const uint8_t *payload, size_t len, uint32_t now_ms)
{
    demo_call();
    if (len == 5 && !memcmp(payload, "stall", 5)) {   // the test holds the gate: a demo that is slow to read
        atomic_store(&s_stalled, true);
        pthread_mutex_lock(&s_gate);
        pthread_mutex_unlock(&s_gate);
    }
    const int i = atomic_load(&s_received_n);
    if (i < 64) {
        memcpy(s_received[i], payload, len < 16 ? len : 16);
        s_received_type[i] = type;
        s_received_len[i] = len;
        atomic_store(&s_received_n, i + 1);
    }
    if (len == 4 && !memcmp(payload, "ping", 4)) {   // a reply waits for the tick, as the real demo's do
        pthread_mutex_lock(&s_mu);
        snprintf(s_outbox, sizeof s_outbox, "pong");
        s_due_ms = now_ms;
        pthread_mutex_unlock(&s_mu);
    }
}

void max_demo_tick(uint32_t now_ms, max_demo_emit_fn emit, void *ctx)
{
    demo_call();
    char out[64] = "";
    pthread_mutex_lock(&s_mu);
    if (s_outbox[0] && (int32_t)(now_ms - s_due_ms) >= 0) {
        memcpy(out, s_outbox, sizeof out);
        s_outbox[0] = 0;
        s_emitted_at_ms = now_ms;
    }
    pthread_mutex_unlock(&s_mu);
    if (out[0]) emit(CABLE_TYPE_JSON, (const uint8_t *)out, strlen(out), ctx);
}

uint32_t max_demo_next_ms(uint32_t now_ms)
{
    demo_call();
    pthread_mutex_lock(&s_mu);
    const uint32_t next = s_outbox[0] && (int32_t)(s_due_ms - now_ms) < 1000 ? s_due_ms : now_ms + 1000;
    pthread_mutex_unlock(&s_mu);
    return next;
}

static bool received_is(int i, uint8_t type, const char *text)
{
    return i < atomic_load(&s_received_n) && s_received_type[i] == type && s_received_len[i] == strlen(text) &&
           !memcmp(s_received[i], text, strlen(text));
}

static void test_demo(void)
{
    cable_linux_use_demo(true);   // --story
    CHECK(!send_text("early"));   // no link before start
    CHECK(cable_link_start(on_frame, on_tick, &s_got));
    CHECK(cable_link_host_present());   // the demo daemon is always plugged in
    WAIT_FOR(atomic_load(&s_resets) == 1);
    CHECK(atomic_load(&s_resets) == 1 && atomic_load(&s_story_resets) == 1);   // the demo asked for

    // The device's frames reach the demo whole and in order, on the demo's one thread.
    CHECK(send_text("hello"));
    const uint8_t pcm[3] = {1, 2, 3};
    CHECK(cable_link_send_nowait(CABLE_TYPE_PCM, pcm, sizeof pcm));
    WAIT_FOR(atomic_load(&s_received_n) == 2);
    CHECK(received_is(0, CABLE_TYPE_JSON, "hello") && received_is(1, CABLE_TYPE_PCM, "\1\2\3"));
    CHECK(!atomic_load(&s_demo_off_thread));

    // A reply goes out at the tick after it, to the frame callback as a version-1 frame; the callback may send.
    pthread_mutex_lock(&s_mu);
    s_answer = "after-pong";
    pthread_mutex_unlock(&s_mu);
    CHECK(send_text("ping"));
    WAIT_FOR(got_count() == 1 && atomic_load(&s_received_n) == 4);
    CHECK(got_is(0, CABLE_TYPE_JSON, "pong"));
    CHECK(received_is(2, CABLE_TYPE_JSON, "ping") && received_is(3, CABLE_TYPE_JSON, "after-pong"));

    // Something the story has due later goes out when it is due, not at an earlier tick.
    pthread_mutex_lock(&s_mu);
    snprintf(s_outbox, sizeof s_outbox, "later");
    const uint32_t due = (uint32_t)(esp_timer_get_time() / 1000) + 400;   // the link's clock
    s_due_ms = due;
    pthread_mutex_unlock(&s_mu);
    sleep_ms(200);
    CHECK(got_count() == 1);   // ticks ran meanwhile, and sent nothing
    WAIT_FOR(got_count() == 2);
    CHECK(got_is(1, CABLE_TYPE_JSON, "later"));
    pthread_mutex_lock(&s_mu);
    CHECK((int32_t)(s_emitted_at_ms - due) >= 0);
    pthread_mutex_unlock(&s_mu);

    // A payload over the frame's limit is refused, as the device's encoder refuses it.
    static uint8_t big[CABLE_MAX_PAYLOAD + 1];
    CHECK(!cable_link_send(CABLE_TYPE_JSON, big, sizeof big));
    CHECK(cable_link_send(CABLE_TYPE_JSON, big, CABLE_MAX_PAYLOAD));
    WAIT_FOR(atomic_load(&s_received_n) == 5);

    // A demo that stops reading: 64 KB queue, then a send waits its 100 ms and fails, and a no-wait send fails fast.
    pthread_mutex_lock(&s_gate);
    CHECK(send_text("stall"));
    WAIT_FOR(atomic_load(&s_stalled));   // the reader took "stall" off the queue and sits in receive
    CHECK(atomic_load(&s_stalled));
    for (int i = 0; i < 8; i++) CHECK(cable_link_send(CABLE_TYPE_JSON, big, CABLE_MAX_PAYLOAD));
    int64_t t0 = now_us();
    CHECK(!cable_link_send(CABLE_TYPE_JSON, big, CABLE_MAX_PAYLOAD));
    const int64_t waited = now_us() - t0;
    CHECK(waited >= 90000 && waited < 1000000);
    t0 = now_us();
    CHECK(!cable_link_send_nowait(CABLE_TYPE_JSON, big, CABLE_MAX_PAYLOAD));
    CHECK(now_us() - t0 < 100000);
    pthread_mutex_unlock(&s_gate);
    WAIT_FOR(atomic_load(&s_received_n) == 14);
    CHECK(atomic_load(&s_received_n) == 14);   // "stall" and the eight that fit, nothing else
    CHECK(send_text("after"));
    WAIT_FOR(atomic_load(&s_received_n) == 15);
    CHECK(received_is(14, CABLE_TYPE_JSON, "after"));

    check_idle_ticks();

    // A re-plug is a new device to the demo: the same demo starts over.
    cable_link_replug();
    WAIT_FOR(atomic_load(&s_resets) == 2);
    CHECK(atomic_load(&s_resets) == 2 && atomic_load(&s_story_resets) == 2);

    CHECK(!atomic_load(&s_demo_off_thread));   // one thread called the demo, as it requires
    CHECK(!atomic_load(&s_off_reader) && pthread_equal(s_reader, s_demo_thread));
    CHECK(!cable_link_rx_pending());
}

// ── the TCP far end: this test as the daemon ────────────────────────────────────────────────────────────────────

static int free_port(void)
{
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    socklen_t len = sizeof addr;
    CHECK(fd >= 0 && bind(fd, (struct sockaddr *)&addr, sizeof addr) == 0);
    CHECK(getsockname(fd, (struct sockaddr *)&addr, &len) == 0);
    close(fd);
    return ntohs(addr.sin_port);
}

static int dial(int port)
{
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port),
                               .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    CHECK(fd >= 0 && connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0);
    return fd;
}

static void write_frame(int fd, const char *text, size_t first_part)
{
    uint8_t frame[CABLE_MAX_FRAME];
    const int n = cable_frame_encode(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text), frame, sizeof frame);
    CHECK(n > 0);
    const size_t a = first_part < (size_t)n ? first_part : (size_t)n;
    CHECK(write(fd, frame, a) == (ssize_t)a);
    if (a < (size_t)n) {
        sleep_ms(30);   // the rest comes in a later read
        CHECK(write(fd, frame + a, (size_t)n - a) == (ssize_t)(n - a));
    }
}

typedef struct {
    int count;
    char text[64];
} daemon_got_t;

static void daemon_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t len, void *ctx)
{
    daemon_got_t *got = ctx;
    CHECK(version == CABLE_FRAME_VERSION && type == CABLE_TYPE_JSON && len < sizeof got->text);
    memcpy(got->text, payload, len);
    got->text[len] = 0;
    got->count++;
}

// The next frame the device sends on `fd`, or "" after two seconds.
static const char *read_frame(int fd)
{
    static cable_decoder_t d;
    static daemon_got_t got;
    cable_decoder_init(&d);
    got.count = 0;
    got.text[0] = 0;
    for (int i = 0; i < 200 && !got.count; i++) {
        struct pollfd p = {.fd = fd, .events = POLLIN};
        if (poll(&p, 1, 10) <= 0) continue;
        uint8_t buf[256];
        const ssize_t n = read(fd, buf, sizeof buf);
        if (n <= 0) break;
        cable_decoder_feed(&d, buf, (size_t)n, daemon_frame, &got);
    }
    return got.text;
}

// Whether the device hung up on `fd` within two seconds.
static bool hung_up(int fd)
{
    struct pollfd p = {.fd = fd, .events = POLLIN};
    uint8_t buf[64];
    return poll(&p, 1, 2000) == 1 && read(fd, buf, sizeof buf) == 0;
}

static void test_tcp(void)
{
    const int port = free_port();
    cable_linux_use_tcp(port);
    CHECK(cable_link_start(on_frame, on_tick, &s_got));
    CHECK(!cable_link_host_present());   // nobody dialled in yet
    CHECK(!send_text("nobody"));

    // A daemon dials in; a frame split over two reads arrives once, whole.
    const int a = dial(port);
    WAIT_FOR(cable_link_host_present());
    CHECK(cable_link_host_present());
    write_frame(a, "{\"t\":\"welcome\"}", 7);
    WAIT_FOR(got_count() == 1);
    CHECK(got_is(0, CABLE_TYPE_JSON, "{\"t\":\"welcome\"}"));

    // The device's frames reach the daemon in the USB framing.
    CHECK(send_text("{\"t\":\"hello\"}"));
    CHECK(!strcmp(read_frame(a), "{\"t\":\"hello\"}"));

    // A frame whose bytes stop is dropped after 300 ms and counted, and the next whole frame still arrives.
    uint32_t corrupt = 0;
    cable_link_counters(&corrupt, NULL);
    CHECK(corrupt == 0);
    uint8_t frame[64];
    const int n = cable_frame_encode(CABLE_TYPE_JSON, (const uint8_t *)"cut", 3, frame, sizeof frame);
    CHECK(write(a, frame, (size_t)n - 2) == n - 2);
    sleep_ms(50);
    CHECK(cable_link_rx_pending());
    sleep_ms(450);
    CHECK(!cable_link_rx_pending());
    cable_link_counters(&corrupt, NULL);
    CHECK(corrupt == 1);
    write_frame(a, "whole", 99);
    WAIT_FOR(got_count() == 2);
    CHECK(got_is(1, CABLE_TYPE_JSON, "whole"));

    // A second daemon replaces the first: the first is hung up on, and the device now talks to the second.
    const int b = dial(port);
    CHECK(hung_up(a));
    close(a);
    write_frame(b, "from-b", 99);
    WAIT_FOR(got_count() == 3);
    CHECK(got_is(2, CABLE_TYPE_JSON, "from-b"));
    CHECK(send_text("to-b"));
    CHECK(!strcmp(read_frame(b), "to-b"));

    check_idle_ticks();

    // A re-plug hangs up, for the daemon to dial again.
    cable_link_replug();
    CHECK(hung_up(b));
    close(b);
    WAIT_FOR(!cable_link_host_present());
    CHECK(!cable_link_host_present());
    CHECK(!send_text("gone"));

    // A daemon that hangs up is gone too, and a new one is served.
    const int c = dial(port);
    WAIT_FOR(cable_link_host_present());
    close(c);
    WAIT_FOR(!cable_link_host_present());
    CHECK(!cable_link_host_present());
    const int d = dial(port);
    write_frame(d, "from-d", 99);
    WAIT_FOR(got_count() == 4);
    CHECK(got_is(3, CABLE_TYPE_JSON, "from-d"));
    close(d);

    CHECK(!atomic_load(&s_off_reader));   // frames and ticks all on the one reader thread
    CHECK(cable_link_stats().frames_ok == 4);
}

// ── the USB far end: this test as the host, over a pseudo-terminal in place of the gadget's serial port ─────────

static char s_state_path[64];

// What the gadget's controller says of the host (/sys/class/udc/*/state).
static void set_udc_state(const char *state)
{
    FILE *f = fopen(s_state_path, "w");
    CHECK(f && fputs(state, f) >= 0 && fclose(f) == 0);
}

static void test_usb(void)
{
    const int host = posix_openpt(O_RDWR | O_NOCTTY);
    CHECK(host >= 0 && grantpt(host) == 0 && unlockpt(host) == 0);
    char port[128];
    snprintf(port, sizeof port, "%s", ptsname(host));
    snprintf(s_state_path, sizeof s_state_path, "/tmp/test_cable_usb.%d", (int)getpid());
    set_udc_state("not attached\n");
    cable_linux_use_usb(port, s_state_path);
    CHECK(cable_link_start(on_frame, on_tick, &s_got));
    CHECK(!cable_link_host_present());   // the port is open, but no host has configured the gadget
    CHECK(!send_text("nobody"));

    // A host configures it: frames go both ways in the USB framing, a frame split over two reads arriving once.
    set_udc_state("configured\n");
    WAIT_FOR(cable_link_host_present());
    CHECK(cable_link_host_present());
    write_frame(host, "{\"t\":\"welcome\"}", 7);
    WAIT_FOR(got_count() == 1);
    CHECK(got_is(0, CABLE_TYPE_JSON, "{\"t\":\"welcome\"}"));
    CHECK(send_text("{\"t\":\"hello\"}"));
    CHECK(!strcmp(read_frame(host), "{\"t\":\"hello\"}"));

    check_idle_ticks();

    // The host goes: nothing is sent to nobody, and a frame it left half written is not glued to the next host's.
    uint8_t frame[64];
    const int n = cable_frame_encode(CABLE_TYPE_JSON, (const uint8_t *)"cut", 3, frame, sizeof frame);
    CHECK(write(host, frame, (size_t)n - 2) == n - 2);
    sleep_ms(50);
    set_udc_state("not attached\n");
    WAIT_FOR(!cable_link_host_present());
    CHECK(!cable_link_host_present());
    CHECK(!send_text("gone"));
    set_udc_state("configured\n");
    WAIT_FOR(cable_link_host_present());
    write_frame(host, "fresh", 99);
    WAIT_FOR(got_count() == 2);
    CHECK(got_is(1, CABLE_TYPE_JSON, "fresh"));
    CHECK(send_text("to-fresh"));
    CHECK(!strcmp(read_frame(host), "to-fresh"));

    // A re-plug cannot re-enumerate without root: it drops what is half read and keeps the port.
    CHECK(write(host, frame, (size_t)n - 2) == n - 2);
    sleep_ms(50);
    cable_link_replug();
    sleep_ms(200);
    CHECK(!cable_link_rx_pending());
    CHECK(cable_link_host_present());
    write_frame(host, "after-replug", 99);
    WAIT_FOR(got_count() == 3);
    CHECK(got_is(2, CABLE_TYPE_JSON, "after-replug"));

    // The port itself goes (the gadget taken down): the host is gone with it.
    close(host);
    WAIT_FOR(!cable_link_host_present());
    CHECK(!cable_link_host_present());
    CHECK(!send_text("no-port"));

    unlink(s_state_path);
    CHECK(!atomic_load(&s_off_reader));   // frames and ticks all on the one reader thread
}

int main(int argc, char **argv)
{
    if (argc != 2 || (strcmp(argv[1], "demo") && strcmp(argv[1], "tcp") && strcmp(argv[1], "usb"))) {
        fprintf(stderr, "usage: test_cable_linux demo|tcp|usb\n");
        return 2;
    }
    if (!strcmp(argv[1], "demo")) test_demo();
    else if (!strcmp(argv[1], "tcp")) test_tcp();
    else test_usb();
    printf("test_cable_linux %s: %d checks passed\n", argv[1], checks);
    return 0;
}
