// The firmware update screen (the owner's call of 23 Nov, from the artifact "Harness Max Update", its fifth version).
// The left is the Pro's update screen (pod/home/ph_ota.c) laid out for the bar: its navy world, the ring with the
// percent inside, "Harness", "Updating to <to>" and the status, read off the percent alone as the Pro reads it. The
// right is a tea corner under a hanging lamp: the three pets sit in armchairs behind a round table, eyes shut, waiting
// for the bar, three cups steaming on the table; Codex dozes (its z's rise), the Muse hums (notes), the wall clock's
// minute hand goes round. Restarting: their eyes open, the z's and the note stop. It draws no hits: nothing on it is
// touched while the image is written.
//
// The scene is drawn in the artifact's px (its 1920 x 480 glass) at SCENE_K %, so the Pro's pets at their own sizes
// (Claude at 2x, the Muse and Codex at 1x: pixel art has no zoom between) sit in its chairs; every height then fits
// the glass's (MAX_Y).
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "max_ui_draw.h"

// The Pro's update colours (ph_ota.c) and the tea corner's (the artifact's).
enum {
    OTA_BG = 0x0E1B2C, OTA_INK = 0xF2F7FC, OTA_LIGHT = 0x9CC6FF, OTA_MUTED = 0x7F93AA, OTA_TRACK = 0x1B2A3D,
    OTA_FILL = 0x5F8FD6, LAMP = 0xFFC98A, SHADE = 0xE7B678, CORD = 0x2A3A4F, WOOD_TOP = 0x9A6542, WOOD = 0x7A4C30,
    WOOD_DARK = 0x553321, RUG = 0x132338, POT = 0xCFDCEA, POT_DARK = 0x9FB3C9, TEA = 0xC9893A, COOKIE = 0xC99A5B,
    CHAIR = 0x3A4E6E, CHAIR_DARK = 0x2A3953, CHAIR_LIGHT = 0x4C6388, LEAF = 0x4F8A6A, LEAF_DARK = 0x3A6B52,
};
// The left column (glass px across; heights through MAX_Y).
enum { RING_CX = 260, RING_W = 16, TEXT_X = 480, TEXT_W = 560, PCT_GAP = 4 };   // the text up to the clock
// The scene: the artifact's table middle (1410, 338) lands at (SCENE_X, SCENE_Y of a 480-high glass), all at SCENE_K %.
enum { SCENE_K = 78, SCENE_X = 1400, SCENE_Y = 352, ART_X = 1410, ART_Y = 338 };
// The table (artifact px).
enum { TABLE_CX = 1410, TABLE_CY = 338, TABLE_RX = 300, TABLE_RY = 60, TABLE_SIDE = 18 };
// What moves: the steam's, the z's and the note's cycles (the artifact's CSS), the pets' breath a step every BREATH_MS,
// the frame every FRAME_MS (15 a second: everything here moves slowly).
enum { STEAM_MS = 2600, ZZZ_MS = 4200, NOTE_MS = 5400, BREATH_MS = 900, FRAME_MS = 66 };
// The pets' looks: the clock of each one's own loop where its eyes are shut, and where they are open (pod_pet's REST
// loops; the Muse's relaxing frames 0 and 1, drawn without the beach ball its scene juggles over them).
enum { CLAUDE_SHUT_MS = 1810, CODEX_SHUT_MS = 500, PET_OPEN_MS = 0 };

#define PI_F 3.14159265f
static uint32_t s_age;   // ms since the screen came up: every loop's clock

// ---- the artifact's px to the glass ----

static int x16(int x) { return SCENE_X * 16 + (x - ART_X) * 16 * SCENE_K / 100; }
static int y16(int y) { return (SCENE_Y * 16 + (y - ART_Y) * 16 * SCENE_K / 100) * HT_HEIGHT / 480; }
static int w16(int w) { return w * 16 * SCENE_K / 100; }
static int h16(int h) { return w16(h) * HT_HEIGHT / 480; }
static int gx(int x) { return x16(x) >> 4; }
static int gy(int y) { return y16(y) >> 4; }

static void ell(ht_scene_t *s, int cx, int cy, int rx, int ry, unsigned rgb)
{
    pod_ellipse(s, x16(cx), y16(cy), w16(rx), h16(ry), C(rgb));
}
static void rect(ht_scene_t *s, int x, int y, int w, int h, int r, unsigned rgb)
{
    const int x0 = gx(x), y0 = gy(y);
    ht_pro_rect_aa(s, x0, y0, gx(x + w) - x0, gy(y + h) - y0, w16(r) >> 4, C(rgb));
}
// A four-cornered shape as two triangles that share their seam (v0..v3 in order round it).
static void quad(ht_scene_t *s, const int v[8], unsigned rgb)
{
    pod_tri_inner(s, x16(v[0]), y16(v[1]), x16(v[2]), y16(v[3]), x16(v[4]), y16(v[5]), C(rgb), 1u << 2);
    pod_tri_inner(s, x16(v[0]), y16(v[1]), x16(v[4]), y16(v[5]), x16(v[6]), y16(v[7]), C(rgb), 1u << 0);
}

// ---- the left: the Pro's update screen ----

static void progress(ht_scene_t *s)
{
    const bool restarting = max_m.update_restarting;
    const int pct = restarting ? 100 : max_m.update_pct > 100 ? 100 : max_m.update_pct;
    const int cy = MAX_Y(240), r = MAX_Y(150);
    // The ring: the track, then the part done clockwise from 12 o'clock (pod_arc: anticlockwise from 3 o'clock).
    pod_arc(s, RING_CX * 16, cy * 16, r * 16, RING_W * 16, 90, 180, C(OTA_TRACK));
    const int span = pct * 360 / 100;
    if (span > 0) pod_arc(s, RING_CX * 16, cy * 16, r * 16, RING_W * 16, 90 - span / 2, span / 2, C(OTA_FILL));
    char digits[8];   // in the wordmark's face, a smaller "%" after them, the pair centred in the ring
    snprintf(digits, sizeof digits, "%d", pct);
    const int dw = ht_pro_width(&ph_bd_84, digits), sw = ht_pro_width(&ph_sb_48, "%");
    const int x = RING_CX - (dw + PCT_GAP + sw) / 2;
    max_text(s, x, cy, dw + 2, &ph_bd_84, OTA_INK, digits);
    max_text(s, x + dw + PCT_GAP, cy + 8, sw + 2, &ph_sb_48, OTA_INK, "%");

    char head[48];
    snprintf(head, sizeof head, "%s %.20s", restarting ? "Restarting into" : "Updating to", max_m.update_to);
    max_text(s, TEXT_X, MAX_Y(155), TEXT_W, &ph_sb_48, OTA_INK, "Harness");
    max_text(s, TEXT_X, MAX_Y(240), TEXT_W, &ph_sb_32, OTA_LIGHT, head);
    if (restarting) {
        max_text(s, TEXT_X, MAX_Y(296), TEXT_W, &ph_rg_28, OTA_MUTED, "Almost there");
    } else {
        max_text(s, TEXT_X, MAX_Y(296), TEXT_W, &ph_rg_28, OTA_MUTED,
                 pct >= 100 ? "Checking the new firmware" : "Writing the new firmware");
        max_text(s, TEXT_X, MAX_Y(334), TEXT_W, &ph_rg_28, OTA_MUTED, "Keep the cable in");
    }
}

// ---- the room ----

// What the lamp lights behind everything, its cone; then the rug, the cord, the shade and its bulb.
static unsigned cone(void) { return max_mix(LAMP, OTA_BG, 8); }
static void room(ht_scene_t *s)
{
    quad(s, (const int[]){1348, 96, 1472, 96, 1710, 338, 1110, 338}, cone());
    ell(s, 1410, 432, 450, 40, RUG);
    ell(s, 1410, 428, 300, 14, max_mix(0x000000, RUG, 30));
    ht_pro_rect(s, gx(1410) - 1, 0, 3, gy(56), 0, C(CORD));
    quad(s, (const int[]){1374, 54, 1446, 54, 1474, 96, 1346, 96}, SHADE);
    ell(s, 1410, 97, 34, 5, LAMP);
}

// The wall clock: its minute hand a step a second, round in a minute from 10 past.
static void wall_clock(ht_scene_t *s)
{
    const int cx = x16(1012), cy = y16(138), r = w16(40);
    pod_ellipse(s, cx, cy, r, r, C(OTA_MUTED));
    pod_ellipse(s, cx, cy, r - 64, r - 64, C(OTA_TRACK));
    for (int i = 0; i < 4; i++) {   // 12, 3, 6 and 9
        const float a = (float)i * PI_F / 2;
        const int tx = cx + (int)(sinf(a) * (float)(r - 128)), ty = cy - (int)(cosf(a) * (float)(r - 128));
        pod_ellipse(s, tx, ty, 40, 40, C(OTA_MUTED));
    }
    const float hour = -PI_F / 3, min = (float)((s_age / 1000 + 10) % 60) * PI_F / 30;
    max_stroke16(s, cx, cy, cx + (int)(sinf(hour) * (float)r * .42f), cy - (int)(cosf(hour) * (float)r * .42f), 72, OTA_INK);
    max_stroke16(s, cx, cy, cx + (int)(sinf(min) * (float)r * .66f), cy - (int)(cosf(min) * (float)r * .66f), 52, OTA_LIGHT);
    pod_ellipse(s, cx, cy, 64, 64, C(OTA_INK));
}

// The plant on the floor: five leaves fanned from the soil, its pot.
static void plant(ht_scene_t *s)
{
    static const struct { int deg; unsigned rgb; } LEAVES[] = {
        {-52, LEAF_DARK}, {52, LEAF_DARK}, {-24, LEAF}, {24, LEAF}, {0, LEAF}};
    const int x = 1030, base = 452, sx = x, sy = base - 58;
    for (size_t i = 0; i < sizeof LEAVES / sizeof LEAVES[0]; i++) {
        const float a = (float)LEAVES[i].deg * PI_F / 180, c = cosf(a), n = sinf(a);
        // the leaf's axis from (sx, sy) up 62, its widest 11 either side 30 up, turned by deg
        const int tip_x = sx + (int)(n * 62), tip_y = sy - (int)(c * 62);
        const int lx = sx + (int)(-11 * c + n * 30), ly = sy - (int)(c * 30) + (int)(-11 * n);
        const int rx = sx + (int)(11 * c + n * 30), ry = sy - (int)(c * 30) + (int)(11 * n);
        quad(s, (const int[]){sx, sy, lx, ly, tip_x, tip_y, rx, ry}, LEAVES[i].rgb);
    }
    quad(s, (const int[]){x - 32, base - 60, x + 32, base - 60, x + 25, base, x - 25, base}, POT_DARK);
    rect(s, x - 35, base - 66, 70, 10, 3, POT);
}

// ---- the pets in their armchairs ----

// Each pet: its place across (artifact px), the tallest max_pet may fit it (Claude at 2x, Codex at 1x; the Muse's frame
// is drawn as it is), how far its legs reach below the table's far rim, its chair (glass px:
// how far the back rises over the pet's head, negative when the head stands over it, and how wide), and its breath's
// phase.
typedef struct {
    const char *engine;
    int cx, max_h, legs, chair_up, chair_w, phase;
} seat_t;
static const seat_t SEATS[] = {
    {"claude", 1222, 110, 25, 40, 162, 0},
    {"muse", 1410, 0, 30, -40, 156, 1},
    {"codex", 1598, 200, 21, -62, 172, 2},
};
enum { SEAT_COUNT = sizeof SEATS / sizeof SEATS[0], SEAT_CLAUDE = 0, SEAT_MUSE = 1, SEAT_CODEX = 2 };
// The square max_pet fits the pets in, before their heights cut it. The arms of the chairs.
enum { PET_HALF = 240, ARM_W = 26, ARM_UP = 40 };

// The table's far rim under x (artifact px).
static int far_rim(int x)
{
    const float d = (float)(x - TABLE_CX) / TABLE_RX;
    return TABLE_CY - (int)(TABLE_RY * sqrtf(d * d < 1 ? 1 - d * d : 0));
}
// Where a pet's feet stand (glass px): its legs under the far rim, out of sight.
static int seat_foot(const seat_t *p) { return gy(far_rim(p->cx) + 8) + p->legs; }
// The Muse's relaxing frame, without the ball its scene juggles: 0 eyes shut, 1 open.
static const ht_cell_frame_t *muse_frame(bool open)
{
    const ht_pet_t *pet = pod_pet_for("muse");
    const ht_pet_scene_t *rs = pet ? pet->relaxing_scene : NULL;
    return rs && rs->steps > 1 ? &rs->frames[rs->loop[open ? 1 : 0]] : NULL;
}
// How tall each pet stands (glass px), its top then foot - this.
static int pet_h(int i)
{
    if (i == SEAT_MUSE) {
        const ht_cell_frame_t *f = muse_frame(false);
        return f ? f->rows * f->cell : 0;
    }
    return max_pet_h(SEATS[i].engine, POD_SCENE_REST, PET_HALF, SEATS[i].max_h, false);
}
static void chair(ht_scene_t *s, int i)
{
    const seat_t *p = &SEATS[i];
    const int cx = gx(p->cx), top = seat_foot(p) - pet_h(i) - p->chair_up, w = p->chair_w;
    const int x0 = cx - w / 2, bot = gy(TABLE_CY + 10), r = 34, in = 10;
    ht_pro_rect_aa(s, x0, top, w, bot - top, r, C(CHAIR_DARK));
    ht_pro_rect_aa(s, x0 + in, top + in, w - 2 * in, bot - top - in, r - in, C(CHAIR));
    // its piping: a shallow bow across the cushion's head, the top of a flat ellipse the cushion covers 3 px under
    const int rx = (w - 2 * in - 22) * 8, py = (top + in + 12) * 16;
    pod_ellipse(s, cx * 16, py, rx, 6 * 16, C(CHAIR_LIGHT));
    pod_ellipse(s, cx * 16, py + 3 * 16, rx, 6 * 16, C(CHAIR));
}
static void arms(ht_scene_t *s, int i)
{
    const seat_t *p = &SEATS[i];
    const int cx = gx(p->cx), w = p->chair_w, top = gy(far_rim(p->cx)) - ARM_UP, bot = gy(TABLE_CY + 10);
    for (int side = 0; side < 2; side++) {
        const int x = side ? cx + w / 2 - ARM_W + 5 : cx - w / 2 - 5;
        ht_pro_rect_aa(s, x, top, ARM_W, bot - top, 12, C(CHAIR_LIGHT));
        ht_pro_rect_aa(s, x + 3, top + 9, ARM_W - 6, bot - top - 9, 9, C(CHAIR));
    }
}
// Their breath: up a px, two, one, and down, a step every BREATH_MS, each a step after the one before.
static int breath(int i)
{
    static const int8_t RISE[] = {0, 1, 2, 1};
    return MAX_Y(RISE[(s_age / BREATH_MS + (uint32_t)SEATS[i].phase) % 4]);
}
static void pet(ht_scene_t *s, int i, bool open)
{
    const seat_t *p = &SEATS[i];
    const int cx = gx(p->cx), foot = seat_foot(p) - breath(i);
    if (i == SEAT_MUSE) {
        const ht_cell_frame_t *f = muse_frame(open);
        if (f) pod_cell16(s, cx - f->cols * f->cell / 2, foot - f->rows * f->cell, f, 16);
        return;
    }
    const uint32_t clock = open ? PET_OPEN_MS : i == SEAT_CLAUDE ? CLAUDE_SHUT_MS : CODEX_SHUT_MS;
    max_pet(s, p->engine, POD_SCENE_REST, cx, foot, PET_HALF, p->max_h, CHAIR, clock, false);
}

// ---- the table and the tea ----

static void table(ht_scene_t *s)
{
    rect(s, 1228, TABLE_CY + 10, 20, 74, 4, WOOD_DARK);
    rect(s, 1572, TABLE_CY + 10, 20, 74, 4, WOOD_DARK);
    rect(s, 1400, TABLE_CY + 30, 22, 62, 4, WOOD);
    ell(s, TABLE_CX, TABLE_CY + TABLE_SIDE, TABLE_RX, TABLE_RY, WOOD_DARK);
    rect(s, TABLE_CX - TABLE_RX, TABLE_CY, 2 * TABLE_RX, TABLE_SIDE, 0, WOOD_DARK);
    ell(s, TABLE_CX, TABLE_CY, TABLE_RX, TABLE_RY, WOOD_TOP);
    ell(s, TABLE_CX, TABLE_CY, TABLE_RX - 34, TABLE_RY - 8, max_mix(OTA_INK, WOOD_TOP, 7));
    ell(s, TABLE_CX, TABLE_CY, TABLE_RX - 36, TABLE_RY - 10, WOOD_TOP);
}

// One wisp (the artifact's: an S of two bends, each 19 tall at `k` %, rising from 8 px below its foot to 26 above
// and fading over STEAM_MS, `age` into it): each bend an arc, shorter and finer as the wisp fades.
static void wisp(ht_scene_t *s, int x, int y, int k, uint32_t age)
{
    const int t = (int)(age % STEAM_MS) * 1000 / STEAM_MS;            // thousandths of the way
    const int o = t < 250 ? t * 900 / 250 : (1000 - t) * 900 / 750;   // opacity in thousandths, .9 at most
    if (o < 150) return;
    const int fx = x16(x), fy = y16(y + 8 - 34 * t / 1000);
    const int chord = w16(19) * k / 100, sag = w16(5) * k / 200;
    if (sag <= 0) return;
    const int rad = (chord * chord / 4 + sag * sag) / (2 * sag);
    const int half = (int)(asinf((float)chord / 2 / (float)rad) * 180 / PI_F) * o / 900;
    if (half < 3) return;
    const int w = 16 + 24 * o / 900;
    const uint16_t ink = C(max_mix(OTA_INK, OTA_BG, 58));
    pod_arc(s, fx + rad - sag, fy - chord / 2, rad, w, 180, half, ink);           // bowed left
    pod_arc(s, fx - rad + sag, fy - chord - chord / 2, rad, w, 0, half, ink);     // then right
}
static void steam(ht_scene_t *s, int x, int y, int k, int spread)
{
    static const uint32_t DELAY[] = {0, 900, 1700};
    for (int i = 0; i < 3; i++) wisp(s, x + (i - 1) * spread, y, k, s_age + STEAM_MS - DELAY[i]);
}
// A cup at 5/4 of the artifact's (its foot's middle at x, y): its shadow, body, blue band, the tea in its rim, steam.
static void cup(ht_scene_t *s, int x, int y)
{
#define L(v) ((v) * 5 / 4)
    ell(s, x, y + L(1), L(17), L(4), max_mix(0x000000, WOOD_TOP, 25));
    quad(s, (const int[]){x + L(-19), y + L(-36), x + L(19), y + L(-36), x + L(16), y, x + L(-16), y}, POT);
    rect(s, x + L(-18), y + L(-16), L(36), L(5), 0, max_mix(OTA_FILL, POT, 80));
    ell(s, x, y + L(-36), L(20), L(6), POT_DARK);
    ell(s, x, y + L(-36), L(18), L(4), TEA);
    steam(s, x, y + L(-46), 100, L(7));
#undef L
}
static void teapot(ht_scene_t *s, int x, int b)
{
    pod_arc(s, x16(x - 46), y16(b - 44), w16(12), w16(7), 180, 115, C(POT_DARK));   // the handle
    quad(s, (const int[]){x + 28, b - 28, x + 61, b - 60, x + 71, b - 58, x + 33, b - 12}, POT);   // the spout
    ell(s, x, b - 30, 42, 30, POT);
    ell(s, x, b - 58, 22, 7, POT_DARK);
    ell(s, x, b - 66, 6, 6, POT_DARK);
    ell(s, x - 15, b - 38, 8, 13, max_mix(OTA_INK, POT, 28));
    steam(s, x + 68, b - 66, 60, 4);
}
static void plate(ht_scene_t *s, int x, int y)
{
    ell(s, x, y, 38, 10, POT);
    ell(s, x, y - 1, 30, 7, max_mix(POT_DARK, POT, 50));
    static const int8_t AT[][2] = {{-13, 0}, {12, 1}, {0, -6}};
    for (int i = 0; i < 3; i++) ell(s, x + AT[i][0], y - 5 + AT[i][1], 11, 6, COOKIE);
}

// ---- what the waiting pets do ----

// Codex dozing: three z's in turn, each rising up and right from over its head and fading (ZZZ_MS, a third apart).
static void zzz(ht_scene_t *s, int x, int y)
{
    static const ht_pro_font_t *const FACE[] = {&ph_sb_22, &ph_sb_26, &ph_sb_34};
    for (int i = 0; i < 3; i++) {
        const int t = (int)((s_age + ZZZ_MS - (uint32_t)i * ZZZ_MS / 3) % ZZZ_MS) * 1000 / ZZZ_MS;
        const int o = t < 200 ? t * 90 / 200 : (1000 - t) * 90 / 800;   // percent, 90 at most
        if (o < 8) continue;
        max_text(s, x + 20 * t / 1000, y - MAX_Y(42) * t / 1000, 40, FACE[i], max_mix(OTA_LIGHT, OTA_BG, (unsigned)o), "z");
    }
}
// The Muse humming: a note rising up and left from beside its head, the second one NOTE_MS / 2 after.
static void note(ht_scene_t *s, int x, int y, uint32_t delay)
{
    const int t = (int)((s_age + NOTE_MS - delay) % NOTE_MS) * 1000 / NOTE_MS;
    if (t < 300) return;
    const int o = t < 450 ? (t - 300) * 85 / 150 : (1000 - t) * 85 / 550;
    if (o < 8) return;
    const int k = (t - 300) * 1000 / 700, nx = (x - 24 * k / 1000) * 16, ny = (y - MAX_Y(40) * k / 1000) * 16;
    const uint16_t ink = C(max_mix(LAMP, cone(), (unsigned)o));
    pod_ellipse(s, nx, ny, 88, 80, ink);
    ht_pro_rect(s, (nx >> 4) + 3, (ny >> 4) - 22, 3, 22, 0, ink);
    pod_tri(s, nx + 96, ny - 352, nx + 210, ny - 112, nx + 96, ny - 192, ink);
}

// ---- the screen ----

void max_draw_update(ht_scene_t *s, uint32_t now_ms)
{
    s_age = now_ms - max_m.page_from;
    const bool open = max_m.update_restarting;
    s->background = C(OTA_BG);
    progress(s);
    room(s);
    wall_clock(s);
    plant(s);
    for (int i = 0; i < SEAT_COUNT; i++) chair(s, i);
    for (int i = 0; i < SEAT_COUNT; i++) arms(s, i);
    for (int i = 0; i < SEAT_COUNT; i++) pet(s, i, open);
    table(s);
    plate(s, 1300, 374);
    teapot(s, 1496, 380);
    cup(s, 1236, 328);
    cup(s, 1404, 318);
    cup(s, 1584, 328);
    if (!open) {
        const seat_t *codex = &SEATS[SEAT_CODEX], *muse = &SEATS[SEAT_MUSE];
        const int codex_top = seat_foot(codex) - pet_h(SEAT_CODEX), muse_top = seat_foot(muse) - pet_h(SEAT_MUSE);
        zzz(s, gx(codex->cx) + 52, codex_top + MAX_Y(26));
        note(s, gx(muse->cx) - 66, muse_top + MAX_Y(40), 0);
        note(s, gx(muse->cx) - 50, muse_top + MAX_Y(24), NOTE_MS / 2);
    }
    max_motion(now_ms, FRAME_MS);
}
