// The glass on a DRM/KMS screen with evdev touch: the Orange Pi's bar. No compositor and no GPU: two dumb buffers the
// display engine scans out in turn, painted by the CPU through glass_fit (scaled, and turned when the native mode is
// portrait). A frame is painted whole into the buffer off screen and flipped to on the next vblank, so the screen shows
// neither half a frame nor a tear where the scan passes the paint: what motion needs. Where the flip is refused, one
// buffer painted as it shows, as before.
//
// /dev/dri/card0 by name: on the Orange Pi the GPU's card1 enumerates first and has no display. The program must be
// the DRM master: the boot wrapper stops every other UI first (systemd Conflicts=).
#include "max_output.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#include "evdev_touch.h"
#include "glass_fit.h"

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "drm";

#define DRM_CARD "/dev/dri/card0"
#define TOUCH_RETRY_US 5000000   // a touchscreen that is not there (yet) is looked for again this often, as on the device
#define TOUCH_WAIT_MS 1000       // a read with no finger down waits this long at most for a press (evdev_touch.h)
#define FLIP_WAIT_MS 100         // six refreshes at 60 Hz: a flip that has not landed by then is not coming

typedef struct {
    uint32_t *pixels;   // XRGB8888, s_stride pixels a row
    size_t bytes;
    uint32_t fb;
} scanout_t;

// The render task's, like every paint; the touch task reads s_fit only.
static int s_fd = -1;          // open for the program's life: closing it would drop the master and the picture
static uint32_t s_crtc, s_conn;
static drmModeModeInfo s_mode;
static glass_fit_t s_fit;
static scanout_t s_buf[2];
static int s_stride;
static int s_front;            // the buffer on screen, or queued to be at the next vblank
static bool s_flipping;        // two buffers flipped on vblank; false: one, painted as it shows
static bool s_flip_pending;    // the last flip's vblank has not come: the other buffer may still be on screen
static uintptr_t s_flip_tag;   // that flip's: the event of one given up on is not it
static glass_fit_flip_t s_damage;
static const uint16_t *s_glass;
static bool s_dark;

// A dumb buffer of the mode's size, mapped, all black: the bars around a letterboxed picture stay black.
static bool scanout_make(scanout_t *out)
{
    struct drm_mode_create_dumb create = {.width = s_mode.hdisplay, .height = s_mode.vdisplay, .bpp = 32};
    if (drmIoctl(s_fd, DRM_IOCTL_MODE_CREATE_DUMB, &create) != 0 ||
        drmModeAddFB(s_fd, s_mode.hdisplay, s_mode.vdisplay, 24, 32, create.pitch, create.handle, &out->fb) != 0)
        return false;
    struct drm_mode_map_dumb map = {.handle = create.handle};
    if (drmIoctl(s_fd, DRM_IOCTL_MODE_MAP_DUMB, &map) != 0) return false;
    void *pixels = mmap(NULL, create.size, PROT_READ | PROT_WRITE, MAP_SHARED, s_fd, (off_t)map.offset);
    if (pixels == MAP_FAILED) return false;
    memset(pixels, 0, create.size);
    out->pixels = pixels;
    out->bytes = create.size;
    s_stride = (int)(create.pitch / 4);   // both buffers are the mode's size: the same pitch
    return true;
}

bool max_output_open(int glass_w, int glass_h)
{
    s_fd = open(DRM_CARD, O_RDWR | O_CLOEXEC);
    if (s_fd < 0) {
        ESP_LOGE(TAG, "%s: %s", DRM_CARD, strerror(errno));
        return false;
    }
    drmModeRes *res = drmModeGetResources(s_fd);
    drmModeConnector *conn = NULL;
    for (int i = 0; res && i < res->count_connectors && !conn; i++) {
        conn = drmModeGetConnector(s_fd, res->connectors[i]);
        if (conn && (conn->connection != DRM_MODE_CONNECTED || conn->count_modes == 0)) {
            drmModeFreeConnector(conn);
            conn = NULL;
        }
    }
    if (!conn) {
        ESP_LOGE(TAG, "%s: no connected display", DRM_CARD);
        return false;
    }
    // The panel's preferred mode is its native one (the bar: 320 x 1480, portrait).
    s_mode = conn->modes[0];
    for (int i = 0; i < conn->count_modes; i++)
        if (conn->modes[i].type & DRM_MODE_TYPE_PREFERRED) {
            s_mode = conn->modes[i];
            break;
        }
    // The CRTC driving the connector now, else the first one its encoders can use.
    for (int i = 0; i < conn->count_encoders && !s_crtc; i++) {
        drmModeEncoder *enc = drmModeGetEncoder(s_fd, conn->encoders[i]);
        if (!enc) continue;
        if (enc->encoder_id == conn->encoder_id && enc->crtc_id) s_crtc = enc->crtc_id;
        for (int c = 0; !s_crtc && c < res->count_crtcs; c++)
            if (enc->possible_crtcs & (1u << c)) s_crtc = res->crtcs[c];
        drmModeFreeEncoder(enc);
    }
    if (!s_crtc || !scanout_make(&s_buf[0])) {
        ESP_LOGE(TAG, "no scanout buffer for %ux%u: %s", s_mode.hdisplay, s_mode.vdisplay, strerror(errno));
        return false;
    }
    s_conn = conn->connector_id;
    if (drmModeSetCrtc(s_fd, s_crtc, s_buf[0].fb, 0, 0, &s_conn, 1, &s_mode) != 0) {
        // EACCES: another program is the DRM master (a UI that has not stopped).
        ESP_LOGE(TAG, "cannot show %ux%u on %s: %s", s_mode.hdisplay, s_mode.vdisplay, DRM_CARD, strerror(errno));
        return false;
    }
    // The second buffer is what a flip needs; without it the one on screen is painted as it shows, which can tear.
    s_flipping = scanout_make(&s_buf[1]);
    if (!s_flipping)
        ESP_LOGW(TAG, "no second scanout buffer (%s): painting the one on screen, which can tear", strerror(errno));
    s_fit = glass_fit(glass_w, glass_h, s_mode.hdisplay, s_mode.vdisplay);
    ESP_LOGI(TAG, "%s %ux%u@%u: the %dx%d glass as %dx%d at (%d,%d)%s, %s", DRM_CARD, s_mode.hdisplay, s_mode.vdisplay,
             s_mode.vrefresh, glass_w, glass_h, s_fit.pic.w, s_fit.pic.h, s_fit.pic.x, s_fit.pic.y,
             s_fit.turned ? ", turned a quarter" : "", s_flipping ? "two buffers flipped on vblank" : "one buffer");
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    return true;
}

static void paint(int buffer, glass_fit_rect_t land)
{
    glass_fit_paint(&s_fit, s_glass, land, s_buf[buffer].pixels, s_stride);
}

static void flip_done(int fd, unsigned int sequence, unsigned int tv_sec, unsigned int tv_usec, void *tag)
{
    (void)fd;
    (void)sequence;
    (void)tv_sec;
    (void)tv_usec;
    if ((uintptr_t)tag == s_flip_tag) s_flip_pending = false;
}

// Until the last flip has landed: from then on the buffer it left is off screen and free to paint (each frame waits
// for its own, max_output_show). Bounded: a flip whose vblank does not come (the screen gone) is taken as done, said
// once; the next flip then fails (EBUSY) if the kernel still holds it, which ends the flipping (single_buffer).
static void flip_wait(void)
{
    static bool said;
    drmEventContext events = {.version = 2, .page_flip_handler = flip_done};
    while (s_flip_pending) {
        struct pollfd p = {.fd = s_fd, .events = POLLIN};
        const int n = poll(&p, 1, FLIP_WAIT_MS);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0 || drmHandleEvent(s_fd, &events) != 0) {
            if (!said) ESP_LOGW(TAG, "a flip did not land in %d ms (%s): taken as done", FLIP_WAIT_MS,
                                n < 0 ? strerror(errno) : n == 0 ? "no vblank" : "the event did not read");
            said = true;
            s_flip_pending = false;
        }
    }
}

// A flip was refused: one buffer from now on, painted as it shows, as when there was no second one. The frame is
// whole in the buffer off screen (`out` was just painted into it): show that one the plain way, else bring the one on
// screen up to date.
static void single_buffer(const char *why, const glass_fit_rect_t *out, int n)
{
    ESP_LOGW(TAG, "page flip refused (%s): painting the buffer on screen from now on, which can tear", why);
    s_flipping = false;
    const int back = s_front ^ 1;
    if (drmModeSetCrtc(s_fd, s_crtc, s_buf[back].fb, 0, 0, &s_conn, 1, &s_mode) == 0) {
        s_front = back;
        return;
    }
    for (int i = 0; i < n; i++) paint(s_front, out[i]);
}

void max_output_paint(const uint16_t *glass, int x, int y, int w, int h)
{
    if (s_dark) return;
    const glass_fit_rect_t land = glass_fit_damage(&s_fit, (glass_fit_rect_t){x, y, w, h});
    if (!land.w) return;
    s_glass = glass;
    if (s_flipping) glass_fit_flip_add(&s_damage, land);   // painted when the frame is whole (max_output_show)
    else paint(s_front, land);
}

void max_output_show(void)
{
    if (s_dark || !s_flipping) return;   // one buffer was painted as the rectangles came
    glass_fit_rect_t out[GLASS_FIT_FLIP_MAX];
    const int n = glass_fit_flip(&s_damage, out);
    if (!n) return;
    const int back = s_front ^ 1;   // off screen: the last frame waited for its flip (below)
    for (int i = 0; i < n; i++) paint(back, out[i]);
    if (drmModePageFlip(s_fd, s_crtc, s_buf[back].fb, DRM_MODE_PAGE_FLIP_EVENT, (void *)++s_flip_tag) != 0) {
        single_buffer(strerror(errno), out, n);
        return;
    }
    s_flip_pending = true;
    s_front = back;
    // The frame waits for its own flip here, not at the start of the next one: the render task then builds the next
    // scene right after the vblank this one shows at, with what the finger did meanwhile, and paints it within the
    // next refresh (scene, strips and paint: 2-12 ms of the 17 at 2 GHz). Waiting at the start, the next scene was
    // built as soon as this one was queued, a refresh before it could show: a tap during a motion (App Detail's press)
    // reached the glass 42 ms after the finger on average, against 29 waiting here (2026-11-20).
    flip_wait();
}

// The HDMI bar has no light this program can dim: dark is a black picture, and the picture stays in the glass copy.
void max_output_power(bool on)
{
    s_dark = !on;
    if (on) return;
    flip_wait();   // a flip landing after the black would show its picture again
    for (int i = 0; i < 2; i++)
        if (s_buf[i].pixels) memset(s_buf[i].pixels, 0, s_buf[i].bytes);
}

// ── touch: the first evdev device with BTN_TOUCH and absolute X and Y, read by the touch task ────────────────────────

static int s_touch = -1;
static struct input_absinfo s_ax, s_ay;
static int64_t s_touch_retry_at;
static evdev_touch_t s_finger;

#define BITS_LONGS(n) (((n) + 8 * sizeof(long) - 1) / (8 * sizeof(long)))
static bool has_bit(const unsigned long *bits, int bit) { return (bits[bit / (8 * sizeof(long))] >> (bit % (8 * sizeof(long)))) & 1; }

static bool touch_open(void)
{
    for (int i = 0; i < 32; i++) {
        char path[32];
        snprintf(path, sizeof path, "/dev/input/event%d", i);
        const int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) continue;
        unsigned long abs_bits[BITS_LONGS(ABS_CNT)] = {0}, key_bits[BITS_LONGS(KEY_CNT)] = {0};
        char name[128] = "";
        if (ioctl(fd, EVIOCGBIT(EV_ABS, sizeof abs_bits), abs_bits) >= 0 &&
            ioctl(fd, EVIOCGBIT(EV_KEY, sizeof key_bits), key_bits) >= 0 && has_bit(abs_bits, ABS_X) &&
            has_bit(abs_bits, ABS_Y) && has_bit(key_bits, BTN_TOUCH) && ioctl(fd, EVIOCGABS(ABS_X), &s_ax) >= 0 &&
            ioctl(fd, EVIOCGABS(ABS_Y), &s_ay) >= 0 && s_ax.maximum > s_ax.minimum && s_ay.maximum > s_ay.minimum) {
            ioctl(fd, EVIOCGNAME(sizeof name - 1), name);
            // Its axes are the panel's native ones, as libinput (and the Near demo's flutter-pi) read them.
            ESP_LOGI(TAG, "touch: %s \"%s\", x %d..%d, y %d..%d", path, name, s_ax.minimum, s_ax.maximum, s_ay.minimum,
                     s_ay.maximum);
            s_touch = fd;
            evdev_touch_init(&s_finger, fd);
            return true;
        }
        close(fd);
    }
    return false;
}

pro_touch_sample_t max_output_touch(int *x, int *y)
{
    if (s_touch < 0) {
        const int64_t now = esp_timer_get_time();
        if (now < s_touch_retry_at) return PRO_TOUCH_NONE;
        s_touch_retry_at = now + TOUCH_RETRY_US;
        if (!touch_open()) return PRO_TOUCH_NONE;
    }
    if (!evdev_touch_read(&s_finger, TOUCH_WAIT_MS)) {   // unplugged (ENODEV): look for it again
        ESP_LOGW(TAG, "touch lost: %s", s_finger.gone_errno ? strerror(s_finger.gone_errno) : "end of file");
        close(s_touch);
        s_touch = -1;
        s_touch_retry_at = esp_timer_get_time() + TOUCH_RETRY_US;
        return PRO_TOUCH_ERROR;
    }
    if (!s_finger.down) return PRO_TOUCH_NONE;
    const int ox = glass_fit_axis(s_finger.x, s_ax.minimum, s_ax.maximum, s_fit.out_w);
    const int oy = glass_fit_axis(s_finger.y, s_ay.minimum, s_ay.maximum, s_fit.out_h);
    int gx, gy;
    if (!glass_fit_touch(&s_fit, ox, oy, &gx, &gy)) return PRO_TOUCH_BAD;   // on the black around the picture
    if (x) *x = gx;
    if (y) *y = gy;
    return PRO_TOUCH_ONE;
}

void max_output_run(void)
{
    for (;;) pause();   // the threads do the work; a signal ends the program, and the kernel drops the master
}
