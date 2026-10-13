// pro_frame.c's strip and turn math: whatever the damage, every damaged pixel reaches the panel exactly as a direct
// full raster of the new scene would draw it (turned when built with -DPOD_PANEL_TURN=180), and every pixel of a damage
// rectangle is written once. The panel is a host fake: it keeps a 720 x 720 "glass" and applies the real pro_turn.h
// rules (the same inline functions pro_display.c calls once), and it checks the A/B overlap discipline.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pro_canvas.h"
#include "pro_display.h"
#include "pro_frame.h"
#include "pro_turn.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); exit(1); } checks++; } while (0)

int64_t esp_timer_get_time(void) { static int64_t t; return t += 3; }

enum { N = PRO_DISPLAY_PX };
static uint16_t glass[N * N];            // the panel's framebuffer, in panel (turned) coordinates
static unsigned char writes[N * N];      // how often each panel pixel was written during one present
static uint16_t strips[2][PRO_STRIP_PX];
static int in_flight_buf = -1, overlaps, submits;

uint16_t *pro_panel_strip(int which) { return strips[which & 1]; }
void pro_panel_prepare(uint16_t *buf, int w, int h)
{
    // The raster of the next strip is done while the previous DMA may still own the other buffer: never this one.
    if (in_flight_buf >= 0) { CHECK(buf != strips[in_flight_buf]); overlaps++; }
    pro_turn_pixels(buf, (size_t)w * h);
}
void pro_panel_submit(int x, int y, int w, int h, const uint16_t *buf)
{
    CHECK(in_flight_buf < 0);   // the caller waited for the previous submit first
    CHECK(buf == strips[0] || buf == strips[1]);
    CHECK(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= N && y + h <= N && (size_t)w * h <= PRO_STRIP_PX);
    int px, py;
    pro_turn_rect(x, y, w, h, &px, &py);
    for (int r = 0; r < h; r++)
        for (int c = 0; c < w; c++) {
            glass[(py + r) * N + px + c] = buf[r * w + c];
            writes[(py + r) * N + px + c]++;
        }
    in_flight_buf = buf == strips[0] ? 0 : 1;
    submits++;
}
void pro_panel_wait(void) { in_flight_buf = -1; }

static uint16_t full[N * N];   // a direct raster of the whole scene, upright
static void paint_all(const ht_scene_t *s)   // put a whole scene on the glass as the panel would hold it
{
    ht_raster(s, (ht_rect_t){0, 0, N, N}, full);
    for (int y = 0; y < N; y++)
        for (int x = 0; x < N; x++) glass[pro_turn_coord(y) * N + pro_turn_coord(x)] = full[y * N + x];
}

static void scene(ht_scene_t *s, int n, const int (*r)[5])   // r: x, y, w, h, colour
{
    ht_scene_clear(s, ht_rgb(0x101010));
    for (int i = 0; i < n; i++) CHECK(ht_pro_rect(s, r[i][0], r[i][1], r[i][2], r[i][3], 0, ht_rgb((unsigned)r[i][4])));
}

// Present prev -> next on a glass that shows prev; the glass must then show next, and each damage pixel written once.
static void replay(const ht_scene_t *prev, const ht_scene_t *next, int expect_overlap)
{
    if (prev) paint_all(prev);
    else memset(glass, 0x5a, sizeof glass);   // a glass of garbage: a full paint must replace all of it
    memset(writes, 0, sizeof writes);
    in_flight_buf = -1; overlaps = submits = 0;
    ht_damage_t damage;
    ht_damage(prev, next, &damage);
    (void)pro_frame_present(prev, next);
    CHECK(in_flight_buf < 0);   // the last DMA was waited for before returning
    ht_raster(next, (ht_rect_t){0, 0, N, N}, full);
    for (int y = 0; y < N; y++)
        for (int x = 0; x < N; x++) {
            const int g = pro_turn_coord(y) * N + pro_turn_coord(x);
            CHECK(glass[g] == full[y * N + x]);          // the turn is applied exactly once
            int covered = 0;
            for (int i = 0; i < damage.count; i++) {
                const ht_rect_t d = damage.rect[i];
                covered += x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h;
            }
            CHECK(writes[g] == covered);                 // damaged pixels once per rectangle, the rest never
        }
    if (expect_overlap) CHECK(overlaps > 0);
    CHECK(submits > 0 || damage.count == 0);
}

int main(void)
{
    static ht_scene_t a, b;
    static const int base[][5] = {{0, 0, N, N, 0x203040}, {40, 50, 200, 100, 0xff0000}, {300, 400, 120, 300, 0x00ff00}};
    scene(&a, 3, base);
    // 1. No previous scene: the whole glass, from garbage.
    replay(NULL, &a, 1);
    // 2. A small edit (one transfer, taller than nothing, narrower than the glass).
    static const int small[][5] = {{0, 0, N, N, 0x203040}, {40, 50, 200, 100, 0xff0000}, {300, 400, 120, 300, 0x00ff00},
                                   {500, 10, 30, 20, 0xffffff}};
    scene(&b, 4, small);
    replay(&a, &b, 0);
    // 3. A tall narrow change, off-centre (strips of its own width, many of them, odd bounds).
    static const int tall[][5] = {{0, 0, N, N, 0x203040}, {40, 50, 200, 100, 0xff0000}, {300, 400, 120, 300, 0x00ff00},
                                  {611, 33, 77, 649, 0x1234ff}};
    scene(&b, 4, tall);
    replay(&a, &b, 1);
    // 4. Scattered changes on both sides of the glass, one at the very corners.
    static const int scat[][5] = {{0, 0, N, N, 0x203040}, {40, 50, 200, 100, 0x00ffff}, {300, 400, 120, 300, 0x00ff00},
                                  {0, 0, 7, 9, 0xffff00}, {N - 13, N - 11, 13, 11, 0xff00ff}, {350, 5, 40, 700, 0x808080}};
    scene(&b, 6, scat);
    replay(&a, &b, 1);
    // 5. Moving things: the old place and the new place both repaint.
    static const int moved[][5] = {{0, 0, N, N, 0x203040}, {40, 50, 200, 100, 0xff0000}, {300, 520, 120, 150, 0x00ff00}};
    scene(&b, 3, moved);
    replay(&a, &b, 0);
    // 6. Identical scenes: nothing is pushed.
    replay(&a, &a, 0);
    CHECK(submits == 0);
    printf("test_pro_frame (%s): %d checks passed\n",
#if defined(POD_PANEL_TURN) && POD_PANEL_TURN == 180
           "turned 180",
#else
           "upright",
#endif
           checks);
    return 0;
}
