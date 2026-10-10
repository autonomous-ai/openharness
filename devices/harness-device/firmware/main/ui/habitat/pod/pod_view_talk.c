// The Listening screen (mockup pro-listen.html, owner 2026-10-10): the agent's name as the title and, centred between
// the title bar and the controls, the engine's listening pet, or with no pet ("N2") the word Listening in soft green
// with a light passing over its letters and three thin arcs each side drifting in toward it. The big button sends.
#include "pod_view_shared.h"
#include "pod_draw.h"
#include "../theme.h"

#include <string.h>

#define C pod_c

// sin(x), x in radians, without libm: reduce to [-pi, pi], fold to [-pi/2, pi/2], then a Taylor series.
static float fsin(float x)
{
    const float pi = 3.14159265f, two_pi = 6.2831853f;
    int k = (int)(x / two_pi + (x >= 0 ? 0.5f : -0.5f));
    x -= (float)k * two_pi;
    if (x > pi / 2) x = pi - x; else if (x < -pi / 2) x = -pi - x;
    float x2 = x * x;
    return x * (1.0f - x2 / 6.0f * (1.0f - x2 / 20.0f * (1.0f - x2 / 42.0f * (1.0f - x2 / 72.0f))));
}
// e^-x for x >= 0, without libm: (1 + x/16)^-16 is within 1% where it matters here (a glow fading out).
static float fexpn(float x)
{
    if (x > 12.0f) return 0.0f;
    float b = 1.0f + x / 16.0f;
    b *= b; b *= b; b *= b; b *= b;
    return 1.0f / b;
}

// col faded toward the screen's ground by k (0 = ground, 1 = col): opaque, nothing to blend on the device.
static uint16_t fade(unsigned col, float k)
{
    unsigned g = HT_THEME_CANVAS, out = 0;
    for (int sh = 0; sh <= 16; sh += 8) {
        int c = (int)(col >> sh & 0xff), b = (int)(g >> sh & 0xff);
        out |= (unsigned)(b + (int)((float)(c - b) * k + 0.5f)) << sh;
    }
    return C(out);
}

enum { LISTEN = 260, LOOP_MS = 1680, ARCS = 3, GREEN = 0x34a860, SOFT = 0x609cec };

// The round dial's listening arcs: ARCS each side travelling from r_far in to r_near, bright midway and gone at
// the ends (u = (t + k / ARCS) mod 1, brightness sin(pi u)). Always 2 * ARCS runs: a hidden one keeps its slot.
static void arcs(ht_scene_t *s, int cx, int cy, int r_far, int r_near, float t)
{
    for (int k = 0; k < ARCS; k++) {
        float u = t + (float)k / ARCS;
        if (u >= 1.0f) u -= 1.0f;
        int r = r_far + (int)((float)(r_near - r_far) * u);
        float b = fsin(3.14159265f * u);
        int w16 = b < 0.12f ? 0 : 4 * 16;
        uint16_t ink = fade(SOFT, 0.25f + 0.75f * b);
        pod_arc(s, cx * 16, cy * 16, r * 16, w16, 180, 22, ink);
        pod_arc(s, cx * 16, cy * 16, r * 16, w16, 0, 22, ink);
    }
}

// The word, one run a letter: soft green, each letter brighter as the light (a gaussian moving left to right)
// passes over it.
static void word(ht_scene_t *s, int cy, float t)
{
    static const char text[] = "Listening";
    const int n = (int)sizeof text - 1;
    int x = (POD_W - ht_pro_width(&ht_pro_32, text)) / 2, y = cy - ht_pro_32.height / 2;
    for (int i = 0; i < n; i++) {
        char ch[2] = {text[i], 0};
        float d = ((float)i / (float)(n - 1) - (t * 1.4f - 0.2f)) / 0.16f;
        int w = ht_pro_width(&ht_pro_32, ch);
        ht_pro_text(s, x, y, w, &ht_pro_32, fade(GREEN, 0.45f + 0.55f * fexpn(d * d)), ch);
        x += w;
    }
}

void pod_view_talk(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    pod_status(f, pod_view_title(nav, m), true, 0);
    const pod_agent_t *a = pod_view_agent_of(nav, m);
    const int cy = (POD_STATUS_H + POD_TRANSPORT_Y) / 2;
    if (a && pod_pet_has(a->engine, POD_SCENE_LISTEN)) {
        pod_pet_draw(s, (POD_W - LISTEN) / 2, cy - LISTEN / 2, LISTEN, a->engine, POD_SCENE_LISTEN, now_ms, nav->talk_started_ms);
    } else {
        float t = (float)(now_ms % LOOP_MS) / (float)LOOP_MS;
        int half = ht_pro_width(&ht_pro_32, "Listening") / 2;
        word(s, cy, t);
        arcs(s, POD_W / 2, cy, half + 120, half + 26, t);
    }
    pod_transport(f, true);
}
