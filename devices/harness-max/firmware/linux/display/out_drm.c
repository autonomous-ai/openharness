// The glass on a DRM/KMS screen with evdev touch: the Orange Pi's bar. No compositor and no GPU: one dumb buffer the
// display engine scans out, painted by the CPU through glass_fit (scaled, and turned when the native mode is portrait).
//
// /dev/dri/card0 by name: on the Orange Pi the GPU's card1 enumerates first and has no display. The program must be
// the DRM master: the boot wrapper stops every other UI first (systemd Conflicts=).
#include "max_output.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#include "glass_fit.h"

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "drm";

#define DRM_CARD "/dev/dri/card0"
#define TOUCH_RETRY_US 5000000   // a touchscreen that is not there (yet) is looked for again this often, as on the device

static glass_fit_t s_fit;
static uint32_t *s_map;   // the scanout buffer: XRGB8888, s_stride pixels a row
static size_t s_map_bytes;
static int s_stride;
static bool s_dark;       // the render task's, like every paint

bool max_output_open(int glass_w, int glass_h)
{
    const int fd = open(DRM_CARD, O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        ESP_LOGE(TAG, "%s: %s", DRM_CARD, strerror(errno));
        return false;
    }
    drmModeRes *res = drmModeGetResources(fd);
    drmModeConnector *conn = NULL;
    for (int i = 0; res && i < res->count_connectors && !conn; i++) {
        conn = drmModeGetConnector(fd, res->connectors[i]);
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
    drmModeModeInfo mode = conn->modes[0];
    for (int i = 0; i < conn->count_modes; i++)
        if (conn->modes[i].type & DRM_MODE_TYPE_PREFERRED) {
            mode = conn->modes[i];
            break;
        }
    // The CRTC driving the connector now, else the first one its encoders can use.
    uint32_t crtc = 0;
    for (int i = 0; i < conn->count_encoders && !crtc; i++) {
        drmModeEncoder *enc = drmModeGetEncoder(fd, conn->encoders[i]);
        if (!enc) continue;
        if (enc->encoder_id == conn->encoder_id && enc->crtc_id) crtc = enc->crtc_id;
        for (int c = 0; !crtc && c < res->count_crtcs; c++)
            if (enc->possible_crtcs & (1u << c)) crtc = res->crtcs[c];
        drmModeFreeEncoder(enc);
    }
    struct drm_mode_create_dumb create = {.width = mode.hdisplay, .height = mode.vdisplay, .bpp = 32};
    uint32_t fb = 0;
    bool ok = crtc && drmIoctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &create) == 0 &&
              drmModeAddFB(fd, mode.hdisplay, mode.vdisplay, 24, 32, create.pitch, create.handle, &fb) == 0;
    struct drm_mode_map_dumb map = {.handle = create.handle};
    ok = ok && drmIoctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &map) == 0;
    void *pixels = ok ? mmap(NULL, create.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, (off_t)map.offset) : MAP_FAILED;
    if (pixels == MAP_FAILED) {
        ESP_LOGE(TAG, "no scanout buffer for %ux%u: %s", mode.hdisplay, mode.vdisplay, strerror(errno));
        return false;
    }
    s_map = pixels;
    s_map_bytes = create.size;
    s_stride = (int)(create.pitch / 4);
    memset(s_map, 0, s_map_bytes);   // the bars around a letterboxed picture stay black
    uint32_t conn_id = conn->connector_id;
    if (drmModeSetCrtc(fd, crtc, fb, 0, 0, &conn_id, 1, &mode) != 0) {
        // EACCES: another program is the DRM master (a UI that has not stopped).
        ESP_LOGE(TAG, "cannot show %ux%u on %s: %s", mode.hdisplay, mode.vdisplay, DRM_CARD, strerror(errno));
        return false;
    }
    s_fit = glass_fit(glass_w, glass_h, mode.hdisplay, mode.vdisplay);
    ESP_LOGI(TAG, "%s %ux%u@%u: the %dx%d glass as %dx%d at (%d,%d)%s", DRM_CARD, mode.hdisplay, mode.vdisplay,
             mode.vrefresh, glass_w, glass_h, s_fit.pic.w, s_fit.pic.h, s_fit.pic.x, s_fit.pic.y,
             s_fit.turned ? ", turned a quarter" : "");
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    return true;   // fd stays open: closing it would drop the master and the picture
}

void max_output_paint(const uint16_t *glass, int x, int y, int w, int h)
{
    if (s_dark) return;
    const glass_fit_rect_t land = glass_fit_damage(&s_fit, (glass_fit_rect_t){x, y, w, h});
    if (land.w) glass_fit_paint(&s_fit, glass, land, s_map, s_stride);
}

// The HDMI bar has no light this program can dim: dark is a black picture, and the picture stays in the glass copy.
void max_output_power(bool on)
{
    s_dark = !on;
    if (!on) memset(s_map, 0, s_map_bytes);
}

// ── touch: the first evdev device with BTN_TOUCH and absolute X and Y, polled by the touch task ──────────────────────

static int s_touch = -1;
static struct input_absinfo s_ax, s_ay;
static int64_t s_touch_retry_at;
static bool s_down, s_pend_down, s_dropped;
static int s_x, s_y, s_pend_x, s_pend_y;   // raw axis values

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
            s_down = s_pend_down = false;
            return true;
        }
        close(fd);
    }
    return false;
}

// After SYN_DROPPED the events in between are gone: read the state back from the device.
static void touch_resync(void)
{
    unsigned long keys[BITS_LONGS(KEY_CNT)] = {0};
    struct input_absinfo ax, ay;
    if (ioctl(s_touch, EVIOCGKEY(sizeof keys), keys) >= 0) s_pend_down = has_bit(keys, BTN_TOUCH);
    if (ioctl(s_touch, EVIOCGABS(ABS_X), &ax) >= 0) s_pend_x = ax.value;
    if (ioctl(s_touch, EVIOCGABS(ABS_Y), &ay) >= 0) s_pend_y = ay.value;
}

pro_touch_sample_t max_output_touch(int *x, int *y)
{
    if (s_touch < 0) {
        const int64_t now = esp_timer_get_time();
        if (now < s_touch_retry_at) return PRO_TOUCH_NONE;
        s_touch_retry_at = now + TOUCH_RETRY_US;
        if (!touch_open()) return PRO_TOUCH_NONE;
    }
    struct input_event ev[64];
    for (;;) {
        const ssize_t n = read(s_touch, ev, sizeof ev);
        if (n < 0 && errno == EAGAIN) break;
        if (n <= 0) {   // unplugged (ENODEV): look for it again
            ESP_LOGW(TAG, "touch lost: %s", n < 0 ? strerror(errno) : "end of file");
            close(s_touch);
            s_touch = -1;
            s_touch_retry_at = esp_timer_get_time() + TOUCH_RETRY_US;
            return PRO_TOUCH_ERROR;
        }
        for (size_t i = 0; i < (size_t)n / sizeof ev[0]; i++) {
            const struct input_event *e = &ev[i];
            if (e->type == EV_SYN && e->code == SYN_DROPPED) {
                s_dropped = true;
            } else if (e->type == EV_SYN && e->code == SYN_REPORT) {
                if (s_dropped) {
                    touch_resync();
                    s_dropped = false;
                }
                s_down = s_pend_down;
                s_x = s_pend_x;
                s_y = s_pend_y;
            } else if (s_dropped) {
                continue;   // until the next report, events are part of what was lost
            } else if (e->type == EV_ABS && e->code == ABS_X) {
                s_pend_x = e->value;
            } else if (e->type == EV_ABS && e->code == ABS_Y) {
                s_pend_y = e->value;
            } else if (e->type == EV_KEY && e->code == BTN_TOUCH) {
                s_pend_down = e->value != 0;
            }
        }
    }
    if (!s_down) return PRO_TOUCH_NONE;
    const int ox = glass_fit_axis(s_x, s_ax.minimum, s_ax.maximum, s_fit.out_w);
    const int oy = glass_fit_axis(s_y, s_ay.minimum, s_ay.maximum, s_fit.out_h);
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
