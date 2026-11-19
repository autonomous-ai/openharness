// The Pro's cable/cable_link.h on Linux: one reader thread delivers frames and ticks pro_cable as the device's reader
// task does, from any far end (cable_linux.h).
//
// TCP: the bytes of one connection, through the same decoder as USB. USB: the bytes of the gadget's serial port, the
// same way; the port is opened again whenever it dies (a host that leaves hangs it up). Demo: the device's frames are
// queued and handed to the fake daemon on the reader thread, which is the one thread that calls main/demo (it is not
// thread-safe); its frames go straight to the frame callback, which may send and so only queues.
#include "cable_linux.h"

#include "cable/cable_link.h"
#include "demo/max_demo.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "cable";

// As the device's reader (cable_link.c): a read parks at most this long, so the tick runs at least this often; a
// partial frame whose bytes stop this long is dropped; a send waits this long for room.
#define READ_WAIT_MS 100
#define FRAME_IDLE_US INT64_C(300000)
#define WRITE_WAIT_MS 100
#define NOWAIT_WRITE_MS 10
#define READ_CHUNK 256
// The device's frames waiting for the demo, by payload bytes: a recording's PCM is the most that queues.
#define DEMO_QUEUE_BYTES (64 * 1024)
// How soon a USB port that would not open, or died, is tried again.
#define USB_REOPEN_US INT64_C(1000000)

static enum { USE_TCP, USE_USB, USE_DEMO } s_use = USE_TCP;
static int s_port = CABLE_LINUX_PORT;
static const char *s_usb_port = CABLE_LINUX_USB_PORT;
static char s_udc_state[256];   // empty: no controller, so never a host
static atomic_bool s_usb_host;   // the reader's last reading of s_udc_state
static cable_frame_cb s_cb;
static cable_tick_cb s_tick;
static void *s_ctx;
static atomic_bool s_running, s_replug;
static bool s_story;   // the demo's: set before the link starts, read by its reader
static atomic_uint s_rx_bytes, s_frames_ok;

void cable_linux_use_demo(bool story)
{
    s_use = USE_DEMO;
    s_story = story;
}

void cable_linux_use_tcp(int port)
{
    s_use = USE_TCP;
    s_port = port;
}

void cable_linux_use_usb(const char *port, const char *udc_state)
{
    s_use = USE_USB;
    s_usb_port = port;
    s_udc_state[0] = 0;
    if (udc_state) {
        snprintf(s_udc_state, sizeof s_udc_state, "%s", udc_state);
        return;
    }
    DIR *dir = opendir("/sys/class/udc");
    for (struct dirent *e; dir && (e = readdir(dir));) {
        if (e->d_name[0] == '.') continue;
        snprintf(s_udc_state, sizeof s_udc_state, "/sys/class/udc/%.200s/state", e->d_name);
        break;
    }
    if (dir) closedir(dir);
}

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

static void deliver(uint8_t version, uint8_t type, const uint8_t *payload, size_t len, void *ctx)
{
    atomic_fetch_add_explicit(&s_frames_ok, 1, memory_order_relaxed);
    s_cb(version, type, payload, len, ctx);
}

// Monotonic deadlines for the condition variable (CLOCK_MONOTONIC on Linux; macOS waits a relative time).
static void cond_init(pthread_cond_t *cv)
{
#ifdef __APPLE__
    pthread_cond_init(cv, NULL);
#else
    pthread_condattr_t attr;
    pthread_condattr_init(&attr);
    pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
    pthread_cond_init(cv, &attr);
    pthread_condattr_destroy(&attr);
#endif
}

// False when `deadline_ms` (esp_timer's clock) passed before a signal.
static bool cond_wait(pthread_cond_t *cv, pthread_mutex_t *mu, uint32_t deadline_ms)
{
    const int32_t left = (int32_t)(deadline_ms - now_ms());
    if (left <= 0) return false;
#ifdef __APPLE__
    const struct timespec rel = {left / 1000, (long)(left % 1000) * 1000000L};
    return pthread_cond_timedwait_relative_np(cv, mu, &rel) != ETIMEDOUT;
#else
    struct timespec abs;
    clock_gettime(CLOCK_MONOTONIC, &abs);
    abs.tv_sec += left / 1000;
    abs.tv_nsec += (long)(left % 1000) * 1000000L;
    if (abs.tv_nsec >= 1000000000L) {
        abs.tv_sec++;
        abs.tv_nsec -= 1000000000L;
    }
    return pthread_cond_timedwait(cv, mu, &abs) != ETIMEDOUT;
#endif
}

// ── demo ────────────────────────────────────────────────────────────────────────────────────────────────────────

typedef struct qframe {
    struct qframe *next;
    uint8_t type;
    size_t len;
    uint8_t data[];
} qframe_t;

static pthread_mutex_t s_q_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t s_q_cv;   // a frame was queued, or room was made
static qframe_t *s_q_head, **s_q_tail = &s_q_head;
static size_t s_q_bytes;

static bool demo_send(uint8_t type, const uint8_t *payload, size_t len, bool nowait)
{
    if (len > CABLE_MAX_PAYLOAD) {
        ESP_LOGE(TAG, "refusing to send %u-byte payload (max %d)", (unsigned)len, CABLE_MAX_PAYLOAD);
        return false;
    }
    qframe_t *f = malloc(sizeof *f + len);
    if (!f) return false;
    f->next = NULL;
    f->type = type;
    f->len = len;
    if (len) memcpy(f->data, payload, len);
    if (nowait ? pthread_mutex_trylock(&s_q_mu) != 0 : pthread_mutex_lock(&s_q_mu) != 0) {
        free(f);
        return false;
    }
    // A full queue is a host that is not reading: wait as a send on a full USB FIFO does, then give up.
    const uint32_t deadline = now_ms() + (nowait ? NOWAIT_WRITE_MS : WRITE_WAIT_MS);
    while (s_q_bytes + len > DEMO_QUEUE_BYTES && cond_wait(&s_q_cv, &s_q_mu, deadline)) {}
    const bool room = s_q_bytes + len <= DEMO_QUEUE_BYTES;
    if (room) {
        *s_q_tail = f;
        s_q_tail = &f->next;
        s_q_bytes += len;
        pthread_cond_broadcast(&s_q_cv);
    }
    pthread_mutex_unlock(&s_q_mu);
    if (!room) free(f);
    return room;
}

static void demo_emit(uint8_t type, const uint8_t *payload, size_t len, void *ctx)
{
    (void)ctx;
    deliver(CABLE_FRAME_VERSION, type, payload, len, s_ctx);
}

static void *demo_reader(void *arg)
{
    (void)arg;
    max_demo_reset(now_ms(), s_story);
    for (;;) {
        // A re-plug is a fresh plug-in: the same demo starts over, as a daemon sees a new device.
        if (atomic_exchange(&s_replug, false)) max_demo_reset(now_ms(), s_story);
        pthread_mutex_lock(&s_q_mu);
        qframe_t *in = s_q_head;
        s_q_head = NULL;
        s_q_tail = &s_q_head;
        s_q_bytes = 0;
        pthread_cond_broadcast(&s_q_cv);
        pthread_mutex_unlock(&s_q_mu);
        while (in) {
            qframe_t *next = in->next;
            max_demo_receive(in->type, in->data, in->len, now_ms());
            free(in);
            in = next;
        }
        max_demo_tick(now_ms(), demo_emit, NULL);
        if (s_tick) s_tick(s_ctx);
        // Until the demo has something due or the device sends, and at least once per READ_WAIT_MS for the tick.
        const uint32_t now = now_ms();
        const int32_t due = (int32_t)(max_demo_next_ms(now) - now);
        const uint32_t deadline = now + (uint32_t)(due < 0 ? 0 : due < READ_WAIT_MS ? due : READ_WAIT_MS);
        pthread_mutex_lock(&s_q_mu);
        while (!s_q_head && !atomic_load(&s_replug) && cond_wait(&s_q_cv, &s_q_mu, deadline)) {}
        pthread_mutex_unlock(&s_q_mu);
    }
    return NULL;
}

// ── TCP and USB: a descriptor of bytes in the USB framing ───────────────────────────────────────────────────────

static cable_decoder_t s_decoder;            // the reader's
static int s_listen = -1;
static pthread_mutex_t s_tx_mu = PTHREAD_MUTEX_INITIALIZER;   // the encode buffer, the write, and s_client
static int s_client = -1;
static uint8_t s_tx_frame[CABLE_MAX_FRAME];

// Swap the connection the reader serves (-1: none). The old one is closed under the send lock, so no send writes to a
// closed (or reused) descriptor; the decoder starts over, as after a re-plug.
static void set_client(int fd)
{
    pthread_mutex_lock(&s_tx_mu);
    if (s_client >= 0) close(s_client);
    s_client = fd;
    pthread_mutex_unlock(&s_tx_mu);
    cable_decoder_reset(&s_decoder);
}

static bool tcp_listen(void)
{
    s_listen = socket(AF_INET6, SOCK_STREAM, 0);
    if (s_listen < 0) {
        ESP_LOGE(TAG, "socket: %s", strerror(errno));
        return false;
    }
    const int on = 1, off = 0;
    setsockopt(s_listen, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
    setsockopt(s_listen, IPPROTO_IPV6, IPV6_V6ONLY, &off, sizeof off);   // IPv4 too, as mapped addresses
    struct sockaddr_in6 addr = {.sin6_family = AF_INET6, .sin6_port = htons((uint16_t)s_port), .sin6_addr = in6addr_any};
    if (bind(s_listen, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(s_listen, 2) != 0) {
        ESP_LOGE(TAG, "cannot listen on port %d: %s", s_port, strerror(errno));
        close(s_listen);
        s_listen = -1;
        return false;
    }
    return true;
}

static void *tcp_reader(void *arg)
{
    (void)arg;
    uint8_t chunk[READ_CHUNK];
    int64_t last_rx_us = esp_timer_get_time();
    for (;;) {
        if (atomic_exchange(&s_replug, false) && s_client >= 0) {
            ESP_LOGW(TAG, "re-plug: dropping the daemon's connection");
            set_client(-1);
        }
        struct pollfd fds[2] = {{.fd = s_listen, .events = POLLIN}, {.fd = s_client, .events = POLLIN}};
        const int ready = poll(fds, s_client >= 0 ? 2 : 1, READ_WAIT_MS);
        if (ready > 0 && (fds[0].revents & POLLIN)) {
            const int fd = accept(s_listen, NULL, NULL);
            if (fd >= 0) {
                // The newest connection wins: a daemon that restarted, or came back on another network, is not
                // locked out by its own half-dead last connection.
                ESP_LOGI(TAG, "daemon connected%s", s_client >= 0 ? " (replacing the last connection)" : "");
                fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
#ifdef SO_NOSIGPIPE
                const int on = 1;
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
#endif
                set_client(fd);
                last_rx_us = esp_timer_get_time();
                fds[1].revents = 0;   // the poll result was for the old descriptor
            }
        }
        int n = 0;
        if (s_client >= 0 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            n = (int)read(s_client, chunk, sizeof chunk);
            if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
                ESP_LOGI(TAG, "daemon disconnected");
                set_client(-1);
                n = 0;
            }
            if (n < 0) n = 0;
        }
        // As the device's reader_step: expire a stale partial before feeding, then feed.
        if (s_decoder.len && esp_timer_get_time() - last_rx_us >= FRAME_IDLE_US) {
            cable_decoder_expire(&s_decoder, deliver, s_ctx);
            last_rx_us = esp_timer_get_time();
        }
        if (n > 0) {
            atomic_fetch_add_explicit(&s_rx_bytes, (unsigned)n, memory_order_relaxed);
            cable_decoder_feed(&s_decoder, chunk, (size_t)n, deliver, s_ctx);
            last_rx_us = esp_timer_get_time();
        }
        if (s_tick) s_tick(s_ctx);
    }
    return NULL;
}

// Whether a host has configured the gadget: the controller's state file says "configured".
static bool udc_configured(void)
{
    if (!s_udc_state[0]) return false;
    FILE *f = fopen(s_udc_state, "r");
    if (!f) return false;
    char state[32] = "";
    const bool configured = fgets(state, sizeof state, f) && !strncmp(state, "configured", 10);
    fclose(f);
    return configured;
}

static int open_usb_port(void)
{
    const int fd = open(s_usb_port, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return -1;
    struct termios t;
    if (tcgetattr(fd, &t) == 0) {   // raw bytes: no echo, no line editing, no CR/LF translation
        cfmakeraw(&t);
        tcsetattr(fd, TCSANOW, &t);
    }
    return fd;
}

// Start over on the port: what is half read or still unsent belongs to a host that is gone (or to no host at all).
static void usb_flush(void)
{
    pthread_mutex_lock(&s_tx_mu);
    if (s_client >= 0) tcflush(s_client, TCIOFLUSH);
    pthread_mutex_unlock(&s_tx_mu);
    cable_decoder_reset(&s_decoder);
}

static void *usb_reader(void *arg)
{
    (void)arg;
    uint8_t chunk[READ_CHUNK];
    int64_t last_rx_us = esp_timer_get_time(), reopen_at_us = 0;
    bool told_closed = false;
    for (;;) {
        const bool host = udc_configured();
        if (host != atomic_load(&s_usb_host)) {
            // Sends stop before the flush when the host goes, and start only after it when one comes.
            ESP_LOGI(TAG, "usb: %s", host ? "a host configured the gadget" : "the host is gone");
            if (!host) atomic_store(&s_usb_host, false);
            usb_flush();
            if (host) atomic_store(&s_usb_host, true);
        }
        // Without root the gadget cannot be re-enumerated: a re-plug drops what is in flight and keeps the port.
        if (atomic_exchange(&s_replug, false)) {
            ESP_LOGW(TAG, "re-plug: starting over on %s", s_usb_port);
            usb_flush();
        }
        if (s_client < 0 && esp_timer_get_time() >= reopen_at_us) {
            const int fd = open_usb_port();
            if (fd >= 0) {
                ESP_LOGI(TAG, "usb: %s open", s_usb_port);
                set_client(fd);
                told_closed = false;
            } else {
                if (!told_closed) ESP_LOGW(TAG, "usb: %s: %s (trying again each second)", s_usb_port, strerror(errno));
                told_closed = true;
                reopen_at_us = esp_timer_get_time() + USB_REOPEN_US;
            }
        }
        int n = 0;
        struct pollfd p = {.fd = s_client, .events = POLLIN};
        if (poll(&p, s_client >= 0 ? 1 : 0, READ_WAIT_MS) > 0 && (p.revents & (POLLIN | POLLHUP | POLLERR))) {
            n = (int)read(s_client, chunk, sizeof chunk);
            if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
                // Hung up (the host left, or the gadget went away): this descriptor is done; a new open serves the next.
                ESP_LOGI(TAG, "usb: %s closed", s_usb_port);
                set_client(-1);
                reopen_at_us = esp_timer_get_time() + USB_REOPEN_US;
            }
            if (n < 0) n = 0;
        }
        if (s_decoder.len && esp_timer_get_time() - last_rx_us >= FRAME_IDLE_US) {
            cable_decoder_expire(&s_decoder, deliver, s_ctx);
            last_rx_us = esp_timer_get_time();
        }
        if (n > 0) {
            atomic_fetch_add_explicit(&s_rx_bytes, (unsigned)n, memory_order_relaxed);
            cable_decoder_feed(&s_decoder, chunk, (size_t)n, deliver, s_ctx);
            last_rx_us = esp_timer_get_time();
        }
        if (s_tick) s_tick(s_ctx);
    }
    return NULL;
}

// Write all of `len` bytes to the connection within `wait_ms`. Under s_tx_mu.
static bool write_all(const uint8_t *data, size_t len, uint32_t wait_ms)
{
    const uint32_t deadline = now_ms() + wait_ms;
    while (len && s_client >= 0) {
#ifdef MSG_NOSIGNAL
        const ssize_t n = s_use == USE_TCP ? send(s_client, data, len, MSG_NOSIGNAL) : write(s_client, data, len);
#else
        const ssize_t n = s_use == USE_TCP ? send(s_client, data, len, 0) : write(s_client, data, len);
#endif
        if (n > 0) {
            data += n;
            len -= (size_t)n;
            continue;
        }
        if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return false;   // the reader sees it close
        const int32_t left = (int32_t)(deadline - now_ms());
        if (left <= 0) return false;
        struct pollfd p = {.fd = s_client, .events = POLLOUT};
        poll(&p, 1, left);
    }
    return len == 0;
}

static bool fd_send(uint8_t type, const uint8_t *payload, size_t len, bool nowait)
{
    // A gadget's port takes bytes with no host behind it and keeps them for the next one: say nothing to nobody.
    if (s_use == USE_USB && !atomic_load(&s_usb_host)) return false;
    if (nowait ? pthread_mutex_trylock(&s_tx_mu) != 0 : pthread_mutex_lock(&s_tx_mu) != 0) return false;
    bool ok = false;
    const int n = cable_frame_encode(type, payload, len, s_tx_frame, sizeof s_tx_frame);
    if (n < 0) ESP_LOGE(TAG, "refusing to send %u-byte payload (max %d)", (unsigned)len, CABLE_MAX_PAYLOAD);
    else ok = write_all(s_tx_frame, (size_t)n, nowait ? NOWAIT_WRITE_MS : WRITE_WAIT_MS);
    pthread_mutex_unlock(&s_tx_mu);
    return ok;
}

// ── cable_link.h ────────────────────────────────────────────────────────────────────────────────────────────────

bool cable_link_start(cable_frame_cb cb, cable_tick_cb tick, void *ctx)
{
    if (atomic_load(&s_running)) return true;
    s_cb = cb;
    s_tick = tick;
    s_ctx = ctx;
    cond_init(&s_q_cv);
    cable_decoder_init(&s_decoder);
    if (s_use == USE_TCP && !tcp_listen()) return false;
    atomic_store(&s_running, true);   // before the reader: a frame may arrive before pthread_create returns
    pthread_t reader;
    void *(*const run)(void *) = s_use == USE_TCP ? tcp_reader : s_use == USE_USB ? usb_reader : demo_reader;
    if (pthread_create(&reader, NULL, run, NULL) != 0) {
        atomic_store(&s_running, false);
        ESP_LOGE(TAG, "reader thread not started: no link to the daemon");
        return false;
    }
    pthread_detach(reader);
    if (s_use == USE_TCP) ESP_LOGI(TAG, "link up: waiting for a daemon on TCP port %d", s_port);
    else if (s_use == USE_USB) ESP_LOGI(TAG, "link up: waiting for a host on %s (%s)", s_usb_port,
                                        s_udc_state[0] ? s_udc_state : "no USB device controller");
    else ESP_LOGI(TAG, "link up: the demo daemon");
    return true;
}

bool cable_link_send(uint8_t type, const uint8_t *payload, size_t len)
{
    if (!atomic_load(&s_running)) return false;
    return s_use == USE_DEMO ? demo_send(type, payload, len, false) : fd_send(type, payload, len, false);
}

bool cable_link_send_nowait(uint8_t type, const uint8_t *payload, size_t len)
{
    if (!atomic_load(&s_running)) return false;
    return s_use == USE_DEMO ? demo_send(type, payload, len, true) : fd_send(type, payload, len, true);
}

// The log stays on stderr (the journal): the daemon files a Linux build's lines nowhere.
void cable_link_set_log_framing(bool on) { (void)on; }

bool cable_link_host_present(void)
{
    if (!atomic_load(&s_running)) return false;
    if (s_use == USE_DEMO) return true;   // the demo daemon is always plugged in
    pthread_mutex_lock(&s_tx_mu);
    const bool present = s_client >= 0 && (s_use == USE_TCP || atomic_load(&s_usb_host));
    pthread_mutex_unlock(&s_tx_mu);
    return present;
}

// The reader acts on it: the demo starts over, the TCP connection is dropped for the daemon to dial again, or the USB
// port starts over.
void cable_link_replug(void)
{
    if (!atomic_load(&s_running)) return;
    atomic_store(&s_replug, true);
    pthread_mutex_lock(&s_q_mu);
    pthread_cond_broadcast(&s_q_cv);
    pthread_mutex_unlock(&s_q_mu);
}

bool cable_link_rx_pending(void) { return s_decoder.len != 0; }   // the reader's own state; the demo's frames are whole

void cable_link_counters(uint32_t *corrupt_frames, uint32_t *discarded_bytes)
{
    if (corrupt_frames) *corrupt_frames = s_decoder.corrupt_frames;
    if (discarded_bytes) *discarded_bytes = s_decoder.discarded_bytes;
}

cable_link_stats_t cable_link_stats(void)
{
    // No USB peripheral: no ISR or ring counts.
    return (cable_link_stats_t){
        .rx_bytes = atomic_load_explicit(&s_rx_bytes, memory_order_relaxed),
        .frames_ok = atomic_load_explicit(&s_frames_ok, memory_order_relaxed),
        .corrupt_frames = s_decoder.corrupt_frames,
        .discarded_bytes = s_decoder.discarded_bytes,
    };
}

void cable_link_reset_decoder(void) { cable_decoder_reset(&s_decoder); }
