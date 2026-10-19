#include "pod_pet.h"
#include "pro_canvas.h"
#include <string.h>

#include "pod/pod_mem.h"

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
static int clampi(int v, int lo, int hi) { return hi < lo ? lo : imin(imax(v, lo), hi); }
// v * z / 16, rounded to nearest (halves away from zero). Zooms are in sixteenths: an eighth-zoom pet carries 2 * z8, which rounds exactly as z8 / 8 did.
static int sc(int v, unsigned z16) { int n = v * (int)z16; return n >= 0 ? (n + 8) / 16 : -((-n + 8) / 16); }

// ---- lookup ---------------------------------------------------------------------------------------------

const ht_pet_t *pod_pet_for(const char *engine)
{
    if (!engine) return NULL;
    if (!strcmp(engine, "codex")) return &pod_codex_pet;   // first, so an import_pets.sh re-run that restores a Codex row in ht_pets changes nothing
    for (unsigned i = 0; i < ht_pet_count; i++)
        if (!strcmp(engine, ht_pets[i].engine)) return &ht_pets[i];
    return NULL;
}
// The ASK scene of an engine (NULL: the small pet's asking loop plays).
static const ht_pet_scene_t *pod_ask_scene_for(const char *engine)
{
    if (!strcmp(engine, "claude")) return &pod_claude_ask;
    if (!strcmp(engine, "codex")) return &pod_codex_ask;
    return NULL;
}
static const ht_pet_scene_t *scene_of(const ht_pet_t *pet, pod_scene_t which)
{
    switch (which) {
    case POD_SCENE_WORK: return pet->working_scene;
    case POD_SCENE_WORK_ALT: return pet->working_alt ? pet->working_alt : pet->working_scene;
    case POD_SCENE_RELAX: return pet->relaxing_scene;
    case POD_SCENE_LISTEN: return pet->listening_scene;
    case POD_SCENE_SEND: return pet->sending_scene;
    case POD_SCENE_ASK: return pod_ask_scene_for(pet->engine);
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

// How long a step is shown. Pets redraws on a 66 ms beat (POD_PH_ANIM_MS), so a step shorter than that (Claude's 55 ms scenes, Codex's 42 to 46 ms
// loop) sampled by the clock skips one every few beats and stutters. In beat mode (Pets: pod_pet_draw) such a step is shown for exactly one beat, so
// every step is drawn in turn, a little slower than the art's own pace. pod_pet_draw_on keeps the clock and its 33 ms frames (tests and tools).
static uint32_t beat_step_ms(uint32_t step_ms, bool beat) { return beat && step_ms < POD_PH_ANIM_MS ? POD_PH_ANIM_MS : step_ms; }
static unsigned scene_clock_step(const ht_pet_scene_t *c, uint32_t clock_ms, bool beat) { return (clock_ms / beat_step_ms(c->step_ms, beat)) % c->steps; }

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
    unsigned z;            // zoom in sixteenths (16 = 1x)
    unsigned zmax;         // 16, or 32 when the square is the 2x one (an hd pet's is 16)
    uint32_t ground;       // 0xRRGGBB the listening waves fade toward
    bool flat;             // the ground under the scene's main frame is the one colour `ground` (pod_pet_draw_flat): a frame below 1x is baked
    bool beat;             // Pets: a step shorter than the 66 ms beat lasts one beat (see beat_step_ms)
    bool hd;               // pod_codex_pet: stored at the size it is shown, so never zoomed above 1x, and below it in sixteenths (the square may still be the 2x one)
} ctx_t;

static void rect_in(const ctx_t *c, int *x, int *y, int w, int h)
{
    *x = clampi(*x, c->bx, c->bx + c->side - w);
    *y = clampi(*y, c->by, c->by + c->side - h);
}
static void put_frame(const ctx_t *c, int x, int y, const ht_cell_frame_t *f, bool main_frame)
{
    int w = (f->cols * f->cell * (int)c->z + 15) / 16, h = (f->rows * f->cell * (int)c->z + 15) / 16;
    rect_in(c, &x, &y, w, h);
    if (main_frame && c->flat) pod_cell_flat16(c->s, x, y, f, c->z, ht_rgb(c->ground));   // only the main frame: an overlay lands on the frame, not on the ground
    else pod_cell16(c->s, x, y, f, c->z);
}
static void put_overlay(const ctx_t *c, const ht_pet_scene_t *e, unsigned level, unsigned step)
{
    unsigned i = level * e->steps + step;
    put_frame(c, c->ox + sc(e->overlay->at[i][0], c->z), c->oy + sc(e->overlay->at[i][1], c->z),
              &e->overlay->frames[e->overlay->loop[i]], false);
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
    for (int i = 0; i < 3; i++) {   // fades to the ground (white glass by default)
        float g = (float)((c->ground >> (16 - 8 * i)) & 255);
        rgb[i] = (unsigned)round_pos(g - (g - (float)w->rgb[i]) * a);
    }
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
    put_frame(c, c->ox, c->oy + sc(dy, c->z), &e->frames[e->loop[at]], true);
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
static unsigned s_scans;
unsigned pod_pet_extent_scans(void) { return s_scans; }
static extent_t scene_extent(const ht_pet_scene_t *e, unsigned level)
{
    s_scans++;
    // A whole scene (tens of KB): in PSRAM, not internal RAM. The render task is the only caller.
    static EXT_RAM_BSS_ATTR ht_scene_t scratch;
    extent_t u = {0x7fff, 0x7fff, -0x7fff, -0x7fff};
    for (unsigned n = 0; n < 24 + 128; n++) {
        uint32_t clock_ms = n < 24 ? n * e->step_ms : (n - 24) * 41u;
        ctx_t c = {&scratch, -4000, -4000, 8000, 0, 0, 16, 16, 0xffffff, false, false, false};
        scratch.count = 0;
        play_scene(&c, e, level, scene_clock_step(e, clock_ms, false), clock_ms);
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
// One slot per (scene, level) the player asks for: 4 pets x 4 scenes (the listening one at its top level, the rest at 0) is 16; 32 leaves room for more pets.
enum { EXTENT_SLOTS = 32 };
static unsigned scene_level(const ht_pet_scene_t *e, pod_scene_t scene) { (void)e; return scene == POD_SCENE_LISTEN ? HT_PET_SCENE_LEVELS - 1 : 0; }
static extent_t cached_extent(const ht_pet_scene_t *e, unsigned level)
{
    static struct { const ht_pet_scene_t *e; unsigned level; extent_t u; } cache[EXTENT_SLOTS];
    static unsigned used;
    for (unsigned i = 0; i < used; i++)
        if (cache[i].e == e && cache[i].level == level) return cache[i].u;
    extent_t u = scene_extent(e, level);
    if (used < EXTENT_SLOTS) { cache[used].e = e; cache[used].level = level; cache[used].u = u; used++; }
    return u;
}

// ---- the small pet --------------------------------------------------------------------------------------

// Whether row r of the frame has an inked cell: one pass over the row's own bytes (a packed row is a run of skip, count, cells; the
// plain grid's row is read in place), not a ht_cell_at per cell, which unpacks the whole row every time.
static bool row_inked(const ht_cell_frame_t *fr, int r)
{
    if (!fr->row_at) {
        const uint8_t *p = fr->cells + (size_t)r * fr->cols;
        for (int c = 0; c < fr->cols; c++) if (p[c]) return true;
        return false;
    }
    const uint8_t *p = fr->cells + fr->row_at[r];
    for (int x = 0; x < fr->cols;) {
        int skip = *p++, n = *p++;
        for (int k = 0; k < n; k++) if (p[k]) return true;
        p += n; x += skip + n;
    }
    return false;
}
static void ink_rows(const ht_cell_frame_t *fr, int *first, int *end)
{
    *first = *end = 0;
    for (int r = 0; r < fr->rows; r++)
        if (row_inked(fr, r)) { if (*end == 0) *first = r; *end = r + 1; }
}
static bool loops_differ(const ht_pet_t *pet, int a, int b)
{
    for (unsigned i = 0; i < ht_pet_steps(pet); i++)
        if (pet->loops[a][i].frame != pet->loops[b][i].frame || pet->loops[a][i].dy != pet->loops[b][i].dy) return true;
    return false;
}
// The small pet's zoom: the largest that leaves 12% of the square free (the cells are stored at 2x, so 8/8 is the stored size). A pixel-art pet
// zooms in eighths, and at 2x it is 2x when it fits, else at most 1x (no zoom between); an hd pet is stored at the size it is shown and
// zooms down in sixteenths.
static int rest_zoom(int side, int fw, int fh, unsigned zmax, bool hd)
{
    int m = imax(1, imax(fw, fh)), z = hd ? side * 88 * 16 / 100 / m : 2 * (side * 88 * 8 / 100 / m);
    z = clampi(z, 4, (int)zmax);
    return !hd && z > 16 && z < 32 ? 16 : z;
}
// A scene's zoom: 2x when the square is the 2x one and it fits at 2x, 1x when it fits, else down to fit the room (3 px margin), never under 4/8 (4/16 for hd).
static unsigned fit_zoom(int big, int room, unsigned zmax, bool hd)
{
    if (zmax == 32 && big * 2 <= room) return 32;
    if (big <= room) return 16;
    return hd ? (unsigned)imax(4, 16 * room / big) : 2u * (unsigned)imax(4, 8 * room / big);
}
static void play_rest(ctx_t *c, const ht_pet_t *pet, ht_pet_state_t state, uint32_t clock_ms)
{
    unsigned step = (clock_ms / beat_step_ms(pet->step_ms[state], c->beat)) % ht_pet_steps(pet);
    const ht_pet_step_t *p = &pet->loops[state][step];
    const ht_cell_frame_t *fr = &pet->cells[p->frame];
    int fw = fr->cols * fr->cell, fh = fr->rows * fr->cell;
    int z = rest_zoom(c->side, fw, fh, c->zmax, c->hd);
    int pw = (fw * z + 15) / 16, ph = (fh * z + 15) / 16;
    // Centred by the ink of the loop's first frame, as the dial does, so a pose that reaches higher does not move it.
    int r0, r1;
    ink_rows(&pet->cells[pet->loops[state][0].frame], &r0, &r1);
    int ink_top = r0 * fr->cell * z / 16, ink_h = (r1 - r0) * fr->cell * z / 16;
    if (ink_h <= 0) { ink_top = 0; ink_h = ph; }
    int px = c->bx + (c->side - pw) / 2;
    int py = c->by + (c->side - ink_h) / 2 - ink_top + p->dy * z / 8;
    c->z = (unsigned)z;
    put_frame(c, px, py, fr, true);
}

// ---- when the drawing next changes ----------------------------------------------------------------------

// Whether the scene draws something different at step b than at step a (frame, offset, overlay or shapes).
static bool step_differs(const ht_pet_scene_t *e, unsigned level, unsigned a, unsigned b)
{
    unsigned i = level * e->steps + a, j = level * e->steps + b;
    if (e->loop[i] != e->loop[j] || (e->step_dy && e->step_dy[i] != e->step_dy[j])) return true;
    if (e->overlay && (e->overlay->loop[i] != e->overlay->loop[j] || memcmp(e->overlay->at[i], e->overlay->at[j], sizeof e->overlay->at[0])))
        return true;
    return e->shapes && memcmp(&e->shapes->at[a * e->shapes->count], &e->shapes->at[b * e->shapes->count],
                               e->shapes->count * sizeof e->shapes->at[0]);
}

static uint32_t next_step_ms(const char *engine, pod_scene_t scene, uint32_t clock_ms, uint32_t started_ms, bool beat)
{
    const ht_pet_t *pet = pod_pet_for(engine);
    if (!pet) return 1000;   // a still logo: only the screen's own clocks move
    const ht_pet_scene_t *e = scene_of(pet, scene);
    if (scene == POD_SCENE_ASK) return beat ? POD_PH_ANIM_MS - clock_ms % POD_PH_ANIM_MS : POD_PET_STEP_MS;   // the room's "?" bubble bobs: every beat (the cards' ASK is not redrawn by this)
    unsigned n = e ? e->steps : ht_pet_steps(pet), step_ms = 0, from = 0, k;
    bool hold = false;   // SEND holds its last step instead of wrapping
    ht_pet_state_t state = HT_PET_IDLE;
    if (e) {
        if (e->bars || e->waves) return beat ? POD_PH_ANIM_MS - clock_ms % POD_PH_ANIM_MS : POD_PET_STEP_MS;   // drawn from the clock: every frame the beat allows
        step_ms = beat_step_ms(e->step_ms, beat);
        if (scene == POD_SCENE_SEND) {
            hold = true;
            uint32_t age = (int32_t)(clock_ms - started_ms) >= 0 ? clock_ms - started_ms : 0;
            clock_ms = age;
            from = age / step_ms >= n ? n - 1u : age / step_ms;
        } else from = scene_clock_step(e, clock_ms, beat);
    } else {
        if (scene == POD_SCENE_ASK && loops_differ(pet, HT_PET_ASKING, HT_PET_IDLE)) state = HT_PET_ASKING;
        step_ms = beat_step_ms(pet->step_ms[state], beat);
        from = (clock_ms / step_ms) % n;
    }
    for (k = 1; k <= n; k++) {
        unsigned to = from + k;
        if (hold && to >= n) return POD_PET_STEP_MS;   // held: the caller knows when the scene ends
        to %= n;
        if (e ? step_differs(e, 0, from, to)   // (LISTEN, the only level > 0, always has bars or waves)
              : pet->loops[state][from].frame != pet->loops[state][to].frame || pet->loops[state][from].dy != pet->loops[state][to].dy)
            return k * step_ms - clock_ms % step_ms;
    }
    return n * step_ms;   // every step draws the same
}
uint32_t pod_pet_next_step_ms(const char *engine, pod_scene_t scene, uint32_t clock_ms, uint32_t started_ms)
{
    return next_step_ms(engine, scene, clock_ms, started_ms, false);
}
uint32_t pod_pet_next_beat_ms(const char *engine, pod_scene_t scene, uint32_t clock_ms, uint32_t started_ms)
{
    return next_step_ms(engine, scene, clock_ms, started_ms, true);
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

// The default mark at any size: the outline box, its inside and ">_" in the largest font that fits.
void pod_mark_default_big(ht_scene_t *s, int x, int y, int size, uint16_t ground)
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

static bool is_hd(const ht_pet_t *pet) { return pet == &pod_codex_pet; }   // Codex: the one HD pet

int pod_pet_ink_h(const char *engine, pod_scene_t scene, int side, unsigned zoom8)
{
    const ht_pet_t *pet = pod_pet_for(engine);
    if (!pet) return 0;
    unsigned zmax = zoom8 > 8 && zoom8 <= 16 ? zoom8 : 8u;
    if (zmax > 8) side = side * (int)zmax / 8;
    const bool hd = is_hd(pet);
    zmax = hd ? 16 : 2 * zmax;
    const ht_pet_scene_t *e = scene_of(pet, scene);
    if (!e) {   // the small pet (play_rest): the ink of the loop's first frame at the zoom it picks
        ht_pet_state_t state = HT_PET_IDLE;
        if (scene == POD_SCENE_ASK && loops_differ(pet, HT_PET_ASKING, HT_PET_IDLE)) state = HT_PET_ASKING;
        const ht_cell_frame_t *fr = &pet->cells[pet->loops[state][0].frame];
        int fw = fr->cols * fr->cell, fh = fr->rows * fr->cell;
        int z = rest_zoom(side, fw, fh, zmax, hd);
        int r0, r1;
        ink_rows(fr, &r0, &r1);
        int h = (r1 - r0) * fr->cell * z / 16;
        return h > 0 ? h : (fh * z + 15) / 16;
    }
    extent_t u = cached_extent(e, scene_level(e, scene));   // the level the draw uses
    int uw = u.x1 - u.x0, uh = u.y1 - u.y0, room = imax(1, side - 6), big = imax(uw, uh);
    return sc(uh, fit_zoom(big, room, zmax, hd));
}
// The "?" bubble over the pet the runs from..count drew (the Agent room's ASK): left edge 6 px right of the pet's, top 6 px under its top plus the bob, kept
// inside the pet's square and never above the pet. Always 1:1 (pod_cell16 at its own zoom). Over each loop of loop_ms (the ASK scene's, or the small
// pet's asking loop) it pops in once, zoom 10 -> 13 -> 16 over the first 250 ms, and bobs round(4 sin(2 pi u / loop_ms)) px.
static void put_ask_bubble(const ctx_t *c, int from, unsigned loop_ms, uint32_t age)
{
    ht_scene_t *s = c->s;
    if (s->count <= from) return;
    int top = s->runs[from].y, right = 0;
    for (int i = from; i < s->count; i++) { top = imin(top, s->runs[i].y); right = imax(right, s->runs[i].x + s->runs[i].w); }
    uint32_t u = age % loop_ms;
    float v = 4.0f * fsin(6.2831853f * (float)u / (float)loop_ms);
    int bob = (int)(v + (v >= 0 ? 0.5f : -0.5f));
    int x = clampi(right + 6, c->bx, c->bx + c->side - pod_ask_bubble.cols);
    int y = clampi(top + 6 + bob, imax(top, c->by), c->by + c->side - pod_ask_bubble.rows);
    pod_cell16(s, x, y, &pod_ask_bubble, u < 125 ? 10u : u < 250 ? 13u : 16u);
}
enum { DRAW_BEAT = 1, DRAW_FLAT = 2 };
static void draw(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                 uint32_t clock_ms, uint32_t started_ms, uint32_t ground_rgb, unsigned zoom8, unsigned flags)
{
    unsigned zmax = zoom8 > 8 && zoom8 <= 16 ? zoom8 : 8u;   // 9..15 only grow the square
    if (zmax > 8) { int grown = side * (int)zmax / 8; x -= (grown - side) / 2; y -= (grown - side) / 2; side = grown; }   // the zoomed square, same centre
    const ht_pet_t *pet = pod_pet_for(engine);
    if (!pet) {   // the logo, big, on a pale box; a light mark (Cursor's) on a dark one, else it would vanish
        const pod_mark_t *m = pod_mark(engine);
        int size = m ? pod_logo_cover_size(side) : imax(POD_DEFAULT_MARK_SIDE, side * 55 / 100);   // the default mark scales (it is drawn, not a bitmap)
        int mx = x + (side - size) / 2, my = y + (side - size) / 2;
        ht_pro_rect(s, x, y, side, side, 14, ht_rgb(m && m->light ? 0x1d1e23 : 0xf0f4f0));
        if (!pod_logo_draw(s, mx, my, size, engine)) pod_mark_default_big(s, mx, my, size, ht_rgb(0xf0f4f0));
        return;
    }
    // Codex's frames are HD (pets_codex.c, K = 1.6 of the 192 x 208 art): drawn at 1x or below, in a square that is still the 2x one.
    const bool hd = is_hd(pet);
    ctx_t c = {s, x, y, side, x, y, 16, hd ? 16u : 2 * zmax, ground_rgb, (flags & DRAW_FLAT) != 0, (flags & DRAW_BEAT) != 0, hd};
    const ht_pet_scene_t *e = scene_of(pet, scene);
    const int first = s->count;
    const bool ask = scene == POD_SCENE_ASK && zoom8 == 16;   // the Agent room's "?" bubble
    const uint32_t age = (int32_t)(clock_ms - started_ms) >= 0 ? clock_ms - started_ms : 0;
    if (!e) {
        ht_pet_state_t state = HT_PET_IDLE;
        if (scene == POD_SCENE_ASK && loops_differ(pet, HT_PET_ASKING, HT_PET_IDLE)) state = HT_PET_ASKING;
        play_rest(&c, pet, state, clock_ms);
        if (ask) put_ask_bubble(&c, first, ht_pet_steps(pet) * pet->step_ms[state], age);
        return;
    }
    unsigned level = scene_level(e, scene), step;
    // Fit what the scene draws (a margin of 3 px for rounding), zooming down only when it is larger than the square.
    extent_t u = cached_extent(e, level);
    int uw = u.x1 - u.x0, uh = u.y1 - u.y0, room = imax(1, side - 6), big = imax(uw, uh);
    c.z = fit_zoom(big, room, c.zmax, hd);
    c.ox = x + (side - sc(uw, c.z)) / 2 - sc(u.x0, c.z);
    c.oy = y + (side - sc(uh, c.z)) / 2 - sc(u.y0, c.z);
    if (scene == POD_SCENE_SEND) {
        uint32_t age = (int32_t)(clock_ms - started_ms) >= 0 ? clock_ms - started_ms : 0;
        const uint32_t step_ms = beat_step_ms(e->step_ms, c.beat);
        step = age / step_ms >= e->steps ? e->steps - 1u : age / step_ms;
    } else step = scene_clock_step(e, clock_ms, c.beat);
    play_scene(&c, e, level, step, clock_ms);
    if (ask) put_ask_bubble(&c, first, e->steps * e->step_ms, age);
}

// Pets (the beat, white ground), Pets over a ground of one colour (the beat, and a frame below 1x baked), and the clock-stepped variant.
void pod_pet_draw(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                  uint32_t clock_ms, uint32_t started_ms, unsigned zoom8)
{
    draw(s, x, y, side, engine, scene, clock_ms, started_ms, 0xffffff, zoom8, DRAW_BEAT);
}
void pod_pet_draw_flat(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                       uint32_t clock_ms, uint32_t started_ms, uint32_t ground_rgb, unsigned zoom8)
{
    draw(s, x, y, side, engine, scene, clock_ms, started_ms, ground_rgb, zoom8, DRAW_BEAT | DRAW_FLAT);
}
void pod_pet_draw_on(ht_scene_t *s, int x, int y, int side, const char *engine, pod_scene_t scene,
                     uint32_t clock_ms, uint32_t started_ms, uint32_t ground_rgb, unsigned zoom8)
{
    draw(s, x, y, side, engine, scene, clock_ms, started_ms, ground_rgb, zoom8, 0);
}
