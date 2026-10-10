#include "pod_pet.h"
#include "../pro_canvas.h"
#include <string.h>

#include "pod/pod_mem.h"

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
static int clampi(int v, int lo, int hi) { return hi < lo ? lo : imin(imax(v, lo), hi); }
// v * z / 8, rounded to nearest (halves away from zero).
static int sc(int v, unsigned z8) { int n = v * (int)z8; return n >= 0 ? (n + 4) / 8 : -((-n + 4) / 8); }

// ---- lookup ---------------------------------------------------------------------------------------------

const ht_pet_t *pod_pet_for(const char *engine)
{
    if (!engine) return NULL;
    for (unsigned i = 0; i < ht_pet_count; i++)
        if (!strcmp(engine, ht_pets[i].engine)) return &ht_pets[i];
    return NULL;
}
static const ht_pet_scene_t *scene_of(const ht_pet_t *pet, pod_scene_t which)
{
    switch (which) {
    case POD_SCENE_WORK: return pet->working_scene;
    case POD_SCENE_RELAX: return pet->relaxing_scene;
    case POD_SCENE_LISTEN: return pet->listening_scene;
    case POD_SCENE_SEND: return pet->sending_scene;
    default: return NULL;
    }
}
bool pod_pet_has(const char *engine, pod_scene_t scene)
{
    const ht_pet_t *pet = pod_pet_for(engine);
    if (!pet) return false;
    return scene == POD_SCENE_REST || scene == POD_SCENE_ASK || scene_of(pet, scene) != NULL;
}
unsigned pod_pet_runs(const char *engine, pod_scene_t scene)
{
    const ht_pet_t *pet = pod_pet_for(engine);
    if (!pet) return 1 + (pod_mark(engine) ? 1u : POD_DEFAULT_MARK_RUNS);   // the pale cover and the mark
    const ht_pet_scene_t *c = scene_of(pet, scene);
    if (!c) return 1;                                   // the small pet, straight on the glass
    return 1 + (c->overlay ? 1 : 0) + (c->bars ? 3 : 0) + (c->waves ? 2u * c->waves->count : 0u) +
           (c->shapes ? c->shapes->count : 0u);
}

// ---- the dial's scene maths, ported ---------------------------------------------------------------------

static unsigned scene_clock_step(const ht_pet_scene_t *c, uint32_t clock_ms) { return (clock_ms / c->step_ms) % c->steps; }

// sin(x) for x in radians, no libm: reduce to [-pi, pi], then a Taylor series (error < 2e-4).
static float fsin(float x)
{
    const float pi = 3.14159265f, two_pi = 6.2831853f;
    if (x > 1e6f || x < -1e6f) return 0.0f;
    int k = (int)(x / two_pi + (x >= 0 ? 0.5f : -0.5f));
    x -= (float)k * two_pi;
    if (x > pi / 2) x = pi - x; else if (x < -pi / 2) x = -pi - x;
    float x2 = x * x;
    return x * (1.0f - x2 / 6.0f * (1.0f - x2 / 20.0f * (1.0f - x2 / 42.0f * (1.0f - x2 / 72.0f))));
}
static int round_pos(float v) { return (int)(v + 0.5f); }

typedef struct {
    ht_scene_t *s;
    int bx, by, side;      // the square
    int ox, oy;            // where the scene's top-left sits
    unsigned z;            // zoom in eighths
} ctx_t;

static void rect_in(const ctx_t *c, int *x, int *y, int w, int h)
{
    *x = clampi(*x, c->bx, c->bx + c->side - w);
    *y = clampi(*y, c->by, c->by + c->side - h);
}
static void put_frame(const ctx_t *c, int x, int y, const ht_cell_frame_t *f)
{
    int w = (f->cols * f->cell * (int)c->z + 7) / 8, h = (f->rows * f->cell * (int)c->z + 7) / 8;
    rect_in(c, &x, &y, w, h);
    pod_cell(c->s, x, y, f, c->z);
}
static void put_overlay(const ctx_t *c, const ht_pet_scene_t *e, unsigned level, unsigned step)
{
    unsigned i = level * e->steps + step;
    put_frame(c, c->ox + sc(e->overlay->at[i][0], c->z), c->oy + sc(e->overlay->at[i][1], c->z),
              &e->overlay->frames[e->overlay->loop[i]]);
}
static int bar_height(const ht_pet_bars_t *b, int j, unsigned level, uint32_t clock_ms)
{
    float t = (float)(clock_ms % b->period_ms);
    float a = (fsin(6.2831853f * t / (float)b->period_ms + (float)j * b->phase) + 1.0f) * 0.5f;
    return round_pos((float)b->min_h + (float)b->swing * a * (float)level / (float)(HT_PET_SCENE_LEVELS - 1));
}
static void put_bar(const ctx_t *c, const ht_pet_scene_t *e, int j, unsigned level, uint32_t clock_ms)
{
    const ht_pet_bars_t *b = e->bars;
    int h = bar_height(b, j, level, clock_ms);
    int bh = imax(1, sc(h + 1, c->z)), bw = imax(1, sc(b->w, c->z));
    int x = c->ox + sc(b->x[j], c->z), y = c->oy + sc(b->cy, c->z) - bh / 2;
    rect_in(c, &x, &y, bw, bh);
    ht_pro_rect(c->s, x, y, bw, bh, sc(b->radius, c->z), b->fill[j]);
}
static void put_wave(const ctx_t *c, const ht_pet_scene_t *e, int side, int k, unsigned level, uint32_t clock_ms)
{
    const ht_pet_waves_t *w = e->waves;
    float u = (float)(clock_ms % w->period_ms) / (float)w->period_ms + (float)k / (float)w->count;
    if (u >= 1.0f) u -= 1.0f;
    float a = fsin(3.14159265f * u) * (0.4f + 0.6f * (float)level / (float)(HT_PET_SCENE_LEVELS - 1));
    int cx16 = c->ox * 16 + sc(w->cx16 + (side ? -w->gap16 : w->gap16), c->z), cy16 = c->oy * 16 + sc(w->cy16, c->z);
    if (a < 0.12f) { pod_arc(c->s, cx16, cy16, 0, 0, 0, 0, 0); return; }
    int r16 = round_pos((float)w->r_far16 - (float)(w->r_far16 - w->r_near16) * u);
    unsigned rgb[3];
    for (int i = 0; i < 3; i++) rgb[i] = (unsigned)round_pos(255.0f - (255.0f - (float)w->rgb[i]) * a);   // fades to the white glass
    pod_arc(c->s, cx16, cy16, sc(r16, c->z), imax(1, sc(w->w16, c->z)), side ? 180 : 0, w->half_deg,
            ht_rgb(rgb[0] << 16 | rgb[1] << 8 | rgb[2]));
}
static void put_shape(const ctx_t *c, const ht_pet_scene_t *e, unsigned k, unsigned step)
{
    const ht_pet_shape_t *p = &e->shapes->at[step * e->shapes->count + k];
    int w16 = p->w16 ? imax(1, sc(p->w16, c->z)) : 0;
    pod_arc(c->s, c->ox * 16 + sc(p->cx16, c->z), c->oy * 16 + sc(p->cy16, c->z), sc(p->r16, c->z), w16,
            p->mid_deg, p->half_deg, p->rgb);
}

// A large scene: ground already drawn. `step` picks the frame, overlay and shapes; the clock moves the bars and
// waves. Run order: waves, [overlay under bars], frame, bars, overlay, shapes.
static void play_scene(ctx_t *c, const ht_pet_scene_t *e, unsigned level, unsigned step, uint32_t clock_ms)
{
    unsigned at = level * e->steps + step;
    if (e->waves)
        for (int side = 0; side < 2; side++)
            for (int k = 0; k < e->waves->count; k++) put_wave(c, e, side, k, level, clock_ms);
    if (e->overlay && e->bars) put_overlay(c, e, level, step);
    int dy = e->step_dy ? e->step_dy[at] : 0;
    put_frame(c, c->ox, c->oy + sc(dy, c->z), &e->frames[e->loop[at]]);
    if (e->bars)
        for (int j = 0; j < 3; j++) put_bar(c, e, j, level, clock_ms);
    if (e->overlay && !e->bars) put_overlay(c, e, level, step);
    if (e->shapes)
        for (unsigned k = 0; k < e->shapes->count; k++) put_shape(c, e, k, step);
}

// The union of everything the scene draws over its loop, at zoom 8, from its origin. The art spills past the
// w x h box (the dial's dx, dy place it on a round glass: juggling balls above, waves beside), so the player
// centres and fits this, not the box. Found by playing the scene over a few seconds, once per scene.
typedef struct { int x0, y0, x1, y1; } extent_t;
static extent_t scene_extent(const ht_pet_scene_t *e, unsigned level)
{
    // A whole scene (tens of KB): in PSRAM, not internal RAM. The render task is the only caller.
    static EXT_RAM_BSS_ATTR ht_scene_t scratch;
    extent_t u = {0x7fff, 0x7fff, -0x7fff, -0x7fff};
    for (unsigned n = 0; n < 24 + 128; n++) {
        uint32_t clock_ms = n < 24 ? n * e->step_ms : (n - 24) * 41u;
        ctx_t c = {&scratch, -4000, -4000, 8000, 0, 0, 8};
        scratch.count = 0;
        play_scene(&c, e, level, scene_clock_step(e, clock_ms), clock_ms);
        for (int i = 0; i < scratch.count; i++) {
            const ht_run_t *r = &scratch.runs[i];
            if (r->w <= 0 || r->pro_height <= 0) continue;
            u.x0 = imin(u.x0, r->x); u.y0 = imin(u.y0, r->y);
            u.x1 = imax(u.x1, r->x + r->w); u.y1 = imax(u.y1, r->y + r->pro_height);
        }
    }
    if (u.x1 < u.x0) u = (extent_t){0, 0, e->w, e->h};
    return u;
}
static extent_t cached_extent(const ht_pet_scene_t *e, unsigned level)
{
    static struct { const ht_pet_scene_t *e; unsigned level; extent_t u; } cache[16];
    static unsigned used;
    for (unsigned i = 0; i < used; i++)
        if (cache[i].e == e && cache[i].level == level) return cache[i].u;
    extent_t u = scene_extent(e, level);
    if (used < 16) { cache[used].e = e; cache[used].level = level; cache[used].u = u; used++; }
    return u;
}

// ---- the small pet --------------------------------------------------------------------------------------

static void ink_rows(const ht_cell_frame_t *fr, int *first, int *end)
{
    *first = *end = 0;
    for (int r = 0; r < fr->rows; r++)
        for (int col = 0; col < fr->cols; col++)
            if (ht_cell_at(fr, col, r)) { if (*end == 0) *first = r; *end = r + 1; break; }
}
static bool loops_differ(const ht_pet_t *pet, int a, int b)
{
    for (unsigned i = 0; i < ht_pet_steps(pet); i++)
        if (pet->loops[a][i].frame != pet->loops[b][i].frame || pet->loops[a][i].dy != pet->loops[b][i].dy) return true;
    return false;
}
static void play_rest(ctx_t *c, const ht_pet_t *pet, ht_pet_state_t state, uint32_t clock_ms)
{
    unsigned step = (clock_ms / pet->step_ms[state]) % ht_pet_steps(pet);
    const ht_pet_step_t *p = &pet->loops[state][step];
    const ht_cell_frame_t *fr = &pet->cells[p->frame];
    int fw = fr->cols * fr->cell, fh = fr->rows * fr->cell;
    // Largest zoom that leaves 12% of the square free: the cells are stored at 2x, so 8 is the stored size.
    int z = c->side * 88 * 8 / 100 / imax(1, imax(fw, fh));
    z = clampi(z, 2, 8);
    int pw = (fw * z + 7) / 8, ph = (fh * z + 7) / 8;
    // Centred by the ink of the loop's first frame, as the dial does, so a pose that reaches higher does not move it.
    int r0, r1;
    ink_rows(&pet->cells[pet->loops[state][0].frame], &r0, &r1);
    int ink_top = r0 * fr->cell * z / 8, ink_h = (r1 - r0) * fr->cell * z / 8;
    if (ink_h <= 0) { ink_top = 0; ink_h = ph; }
    int px = c->bx + (c->side - pw) / 2;
    int py = c->by + (c->side - ink_h) / 2 - ink_top + p->dy * z / 4;
    c->z = (unsigned)z;
    put_frame(c, px, py, fr);
}

// ---- the player -----------------------------------------------------------------------------------------

// Logos are pre-rendered in native order at the exact sizes Pod draws (scripts/pod_gen_logos.py): a lookup and a blit.
const pod_logo_t *pod_logo_find(const char *engine, int size)
{
    const pod_mark_t *m = pod_mark(engine);
    if (!m) return NULL;
    for (unsigned i = 0; i < POD_LOGO_NSIZES; i++)
        if (m->logos[i].size == size) return &m->logos[i];
    return NULL;
}
int pod_logo_cover_size(int side) { (void)side; return POD_LOGO_COVER; }
bool pod_logo_draw_faded(ht_scene_t *s, int x, int y, int size, const char *engine, unsigned opacity)
{
    const pod_logo_t *l = pod_logo_find(engine, size);
    if (!l) return false;
    ht_pro_bitmap_t b = {l->px, l->a, size, size, 0, NULL};
    return ht_pro_image_faded(s, x, y, &b, opacity);
}
bool pod_logo_draw(ht_scene_t *s, int x, int y, int size, const char *engine) { return pod_logo_draw_faded(s, x, y, size, engine, 255); }

void pod_mark_default(ht_scene_t *s, int x, int y, uint16_t ground)
{
    const int side = POD_DEFAULT_MARK_SIDE;
    ht_pro_rect(s, x, y, side, side, 7, ht_rgb(0x9aa09a));
    ht_pro_rect(s, x + 2, y + 2, side - 4, side - 4, 5, ground);
    int w = ht_pro_width(&ht_pro_24, ">_");
    ht_pro_text(s, x + (side - w) / 2, y + (side - ht_pro_24.height) / 2 - 2, w, &ht_pro_24, ht_rgb(0x6f746f), ">_");
}

// The default mark at any size: the outline box, its inside and ">_" in the largest font that fits.
static void mark_default_big(ht_scene_t *s, int x, int y, int size, uint16_t ground)
{
    ht_pro_rect(s, x, y, size, size, size / 5, ht_rgb(0x9aa09a));
    ht_pro_rect(s, x + 2, y + 2, size - 4, size - 4, size / 5 - 2, ground);
    static const ht_pro_font_t *const fonts[] = {&ht_pro_56, &ht_pro_42, &ht_pro_32, &ht_pro_24};
    const ht_pro_font_t *f = fonts[3];
    for (unsigned i = 0; i < 4; i++)
        if (ht_pro_width(fonts[i], ">_") <= size * 62 / 100 && fonts[i]->height <= size * 70 / 100) { f = fonts[i]; break; }
    int w = ht_pro_width(f, ">_");
    ht_pro_text(s, x + (size - w) / 2, y + (size - f->height) / 2 - size / 16, w, f, ht_rgb(0x6f746f), ">_");
}

void pod_pet_draw(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                  uint32_t clock_ms, uint32_t started_ms)
{
    const ht_pet_t *pet = pod_pet_for(engine);
    if (!pet) {   // the logo, big, on a pale box; a light mark (Cursor's) on a dark one, else it would vanish
        const pod_mark_t *m = pod_mark(engine);
        int size = m ? pod_logo_cover_size(side) : imax(POD_DEFAULT_MARK_SIDE, side * 55 / 100);   // the default mark scales (it is drawn, not a bitmap)
        int mx = x + (side - size) / 2, my = y + (side - size) / 2;
        ht_pro_rect(s, x, y, side, side, 14, ht_rgb(m && m->light ? 0x1d1e23 : 0xf0f4f0));
        if (!pod_logo_draw(s, mx, my, size, engine)) mark_default_big(s, mx, my, size, ht_rgb(0xf0f4f0));
        return;
    }
    ctx_t c = {s, x, y, side, x, y, 8};
    const ht_pet_scene_t *e = scene_of(pet, scene);
    if (!e) {
        ht_pet_state_t state = HT_PET_IDLE;
        if (scene == POD_SCENE_ASK && loops_differ(pet, HT_PET_ASKING, HT_PET_IDLE)) state = HT_PET_ASKING;
        play_rest(&c, pet, state, clock_ms);
        return;
    }
    unsigned level = scene == POD_SCENE_LISTEN ? HT_PET_SCENE_LEVELS - 1 : 0, step;
    // Fit what the scene draws (a margin of 3 px for rounding), zooming down only when it is larger than the square.
    extent_t u = cached_extent(e, level);
    int uw = u.x1 - u.x0, uh = u.y1 - u.y0, room = imax(1, side - 6), big = imax(uw, uh);
    c.z = big <= room ? 8u : (unsigned)imax(4, 8 * room / big);
    c.ox = x + (side - sc(uw, c.z)) / 2 - sc(u.x0, c.z);
    c.oy = y + (side - sc(uh, c.z)) / 2 - sc(u.y0, c.z);
    if (scene == POD_SCENE_SEND) {
        uint32_t age = (int32_t)(clock_ms - started_ms) >= 0 ? clock_ms - started_ms : 0;
        step = age / e->step_ms >= e->steps ? e->steps - 1u : age / e->step_ms;
    } else step = scene_clock_step(e, clock_ms);
    play_scene(&c, e, level, step, clock_ms);
}
